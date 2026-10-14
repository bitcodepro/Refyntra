// Visual (screenshot) scenarios of the Solution view and the NuGet panel (runTest.mjs --visual, scenarios
// "visual-solution-dark" / "visual-solution-light") on a temp copy of tests/fixtures/Explorer (Explorer.sln). Docker/Xvfb
// only (scripts/test/linux-visual.sh), the same fixed settings as visual.cjs; a local folder feed made in the test
// provides a package (no internet).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PACKAGE_ID, createLocalFeed, nugetConfig } = require('./localFeed.cjs');

const SCREEN = { width: 1600, height: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const out = process.env.REFYNTRA_VISUAL_OUT;
  const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
  const xdo = (...args) => execFileSync('xdotool', args, { timeout: 15000 }).toString().trim();
  const key = (...keys) => xdo('key', '--delay', '60', ...keys);
  const parkMouse = () => xdo('mousemove', '800', '12');

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'host ready', 240000);
    const ex = a.solution.explorer;
    await waitFor(async () => {
      await ex.refresh();
      return ex.structure()?.projects.length === 3;
    }, 'the solution model', 60000);
    return { a, ex };
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
    for (const c of ['notifications.clearAll', 'workbench.action.closePanel']) {
      try {
        await vscode.commands.executeCommand(c);
      } catch {
        /* ignore */
      }
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
      'visual: the VS Code window covers the fixed Xvfb screen; the solution is loaded',
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
      'visual: solution-explorer — the Refyntra Solution view: folders, project kinds, Dependencies, a linked file',
      async () => {
        const { ex } = await ready();
        await reset();
        // The view is on from the start in this scenario (runTest.mjs); the other Refyntra views are hidden in this
        // throwaway profile so the tree has the side bar.
        await vscode.commands.executeCommand('workbench.view.extension.refyntra');
        for (const v of ['refyntra.relatedView', 'refyntra.stackTraceView', 'refyntra.taskContextView']) {
          try {
            await vscode.commands.executeCommand(`${v}.removeView`);
          } catch {
            /* not available in this version */
          }
        }
        await vscode.commands.executeCommand('refyntra.solutionView.focus');
        await sleep(1000);
        const app = ex.structure().projects.find((p) => p.name === 'Explorer.App');
        const core = ex.structure().projects.find((p) => p.name === 'Explorer.Core');
        assert.ok(await ex.expand(`proj:${app.projectUri}`, 1));
        assert.ok(await ex.expand(`deps:${app.projectUri}`, 2));
        assert.ok(await ex.expand(`dir:${app.projectUri}|Shared`, 1));
        assert.ok(await ex.expand(`proj:${core.projectUri}`, 1));
        assert.ok(await ex.expand(`deps:packages:${core.projectUri}`, 1));
        // Focus leaves the tree: no selection highlight or inline buttons on a hovered row.
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await shot('solution-explorer', 2500);
      },
    ],
    [
      'visual: nuget-installed — Manage NuGet Packages, Installed tab: a central package and one from a local folder feed',
      async () => {
        const { a, ex } = await ready();
        await reset();
        const feed = await createLocalFeed();
        try {
          fs.writeFileSync(path.join(root(), 'nuget.config'), nugetConfig(feed.feed));
          const core = ex.structure().projects.find((p) => p.name === 'Explorer.Core');
          await vscode.commands.executeCommand('refyntra.manageNuGet', core.projectUri);
          const panel = a.solution.nuget.current();
          await panel.dispatch({ action: 'search', values: { term: 'Refyntra', prerelease: false } });
          await panel.dispatch({ action: 'install', arg: PACKAGE_ID, version: '1.0.0' });
          await waitFor(() => panel.state().installed.some((r) => r.id === PACKAGE_ID), 'installed from the local feed', 120000);
          await panel.dispatch({ action: 'tab', arg: 'installed' });
          assert.deepEqual(panel.requests, [], 'no network request');
          await vscode.commands.executeCommand('workbench.action.closeSidebar');
          await shot('nuget-installed', 3000);
        } finally {
          feed.cleanup();
        }
      },
    ],
  ];
};
