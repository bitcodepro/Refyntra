// Language servers bundled in the VSIX (no other VS Code extension is needed for Python or Rust):
//   - Pyright (npm `pyright`, MIT; typeshed stubs Apache-2.0): only the files its language server needs, copied from
//     node_modules (pinned in packages/extension/package.json). Identical in every VSIX.
//   - rust-analyzer (MIT OR Apache-2.0): one native binary per VSIX target, downloaded at PACKAGING time only from the
//     official GitHub release pinned in scripts/package/rust-analyzer.json and verified against its SHA-256. Never at
//     run time. Downloads are cached in <repo>/.cache/rust-analyzer/<version>/<target>/.
// CLI (development): node scripts/package/servers.mjs --rust-analyzer [--target <vsce target>]
//   fetches + verifies the binary for the current (or given) target into the cache; the extension's dev mode finds it there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RA = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'package', 'rust-analyzer.json'), 'utf8'));
export const RA_TARGETS = Object.keys(RA.targets);
export const LICENSES_DIR = path.join(repo, 'scripts', 'package', 'licenses');

/** The vsce target of this machine (alpine is never auto-detected; pass --target alpine-x64). */
export function currentTarget() {
  return `${process.platform}-${process.arch}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Minimal ZIP reader (stored/deflated entries) for the release archives; no external tools. Returns every file entry. */
export function unzipAll(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    if (method === 0) out.push({ name, data: Buffer.from(data) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(data) });
    else throw new Error(`unsupported zip compression method ${method} (${name})`);
  }
  return out;
}

/** Minimal tar.gz reader (regular files only; ustar names with prefix). */
export function untarGzAll(gz) {
  const buf = zlib.gunzipSync(gz);
  const out = [];
  let p = 0;
  while (p + 512 <= buf.length) {
    const header = buf.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const str = (o, l) => {
      const s = header.subarray(o, o + l).toString('utf8');
      const z = s.indexOf('\0');
      return z >= 0 ? s.slice(0, z) : s;
    };
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = header[156];
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : '') + str(0, 100);
    if (type === 0x30 || type === 0) out.push({ name, data: Buffer.from(buf.subarray(p + 512, p + 512 + size)) });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function unzipEntry(buf, wanted) {
  const e = unzipAll(buf).find((x) => path.posix.basename(x.name) === wanted);
  if (!e) throw new Error(`${wanted} not found in the archive`);
  return e.data;
}

/** Downloads (once) and verifies the rust-analyzer binary for a target; returns its cached path. */
export async function ensureRustAnalyzer(target) {
  const t = RA.targets[target];
  if (!t) throw new Error(`rust-analyzer is not pinned for target ${target} (scripts/package/rust-analyzer.json has ${RA_TARGETS.join(', ')})`);
  const dir = path.join(repo, '.cache', 'rust-analyzer', RA.version, target);
  const bin = path.join(dir, t.binary);
  const archive = path.join(dir, path.posix.basename(new URL(t.url).pathname));
  if (fs.existsSync(bin) && fs.existsSync(archive) && sha256(fs.readFileSync(archive)) === t.sha256) return bin;
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Downloading rust-analyzer ${RA.version} for ${target} (packaging only) …`);
  const res = await fetch(t.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${t.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== t.sha256) throw new Error(`SHA-256 mismatch for ${t.url}: expected ${t.sha256}, got ${got}. Refusing to bundle.`);
  fs.writeFileSync(archive, buf);
  const out = t.url.endsWith('.zip') ? unzipEntry(buf, t.binary) : zlib.gunzipSync(buf);
  fs.writeFileSync(bin, out, { mode: 0o755 });
  console.log(`rust-analyzer ${RA.version} ${target}: verified (sha256 ${got.slice(0, 16)}…), ${(out.length / 1048576).toFixed(1)} MiB`);
  return bin;
}

