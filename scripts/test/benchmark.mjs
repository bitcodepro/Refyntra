// Performance baseline: cold open, time to Ready, warm p50/p95/p99 and RSS of the whole host process tree.
//   node scripts/test/benchmark.mjs [--iterations 30] [--budget-sec 280] [--out docs/performance] [--date YYYY-MM-DD]
//        [--copy] <name=path | path> [...]
// --copy copies targets located inside this repo (tests/fixtures) to a temp dir first; other targets are used as given.
// Read-only: only reads, searches, analysis and rename *prepare* (always followed by refactor/discard); no file is written
// in the target. Env: REFYNTRA_HOST_PATH (default: the Release build in src/dotnet).
// These numbers are a baseline for one machine, not a promise.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = { iterations: 30, budgetSec: 280, out: path.join(root, 'docs', 'performance'), date: new Date().toISOString().slice(0, 10), copy: false };
const targets = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--iterations') opt.iterations = Math.max(30, Number(argv[++i]));
  else if (a === '--budget-sec') opt.budgetSec = Number(argv[++i]);
  else if (a === '--out') opt.out = path.resolve(argv[++i]);
  else if (a === '--date') opt.date = argv[++i];
  else if (a === '--copy') opt.copy = true;
  else {
    const m = /^([A-Za-z0-9_.-]+)=(.+)$/.exec(a);
    targets.push(m ? { name: m[1], path: m[2] } : { name: path.basename(a, path.extname(a)), path: a });
  }
}
if (!targets.length) {
  console.error('usage: node scripts/test/benchmark.mjs [--iterations N] [--copy] [--out dir] <name=path-to-sln-or-csproj> ...');
  process.exit(2);
}
const hostPath = process.env.REFYNTRA_HOST_PATH || path.join(root, 'src', 'dotnet', 'Refyntra.Host', 'bin', 'Release', 'net10.0', 'Refyntra.Host.dll');
const isWin = process.platform === 'win32';

// ---------------------------------------------------------------- process tree RSS
/** Returns the sum of RSS (bytes) and the process count of `rootPid` and all its descendants (Linux, via /proc). */
function linuxTree(rootPid) {
  const kids = new Map();
  const rss = new Map();
  const page = 4096;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
      const statm = fs.readFileSync(`/proc/${d}/statm`, 'utf8').split(' ');
      rss.set(Number(d), Number(statm[1]) * page);
    } catch { /* process vanished */ }
  }
  let total = 0;
  let count = 0;
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (rss.has(p)) { total += rss.get(p); count++; }
    for (const k of kids.get(p) ?? []) stack.push(k);
  }
  return { bytes: total, count };
}

