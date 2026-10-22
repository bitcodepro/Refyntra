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

  /** The Run and Debug UI is off for the older screenshots (runTest.mjs visualSettings); these cases switch it on. */
  async function runUi(on) {
    const c = vscode.workspace.getConfiguration('refyntra');
    for (const k of ['run.statusBar', 'run.editorButtons', 'run.view', 'run.codeLens']) await c.update(k, on, vscode.ConfigurationTarget.Global);
  }

  /**
   * CodeLens off for a case: the lists are the subject, and a freshly opened or edited editor draws its lenses at its own
   * pace (no API says when they are on screen), so without them every capture is the same.
   */
  async function codeLens(on) {
    await vscode.workspace.getConfiguration('editor').update('codeLens', on, vscode.ConfigurationTarget.Global);
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
    [
      'visual: search-everywhere — camel-hump query with Types, Files and Commands sections',
      async () => {
        const a = await ready();
        await reset();
        await open(REQUESTS, 'GetOrderQuery');
        const query = 'GOQ';
        // Wait for the QuickPick's own data (files, type list, engine results) instead of sleeping.
        void vscode.commands.executeCommand('refyntra.find', query);
        await waitFor(() => {
          const st = a.searchEverywhere();
          return st.ready && st.value === query && st.items.some((i) => i.label.endsWith(' GetOrderQuery'));
        }, 'Search Everywhere results', 60000);
        await shot('search-everywhere', 1500);
        key('Escape');
        await reset();
      },
    ],
    [
      'visual: run-view — the Refyntra Run view, the run target in the status bar and Run | Debug over Program.cs',
      async () => {
        const a = await ready();
        await reset();
        await runUi(true);
        const targets = await a.run.refresh();
        const api = targets.find((t) => t.label === 'Shop.Api');
        assert.ok(api && api.runnable, 'Shop.Api is a runnable web app');
        await a.run.select(api, { configuration: 'Debug' });
        await open(PROGRAM, 'var builder');
        await waitFor(async () => {
          const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file(PROGRAM), 10);
          return ls.some((l) => l.command && /Run/.test(l.command.title));
        }, 'Run | Debug lenses', 60000);
        // The view's `when` (config.refyntra.run.view) needs a moment after the setting changed.
        await sleep(1500);
        // The Run tab of its own (Ctrl+Alt+R).
        await vscode.commands.executeCommand('refyntra.run.open');
        await shot('run-view', 2500);
      },
    ],
    [
      'visual: debug-stopped — netcoredbg stopped at a breakpoint in Program.cs (Run and Debug view, Variables)',
      async () => {
        const a = await ready();
        await reset();
        await runUi(true);
        const api = (await a.run.refresh()).find((t) => t.label === 'Shop.Api');
        const doc = await vscode.workspace.openTextDocument(file(PROGRAM));
        const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('var app = builder.Build();'));
        assert.ok(line > 0, 'the breakpoint line');
        const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        let stopped = false;
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('refyntra-dotnet', {
          createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => { if (m.type === 'event' && m.event === 'stopped') stopped = true; } }),
        });
        try {
          assert.equal(await a.run.debug(api.id), true, 'debugging started');
          await waitFor(() => stopped, 'stopped at the breakpoint', 240000);
          await vscode.commands.executeCommand('workbench.view.debug');
          await vscode.commands.executeCommand('workbench.action.closePanel');
          await sleep(2000);
          await shot('debug-stopped', 3000);
        } finally {
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
          if (vscode.debug.activeDebugSession) await vscode.debug.stopDebugging();
          await waitFor(() => !vscode.debug.activeDebugSession, 'debug session ended', 60000);
          await runUi(false);
          await reset();
        }
      },
    ],
    [
      'visual: inline-values — values after the lines of Program.cs while stopped, then the Immediate Window with an expanded object',
      async () => {
        const a = await ready();
        await reset();
        const api = (await a.run.refresh()).find((t) => t.label === 'Shop.Api');
        const doc = await vscode.workspace.openTextDocument(file(PROGRAM));
        const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('var app = builder.Build();'));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        let stopped = false;
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('refyntra-dotnet', {
          createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => { if (m.type === 'event' && m.event === 'stopped') stopped = true; } }),
        });
        try {
          assert.equal(await a.run.debug(api.id), true, 'debugging started');
          await waitFor(() => stopped, 'stopped at the breakpoint', 240000);
          // VS Code opens the Run and Debug view when it focuses the stopped frame: close the side bar only after that.
          await waitFor(() => vscode.debug.activeStackItem, 'the stopped frame is focused', 30000);
          await vscode.commands.executeCommand('workbench.action.closeSidebar');
          await vscode.commands.executeCommand('workbench.action.closePanel');
          await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
          await sleep(3000);
          await shot('inline-values', 2500);
          await vscode.commands.executeCommand('refyntra.showImmediate');
          await waitFor(() => a.immediate.frame(), 'Immediate bound to the frame', 10000);
          await sleep(1500);
          await a.immediate.evaluate('builder.Environment.EnvironmentName');
          const env = await a.immediate.evaluate('builder.Environment');
          if (env.result && env.result.ref > 0) await a.immediate.expand(env.result.id);
          await sleep(1500);
          await shot('immediate', 2500);
        } finally {
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
          if (vscode.debug.activeDebugSession) await vscode.debug.stopDebugging();
          await waitFor(() => !vscode.debug.activeDebugSession, 'debug session ended', 60000);
          await reset();
        }
      },
    ],
    [
      'visual: smart-step-into — the Smart Step Into picker while stopped in Program.cs (a framework call is listed with the reason)',
      async () => {
        const a = await ready();
        await reset();
        const api = (await a.run.refresh()).find((t) => t.label === 'Shop.Api');
        const doc = await vscode.workspace.openTextDocument(file(PROGRAM));
        const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('var app = builder.Build();'));
        const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(line, 0)));
        vscode.debug.addBreakpoints([bp]);
        let stopped = false;
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('refyntra-dotnet', {
          createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => { if (m.type === 'event' && m.event === 'stopped') stopped = true; } }),
        });
        try {
          assert.equal(await a.run.debug(api.id), true, 'debugging started');
          await waitFor(() => stopped, 'stopped at the breakpoint', 240000);
          await waitFor(() => vscode.debug.activeStackItem, 'the stopped frame is focused', 30000);
          await vscode.commands.executeCommand('workbench.action.closeSidebar');
          await vscode.commands.executeCommand('workbench.action.closePanel');
          await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
          const outcome = vscode.commands.executeCommand('refyntra.smartStepInto');
          await waitFor(() => a.debugExtras.hooks.pickerOpen && a.debugExtras.hooks.lastTargets, 'the Smart Step Into picker', 60000);
          assert.deepEqual(a.debugExtras.hooks.lastTargets.targets.map((t) => t.label), ['WebApplicationBuilder.Build()']);
          parkMouse();
          await shot('smart-step-into', 2000);
          key('Escape');
          assert.equal((await outcome).kind, 'cancelled');
        } finally {
          tracker.dispose();
          vscode.debug.removeBreakpoints([bp]);
          if (vscode.debug.activeDebugSession) await vscode.debug.stopDebugging();
          await waitFor(() => !vscode.debug.activeDebugSession, 'debug session ended', 60000);
          await reset();
        }
      },
    ],
    [
      'visual: ctor-actions — Ctrl+. on a new constructor parameter (field, property, DI registration), then the Generate constructor picker',
      async () => {
        await ready();
        await reset();
        const rel = 'Shop.Api/Handlers/OrderHandlers.cs';
        const { doc } = await open(rel, 'IAuditLog audit)');
        const text = doc.getText();
        const edit = new vscode.WorkspaceEdit();
        const paramAt = doc.positionAt(text.indexOf('IAuditLog audit)') + 'IAuditLog audit'.length);
        edit.insert(doc.uri, paramAt, ', IClock clock');
        await vscode.workspace.applyEdit(edit);
        try {
          const clock = doc.positionAt(doc.getText().indexOf('IClock clock') + 8);
          const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Selection(clock, clock) });
          ed.revealRange(new vscode.Range(clock, clock), vscode.TextEditorRevealType.InCenter);
          // Deterministic: wait until the host's edit actions for this exact position are listed (this also fills the
          // provider's short cache, so the Ctrl+. menu below shows them at once).
          const cursor = new vscode.Range(clock, clock);
          await waitFor(async () => ((await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, cursor, 'refactor.rewrite')) ?? []).some((a) => a.title === 'Convert to block body (Refyntra)'), 'host edit actions at the parameter', 120000);
          // The light bulb must be on the line first: VS Code places the menu differently (above or below the line)
          // depending on whether the light bulb is already shown when Ctrl+. runs.
          await sleep(1500);
          await vscode.commands.executeCommand('editor.action.quickFix');
          await shot('ctor-actions', 2500);
          key('Escape');
          await sleep(500);
          // Generate constructor on the class: the multi-select picker (readonly, not initialised members preselected).
          const field = new vscode.WorkspaceEdit();
          const auditField = doc.getText().indexOf('private readonly IAuditLog _audit;');
          field.insert(doc.uri, doc.positionAt(auditField + 'private readonly IAuditLog _audit;'.length), '\n    private readonly IClock _time;');
          await vscode.workspace.applyEdit(field);
          const cls = doc.positionAt(doc.getText().indexOf('class OrderPlacedAuditHandler') + 8);
          void vscode.commands.executeCommand('refyntra.ctor.generate', { uri: doc.uri.toString(), offset: doc.offsetAt(cls) });
          await sleep(1500);
          await shot('generate-constructor', 1500);
          key('Escape');
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
          await reset();
        }
      },
    ],
    [
      'visual: postfix-completion — the C# postfix templates after "names." (from the host, after the regular members)',
      async () => {
        await ready();
        await reset();
        const rel = 'Shop.Api/Handlers/OrderHandlers.cs';
        const { doc } = await open(rel, '_audit.Write("order placed");');
        const edit = new vscode.WorkspaceEdit();
        const at = doc.getText().indexOf('        _audit.Write("order placed");');
        edit.insert(doc.uri, doc.positionAt(at), '        var names = new[] { "a", "b" };\n        names.\n');
        await vscode.workspace.applyEdit(edit);
        try {
          const pos = doc.positionAt(doc.getText().indexOf('names.\n') + 'names.'.length);
          const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Selection(pos, pos) });
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          // Deterministic: the host's templates for exactly this text are cached by the provider before the list opens.
          await waitFor(async () => {
            const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos, '.');
            return (list?.items ?? []).some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'foreach');
          }, 'postfix templates for names.', 120000);
          await vscode.commands.executeCommand('editor.action.triggerSuggest');
          await sleep(1500);
          await shot('postfix-completion', 1500);
          key('Escape');
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
          await reset();
        }
      },
    ],
    [
      'visual: generate-picker — Refyntra: Generate… (Alt+Insert) on a class: the kinds the host offers',
      async () => {
        const a = await ready();
        await reset();
        const rel = 'Shop.Api/Handlers/OrderHandlers.cs';
        const { doc } = await open(rel, 'class OrderPlacedAuditHandler', 8);
        const pos = doc.positionAt(doc.getText().indexOf('class OrderPlacedAuditHandler') + 8);
        // Deterministic: the host lists the kinds for this class before the command asks for them again.
        await waitFor(async () => {
          const r = await a.engine.generate({ uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } });
          return r.kind === 'kinds' && r.kinds.length > 0;
        }, 'Generate kinds for the class', 120000);
        void vscode.commands.executeCommand('refyntra.generate');
        await sleep(1500);
        await shot('generate-picker', 1500);
        key('Escape');
        await reset();
      },
    ],
    [
      'visual: recent-files — Refyntra: Recent Files (Ctrl+E): the previous file first, the current one second, a modified file',
      async () => {
        const a = await ready();
        await reset();
        a.recent.clear();
        await codeLens(false);
        // Program.cs gets an unsaved change (the "modified" marker) and is not the visible editor, so the CodeLens of
        // the shown file never re-resolve after an edit.
        const program = await open(PROGRAM, 'var builder');
        await program.ed.edit((e) => e.insert(new vscode.Position(0, 0), '// draft\n'));
        await open(REQUESTS, 'record GetOrderQuery');
        await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
        await waitFor(() => a.recent.recentFiles().length === 3, 'three recent files', 10000);
        void vscode.commands.executeCommand('refyntra.recentFiles');
        await waitFor(() => a.recent.state().open && a.recent.state().ready && a.recent.state().kind === 'files' && a.recent.state().items.length === 3, 'Recent Files list', 10000);
        await shot('recent-files', 1500);
        key('Escape');
        await open(PROGRAM, 'var builder');
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await codeLens(true);
        await reset();
      },
    ],
    [
      'visual: recent-locations — Refyntra: Recent Locations (Ctrl+Shift+E): edited and visited places with member and code line',
      async () => {
        const a = await ready();
        await reset();
        a.recent.clear();
        await codeLens(false);
        const uriOf = (rel) => file(rel).toString();
        const p = await open(PROGRAM, 'var builder');
        await waitFor(() => a.recent.recentLocations().some((l) => l.uri === uriOf(PROGRAM) && l.line === p.start.line), 'Program.cs visited', 15000);
        const s = await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
        await waitFor(() => a.recent.recentLocations().some((l) => l.uri === uriOf(SERVICES) && l.line === s.start.line), 'Find visited', 15000);
        const line = s.doc.getText().split(/\r?\n/).findIndex((t) => t.includes('_orders[id] = new OrderDto'));
        await s.ed.edit((e) => e.insert(new vscode.Position(line, s.doc.lineAt(line).text.length), ' // audit'));
        const pos = new vscode.Position(line, s.doc.lineAt(line).text.length);
        s.ed.selection = new vscode.Selection(pos, pos);
        await waitFor(() => a.recent.recentLocations().length === 3 && a.recent.recentLocations()[0].kind === 'edited', 'the edit recorded', 15000);
        void vscode.commands.executeCommand('refyntra.recentLocations');
        await waitFor(() => a.recent.state().open && a.recent.state().ready && a.recent.state().kind === 'locations' && a.recent.state().items.length === 3, 'Recent Locations list', 15000);
        await shot('recent-locations', 1500);
        key('Escape');
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await codeLens(true);
        await reset();
      },
    ],
    [
      'visual: file-structure — Refyntra: File Structure (Ctrl+F12): members by type with kind and accessibility, the member at the cursor selected',
      async () => {
        const a = await ready();
        await reset();
        await codeLens(false);
        await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
        // Deterministic: the rows come from the host (code/fileStructure); the test hook says when they are shown.
        void vscode.commands.executeCommand('refyntra.fileStructure');
        await waitFor(() => a.fileStructure.state().open && a.fileStructure.state().ready && a.fileStructure.state().source === 'host' && /^OrderService\.Find@/.test(a.fileStructure.state().activeId || ''), 'File Structure rows', 120000);
        await shot('file-structure', 1500);
        key('Escape');
        await codeLens(true);
        await reset();
      },
    ],
    [
      'visual: metadata-document — Go to Metadata on a NuGet type: the read-only decompiled MediatR.ISender with its XML docs',
      async () => {
        const a = await ready();
        await reset();
        await open('Shop.Api/Program.cs', 'ISender sender', 2);
        // Deterministic: MediatR is pinned (12.5.0, fixed MVID) and so is the decompiler; the command resolves once
        // the document is shown with the caret on the type name.
        const r = await vscode.commands.executeCommand('refyntra.goToMetadata');
        if (!r || r.kind !== 'document') throw new Error(`no metadata document: ${JSON.stringify(r)}`);
        await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === 'refyntra-metadata:/MediatR/MediatR.ISender.cs', 'decompiled ISender shown', 60000);
        await waitFor(() => !a.related.state.loading, 'Related idle', 60000);
        await shot('metadata-document', 1500);
        await reset();
      },
    ],
    // The Navigate To and Usages cases run last: the Usages view appears in the side bar from the first search on,
    // and no earlier screenshot shows it.
    [
      'visual: navigate-to — Refyntra: Navigate To… (Alt+`) on a class member: the targets with counts',
      async () => {
        const a = await ready();
        await reset();
        await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
        // Deterministic: the list is shown once every target and count is computed (test hook, no sleep).
        void vscode.commands.executeCommand('refyntra.navigateTo');
        await waitFor(() => a.navigateTo.state().open && a.navigateTo.state().ready && a.navigateTo.state().items.length > 0, 'Navigate To targets', 120000);
        await shot('navigate-to', 1500);
        key('Escape');
        await reset();
      },
    ],
    [
      'visual: usages — the Refyntra Usages view: usages of IOrderService grouped by kind, then file',
      async () => {
        const a = await ready();
        await reset();
        const { doc, start } = await open(SERVICES, 'public interface IOrderService', 'public interface '.length + 1);
        a.usages.clear();
        a.usages.setGroupings(['kind', 'file']);
        a.usages.setFilters({ kinds: [], tests: 'all' });
        await a.usages.find({ uri: doc.uri.toString(), position: { line: start.line, character: start.character } });
        await waitFor(() => !a.usages.state().loading && a.usages.state().sessions.length === 1, 'usages loaded', 120000);
        // Only the side bar matters here: no editor (its CodeLens resolve at their own pace) and Related collapsed (it
        // follows the cursor), so the Usages view has the room and nothing else on screen moves.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('refyntra.relatedView.focus');
        await vscode.commands.executeCommand('workbench.actions.view.toggleCollapse').then(undefined, () => undefined);
        await vscode.commands.executeCommand('refyntra.usagesView.focus');
        // Deterministic: the header (description) and the first row are drawn before the capture (it once caught the view
        // without its header row).
        await waitFor(() => a.usages.renderedFirstRow(), 'the Usages view drawn', 30000);
        // Deterministic focus: keyboard focus leaves the side bar (the empty editor group takes it), so the Usages header
        // shows its title (not the focus-only title-bar actions) and no tree draws a focus outline. With list.focusFirst
        // the capture depended on whether Xvfb (no window manager) had given the window focus in time.
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        parkMouse();
        await shot('usages', 2500);
        a.usages.clear();
      },
    ],
    [
      'visual: inspection-quickfix — an OR1003 squiggle with the Refyntra quick fixes (Ctrl+.)',
      async () => {
        await ready();
        await reset();
        await codeLens(false);
        try {
          const { doc, ed } = await open(SERVICES, 'public sealed class AuditLog');
          assert.ok(doc.getText().includes('public void Write(string entry)'), 'AuditLog.Write');
          const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
          // After the closing brace of AuditLog.Write (an unsaved edit, reverted below).
          const at = doc.lineAt(doc.positionAt(doc.getText().indexOf('public void Write(string entry)')).line + 2).range.end;
          await ed.edit((e) => e.insert(at, `${eol}${eol}    public async void Flush() => await Task.Yield();`));
          const d = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).find((x) => x.source === 'Refyntra' && (typeof x.code === 'object' ? x.code.value : x.code) === 'OR1003'), 'the OR1003 squiggle', 90000);
          ed.selection = new vscode.Selection(d.range.start, d.range.start);
          ed.revealRange(d.range, vscode.TextEditorRevealType.InCenter);
          await waitFor(async () => {
            const list = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range, vscode.CodeActionKind.QuickFix.value)) ?? [];
            return list.some((x) => /Refyntra/.test(x.title));
          }, 'the quick fixes', 30000);
          await sleep(800);
          await vscode.commands.executeCommand('editor.action.quickFix');
          await shot('inspection-quickfix', 2500);
          key('Escape');
          await vscode.commands.executeCommand('workbench.action.files.revert');
        } finally {
          await codeLens(true);
        }
      },
    ],
    // Structural Search runs after every other case: its results view stays in the side bar from the first search on.
    [
      'visual: structural-search — Refyntra: Structural Search… with a type-constrained placeholder and its results',
      async () => {
        const a = await ready();
        await reset();
        const ss = a.structuralSearch;
        await ss.open({ text: 'await $call$', replacement: '$call$.GetAwaiter().GetResult()', placeholders: [{ name: 'call', kind: 'expression', type: 'System.Threading.Tasks.Task' }], scope: 'solution' });
        // Deterministic: the host answers the search (4 awaits in 2 files of Shop); the page renders the posted view.
        const r = await ss.search();
        assert.ok(r && r.matches.length === 4, JSON.stringify(r));
        await waitFor(() => ss.view() && !ss.view().busy && ss.view().groups.length === 2, 'panel results', 30000);
        await shot('structural-search', 2500);
        await reset();
      },
    ],
    [
      'visual: structural-results — the Structural Search Results view: files with counts and line previews',
      async () => {
        const a = await ready();
        await reset();
        await waitFor(() => a.structuralSearch.results.state().total === 4, 'results of the previous case', 30000);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('refyntra.relatedView.focus');
        await vscode.commands.executeCommand('workbench.actions.view.toggleCollapse').then(undefined, () => undefined);
        await vscode.commands.executeCommand('refyntra.structuralResultsView.focus');
        await vscode.commands.executeCommand('list.focusFirst');
        await shot('structural-results', 2500);
        await vscode.commands.executeCommand('refyntra.structuralSearch.clear');
        await reset();
      },
    ],
    [
      'visual: git-tab — the Refyntra Git tab: a change to stage, branches, the graph with a branch cut from main and merged back',
      async () => {
        const a = await ready();
        await reset();
        // The last case: the copy becomes a repository with fixed dates and authors (nothing after it depends on that).
        const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const { execFileSync } = require('node:child_process');
        let t = 1700000000;
        const git = (...args) => {
          t += 3600;
          const env = { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` };
          return String(execFileSync('git', args, { cwd: root, env }));
        };
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Alice');
        git('config', 'user.email', 'a@example.com');
        git('add', '-A');
        git('commit', '-q', '-m', 'Shop: orders API');
        git('switch', '-q', '-c', 'feature/cancel');
        fs.appendFileSync(path.join(root, 'README.md'), 'Cancel orders\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'Cancel order endpoint');
        git('switch', '-q', 'main');
        fs.appendFileSync(path.join(root, 'NOTES.md'), 'Release notes\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'Release notes');
        git('merge', '-q', '--no-ff', '-m', 'Merge feature/cancel', 'feature/cancel');
        git('switch', '-q', '-c', 'feature/audit');
        fs.appendFileSync(path.join(root, 'NOTES.md'), 'Audit\n');
        git('commit', '-q', '-am', 'Audit log');
        git('switch', '-q', 'main');
        fs.appendFileSync(path.join(root, 'NOTES.md'), 'Draft\n');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('refyntra.git.open');
        const m = await a.gitView.refresh();
        assert.equal(m.rows.length, 5, JSON.stringify(m.rows.map((r) => r.commit.subject)));
        await shot('git-tab', 2500);
      },
    ],
  ];
  // REFYNTRA_VISUAL_ONLY=codelens,find: only these screenshots (local debugging); the window setup always runs.
  return only.length ? cases.filter(([title], i) => i === 0 || only.some((o) => title.startsWith(`visual: ${o} `))) : cases;
};