/** Copies the verified rust-analyzer binary and its two license texts into <dest> (servers/rust-analyzer). */
export async function stageRustAnalyzer(target, dest) {
  const bin = await ensureRustAnalyzer(target);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(bin, path.join(dest, path.basename(bin)));
  fs.chmodSync(path.join(dest, path.basename(bin)), 0o755);
  fs.copyFileSync(path.join(LICENSES_DIR, 'rust-analyzer-LICENSE-MIT.txt'), path.join(dest, 'LICENSE-MIT.txt'));
  fs.copyFileSync(path.join(LICENSES_DIR, 'rust-analyzer-LICENSE-APACHE.txt'), path.join(dest, 'LICENSE-APACHE.txt'));
  fs.writeFileSync(path.join(dest, 'VERSION.txt'), `rust-analyzer ${RA.version} (${target})\nSource: ${RA.source}\nSHA-256 of the release archive: ${RA.targets[target].sha256}\n`);
}

/** The Pyright files the language server needs (relative to the npm package). Everything else is left out. */
export const PYRIGHT_FILES = ['langserver.index.js', 'LICENSE.txt', 'package.json', 'dist/pyright-langserver.js', 'dist/pyright-internal.js', 'dist/vendor.js'];
/** typeshed: the standard library stubs and the license; third-party `stubs/` are not bundled (see the support matrix). */
export const TYPESHED_DIRS = ['dist/typeshed-fallback/stdlib'];
export const TYPESHED_FILES = ['dist/typeshed-fallback/LICENSE', 'dist/typeshed-fallback/commit.txt', 'dist/typeshed-fallback/README.md'];

export function pyrightSource() {
  return path.join(repo, 'packages', 'extension', 'node_modules', 'pyright');
}

/** Copies the needed Pyright files into <dest> (servers/pyright), without source maps or their references. */
export function stagePyright(dest) {
  const src = pyrightSource();
  if (!fs.existsSync(path.join(src, 'langserver.index.js'))) throw new Error('pyright is not installed (pnpm install)');
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of [...PYRIGHT_FILES, ...TYPESHED_FILES]) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let buf = fs.readFileSync(path.join(src, f));
    if (f.endsWith('.js')) buf = Buffer.from(buf.toString('utf8').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n'), 'utf8');
    if (f === 'package.json') {
      const pj = JSON.parse(buf.toString('utf8'));
      buf = Buffer.from(JSON.stringify({ name: pj.name, version: pj.version, license: pj.license, author: pj.author, repository: pj.repository }, null, 2) + '\n');
    }
    fs.writeFileSync(to, buf);
  }
  for (const d of TYPESHED_DIRS) fs.cpSync(path.join(src, d), path.join(dest, d), { recursive: true });
  return JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
}

// ---- Web worker (React / Next.js / Angular, ADR-007): pinned npm packages of packages/web-frameworks, copied from
// node_modules at packaging time. TypeScript (Apache-2.0): the compiler API file and its default lib .d.ts files
// (needed by the checker; no tsc/tsserver executables). @angular/language-service (MIT): its self-contained bundle.
export function webFrameworksModules() {
  return path.join(repo, 'packages', 'web-frameworks', 'node_modules');
}
export const TYPESCRIPT_FILES = ['typescript.js', 'LICENSE.txt', 'ThirdPartyNoticeText.txt', 'package.json'];
/** lib.*.d.ts default library files of the pinned TypeScript, copied next to typescript.js (where the compiler looks). */
export const TYPESCRIPT_LIB = /^lib(\.[\w-]+)*\.d\.ts$/;
export const ANGULAR_LS_FILES = ['bundles/language-service.js', 'package.json', 'LICENSE.txt'];

