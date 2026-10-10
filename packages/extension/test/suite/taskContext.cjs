// Task context e2e on a temp copy of tests/fixtures/Shop (runTest.mjs scenario "task-context"): add a symbol, a pinned
// relation, a Find result and a file; move the symbol by an edit (moved, opens the new place); re-read the stored
// state (persists); rename it through Refyntra (resolved by name); delete it (missing); Markdown, export/import.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri;
  const file = (rel) => vscode.Uri.joinPath(root(), ...rel.split('/'));
  const SERVICES = 'Shop.Api/Services/OrderServices.cs';

  async function ready() {
    const a = await api();
    await waitFor(() => csharp(a.health())?.state === 'Ready', 'C# Ready', 240000);
    return a;
  }

  async function cursorOn(rel, needle, offset = 0) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const idx = doc.getText().indexOf(needle);
    assert.ok(idx >= 0, `${needle} in ${rel}`);
    const pos = doc.positionAt(idx + offset);
    const ed = await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    return { doc, ed, pos };
  }

  /** Resolves again until the item reaches `status` (bounded: the host needs a moment after an edit). */
  async function resolvesTo(tc, itemId, status, what) {
    let last;
    await waitFor(
      async () => {
        await tc.resolveNow();
        last = tc.stateOf(itemId);
        return last && last.status === status;
      },
      `${what}: ${status} (last: ${JSON.stringify(last)})`,
      90000,
    );
    return last;
  }

  const itemById = (tc, id) => tc.active().items.find((i) => i.id === id);
  const ids = {};
  let relationTitle;

  return [
    [
      'task context: the temp Shop copy loads; a context is created and is the view description',
      async () => {
        const a = await ready();
        assert.ok(!root().fsPath.includes(`tests${path.sep}fixtures`), 'runs on a temp copy');
        const tc = a.taskContext;
        assert.equal(tc.active(), undefined);
        await vscode.commands.executeCommand('refyntra.taskContext.new', 'Checkout');
        assert.equal(tc.active().name, 'Checkout');
        await vscode.commands.executeCommand('refyntra.taskContext.new', 'Checkout');
        assert.equal(tc.active().name, 'Checkout (2)', 'names stay unique');
        tc.testHooks = { confirm: () => true };
        await vscode.commands.executeCommand('refyntra.taskContext.delete');
        assert.equal(tc.active().name, 'Checkout');
      },
    ],
    [
      'task context: add the symbol at the cursor, a pinned relation from Related, a Find result and a file',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        await cursorOn(SERVICES, 'class OrderService ', 'class '.length + 2);
        const sym = await vscode.commands.executeCommand('refyntra.taskContext.addSymbol');
        assert.ok(sym, tc.lastMessage);
        ids.symbol = sym.id;
        assert.equal(sym.target.name, 'OrderService');
        assert.equal(sym.target.symbolKind, 'class');
        assert.equal(sym.target.route, 'csharp.roslyn');
        assert.deepEqual(sym.target.file, { folder: vscode.workspace.workspaceFolders[0].name, path: SERVICES });
        assert.match(sym.target.fingerprint, /^fnv1a32:[0-9a-f]{8}$/);
        assert.equal((await resolvesTo(tc, sym.id, 'resolved', 'added symbol')).status, 'resolved');

        // Related on the class: pin "OrderService implements IOrderService".
        await vscode.commands.executeCommand('refyntra.related');
        await waitFor(() => a.related.current()?.kind === 'related', 'Related outcome', 60000);
        const toInterface = a.related.current().groups.flatMap((g) => g.relations).filter((r) => r.target.symbol?.name === 'IOrderService');
        // Prefer the base-type relation; any relation to IOrderService (for example the DI service) works the same.
        const rel = toInterface.find((r) => /implement|base/i.test(r.relationKind)) ?? toInterface[0];
        assert.ok(rel, 'OrderService → IOrderService relation');
        const pinned = await vscode.commands.executeCommand('refyntra.taskContext.addFromRelated', { kind: 'relation', relation: rel });
        assert.ok(pinned, tc.lastMessage);
        ids.relation = pinned.id;
        assert.equal(pinned.kind, 'relation');
        assert.equal(pinned.subject.name, 'OrderService');
        assert.equal(pinned.target.name, 'IOrderService');
        assert.equal(pinned.target.route, 'csharp.roslyn', 'a module route is stored as its language route');
        relationTitle = `OrderService ${pinned.relationKind} IOrderService`;
        // The Related view's relation items carry the context value of the inline "Add to Task Context" button.
        assert.equal(a.related.getTreeItem({ kind: 'relation', relation: rel }).contextValue, 'refyntra.relatedRelation');

        // Find result.
        const found = await a.engine.find('AuditLog');
        const it = found.items.find((i) => i.symbol?.name === 'AuditLog');
        assert.ok(it, 'Find AuditLog');
        const fromFind = await vscode.commands.executeCommand('refyntra.taskContext.addFindItem', it);
        assert.ok(fromFind, tc.lastMessage);
        ids.find = fromFind.id;

        // File (Explorer passes the URI).
        const f = await vscode.commands.executeCommand('refyntra.taskContext.addFile', file('Shop.Api/Program.cs'));
        ids.file = f.id;
        assert.equal(f.target.name, 'Program.cs');

        // Adding the same symbol twice is a no-op.
        await cursorOn(SERVICES, 'class OrderService ', 'class '.length + 2);
        await vscode.commands.executeCommand('refyntra.taskContext.addSymbol');
        assert.equal(tc.active().items.length, 4);
        await tc.resolveNow();
        for (const id of Object.values(ids)) assert.equal(tc.stateOf(id).status, 'resolved', JSON.stringify(tc.stateOf(id)));

        // Storage holds descriptors, not code: no source line in workspaceState.
        const stored = JSON.stringify(tc.store);
        assert.ok(!stored.includes('public sealed class'), 'no source text stored');
        assert.ok(!stored.includes(root().fsPath.replace(/\\/g, '\\\\')), 'workspace files are stored relative');
      },
    ],
    [
      'task context: an edit moves the symbol → moved, and Open goes to the new place',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        const before = itemById(tc, ids.symbol).target.position.line;
        const doc = await vscode.workspace.openTextDocument(file(SERVICES));
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(0, 0), '// one\n// two\n// three\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        const st = await resolvesTo(tc, ids.symbol, 'moved', 'after inserting three lines');
        assert.match(st.reason, /new place/);
        assert.equal(itemById(tc, ids.symbol).target.position.line, before + 3);
        assert.equal(tc.getTreeItem({ kind: 'item', item: itemById(tc, ids.symbol) }).description.split(' · ')[0], 'moved', 'the state is a word');
        const label = tc.getTreeItem({ kind: 'item', item: itemById(tc, ids.symbol) }).accessibilityInformation.label;
        assert.match(label, /OrderService, class, moved/);
        const opened = await vscode.commands.executeCommand('refyntra.taskContext.open', ids.symbol);
        assert.equal(opened, 'opened');
        const ed = vscode.window.activeTextEditor;
        assert.equal(ed.document.uri.toString(), doc.uri.toString());
        assert.equal(ed.selection.active.line, before + 3);
        assert.match(ed.document.lineAt(ed.selection.active.line).text, /class OrderService\b/);
        // The relation's subject moved too.
        assert.equal(itemById(tc, ids.relation).subject.position.line, before + 3);
      },
    ],
    [
      'task context: the stored state survives a reload (re-read from workspaceState) and resolves at once',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        const snapshot = JSON.parse(JSON.stringify(tc.store));
        await tc.reloadFromStorage();
        assert.deepEqual(JSON.parse(JSON.stringify(tc.store)), snapshot);
        assert.equal(tc.active().name, 'Checkout');
        assert.equal(tc.stateOf(ids.symbol).status, 'resolved', 'the moved place was stored: now an exact match');
      },
    ],
    [
      'task context: Move Up/Down, drop, note and Markdown (names, relative paths, notes; no code)',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        const order = () => tc.active().items.map((i) => i.id);
        await vscode.commands.executeCommand('refyntra.taskContext.moveDown', ids.symbol);
        assert.deepEqual(order().slice(0, 2), [ids.relation, ids.symbol]);
        await vscode.commands.executeCommand('refyntra.taskContext.moveUp', ids.symbol);
        assert.equal(order()[0], ids.symbol);
        await tc.dropBefore([ids.file], ids.symbol);
        assert.equal(order()[0], ids.file);
        await tc.editNote(ids.symbol, 'check the cache path');
        const md = await vscode.commands.executeCommand('refyntra.taskContext.copyMarkdown');
        assert.match(md, /^# Checkout/);
        assert.ok(md.includes('**OrderService** (class) — `Shop.Api/Services/OrderServices.cs:'), md);
        assert.ok(md.includes('> check the cache path'), md);
        assert.ok(md.includes(relationTitle), md);
        assert.ok(!md.includes('sealed') && !md.includes(root().fsPath), md);
        assert.equal(await vscode.env.clipboard.readText(), md);
      },
    ],
    [
      'task context: rename through Refyntra → resolved by name (the item follows the new name)',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        const { pos, doc } = await cursorOn(SERVICES, 'class OrderService ', 'class '.length + 2);
        const r = await a.engine.prepareRename({ uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } }, 'OrderManager');
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        const st = await resolvesTo(tc, ids.symbol, 'resolved', 'after the rename');
        assert.match(st.reason ?? '', /renamed from OrderService to OrderManager/);
        const item = itemById(tc, ids.symbol);
        assert.equal(item.target.name, 'OrderManager');
        assert.equal(item.target.qualifiedName, 'Shop.Api.Services.OrderManager');
        await resolvesTo(tc, ids.relation, 'resolved', 'relation after the rename');
        assert.equal(itemById(tc, ids.relation).subject.name, 'OrderManager');
      },
    ],
    [
      'task context: delete the class → missing (kept, with the reason); Open explains instead of opening',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        const doc = await vscode.workspace.openTextDocument(file(SERVICES));
        const lines = doc.getText().split(/\r?\n/);
        const start = lines.findIndex((l) => /class OrderManager\b/.test(l));
        let end = start;
        while (lines[end] !== '}') end++;
        const edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, new vscode.Range(start, 0, end + 1, 0));
        assert.ok(await vscode.workspace.applyEdit(edit));
        const st = await resolvesTo(tc, ids.symbol, 'missing', 'after deleting the class');
        assert.match(st.reason, /not found/);
        assert.equal(tc.active().items.length, 4, 'a missing item is kept');
        assert.match(tc.getTreeItem({ kind: 'item', item: itemById(tc, ids.symbol) }).description, /^missing/);
        await resolvesTo(tc, ids.relation, 'missing', 'relation whose subject was deleted');
        const opened = await vscode.commands.executeCommand('refyntra.taskContext.open', ids.symbol);
        assert.equal(opened, 'missing');
        assert.match(tc.lastMessage, /missing/);
        assert.match(a.taskContext.getTreeItem({ kind: 'item', item: itemById(tc, ids.find) }).contextValue, /^refyntra\.taskItem\./);
      },
    ],
    [
      'task context: export to a chosen file and import it back as a new context',
      async () => {
        const a = await ready();
        const tc = a.taskContext;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-tc-export-'));
        try {
          const target = vscode.Uri.file(path.join(dir, 'checkout.json'));
          await tc.exportTo(target);
          const text = fs.readFileSync(target.fsPath, 'utf8');
          const parsed = JSON.parse(text);
          assert.equal(parsed.format, 'refyntra.taskContext');
          assert.equal(parsed.contexts[0].items.length, 4);
          assert.ok(!text.includes('sealed class'), 'no source text in the export');
          const imported = await tc.importFrom(target);
          assert.deepEqual(imported, ['Checkout (2)']);
          assert.equal(tc.active().items.length, 4);
          await tc.resolveNow();
          const fileItem = tc.active().items.find((i) => i.kind === 'file');
          assert.equal(tc.stateOf(fileItem.id).status, 'resolved');
          await vscode.commands.executeCommand('refyntra.taskContext.switch', tc.store.contexts[0].id);
          assert.equal(tc.active().name, 'Checkout');
          tc.testHooks = { confirm: () => true };
          await vscode.commands.executeCommand('refyntra.taskContext.clear');
          assert.equal(tc.active().items.length, 0);
        } finally {
          tc.testHooks = {};
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    ],
  ];
};
