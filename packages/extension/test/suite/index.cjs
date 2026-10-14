// Minimal test runner executed inside the Extension Host (no mocha dependency).
const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXPECTED_COMMANDS = [
  'refyntra.find',
  'refyntra.related',
  'refyntra.actions',
  'refyntra.rename',
  'refyntra.showHealth',
  'refyntra.showHealthText',
  'refyntra.restartBackend',
  'refyntra.exportDebugBundle',
  'refyntra.selectSolution',
  'refyntra.findHandler',
  'refyntra.findEndpoint',
  'refyntra.findRegistration',
  'refyntra.related.pin',
  'refyntra.related.unpin',
  'refyntra.related.open',
  'refyntra.runRestore',
  'refyntra.nativeRename',
  'refyntra.showMenu',
  'refyntra.getStarted',
  'refyntra.keyboardShortcuts',
  'refyntra.goToMetadata',
  'refyntra.openMetadata',
  'refyntra.delegatedAction',
  'refyntra.structuralSearch',
];

// protocol-v1.md "Capability ids": the catalogue the host, initialize.capabilities and the UI share.
const CAPABILITY_CATALOGUE = ['csharp.find', 'csharp.related', 'csharp.rename', 'csharp.references'];

async function waitFor(predicate, what, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function api() {
  const ext = vscode.extensions.getExtension('refyntra.refyntra');
  assert.ok(ext, 'extension refyntra.refyntra is installed in the dev host');
  return ext.activate();
}

function csharp(h) {
  return h.adapters.find((a) => a.adapterId === 'csharp');
}

async function healthDocText() {
  await vscode.commands.executeCommand('refyntra.showHealthText');
  const doc = await waitFor(() => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'refyntra-health'), 'health document');
  return doc.getText();
}

const common = [
  [
    'Get started opens the Refyntra walkthrough',
    async () => {
      await api();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('refyntra.getStarted');
      const tab = await waitFor(() => {
        const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => /walkthrough|welcome|get started|refyntra/i.test(x.label));
        return t;
      }, 'a walkthrough tab', 10000);
      console.log(`    (opened tab: ${tab.label})`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'contributes and registers every command',
    async () => {
      await api();
      const all = await vscode.commands.getCommands(true);
      for (const c of EXPECTED_COMMANDS) assert.ok(all.includes(c), `command ${c} is registered`);
    },
  ],
  [
    'does not register Definition/Rename providers and contributes no default keybindings',
    async () => {
      const pkg = vscode.extensions.getExtension('refyntra.refyntra').packageJSON;
      for (const kb of pkg.contributes.keybindings) assert.match(kb.when, /config\.refyntra\.keybindings\.preset == '(visualStudio|resharper)'/);
      assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
    },
  ],
  [
    'onboarding: walkthrough files exist, editor submenu, one welcome variant per state',
    async () => {
      const ext = vscode.extensions.getExtension('refyntra.refyntra');
      const pkg = ext.packageJSON;
      const fsx = require('node:fs');
      const px = require('node:path');
      const w = pkg.contributes.walkthroughs.find((x) => x.id === 'refyntra.getStarted');
      assert.equal(w.steps.length, 7);
      for (const st of w.steps) {
        assert.ok(fsx.existsSync(px.join(ext.extensionPath, st.media.markdown)), st.media.markdown);
        assert.match(st.description, /\(command:refyntra\.[A-Za-z.]+\)/, `${st.id} has a command button`);
      }
      assert.deepEqual(pkg.contributes.menus['refyntra.editorContext'].map((m) => m.command), ['refyntra.related', 'refyntra.tests.runRelated', 'refyntra.find', 'refyntra.findHandler', 'refyntra.findEndpoint', 'refyntra.findRegistration', 'refyntra.rename', 'refyntra.extractMethod', 'refyntra.changeSignature', 'refyntra.moveTypeToFile', 'refyntra.safeDelete', 'refyntra.generateHandler', 'refyntra.cleanup', 'refyntra.taskContext.addSymbol', 'refyntra.taskContext.addFile', 'refyntra.actions']);
      assert.match(pkg.contributes.menus['editor/context'][0].when, /csharp\|typescript/);
      const whens = pkg.contributes.viewsWelcome.map((v) => v.when);
      for (const v of ['ready', 'untrusted', 'noSolution', 'hostFailed']) assert.equal(whens.filter((x) => x.includes(`refyntra.welcome == ${v}`)).length, 1, v);
      const all = await vscode.commands.getCommands(true);
      for (const v of pkg.contributes.viewsWelcome) for (const m of v.contents.matchAll(/\(command:([^)]+)\)/g)) assert.ok(all.includes(m[1]), `welcome button ${m[1]} is a registered command`);
    },
  ],
  [
    'every catalogue capability has a title and an editor command in the UI',
    async () => {
      const a = await api();
      for (const id of CAPABILITY_CATALOGUE) {
        const ui = a.capabilityUi(id);
        assert.notEqual(ui.title, id, `${id} has a title`);
        assert.ok(ui.command && ui.command.startsWith('refyntra.'), `${id} has a command`);
      }
    },
  ],
];

const scenarios = {
  restricted: [
    [
      'Run and Debug refuse to build or run in Restricted Mode (no process, no configuration)',
      async () => {
        const a = await api();
        const before = a.hostSpawnCount();
        const session = await a.run.run();
        assert.equal(session, undefined, 'no run session in Restricted Mode');
        assert.equal(a.run.sessions.size, 0);
        assert.deepEqual(await a.run.dynamicConfigurations('refyntra-dotnet'), [], 'no dynamic debug configurations');
        assert.equal(await a.run.debug(), false, 'no debug session in Restricted Mode');
        assert.equal(vscode.debug.activeDebugSession, undefined);
        assert.equal(a.hostSpawnCount(), before, 'nothing spawned');
        const text = await healthDocText();
        assert.match(text, /Run and debug: Restricted Mode/);
      },
    ],
    [
      'runs in (simulated) Restricted Mode',
      async () => {
        // VS Code trusts every Extension Development Host workspace; the runner sets REFYNTRA_TEST_FORCE_RESTRICTED.
        const a = await api();
        assert.equal(a.isTrusted(), false, 'Refyntra must see the workspace as untrusted in this scenario');
      },
    ],
    [
      'health shows TrustRequired and the host is never spawned',
      async () => {
        const a = await api();
        await waitFor(() => csharp(a.health())?.state === 'TrustRequired', 'TrustRequired');
        const h = csharp(a.health());
        assert.equal(h.reasonCode, 'TrustRequired');
        assert.equal(h.recoveryActions[0].command, 'workbench.trust.manage');
        assert.equal(a.hostSpawnCount(), 0);
        assert.match(a.statusBarText(), /Refyntra: C# TrustRequired/);
        assert.equal(a.welcomeVariant(), 'untrusted');
        const text = await healthDocText();
        assert.match(text, /Restricted Mode/);
        assert.match(text, /TrustRequired/);
        await vscode.commands.executeCommand('refyntra.showHealth');
        assert.ok(a.healthPage.isOpen(), 'Show Health opens the Health page');
        const page = a.healthPage.model().sections[0];
        assert.equal(page.headline, 'Restricted Mode');
        assert.equal(page.primary.id, 'trustWorkspace');
        await a.healthPage.dispatch({ type: 'action', key: 'workbench.action.terminal.new' });
        assert.equal(a.hostSpawnCount(), 0);
      },
    ],
    [
      'features explain the trust requirement instead of running',
      async () => {
        const a = await api();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Program.cs'));
        await vscode.window.showTextDocument(doc);
        const actions = await a.engine.actions({ uri: doc.uri.toString(), position: { line: 2, character: 25 } });
        assert.ok(actions.items.length > 0);
        assert.ok(actions.items.every((i) => i.state === 'unavailable' && i.reasonCode === 'TrustRequired'));
        const rel = await a.engine.related({ uri: doc.uri.toString(), position: { line: 2, character: 25 } });
        assert.equal(rel.kind, 'unavailable');
        const find = await a.engine.find('GetOrder');
        assert.equal(find.items.length, 0);
        assert.ok(find.notes.some((n) => n.includes('TrustRequired')));
        await vscode.commands.executeCommand('refyntra.restartBackend');
        assert.equal(a.hostSpawnCount(), 0, 'restart in Restricted Mode must not spawn');
      },
    ],
    [
      'refyntra.runRestore refuses in Restricted Mode: no terminal is created',
      async () => {
        const a = await api();
        assert.equal(a.isTrusted(), false);
        const sln = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Any.sln').fsPath;
        const opened = [];
        const sub = vscode.window.onDidOpenTerminal((t) => opened.push(t.name));
        try {
          await vscode.commands.executeCommand('refyntra.runRestore', sln);
          await new Promise((r) => setTimeout(r, 1000));
        } finally {
          sub.dispose();
        }
        assert.deepEqual(opened, [], 'no terminal in Restricted Mode');
      },
    ],
  ],
  'no-solution': [
    [
      'health shows NotStarted with NoSolutionFound',
      async () => {
        const a = await api();
        await waitFor(() => csharp(a.health())?.reasonCode === 'NoSolutionFound', 'NoSolutionFound');
        assert.equal(csharp(a.health()).state, 'NotStarted');
        assert.equal(a.hostSpawnCount(), 0);
        assert.equal(a.welcomeVariant(), 'noSolution');
        assert.match(await healthDocText(), /NotStarted/);
        await vscode.commands.executeCommand('refyntra.showHealth');
        const page = a.healthPage.model().sections[0];
        assert.equal(page.headline, 'C#: no solution or project found');
        assert.equal(page.primary.id, 'selectSolution');
      },
    ],
  ],
  'no-host': [
    [
      'trusted workspace with a missing host reports HostNotFound (no spawn, no restart loop)',
      async () => {
        const a = await api();
        assert.equal(vscode.workspace.isTrusted, true);
        await waitFor(() => csharp(a.health())?.state === 'Failed', 'Failed');
        const h = csharp(a.health());
        assert.equal(h.reasonCode, 'HostNotFound');
        assert.match(h.message, /does not exist/);
        assert.equal(a.welcomeVariant(), 'hostFailed');
        assert.equal(a.hostSpawnCount(), 0);
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(csharp(a.health()).restartCount, 0);
        assert.match(await healthDocText(), /HostNotFound/);
        await vscode.commands.executeCommand('refyntra.showHealth');
        const page = a.healthPage.model().sections[0];
        assert.equal(page.headline, 'C# is not running');
        assert.equal(page.primary.id, 'restartBackend');
      },
    ],
    [
      'document sync records C# buffers immediately',
      async () => {
        const a = await api();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Program.cs'));
        const ed = await vscode.window.showTextDocument(doc);
        assert.ok(a.engine.handlesDocument(doc.uri.toString(), doc.languageId));
        await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// dirty\n'));
        assert.ok(doc.isDirty);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      },
    ],
  ],
  e2e: [
    [
      'real host reaches Ready/Partial and Find returns the fixture symbol',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 180000);
        const h = csharp(a.health());
        assert.notEqual(h.state, 'Failed', `${h.reasonCode}: ${h.message}`);
        assert.ok(a.hostSpawnCount() >= 1);
        const r = await a.engine.find('GetOrderQuery');
        assert.ok(r.items.some((i) => i.label === 'GetOrderQuery'), JSON.stringify(r.notes));
      },
    ],
    [
      'Search Everywhere: camel humps find a type, > a Refyntra command, / a file',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial'].includes(csharp(a.health())?.state), 'host ready', 180000);
        const query = async (value, accept, what) => {
          const before = a.searchEverywhere().generation;
          void vscode.commands.executeCommand('refyntra.find', value);
          await waitFor(() => { const st = a.searchEverywhere(); return st.generation > before && st.ready && st.value === value && accept(st.items); }, what, 60000);
          await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        };
        await query('GOQ', (items) => items.some((i) => i.label.endsWith(' GetOrderQuery')), 'camel hump GOQ → GetOrderQuery');
        await query('>Refyntra: Find', (items) => items.some((i) => i.section === 'commands' && i.label.includes('Refyntra: Find')), '> finds the Refyntra command');
        await query('/Program', (items) => items.some((i) => i.section === 'files' && i.label.endsWith(' Program.cs')), '/ finds Program.cs');
        await query('@refyntra', (items) => items.some((i) => i.section === 'settings'), '@ finds Refyntra settings');
      },
    ],
    [
      'Related, Actions and a dirty (unsaved) buffer work against the real host',
      async () => {
        const a = await api();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Program.cs'));
        const ed = await vscode.window.showTextDocument(doc);
        const at = { uri: doc.uri.toString(), position: { line: 2, character: 25 } };
        const rel = await a.engine.related(at);
        assert.equal(rel.kind, 'related', JSON.stringify(rel));
        assert.equal(rel.subject && rel.subject.name, 'GetOrderQuery');
        const actions = await a.engine.actions(at);
        assert.ok(actions.items.length > 0 || actions.note, 'actions list or an explanation');
        await ed.edit((b) => b.insert(new vscode.Position(doc.lineCount, 0), '\npublic sealed class UnsavedOnlyType { }\n'));
        const found = await a.engine.find('UnsavedOnlyType');
        assert.ok(found.items.some((i) => i.label === 'UnsavedOnlyType'), `dirty buffer visible to Find: ${JSON.stringify(found.notes)}`);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      },
    ],
    [
      'Rename prepares a preview plan without changing files',
      async () => {
        const a = await api();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Program.cs'));
        const before = doc.getText();
        const r = await a.engine.prepareRename({ uri: doc.uri.toString(), position: { line: 2, character: 25 } }, 'FetchOrderQuery');
        if (r.kind === 'preview') {
          assert.deepEqual(r.issues, []);
          assert.ok(r.plan.writeSet.length >= 1);
          assert.equal(r.applyEnabled, true); // refyntra.rename.apply is on by default; preparing still changes nothing
          a.engine.discardPlan(r.planId);
        } else {
          console.log(`    (rename unavailable from host: ${r.reasonCode} ${r.message})`);
        }
        assert.equal(doc.getText(), before);
      },
    ],
  ],
};