const stripMap = (buf) => Buffer.from(buf.toString('utf8').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n'), 'utf8');
const trimManifest = (buf) => {
  const pj = JSON.parse(buf.toString('utf8'));
  return Buffer.from(JSON.stringify({ name: pj.name, version: pj.version, license: pj.license, author: pj.author, repository: pj.repository }, null, 2) + '\n');
};

/** Copies the pinned TypeScript and Angular language service into <dest>/typescript and <dest>/angular-language-service. */
export function stageWebWorker(dest) {
  const mods = webFrameworksModules();
  const tsSrc = path.join(mods, 'typescript');
  const ngSrc = path.join(mods, '@angular', 'language-service');
  if (!fs.existsSync(path.join(tsSrc, 'lib', 'typescript.js')) || !fs.existsSync(path.join(ngSrc, 'bundles', 'language-service.js'))) throw new Error('typescript / @angular/language-service are not installed for packages/web-frameworks (pnpm install)');
  const tsDest = path.join(dest, 'typescript');
  const ngDest = path.join(dest, 'angular-language-service');
  fs.rmSync(tsDest, { recursive: true, force: true });
  fs.rmSync(ngDest, { recursive: true, force: true });
  fs.mkdirSync(tsDest, { recursive: true });
  fs.writeFileSync(path.join(tsDest, 'typescript.js'), stripMap(fs.readFileSync(path.join(tsSrc, 'lib', 'typescript.js'))));
  fs.copyFileSync(path.join(tsSrc, 'LICENSE.txt'), path.join(tsDest, 'LICENSE.txt'));
  fs.copyFileSync(path.join(tsSrc, 'ThirdPartyNoticeText.txt'), path.join(tsDest, 'ThirdPartyNoticeText.txt'));
  fs.writeFileSync(path.join(tsDest, 'package.json'), trimManifest(fs.readFileSync(path.join(tsSrc, 'package.json'))));
  for (const f of fs.readdirSync(path.join(tsSrc, 'lib'))) if (TYPESCRIPT_LIB.test(f)) fs.copyFileSync(path.join(tsSrc, 'lib', f), path.join(tsDest, f));
  fs.mkdirSync(path.join(ngDest, 'bundles'), { recursive: true });
  fs.writeFileSync(path.join(ngDest, 'bundles', 'language-service.js'), stripMap(fs.readFileSync(path.join(ngSrc, 'bundles', 'language-service.js'))));
  fs.writeFileSync(path.join(ngDest, 'package.json'), trimManifest(fs.readFileSync(path.join(ngSrc, 'package.json'))));
  fs.copyFileSync(path.join(LICENSES_DIR, 'angular-language-service-LICENSE.txt'), path.join(ngDest, 'LICENSE.txt'));
  return { typescript: JSON.parse(fs.readFileSync(path.join(tsSrc, 'package.json'), 'utf8')).version, angular: JSON.parse(fs.readFileSync(path.join(ngSrc, 'package.json'), 'utf8')).version };
}

// ---- Debug adapters (scripts/package/debuggers.json, ADR-008) ----
// netcoredbg (MIT): the official release archive of the VSIX target, staged into debuggers/netcoredbg (none for targets
// without a build). debugpy (MIT): the pure-Python parts of the official py2.py3-none-any wheel, identical in every VSIX.
export const DBG = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'package', 'debuggers.json'), 'utf8'));
export const NETCOREDBG_TARGETS = Object.keys(DBG.netcoredbg.targets);

async function verifiedDownload(url, sha, what) {
  console.log(`Downloading ${what} (packaging only) …`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== sha) throw new Error(`SHA-256 mismatch for ${url}: expected ${sha}, got ${got}. Refusing to bundle.`);
  return buf;
}

async function cachedVerified(url, sha, dir, what) {
  const file = path.join(dir, path.posix.basename(new URL(url).pathname));
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === sha) return fs.readFileSync(file);
  const buf = await verifiedDownload(url, sha, what);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

/** The verified netcoredbg files of a target ({name, data}[] relative to its netcoredbg/ folder); undefined without a build. */
export async function ensureNetcoredbg(target) {
  const t = DBG.netcoredbg.targets[target];
  if (!t) return undefined;
  const buf = await cachedVerified(t.url, t.sha256, path.join(repo, '.cache', 'netcoredbg', DBG.netcoredbg.version, target), `netcoredbg ${DBG.netcoredbg.version} for ${target}`);
  const entries = (t.url.endsWith('.zip') ? unzipAll(buf) : untarGzAll(buf))
    .filter((e) => e.name.startsWith('netcoredbg/'))
    .map((e) => ({ name: e.name.slice('netcoredbg/'.length), data: e.data }));
  if (!entries.some((e) => e.name === t.binary)) throw new Error(`${t.binary} not found in ${t.url}`);
  return entries;
}

