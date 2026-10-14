// Visual (screenshot) scenario of the EF Core tools (runTest.mjs --visual, scenarios "visual-ef-dark" /
// "visual-ef-light") on a temp copy of tests/fixtures/EfCore. Docker/Xvfb only (scripts/test/linux-visual.sh), same
// fixed settings as visual.cjs; the screenshot goes to the same theme folders and is compared the same way. Nothing runs
// dotnet ef here: the view shows what the host read from source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCREEN = { width: 1600, height: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const out = process.env.REFYNTRA_VISUAL_OUT;
  const xdo = (...args) => execFileSync('xdotool', args, { timeout: 15000 }).toString().trim();
  const key = (...keys) => xdo('key', '--delay', '60', ...keys);
  const parkMouse = () => xdo('mousemove', '800', '12');

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'host ready', 240000);
    await waitFor(async () => {
      await a.efCore.refresh();
      return a.efCore.state().contexts === 2;
    }, 'the EF Core view model', 120000);
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

  return [
    [
      'visual: the VS Code window covers the fixed Xvfb screen; the EF Core model is read',
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
      'visual: ef-core-view — DbContexts with migrations, snapshot and configurations',
      async () => {
        const a = await ready();
        await reset();
        const shop = (await a.efCore.getChildren()).find((n) => n.label === 'ShopDbContext');
        assert.ok(shop, 'ShopDbContext');
        // The other Refyntra views collapsed, the EF Core view open with every node expanded (the tree's default).
        await vscode.commands.executeCommand('refyntra.relatedView.focus');
        await vscode.commands.executeCommand('workbench.actions.view.toggleCollapse').then(undefined, () => undefined);
        await vscode.commands.executeCommand('refyntra.stackTraceView.focus');
        await vscode.commands.executeCommand('workbench.actions.view.toggleCollapse').then(undefined, () => undefined);
        await vscode.commands.executeCommand('refyntra.taskContextView.focus');
        await vscode.commands.executeCommand('workbench.actions.view.toggleCollapse').then(undefined, () => undefined);
        await vscode.commands.executeCommand('refyntra.efCoreView.focus');
        // No editor (CodeLens resolve at their own pace); focus leaves the tree so no row shows hover or inline actions.
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await shot('ef-core-view', 2500);
      },
    ],
  ];
};
