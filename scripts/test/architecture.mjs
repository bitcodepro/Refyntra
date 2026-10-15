// Import-boundary checks. Run: pnpm test:architecture
//   contracts       imports nothing (only relative files)
//   domain          contracts only; no vscode, no node builtins
//   application     contracts + domain only; no vscode, no node builtins, no infrastructure/extension
//   infrastructure  no extension, no adapter-testing
//   extension       no adapter-testing (fake adapters never reach presentation)
//   adapter-testing no extension
//   adapter-vscode-providers  contracts + domain + application (+ type-only vscode); no infrastructure/extension/adapter-testing
//   adapter-lsp     contracts + domain + application + adapter-vscode-providers (shared text rules); no vscode, no node
//                   builtins, no infrastructure: the LSP client (process, framing, JSON-RPC) lives in infrastructure and
//                   reaches the adapter only through the application's LspConnection port
//   adapter-web-styles  contracts + domain + application + the bundled MIT parsers (vscode-css-languageservice,
//                   vscode-html-languageservice, vscode-languageserver-textdocument); no vscode, no node builtins, no
//                   processes: pure in-process parsing, composed only by the extension composition root
//   web-frameworks  contracts + domain + application (+ type-only typescript); no vscode. Node builtins only in the
//                   Node parts (src/worker/ = the worker process, src/host/ = its process client, src/node/, src/node.ts);
//                   the pure parts (service, protocol, conventions) never import them. src/host/workerProcess.ts is the
//                   only file outside infrastructure that starts a process: Refyntra's own web worker (ADR-007).
//   The LSP client (lspClient.ts) lives in infrastructure; application and domain never import it.
//   Only the extension composition root (packages/extension/src/extension.ts) and the test-support package
//   adapter-testing may import @refyntra/adapter-vscode-providers (application/domain never do).
// Also checks that package.json dependencies do not declare forbidden packages.
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const RULES = {
  contracts: { allow: [], forbidVscode: true, forbidBuiltins: true },
  domain: { allow: ['@refyntra/contracts'], forbidVscode: true, forbidBuiltins: true },
  application: { allow: ['@refyntra/contracts', '@refyntra/domain'], forbidVscode: true, forbidBuiltins: true },
  infrastructure: { forbid: ['@refyntra/extension', 'refyntra', '@refyntra/adapter-testing'] },
  extension: { forbid: ['@refyntra/adapter-testing'] },
  'adapter-testing': { forbid: ['@refyntra/extension', 'refyntra', 'vscode'] },
  'adapter-vscode-providers': { allow: ['@refyntra/contracts', '@refyntra/domain', '@refyntra/application', 'vscode'], forbidVscodeValue: true },
  'adapter-lsp': { allow: ['@refyntra/contracts', '@refyntra/domain', '@refyntra/application', '@refyntra/adapter-vscode-providers'], forbidVscode: true, forbidBuiltins: true },
  'web-frameworks': { allow: ['@refyntra/contracts', '@refyntra/domain', '@refyntra/application', 'typescript'], forbidVscode: true, forbidBuiltins: true, nodeParts: /^packages\/web-frameworks\/src\/(worker\/|host\/|node\/|node\.ts$)/, typeOnly: ['typescript'] },
  'adapter-web-styles': { allow: ['@refyntra/contracts', '@refyntra/domain', '@refyntra/application', 'vscode-css-languageservice', 'vscode-html-languageservice', 'vscode-languageserver-textdocument'], forbidVscode: true, forbidBuiltins: true },
};