/** Stages netcoredbg for a target into <dest> (debuggers/netcoredbg); false when no official build exists for it. */
export async function stageNetcoredbg(target, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  const entries = await ensureNetcoredbg(target);
  if (!entries) return false;
  const t = DBG.netcoredbg.targets[target];
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const to = path.join(dest, e.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, e.data);
  }
  fs.chmodSync(path.join(dest, t.binary), 0o755);
  fs.copyFileSync(path.join(LICENSES_DIR, 'netcoredbg-LICENSE.txt'), path.join(dest, 'LICENSE.txt'));
  const third = DBG.netcoredbg.licenses.slice(1).map((l) => `==== ${l.what} ====\n\n${fs.readFileSync(path.join(LICENSES_DIR, l.file), 'utf8').trim()}\n`);
  fs.writeFileSync(path.join(dest, 'THIRD-PARTY-LICENSES.txt'), third.join('\n'));
  fs.writeFileSync(path.join(dest, 'VERSION.txt'), `netcoredbg ${DBG.netcoredbg.version} (${target})\nSource: ${DBG.netcoredbg.source}\nSHA-256 of the release archive: ${t.sha256}\n`);
  return true;
}

/** debugpy wheel entries that are staged: pure Python and data only (see debuggers.json). */
export function debugpyKeep(name) {
  if (!name.startsWith('debugpy/')) return false;
  if (/(^|\/)tests?\//.test(name)) return false;
  if (name.includes('/pydevd_attach_to_process/') && !name.endsWith('.py')) return false;
  if (/(^|\/)\.gitignore$/.test(name)) return false;
  // Protocol schemas only read by pydevd's code generator (__main__pydevd_gen_debug_adapter_protocol.py), not at run time.
  if (/\/_debug_adapter\/[^/]+\.json$/.test(name)) return false;
  return !/\.(pdb|c|pyx|pxd|pyd|so|dll|dylib|exe|cpp|hpp|h|sh|cmd|bat)$/i.test(name);
}

/** Stages the verified debugpy wheel's pure-Python files into <dest> (debuggers/debugpy); returns the version. */
export async function stageDebugpy(dest) {
  const d = DBG.debugpy;
  const buf = await cachedVerified(d.url, d.sha256, path.join(repo, '.cache', 'debugpy', d.version), `debugpy ${d.version}`);
  fs.rmSync(dest, { recursive: true, force: true });
  const entries = unzipAll(buf);
  for (const e of entries) {
    if (!debugpyKeep(e.name)) continue;
    const to = path.join(dest, e.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, e.data);
  }
  const lic = entries.find((e) => /dist-info\/(licenses\/)?LICENSE$/.test(e.name));
  if (!lic) throw new Error('the debugpy wheel has no LICENSE');
  fs.writeFileSync(path.join(dest, 'LICENSE.txt'), lic.data);
  fs.writeFileSync(path.join(dest, 'VERSION.txt'), `debugpy ${d.version} (pure-Python parts)\nSource: ${d.source}\nSHA-256 of the wheel: ${d.sha256}\n`);
  return d.version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--target');
  const target = i >= 0 ? process.argv[i + 1] : currentTarget();
  if (process.argv.includes('--rust-analyzer')) console.log(await ensureRustAnalyzer(target));
  // Development: stage the debug adapters into packages/extension/debuggers (the extension's dev mode finds them there).
  if (process.argv.includes('--debuggers')) {
    const base = path.join(repo, 'packages', 'extension', 'debuggers');
    console.log((await stageNetcoredbg(target, path.join(base, 'netcoredbg'))) ? `netcoredbg staged for ${target}` : `no netcoredbg build for ${target}`);
    console.log(`debugpy ${await stageDebugpy(path.join(base, 'debugpy'))} staged`);
  }
}