class TreeSampler {
  constructor(rootPid) {
    this.samples = [];
    this.last = null;
    if (isWin) {
      // One long-lived PowerShell polls Win32_Process (parent links + working set) so we do not pay start-up per sample.
      const script = `$r=${rootPid};while($true){$all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize;` +
        `$set=@{};$set[[uint32]$r]=1;$grew=$true;while($grew){$grew=$false;foreach($p in $all){if($set.ContainsKey($p.ParentProcessId) -and -not $set.ContainsKey($p.ProcessId)){$set[$p.ProcessId]=1;$grew=$true}}}` +
        `$sum=0;$n=0;foreach($p in $all){if($set.ContainsKey($p.ProcessId)){$sum+=$p.WorkingSetSize;$n++}};Write-Output "$sum $n";Start-Sleep -Milliseconds 150}`;
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      let acc = '';
      this.ps.stdout.on('data', (d) => {
        acc += d;
        let nl;
        while ((nl = acc.indexOf('\n')) >= 0) {
          const [b, c] = acc.slice(0, nl).trim().split(' ').map(Number);
          acc = acc.slice(nl + 1);
          if (Number.isFinite(b) && b > 0) this.add(b, c);
        }
      });
    } else {
      this.timer = setInterval(() => { try { const t = linuxTree(rootPid); if (t.bytes) this.add(t.bytes, t.count); } catch { /* ignore */ } }, 200);
    }
  }
  add(bytes, count) { this.last = { bytes, count }; this.samples.push({ t: Date.now(), bytes, count }); }
  peak() { return Math.max(0, ...this.samples.map((s) => s.bytes)); }
  maxProcesses() { return Math.max(0, ...this.samples.map((s) => s.count)); }
  medianSince(sinceMs) {
    const v = this.samples.filter((s) => s.t >= sinceMs).map((s) => s.bytes).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  stop() { if (this.timer) clearInterval(this.timer); try { this.ps?.kill(); } catch { /* ignore */ } }
}

function killTree(pid) {
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// ---------------------------------------------------------------- stats
const round = (x) => Math.round(x * 10) / 10;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, min: round(s[0]), p50: round(pct(s, 50)), p95: round(pct(s, 95)), p99: round(pct(s, 99)), max: round(s[s.length - 1]) };
}
const mb = (b) => Math.round(b / 1048576);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- machine info
function machineInfo() {
  const cpus = os.cpus();
  let sdk = 'unknown';
  let runtimes = '';
  try { sdk = execFileSync('dotnet', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* ignore */ }
  try { runtimes = execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('Microsoft.NETCore.App')).map((l) => l.split(' [')[0]).join('; '); } catch { /* ignore */ }
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: `${cpus[0]?.model?.trim()} x${cpus.length}`,
    ramGb: Math.round(os.totalmem() / 1073741824),
    dotnetSdk: sdk,
    dotnetRuntimes: runtimes,
    node: process.version,
    note: 'VS Code is not involved: the host is driven headlessly over the JSON-RPC pipe.',
  };
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!/^(bin|obj|node_modules|\.git)$/.test(e.name)) walk(path.join(d, e.name)); } else if (e.name.endsWith('.cs')) n++;
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return n;
}

