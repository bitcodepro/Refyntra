// Read-only regression on permitted OSS projects with pinned commit SHAs.
//   node scripts/test/regression.mjs [--manifest tests/regression/manifest.json] [--keep] [--work <dir>] [--only <id>] [--update]
//     clones every manifest entry into a temp dir at its pinned SHA, applies the documented SDK pin override, restores, drives
//     the host (load, search, related, references, analysis/run, rename prepare + discard; never apply) and compares the
//     result with the saved expectations. --update prints the observed expectations instead of failing (review before saving).
//   node scripts/test/regression.mjs --probe <sln|csproj> --out <file.json> [--max-subjects N]
//     generic read-only probe of any already-restored solution (used for the private quality corpus). The output contains
//     symbol names and paths of that solution, so it must be written OUTSIDE this repository; the script refuses otherwise.
// Env: REFYNTRA_HOST_PATH (default: the Release build in src/dotnet), NUGET_PACKAGES as usual.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, startHost, stats } from './lib/host-client.mjs';

const argv = process.argv.slice(2);
const opt = { manifest: path.join(repoRoot, 'tests', 'regression', 'manifest.json'), keep: false, work: null, only: null, update: false, probe: null, out: null, maxSubjects: 150 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--manifest') opt.manifest = path.resolve(argv[++i]);
  else if (a === '--keep') opt.keep = true;
  else if (a === '--work') opt.work = path.resolve(argv[++i]);
  else if (a === '--only') opt.only = argv[++i];
  else if (a === '--update') opt.update = true;
  else if (a === '--probe') opt.probe = path.resolve(argv[++i]);
  else if (a === '--out') opt.out = path.resolve(argv[++i]);
  else if (a === '--max-subjects') opt.maxSubjects = Number(argv[++i]);
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}

const fileOf = (loc) => (loc?.uri ? decodeURIComponent(new URL(loc.uri).pathname).replace(/^\/([A-Za-z]:)/, '$1') : null);
const relSummary = (r, base) => {
  const f = fileOf(r.target.location);
  return {
    kind: r.relationKind,
    label: r.target.label,
    target: r.target.symbol?.displayName ?? null,
    at: f ? `${path.relative(base, f).replaceAll('\\', '/')}:${r.target.location.range.start.line + 1}` : null,
    confidence: r.confidence,
    registration: r.target.registration ? { lifetime: r.target.registration.lifetime, form: r.target.registration.form, root: r.target.registration.compositionRoot } : undefined,
    endpoint: r.target.endpoint ?? undefined,
  };
};