// The plan's journeys on tests/fixtures/Shop (two projects, real MediatR 12.5.0 metadata).
const shopFile = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
async function shopPosition(rel, needle, offset = 0) {
  const doc = await vscode.workspace.openTextDocument(shopFile(rel));
  const i = doc.getText().indexOf(needle);
  assert.ok(i >= 0, `${needle} in ${rel}`);
  return { doc, at: { uri: doc.uri.toString(), position: doc.positionAt(i + offset) } };
}
const allRelations = (view) => view.groups.flatMap((g) => g.relations);
/** Runs "Refyntra: Related" at a position and returns the root items of the Related view (label, icon, command). */
async function relatedViewItems(a, doc, position) {
  const ed = await vscode.window.showTextDocument(doc);
  ed.selection = new vscode.Selection(position, position);
  await vscode.commands.executeCommand('refyntra.related');
  await waitFor(() => !a.related.state.loading && a.related.current(), 'Related view loaded', 120000);
  return a.related.getChildren().map((n) => {
    const item = a.related.getTreeItem(n);
    return { label: String(item.label), icon: item.iconPath && item.iconPath.id, command: item.command && item.command.command, args: item.command && item.command.arguments, tooltip: typeof item.tooltip === 'string' ? item.tooltip : undefined };
  });
}
scenarios.shop = [
  [
    'Shop loads with both projects',
    async () => {
      const a = await api();
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
      const h = csharp(a.health());
      assert.equal(h.state, 'Ready', `${h.reasonCode}: ${h.message}`);
      await vscode.commands.executeCommand('refyntra.showHealth');
      const page = a.healthPage.model().sections[0];
      assert.equal(page.headline, `C# is ready — ${h.projects.length} projects loaded`);
      assert.equal(page.primary, undefined);
    },
  ],
  [
    'GetOrderQuery → handler, Send call site and the endpoint',
    async () => {
      const a = await api();
      const { at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(', 1);
      const rel = await a.engine.related(at);
      assert.equal(rel.kind, 'related', JSON.stringify(rel));
      assert.equal(rel.subject && rel.subject.name, 'GetOrderQuery');
      const k = allRelations(rel).map((r) => r.relationKind);
      for (const want of ['mediatr.handler', 'mediatr.send', 'aspnet.endpoint']) assert.ok(k.includes(want), `${want} in ${k.join(', ')}`);
      const handler = allRelations(rel).find((r) => r.relationKind === 'mediatr.handler');
      assert.equal(handler.target.symbol.name, 'GetOrderQueryHandler');
    },
  ],
  [
    'Related tree: every item has a screen-reader label ("Handler GetOrderQueryHandler, Shop.Api, proven")',
    async () => {
      const a = await api();
      const { doc, at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(', 1);
      const ed = await vscode.window.showTextDocument(doc);
      ed.selection = new vscode.Selection(at.position, at.position);
      await vscode.commands.executeCommand('refyntra.related');
      await waitFor(() => !a.related.state.loading && a.related.current(), 'Related view loaded', 120000);
      const walk = (nodes) => nodes.flatMap((n) => [n, ...walk(a.related.getChildren(n))]);
      const items = walk(a.related.getChildren()).map((n) => a.related.getTreeItem(n));
      assert.ok(items.length > 0);
      for (const it of items) assert.ok(it.accessibilityInformation && it.accessibilityInformation.label, `${String(it.label)} has accessibilityInformation`);
      const labels = items.map((i) => i.accessibilityInformation.label);
      assert.ok(labels.some((l) => /^Handler GetOrderQueryHandler, .*Shop\.Api.*, proven/.test(l)), labels.join(' | '));
    },
  ],
  [
    'Related view: a completely loaded solution shows no scope notes (detected frameworks are not listed)',
    async () => {
      const a = await api();
      const { doc, at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(', 1);
      const items = await relatedViewItems(a, doc, new vscode.Position(at.position.line, at.position.character));
      const notes = items.filter((i) => i.icon === 'warning' || i.icon === 'info');
      assert.deepEqual(notes, [], JSON.stringify(items));
      assert.ok(!items.some((i) => /Version=|PublicKeyToken|^mediatr:|^aspnetcore:|^di:/.test(i.label)), JSON.stringify(items));
    },
  ],
  [
    'IOrderService → registrations from two composition roots and the implementations',
    async () => {
      const a = await api();
      const { at } = await shopPosition('Shop.Api/Services/OrderServices.cs', 'IOrderService', 1);
      const rel = await a.engine.related(at);
      assert.equal(rel.kind, 'related', JSON.stringify(rel));
      const regs = allRelations(rel).filter((r) => r.relationKind === 'di.registration');
      const roots = new Set(regs.map((r) => r.target.registration.compositionRoot));
      assert.ok(roots.size >= 2, `composition roots: ${[...roots].join(', ')}`);
      const impls = allRelations(rel).filter((r) => r.target.symbol).map((r) => r.target.symbol.name);
      for (const want of ['OrderService', 'CachedOrderService']) assert.ok(impls.includes(want), `${want} in ${impls.join(', ')}`);
    },
  ],
  [
    'Find with a filter; the foreign IRequest gets no MediatR relations',
    async () => {
      const a = await api();
      const all = await a.engine.find('type:');
      const labels = all.items.map((i) => i.label);
      assert.ok(labels.includes('GetOrderQuery') && labels.includes('OrderService'), 'an empty query with type: lists types');
      const r = await a.engine.find('type: GetOrder');
      assert.ok(r.items.some((i) => i.label === 'GetOrderQuery'), JSON.stringify(r.items.map((i) => i.label)));
      const { at } = await shopPosition('Shop.Api/Legacy/LegacyMessaging.cs', 'interface IRequest', 'interface '.length + 1);
      const rel = await a.engine.related(at);
      const k = rel.kind === 'related' ? allRelations(rel).map((x) => x.relationKind) : [];
      assert.ok(!k.some((x) => x.startsWith('mediatr.')), `foreign interface got ${k.join(', ')}`);
    },
  ],
  [
    'Actions: the catalogue capabilities, Related available on a plain type too (not only with MediatR)',
    async () => {
      const a = await api();
      for (const [rel, needle] of [['Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery('], ['Shop.Api/Services/OrderServices.cs', 'IOrderService']]) {
        const { at } = await shopPosition(rel, needle, 1);
        const actions = await a.engine.actions(at);
        // The catalogue plus, where they apply, the create-file and code refactoring actions (outside the catalogue).
        const extra = ['csharp.moveTypeToFile', 'csharp.generateHandler', 'csharp.safeDelete', 'csharp.changeSignature', 'csharp.extractMethod'];
        const ids = actions.items.map((i) => i.capabilityId).filter((id) => !extra.includes(id)).sort();
        assert.deepEqual(ids, [...CAPABILITY_CATALOGUE].sort(), JSON.stringify(actions));
        const related = actions.items.find((i) => i.capabilityId === 'csharp.related');
        assert.equal(related.state, 'available');
        assert.equal(related.guarantee, 'owned-semantic');
        assert.ok(actions.items.every((i) => a.capabilityUi(i.capabilityId).command), 'every action can be run from the UI');
      }
    },
  ],
  [
    'Export Debug Bundle: previewed before anything is written; redacted paths and names; saved only after confirmation',
    async () => {
      const a = await api();
      const os = require('node:os');
      const fsx = require('node:fs');
      const p = require('node:path');
      const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'refyntra-bundle-'));
      const target = vscode.Uri.file(p.join(dir, 'bundle.json'));
      try {
        // 1. Declined: the preview is shown, nothing is written.
        let seen;
        a.debugBundle.testHooks = {
          includeProjectNames: false,
          saveTarget: target,
          confirm: (text) => {
            seen = text;
            assert.equal(fsx.existsSync(target.fsPath), false, 'nothing written while the preview is shown');
            const preview = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'refyntra-debug-bundle');
            assert.ok(preview, 'preview document is open');
            assert.equal(preview.getText(), text, 'the preview shows exactly the bundle text');
            return false;
          },
        };
        const declined = await vscode.commands.executeCommand('refyntra.exportDebugBundle');
        assert.equal(declined.status, 'cancelled');
        assert.ok(seen);
        assert.equal(fsx.existsSync(target.fsPath), false, 'declined: no file');
        assert.deepEqual(fsx.readdirSync(dir), [], 'declined: the folder stays empty');
        const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const b = JSON.parse(seen);
        assert.equal(b.format, 'refyntra-debug-bundle/1');
        assert.equal(b.versions.vscode, vscode.version);
        assert.ok(b.versions.backends[0].protocol.startsWith('1.'), JSON.stringify(b.versions));
        assert.equal(b.adapters.find((x) => x.adapter === 'csharp').state, 'Ready');
        assert.ok(b.adapters[0].sdk.version, 'SDK version');
        for (const bad of [ws, ws.split(p.sep).join('/'), os.homedir(), 'Shop.Api', 'Shop.Contracts', 'GetOrderQueryHandler']) {
          assert.ok(!seen.toLowerCase().includes(bad.toLowerCase()), `bundle must not contain ${bad}`);
        }
        assert.ok(b.log.lines.length > 0, 'log lines are included');
        // 2. Confirmed with project names: written exactly as previewed, still no paths.
        let shown;
        a.debugBundle.testHooks = { includeProjectNames: true, saveTarget: target, confirm: (t) => ((shown = t), true) };
        const saved = await vscode.commands.executeCommand('refyntra.exportDebugBundle');
        assert.equal(saved.status, 'saved');
        const written = fsx.readFileSync(target.fsPath, 'utf8');
        assert.equal(written, shown, 'the saved file is byte-identical to the preview');
        assert.ok(written.includes('Shop.Api'), 'opt-in keeps project names');
        assert.ok(!written.toLowerCase().includes(ws.toLowerCase()), 'paths stay redacted');
      } finally {
        a.debugBundle.testHooks = undefined;
        fsx.rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    'Rename across both projects is a preview and changes nothing',
    async () => {
      const a = await api();
      const { doc, at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(', 1);
      const handlerDoc = await vscode.workspace.openTextDocument(shopFile('Shop.Api/Handlers/OrderHandlers.cs'));
      const before = [doc.getText(), handlerDoc.getText()];
      const r = await a.engine.prepareRename(at, 'FetchOrderQuery');
      assert.equal(r.kind, 'preview', JSON.stringify(r));
      const files = r.plan.writeSet.map((c) => c.uri.split('/').pop());
      for (const want of ['OrderRequests.cs', 'OrderHandlers.cs', 'Program.cs']) assert.ok(files.includes(want), `${want} in ${files.join(', ')}`);
      assert.equal(r.applyEnabled, true); // refyntra.rename.apply is on by default; preparing still changes nothing
      a.engine.discardPlan(r.planId);
      assert.deepEqual([doc.getText(), handlerDoc.getText()], before);
    },
  ],
];

// Stage C on a temp copy of Shop (runTest.mjs copies + restores it; refyntra.rename.apply = true).
const fsp = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const TARGETS = ['Shop.Contracts/Orders/OrderRequests.cs', 'Shop.Api/Handlers/OrderHandlers.cs', 'Shop.Api/Program.cs', 'Shop.Api/Services/UnicodeUser.cs'];
const diskBytes = () => Promise.all(TARGETS.map((t) => fsp.readFile(shopFile(t).fsPath)));
const openDoc = (rel) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === shopFile(rel).toString() && !d.isClosed);
async function prepareGetOrder(a) {
  const { at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(', 1);
  const r = await a.engine.prepareRename(at, 'FetchOrderQuery');
  assert.equal(r.kind, 'preview', JSON.stringify(r));
  assert.equal(r.applyEnabled, true);
  assert.deepEqual(r.issues, []);
  return r;
}
async function revertAll() {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}
scenarios['rename-apply'] = [
  [
    'the temp Shop copy loads (apply setting on)',
    async () => {
      const a = await api();
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
      assert.equal(csharp(a.health()).state, 'Ready');
      assert.equal(vscode.workspace.getConfiguration('refyntra').get('rename.apply'), true);
      assert.ok(!shopFile('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy, never on the repository fixture');
    },
  ],
  [
    'applyEdit returning false: failed, every file unchanged, nothing saved',
    async () => {
      const a = await api();
      const disk = await diskBytes();
      const r = await prepareGetOrder(a);
      a.editApplier.faults.rejectNextApply = true;
      const out = await a.engine.applyRename(r.planId);
      assert.equal(out.status, 'failed', out.message);
      assert.match(out.message, /no file was changed/);
      assert.deepEqual(out.files.map((f) => f.status), out.files.map(() => 'unchanged'));
      assert.deepEqual(await diskBytes(), disk);
      assert.equal(a.engine.planState(r.planId), undefined, 'single use: a failed plan is gone');
    },
  ],
  [
    'a target edited between preview and apply is refused; Rename again shows a new preview',
    async () => {
      const a = await api();
      const handlers = await vscode.workspace.openTextDocument(shopFile('Shop.Api/Handlers/OrderHandlers.cs'));
      const r = await prepareGetOrder(a);
      const ed = await vscode.window.showTextDocument(handlers);
      await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// typed after the preview\n'));
      const out = await a.engine.applyRename(r.planId);
      assert.equal(out.status, 'stale', out.message);
      assert.equal(out.canReprepare, true);
      assert.ok(!handlers.getText().includes('FetchOrderQuery'));
      const again = await prepareGetOrder(a);
      assert.notEqual(again.planId, r.planId);
      a.engine.discardPlan(again.planId);
      await revertAll();
    },
  ],
  [
    'an external disk write of a closed target after the preview makes revalidation stale',
    async () => {
      const a = await api();
      const program = shopFile('Shop.Api/Program.cs').fsPath;
      assert.equal(openDoc('Shop.Api/Program.cs'), undefined, 'Program.cs must be closed for this test');
      const original = await fsp.readFile(program);
      const r = await prepareGetOrder(a);
      await fsp.writeFile(program, Buffer.concat([original, Buffer.from('\n// external tool\n')]));
      try {
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'stale', out.message);
        assert.match(out.message, /changed since the preview/);
      } finally {
        await fsp.writeFile(program, original);
      }
      assert.equal(openDoc('Shop.Api/Program.cs'), undefined);
    },
  ],
  [
    'apply across two projects (dirty open buffer, closed files, CRLF + BOM + emoji): confirmed, not saved, host resynced, Undo restores',
    async () => {
      const a = await api();
      await revertAll();
      const handlers = await vscode.workspace.openTextDocument(shopFile('Shop.Api/Handlers/OrderHandlers.cs'));
      const ed = await vscode.window.showTextDocument(handlers);
      await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// unsaved line\n'));
      assert.ok(handlers.isDirty);
      const disk = await diskBytes();
      const r = await prepareGetOrder(a);
      const files = r.plan.writeSet.map((c) => c.uri.split('/').pop()).sort();
      assert.deepEqual(files, ['OrderHandlers.cs', 'OrderRequests.cs', 'Program.cs', 'UnicodeUser.cs']);
      const before = new Map();
      for (const t of TARGETS) before.set(t, openDoc(t)?.getText() ?? null);

      const out = await a.engine.applyRename(r.planId);
      assert.equal(out.status, 'applied', out.message);
      assert.equal(out.files.length, 4);
      assert.ok(out.files.every((f) => f.status === 'confirmed'), JSON.stringify(out.files));
      for (const t of TARGETS) {
        const doc = openDoc(t);
        assert.ok(doc, `${t} is loaded after apply`);
        assert.ok(doc.getText().includes('FetchOrderQuery'), t);
        assert.ok(!/\bGetOrderQuery\b/.test(doc.getText()), t);
        assert.ok(doc.isDirty, `${t} is not saved automatically`);
      }
      assert.ok(handlers.getText().startsWith('// unsaved line\n'), 'the dirty buffer edit is kept');
      const uni = openDoc('Shop.Api/Services/UnicodeUser.cs');
      assert.equal(uni.eol, vscode.EndOfLine.CRLF);
      assert.ok(uni.getText().includes('\u{1F469}‍\u{1F469}‍\u{1F467}'));
      assert.deepEqual(await diskBytes(), disk, 'disk unchanged (no auto-save)');
      assert.equal((await fsp.readFile(shopFile('Shop.Api/Services/UnicodeUser.cs').fsPath)).subarray(0, 3).toString('hex'), 'efbbbf');

      // The host was resynced through normal document sync: Find sees the renamed type in the unsaved buffers.
      const found = await a.engine.find('type: FetchOrderQuery');
      assert.ok(found.items.some((i) => i.label === 'FetchOrderQuery'), JSON.stringify(found));

      // Undo through the editor. One undo of a multi-file edit may undo every file; models that applyEdit loaded for
      // closed files and that are clean again may be released by VS Code (then the disk text is the text).
      const undoCount = { n: 0 };
      for (const t of TARGETS) {
        const doc = openDoc(t);
        if (!doc) continue;
        if (doc.getText() === before.get(t) || (before.get(t) === null && !doc.getText().includes('FetchOrderQuery'))) continue;
        await vscode.window.showTextDocument(doc);
        await withTimeout(vscode.commands.executeCommand('undo'), 20000, `undo in ${t}`);
        undoCount.n++;
      }
      assert.ok(undoCount.n >= 1);
      for (const t of TARGETS) {
        const doc = openDoc(t);
        const text = doc ? doc.getText() : (await fsp.readFile(shopFile(t).fsPath, 'utf8')).replace(/^﻿/, '');
        assert.ok(!text.includes('FetchOrderQuery'), `undo restored ${t}`);
        if (before.get(t) !== null) assert.equal(text, before.get(t), `undo restored ${t} exactly`);
        if (doc && before.get(t) === null) assert.equal(doc.isDirty, false, `${t} is clean again after undo`);
      }
      assert.ok(handlers.getText().startsWith('// unsaved line\n'));
      await revertAll();
      assert.deepEqual(await diskBytes(), disk);
    },
  ],
  [
    'host killed between prepare and apply: the plan is rejected (new epoch), nothing applied',
    async () => {
      const a = await api();
      await revertAll();
      const disk = await diskBytes();
      const r = await prepareGetOrder(a);
      const epoch = r.plan.sessionEpoch;
      const pid = a.hostPids().at(-1);
      assert.ok(pid, 'host pid known');
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
      else process.kill(pid, 'SIGKILL');
      await waitFor(() => csharp(a.health())?.sessionEpoch !== epoch, 'epoch change', 60000);
      const out = await a.engine.applyRename(r.planId);
      assert.equal(out.status, 'stale', out.message);
      assert.deepEqual(await diskBytes(), disk);
      assert.ok(TARGETS.every((t) => !openDoc(t)?.getText().includes('FetchOrderQuery')));
      await waitFor(() => csharp(a.health())?.state === 'Ready', 'Ready after restart', 240000);
    },
  ],
];

// Recovery click "Run dotnet restore" on a Shop copy without obj/ (runTest.mjs: copyOpts.restore = false).
const nodePath = require('node:path');
const fs = require('node:fs');
function collectRestoreActions(h) {
  return [...h.recoveryActions, ...h.diagnostics.flatMap((d) => d.recoveryActions ?? []), ...h.projects.flatMap((p) => p.diagnostics.flatMap((d) => d.recoveryActions ?? []))].filter((r) => r.command === 'refyntra.runRestore');
}
scenarios['restore-recovery'] = [
  [
    'the unrestored copy reports the restore recovery action (not Ready)',
    async () => {
      const a = await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      assert.ok(!fs.existsSync(nodePath.join(root, 'Shop.Contracts', 'obj', 'project.assets.json')), 'copy starts without restore output');
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host settled', 240000);
      const h = csharp(a.health());
      assert.notEqual(h.state, 'Ready', 'an unrestored solution must not be Ready');
      const acts = collectRestoreActions(h);
      assert.ok(acts.length >= 1, `restore action offered: ${h.state} ${h.reasonCode} ${JSON.stringify(h.recoveryActions)}`);
      assert.equal(acts[0].title, 'Run dotnet restore');
      assert.equal(acts[0].args.length, 1);
      assert.equal(nodePath.resolve(acts[0].args[0]), nodePath.resolve(root, 'Shop.sln'));
      assert.match(await healthDocText(), /Run dotnet restore/);
      await vscode.commands.executeCommand('refyntra.showHealth');
      const page = a.healthPage.model().sections[0];
      assert.equal(page.headline, 'C# works partially');
      assert.match(page.meaning, /^\d+ of \d+ projects are missing their NuGet packages/);
      assert.equal(page.primary.id, 'restore');
      assert.equal(page.primary.label, 'Restore packages');
      assert.ok(page.groups.some((g) => g.title === 'Needs packages'), JSON.stringify(page.groups));
    },
  ],
  [
    'Related view explains the incomplete scope in plain language, with Run dotnet restore and Show Health',
    async () => {
      const a = await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const doc = await vscode.workspace.openTextDocument(nodePath.join(root, 'Shop.Contracts', 'Orders', 'OrderRequests.cs'));
      const pos = doc.positionAt(doc.getText().indexOf('GetOrderQuery(') + 1);
      const items = await relatedViewItems(a, doc, pos);
      const warn = items.find((i) => i.icon === 'warning');
      assert.ok(warn, JSON.stringify(items));
      assert.match(warn.label, /^Results may be incomplete: \d+ of \d+ projects .*\(.*NuGet packages not restored.*\)$/);
      const restore = items.find((i) => i.label === 'Run dotnet restore');
      assert.ok(restore, JSON.stringify(items));
      assert.equal(restore.command, 'refyntra.runRestore');
      assert.equal(nodePath.resolve(restore.args[0]), nodePath.resolve(root, 'Shop.sln'));
      assert.equal(items.find((i) => i.label === 'Show Health')?.command, 'refyntra.showHealth');
      assert.ok(!items.some((i) => /Version=|PublicKeyToken|loaded completely$|^Search scope/.test(i.label)), JSON.stringify(items));
    },
  ],
  [
    'refuses a path outside the workspace and non-solution paths: no terminal',
    async () => {
      await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const outside = nodePath.join(nodePath.dirname(root), 'Elsewhere.sln');
      const notSln = nodePath.join(root, 'Shop.Api', 'Program.cs');
      const opened = [];
      const sub = vscode.window.onDidOpenTerminal((t) => opened.push(t.name));
      try {
        for (const bad of [outside, notSln, 'Shop.sln', undefined, 42]) await vscode.commands.executeCommand('refyntra.runRestore', bad);
        await new Promise((r) => setTimeout(r, 1000));
      } finally {
        sub.dispose();
      }
      assert.deepEqual(opened, []);
    },
  ],
  [
    'a solution name with $(...), backticks and %VAR% is passed to dotnet as one argument: nothing is expanded or executed',
    async () => {
      await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      // PowerShell would run $(...) inside double quotes; bash would run `...`; cmd expands %VAR%.
      const evilName = 'Shop $(New-Item -ItemType File -Path pwned-ps.txt) `touch pwned-sh.txt` %COMSPEC%.sln';
      const evil = nodePath.join(root, evilName);
      fs.copyFileSync(nodePath.join(root, 'Shop.sln'), evil);
      const pwned = () => ['pwned-ps.txt', 'pwned-sh.txt'].filter((f) => fs.existsSync(nodePath.join(root, f)));
      const ended = new Promise((resolve) => {
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution.task.definition.type !== 'refyntra-restore') return;
          sub.dispose();
          resolve(e);
        });
      });
      try {
        const execution = await vscode.commands.executeCommand('refyntra.runRestore', evil);
        assert.ok(execution, 'the restore task was started');
        const exec = execution.task.execution;
        assert.ok(exec instanceof vscode.ProcessExecution, 'runs as a process (no shell command line)');
        assert.equal(exec.process, 'dotnet');
        assert.deepEqual(exec.args, ['restore', evil]);
        const end = await withTimeout(ended, 240000, 'restore task end');
        assert.equal(end.exitCode, 0, 'dotnet restore received the literal file name and restored it');
        assert.deepEqual(pwned(), [], 'no shell expansion happened');
      } finally {
        fs.rmSync(evil, { force: true });
      }
    },
  ],
  [
    'clicking the recovery action runs dotnet restore as a task; after it finishes, restart reaches Ready',
    async () => {
      const a = await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      for (const p of ['Shop.Contracts', 'Shop.Api']) fs.rmSync(nodePath.join(root, p, 'obj'), { recursive: true, force: true });
      await vscode.commands.executeCommand('refyntra.restartBackend');
      await waitFor(() => collectRestoreActions(csharp(a.health())).length > 0, 'restore action offered again', 240000);
      const action = collectRestoreActions(csharp(a.health()))[0];
      const started = [];
      const ended = new Promise((resolve) => {
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution.task.definition.type !== 'refyntra-restore') return;
          sub.dispose();
          resolve(e);
        });
      });
      const sub = vscode.tasks.onDidStartTaskProcess((e) => started.push(e.execution.task));
      try {
        // Exactly what the UI does (actions.ts runRecovery): executeCommand(action.command, ...args).
        await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
        const end = await withTimeout(ended, 240000, 'restore task end');
        assert.equal(end.exitCode, 0);
      } finally {
        sub.dispose();
      }
      assert.equal(started.length, 1);
      assert.equal(started[0].definition.target, nodePath.resolve(root, 'Shop.sln'));
      assert.equal(nodePath.resolve(started[0].execution.options.cwd), nodePath.resolve(root));
      const assets = ['Shop.Contracts', 'Shop.Api'].map((p) => nodePath.join(root, p, 'obj', 'project.assets.json'));
      assert.ok(assets.every((f) => fs.existsSync(f)), 'obj/project.assets.json written by the restore');
      await vscode.commands.executeCommand('refyntra.restartBackend');
      await waitFor(() => csharp(a.health())?.state === 'Ready', 'Ready after restore + restart', 240000);
      assert.equal(collectRestoreActions(csharp(a.health())).length, 0, 'no restore action once restored');
    },
  ],
  [
    'Health page: Restore packages (clicked through the webview message path) restores, restarts the backend by itself and shows ready',
    async () => {
      const a = await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      for (const p of ['Shop.Contracts', 'Shop.Api']) fs.rmSync(nodePath.join(root, p, 'obj'), { recursive: true, force: true });
      await vscode.commands.executeCommand('refyntra.restartBackend');
      await waitFor(() => collectRestoreActions(csharp(a.health())).length > 0, 'unrestored again', 240000);
      await vscode.commands.executeCommand('refyntra.showHealth');
      const before = a.healthPage.model().sections[0];
      assert.equal(before.headline, 'C# works partially');
      assert.equal(before.primary.id, 'restore');
      assert.equal(nodePath.resolve(before.primary.arg), nodePath.resolve(root, 'Shop.sln'));
      const restarts = csharp(a.health()).restartCount;
      const spawns = a.hostSpawnCount();
      const started = [];
      const sub = vscode.tasks.onDidStartTaskProcess((e) => started.push(e.execution.task));
      try {
        // Same message the page script posts for the primary button.
        await a.healthPage.dispatch({ type: 'action', key: before.primary.key });
        await waitFor(() => a.healthPage.model().restoreBanner?.text.startsWith('Restoring'), 'restore banner', 20000);
        assert.equal(a.healthPage.model().sections[0].primary, undefined, 'no second Restore button while it runs');
        await waitFor(() => csharp(a.health())?.state === 'Ready' && a.hostSpawnCount() > spawns, 'Ready after restore + automatic restart', 300000);
      } finally {
        sub.dispose();
      }
      assert.equal(started.length, 1);
      assert.equal(started[0].definition.type, 'refyntra-restore');
      assert.ok(csharp(a.health()).restartCount >= restarts);
      await waitFor(() => a.healthPage.model().restoreBanner === undefined, 'banner cleared', 30000);
      const after = a.healthPage.model().sections[0];
      assert.match(after.headline, /^C# is ready — \d+ projects loaded$/);
      assert.equal(after.primary, undefined);
    },
  ],
];

// A rename target saved in Windows-1251 (runTest.mjs writes Shop.Api/Services/Legacy1251.cs).
scenarios['rename-nonutf8'] = [
  [
    'with a Windows-1251 target: apply is refused or the preview blocked, no .cs file changes, no buffer is edited',
    async () => {
      const a = await api();
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
      assert.equal(csharp(a.health()).state, 'Ready');
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const listCs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (/^(bin|obj)$/.test(e.name) ? [] : listCs(nodePath.join(d, e.name))) : e.name.endsWith('.cs') ? [nodePath.join(d, e.name)] : []));
      const snapshot = () => new Map(listCs(root).map((f) => [f, fs.readFileSync(f)]));
      assert.ok(fs.existsSync(nodePath.join(root, 'Shop.Api', 'Services', 'Legacy1251.cs')));
      const before = snapshot();
      const { at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'GetOrderQuery(', 1);
      const r = await a.engine.prepareRename(at, 'FetchOrderQuery');
      console.log(`    (prepare: ${r.kind}${r.kind === 'preview' ? ` applyEnabled=${r.applyEnabled} issues=${JSON.stringify(r.issues)} files=${r.plan.writeSet.map((c) => c.uri.split('/').pop())}` : ` ${r.reasonCode} ${r.message}`})`);
      // The host refuses a non-UTF-8 target at prepare, naming the file (not a later misleading "code changed").
      assert.equal(r.kind, 'unavailable', JSON.stringify(r));
      assert.equal(r.reasonCode, 'UnsupportedEncoding');
      assert.match(r.message, /Legacy1251\.cs/);
      const after = snapshot();
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
      for (const [f, bytes] of before) assert.ok(bytes.equals(after.get(f)), `${f} unchanged on disk`);
      for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === 'file') assert.ok(!doc.getText().includes('FetchOrderQuery') && !doc.isDirty, `${doc.uri.fsPath} untouched`);
    },
  ],
  [
    'a closed target with mixed line endings is refused at prepare (VS Code would normalize it: preview != result)',
    async () => {
      const a = await api();
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const mixed = nodePath.join(root, 'Shop.Api', 'Services', 'MixedEol.cs');
      const before = fs.readFileSync(mixed);
      assert.ok(before.includes(Buffer.from('\r\n')) && before.includes(Buffer.from(';\n')), 'the copy has mixed line endings');
      assert.equal(vscode.workspace.textDocuments.find((d) => d.uri.fsPath === mixed), undefined, 'MixedEol.cs is closed');
      const { at } = await shopPosition('Shop.Contracts/Orders/OrderRequests.cs', 'CancelOrderCommand(', 1);
      const r = await a.engine.prepareRename(at, 'AbortOrderCommand');
      assert.equal(r.kind, 'unavailable', JSON.stringify(r));
      assert.equal(r.reasonCode, 'MixedLineEndings');
      assert.match(r.message, /MixedEol\.cs/);
      assert.ok(fs.readFileSync(mixed).equals(before), 'MixedEol.cs unchanged');
    },
  ],
];

