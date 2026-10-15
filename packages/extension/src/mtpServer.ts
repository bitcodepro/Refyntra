import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import type { TestOutcome, TrxResult } from './testingModel';
import { splitFullyQualifiedName } from './vstestProtocol';

/** One test node of the Microsoft Testing Platform server protocol (testing/testUpdates/tests). */
export interface MtpNode {
  uid: string;
  'display-name': string;
  'execution-state'?: string;
  'location.type'?: string;
  'location.method'?: string;
  'error.message'?: string;
  'error.stacktrace'?: string;
  'time.duration-ms'?: number;
  'standardOutput'?: string;
  [key: string]: unknown;
}

/** LSP-style framing (Content-Length header) of the MTP JSON-RPC protocol. */
export function encodeRpc(message: object): Buffer {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export class RpcReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Record<string, unknown>[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Record<string, unknown>[] = [];
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h < 0) return out;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, h).toString('ascii'));
      if (!m) throw new Error('A message without Content-Length.');
      const n = Number(m[1]);
      if (this.buf.length < h + 4 + n) return out;
      out.push(JSON.parse(this.buf.subarray(h + 4, h + 4 + n).toString('utf8')) as Record<string, unknown>);
      this.buf = this.buf.subarray(h + 4 + n);
    }
  }
}

const OUTCOMES: Record<string, TestOutcome> = { passed: 'passed', failed: 'failed', 'timed-out': 'failed', error: 'errored', skipped: 'skipped', cancelled: 'skipped' };

/** A node as a result row for the matcher: class from location.type, method without its parameter list. */
export function mtpNodeAsResult(n: MtpNode): TrxResult {
  const display = String(n['display-name'] ?? '');
  const split = splitFullyQualifiedName(display);
  const type = typeof n['location.type'] === 'string' ? n['location.type'] : split.className;
  const method = typeof n['location.method'] === 'string' && n['location.method'] ? n['location.method'].replace(/\(.*$/, '') : split.methodName;
  const out: TrxResult = { className: type, methodName: method, testName: display, outcome: OUTCOMES[String(n['execution-state'])] ?? 'skipped' };
  if (typeof n['time.duration-ms'] === 'number') out.durationMs = n['time.duration-ms'];
  if (typeof n['error.message'] === 'string' && n['error.message']) out.message = n['error.message'];
  if (typeof n['error.stacktrace'] === 'string' && n['error.stacktrace']) out.stackTrace = n['error.stacktrace'];
  if (typeof n.standardOutput === 'string' && n.standardOutput) out.stdout = n.standardOutput;
  return out;
}

/**
 * Runs a Microsoft Testing Platform test application in server mode (`--server`, JSON-RPC over TCP): discovery returns
 * every test node — data rows included — and the run takes exactly the nodes chosen from them, so one data row runs
 * alone. One process per call; it exits after the run. Rejects when the application does not speak the protocol (the
 * caller then runs it from the command line).
 */
export function runMtpServer(
  target: string,
  cwd: string,
  choose: (discovered: MtpNode[]) => MtpNode[],
  log: (text: string) => void,
  cancel: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): unknown },
  timeoutMs = 600000,
): Promise<{ chosen: MtpNode[]; results: MtpNode[] }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let finished = false;
    let child: ReturnType<typeof spawn> | undefined;
    const done = (e: Error | undefined, value?: { chosen: MtpNode[]; results: MtpNode[] }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      if (child && child.exitCode === null) setTimeout(() => child?.exitCode === null && child.kill(), 3000).unref();
      if (e) reject(e);
      else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error('the test application did not answer in time')), timeoutMs);
    cancel.onCancellationRequested(() => done(new Error('cancelled')));
    server.once('error', (e) => done(e));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      child = spawn('dotnet', ['exec', target, '--server', '--client-host', '127.0.0.1', '--client-port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
      child.stderr?.on('data', (d: Buffer) => log(d.toString()));
      child.on('error', (e) => done(e));
      child.on('exit', (code) => done(new Error(`the test application exited (${code}) before the run finished`)));
    });
    server.once('connection', (sock) => {
      const reader = new RpcReader();
      let id = 0;
      const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
      let updates: MtpNode[] = [];
      const request = (method: string, params: object) => {
        const i = ++id;
        sock.write(encodeRpc({ id: i, method, params }));
        return new Promise<unknown>((res, rej) => pending.set(i, { res, rej }));
      };
      sock.on('data', (d: Buffer) => {
        let msgs: Record<string, unknown>[];
        try {
          msgs = reader.push(d);
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        for (const m of msgs) {
          if (m.id !== undefined && m.method === undefined) {
            const p = pending.get(Number(m.id));
            pending.delete(Number(m.id));
            if (m.error) p?.rej(new Error(JSON.stringify(m.error)));
            else p?.res(m.result);
          } else if (m.method === 'testing/testUpdates/tests') {
            for (const c of ((m.params as { changes?: { node?: MtpNode }[] })?.changes ?? [])) if (c.node) updates.push(c.node);
          } else if (m.method === 'client/log') {
            const p = m.params as { level?: string; message?: string };
            if (p?.level && p.level !== 'Trace' && p.message) log(`${p.message}\n`);
          } else if (m.id !== undefined) sock.write(encodeRpc({ id: m.id, result: null }));
        }
      });
      sock.on('error', (e) => done(e));
      void (async () => {
        try {
          await request('initialize', { processId: process.pid, clientInfo: { name: 'refyntra', version: '1' }, capabilities: { testing: { debuggerProvider: false } } });
          // Updates may still arrive right after a response: a short settle.
          const settle = () => new Promise((r) => setTimeout(r, 300));
          await request('testing/discoverTests', { runId: randomUUID() });
          await settle();
          const discovered = updates.filter((u) => u['execution-state'] === 'discovered');
          const chosen = choose(discovered);
          updates = [];
          if (chosen.length > 0) {
            await request('testing/runTests', { runId: randomUUID(), tests: chosen });
            await settle();
          }
          const results = updates.filter((u) => u['execution-state'] && u['execution-state'] !== 'in-progress' && u['execution-state'] !== 'discovered');
          sock.write(encodeRpc({ method: 'exit', params: {} }));
          done(undefined, { chosen, results });
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
  });
}