// ---------------------------------------------------------------- one run
async function runTarget(t, deadline) {
  let target = path.resolve(t.path);
  let tempDir;
  if (opt.copy && target.startsWith(root)) {
    const isDir = fs.statSync(target).isDirectory();
    const src = isDir ? target : path.dirname(target);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-bench-'));
    fs.cpSync(src, tempDir, { recursive: true });
    target = isDir ? tempDir : path.join(tempDir, path.basename(target));
  }
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const result = { name: t.name, target: tempDir ? `(temp copy of) ${t.path}` : t.path, errors: [], methods: {}, cancelledOrFailed: {} };

  const child = spawn('dotnet', [hostPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const sampler = new TreeSampler(child.pid);
  child.stderr.on('data', () => undefined);
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
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      }
    }
  });
  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params: { traceId: `bench-${id}`, ...params } });
  });
  const workspaceId = 'bench';
  const timeLeft = () => deadline - Date.now();
  const finish = () => { for (const m of Object.values(result.methods)) { m.warm = m.samples?.length ? stats(m.samples) : null; delete m.samples; } };
  const record = async (label, fn) => {
    const t0 = performance.now();
    try {
      const r = await fn();
      const ms = performance.now() - t0;
      result.methods[label] ??= { cold: null, samples: [] };
      if (result.methods[label].cold === null) result.methods[label].cold = round(ms);
      else result.methods[label].samples.push(ms);
      return r;
    } catch (e) {
      result.cancelledOrFailed[label] = (result.cancelledOrFailed[label] ?? 0) + 1;
      result.errors.push(`${label}: ${e.code ?? ''} ${e.message}`.slice(0, 200));
      result.methods[label] ??= { cold: null, samples: [] };
      return undefined;
    }
  };

  const wall0 = Date.now();
  try {
    await request('initialize', { protocolMajor: 1, protocolMinor: 0, clientName: 'benchmark', clientVersion: '0' });
    const tOpen = performance.now();
    let status = await request('workspace/open', { workspaceId, path: target, trusted: true });
    result.coldOpenMs = round(performance.now() - tOpen);
    // workspace/open answers when loading ends; if it ever answers early, poll until the state is Ready.
    let guard = 0;
    while (/load|start|pend/i.test(String(status.state)) && guard++ < 600 && timeLeft() > 0) {
      await sleep(100);
      status = await request('engine/status', {});
    }
    result.timeToReadyMs = round(performance.now() - tOpen);
    result.state = status.state;
    result.reasonCode = status.reasonCode ?? null;
    result.sdkVersion = status.sdk?.version ?? null;
    result.projects = status.projects.length;
    result.documents = status.projects.reduce((n, p) => n + (p.documentCount ?? 0), 0);
    result.csFilesOnDisk = countFiles(dir);
    result.projectStates = Object.fromEntries(status.projects.map((p) => [p.name, `${p.state}/${p.documentCount}`]));
    if (!/ready|partial|degraded/i.test(String(status.state))) throw new Error(`workspace state ${status.state} ${status.reasonCode ?? ''}`);

    const { snapshotId } = await request('workspace/snapshotBarrier', { workspaceId, sequence: -1 });
    const all = await request('code/search', { workspaceId, snapshotId, query: '', filters: { type: true }, limit: 500 });
    // Subject: the type with the most references among the first candidates, so references/related do real work.
    let best;
    for (const item of all.items.filter((i) => i.symbol?.symbolId).slice(0, 25)) {
      const refs = await request('code/references', { workspaceId, snapshotId, symbolId: item.symbol.symbolId }).catch(() => undefined);
      const n = refs?.locations?.length ?? 0;
      if (!best || n > best.n) best = { n, symbol: item.symbol };
    }
    if (!best) throw new Error('no symbol found to benchmark');
    const sym = best.symbol;
    result.subject = { name: sym.displayName ?? sym.name, kind: sym.kind, references: best.n };
    const newName = `${sym.name}Bench`;

    const ops = {
      'code/search': () => request('code/search', { workspaceId, snapshotId, query: sym.name, filters: {}, limit: 50 }),
      'code/related': () => request('code/related', { workspaceId, snapshotId, symbolId: sym.symbolId }),
      'code/references': () => request('code/references', { workspaceId, snapshotId, symbolId: sym.symbolId }),
      'analysis/run': () => request('analysis/run', { workspaceId, snapshotId }),
      'refactor/prepare': async () => {
        const r = await request('refactor/prepare', { workspaceId, snapshotId, actionId: 'csharp.rename', symbolId: sym.symbolId, newName });
        if (r.kind === 'prepared') send({ jsonrpc: '2.0', method: 'refactor/discard', params: { workspaceId, planId: r.plan.planId } });
        else result.prepareUnavailable = `${r.reasonCode}: ${r.message}`.slice(0, 200);
        return r;
      },
    };
    // Cold = the first call of each method right after open; then warm iterations, interleaved like real use.
    for (const [label, fn] of Object.entries(ops)) await record(label, fn);
    const warmStart = Date.now();
    for (let i = 0; i < opt.iterations && timeLeft() > 5000; i++) {
      for (const [label, fn] of Object.entries(ops)) await record(label, fn);
    }
    result.warmSeconds = round((Date.now() - warmStart) / 1000);
    // Steady RSS: 3 s settle after the warm phase, then the median over the next 3 s.
    await sleep(3000);
    const steadyFrom = Date.now();
    await sleep(3000);
    result.rssSteadyMb = mb(sampler.medianSince(steadyFrom));
    result.rssPeakMb = mb(sampler.peak());
    result.maxProcessesInTree = sampler.maxProcesses();
    result.finalProcessesInTree = sampler.last?.count ?? null;
    finish();
    await request('shutdown', {}).catch(() => undefined);
    send({ jsonrpc: '2.0', method: 'exit', params: {} });
    child.stdin.end();
  } catch (e) {
    result.errors.push(`FATAL: ${e.message}`);
    finish();
  } finally {
    result.wallSeconds = round((Date.now() - wall0) / 1000);
    result.rssPeakMb ??= mb(sampler.peak());
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
    killTree(child.pid);
    sampler.stop();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return result;
}

