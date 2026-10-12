// Audits what the VSIX actually ships. Exits 1 when anything forbidden is inside.
// Usage: pnpm audit:vsix [--vsix <path>] [--strict-binary]
//   --strict-binary  also fail when .NET binaries embed the build machine's absolute paths (reported as warnings otherwise)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repo, extPkg, ensureVsix, extractVsix, walk, rel } from './lib.mjs';
import { ANGULAR_LS_FILES, DBG, PYRIGHT_FILES, RA, TYPESCRIPT_FILES, TYPESCRIPT_LIB, TYPESHED_FILES, debugpyKeep } from './servers.mjs';

const vsix = ensureVsix();
const tmp = extractVsix(vsix);
const failures = [];
const warnings = [];
const fail = (m) => failures.push(m);

try {
  const files = walk(tmp).map((f) => ({ abs: f, rel: rel(tmp, f), size: fs.statSync(f).size }));

  // ---- forbidden names / locations ----
  const forbiddenBase = [
    [/^mediatr/i, 'MediatR (test-only, must not be redistributed)'],
    [/^xunit/i, 'xunit (test-only)'],
    [/^(microsoft\.)?entityframework/i, 'EF Core (test-only)'],
    [/^npgsql/i, 'Npgsql (test-only)'],
    [/^(microsoft\.net\.test\.sdk|microsoft\.testplatform|testhost|vstest)/i, 'test platform binary'],
    [/^\.env(\..*)?$/i, 'secrets-like file (.env)'],
    [/\.(pfx|snk|p12|pem|key|keystore|jks|publishsettings)$/i, 'secrets-like file (key/certificate)'],
    [/^id_(rsa|dsa|ecdsa|ed25519)/i, 'secrets-like file (ssh key)'],
    [/\.(ts|tsx|mts|cts)$/i, 'TypeScript source / declaration'],
    [/\.(cs|csproj|sln|slnx|vbproj|fsproj|props|targets)$/i, 'C# source / MSBuild project file'],
    [/\.pdb$/i, 'debug symbols (embed absolute source paths; not intended in the alpha payload)'],
    [/\.(vsix|nupkg|zip)$/i, 'nested archive'],
  ];
  // Our own assemblies are allowed to contain these words (Refyntra.Frameworks.MediatR.dll adds MediatR navigation).
  const firstParty = /^refyntra\./i;
  const forbiddenDir = [/(^|\/)tests?(\/|$)/i, /(^|\/)__tests__(\/|$)/i, /(^|\/)fixtures?(\/|$)/i, /(^|\/)node_modules(\/|$)/i, /(^|\/)\.git(\/|$)/i, /(^|\/)(bin|obj)(\/|$)/i, /(^|\/)src(\/|$)/i];
  for (const f of files) {
    const base = path.posix.basename(f.rel);
    const inside = f.rel.replace(/^extension\//, '');
    // The TypeScript default library declarations the web worker's checker needs (servers/typescript/lib.*.d.ts).
    const tsLib = /^extension\/servers\/typescript\/[^/]+$/.test(f.rel) && TYPESCRIPT_LIB.test(base);
    for (const [re, why] of forbiddenBase) {
      if (re.test(base) && !firstParty.test(base) && !tsLib) fail(`${f.rel}: ${why}`);
    }
    for (const re of forbiddenDir) if (re.test(inside)) fail(`${f.rel}: forbidden folder (${re.source})`);
    if (/\.map$/i.test(base)) fail(`${f.rel}: source map shipped (maps reference local source paths)`);
  }

  // ---- build machine paths ----
  const user = os.userInfo().username;
  const repoFwd = repo.split(path.sep).join('/');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '(?:\\\\\\\\|\\\\|/)'; // \\ or \ or /
  const parts = [
    `E:${sep}Temp`,
    `[A-Za-z]:${sep}Users${sep}`,
    `/Users/[^/\\s"']+/`,
    `/home/[^/\\s"']+/`,
    esc(repoFwd).replace(/\//g, sep),
    `${sep}${esc(user)}${sep}`,
  ];
  const pathRe = new RegExp(parts.join('|'), 'i');
  const textExt = /\.(js|cjs|mjs|json|jsonc|md|txt|xml|config|vsixmanifest|props|targets|yml|yaml|html|css|svg|map|rtf)$/i;
  const binaryExt = /\.(dll|exe)$/i;
  const binaryHits = [];
  for (const f of files) {
    const base = path.posix.basename(f.rel);
    if (textExt.test(base) || base === 'LICENSE' || base === 'NOTICE' || /^\[Content_Types\]/.test(base)) {
      const text = fs.readFileSync(f.abs, 'utf8');
      const m = pathRe.exec(text);
      if (m) fail(`${f.rel}: contains a build-machine path: ${JSON.stringify(text.slice(Math.max(0, m.index - 10), m.index + 50))}`);
    } else if (binaryExt.test(base)) {
      const buf = fs.readFileSync(f.abs);
      const probe = [repo, repoFwd, `${repo.slice(0, 1)}:\\Temp`];
      if (probe.some((p) => buf.includes(Buffer.from(p, 'latin1')) || buf.includes(Buffer.from(p, 'utf16le')))) binaryHits.push(f.rel);
    }
  }
  if (binaryHits.length) {
    const msg = `${binaryHits.length} binaries embed the repository's absolute path (PDB path in the debug directory), e.g. ${binaryHits.slice(0, 3).join(', ')}; fix with DeterministicSourcePaths / PathMap in the host build`;
    if (process.argv.includes('--strict-binary')) fail(msg); else warnings.push(msg);
  }
  const jsFiles = files.filter((f) => /\.(js|cjs|mjs)$/.test(f.rel));
  for (const f of jsFiles) if (/\/\/# sourceMappingURL=/.test(fs.readFileSync(f.abs, 'utf8'))) fail(`${f.rel}: references a source map`);

  // ---- bundled language servers: exactly these files, nothing else under extension/servers/ ----
  const manifest = fs.readFileSync(path.join(tmp, 'extension.vsixmanifest'), 'utf8');
  const target = /TargetPlatform="([^"]+)"/.exec(manifest)?.[1];
  const pyrightAllowed = new Set([...PYRIGHT_FILES, ...TYPESHED_FILES].map((f) => `extension/servers/pyright/${f}`));
  const typeshedStdlib = /^extension\/servers\/pyright\/dist\/typeshed-fallback\/stdlib\/(?:[\w.-]+\/)*(?:[\w.-]+\.pyi|VERSIONS)$/;
  const raBinary = target ? RA.targets[target]?.binary : undefined;
  if (target && !raBinary) fail(`VSIX target ${target} has no pinned rust-analyzer`);
  const raAllowed = new Set(raBinary ? [raBinary, 'LICENSE-MIT.txt', 'LICENSE-APACHE.txt', 'VERSION.txt'].map((f) => `extension/servers/rust-analyzer/${f}`) : []);
  for (const f of files.filter((x) => x.rel.startsWith('extension/servers/'))) {
    if (f.rel.startsWith('extension/servers/typescript/')) {
      const n = f.rel.slice('extension/servers/typescript/'.length);
      if (!TYPESCRIPT_FILES.includes(n) && !TYPESCRIPT_LIB.test(n)) fail(`${f.rel}: not one of the TypeScript files the web worker uses`);
    } else if (f.rel.startsWith('extension/servers/angular-language-service/')) {
      if (!ANGULAR_LS_FILES.includes(f.rel.slice('extension/servers/angular-language-service/'.length))) fail(`${f.rel}: not one of the Angular language service files the web worker uses`);
    } else if (f.rel.startsWith('extension/servers/pyright/')) {
      if (!pyrightAllowed.has(f.rel) && !typeshedStdlib.test(f.rel)) fail(`${f.rel}: not one of the Pyright language-server files Refyntra bundles`);
    } else if (!raAllowed.has(f.rel)) fail(`${f.rel}: not allowed under servers/ (${target ? `the ${target} package carries only its own rust-analyzer` : 'the universal package carries no rust-analyzer'})`);
  }
  for (const need of [...TYPESCRIPT_FILES.map((f) => `extension/servers/typescript/${f}`), 'extension/servers/typescript/lib.d.ts', ...ANGULAR_LS_FILES.map((f) => `extension/servers/angular-language-service/${f}`), 'extension/dist/webWorker.js']) if (!files.some((f) => f.rel === need)) fail(`${need}: web worker file is missing`);
  for (const need of [...pyrightAllowed, ...raAllowed]) if (!files.some((f) => f.rel === need)) fail(`${need}: bundled language-server file is missing`);
  if (raBinary) {
    const bin = path.join(tmp, 'extension', 'servers', 'rust-analyzer', raBinary);
    const head = fs.readFileSync(bin).subarray(0, 4);
    const kind = head[0] === 0x4d && head[1] === 0x5a ? 'win32' : head.toString('latin1', 1, 4) === 'ELF' ? 'linux' : [0xcf, 0xce].includes(head[0]) && head[1] === 0xfa ? 'darwin' : 'unknown';
    const wanted = target.startsWith('alpine') ? 'linux' : target.split('-')[0];
    if (kind !== wanted) fail(`servers/rust-analyzer/${raBinary} is a ${kind} binary, but the VSIX targets ${target}`);
    const verified = fs.readFileSync(path.join(tmp, 'extension', 'servers', 'rust-analyzer', 'VERSION.txt'), 'utf8');
    if (!verified.includes(RA.targets[target].sha256) || !verified.includes(RA.version)) fail('servers/rust-analyzer/VERSION.txt does not name the pinned release and its SHA-256');
  }
  console.log(`Language servers: Pyright (${files.filter((f) => f.rel.startsWith('extension/servers/pyright/')).length} files), rust-analyzer ${raBinary ? `${RA.version} for ${target}` : 'not included (universal package)'}`);

  // ---- bundled debug adapters (ADR-008): exactly these files under extension/debuggers/ ----
  const ncd = target ? DBG.netcoredbg.targets[target] : undefined;
  const ncdAllowed = (n) => !!ncd && (n === ncd.binary || ['ManagedPart.dll', 'LICENSE.txt', 'THIRD-PARTY-LICENSES.txt', 'VERSION.txt'].includes(n) || /^Microsoft\.CodeAnalysis(\.CSharp)?(\.Scripting)?\.dll$/.test(n) || /^(lib)?dbgshim\.(dll|so|dylib)$/.test(n));
  for (const f of files.filter((x) => x.rel.startsWith('extension/debuggers/'))) {
    const n = f.rel.slice('extension/debuggers/'.length);
    if (n.startsWith('netcoredbg/')) {
      if (!ncdAllowed(n.slice('netcoredbg/'.length))) fail(`${f.rel}: not a netcoredbg file of the ${target ?? 'universal'} package`);
    } else if (n.startsWith('debugpy/')) {
      const d = n.slice('debugpy/'.length);
      if (d !== 'LICENSE.txt' && d !== 'VERSION.txt' && !debugpyKeep(d)) fail(`${f.rel}: not one of the pure-Python debugpy files Refyntra bundles`);
    } else fail(`${f.rel}: not allowed under debuggers/`);
  }
  for (const need of ['debugpy/LICENSE.txt', 'debugpy/VERSION.txt', 'debugpy/debugpy/adapter/__main__.py', ...(ncd ? [`netcoredbg/${ncd.binary}`, 'netcoredbg/LICENSE.txt', 'netcoredbg/THIRD-PARTY-LICENSES.txt', 'netcoredbg/VERSION.txt', 'netcoredbg/ManagedPart.dll'] : [])]) {
    if (!files.some((f) => f.rel === `extension/debuggers/${need}`)) fail(`debuggers/${need}: bundled debug adapter file is missing`);
  }
  if (ncd) {
    const bin = path.join(tmp, 'extension', 'debuggers', 'netcoredbg', ncd.binary);
    const head = fs.readFileSync(bin).subarray(0, 4);
    const kind = head[0] === 0x4d && head[1] === 0x5a ? 'win32' : head.toString('latin1', 1, 4) === 'ELF' ? 'linux' : [0xcf, 0xce].includes(head[0]) && head[1] === 0xfa ? 'darwin' : 'unknown';
    if (kind !== target.split('-')[0]) fail(`debuggers/netcoredbg/${ncd.binary} is a ${kind} binary, but the VSIX targets ${target}`);
    const v = fs.readFileSync(path.join(tmp, 'extension', 'debuggers', 'netcoredbg', 'VERSION.txt'), 'utf8');
    if (!v.includes(ncd.sha256) || !v.includes(DBG.netcoredbg.version)) fail('debuggers/netcoredbg/VERSION.txt does not name the pinned release and its SHA-256');
  }
  if (!fs.readFileSync(path.join(tmp, 'extension', 'debuggers', 'debugpy', 'VERSION.txt'), 'utf8').includes(DBG.debugpy.sha256)) fail('debuggers/debugpy/VERSION.txt does not name the pinned wheel SHA-256');
  console.log(`Debug adapters: debugpy ${DBG.debugpy.version} (${files.filter((f) => f.rel.startsWith('extension/debuggers/debugpy/')).length} files), netcoredbg ${ncd ? `${DBG.netcoredbg.version} for ${target}` : `not included (no official build for ${target ?? 'the universal package'})`}`);

  // ---- required content ----
  for (const need of ['extension/dist/extension.js', 'extension/host/Refyntra.Host.dll', 'extension/host/Refyntra.Host.deps.json', 'extension/LICENSE.txt', 'extension/THIRD_PARTY_NOTICES.md', 'extension/package.json']) {
    if (!files.some((f) => f.rel === need)) fail(`${need}: required file is missing`);
  }
  const shippedNotices = path.join(tmp, 'extension', 'THIRD_PARTY_NOTICES.md');
  const repoNotices = path.join(repo, 'THIRD_PARTY_NOTICES.md');
  if (fs.existsSync(shippedNotices) && fs.existsSync(repoNotices) && fs.readFileSync(shippedNotices, 'utf8') !== fs.readFileSync(repoNotices, 'utf8')) {
    fail('THIRD_PARTY_NOTICES.md in the VSIX differs from the repository copy; run pnpm notices and then pnpm package:vsix');
  }
  const legalDir = path.join(repo, 'packages', 'extension', 'legal');
  if (fs.existsSync(legalDir)) {
    for (const n of fs.readdirSync(legalDir)) if (!files.some((f) => f.rel === `extension/legal/${n}`)) fail(`legal/${n} is missing from the VSIX; run pnpm package:vsix`);
  }
  if (files.some((f) => f.rel === 'extension/host/BuildHost-net472/Microsoft.CodeAnalysis.Workspaces.MSBuild.BuildHost.exe')) {
    fail('BuildHost-net472 is shipped (only needed for .NET Framework / non-SDK-style projects, unsupported in the alpha)');
  }
  const pjPath = path.join(tmp, 'extension', 'package.json');
  const pj = fs.existsSync(pjPath) ? JSON.parse(fs.readFileSync(pjPath, 'utf8')) : {};
  if (pj.dependencies && Object.keys(pj.dependencies).length) fail(`package.json declares runtime dependencies (${Object.keys(pj.dependencies).join(', ')}) but ships no node_modules`);

  // ---- size report ----
  const buckets = new Map();
  const add = (k, s) => { const b = buckets.get(k) ?? { n: 0, size: 0 }; b.n++; b.size += s; buckets.set(k, b); };
  for (const f of files) {
    const segs = f.rel.split('/');
    add(segs.length <= 2 ? `${segs[0]}/(root files)` : segs.slice(0, (segs[1] === 'host' || segs[1] === 'servers' || segs[1] === 'debuggers') && segs.length > 3 ? 3 : 2).join('/'), f.size);
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  console.log(`VSIX: ${path.relative(repo, vsix)} (${(fs.statSync(vsix).size / 1024).toFixed(1)} KiB compressed, ${(total / 1024).toFixed(1)} KiB unpacked, ${files.length} files)\n`);
  console.log('Unpacked size by folder:');
  for (const [k, b] of [...buckets].sort((a, c) => c[1].size - a[1].size)) console.log(`  ${(b.size / 1024).toFixed(1).padStart(10)} KiB  ${String(b.n).padStart(4)} files  ${k}`);
  console.log(`\nExtension ${extPkg.name}@${extPkg.version}`);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (failures.length) {
    console.error(`\nAUDIT FAILED (${failures.length}):`);
    for (const m of failures) console.error(`  - ${m}`);
    process.exitCode = 1;
  } else {
    console.log('\nAUDIT PASSED: no test libraries, fixtures, sources, secrets, source maps or build-machine paths in text files.');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