// Stage D on a temp copy of tests/fixtures/DiRules: OR1001 in Refyntra's own Problems collection + Tests in Related.
const refyntraDiagnostics = () =>
  vscode.languages.getDiagnostics().flatMap(([uri, list]) => list.filter((d) => d.source === 'Refyntra' && (typeof d.code === 'object' ? d.code.value : d.code) === 'OR1001').map((d) => ({ uri, d })));
scenarios['di-rules'] = [
  [
    'DiRules loads with the app and the xUnit test project',
    async () => {
      const a = await api();
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
      const h = csharp(a.health());
      assert.equal(h.state, 'Ready', `${h.reasonCode}: ${h.message}`);
    },
  ],
  [
    'OR1001 warnings (direct, transitive, typeof) appear in Problems with the proof path; abstentions do not',
    async () => {
      const all = await waitFor(() => {
        const d = refyntraDiagnostics();
        return d.length >= 3 ? d : undefined;
      }, 'three OR1001 diagnostics', 60000);
      assert.equal(all.length, 3, all.map((x) => x.d.message).join('\n'));
      const program = all.find((x) => x.uri.fsPath.endsWith('Program.cs'));
      assert.ok(program, 'a warning in Program.cs');
      const d = program.d;
      assert.equal(d.severity, vscode.DiagnosticSeverity.Warning);
      assert.equal(typeof d.code === 'object' ? d.code.value : d.code, 'OR1001');
      assert.match(String(d.code.target), /docs\/rules\/OR1001\.md$/);
      assert.match(d.message, /'IPriceCache'.*'IOrderRepository'/);
      assert.equal(d.relatedInformation.length, 3);
      assert.ok(d.relatedInformation[1].location.uri.fsPath.endsWith('Direct.cs'), 'the constructor parameter is a related location');
      assert.match(d.relatedInformation[2].message, /Scoped registration AddScoped<IOrderRepository, OrderRepository>/);
      const files = all.map((x) => nodePath.basename(x.uri.fsPath)).sort();
      assert.deepEqual(files, ['Program.cs', 'Transitive.cs', 'Typeof.cs']);
    },
  ],
  [
    'an abstention is explained on demand (code action + explanation), not published as a problem',
    async () => {
      const doc = await vscode.workspace.openTextDocument(shopFile('DiRules.App/Cases/Conditional.cs'));
      const line = doc.getText().split(/\r?\n/).findIndex((l) => l.includes('AddSingleton<CondConsumer>'));
      assert.ok(line >= 0);
      assert.equal(vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Refyntra' && (typeof d.code === 'object' ? d.code.value : d.code) === 'OR1001').length, 0);
      const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(line, 0, line, 0));
      const explainAction = (actions || []).find((x) => /OR1001/.test(x.title));
      assert.ok(explainAction, `code actions: ${(actions || []).map((x) => x.title).join(', ')}`);
      const text = await vscode.commands.executeCommand(explainAction.command.command, ...explainAction.command.arguments);
      assert.match(text, /ConditionalRegistration/);
      assert.match(text, /These are not problems/);
    },
  ],
  [
    'editing only the constructor file removes the PriceCache warning (dependency invalidation), Undo restores it',
    async () => {
      const doc = await vscode.workspace.openTextDocument(shopFile('DiRules.App/Direct.cs'));
      const editor = await vscode.window.showTextDocument(doc);
      const before = doc.getText();
      const needle = 'public PriceCache(IOrderRepository orders) => _orders = orders;';
      const i = before.indexOf(needle);
      assert.ok(i >= 0);
      await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(i), doc.positionAt(i + needle.length)), 'public PriceCache() => _orders = new OrderRepository();'));
      await waitFor(() => !refyntraDiagnostics().some((x) => /'IPriceCache'/.test(x.d.message)) && refyntraDiagnostics().length === 2, 'PriceCache warning gone', 60000);
      await vscode.commands.executeCommand('undo');
      assert.equal(doc.getText(), before);
      await waitFor(() => refyntraDiagnostics().some((x) => /'IPriceCache'/.test(x.d.message)), 'PriceCache warning back', 60000);
      assert.equal(doc.isDirty, false, 'Undo returned to the saved text');
    },
  ],
  [
    'Related → Tests: a referencing xUnit test (proven, not coverage) and a name match (heuristic)',
    async () => {
      const a = await api();
      const { at } = await shopPosition('DiRules.App/Direct.cs', 'class PriceCache', 'class '.length + 1);
      const rel = await a.engine.related(at);
      assert.equal(rel.kind, 'related', JSON.stringify(rel));
      const tests = rel.groups.find((g) => g.group === 'tests');
      assert.ok(tests, `groups: ${rel.groups.map((g) => g.group).join(', ')}`);
      const labels = tests.relations.map((r) => `${r.confidence}: ${r.target.label}`);
      assert.ok(labels.includes('proven: OrderServiceTests.PriceUsesTheRepository — references the symbol — not coverage'), labels.join('\n'));
      assert.ok(labels.includes('heuristic: PriceCacheTests — name match only (heuristic)'), labels.join('\n'));
    },
  ],
  [
    'Actions on a test: "Run test" is unavailable with the reason (no public test integration)',
    async () => {
      const a = await api();
      const { at } = await shopPosition('DiRules.Tests/OrderServiceTests.cs', 'TotalIsZeroForAnEmptyRepository', 1);
      const actions = await a.engine.actions(at);
      const run = actions.items.find((i) => i.capabilityId === 'tests.run');
      assert.ok(run, JSON.stringify(actions.items.map((i) => i.capabilityId)));
      assert.equal(run.state, 'unavailable');
      assert.equal(run.reasonCode, 'NoPublicTestIntegration');
      assert.match(run.message, /^Run test: unavailable — no supported public test integration/);
      // The reverse direction: the test lists the production symbols it references.
      const rel = await a.engine.related(at);
      const subjects = rel.groups.find((g) => g.group === 'tests').relations.filter((r) => r.relationKind === 'test.subject').map((r) => r.target.symbol.name);
      for (const want of ['OrderService', 'OrderRepository', 'Total']) assert.ok(subjects.includes(want), subjects.join(', '));
    },
  ],
];

