// Bundles the extension (and the workspace packages it uses) into dist/extension.js with esbuild.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..', '..');
const src = (pkg) => path.join(repo, 'packages', pkg, 'src', 'index.ts');
const production = process.argv.includes('--production');

// Type-check first (esbuild only strips types). `tsc -b` also builds the referenced packages.
execFileSync(process.execPath, [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });

// The CSS/HTML language services publish a UMD "main" whose inner requires esbuild cannot follow: bundle their ESM
// build (the package's own "module" entry) instead. Only these two packages are redirected. Their browser data
// (descriptions of every CSS property and HTML tag, ~1.7 MB, used only by completion/hover, which Refyntra does not
// offer) is replaced by empty data sets: Refyntra uses the parsers, symbols, links and the HTML scanner only.
const esmEntry = {
  name: 'refyntra-esm-entry',
  setup(b) {
    b.onResolve({ filter: /^vscode-(css|html)-languageservice$/ }, (args) => {
      const pj = createRequire(path.join(args.resolveDir, 'index.js')).resolve(`${args.path}/package.json`);
      const entry = JSON.parse(fs.readFileSync(pj, 'utf8')).module;
      return entry ? { path: path.join(path.dirname(pj), entry) } : undefined;
    });
    b.onResolve({ filter: /\/data\/webCustomData$/ }, (args) =>
      /[\\/]vscode-(css|html)-languageservice[\\/]/.test(args.importer) ? { path: /vscode-css/.test(args.importer) ? 'css' : 'html', namespace: 'refyntra-empty-web-data' } : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: 'refyntra-empty-web-data' }, (args) => ({
      contents: args.path === 'css' ? 'export const cssData = { version: 1.1, properties: [], atDirectives: [], pseudoClasses: [], pseudoElements: [] };' : 'export const htmlData = { version: 1.1, tags: [], globalAttributes: [], valueSets: [] };',
      loader: 'js',
    }));
  },
};

const result = await build({
  plugins: [esmEntry],
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
    '@refyntra/adapter-lsp': src('adapter-lsp'),
    '@refyntra/adapter-web-styles': src('adapter-web-styles'),
    '@refyntra/web-frameworks/node': path.join(repo, 'packages', 'web-frameworks', 'src', 'node.ts'),
    '@refyntra/web-frameworks': src('web-frameworks'),
  },
});
fs.writeFileSync(path.join(root, 'dist', 'extension.meta.json'), JSON.stringify(result.metafile));

// The web worker (React / Next.js / Angular, ADR-007): its own process entry. TypeScript and the Angular language
// service are NOT bundled into it; the worker loads the pinned copies staged in servers/ (or the dev node_modules).
await build({
  entryPoints: [path.join(repo, 'packages', 'web-frameworks', 'src', 'worker', 'main.ts')],
  outfile: path.join(root, 'dist', 'webWorker.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['typescript'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});
