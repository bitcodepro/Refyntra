// Visual (screenshot) scenarios (runTest.mjs --visual, scenarios "visual-dark" / "visual-light") on a temp copy of Shop.
// Runs ONLY headless under Xvfb in Docker (scripts/test/linux-visual.sh): every case brings one piece of Refyntra UI
// into a stable state, then captures the whole X display with ImageMagick's `import -window root`. Keys and the mouse
// go through xdotool (menus, QuickPick input). scripts/test/visual-compare.mjs compares the PNGs with the baselines.
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
  const SERVICES = 'Shop.Api/Services/OrderServices.cs';
  const PROGRAM = 'Shop.Api/Program.cs';
  const REQUESTS = 'Shop.Contracts/Orders/OrderRequests.cs';

  const xdo = (...args) => execFileSync('xdotool', args, { timeout: 15000 }).toString().trim();
  const key = (...keys) => xdo('key', '--delay', '60', ...keys);
  /** The pointer rests on the title bar (no hover effect anywhere); with no window manager focus follows it. */
  const parkMouse = () => xdo('mousemove', '800', '12');

  async function ready() {
    const a = await api();
    await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
    assert.equal(csharp(a.health()).state, 'Ready');
    await waitFor(() => a.statusKind() !== 'loading', 'status not loading', 60000);
    return a;
  }

  /** Back to a neutral layout: no editors, no panel, no notifications, Explorer closed, nothing open over the window. */
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

  async function open(rel, needle, offset = 0, length = 0) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, `${needle} in ${rel}`);
    const start = doc.positionAt(i + offset);
    const end = doc.positionAt(i + offset + length);
    const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Selection(start, end) });
    ed.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return { doc, ed, start, end };
  }

  /** Waits for the UI to settle, then captures the display (all notifications cleared, pointer parked). */
  async function shot(name, settleMs = 1200) {
    // Stable state first: Related (it follows the cursor) has finished loading and the CodeLens of the active C#
    // editor are resolved, so no capture depends on how fast the host answered.
    const ext = await api();
    await waitFor(() => !ext.related.state.loading, 'Related idle', 120000);
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'csharp' && ed.document.uri.scheme === 'file') {
      await waitFor(async () => {
        const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', ed.document.uri, 100);
        return ls.length > 0 && ls.every((l) => l.command && l.command.title);
      }, `CodeLens of ${ed.document.fileName}`, 90000);
    }
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

  async function waitLenses(rel, test) {
    await waitFor(async () => {
      const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file(rel), 100);
      return test(ls.map((l) => (l.command && l.command.title) || ''));
    }, `CodeLens in ${rel}`, 90000);
  }

  const only = (process.env.REFYNTRA_VISUAL_ONLY || '').split(',').filter(Boolean);
  const cases = [
    [
      'visual: the VS Code window covers the fixed Xvfb screen; the host is ready',
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
      'visual: codelens — CodeLens over a class and a method',
      async () => {
        await ready();
        await reset();
        // The lens provider answers for open documents only.
        await open(SERVICES, 'public sealed class OrderService');
        await waitLenses(SERVICES, (t) => t.some((x) => /references?/.test(x)) && t.some((x) => /implementations?/.test(x)));
        await waitLenses(SERVICES, (t) => t.every((x) => x.length > 0));
        await shot('codelens', 2500);
      },
    ],
    [
      'visual: lightbulb — Ctrl+. on a selection lists Refyntra refactorings',
      async () => {
        await ready();
        await reset();
        const stmt = 'var id = _orders.Count + 1;';
        await open(SERVICES, stmt, 0, stmt.length);
        await sleep(800);
        await vscode.commands.executeCommand('editor.action.refactor');
        await shot('lightbulb', 2500);
        key('Escape');
      },
    ],
    [
      'visual: context-menu — the editor context menu with the Refyntra submenu open',
      async () => {
        await ready();
        await reset();
        await open(SERVICES, 'public int Create(string customer', 'public int '.length + 1);
        await sleep(500);
        await vscode.commands.executeCommand('editor.action.showContextMenu');
        await sleep(800);
        // The Refyntra submenu is the last entry of the "navigation" group, the first group of the menu.
        key(...Array(Number(process.env.REFYNTRA_VISUAL_MENU_DOWNS || 1)).fill('Down'), 'Right');
        await shot('context-menu', 1500);
        key('Escape', 'Escape');
      },
    ],
    [
      'visual: refactor-preview — the native Refactor Preview for a rename',
      async () => {
        const a = await ready();
        await reset();
        const { doc, start } = await open(SERVICES, 'int Create(string customer, decimal total);', 'int '.length + 1);
        const r = await a.engine.prepareRename({ uri: doc.uri.toString(), position: { line: start.line, character: start.character } }, 'CreateOrder');
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const applying = a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: rename' } });
        await sleep(4000);
        await shot('refactor-preview', 2000);
        await vscode.commands.executeCommand('refactorPreview.discard');
        const outcome = await applying;
        assert.notEqual(outcome.status, 'applied');
        assert.equal(doc.isDirty, false);
      },
    ],
    [
      'visual: change-signature — the Change Signature dialog after a reorder',
      async () => {
        const a = await ready();
        await reset();
        const { doc, start } = await open(SERVICES, 'public int Create(string customer', 'public int '.length + 1);
        const running = vscode.commands.executeCommand('refyntra.changeSignature', { uri: doc.uri.toString(), position: { line: start.line, character: start.character } });
        const dialog = await waitFor(() => a.changeSignatureDialog(), 'dialog open', 30000);
        dialog.dispatch({ type: 'move', index: 0, delta: 1 });
        await waitFor(() => dialog.view().callSites, 'call-site count', 30000);
        await shot('change-signature', 2500);
        dialog.dispatch({ type: 'cancel' });
        await running;
        assert.equal(doc.isDirty, false);
      },
    ],
    [
      'visual: related — the Related view on IOrderService (groups, icons, counts)',
      async () => {
        const a = await ready();
        await reset();
        await open(SERVICES, 'public interface IOrderService', 'public interface '.length + 1);
        await vscode.commands.executeCommand('refyntra.related');
        await waitFor(() => !a.related.state.loading && a.related.current(), 'Related view loaded', 120000);
        await vscode.commands.executeCommand('refyntra.relatedView.focus');
        await shot('related', 2500);
      },
    ],
    [
      'visual: stack-trace — the Stack Trace view with an opened, highlighted frame',
      async () => {
        const a = await ready();
        await reset();
        const trace = [
          'System.InvalidOperationException: Order 42 was not found',
          '   at Shop.Api.Services.OrderService.Create(String customer, Decimal total) in /home/ci/Shop/Shop.Api/Services/OrderServices.cs:line 19',
          '   at Shop.Api.Handlers.CreateOrderCommandHandler.Handle(CreateOrderCommand request, CancellationToken cancellationToken) in /home/ci/Shop/Shop.Api/Handlers/OrderHandlers.cs:line 20',
          '   at MediatR.Wrappers.RequestHandlerWrapperImpl`2.Handle(Object request, CancellationToken cancellationToken)',
          '   at MediatR.Mediator.Send[TResponse](IRequest`1 request, CancellationToken cancellationToken)',
        ].join('\n');
        await vscode.commands.executeCommand('refyntra.openStackTrace', trace);
        const r = await a.stackTrace.openFrame(0);
        assert.equal(r.kind, 'opened', JSON.stringify(r));
        // The line flash (FLASH_MS, 1.5 s) is over before the capture: the frame is highlighted as the selected row
        // of the view (focus the view, first row = the exception group, Down = its first frame).
        await sleep(2000);
        await vscode.commands.executeCommand('refyntra.stackTraceView.focus');
        await vscode.commands.executeCommand('list.focusFirst');
        key('Down');
        await shot('stack-trace', 1500);
        await vscode.commands.executeCommand('refyntra.stackTrace.clear');
      },
    ],
    [
      'visual: task-context — the Task Context view with a symbol and a file',
      async () => {
        const a = await ready();
        await reset();
        const tc = a.taskContext;
        await vscode.commands.executeCommand('refyntra.taskContext.new', 'Checkout');
        await open(SERVICES, 'public sealed class OrderService', 'public sealed class '.length + 1);
        await vscode.commands.executeCommand('refyntra.taskContext.addSymbol');
        await open(PROGRAM, 'var app');
        await vscode.commands.executeCommand('refyntra.taskContext.addFile');
        await waitFor(() => tc.active() && tc.active().items.length >= 2, 'two task items', 30000);
        await tc.resolveNow();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('refyntra.taskContextView.focus');
        await shot('task-context', 2500);
      },
    ],
    [
      'visual: status-bar — the status bar item and its menu',
      async () => {
        await ready();
        await reset();
        await open(SERVICES, 'public interface IOrderService');
        void vscode.commands.executeCommand('refyntra.statusMenu');
        await shot('status-bar', 2000);
        key('Escape');
      },
    ],
    [
      'visual: health — the Health page',
      async () => {
        const a = await ready();
        await reset();
        await vscode.commands.executeCommand('refyntra.showHealth');
        await waitFor(() => a.healthPage.isOpen(), 'Health page open', 30000);
        await shot('health', 3000);
      },
    ],
    [
      'visual: hover — hover on a MediatR request',
      async () => {
        await ready();
        await reset();
        const { doc, start } = await open(PROGRAM, 'new GetOrderQuery(id)', 'new '.length + 2);
        await waitFor(async () => {
          const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, start);
          return hs.some((h) => h.contents.some((c) => /GetOrderQueryHandler/.test(typeof c === 'string' ? c : c.value)));
        }, 'MediatR hover', 60000);
        await vscode.commands.executeCommand('editor.action.showHover');
        await shot('hover', 2500);
        key('Escape');
      },
    ],
    [
      'visual: find — the Find QuickPick with results',
      async () => {
        const a = await ready();
        await reset();
        await open(REQUESTS, 'GetOrderQuery');
        const query = 'Order';
        await waitFor(async () => (await a.engine.find(query)).items.length > 0, 'Find results', 60000);
        void vscode.commands.executeCommand('refyntra.find');
        await sleep(1000);
        xdo('type', '--delay', '40', query);
        await shot('find', 3000);
        key('Escape');
        await reset();
      },
    ],
  ];
  // REFYNTRA_VISUAL_ONLY=codelens,find: only these screenshots (local debugging); the window setup always runs.
  return only.length ? cases.filter(([title], i) => i === 0 || only.some((o) => title.startsWith(`visual: ${o} `))) : cases;
};