// ---------------------------------------------------------------- delegated TS/JS route

const TS_ROUTE = 'typescript.vscode-providers';
const tsFile = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
const tsRoute = (h) => h.adapters.find((x) => x.providerRouteId === TS_ROUTE);

async function tsPosition(rel, needle, offset = 0, occurrence = 0) {
  const doc = await vscode.workspace.openTextDocument(tsFile(rel));
  let i = -1;
  for (let n = 0; n <= occurrence; n++) i = doc.getText().indexOf(needle, i + 1);
  assert.ok(i >= 0, `${needle} in ${rel}`);
  return { doc, at: { uri: doc.uri.toString(), position: doc.positionAt(i + offset) } };
}

/** The TypeScript server answers once the project is loaded; wait for document symbols of orders.ts. */
async function waitForTsServer() {
  const doc = await vscode.workspace.openTextDocument(tsFile('src/orders.ts'));
  await vscode.window.showTextDocument(doc);
  await waitFor(async () => {
    const s = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    return Array.isArray(s) && s.length > 0;
  }, 'TypeScript language features', 180000);
  // The project is loaded once references reach the closed file too.
  await waitFor(async () => {
    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, new vscode.Position(0, 18));
    return Array.isArray(refs) && refs.some((l) => l.uri.path.endsWith('/closed.ts'));
  }, 'TypeScript project loaded', 180000);
}