// ---------------------------------------------------------------- report
function markdown(machine, results, date) {
  const L = [];
  L.push(`# Performance baseline ${date}`, '',
    'Measured by `node scripts/test/benchmark.mjs`. A baseline for one machine and one build, **not a promise**. ' +
    'The hypothesis of warm navigation p95 around 350-500 ms on a mid-size fixture is only compared below; no budget is derived from it. ' +
    'Cold load and memory get budgets in an ADR after more baselines.', '',
    '## Machine', '', ...Object.entries(machine).map(([k, v]) => `- ${k}: ${v}`), '',
    '## Method', '',
    '- The .NET host is driven headlessly over JSON-RPC (no VS Code): this is the engine cost, not the editor round trip.',
    `- Cold = first call of each method right after \`workspace/open\`. Warm = ${opt.iterations} further interleaved iterations on one snapshot; nearest-rank percentiles.`,
    '- `refactor/prepare` is a rename of the subject type, always followed by `refactor/discard`; nothing is written.',
    '- RSS is the sum of working sets of the whole process tree (host + BuildHost children), sampled every ~150-200 ms. Steady = median over 3 s of idle after the warm phase.',
    '- Subject selection calls code/references on up to 25 types before the cold measurements, so cold code/references is not truly cold.',
    '- Failed/cancelled requests are counted separately and are not part of the percentiles.', '');
  for (const r of results) {
    L.push(`## ${r.name}`, '', `- target: ${r.target}`,
      `- SDK ${r.sdkVersion}; state ${r.state}${r.reasonCode ? ` (${r.reasonCode})` : ''}; ${r.projects} projects, ${r.documents} documents loaded, ${r.csFilesOnDisk} .cs files on disk`,
      `- cold workspace/open: **${r.coldOpenMs} ms**; time to Ready: **${r.timeToReadyMs} ms**`,
      `- RSS of the process tree: peak **${r.rssPeakMb} MB**, steady **${r.rssSteadyMb} MB**; max ${r.maxProcessesInTree} processes, ${r.finalProcessesInTree} at the end`,
      `- subject: ${r.subject?.name} (${r.subject?.kind}), ${r.subject?.references} references; run took ${r.wallSeconds} s${r.prepareUnavailable ? `; prepare unavailable: ${r.prepareUnavailable}` : ''}`, '',
      '| method | cold ms | n | p50 | p95 | p99 | max | failed |', '|---|---|---|---|---|---|---|---|');
    for (const [label, m] of Object.entries(r.methods)) {
      const w = m.warm;
      L.push(`| ${label} | ${m.cold} | ${w?.n ?? 0} | ${w?.p50 ?? '-'} | ${w?.p95 ?? '-'} | ${w?.p99 ?? '-'} | ${w?.max ?? '-'} | ${r.cancelledOrFailed[label] ?? 0} |`);
    }
    if (r.errors.length) L.push('', `Errors: ${[...new Set(r.errors)].slice(0, 5).join(' | ')}`);
    L.push('');
  }
  return L.join('\n');
}

const machine = machineInfo();
const results = [];
for (const t of targets) {
  console.log(`benchmark ${t.name} ...`);
  const r = await runTarget(t, Date.now() + opt.budgetSec * 1000);
  results.push(r);
  console.log(`  open ${r.coldOpenMs} ms, peak ${r.rssPeakMb} MB, steady ${r.rssSteadyMb} MB, ${r.wallSeconds} s${r.errors.length ? `, errors: ${r.errors.length}` : ''}`);
}
fs.mkdirSync(opt.out, { recursive: true });
const base = path.join(opt.out, `baseline-${opt.date}`);
fs.writeFileSync(`${base}.json`, JSON.stringify({ date: opt.date, machine, iterations: opt.iterations, results }, null, 2));
fs.writeFileSync(`${base}.md`, markdown(machine, results, opt.date));
console.log(`wrote ${base}.md and .json`);
process.exitCode = results.some((r) => r.errors.some((e) => e.startsWith('FATAL'))) ? 1 : 0;
