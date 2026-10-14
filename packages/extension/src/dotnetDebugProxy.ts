// The refyntra-dotnet debug adapter: netcoredbg (a child process speaking DAP over stdio) behind Refyntra's in-process
// proxy (dapProxyModel.ts), which adds logpoints and hit counts (ADR-008, "Debugger capabilities").
import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapProxyCore, type DapMessage, type DapProxyStats } from './dapProxyModel';

/** The stats of the last refyntra-dotnet session (the e2e reads them through the API). */
export const dotnetProxyHooks: { last?: DapProxyStats } = {};

/** Splits a DAP stream (Content-Length framing) into messages. */
export class DapReader {
  private buffer = Buffer.alloc(0);
  constructor(private readonly onMessage: (m: DapMessage) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buffer.length < headerEnd + 4 + len) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + len);
      try {
        this.onMessage(JSON.parse(body) as DapMessage);
      } catch {
        // Not JSON: skip it.
      }
    }
  }
}

export function encodeDap(m: DapMessage): string {
  const json = JSON.stringify(m);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

/** netcoredbg behind the proxy, as an inline debug adapter. */
export class NetcoredbgProxyAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly child: ChildProcess;
  private readonly core: DapProxyCore;
  private terminated = false;

  constructor(exe: string) {
    this.core = new DapProxyCore(
      (m) => {
        if (m.type === 'event' && m.event === 'terminated') this.terminated = true;
        this.emitter.fire(m as unknown as vscode.DebugProtocolMessage);
      },
      (m) => {
        if (this.child.stdin?.writable) this.child.stdin.write(encodeDap(m));
      },
    );
    dotnetProxyHooks.last = this.core.stats;
    this.child = spawn(exe, ['--interpreter=vscode'], { cwd: path.dirname(exe), stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new DapReader((m) => this.core.fromAdapter(m));
    this.child.stdout?.on('data', (b: Buffer) => reader.push(b));
    this.child.stderr?.on('data', () => undefined);
    this.child.stdin?.on('error', () => undefined);
    const ended = (why?: string) => {
      if (this.terminated) return;
      this.terminated = true;
      if (why) this.emitter.fire({ seq: 0, type: 'event', event: 'output', body: { category: 'stderr', output: `${why}\n` } } as unknown as vscode.DebugProtocolMessage);
      this.emitter.fire({ seq: 0, type: 'event', event: 'terminated' } as unknown as vscode.DebugProtocolMessage);
    };
    this.child.on('error', (e) => ended(`Refyntra could not start netcoredbg: ${e.message}`));
    this.child.on('exit', () => ended());
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    this.core.fromClient(message as unknown as DapMessage);
  }

  dispose(): void {
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
    this.emitter.dispose();
  }
}
