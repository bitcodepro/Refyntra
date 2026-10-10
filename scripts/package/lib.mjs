// Shared helpers for notices.mjs and audit.mjs: locating the VSIX and extracting it to a temp directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const extPkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages', 'extension', 'package.json'), 'utf8'));
export const defaultVsix = path.join(repo, 'dist', `${extPkg.name}-${extPkg.version}.vsix`);

export function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Returns the VSIX path, building it with `pnpm package:vsix` when it does not exist. */
export function ensureVsix() {
  const vsix = path.resolve(argValue('--vsix') ?? defaultVsix);
  if (!fs.existsSync(vsix)) {
    if (argValue('--vsix')) throw new Error(`VSIX not found: ${vsix}`);
    console.log(`${path.relative(repo, vsix)} is missing; running pnpm package:vsix ...`);
    const r = spawnSync('pnpm', ['package:vsix'], { cwd: repo, stdio: 'inherit', shell: true });
    if (r.status !== 0 || !fs.existsSync(vsix)) throw new Error('pnpm package:vsix failed');
  }
  return vsix;
}

/** Extracts a VSIX (zip) into a fresh temp directory; returns the directory. */
export function extractVsix(vsix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-vsix-'));
  const attempts = [['tar', ['-xf', vsix, '-C', dir]], ['unzip', ['-q', vsix, '-d', dir]]];
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe' });
      if (fs.existsSync(path.join(dir, 'extension'))) return dir;
    } catch { /* try the next extractor */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  throw new Error('could not extract the VSIX (need bsdtar or unzip on PATH)');
}

export function walk(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

export const rel = (base, file) => path.relative(base, file).split(path.sep).join('/');