/** Drives one loaded solution. `subjects` = explicit names, or null to pick representative symbols by name pattern. */
async function probe(target, { subjects = null, maxSubjects = 150, prepareCount = 3, prepareNames = null } = {}) {
  const base = path.dirname(target);
  const host = startHost({ clientName: 'regression', timeoutMs: 180000 });
  const times = {};
  const out = { target: path.basename(target), errors: [], timeouts: 0 };
  const timed = async (label, fn) => {
    const t = performance.now();
    try { return await fn(); } catch (e) {
      if (e.code === 'TIMEOUT') out.timeouts++;
      out.errors.push(`${label}: ${e.code ?? ''} ${e.message}`.slice(0, 300));
      return undefined;
    } finally { (times[label] ??= []).push(performance.now() - t); }
  };
  try {
    await host.request('initialize', { protocolMajor: 1, protocolMinor: 2, clientName: 'regression', clientVersion: '0' });
    const workspaceId = 'regression';
    const t0 = performance.now();
    const status = await host.request('workspace/open', { workspaceId, path: target, trusted: true }, 600000);
    out.openMs = Math.round(performance.now() - t0);
    out.state = status.state;
    out.reasonCode = status.reasonCode ?? null;
    out.sdk = status.sdk?.version;
    out.projects = status.projects.map((p) => ({ name: p.name, tfm: p.targetFramework, state: p.state, documents: p.documentCount, diagnostics: p.diagnostics.length }));
    const { snapshotId } = await host.request('workspace/snapshotBarrier', { workspaceId, sequence: -1 });
    const types = (await timed('code/search', () => host.request('code/search', { workspaceId, snapshotId, query: '', filters: { type: true }, limit: 5000 })))?.items ?? [];
    out.typeCount = types.length;
    const bySimple = new Map();
    for (const it of types) if (it.symbol?.symbolId) bySimple.set(it.symbol.name, [...(bySimple.get(it.symbol.name) ?? []), it.symbol]);
    let picked = [];
    if (subjects) {
      for (const name of subjects) {
        let s = bySimple.get(name)?.[0];
        if (!s) s = (await timed('code/search', () => host.request('code/search', { workspaceId, snapshotId, query: name, filters: {}, limit: 50 })))?.items?.map((i) => i.symbol).find((x) => x?.name === name);
        picked.push({ name, symbol: s });
      }
    } else {
      const cat = (s) => /Controller$/.test(s.name) ? 'controller' : /DbContext$|Context$/.test(s.name) && s.kind === 'class' ? 'dbcontext'
        : /(Command|Query|Request|Notification|Event)$/.test(s.name) ? 'request' : /Handler$/.test(s.name) ? 'handler' : /Tests?$/.test(s.name) ? 'test'
          : s.kind === 'interface' ? 'interface' : /(Service|Repository|Client|Manager|Factory|Worker)$/.test(s.name) ? 'service' : null;
      const groups = {};
      for (const it of types) { const s = it.symbol; const c = s?.symbolId && cat(s); if (c) (groups[c] ??= []).push(s); }
      out.categoryCounts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
      const order = Object.keys(groups);
      for (let i = 0; picked.length < maxSubjects && order.some((k) => groups[k].length > i); i++)
        for (const k of order) if (groups[k][i] && picked.length < maxSubjects) picked.push({ name: groups[k][i].name, category: k, symbol: groups[k][i] });
    }
    out.subjects = [];
    for (const p of picked) {
      if (!p.symbol) { out.subjects.push({ name: p.name, found: false }); continue; }
      const rel = await timed('code/related', () => host.request('code/related', { workspaceId, snapshotId, symbolId: p.symbol.symbolId }));
      const refs = await timed('code/references', () => host.request('code/references', { workspaceId, snapshotId, symbolId: p.symbol.symbolId }));
      const kinds = {};
      for (const r of rel?.relations ?? []) kinds[r.relationKind] = (kinds[r.relationKind] ?? 0) + 1;
      out.subjects.push({
        name: p.name, category: p.category, kind: p.symbol.kind, display: p.symbol.displayName, found: true,
        kinds, completeness: rel?.completeness, references: refs?.locations?.length ?? null,
        relations: (rel?.relations ?? []).map((r) => relSummary(r, base)),
      });
    }
    const analysis = await timed('analysis/run', () => host.request('analysis/run', { workspaceId, snapshotId }, 600000));
    await timed('analysis/run', () => host.request('analysis/run', { workspaceId, snapshotId }, 600000));
    const loc = (l) => { const f = fileOf(l); return f ? `${path.relative(base, f).replaceAll('\\', '/')}:${l.range.start.line + 1}` : null; };
    out.analysis = analysis && {
      completeness: analysis.completeness,
      diagnostics: analysis.diagnostics.map((d) => ({ id: d.id, at: loc(d.location), root: d.compositionRoot, message: d.message, path: d.relatedLocations.map((r) => loc(r.location)) })),
      abstentions: analysis.abstentions.map((a) => ({ id: a.ruleId, reason: a.reason, at: a.location ? loc(a.location) : null, root: a.compositionRoot, message: a.message })),
    };
    const preparable = prepareNames ? out.subjects.filter((s) => s.found && prepareNames.includes(s.name)) : out.subjects.filter((s) => s.found).slice(0, prepareCount);
    out.prepare = [];
    for (const s of preparable) {
      const sym = picked.find((p) => p.name === s.name)?.symbol;
      const r = await timed('refactor/prepare', () => host.request('refactor/prepare', { workspaceId, snapshotId, actionId: 'csharp.rename', symbolId: sym.symbolId, newName: `${sym.name}Renamed` }));
      if (r?.kind === 'prepared') host.notify('refactor/discard', { workspaceId, planId: r.plan.planId });
      out.prepare.push({ name: s.name, kind: r?.kind ?? 'error', reason: r?.reasonCode ?? null, files: r?.plan?.files?.length ?? r?.plan?.documentEdits?.length ?? null });
    }
    const st = await host.request('engine/status', {}).catch(() => undefined);
    out.stateAfter = st?.state;
  } catch (e) {
    out.errors.push(`FATAL: ${e.code ?? ''} ${e.message}`.slice(0, 300));
  } finally {
    out.hostErrors = host.errorLog().length;
    await host.stop();
  }
  out.timings = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, stats(v)]));
  return out;
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 << 20 });

if (opt.probe) {
  if (!opt.out) { console.error('--probe needs --out <file outside the repository>'); process.exit(2); }
  const rel = path.relative(repoRoot, opt.out);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) { console.error('refusing to write probe output inside the repository'); process.exit(2); }
  const r = await probe(opt.probe, { maxSubjects: opt.maxSubjects });
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.writeFileSync(opt.out, JSON.stringify(r, null, 2));
  console.log(`state ${r.state}, ${r.projects?.length} projects, ${r.subjects?.length} subjects, ${r.analysis?.diagnostics.length} diagnostics, ${r.analysis?.abstentions.length} abstentions, errors ${r.errors.length}, timeouts ${r.timeouts}; wrote ${opt.out}`);
  process.exit(r.errors.some((e) => e.startsWith('FATAL')) ? 1 : 0);
}

