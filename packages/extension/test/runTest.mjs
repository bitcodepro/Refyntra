// Runs the extension inside a real VS Code Extension Host (@vscode/test-electron).
//   node test/runTest.mjs          integration scenarios (no .NET host needed)
//   node test/runTest.mjs --visual screenshots (Docker/Xvfb only, scripts/test/linux-visual.sh): REFYNTRA_HOST_PATH, REFYNTRA_VISUAL_OUT=<dir>
//   node test/runTest.mjs --e2e    against the real host: REFYNTRA_HOST_PATH=<Refyntra.Host.dll> [REFYNTRA_E2E_WORKSPACE=<folder>]
// VS Code version: REFYNTRA_TEST_VSCODE_VERSION (default: the minimum supported engine, 1.90.2).
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { currentTarget, ensureRustAnalyzer } from '../../../scripts/package/servers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '..');
const repo = path.resolve(extensionDevelopmentPath, '..', '..');
const cachePath = path.join(repo, '.vscode-test');
const version = process.env.REFYNTRA_TEST_VSCODE_VERSION || '1.90.2';
const extensionTestsPath = path.join(here, 'suite', 'index.cjs');
const visual = process.argv.includes('--visual');
const e2e = process.argv.includes('--e2e') || visual;

function userDataDir(name, settings) {
  const dir = path.join(cachePath, 'user-data', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'User'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

const baseSettings = {
  'security.workspace.trust.startupPrompt': 'never',
  'security.workspace.trust.banner': 'never',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'workbench.startupEditor': 'none',
};

/**
 * Copies tests/fixtures/Shop (+ the shielding Directory.* files) into a fresh temp folder, adds a CRLF + BOM + emoji
 * source file and restores it. Apply scenarios work only on such copies: the repository fixture is never modified.
 */
function shopCopy(name, opts = {}) {
  const fixtures = path.join(repo, 'tests', 'fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `refyntra-${name}-`));
  for (const f of fs.readdirSync(fixtures)) if (f.startsWith('Directory.')) fs.copyFileSync(path.join(fixtures, f), path.join(root, f));
  const dest = path.join(root, 'Shop');
  fs.cpSync(path.join(fixtures, 'Shop'), dest, { recursive: true, filter: (src) => !/[\\/](bin|obj)$/.test(src) });
  const unicode = '\ufeff// \u{1F680} CRLF + BOM + emoji \u{1F469}\u200D\u{1F469}\u200D\u{1F467}\r\nusing Shop.Contracts.Orders;\r\n\r\nnamespace Shop.Api.Services;\r\n\r\npublic static class UnicodeUser\r\n{\r\n    /* \u{1F680} */ public static GetOrderQuery Make() => new GetOrderQuery(1); // \u{1F680}\r\n}\r\n';
  fs.writeFileSync(path.join(dest, 'Shop.Api', 'Services', 'UnicodeUser.cs'), unicode, 'utf8');
  opts.extra?.(dest);
  if (opts.restore === false) return { workspace: dest, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
  const r = spawnSync('dotnet', ['restore', path.join(dest, 'Shop.sln'), '--nologo'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`dotnet restore of the ${name} copy failed`);
  return { workspace: dest, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
}

/**
 * A temp TypeScript mini-project for the delegated TS/JS route. `closed.ts` is never opened by the
 * tests (its edits are read from disk); nothing in the repository is modified.
 */
function tsProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `refyntra-${name}-`));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs', jsx: 'react' }, include: ['src'] }, null, 2));
  fs.writeFileSync(path.join(src, 'orders.ts'), 'export function getOrder(id: number): number {\n  return id;\n}\n\nexport class OrderService {\n  load(): number {\n    return getOrder(1);\n  }\n}\n');
  fs.writeFileSync(path.join(src, 'use.ts'), "import { getOrder } from './orders';\n\nexport const first = getOrder(1);\n");
  fs.writeFileSync(path.join(src, 'closed.ts'), "import { getOrder } from './orders';\n\nexport const second = getOrder(2);\n");
  return { workspace: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
}

/**
 * A temp Python + Rust mini-project for the Python and Rust language-server routes (generic code; nothing in the
 * repository is modified). No extension besides Refyntra runs in the test profile: Python uses the bundled Pyright,
 * Rust the bundled rust-analyzer. `app/closed.py` is never opened by the tests.
 */
function pyRustProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `refyntra-${name}-`));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app', 'orders.py'), `def get_order(order_id):
    return order_id


class OrderService:
    def load(self):
        return get_order(1)
`);
  fs.writeFileSync(path.join(root, 'app', 'use.py'), `from app.orders import get_order

first = get_order(1)
`);
  fs.writeFileSync(path.join(root, 'app', 'closed.py'), `from app.orders import get_order

second = get_order(2)
`);
  fs.writeFileSync(path.join(root, 'Cargo.toml'), `[package]
name = "orders"
version = "0.1.0"
edition = "2021"
`);
  fs.writeFileSync(path.join(root, 'src', 'lib.rs'), `mod usage;

pub fn get_order(id: u32) -> u32 {
    id
}
`);
  fs.writeFileSync(path.join(root, 'src', 'usage.rs'), `use crate::get_order;

pub fn first() -> u32 {
    get_order(1)
}
`);
  return { workspace: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
}

/** Copies tests/fixtures/<fixture> (+ the shielding Directory.* files) into a fresh temp folder and restores it. */
function fixtureCopy(name, fixture, sln) {
  const fixtures = path.join(repo, 'tests', 'fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `refyntra-${name}-`));
  for (const f of fs.readdirSync(fixtures)) if (f.startsWith('Directory.')) fs.copyFileSync(path.join(fixtures, f), path.join(root, f));
  const dest = path.join(root, fixture);
  fs.cpSync(path.join(fixtures, fixture), dest, { recursive: true, filter: (src) => !/[\\/](bin|obj)$/.test(src) });
  const r = spawnSync('dotnet', ['restore', path.join(dest, sln), '--nologo'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`dotnet restore of the ${name} copy failed`);
  return { workspace: dest, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
}

/**
 * Visual scenarios: fixed theme, font, zoom and layout; no animations, cursor blink, minimap, tips, welcome page or
 * telemetry. One scenario per theme; screenshots go to $REFYNTRA_VISUAL_OUT/<theme>/.
 */
const visualSettings = {
  'window.titleBarStyle': 'custom',
  'window.zoomLevel': 0,
  'window.commandCenter': false,
  'window.restoreWindows': 'none',
  'workbench.reduceMotion': 'on',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.layoutControl.enabled': false,
  'workbench.editor.enablePreview': false,
  'workbench.list.smoothScrolling': false,
  'editor.fontFamily': "'DejaVu Sans Mono', monospace",
  'editor.fontSize': 14,
  'editor.lineHeight': 20,
  'editor.fontLigatures': false,
  'editor.cursorBlinking': 'solid',
  'editor.cursorSmoothCaretAnimation': 'off',
  'editor.smoothScrolling': false,
  'editor.minimap.enabled': false,
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.matchBrackets': 'never',
  'editor.hover.delay': 300,
  'editor.hover.sticky': true,
  'editor.lightbulb.enabled': 'on',
  'editor.accessibilitySupport': 'off',
  'editor.codeLens': true,
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
  'scm.diffDecorations': 'none',
  'files.autoSave': 'off',
  'refyntra.rename.apply': true,
  'refyntra.preview.style': 'native',
  // Run and Debug UI off for the older screenshots (their baselines predate it); the run cases switch it on.
  'refyntra.run.statusBar': false,
  'refyntra.run.editorButtons': false,
  'refyntra.run.view': false,
  'refyntra.run.codeLens': false,
};
const visualThemes = { dark: 'Default Dark Modern', light: 'Default Light Modern' };

const scenarios = visual
  ? Object.entries(visualThemes).map(([theme, colorTheme]) => ({
      name: `visual-${theme}`,
      copy: `visual-${theme}`,
      trusted: true,
      settings: { ...visualSettings, 'workbench.colorTheme': colorTheme },
      // Software rendering: without it the GPU process fails under Xvfb and webviews do not load ("Could not register
      // service worker"); it also keeps the pixels the same from run to run.
      launchArgs: ['--disable-gpu'],
      env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '', REFYNTRA_VISUAL_OUT: path.join(process.env.REFYNTRA_VISUAL_OUT || path.join(repo, 'test-results', 'visual', 'actual'), theme) },
    }))
  : e2e
  ? [
      {
        name: 'e2e',
        workspace: process.env.REFYNTRA_E2E_WORKSPACE || path.join(here, 'workspaces', 'tiny'),
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // The plan's navigation journeys and rename preview on the two-project fixture (restored by the host tests).
      {
        name: 'shop',
        workspace: path.join(here, '..', '..', '..', 'tests', 'fixtures', 'Shop'),
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Stage C: apply with the experimental setting on, on a temp copy of Shop (fault injection, Undo, encodings).
      {
        name: 'rename-apply',
        copy: 'rename-apply',
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // File rename: rename a type together with its file (closed/open dirty file, stale target, failure injection, Undo).
      {
        name: 'rename-file',
        copy: 'rename-file',
        copyOpts: { extra: (dest) => { for (const [rel, text] of Object.entries(createRequire(import.meta.url)('./suite/fileRename.cjs').extraFiles)) fs.writeFileSync(path.join(dest, ...rel.split('/')), text); } },
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Created files: Move Type to File (apply, Undo, stale target, create failure) and Generate handler.
      {
        name: 'create-file',
        copy: 'create-file',
        copyOpts: { extra: (dest) => { for (const [rel, text] of Object.entries(createRequire(import.meta.url)('./suite/createFile.cjs').extraFiles)) fs.writeFileSync(path.join(dest, ...rel.split('/')), text); } },
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Recovery click "Run dotnet restore": the copy is NOT restored (no obj/), the host reports the restore action.
      {
        name: 'restore-recovery',
        copy: 'restore-recovery',
        copyOpts: { restore: false },
        trusted: true,
        // PowerShell as the terminal shell: a shell command line would expand $(...) in the file name (review S1).
        settings: { 'terminal.integrated.defaultProfile.windows': 'PowerShell' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Delegated TS/JS route on a temp TS project with the built-in TypeScript extension enabled
      // (no --disable-extensions; the extensions dir is empty, so only built-in extensions run).
      {
        name: 'ts-delegated',
        tsProject: true,
        builtinExtensions: true,
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Stage D: OR1001 in the Problems collection (with the proof path) and the Tests group of Related, on a temp
      // copy of the DiRules fixture (DI rule corpus + an xUnit test project).
      {
        name: 'di-rules',
        fixtureCopy: ['DiRules', 'DiRules.sln'],
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // MVC controllers/actions on a temp copy of the Mvc fixture (Related on an action, Find route:).
      {
        name: 'mvc',
        fixtureCopy: ['Mvc', 'Mvc.sln'],
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // EF Core on a temp copy of the EfCore fixture (Related on an entity and a DbContext, Find entity:/table:).
      {
        name: 'efcore',
        fixtureCopy: ['EfCore', 'EfCore.sln'],
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Rename of a DbContext referenced from EF Core migrations, on a temp copy of the EfCore fixture: update the
      // migrations (apply + Undo) or rename only the class (limited, "will not build").
      {
        name: 'rename-efcore',
        fixtureCopy: ['EfCore', 'EfCore.sln'],
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Code Cleanup on a temp copy of the Cleanup fixture: clean up a folder, apply (not saved), Undo; stale plan.
      {
        name: 'cleanup',
        fixtureCopy: ['Cleanup', 'Cleanup.sln'],
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Safe Delete, Extract Method, Change Signature on a temp copy of the Refactorings fixture: apply, file deletion
      // with host resync, Undo (restore), a delete refused when the file changed in the last moment.
      {
        name: 'code-refactor',
        fixtureCopy: ['Refactorings', 'Refactorings.sln'],
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Native VS Code UI on a temp copy of Shop: code action kinds, CodeLens resolve, Call/Type Hierarchy, MediatR hover,
      // the Refactor Preview (apply, discard, stale refused) and the Change Signature dialog.
      {
        name: 'native-ui',
        copy: 'native-ui',
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off', 'refyntra.preview.style': 'native' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Stack trace navigation on a temp copy of the StackTraces fixture (path-suffix matching, ambiguity, by symbol).
      {
        name: 'stack-trace',
        fixtureCopy: ['StackTraces', 'StackTraces.csproj'],
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // Frontend ↔ backend HTTP links (heuristic) on a temp copy of the FullStack fixture (Minimal API + MVC + a TS
      // frontend), with the built-in TypeScript extension enabled.
      {
        name: 'full-stack',
        fixtureCopy: ['FullStack', 'FullStack.sln'],
        builtinExtensions: true,
        trusted: true,
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // HTML/CSS/SCSS/LESS ↔ code links on a temp copy of the WebStyles fixture, with every other extension disabled
      // (also VS Code's built-in language features): Refyntra's bundled CSS/HTML language services answer alone.
      { name: 'web-styles', plainCopy: 'WebStyles', trusted: true, env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' } },
      // React / Next.js / Angular through Refyntra's web worker on temp copies of the Web* fixtures, every other
      // extension disabled (also VS Code's built-in TypeScript features).
      { name: 'web-frameworks', webCopy: ['WebReact', 'WebNext', 'WebAngular', 'WebAngularOld'], trusted: true, env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' } },
      { name: 'web-frameworks-restricted', webCopy: ['WebReact'], trusted: false, env: { REFYNTRA_HOST_PATH: '', REFYNTRA_TEST_FORCE_RESTRICTED: '1' } },
      // Run and Debug on a temp copy of the Runnable fixture, every other extension disabled: the bundled netcoredbg
      // (breakpoint, locals, exit code) and debugpy (system Python), a web app run with its launch profile.
      { name: 'run-debug', fixtureCopy: ['Runnable', 'Runnable.sln'], trusted: true, env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' } },
      // Task context on a temp copy of Shop: add, move by an edit, reload, rename through Refyntra, delete.
      {
        name: 'task-context',
        copy: 'task-context',
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
      // A target saved in Windows-1251 (not UTF-8): the apply must be refused and no file may change.
      {
        name: 'rename-nonutf8',
        copy: 'rename-nonutf8',
        copyOpts: {
          extra: (dest) =>
            fs.writeFileSync(
              path.join(dest, 'Shop.Api', 'Services', 'Legacy1251.cs'),
              // "// <Privet in Cyrillic>" in Windows-1251, then code that references GetOrderQuery.
              Buffer.concat([Buffer.from('// ', 'latin1'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from('\r\nusing Shop.Contracts.Orders;\r\nnamespace Shop.Api.Services;\r\npublic static class Legacy1251\r\n{\r\n    public static GetOrderQuery Make() => new GetOrderQuery(2);\r\n}\r\n', 'latin1')]),
            ) ||
            // Mixed line endings (CRLF and LF) in a closed file that references CancelOrderCommand.
            fs.writeFileSync(
              path.join(dest, 'Shop.Api', 'Services', 'MixedEol.cs'),
              'using Shop.Contracts.Orders;\r\nnamespace Shop.Api.Services;\r\npublic static class MixedEol\n{\n    public static CancelOrderCommand Make() => new CancelOrderCommand(3);\n}\n',
            ),
        },
        trusted: true,
        settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' },
        env: { REFYNTRA_HOST_PATH: process.env.REFYNTRA_HOST_PATH ?? '' },
      },
    ]
  : [
      // Restricted Mode. VS Code always trusts an Extension Development Host workspace, so the extension's
      // test-mode-only switch makes Refyntra's trust gate report untrusted → the host must not be spawned.
      { name: 'restricted', workspace: path.join(here, 'workspaces', 'tiny'), trusted: false, env: { REFYNTRA_TEST_FORCE_RESTRICTED: '1' } },
      // Trusted, but the folder has no solution/project → NotStarted with a reason.
      { name: 'no-solution', workspace: path.join(here, 'workspaces', 'empty'), trusted: true, env: { REFYNTRA_HOST_PATH: '' } },
      // Trusted, solution present, injected host path does not exist → Failed/HostNotFound, no spawn.
      { name: 'no-host', workspace: path.join(here, 'workspaces', 'tiny'), trusted: true, env: { REFYNTRA_HOST_PATH: path.join(cachePath, 'missing', 'Refyntra.Host.dll') } },
      // TS/JS provider absent for a document: a .ts file (routed to the TS/JS route by its extension) whose language
      // mode is Plain Text, so no TypeScript provider answers for it.
      { name: 'ts-absent', tsProject: true, trusted: true, env: { REFYNTRA_HOST_PATH: '' } },
      // Python and Rust on Refyntra's own language servers (bundled Pyright and rust-analyzer) with NO other extension
      // (empty extensions dir, --disable-extensions also disables VS Code's built-in extensions): Find, Related,
      // Rename apply + Undo. REFYNTRA_TEST_EXPECT_NO_CARGO: this machine has no cargo → Health must say so.
      { name: 'pyrust-lsp', pyRustProject: true, trusted: true, settings: { 'refyntra.rename.apply': true, 'files.autoSave': 'off' }, env: { REFYNTRA_HOST_PATH: '', REFYNTRA_TEST_EXPECT_NO_CARGO: hasCargo() ? '0' : '1' } },
      // Restricted Mode with Python and Rust files: no language server process may be spawned.
      { name: 'pyrust-restricted', pyRustProject: true, trusted: false, env: { REFYNTRA_HOST_PATH: '', REFYNTRA_TEST_FORCE_RESTRICTED: '1' } },
      // Accessibility: the same flows under the built-in high contrast theme.
      { name: 'high-contrast', workspace: path.join(here, 'workspaces', 'tiny'), trusted: true, settings: { 'workbench.colorTheme': 'Default High Contrast' }, env: { REFYNTRA_HOST_PATH: '' } },
    ];

/** cargo on PATH or in ~/.cargo/bin (looked up, never run). */
function hasCargo() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.cargo', 'bin'));
  return dirs.some((d) => fs.existsSync(path.join(d, exe)));
}

// The bundled rust-analyzer for this platform (pinned + SHA-256 verified; the same file the platform VSIX ships).
if (!e2e) await ensureRustAnalyzer(currentTarget());

if (e2e && !process.env.REFYNTRA_HOST_PATH) {
  console.error('test:e2e needs REFYNTRA_HOST_PATH=<path to Refyntra.Host.dll>');
  process.exit(2);
}

// REFYNTRA_TEST_ONLY=name1,name2 runs only these scenarios (local debugging).
const only = (process.env.REFYNTRA_TEST_ONLY || '').split(',').filter(Boolean);
let failed = 0;
for (const s of scenarios.filter((x) => only.length === 0 || only.includes(x.name))) {
  console.log(`\n=== Extension Host scenario: ${s.name} (VS Code ${version}) ===`);
  let copy;
  if (s.copy) {
    copy = shopCopy(s.copy, s.copyOpts);
    s.workspace = copy.workspace;
  }
  if (s.webCopy) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `refyntra-${s.name}-`));
    for (const f of s.webCopy) fs.cpSync(path.join(repo, 'tests', 'fixtures', f), path.join(tmp, f), { recursive: true });
    copy = { workspace: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
    s.workspace = tmp;
  } else   if (s.plainCopy) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `refyntra-${s.name}-`));
    fs.cpSync(path.join(repo, 'tests', 'fixtures', s.plainCopy), tmp, { recursive: true });
    copy = { workspace: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
    s.workspace = tmp;
  } else if (s.fixtureCopy) {
    copy = fixtureCopy(s.name, ...s.fixtureCopy);
    s.workspace = copy.workspace;
  } else if (s.tsProject) {
    copy = tsProject(s.name);
    s.workspace = copy.workspace;
  } else if (s.pyRustProject) {
    copy = pyRustProject(s.name);
    s.workspace = copy.workspace;
  }
  // builtinExtensions: keep VS Code's built-in extensions (TypeScript language features); the extensions dir stays
  // empty, so no marketplace extension runs.
  const extensionsDir = path.join(cachePath, s.builtinExtensions ? 'extensions-empty' : 'extensions');
  if (s.builtinExtensions) fs.rmSync(extensionsDir, { recursive: true, force: true });
  const launchArgs = [s.workspace, ...(s.builtinExtensions ? [] : ['--disable-extensions']), `--extensions-dir=${extensionsDir}`, '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userDataDir(s.name, { ...baseSettings, ...(s.settings ?? {}) })}`];
  if (s.trusted) launchArgs.push('--disable-workspace-trust');
  if (s.launchArgs) launchArgs.push(...s.launchArgs);
  try {
    await runTests({
      version,
      cachePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
      extensionTestsEnv: { REFYNTRA_TEST_SCENARIO: s.name, ...s.env },
    });
  } catch (e) {
    failed++;
    console.error(`Scenario ${s.name} failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    // A just-exited host or restore can hold the temp folder for a moment on Windows: retry, then only warn.
    try {
      copy?.cleanup();
    } catch (e) {
      console.warn(`Could not remove the temp copy of scenario ${s.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
if (failed) {
  console.error(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
console.log('\nAll Extension Host scenarios passed');
