// Minimal JSON-RPC client for the .NET host over stdio (Content-Length framing), shared by the read-only test scripts.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const defaultHostPath = () =>
  process.env.REFYNTRA_HOST_PATH || path.join(repoRoot, 'src', 'dotnet', 'Refyntra.Host', 'bin', 'Release', 'net10.0', 'Refyntra.Host.dll');

/** Starts the host. Every request has a timeout (ms); a timed-out request rejects with code 'TIMEOUT'. */
export function startHost({ hostPath = defaultHostPath(), timeoutMs = 120000, clientName = 'script' } = {}) {
  const child = spawn('dotnet', [hostPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d));
  let buf = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
      if (buf.length < sep + 4 + len) return;
      const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
      buf = buf.subarray(sep + 4 + len);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(Object.assign(new Error(msg.error.message), { data: msg.error.data, code: msg.error.code })) : p.resolve(msg.result);
      }
    }
  });
  const exited = new Promise((r) => child.once('exit', (code) => {
    for (const p of pending.values()) p.reject(Object.assign(new Error(`host exited (${code})`), { code: 'EXIT' }));
    pending.clear();
    r(code);
  }));
  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  const request = (method, params = {}, ms = timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${method} timed out after ${ms} ms`), { code: 'TIMEOUT' })); }, ms);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params: { traceId: `${clientName}-${id}`, ...params } });
    });
  const notify = (method, params = {}) => send({ jsonrpc: '2.0', method, params });
  const stop = async () => {
    await request('shutdown', {}, 10000).catch(() => undefined);
    try { notify('exit'); child.stdin.end(); } catch { /* gone */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  };
  const errorLog = () => Buffer.concat(stderr).toString().split('\n').filter((l) => /"level":"(error|fatal)"/.test(l));
  return { child, request, notify, stop, errorLog, exited };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
export function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const r = (x) => Math.round(x * 10) / 10;
  return s.length ? { n: s.length, p50: r(pct(s, 50)), p95: r(pct(s, 95)), max: r(s[s.length - 1]) } : { n: 0 };
}