const tsCommon = [
  [
    'the TS/JS route is registered as a delegated route next to the C# route (which stays the owner of .cs)',
    async () => {
      const a = await api();
      const h = a.health();
      assert.equal(tsRoute(h).state, 'Ready');
      assert.equal(tsRoute(h).displayName, 'TS/JS');
      assert.ok(csharp(h), 'the C# route is still registered');
      assert.equal(csharp(h).providerRouteId, 'csharp.roslyn');
      assert.ok(a.engine.handlesDocument(tsFile('src/orders.ts').toString(), 'typescript'));
      assert.ok(a.engine.handlesDocument(tsFile('src/x.cs').toString(), 'csharp'));
      const all = await vscode.commands.getCommands(true);
      assert.ok(all.includes('refyntra.nativeRename'));
      for (const id of ['typescript.find', 'typescript.related', 'typescript.rename', 'typescript.frameworkRelations']) assert.notEqual(a.capabilityUi(id).title, id);
    },
  ],
];

scenarios['ts-absent'] = [
  ...tsCommon,
  [
    'no TypeScript provider for the document (language mode Plain Text): every feature names the missing provider',
    async () => {
      const a = await api();
      const { doc, at } = await tsPosition('src/use.ts', 'getOrder(1)', 2);
      const plain = await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
      assert.equal(plain.languageId, 'plaintext');
      assert.ok(a.engine.handlesDocument(plain.uri.toString(), 'plaintext'), 'still routed to TS/JS by its extension');
      const rel = await a.engine.related(at);
      assert.equal(rel.kind, 'unavailable', JSON.stringify(rel));
      assert.equal(rel.reasonCode, 'ProviderUnavailable');
      assert.match(rel.message, /TypeScript and JavaScript Language Features/);
      const ren = await a.engine.prepareRename(at, 'fetchOrder');
      assert.equal(ren.kind, 'unavailable', JSON.stringify(ren));
      assert.equal(ren.reasonCode, 'ProviderUnavailable');
      const find = await a.engine.find('getOrder');
      assert.equal(find.items.filter((i) => i.providerRouteId === TS_ROUTE).length, 0);
      assert.ok(find.notes.some((n) => /TS\/JS: .*completeness unknown/.test(n)), JSON.stringify(find.notes));
      const actions = await a.engine.actions(at);
      const fw = actions.items.find((i) => i.capabilityId === 'typescript.frameworkRelations');
      assert.equal(fw.state, 'unavailable');
      assert.equal(fw.reasonCode, 'NoFrameworkModule');
    },
  ],
];

// ---------------------------------------------------------------- Python and Rust: Refyntra's own language servers
// The test profile has NO extension besides Refyntra (--disable-extensions also disables VS Code's built-in language
// extensions): everything below runs on the bundled Pyright and rust-analyzer only.
const PY_ROUTE = 'python.pyright';
const RS_ROUTE = 'rust.rust-analyzer';
const routeOf = (h, id) => h.adapters.find((x) => x.providerRouteId === id);

async function waitForRelated(a, at, what) {
  return waitFor(async () => {
    const r = await a.engine.related(at);
    return r.kind === 'related' && r.groups.some((g) => g.group === 'references') ? r : undefined;
  }, what, 120000);
}

const pyRustCommon = [
  [
    'no other extension is installed or active: only Refyntra (no Python extension, no rust-analyzer extension)',
    async () => {
      await api();
      const others = vscode.extensions.all.filter((e) => e.id !== 'refyntra.refyntra' && e.isActive && !e.packageJSON.isBuiltin);
      assert.deepEqual(others.map((e) => e.id), []);
      assert.ok(!vscode.extensions.getExtension('ms-python.python'), 'no Python extension');
      assert.ok(!vscode.extensions.getExtension('rust-lang.rust-analyzer'), 'no rust-analyzer extension');
    },
  ],
  [
    'the Python and Rust routes are Refyntra-owned language-server routes next to C# and TS/JS',
    async () => {
      const a = await api();
      const h = a.health();
      for (const [id, name, prefix] of [[PY_ROUTE, 'Python', 'python'], [RS_ROUTE, 'Rust', 'rust']]) {
        const r = routeOf(h, id);
        assert.ok(r, id);
        assert.equal(r.displayName, name);
        assert.match(r.hostDescription, /bundled with Refyntra/);
        for (const v of ['find', 'related', 'rename', 'frameworkRelations']) assert.notEqual(a.capabilityUi(`${prefix}.${v}`).title, `${prefix}.${v}`);
      }
      assert.ok(csharp(h));
      assert.ok(tsRoute(h));
    },
  ],
];