// ---------------------------------------------------------------- manifest mode
const manifest = JSON.parse(fs.readFileSync(opt.manifest, 'utf8'));
const work = opt.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-regression-'));
let failures = 0;
const countBy = (xs, key) => { const m = {}; for (const x of xs) m[x[key]] = (m[x[key]] ?? 0) + 1; return m; };
for (const entry of manifest.projects) {
  if (opt.only && entry.id !== opt.only) continue;
  const dir = path.join(work, entry.id);
  console.log(`== ${entry.id} ${entry.repository}@${entry.commit.slice(0, 10)} (${entry.license})`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    run('git', ['init', '-q'], dir);
    run('git', ['remote', 'add', 'origin', entry.repository], dir);
    run('git', ['fetch', '-q', '--depth', '1', 'origin', entry.commit], dir);
    run('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], dir);
  }
  const head = run('git', ['rev-parse', 'HEAD'], dir).trim();
  if (head !== entry.commit) { console.log(`  FAIL: HEAD ${head} is not the pinned commit`); failures++; continue; }
  const license = fs.readFileSync(path.join(dir, entry.licenseFile), 'utf8');
  if (!license.includes(entry.licenseMarker)) { console.log('  FAIL: license file does not match the manifest'); failures++; continue; }
  if (entry.sdk?.globalJsonOverride) fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify(entry.sdk.globalJsonOverride, null, 2));
  const target = path.join(dir, entry.solution);
  try { run('dotnet', ['restore', target, ...(entry.restoreArgs ?? [])], dir); } catch (e) { console.log(`  FAIL: restore failed\n${String(e.stdout ?? '').split('\n').filter((l) => /error/.test(l)).slice(0, 5).join('\n')}`); failures++; continue; }
  const r = await probe(target, { subjects: entry.subjects.map((s) => s.name), prepareNames: (entry.prepare ?? []).map((p) => p.name) });
  const problems = [];
  const e = entry.expect;
  if (r.state !== e.state) problems.push(`state ${r.state}, expected ${e.state}`);
  if (r.projects?.length !== e.projects) problems.push(`${r.projects?.length} projects, expected ${e.projects}`);
  if (r.errors.length) problems.push(`errors: ${r.errors.slice(0, 3).join(' | ')}`);
  const observed = { subjects: [], or1001: null };
  for (const s of entry.subjects) {
    const got = r.subjects?.find((x) => x.name === s.name);
    const kinds = got?.kinds ?? {};
    const targets = {};
    for (const rel of got?.relations ?? []) (targets[rel.kind] ??= []).push(rel.target ?? rel.label);
    for (const k of Object.keys(targets)) targets[k].sort();
    observed.subjects.push({ name: s.name, kinds, targets: Object.fromEntries(Object.entries(targets).filter(([k]) => s.targets?.[k])) });
    if (!got?.found) { problems.push(`${s.name}: not found`); continue; }
    for (const [k, n] of Object.entries(s.kinds)) if ((kinds[k] ?? 0) !== n) problems.push(`${s.name}: ${k} = ${kinds[k] ?? 0}, expected ${n}`);
    for (const k of Object.keys(kinds)) if (!(k in s.kinds)) problems.push(`${s.name}: unexpected relation kind ${k} (${kinds[k]})`);
    for (const [k, list] of Object.entries(s.targets ?? {})) {
      const have = targets[k] ?? [];
      if (JSON.stringify(have) !== JSON.stringify([...list].sort())) problems.push(`${s.name}: ${k} targets ${JSON.stringify(have)}, expected ${JSON.stringify(list)}`);
    }
  }
  const diags = (r.analysis?.diagnostics ?? []).filter((d) => d.id === 'OR1001');
  const abst = (r.analysis?.abstentions ?? []).filter((a) => a.id === 'OR1001');
  observed.or1001 = { warnings: diags.map((d) => d.at).sort(), abstentions: countBy(abst, 'reason') };
  if (JSON.stringify(observed.or1001.warnings) !== JSON.stringify([...e.or1001.warnings].sort())) problems.push(`OR1001 warnings ${JSON.stringify(observed.or1001.warnings)}, expected ${JSON.stringify(e.or1001.warnings)}`);
  if (JSON.stringify(observed.or1001.abstentions) !== JSON.stringify(e.or1001.abstentions)) problems.push(`OR1001 abstentions ${JSON.stringify(observed.or1001.abstentions)}, expected ${JSON.stringify(e.or1001.abstentions)}`);
  for (const p of entry.prepare ?? []) {
    const got = r.prepare?.find((x) => x.name === p.name);
    if (got?.kind !== p.kind) problems.push(`prepare ${p.name}: ${got?.kind}, expected ${p.kind}`);
  }
  console.log(`  ${r.state}, ${r.projects?.length} projects, open ${r.openMs} ms; related p95 ${r.timings['code/related']?.p95} ms; ${diags.length} OR1001 warnings, ${abst.length} abstentions`);
  if (opt.update) console.log(JSON.stringify(observed, null, 2));
  else if (problems.length) { failures++; for (const p of problems) console.log(`  FAIL: ${p}`); } else console.log('  ok');
}
if (!opt.keep && !opt.work) fs.rmSync(work, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
