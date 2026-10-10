// Bundles the extension (and the workspace packages it uses) into dist/extension.js with esbuild.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..', '..');
const src = (pkg) => path.join(repo, 'packages', pkg, 'src', 'index.ts');
const production = process.argv.includes('--production');

// Type-check first (esbuild only strips types). `tsc -b` also builds the referenced packages.
execFileSync(process.execPath, [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });

const result = await build({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  metafile: true, // consumed by scripts/package/notices.mjs to derive the bundled npm packages
  logLevel: 'info',
  alias: {
    '@refyntra/contracts': src('contracts'),
    '@refyntra/domain': src('domain'),
    '@refyntra/application': src('application'),
    '@refyntra/infrastructure': src('infrastructure'),
    '@refyntra/adapter-vscode-providers': src('adapter-vscode-providers'),
  },
});
fs.writeFileSync(path.join(root, 'dist', 'extension.meta.json'), JSON.stringify(result.metafile));