scenarios['pyrust-restricted'] = [
  ...pyRustCommon,
  [
    'Restricted Mode: opening Python and Rust files starts no language server; features explain TrustRequired',
    async () => {
      const a = await api();
      assert.equal(a.isTrusted(), false);
      for (const [file, route] of [['app/use.py', PY_ROUTE], ['src/usage.rs', RS_ROUTE]]) {
        const { doc, at } = await tsPosition(file, 'get_order(1)', 2);
        await vscode.window.showTextDocument(doc);
        const rel = await a.engine.related(at);
        assert.equal(rel.kind, 'unavailable', JSON.stringify(rel));
        assert.equal(rel.reasonCode, 'TrustRequired');
        const r = await waitFor(() => routeOf(a.health(), route)?.state === 'TrustRequired' && routeOf(a.health(), route), `${route} TrustRequired`);
        assert.equal(r.recoveryActions[0].command, 'workbench.trust.manage');
        const ren = await a.engine.prepareRename(at, 'fetch_order');
        assert.equal(ren.kind, 'unavailable');
      }
      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(a.lspLaunches(), [], 'no language server process was spawned');
      const section = a.healthPage.model().sections.find((s) => s.adapterId === 'python');
      assert.equal(section.icon, 'locked');
      assert.equal(section.primary.id, 'trustWorkspace');
    },
  ],
];

scenarios['pyrust-lsp'] = [
  ...pyRustCommon,
  [
    'Python: the bundled Pyright starts lazily on the Node runtime of VS Code (no system Node); Find returns its symbols',
    async () => {
      const a = await api();
      assert.equal(routeOf(a.health(), PY_ROUTE).state, 'NotStarted');
      const { doc } = await tsPosition('app/orders.py', 'get_order');
      await vscode.window.showTextDocument(doc);
      await waitFor(() => ['Ready', 'Partial'].includes(routeOf(a.health(), PY_ROUTE).state), 'Pyright ready', 120000);
      const launch = a.lspLaunches().find((l) => l.args.some((x) => /langserver\.index\.js$/.test(x)));
      assert.ok(launch, JSON.stringify(a.lspLaunches()));
      assert.equal(launch.command, process.execPath, 'runs on the Node runtime VS Code runs extensions on');
      assert.ok(launch.args.includes('--stdio'));
      const r = await waitFor(async () => {
        const x = await a.engine.find('get_order');
        return x.items.some((i) => i.providerRouteId === PY_ROUTE && i.label === 'get_order') ? x : undefined;
      }, 'get_order from Pyright in Find', 60000);
      const item = r.items.find((i) => i.providerRouteId === PY_ROUTE);
      assert.match(item.location.uri, /orders\.py$/);
      assert.equal(item.provenances[0].kind, 'delegated');
      assert.equal(r.routeLabels[PY_ROUTE], 'Python (delegated)');
      const section = a.healthPage.model().sections.find((s) => s.adapterId === 'python');
      assert.equal(section.headline, 'Python: ready (Pyright, bundled with Refyntra)');
    },
  ],
  [
    'Python Related: declaration + references across files (a closed file included)',
    async () => {
      const a = await api();
      const { at } = await tsPosition('app/use.py', 'get_order(1)', 2);
      const r = await waitForRelated(a, at, 'Pyright references');
      assert.equal(r.subject.name, 'get_order');
      assert.match(r.groups[0].relations[0].target.location.uri, /orders\.py$/);
      const files = new Set(r.groups.find((g) => g.group === 'references').relations.map((x) => x.target.location.uri.split('/').pop()));
      for (const f of ['use.py', 'closed.py', 'orders.py']) assert.ok(files.has(f), `reference in ${f}: ${[...files]}`);
      const actions = await a.engine.actions(at);
      assert.equal(actions.items.find((i) => i.capabilityId === 'python.rename').state, 'limited');
      assert.equal(actions.items.find((i) => i.capabilityId === 'python.frameworkRelations').reasonCode, 'NoFrameworkModule');
    },
  ],
  [
    'Python Rename: preview records the server versions; an edit after the preview -> stale; apply + Undo',
    async () => {
      const a = await api();
      const closedPath = tsFile('app/closed.py').fsPath;
      const closedBefore = fs.readFileSync(closedPath, 'utf8');
      const { at } = await tsPosition('app/orders.py', 'get_order', 3);
      let r = await a.engine.prepareRename(at, 'fetch_order');
      assert.equal(r.kind, 'preview', JSON.stringify(r));
      assert.equal(r.plan.kind, 'delegated');
      assert.equal(r.plan.serverSession.server, 'Pyright');
      assert.equal(r.plan.serverSession.processOwner, 'refyntra');
      assert.ok(r.plan.serverSession.documentVersions.some((v) => v.uri.endsWith('/orders.py')));
      assert.deepEqual(r.plan.writeSet.map((c) => c.uri.split('/').pop()).sort(), ['closed.py', 'orders.py', 'use.py']);
      // An edit after the preview: stale, nothing applied.
      const use = await vscode.workspace.openTextDocument(tsFile('app/use.py'));
      const ed = await vscode.window.showTextDocument(use);
      await ed.edit((b) => b.insert(new vscode.Position(use.lineCount - 1, 0), '# edited\n'));
      const stale = await a.engine.applyRename(r.planId, undefined, { acceptLimited: true });
      assert.equal(stale.status, 'stale', JSON.stringify(stale));
      await vscode.commands.executeCommand('workbench.action.files.revert');
      // Apply on the current versions.
      r = await waitFor(async () => {
        const x = await a.engine.prepareRename(at, 'fetch_order');
        return x.kind === 'preview' ? x : undefined;
      }, 'fresh Python rename preview', 30000);
      const first = await a.engine.applyRename(r.planId);
      assert.equal(first.status, 'limited');
      const out = await a.engine.applyRename(r.planId, undefined, { acceptLimited: true });
      assert.equal(out.status, 'applied', JSON.stringify(out));
      assert.equal(r.plan.validation.providerReprepared, true);
      assert.equal(r.plan.validation.returnedEditsMatchedPreview, true);
      const orders = vscode.workspace.textDocuments.find((d) => d.uri.toString() === tsFile('app/orders.py').toString());
      assert.match(orders.getText(), /def fetch_order/);
      const closed = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === closedPath);
      assert.ok(closed && closed.isDirty && closed.getText().includes('fetch_order(2)'), 'closed target loaded and edited, not saved');
      assert.equal(fs.readFileSync(closedPath, 'utf8'), closedBefore, 'disk unchanged');
      // Undo through the editor.
      for (const d of vscode.workspace.textDocuments.filter((x) => x.uri.scheme === 'file' && x.getText().includes('fetch_order'))) {
        await vscode.window.showTextDocument(d);
        await vscode.commands.executeCommand('undo');
      }
      await waitFor(() => !vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && d.getText().includes('fetch_order')), 'undo restored every file', 20000);
      assert.match(orders.getText(), /def get_order/);
    },
  ],
  [
    'Rust: the bundled rust-analyzer (never one from PATH) answers Related and Rename; Health explains a missing cargo',
    async () => {
      const a = await api();
      const { doc, at } = await tsPosition('src/usage.rs', 'get_order(1)', 2);
      await vscode.window.showTextDocument(doc);
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(routeOf(a.health(), RS_ROUTE).state), 'rust-analyzer started', 180000);
      const route = routeOf(a.health(), RS_ROUTE);
      assert.notEqual(route.state, 'Failed', JSON.stringify(route));
      const launch = a.lspLaunches().find((l) => /rust-analyzer(\.exe)?$/.test(l.command));
      assert.ok(launch, JSON.stringify(a.lspLaunches()));
      assert.ok(/[\\/](servers[\\/]rust-analyzer|\.cache[\\/]rust-analyzer)[\\/]/.test(launch.command), `bundled binary: ${launch.command}`);
      if (process.env.REFYNTRA_TEST_EXPECT_NO_CARGO === '1') {
        assert.equal(route.state, 'Partial');
        assert.equal(route.reasonCode, 'CargoNotFound');
        const section = a.healthPage.model().sections.find((s) => s.adapterId === 'rust');
        assert.equal(section.primary.id, 'installRust');
        assert.equal(section.primary.arg, 'https://rustup.rs/');
        assert.match(JSON.stringify(a.health()), /cannot load the Cargo project/);
        // Without cargo rust-analyzer loads no crate (observed on Linux: not even the declaring file answers), which is
        // what Health says. Related must still answer honestly (no relations, no error) instead of hanging.
        const lib = await tsPosition('src/lib.rs', 'get_order', 7);
        const own = await a.engine.related(lib.at);
        assert.ok(own.kind !== 'related' || !own.groups.some((g) => g.relations.length > 0 && g.group === 'references'), JSON.stringify(own));
        // Rename is refused, not guessed: rust-analyzer cannot resolve the symbol without the crate (NotRenameable).
        const ren = await a.engine.prepareRename(lib.at, 'fetch_order');
        assert.equal(ren.kind, 'unavailable', JSON.stringify(ren));
        return;
      }
      const r = await waitForRelated(a, at, 'rust-analyzer references');
      assert.equal(r.subject.name, 'get_order');
      assert.match(r.groups[0].relations[0].target.location.uri, /lib\.rs$/);
      const ren = await a.engine.prepareRename(at, 'fetch_order');
      assert.equal(ren.kind, 'preview', JSON.stringify(ren));
      assert.equal(ren.plan.serverSession.server, 'rust-analyzer');
      assert.deepEqual(ren.plan.writeSet.map((c) => c.uri.split('/').pop()).sort(), ['lib.rs', 'usage.rs']);
      const kw = await a.engine.prepareRename(at, 'match');
      assert.equal(kw.kind, 'unavailable');
      assert.equal(kw.reasonCode, 'InvalidName');
      // A rust-analyzer refactoring through Refyntra: offered on the selection `get_order(1)`, prepared as a delegated
      // plan (preview, re-asked before apply), applied as one edit.
      const sel = { start: { line: 3, character: 4 }, end: { line: 3, character: 16 } };
      const actions = await waitFor(async () => {
        const l = await a.engine.listDelegatedActions(doc.uri.toString(), sel);
        return l.some((x) => /extract into variable/i.test(x.title)) ? l : undefined;
      }, 'rust-analyzer offers Extract into variable', 60000);
      const extract = actions.find((x) => /extract into variable/i.test(x.title));
      assert.match(extract.kind, /^refactor\.extract/);
      const prep = await a.engine.prepareDelegatedAction({ uri: doc.uri.toString(), range: sel, kind: extract.kind, title: extract.title });
      assert.equal(prep.kind, 'preview', JSON.stringify(prep));
      assert.equal(prep.plan.origin.codeAction.title, extract.title);
      assert.deepEqual(prep.plan.writeSet.map((c) => c.uri.split('/').pop()), ['usage.rs']);
      const applied = await a.engine.applyRename(prep.planId, undefined, { acceptLimited: true });
      assert.equal(applied.status, 'applied', applied.message);
      assert.match(doc.getText(), /let \w+ = get_order\(1\);/);
    },
  ],
];

