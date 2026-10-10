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

/** Minimal ZIP reader (stored/deflated entries) for the Windows release archive; no external tools. */
function unzipEntry(buf, wanted) {
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
    if (path.posix.basename(name) === wanted) {
      const lName = buf.readUInt16LE(local + 26);
      const lExtra = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found in the archive`);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--target');
  const target = i >= 0 ? process.argv[i + 1] : currentTarget();
  if (process.argv.includes('--rust-analyzer')) console.log(await ensureRustAnalyzer(target));
}
