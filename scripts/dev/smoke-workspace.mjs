// Read-only smoke test of the .NET host against any solution: load, status, search, related, references.
// Never sends edits or plans; nothing in the target folder is written by Refyntra.
//   node scripts/dev/smoke-workspace.mjs <path to .sln/.csproj> [symbol names...]
// Env: REFYNTRA_HOST_PATH (default: the Release build in src/dotnet).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [target, ...names] = process.argv.slice(2);
if (!target) {
  console.error('usage: node scripts/dev/smoke-workspace.mjs <solution or project> [symbol names...]');
  process.exit(2);
}
const hostPath = process.env.REFYNTRA_HOST_PATH || path.join(root, 'src', 'dotnet', 'Refyntra.Host', 'bin', 'Release', 'net10.0', 'Refyntra.Host.dll');
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
      msg.error ? p.reject(Object.assign(new Error(msg.error.message), { data: msg.error.data, code: msg.error.code })) : p.resolve(msg.result);
    }
  }
});
const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params: { traceId: `smoke-${id}`, ...params } });
  });
const timed = async (label, fn) => {
  const t = performance.now();
  const r = await fn();
  console.log(`  ${label}: ${Math.round(performance.now() - t)} ms`);
  return r;
};

const workspaceId = 'smoke';
try {
  await request('initialize', { protocolMajor: 1, protocolMinor: 0, clientName: 'smoke', clientVersion: '0' });
  const status = await timed('workspace/open (cold load)', () => request('workspace/open', { workspaceId, path: path.resolve(target), trusted: true }));
  console.log(`state ${status.state}${status.reasonCode ? ` (${status.reasonCode})` : ''}; SDK ${status.sdk.version}`);
  for (const p of status.projects) {
    console.log(`  ${p.name} [${p.targetFramework}] ${p.state}, ${p.documentCount} documents`);
    for (const d of p.diagnostics.slice(0, 5)) console.log(`    ${d.severity}: ${d.message.slice(0, 200)}`);
  }
  const { snapshotId } = await request('workspace/snapshotBarrier', { workspaceId, sequence: -1 });
  const all = await timed('code/search "" (types)', () => request('code/search', { workspaceId, snapshotId, query: '', filters: { type: true }, limit: 500 }));
  console.log(`  ${all.items.length} types${all.truncated ? ' (truncated)' : ''}`);
  const subjects = names.length ? names : all.items.slice(0, 5).map((i) => i.symbol?.name).filter(Boolean);
  for (const name of subjects) {
    const found = await request('code/search', { workspaceId, snapshotId, query: name, filters: {}, limit: 20 });
    const hit = found.items.find((i) => i.symbol?.name === name) ?? found.items[0];
    if (!hit?.symbol?.symbolId) {
      console.log(`\n${name}: not found`);
      continue;
    }
    const s = hit.symbol;
    console.log(`\n${s.displayName} (${s.kind}) — ${s.location ? path.basename(new URL(s.location.uri).pathname) + ':' + (s.location.range.start.line + 1) : s.origin}`);
    const rel = await timed('related (warm)', () => request('code/related', { workspaceId, snapshotId, symbolId: s.symbolId }));
    const byKind = {};
    for (const r of rel.relations) byKind[r.relationKind] = (byKind[r.relationKind] ?? 0) + 1;
    console.log(`  relations: ${JSON.stringify(byKind)} completeness=${rel.completeness}`);
    for (const r of rel.relations.filter((x) => x.relationKind.startsWith('di.')).slice(0, 5)) {
      const reg = r.target.registration;
      if (reg) console.log(`    ${reg.lifetime} ${reg.form} in ${reg.compositionRoot}`);
    }
    const refs = await timed('references', () => request('code/references', { workspaceId, snapshotId, symbolId: s.symbolId }));
    console.log(`  ${refs.locations.length} references, ${refs.completeness}`);
  }
} catch (e) {
  console.error(`FAILED: ${e.code ?? ''} ${e.message} ${JSON.stringify(e.data ?? '')}`);
  process.exitCode = 1;
} finally {
  await request('shutdown', {}).catch(() => undefined);
  send({ jsonrpc: '2.0', method: 'exit', params: {} });
  child.stdin.end();
  const errors = Buffer.concat(stderr).toString().split('\n').filter((l) => /"level":"(error|fatal)"/.test(l));
  if (errors.length) console.log(`\nhost errors in log:\n${errors.slice(0, 10).join('\n')}`);
}