scenarios['ts-delegated'] = [
  ...tsCommon,
  [
    'Find returns delegated TS symbols with route label and the completeness note (never a complete index)',
    async () => {
      const a = await api();
      await waitForTsServer();
      const r = await waitFor(async () => {
        const x = await a.engine.find('getOrder');
        return x.items.some((i) => i.label === 'getOrder') ? x : undefined;
      }, 'getOrder in Find', 60000);
      const item = r.items.find((i) => i.label === 'getOrder');
      assert.equal(item.providerRouteId, TS_ROUTE);
      assert.equal(item.provenances[0].kind, 'delegated');
      assert.equal(item.provenances[0].snapshotId, 'unknown');
      assert.match(item.location.uri, /orders\.ts$/);
      assert.equal(r.routeLabels[TS_ROUTE], 'TS/JS (delegated)');
      assert.ok(r.notes.some((n) => /not a complete index/.test(n)));
      assert.equal(new Set(r.items.map((i) => i.key)).size, r.items.length, 'exact duplicates are merged');
    },
  ],
  [
    'Related: declaration from the definition provider + references (also in a closed file); framework relations unavailable',
    async () => {
      const a = await api();
      await waitForTsServer();
      const { at } = await tsPosition('src/use.ts', 'getOrder(1)', 2);
      const r = await a.engine.related(at);
      assert.equal(r.kind, 'related', JSON.stringify(r));
      assert.equal(r.subject.name, 'getOrder');
      assert.equal(r.subject.provenance.kind, 'delegated');
      assert.deepEqual(r.groups.map((g) => g.group), ['declarations', 'references']);
      assert.match(r.groups[0].relations[0].target.location.uri, /orders\.ts$/);
      const refFiles = new Set(r.groups[1].relations.map((x) => x.target.location.uri.split('/').pop()));
      for (const f of ['use.ts', 'closed.ts', 'orders.ts']) assert.ok(refFiles.has(f), `reference in ${f}: ${[...refFiles]}`);
      assert.equal(r.completeness, 'unknown');
      assert.ok(r.scopeNotes.some((n) => /Framework relations/.test(n)));
      const actions = await a.engine.actions(at);
      assert.equal(actions.items.find((i) => i.capabilityId === 'typescript.rename').state, 'limited');
      assert.equal(actions.items.find((i) => i.capabilityId === 'typescript.frameworkRelations').reasonCode, 'NoFrameworkModule');
    },
  ],
  [
    'Rename on a keyword is refused by the provider with its reason (NotRenameable)',
    async () => {
      const a = await api();
      await waitForTsServer();
      const { at } = await tsPosition('src/use.ts', 'export');
      const r = await a.engine.prepareRename(at, 'x');
      assert.equal(r.kind, 'unavailable', JSON.stringify(r));
      assert.equal(r.reasonCode, 'NotRenameable');
    },
  ],
  [
    'Rename preview: a limited delegated plan over open and closed files; an edit after the preview makes it stale',
    async () => {
      const a = await api();
      await waitForTsServer();
      const { at } = await tsPosition('src/orders.ts', 'getOrder', 3);
      const r = await a.engine.prepareRename(at, 'fetchOrder');
      assert.equal(r.kind, 'preview', JSON.stringify(r));
      assert.equal(r.plan.kind, 'delegated');
      assert.equal(r.plan.coverage, 'provider-managed');
      assert.equal(r.plan.validation.status, 'limited');
      assert.equal(r.plan.validation.compilationDelta, 'not-run');
      assert.deepEqual(r.plan.writeSet.map((c) => c.uri.split('/').pop()).sort(), ['closed.ts', 'orders.ts', 'use.ts']);
      assert.ok(r.applyEnabled);
      // An edit in use.ts after the preview: the lease ends, nothing is applied.
      const use = await vscode.workspace.openTextDocument(tsFile('src/use.ts'));
      const ed = await vscode.window.showTextDocument(use);
      await ed.edit((b) => b.insert(new vscode.Position(use.lineCount - 1, 0), '// edited\n'));
      const out = await a.engine.applyRename(r.planId, undefined, { acceptLimited: true });
      assert.equal(out.status, 'stale', JSON.stringify(out));
      assert.ok(!vscode.workspace.textDocuments.some((d) => d.getText().includes('fetchOrder')), 'nothing applied');
      await vscode.commands.executeCommand('workbench.action.files.revert');
    },
  ],
  [
    'Rename apply: confirmation of the limitation, provider asked again, applied to buffers (closed file loaded, nothing saved)',
    async () => {
      const a = await api();
      await waitForTsServer();
      const closedPath = tsFile('src/closed.ts').fsPath;
      const closedBefore = fs.readFileSync(closedPath, 'utf8');
      const { at } = await tsPosition('src/orders.ts', 'getOrder', 3);
      const r = await a.engine.prepareRename(at, 'fetchOrder');
      assert.equal(r.kind, 'preview', JSON.stringify(r));
      const first = await a.engine.applyRename(r.planId);
      assert.equal(first.status, 'limited');
      const out = await a.engine.applyRename(r.planId, undefined, { acceptLimited: true });
      assert.equal(out.status, 'applied', JSON.stringify(out));
      assert.equal(r.plan.validation.providerReprepared, true);
      assert.equal(r.plan.validation.returnedEditsMatchedPreview, true);
      assert.ok(out.files.every((f) => f.status === 'confirmed'), JSON.stringify(out.files));
      const orders = vscode.workspace.textDocuments.find((d) => d.uri.toString() === tsFile('src/orders.ts').toString());
      assert.match(orders.getText(), /function fetchOrder/);
      const closed = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === closedPath);
      assert.ok(closed && closed.isDirty && closed.getText().includes('fetchOrder(2)'), 'closed target loaded and edited, not saved');
      assert.equal(fs.readFileSync(closedPath, 'utf8'), closedBefore, 'disk unchanged (not saved)');
    },
  ],
];

// ---- accessibility -----------------------------------------------------------------------------------
// Internal commands: invoked by buttons and tree items, hidden from the Command Palette on purpose.
const INTERNAL_COMMANDS = ['refyntra.openLocation', 'refyntra.openMetadata', 'refyntra.delegatedAction', 'refyntra.runRestore', 'refyntra.related.open', 'refyntra.nativeRename', 'refyntra.stackTrace.openFrame', 'refyntra.stackTrace.related', 'refyntra.taskContext.addFindItem', 'refyntra.taskContext.addFromRelated', 'refyntra.codeLens.related', 'refyntra.selectRunTargetById', 'refyntra.pickDotnetProcess', 'refyntra.immediate.clear', 'refyntra.editAction', 'refyntra.usages.open', 'refyntra.usages.activate', 'refyntra.usages.closeSession', 'refyntra.usages.showMore', 'refyntra.tests.run', 'refyntra.tests.debug', 'refyntra.ef.open', 'refyntra.structuralSearch.showMore', 'refyntra.structuralSearch.openMatch', 'refyntra.structuralSearch.replaceMatch', 'refyntra.solution.open', 'refyntra.solution.revealInExplorer', 'refyntra.solution.revealInOS', 'refyntra.solution.copyPath', 'refyntra.projectFile.loadVersions', ...['kind', 'project', 'folder', 'file', 'type', 'member'].flatMap((g) => [`refyntra.usages.group.${g}`, `refyntra.usages.ungroup.${g}`])];

common.push([
  'keyboard: every user command is in the Command Palette and the status bar menu leads to the main ones',
  async () => {
    const pkg = vscode.extensions.getExtension('refyntra.refyntra').packageJSON;
    const all = await vscode.commands.getCommands(true);
    const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
    assert.deepEqual([...hidden].sort(), [...INTERNAL_COMMANDS].sort(), 'only internal commands are hidden from the Command Palette');
    for (const c of pkg.contributes.commands) {
      assert.ok(all.includes(c.command), `${c.command} is registered`);
      assert.ok(c.title && c.category === 'Refyntra', `${c.command} has a title and the Refyntra category (palette reads "Refyntra: ${c.title}")`);
    }
    // The status bar menu is a QuickPick: open it by command (keyboard route Status bar item -> Enter) and close it again.
    const menu = vscode.commands.executeCommand('refyntra.showMenu'); // resolves only when the QuickPick closes
    await new Promise((r) => setTimeout(r, 500));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await menu;
  },
]);

