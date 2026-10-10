// Runs the extension inside a real VS Code Extension Host (@vscode/test-electron).
//   node test/runTest.mjs          integration scenarios (no .NET host needed)
//   node test/runTest.mjs --e2e    against the real host: REFYNTRA_HOST_PATH=<Refyntra.Host.dll> [REFYNTRA_E2E_WORKSPACE=<folder>]
// VS Code version: REFYNTRA_TEST_VSCODE_VERSION (default: the minimum supported engine, 1.90.2).
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '..');
const repo = path.resolve(extensionDevelopmentPath, '..', '..');
const cachePath = path.join(repo, '.vscode-test');
const version = process.env.REFYNTRA_TEST_VSCODE_VERSION || '1.90.2';
const extensionTestsPath = path.join(here, 'suite', 'index.cjs');
const e2e = process.argv.includes('--e2e');

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

const scenarios = e2e
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
      // Accessibility: the same flows under the built-in high contrast theme.
      { name: 'high-contrast', workspace: path.join(here, 'workspaces', 'tiny'), trusted: true, settings: { 'workbench.colorTheme': 'Default High Contrast' }, env: { REFYNTRA_HOST_PATH: '' } },
    ];

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
  if (s.fixtureCopy) {
    copy = fixtureCopy(s.name, ...s.fixtureCopy);
    s.workspace = copy.workspace;
  } else if (s.tsProject) {
    copy = tsProject(s.name);
    s.workspace = copy.workspace;
  }
  // builtinExtensions: keep VS Code's built-in extensions (TypeScript language features); the extensions dir stays
  // empty, so no marketplace extension runs.
  const extensionsDir = path.join(cachePath, s.builtinExtensions ? 'extensions-empty' : 'extensions');
  if (s.builtinExtensions) fs.rmSync(extensionsDir, { recursive: true, force: true });
  const launchArgs = [s.workspace, ...(s.builtinExtensions ? [] : ['--disable-extensions']), `--extensions-dir=${extensionsDir}`, '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userDataDir(s.name, { ...baseSettings, ...(s.settings ?? {}) })}`];
  if (s.trusted) launchArgs.push('--disable-workspace-trust');
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
