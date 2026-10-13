// Visual (screenshot) scenarios of the test runner (runTest.mjs --visual, scenarios "visual-tests-dark" /
// "visual-tests-light") on a temp copy of tests/fixtures/TestRunner. Docker/Xvfb only (scripts/test/linux-visual.sh),
// same fixed settings as visual.cjs; the screenshots go to the same theme folders and are compared the same way.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCREEN = { width: 1600, height: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const out = process.env.REFYNTRA_VISUAL_OUT;
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const xdo = (...args) => execFileSync('xdotool', args, { timeout: 15000 }).toString().trim();
  const key = (...keys) => xdo('key', '--delay', '60', ...keys);
  const parkMouse = () => xdo('mousemove', '800', '12');
  const TESTS = 'XUnitTests/CalculatorTests.cs';

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'host ready', 240000);
    await waitFor(() => a.testing.state().ids.some((i) => i.endsWith('|MSTestTests.AddTests.AddRows')), 'discovered tests', 60000);
    return a;
  }

  async function reset() {
    key('Escape');
    key('Escape');
    for (const c of ['workbench.action.closeAllEditors', 'workbench.action.closePanel', 'notifications.clearAll', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closeSidebar']) {
      try {
        await vscode.commands.executeCommand(c);
      } catch {
        /* not available in this version */
      }
    }
    parkMouse();
  }

  async function shot(name, settleMs) {
    try {
      await vscode.commands.executeCommand('notifications.clearAll');
    } catch {
      /* ignore */
    }
    parkMouse();
    await sleep(settleMs);
    fs.mkdirSync(out, { recursive: true });
    const target = path.join(out, `${name}.png`);
    execFileSync('import', ['-window', 'root', '-depth', '8', `png24:${target}`], { timeout: 30000 });
    assert.ok(fs.statSync(target).size > 1000, `${target} written`);
    console.log(`    (screenshot ${name})`);
  }

  /** Every test once, so the explorer, the gutter and the CodeLens show results (a pass, a failure, a skip). */
  let ran = false;
  async function runAll(a) {
    if (ran) return;
    await a.testing.runIds(a.testing.state().ids.filter((i) => i.startsWith('dotnet:proj:')));
    ran = true;
  }

  return [
    [
      'visual: the VS Code window covers the fixed Xvfb screen; the tests are discovered',
      async () => {
        assert.ok(out, 'REFYNTRA_VISUAL_OUT is set');
        const ids = xdo('search', '--onlyvisible', '--class', 'code').split(/\s+/).filter(Boolean);
        assert.ok(ids.length > 0, 'a VS Code window');
        for (const id of ids) {
          xdo('windowmove', id, '0', '0');
          xdo('windowsize', id, String(SCREEN.width), String(SCREEN.height));
        }
        await ready();
        await reset();
        await sleep(1500);
      },
    ],
    [
      'visual: test-explorer — the Test Explorer after a run (data rows, a nested class, a failure, skips)',
      async () => {
        const a = await ready();
        await reset();
        await runAll(a);
        await vscode.commands.executeCommand('workbench.view.testing.focus');
        // Expand the paths to a failed data row, the nested class and an MSTest data row (same items every run).
        for (const suffix of ['AddTheory|(5, 5, 11)', '|XUnitTests.CalculatorTests+Nested.NestedPasses', 'DivideCases|(9, 3, 3)', 'AddRows|(3, 4, 7)']) {
          const id = a.testing.state().ids.find((i) => i.endsWith(suffix));
          assert.ok(id, suffix);
          await vscode.commands.executeCommand('vscode.revealTestInExplorer', a.testing.item(id));
          await sleep(300);
        }
        await vscode.commands.executeCommand('workbench.action.closePanel');
        // Focus leaves the tree: no inline action buttons on the selected row, no cursor in the filter box.
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await shot('test-explorer', 2500);
      },
    ],
    [
      'visual: test-codelens — Run | Debug with the last result over xUnit tests, gutter icons',
      async () => {
        const a = await ready();
        await reset();
        await runAll(a);
        const doc = await vscode.workspace.openTextDocument(file(TESTS));
        await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(0, 0, 0, 0) });
        await waitFor(async () => {
          const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri, 100);
          return ls.length > 0 && ls.every((l) => l.command && l.command.title) && ls.some((l) => l.command.title === '$(error) Run');
        }, 'resolved CodeLens with results', 90000);
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await shot('test-codelens', 2500);
      },
    ],
  ];
};