const PROVIDERS_PKG = '@refyntra/adapter-vscode-providers';
/** Files allowed to import the delegated provider adapter (composition root + test support). */
function mayImportProviders(rel) {
  return rel === 'packages/extension/src/extension.ts' || rel.startsWith('packages/adapter-testing/') || rel.startsWith('packages/adapter-vscode-providers/') || rel.startsWith('packages/adapter-lsp/');
}
/** A value (non-type) import of vscode: the provider adapter receives the vscode API from the composition root. */
const VSCODE_VALUE_RE = /(?:^|[\s;])import\s+(?!type\b)[^;'"]*from\s+['"]vscode['"]|(?:^|[\s;])import\s+['"]vscode['"]|require\s*\(\s*['"]vscode['"]\s*\)/m;

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Returns violations for one package source text (exported for the self-test below). */
export function checkSource(pkg, file, text) {
  const rule = RULES[pkg];
  const out = [];
  if (!rule) return out;
  const relFile = path.relative(repo, file).split(path.sep).join('/');
  const nodePart = !!rule.nodeParts?.test(relFile);
  for (const m of stripComments(text).matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (rule.typeOnly?.includes(spec) && !/^\s*;?\s*(import|export)\s+type\s/.test(m[0])) out.push(`${file}: ${pkg} may import ${spec} only as a type (the worker loads the bundled copy at run time)`);
    if (rule.nodeParts && !nodePart && spec && spec.startsWith('.') && rule.nodeParts.test(path.relative(repo, path.resolve(path.dirname(file), spec)).split(path.sep).join('/') + '/')) out.push(`${file}: the pure part of ${pkg} must not import its Node parts ("${spec}")`);
    if (!spec || spec.startsWith('.')) {
      if (spec && pkg !== 'extension') {
        const resolved = path.resolve(path.dirname(file), spec);
        const ownSrc = path.join(repo, 'packages', pkg);
        if (!resolved.startsWith(ownSrc)) out.push(`${file}: relative import "${spec}" leaves package ${pkg}`);
      }
      continue;
    }
    const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (rule.forbidVscode && bare === 'vscode') out.push(`${file}: ${pkg} must not import vscode`);
    else if (rule.forbidBuiltins && !nodePart && (BUILTINS.has(spec) || BUILTINS.has(bare))) out.push(`${file}: ${pkg} must not import node builtin "${spec}"`);
    else if (rule.allow && !rule.allow.includes(bare) && !(nodePart && (BUILTINS.has(spec) || BUILTINS.has(bare))) && !(rule.forbidVscodeValue && (BUILTINS.has(spec) || BUILTINS.has(bare)))) out.push(`${file}: ${pkg} may only import ${rule.allow.join(', ') || 'relative files'}, found "${spec}"`);
    if (bare === PROVIDERS_PKG && !mayImportProviders(path.relative(repo, file).replace(/\\/g, '/'))) out.push(`${file}: only the extension composition root (extension.ts) may import ${PROVIDERS_PKG}`);
    if (rule.forbid?.includes(bare)) out.push(`${file}: ${pkg} must not import "${spec}"`);
  }
  if (rule.forbidVscodeValue && VSCODE_VALUE_RE.test(stripComments(text))) out.push(`${file}: ${pkg} may import vscode only as a type (the API is injected by the composition root)`);
  return out;
}

function checkManifest(pkg) {
  const rule = RULES[pkg];
  const file = path.join(repo, 'packages', pkg, 'package.json');
  if (!fs.existsSync(file)) return [`missing ${file}`];
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const deps = Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies });
  const internal = deps.filter((d) => d.startsWith('@refyntra/'));
  const out = [];
  if (rule.allow) for (const d of internal) if (!rule.allow.includes(d)) out.push(`${file}: ${pkg} must not depend on ${d}`);
  if (rule.forbid) for (const d of deps) if (rule.forbid.includes(d)) out.push(`${file}: ${pkg} must not depend on ${d}`);
  if (rule.forbidVscode && deps.some((d) => d === 'vscode' || d === '@types/vscode')) out.push(`${file}: ${pkg} must not depend on vscode`);
  if (pkg !== 'extension' && pkg !== 'adapter-testing' && pkg !== 'adapter-vscode-providers' && pkg !== 'adapter-lsp' && deps.includes(PROVIDERS_PKG)) out.push(`${file}: ${pkg} must not depend on ${PROVIDERS_PKG}`);
  return out;
}