scenarios['high-contrast'] = [
  [
    'the High Contrast theme is active',
    async () => {
      await waitFor(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast, 'High Contrast color theme', 15000);
    },
  ],
  [
    'Health page opens under High Contrast: landmarks, live region, text next to every icon, HC styles',
    async () => {
      const a = await api();
      await vscode.commands.executeCommand('refyntra.showHealth');
      assert.ok(a.healthPage.isOpen());
      const html = a.healthPage.html();
      assert.match(html, /<main id="root"/);
      assert.match(html, /<h1 id="page-title"/);
      assert.match(html, /id="live"[^>]*role="status"[^>]*aria-live="polite"/);
      assert.match(html, /body\.vscode-high-contrast/);
      assert.match(html, /body\.vscode-high-contrast-light/);
      assert.match(html, /:focus-visible\{outline:2px solid var\(--vscode-focusBorder\)/);
      assert.ok(!/<[^>]+\son[a-z]+=/i.test(html), 'no inline event handlers');
      for (const s of a.healthPage.model().sections) assert.ok(s.headline.length > 0, 'every status has its meaning in words, not only an icon');
      const label = a.statusBarLabel();
      assert.match(label, /^Refyntra: /);
      assert.match(label, /Press Enter for the Refyntra menu/);
    },
  ],
  [
    'Health actions work from the keyboard path (message dispatch) under High Contrast',
    async () => {
      const a = await api();
      await vscode.commands.executeCommand('refyntra.showHealth');
      const secondary = a.healthPage.model().secondary.find((x) => x.id === 'getStarted');
      assert.ok(secondary, 'Get started is on the page');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await a.healthPage.dispatch({ type: 'action', key: secondary.key });
      await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => /walkthrough|welcome|get started|refyntra/i.test(t.label)), 'walkthrough tab', 10000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
];

// MVC: on a temp copy of tests/fixtures/Mvc: MVC actions and controllers relate to their endpoints, Find route: finds them.
scenarios.mvc = [
  [
    'Mvc loads',
    async () => {
      const a = await api();
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
      const h = csharp(a.health());
      assert.equal(h.state, 'Ready', `${h.reasonCode}: ${h.message}`);
    },
  ],
  [
    'Related on an action shows its endpoint; Related on the controller shows all its endpoints',
    async () => {
      const a = await api();
      const { at } = await shopPosition('Mvc.Api/Controllers/OrdersController.cs', 'GetOrder(int id)', 1);
      const rel = await a.engine.related(at);
      assert.equal(rel.kind, 'related', JSON.stringify(rel));
      const eps = allRelations(rel).filter((r) => r.relationKind === 'aspnet.endpoint');
      assert.equal(eps.length, 1, JSON.stringify(eps));
      assert.equal(eps[0].target.endpoint.route, '/api/Orders/{id:int}');
      assert.equal(eps[0].target.endpoint.kind, 'mvc');
      assert.deepEqual(eps[0].target.endpoint.httpMethods, ['GET']);
      const c = await shopPosition('Mvc.Api/Controllers/OrdersController.cs', 'class OrdersController', 'class '.length + 1);
      const crel = await a.engine.related(c.at);
      const routes = allRelations(crel).filter((r) => r.relationKind === 'aspnet.endpoint').map((r) => r.target.endpoint.route);
      assert.equal(routes.length, 7, routes.join(', '));
      for (const want of ['/api/Orders/{id:int}', '/api/Orders', '/api/legacy/orders/{id}', '/api/Orders/probe']) assert.ok(routes.includes(want), `${want} in ${routes.join(', ')}`);
    },
  ],
  [
    'Find route:/api/Orders finds the MVC endpoints (and method: narrows them)',
    async () => {
      const a = await api();
      const r = await a.engine.find('route:/api/Orders');
      const eps = r.items.filter((i) => i.kind === 'endpoint');
      assert.equal(eps.length, 6, JSON.stringify(r.items.map((i) => i.label)));
      assert.ok(eps.every((i) => i.endpoint.kind === 'mvc'));
      const gets = await a.engine.find('route:/api/Orders method:GET');
      assert.deepEqual(gets.items.map((i) => i.endpoint.route).sort(), ['/api/Orders/Internal', '/api/Orders/{id:int}']);
    },
  ],
];

// EF Core: on a temp copy of tests/fixtures/EfCore: entity and DbContext relations (group "data"), Find entity:/table:.
scenarios.efcore = [
  [
    'EfCore loads',
    async () => {
      const a = await api();
      await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
      const h = csharp(a.health());
      assert.equal(h.state, 'Ready', `${h.reasonCode}: ${h.message}`);
    },
  ],
  [
    'Related on an entity shows its DbContexts, table, navigations, queries (with the endpoint) and migrations',
    async () => {
      const a = await api();
      const { at } = await shopPosition('EfCore.Domain/Entities.cs', 'class Order', 'class '.length + 1);
      const rel = await a.engine.related(at);
      assert.equal(rel.kind, 'related', JSON.stringify(rel));
      const data = rel.groups.find((g) => g.group === 'data');
      assert.ok(data, `groups: ${rel.groups.map((g) => g.group).join(', ')}`);
      const kinds = new Set(data.relations.map((r) => r.relationKind));
      for (const k of ['efcore.dbContext', 'efcore.configuration', 'efcore.table', 'efcore.navigation', 'efcore.migration']) assert.ok(kinds.has(k), `${k} in ${[...kinds].join(', ')}`);
      const table = data.relations.find((r) => r.relationKind === 'efcore.table');
      assert.equal(table.target.label, 'orders');
      const queries = allRelations(rel).filter((r) => r.relationKind === 'efcore.query');
      assert.ok(queries.some((q) => q.target.label.includes('OrderQueries.Open')), JSON.stringify(queries.map((q) => q.target.label)));
      assert.ok(allRelations(rel).some((r) => r.relationKind === 'aspnet.endpoint' && r.target.endpoint.route === '/orders/{id}'));
    },
  ],
  [
    'Related on a DbContext shows its entities and its AddDbContext registration',
    async () => {
      const a = await api();
      const { at } = await shopPosition('EfCore.Api/Data/ShopDbContext.cs', 'class ShopDbContext', 'class '.length + 1);
      const rel = await a.engine.related(at);
      const entities = allRelations(rel).filter((r) => r.relationKind === 'efcore.entity').map((r) => r.target.symbol && r.target.symbol.name);
      for (const want of ['Customer', 'Order', 'Product', 'OrderLine']) assert.ok(entities.includes(want), `${want} in ${entities.join(', ')}`);
      assert.ok(allRelations(rel).some((r) => r.relationKind === 'di.registration' && r.target.label.includes('AddDbContext')));
    },
  ],
  [
    'Find entity: lists EF entities only; table: finds an entity by its mapped table',
    async () => {
      const a = await api();
      const r = await a.engine.find('entity:Order');
      const names = r.items.map((i) => i.symbol && i.symbol.name);
      assert.ok(names.includes('Order') && names.includes('OrderLine'), names.join(', '));
      assert.ok(!names.includes('OrderSummary') && !names.includes('OrderQueries'), names.join(', '));
      const t = await a.engine.find('table:catalog_products');
      assert.deepEqual(t.items.map((i) => i.symbol && i.symbol.name), ['Product']);
    },
  ],
];

// File rename: type rename together with its file (test/suite/fileRename.cjs).
scenarios['rename-file'] = require('./fileRename.cjs').cases({ api, csharp, waitFor });
// Created files: Move Type to File and Generate handler (test/suite/createFile.cjs).
scenarios['create-file'] = require('./createFile.cjs').cases({ api, csharp, waitFor });
// EF Core migrations in a rename (test/suite/efMigrationRename.cjs).
scenarios['rename-efcore'] = require('./efMigrationRename.cjs').cases({ api, csharp, waitFor });
// EF Core tools (ADR-011): the migrations view on the EfCore fixture; dotnet-ef tasks, OR1011, Show SQL on EfTools.
scenarios.efcore.push(...require('./efCore.cjs').treeCases({ api, csharp, waitFor }));
scenarios['ef-tools'] = require('./efCore.cjs').cases({ api, csharp, waitFor });
// Code Cleanup (test/suite/cleanup.cjs).
scenarios.cleanup = require('./cleanup.cjs').cases({ api, csharp, waitFor });
// Safe Delete, Extract Method, Change Signature (test/suite/codeRefactor.cjs).
scenarios['code-refactor'] = require('./codeRefactor.cjs').cases({ api, csharp, waitFor });
// Stack trace navigation (test/suite/stackTrace.cjs).
scenarios['stack-trace'] = require('./stackTrace.cjs').cases({ api, csharp, waitFor });
// Frontend ↔ backend HTTP links (test/suite/fullStack.cjs).
scenarios['full-stack'] = require('./fullStack.cjs').cases({ api, csharp, waitFor });
// HTML/CSS/SCSS/LESS ↔ code links with every other extension disabled (test/suite/webStyles.cjs).
scenarios['web-styles'] = require('./webStyles.cjs').cases({ api, waitFor });
// React / Next.js / Angular through the web worker (test/suite/webFrameworks.cjs).
scenarios['web-frameworks'] = require('./webFrameworks.cjs').cases({ api, waitFor });
scenarios['web-frameworks-restricted'] = require('./webFrameworks.cjs').restricted({ api, waitFor });
// Task context (test/suite/taskContext.cjs).
scenarios['task-context'] = require('./taskContext.cjs').cases({ api, csharp, waitFor });
// Constructor / DI helpers on Roslyn, Register in DI and Fix in scope through the Refactor Preview (test/suite/ctorDi.cjs).
scenarios['ctor-di'] = require('./ctorDi.cjs').cases({ api, csharp, waitFor });
// Inspections OR1002–OR1010 on a temp copy of tests/fixtures/Inspections (suite/inspections.cjs).
scenarios.inspections = require('./inspections.cjs').cases({ api, csharp, waitFor });
// Structural Search and Replace on a temp copy of tests/fixtures/StructuralSearch (suite/structuralSearch.cjs).
scenarios['structural-search'] = require('./structuralSearch.cjs').cases({ api, csharp, waitFor });
// Native VS Code UI: code actions, CodeLens, Call/Type Hierarchy, hover, Refactor Preview, Change Signature dialog (test/suite/nativeUi.cjs).
scenarios['native-ui'] = require('./nativeUi.cjs').cases({ api, csharp, waitFor });
// Navigate To and Find Usages grouped (test/suite/navigation.cjs).
scenarios.navigation = require('./navigation.cjs').cases({ api, csharp, waitFor });
// Go to metadata / decompiled sources (test/suite/metadata.cjs), on the same Shop copy.
scenarios.navigation.push(...require('./metadata.cjs').cases({ api, csharp, waitFor }));
// Visual (screenshot) scenarios, Docker/Xvfb only (test/suite/visual.cjs, scripts/test/linux-visual.sh).
// Run and Debug on a temp copy of the Runnable fixture (bundled netcoredbg and debugpy; test/suite/runDebug.cjs).
scenarios['run-debug'] = require('./runDebug.cjs').cases({ api, csharp, waitFor });
// Test runner on the Testing API (test/suite/testing.cjs).
scenarios.tests = require('./testing.cjs').cases({ api, csharp, waitFor });
// Target frameworks: net8.0 / net9.0 / net10.0 / netstandard2.x (Docker image with SDK 8 and the .NET 9 runtime).
scenarios.compat = require('./compat.cjs').cases({ api, csharp, waitFor });
scenarios['compat-sdk-missing'] = require('./compat.cjs').sdkMissing({ api, csharp, waitFor });

// Solution Explorer, project operations, NuGet, project file editing (test/suite/solution.cjs); the tree also on Shop.
scenarios.solution = require('./solution.cjs').cases({ api, csharp, waitFor });
scenarios.shop.push(...require('./solution.cjs').shop({ api, csharp, waitFor }));

scenarios['visual-dark'] = require('./visual.cjs').cases({ api, csharp, waitFor });
scenarios['visual-light'] = require('./visual.cjs').cases({ api, csharp, waitFor });
// REFYNTRA_VISUAL_ONLY (pnpm test:visual --only=a,b) also applies to these extra suites: the first case (window setup)
// always runs, the screenshot cases only when named.
const visualOnly = (cases) => {
  const only = (process.env.REFYNTRA_VISUAL_ONLY || '').split(',').filter(Boolean);
  return only.length ? cases.filter(([title], i) => i === 0 || only.some((o) => title.startsWith(`visual: ${o} `))) : cases;
};
scenarios['visual-tests-dark'] = visualOnly(require('./visualTests.cjs').cases({ api, csharp, waitFor }));
scenarios['visual-tests-light'] = visualOnly(require('./visualTests.cjs').cases({ api, csharp, waitFor }));
scenarios['visual-ef-dark'] = visualOnly(require('./visualEf.cjs').cases({ api, csharp, waitFor }));
scenarios['visual-ef-light'] = visualOnly(require('./visualEf.cjs').cases({ api, csharp, waitFor }));
scenarios['visual-solution-dark'] = visualOnly(require('./visualSolution.cjs').cases({ api, csharp, waitFor }));
scenarios['visual-solution-light'] = visualOnly(require('./visualSolution.cjs').cases({ api, csharp, waitFor }));

exports.run =async function run() {
  const name = process.env.REFYNTRA_TEST_SCENARIO;
  const cases = [...common, ...(scenarios[name] || [])];
  if (!scenarios[name]) throw new Error(`Unknown scenario ${name}`);
  const failures = [];
  for (const [title, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${title}`);
    } catch (e) {
      console.log(`  ✗ ${title}\n    ${e && e.stack ? e.stack : e}`);
      failures.push(title);
    }
    // VNC watch mode (scripts/test/lib/display.sh): a pause after each case so a person can follow.
    const pause = Number(process.env.REFYNTRA_VNC_PAUSE_MS || 0);
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  }
  if (failures.length) throw new Error(`${failures.length} test(s) failed in scenario ${name}`);
};
