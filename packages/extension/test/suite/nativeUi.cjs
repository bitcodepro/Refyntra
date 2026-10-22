// Native VS Code UI e2e (runTest.mjs scenario "native-ui") on a temp copy of the Shop fixture: code action kinds in the
// lightbulb / Refactor menu, CodeLens resolve, the built-in Call and Type Hierarchy answered by Refyntra's host, the
// MediatR hover, the editor's Refactor Preview applying a revalidated plan / discarding / refusing a stale plan, the
// Change Signature dialog, and the status bar state. The repository fixture is never touched.
const assert = require('node:assert/strict');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const services = () => file('Shop.Api/Services/OrderServices.cs');
  const handlers = () => file('Shop.Api/Handlers/OrderHandlers.cs');
  const requests = () => file('Shop.Contracts/Orders/OrderRequests.cs');

  async function ready() {
    const a = await api();
    await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
    assert.equal(csharp(a.health()).state, 'Ready');
    return a;
  }

  async function at(uri, needle, offset = 0) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, needle);
    return { doc, pos: doc.positionAt(i + offset) };
  }

  async function revertAll() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  /** Confirms (or discards) the editor's Refactor Preview once it is open; resolves with the apply outcome. */
  async function throughPreview(applying, command) {
    let done = false;
    const result = applying.finally(() => (done = true));
    const start = Date.now();
    while (!done && Date.now() - start < 60000) {
      await new Promise((r) => setTimeout(r, 300));
      if (done) break;
      try {
        await vscode.commands.executeCommand(command);
      } catch {
        // The panel is not open yet.
      }
    }
    return result;
  }

  return [
    ['the temp Shop copy loads (apply on); the status bar says ready', async () => {
      const a = await ready();
      await waitFor(() => a.statusKind() !== 'loading', 'status not loading', 60000);
      assert.match(a.statusBarText(), /C# Ready/);
      // Other routes of this workspace (Python, Rust, …) may report their own state; C# is ready, nothing is loading.
    }],
    ['code actions: Refactor kinds at a method, Extract Method for a selection, Code Cleanup as a source action', async () => {
      await ready();
      const { doc, pos } = await at(services(), 'public int Create(string customer', 'public int '.length + 1);
      const kinds = (actions) => actions.map((x) => x.kind && x.kind.value);
      const refactors = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(pos, pos), vscode.CodeActionKind.Refactor.value);
      const k = kinds(refactors);
      for (const want of ['refactor.rewrite.signature', 'refactor.rewrite.rename']) assert.ok(k.includes(want), `${want} in ${k.join(', ')}`);
      const sig = refactors.find((x) => x.kind.value === 'refactor.rewrite.signature');
      assert.equal(sig.command.command, 'refyntra.changeSignature');
      assert.equal(sig.command.arguments[0].uri, doc.uri.toString());
      const stmt = await at(services(), 'var id = _orders.Count + 1;');
      const sel = new vscode.Range(stmt.pos, stmt.doc.positionAt(stmt.doc.offsetAt(stmt.pos) + 'var id = _orders.Count + 1;'.length));
      const extract = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, sel, 'refactor.extract');
      const em = extract.find((x) => x.kind.value === 'refactor.extract.method');
      assert.ok(em && !em.disabled, JSON.stringify(kinds(extract)));
      assert.deepEqual(em.command.arguments[0].range.start, { line: sel.start.line, character: sel.start.character });
      const source = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(pos, pos), 'source');
      assert.ok(kinds(source).includes('source.refyntra.cleanup'), kinds(source).join(', '));
      const typeAt = await at(services(), 'class CachedOrderService', 'class '.length + 1);
      const onType = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(typeAt.pos, typeAt.pos), 'refactor');
      for (const want of ['refactor.move.typeToFile', 'refactor.rewrite.safeDelete']) assert.ok(kinds(onType).includes(want), `${want} in ${kinds(onType).join(', ')}`);
    }],
    ['CodeLens: references on a method resolve; a MediatR request gets "→ Handler" after the first resolve', async () => {
      const a = await ready();
      // The lens command works on open documents only (the editor's model).
      for (const u of [services(), requests(), handlers()]) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(u), { preview: false });
      const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', services(), 100);
      const titles = lenses.map((l) => l.command && l.command.title).filter(Boolean);
      assert.ok(titles.some((t) => /^\d+ references?/.test(t)), titles.join(' | '));
      const iface = lenses.find((l) => l.range.start.line === 4);
      assert.ok(iface && /implementations?/.test(iface.command.title), iface && iface.command.title);
      assert.equal(iface.command.command, 'editor.action.peekLocations');
      const handler = await waitFor(async () => {
        const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', requests(), 100);
        return ls.find((l) => l.command && /^→ Handler: GetOrderQueryHandler/.test(l.command.title));
      }, 'MediatR handler lens', 60000);
      assert.equal(handler.command.command, 'editor.action.peekLocations');
      const sent = await waitFor(async () => {
        const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', handlers(), 100);
        return ls.find((l) => l.command && /^← sent from [1-9]\d* place/.test(l.command.title));
      }, 'MediatR sent-from lens', 60000);
      assert.equal(sent.command.command, 'editor.action.peekLocations');
      assert.ok(a.codeLens.scanTimes.length > 0 && Math.max(...a.codeLens.scanTimes) < 50, `scan ms ${a.codeLens.scanTimes.join(',')}`);
      // A C# file outside every loaded project: a clear lens, not the old catch-all.
      const stray = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Stray.cs');
      await vscode.workspace.fs.writeFile(stray, Buffer.from('public class Stray\n{\n}\n'));
      try {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(stray));
        let seen = [];
        const strayLens = await waitFor(async () => {
          const ls = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', stray, 100);
          seen = ls.map((l) => (l.command ? l.command.title : '(unresolved)'));
          return ls.find((l) => l.command && !/loading/.test(l.command.title));
        }, 'the lens of a file outside the projects', 60000).catch((e) => {
          throw new Error(`${e.message}; lenses: ${JSON.stringify(seen)}`);
        });
        // The host answers "no symbol" for it; never the old catch-all "not available yet".
        assert.match(strayLens.command.title, /no symbol|project is not loaded/);
        assert.doesNotMatch(strayLens.command.title, /not available yet/);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.workspace.fs.delete(stray);
      }
    }],
    ['Call Hierarchy: incoming calls of IOrderService.Find come from the handler (built-in command, Refyntra host)', async () => {
      await ready();
      const { doc, pos } = await at(services(), 'OrderDto? Find(int id);', 'OrderDto? '.length + 1);
      const items = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', doc.uri, pos);
      assert.equal(items.length, 1);
      assert.equal(items[0].name, 'Find');
      const incoming = await vscode.commands.executeCommand('vscode.provideIncomingCalls', items[0]);
      assert.deepEqual(incoming.map((c) => c.from.name), ['Handle']);
      assert.ok(incoming[0].fromRanges.length >= 1);
      const h = await at(handlers(), 'public async Task<int> Handle', 'public async Task<int> '.length + 1);
      const [handle] = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', h.doc.uri, h.pos);
      const outgoing = await vscode.commands.executeCommand('vscode.provideOutgoingCalls', handle);
      assert.ok(outgoing.some((c) => c.to.name === 'Create'), outgoing.map((c) => c.to.name).join(', '));
    }],
    ['Type Hierarchy: subtypes of IOrderService and supertypes of OrderService', async () => {
      await ready();
      const { doc, pos } = await at(services(), 'interface IOrderService', 'interface '.length + 1);
      const [item] = await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', doc.uri, pos);
      assert.equal(item.name, 'IOrderService');
      const subs = await vscode.commands.executeCommand('vscode.provideSubtypes', item);
      assert.deepEqual(subs.map((s) => s.name).sort(), ['CachedOrderService', 'OrderService']);
      const impl = await at(services(), 'class OrderService', 'class '.length + 1);
      const [cls] = await vscode.commands.executeCommand('vscode.prepareTypeHierarchy', impl.doc.uri, impl.pos);
      const sups = await vscode.commands.executeCommand('vscode.provideSupertypes', cls);
      assert.deepEqual(sups.map((s) => s.name), ['IOrderService']);
    }],
    ['hover on a MediatR request names its handler with a link', async () => {
      await ready();
      const { doc, pos } = await at(file('Shop.Api/Program.cs'), 'new GetOrderQuery(id)', 'new '.length + 2);
      const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos);
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /GetOrderQueryHandler/);
      assert.match(text, /command:refyntra\.openLocation/);
    }],
    ['Refactor Preview: a revalidated rename is applied only after it is confirmed in the panel', async () => {
      const a = await ready();
      const { doc, pos } = await at(services(), 'int Create(string customer, decimal total);', 'int '.length + 1);
      const r = await a.engine.prepareRename({ uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } }, 'CreateOrder');
      assert.equal(r.kind, 'preview', JSON.stringify(r));
      assert.ok(r.plan.writeSet.every((c) => c.kind === 'text'));
      // Minimal edits, one per occurrence (the preview lists them), never one whole-document replacement.
      assert.ok(r.plan.writeSet.every((c) => c.edits.every((e) => e.range.start.line === e.range.end.line && !e.newText.includes('\n'))), JSON.stringify(r.plan.writeSet.map((c) => c.edits.length)));
      const out = await throughPreview(a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: rename' } }), 'refactorPreview.apply');
      assert.equal(out.status, 'applied', out.message);
      assert.ok(out.files.every((f) => f.status === 'confirmed'));
      assert.match((await vscode.workspace.openTextDocument(handlers())).getText(), /_orders\.CreateOrder\(/);
      await revertAll();
      await waitFor(async () => (await a.engine.find('member: Create')).items.length > 0, 'host sees the reverted text', 60000);
    }],
    ['Refactor Preview: discarding changes nothing; a plan that went stale is refused before the panel opens', async () => {
      const a = await ready();
      const { doc, pos } = await at(services(), 'OrderDto? Find(int id);', 'OrderDto? '.length + 1);
      const target = { uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } };
      const r = await a.engine.prepareRename(target, 'Lookup');
      assert.equal(r.kind, 'preview', JSON.stringify(r));
      const before = doc.getText();
      const discarded = await throughPreview(a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: rename' } }), 'refactorPreview.discard');
      assert.notEqual(discarded.status, 'applied');
      assert.ok((discarded.files || []).every((f) => f.status === 'unchanged'), JSON.stringify(discarded));
      assert.equal(doc.getText(), before);
      const stale = await a.engine.prepareRename(target, 'Lookup');
      assert.equal(stale.kind, 'preview');
      const edit = new vscode.WorkspaceEdit();
      edit.insert(handlers(), new vscode.Position(0, 0), '// edited after the preview\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      const refused = await a.engine.applyRename(stale.planId, undefined, { confirmation: { label: 'Refyntra: rename' } });
      assert.equal(refused.status, 'stale', refused.message);
      assert.equal(doc.getText(), before);
      await revertAll();
    }],
    ['Change Signature dialog: reorder with the keyboard path, live preview, cancel changes nothing', async () => {
      const a = await ready();
      const { doc, pos } = await at(services(), 'public int Create(string customer', 'public int '.length + 1);
      const running = vscode.commands.executeCommand('refyntra.changeSignature', { uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } });
      const dialog = await waitFor(() => a.changeSignatureDialog(), 'dialog open', 30000);
      assert.equal(dialog.view().problem, 'The signature is unchanged.');
      dialog.dispatch({ type: 'move', index: 0, delta: 1 });
      assert.equal(dialog.view().preview, 'Create(decimal total, string customer)');
      assert.equal(dialog.view().problem, undefined);
      await waitFor(() => dialog.view().callSites, 'call-site count', 30000);
      dialog.dispatch({ type: 'cancel' });
      await running;
      assert.equal(a.changeSignatureDialog(), undefined);
      assert.equal(doc.isDirty, false);
    }],
  ];
};