function selfTest() {
  const f = path.join(repo, 'packages', 'domain', 'src', 'x.ts');
  const cases = [
    ['domain', "import * as vscode from 'vscode';", 1],
    ['domain', "import { readFile } from 'node:fs';", 1],
    ['application', "import { x } from '@refyntra/infrastructure';", 1],
    ['application', "export * from '@refyntra/domain';", 0],
    ['contracts', "import { a } from '@refyntra/domain';", 1],
    ['extension', "import { FixtureEngine } from '@refyntra/adapter-testing';", 1],
    ['domain', "// import 'vscode'\nconst a = 1;", 0],
    ['application', "const cp = require('child_process');", 1],
    ['domain', "import type { Range } from '@refyntra/contracts';", 0],
    ['application', "import { DelegatedProviderAdapter } from '@refyntra/adapter-vscode-providers';", 2],
    ['domain', "import { TS_JS_DESCRIPTOR } from '@refyntra/adapter-vscode-providers';", 2],
    ['adapter-vscode-providers', "import * as vscode from 'vscode';", 1],
    ['adapter-vscode-providers', "import type * as vscode from 'vscode';", 0],
    ['adapter-vscode-providers', "import { x } from '@refyntra/infrastructure';", 1],
    ['adapter-vscode-providers', "import { createHash } from 'node:crypto';", 0],
    ['adapter-lsp', "import { x } from '@refyntra/infrastructure';", 1],
    ['adapter-lsp', "import { spawn } from 'node:child_process';", 1],
    ['adapter-lsp', "import type * as vscode from 'vscode';", 1],
    ['application', "import { createLspConnectionFactory } from '@refyntra/infrastructure';", 1],
    ['adapter-web-styles', "import { getCSSLanguageService } from 'vscode-css-languageservice';", 0],
    ['adapter-web-styles', "import * as vscode from 'vscode';", 1],
    ['adapter-web-styles', "import { readFile } from 'node:fs';", 1],
    ['adapter-web-styles', "import { x } from '@refyntra/infrastructure';", 1],
    ['application', "import { WebStyleService } from '@refyntra/adapter-web-styles';", 1],
    ['web-frameworks', "import type * as TS from 'typescript';", 0],
    ['web-frameworks', "import * as ts from 'typescript';", 1],
    ['web-frameworks', "import { readFileSync } from 'node:fs';", 1],
    ['web-frameworks', "import * as vscode from 'vscode';", 1],
    ['web-frameworks', "import { WorkerProcess } from './host/workerProcess';", 1],
    ['web-frameworks', "import { x } from '@refyntra/infrastructure';", 1],
    ['application', "import { WebFrameworkService } from '@refyntra/web-frameworks';", 1],
  ];
  const nodeFile = path.join(repo, 'packages', 'web-frameworks', 'src', 'worker', 'x.ts');
  if (checkSource('web-frameworks', nodeFile, "import * as fs from 'node:fs';").length !== 0) throw new Error('architecture self-test failed: web-frameworks worker may use node builtins');
  for (const [pkg, src, expected] of cases) {
    const got = checkSource(pkg, f, src).length;
    if (got !== expected) throw new Error(`architecture self-test failed for ${pkg}: ${JSON.stringify(src)} → ${got} violations, expected ${expected}`);
  }
}

selfTest();
const violations = [];
let files = 0;
for (const pkg of Object.keys(RULES)) {
  violations.push(...checkManifest(pkg));
  for (const file of walk(path.join(repo, 'packages', pkg, 'src'))) {
    files++;
    violations.push(...checkSource(pkg, file, fs.readFileSync(file, 'utf8')).map((v) => path.relative(repo, v.split(': ')[0]) + ': ' + v.split(': ').slice(1).join(': ')));
  }
}
// Exactly one owner of workspace.applyEdit.
for (const pkg of Object.keys(RULES)) {
  for (const file of walk(path.join(repo, 'packages', pkg, 'src'))) {
    if (/\bapplyEdit\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8'))) && path.relative(repo, file).replace(/\\/g, '/') !== 'packages/extension/src/editApplier.ts') {
      violations.push(`${path.relative(repo, file)}: only packages/extension/src/editApplier.ts may call workspace.applyEdit`);
    }
  }
}
// Refyntra never registers language providers of its own (it only calls public provider commands or talks LSP to its
// own server processes), never uses vscode-languageclient, and only infrastructure starts processes.
for (const pkg of Object.keys(RULES)) {
  for (const file of walk(path.join(repo, 'packages', pkg, 'src'))) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const r = path.relative(repo, file);
    // The one exception: C# Go to Definition / Implementation (definition.ts), only active without the C# extension.
    const definitionFile = r.split(path.sep).join('/') === 'packages/extension/src/definition.ts';
    if (!definitionFile && /\blanguages\.register(Definition|Rename|Reference|Implementation|DocumentSymbol|WorkspaceSymbol|TypeDefinition|Declaration)Provider\s*\(/.test(text)) violations.push(`${r}: Refyntra must not register VS Code navigation/rename providers`);
    if (/['"]vscode-languageclient(\/[^'"]*)?['"]/.test(text)) violations.push(`${r}: vscode-languageclient must not be used (own LSP client in infrastructure)`);
    if (pkg !== 'infrastructure' && pkg !== 'extension' && r.split(path.sep).join('/') !== 'packages/web-frameworks/src/host/workerProcess.ts' && /['"](node:)?child_process['"]/.test(text)) violations.push(`${r}: only infrastructure (and the composition root's tasks) may start processes`);
  }
}
if (violations.length) {
  console.error(`Architecture check failed (${violations.length}):\n  ${violations.join('\n  ')}`);
  process.exit(1);
}
console.log(`Architecture check passed: ${files} source files in ${Object.keys(RULES).length} packages.`);
