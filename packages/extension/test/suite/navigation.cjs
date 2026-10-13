// Navigate To (Alt+`) and Find Usages grouped (runTest.mjs scenario "navigation") on a temp copy of the Shop fixture,
// against the real host (protocol 1.12: code/usages, code/hierarchy "bases" / "containing"). Nothing is edited.
const assert = require('node:assert/strict');

/** Written into the temp copy before the host loads it (runTest.mjs copyOpts): File Structure's inherited members. */
exports.extraFiles = {
  'Shop.Api/Services/Invoices.cs': [
    'namespace Shop.Api.Services;',
    '',
    'public abstract class EntityBase',
    '{',
    '    public int Id { get; protected set; }',
    '    protected void Touch() { }',
    '    public abstract string Describe();',
    '}',
    '',
    'public sealed class Invoice : EntityBase',
    '{',
    '    #region State',
    '    private decimal _amount;',
    '    public decimal Amount => _amount;',
    '    #endregion',
    '',
    '    public override string Describe() => "invoice";',
    '',
    '    public void AddLine(decimal value) => _amount += value;',
    '',
    '    public sealed class InvoiceLine',
    '    {',
    '        public string Sku { get; init; } = "";',
    '    }',
    '}',
    '',
  ].join('\n'),
};

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const SERVICES = 'Shop.Api/Services/OrderServices.cs';
  const REQUESTS = 'Shop.Contracts/Orders/OrderRequests.cs';

  async function ready() {
    const a = await api();
    await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
    assert.equal(csharp(a.health()).state, 'Ready');
    return a;
  }

  async function open(rel, needle, offset = 0) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, `${needle} in ${rel}`);
    const pos = doc.positionAt(i + offset);
    await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Selection(pos, pos) });
    return { doc, pos };
  }

  /** Runs Navigate To at the cursor and waits for its list (no sleeping). */
  async function navigateTo(a) {
    void vscode.commands.executeCommand('refyntra.navigateTo');
    await waitFor(() => a.navigateTo.state().open && a.navigateTo.state().ready, 'Navigate To list', 120000);
    return a.navigateTo.state();
  }

  const activeLine = () => {
    const ed = vscode.window.activeTextEditor;
    return ed ? ed.document.lineAt(ed.selection.active.line).text : '';
  };

  return [
    ['navigate to: a class member lists base symbols, containing type, usages and the call hierarchy with counts', async () => {
      const a = await ready();
      await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
      const st = await navigateTo(a);
      assert.equal(st.subject, 'Find');
      const byId = Object.fromEntries(st.items.map((i) => [i.id, i]));
      assert.ok(byId.bases, JSON.stringify(st.items));
      assert.equal(byId.bases.label, 'Base symbols');
      assert.equal(byId.bases.description, '1 symbol');
      assert.equal(byId.containingType.description, '1 type');
      // Only targets that exist: Find has no handler, endpoint, registration or derived members.
      for (const absent of ['handlers', 'endpoints', 'registrations', 'implementations']) assert.equal(byId[absent], undefined, absent);
      assert.equal(await a.navigateTo.accept('bases'), true);
      await waitFor(() => /OrderDto\? Find\(int id\);/.test(activeLine()), 'opened the interface member', 30000);
      // The interface member: implementations, usages and its caller (the handler).
      await open(SERVICES, 'OrderDto? Find(int id);', 'OrderDto? '.length + 1);
      const im = Object.fromEntries((await navigateTo(a)).items.map((i) => [i.id, i]));
      assert.equal(im.implementations.label, 'Implementations and overrides');
      assert.equal(im.implementations.description, '2 members');
      assert.match(im.usages.description, /^\d+ usages?$/);
      assert.equal(im.callHierarchy.description, '1 caller');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await waitFor(() => !a.navigateTo.state().open, 'list closed', 10000);
    }],
    ['navigate to: containing type opens the class; an interface lists its implementations and DI registrations', async () => {
      const a = await ready();
      await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
      await navigateTo(a);
      assert.equal(await a.navigateTo.accept('containingType'), true);
      await waitFor(() => /class OrderService : IOrderService/.test(activeLine()), 'opened OrderService', 30000);
      await open(SERVICES, 'public interface IOrderService', 'public interface '.length + 1);
      const st = await navigateTo(a);
      const byId = Object.fromEntries(st.items.map((i) => [i.id, i]));
      assert.equal(byId.implementations.label, 'Implementations');
      assert.equal(byId.implementations.description, '2 types');
      assert.match(byId.registrations.description, /^\d+ registrations?$/);
      assert.equal(byId.implementations.detail, 'opens the peek view');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await waitFor(() => !a.navigateTo.state().open, 'list closed', 10000);
    }],
    ['navigate to: a MediatR request opens its handler directly (one target)', async () => {
      const a = await ready();
      await open(REQUESTS, 'record GetOrderQuery', 'record '.length + 1);
      const st = await navigateTo(a);
      const handler = st.items.find((i) => i.id === 'handlers');
      assert.ok(handler, JSON.stringify(st.items));
      assert.match(handler.description, /^\d+ handlers?$/);
      assert.equal(await a.navigateTo.accept('handlers'), true);
      if (handler.description !== '1 handler') return; // several: the peek view opens instead
      await waitFor(() => /OrderHandlers\.cs$/.test(vscode.window.activeTextEditor?.document.fileName ?? ''), 'opened the handler file', 30000);
    }],
    ['find usages: classified usages of IOrderService grouped by kind, filters, Next / Previous, export', async () => {
      const a = await ready();
      const { doc, pos } = await open(SERVICES, 'public interface IOrderService', 'public interface '.length + 1);
      a.usages.clear();
      a.usages.setGroupings(['kind', 'file']);
      a.usages.setFilters({ kinds: [], tests: 'all' });
      await a.usages.find({ uri: doc.uri.toString(), position: { line: pos.line, character: pos.character } });
      await waitFor(() => !a.usages.state().loading && a.usages.state().sessions.length === 1, 'usages loaded', 120000);
      const st = a.usages.state();
      assert.equal(st.sessions[0].subject.replace(/^.*\./, ''), 'IOrderService');
      assert.ok(st.sessions[0].total >= 7, JSON.stringify(st.sessions));
      const groups = st.lines.filter((l) => !l.startsWith(' '));
      assert.deepEqual(groups.map((l) => l.replace(/ — \d+$/, '')), ['Inheritance / implementation', 'Type argument', 'Other reference'], st.lines.join('\n'));
      assert.match(st.lines.join('\n'), /^Inheritance \/ implementation — 2$/m);
      assert.match(st.lines.join('\n'), /^Type argument — 2$/m);
      // Filter: inheritance only; Next goes to the first one, Previous wraps to the last.
      a.usages.setFilters({ kinds: ['inheritance'], tests: 'all' });
      assert.equal(a.usages.state().sessions[0].shown, 2);
      await vscode.commands.executeCommand('refyntra.usages.next');
      await waitFor(() => /class OrderService : IOrderService/.test(activeLine()), 'first inheritance usage', 30000);
      await vscode.commands.executeCommand('refyntra.usages.next');
      await waitFor(() => /class CachedOrderService : IOrderService/.test(activeLine()), 'second inheritance usage', 30000);
      await vscode.commands.executeCommand('refyntra.usages.next');
      await waitFor(() => /class OrderService : IOrderService/.test(activeLine()), 'Next wraps to the first', 30000);
      await vscode.commands.executeCommand('refyntra.usages.previous');
      await waitFor(() => /class CachedOrderService : IOrderService/.test(activeLine()), 'Previous wraps to the last', 30000);
      // Only tests: Shop has no test project, so nothing matches and the view says so.
      a.usages.setFilters({ kinds: [], tests: 'only' });
      assert.equal(a.usages.state().sessions[0].shown, 0);
      assert.match(a.usages.state().lines.join('\n'), /No usages match the filters/);
      a.usages.setFilters({ kinds: [], tests: 'all' });
      const md = a.usages.markdown();
      assert.match(md, /^# Usages of .*IOrderService/m);
      assert.match(md, /^## Type argument \(2\)$/m);
      assert.match(md, /Program\.cs:\d+ — Type argument: `builder\.Services\.AddScoped<IOrderService, OrderService>\(\);`/);
    }],
    ['find usages: kinds of a method and a field, pinned results keep their tab, show more raises the limit', async () => {
      const a = await ready();
      a.usages.clear();
      a.usages.setGroupings(['kind']);
      const find = await open(SERVICES, 'OrderDto? Find(int id);', 'OrderDto? '.length + 1);
      await a.usages.find({ uri: find.doc.uri.toString(), position: { line: find.pos.line, character: find.pos.character } }, 1);
      await waitFor(() => !a.usages.state().loading && a.usages.state().sessions.length === 1, 'usages of Find', 120000);
      const s = a.usages.state().sessions[0];
      assert.equal(s.loaded, 1);
      assert.equal(s.truncated, s.total > 1);
      assert.match(a.usages.state().lines.join('\n'), /^Invocation — 1$/m);
      a.usages.setPinned(true);
      const field = await open(SERVICES, 'private readonly Dictionary<int, OrderDto> _orders', 'private readonly Dictionary<int, OrderDto> '.length + 1);
      await a.usages.find({ uri: field.doc.uri.toString(), position: { line: field.pos.line, character: field.pos.character } });
      await waitFor(() => !a.usages.state().loading && a.usages.state().sessions.length === 2, 'second tab', 120000);
      const st = a.usages.state();
      assert.deepEqual(st.sessions.map((x) => [x.subject.replace(/\(.*$/, '').replace(/^.*\./, ''), x.pinned, x.active]), [['_orders', false, true], ['Find', true, false]]);
      const text = st.lines.join('\n');
      // _orders.TryGetValue(…) and _orders.Count read the field; _orders[id] = … writes an element (reads the field).
      assert.match(text, /^Usages of .*_orders — \d+ · active$/m);
      assert.match(text, /^\s+Read — 3$/m);
      // A new search replaces the unpinned tab, never the pinned one.
      await a.usages.find({ uri: field.doc.uri.toString(), position: { line: field.pos.line, character: field.pos.character } });
      await waitFor(() => !a.usages.state().loading, 'third search', 120000);
      assert.equal(a.usages.state().sessions.length, 2);
      a.usages.clear();
      assert.equal(a.usages.state().sessions.length, 0);
    }],
    ['recent files: most recent first with the current file second, open editors listed, remove, persisted per workspace', async () => {
      const a = await ready();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const req = await open(REQUESTS, 'record GetOrderQuery');
      const svc = await open(SERVICES, 'public interface IOrderService');
      await waitFor(() => a.recent.recentFiles()[0] === svc.doc.uri.toString(), 'Services recorded first', 10000);
      void vscode.commands.executeCommand('refyntra.recentFiles');
      await waitFor(() => a.recent.state().open && a.recent.state().ready && a.recent.state().kind === 'files', 'Recent Files list', 10000);
      const ids = a.recent.state().items.map((i) => i.id);
      assert.deepEqual(ids.slice(0, 2), [req.doc.uri.toString(), svc.doc.uri.toString()], ids.join('\n'));
      assert.equal(a.recent.state().items[1].label, 'OrderServices.cs');
      assert.equal(a.recent.state().items[1].description, 'Shop.Api/Services');
      // Enter on the first row switches back to the previous file.
      assert.equal(await a.recent.accept(ids[0]), true);
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === req.doc.uri.toString(), 'switched back', 10000);
      // A modified file says so; the remove button drops a row; the list survives a reload (workspaceState).
      const ed = vscode.window.activeTextEditor;
      await ed.edit((e) => e.insert(new vscode.Position(0, 0), '// recent files\n'));
      void vscode.commands.executeCommand('refyntra.recentFiles');
      await waitFor(() => a.recent.state().open && a.recent.state().kind === 'files' && a.recent.state().items.some((i) => i.description.startsWith('modified')), 'modified marker', 10000);
      assert.equal(a.recent.state().items.find((i) => i.description.startsWith('modified')).id, req.doc.uri.toString());
      assert.equal(a.recent.removeItem(svc.doc.uri.toString()), true);
      assert.equal(a.recent.recentFiles().includes(svc.doc.uri.toString()), false);
      // Still open in an editor: the list keeps showing it (open editors are always listed).
      assert.ok(a.recent.state().items.some((i) => i.id === svc.doc.uri.toString()));
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await waitFor(() => !a.recent.state().open, 'list closed', 10000);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      // No editor left: a pending resting-cursor timer records nothing, so the stored value is final after flush().
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await a.recent.flush();
      const before = a.recent.recentFiles();
      a.recent.reload();
      assert.deepEqual(a.recent.recentFiles(), before);
    }],
    ['recent locations: resting cursor and edits with member and code line, re-anchored, deleted line dropped, edited-only, persisted', async () => {
      const a = await ready();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const { doc, pos } = await open(SERVICES, 'public OrderDto? Find(int id) => _orders', 'public OrderDto? '.length + 1);
      const uri = doc.uri.toString();
      const at = (line, kind) => a.recent.recentLocations().find((l) => l.uri === uri && l.line === line && (!kind || l.kind === kind));
      await waitFor(() => at(pos.line, 'visited'), 'the resting cursor is recorded', 15000);
      const ed = vscode.window.activeTextEditor;
      const createLine = doc.getText().split(/\r?\n/).findIndex((t) => t.includes('_orders[id] = new OrderDto'));
      await ed.edit((e) => e.insert(new vscode.Position(createLine, doc.lineAt(createLine).text.length), ' // edited'));
      await waitFor(() => at(createLine, 'edited'), 'the edit is recorded', 10000);
      assert.match(at(createLine).lineText, /_orders\[id\] = new OrderDto\(id, customer, total\); \/\/ edited/);
      // Two lines inserted at the top: both locations move down by two.
      await ed.edit((e) => e.insert(new vscode.Position(0, 0), '// a\n// b\n'));
      await waitFor(() => at(pos.line + 2, 'visited') && at(createLine + 2, 'edited'), 're-anchored', 10000);
      void vscode.commands.executeCommand('refyntra.recentLocations');
      await waitFor(() => a.recent.state().open && a.recent.state().ready && a.recent.state().kind === 'locations', 'Recent Locations list', 15000);
      const st = a.recent.state();
      const edited = st.items.find((i) => i.id === `${uri}#${createLine + 2}`);
      assert.equal(edited.section, 'Edited');
      assert.equal(edited.label, `OrderServices.cs:${createLine + 3}`);
      assert.equal(edited.description, 'OrderService.Create');
      assert.match(edited.detail, /\/\/ edited$/);
      const visited = st.items.find((i) => i.id === `${uri}#${pos.line + 2}`);
      assert.equal(visited.section, 'Visited');
      assert.equal(visited.description, 'OrderService.Find');
      assert.match(visited.detail, /^public OrderDto\? Find\(int id\) =>/);
      // Edited only: the visited rows go; again: back.
      a.recent.toggleEditedOnly();
      await waitFor(() => a.recent.state().ready && a.recent.state().mode === 'edited', 'edited only', 10000);
      assert.ok(a.recent.state().items.every((i) => i.section === 'Edited'));
      a.recent.toggleEditedOnly();
      await waitFor(() => a.recent.state().ready && a.recent.state().items.some((i) => i.section === 'Visited'), 'all again', 10000);
      // Enter opens the location.
      assert.equal(await a.recent.accept(visited.id), true);
      await waitFor(() => /public OrderDto\? Find\(int id\) =>/.test(activeLine()) && vscode.window.activeTextEditor.selection.active.line === pos.line + 2, 'opened the visited location', 10000);
      // The visited line deleted: its location is dropped.
      await vscode.window.activeTextEditor.edit((e) => e.delete(new vscode.Range(pos.line + 2, 0, pos.line + 3, 0)));
      await waitFor(() => !a.recent.recentLocations().some((l) => l.uri === uri && /Find\(int id\) => _orders/.test(l.lineText)), 'deleted line dropped', 10000);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      // No editor left: a pending resting-cursor timer records nothing, so the stored value is final after flush().
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await a.recent.flush();
      const before = a.recent.recentLocations();
      a.recent.reload();
      assert.deepEqual(a.recent.recentLocations(), before);
    }],
    ['file structure: C# members by type and #region from the host, filters, camel humps, inherited members, Enter jumps', async () => {
      const a = await ready();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await open('Shop.Api/Services/Invoices.cs', 'public void AddLine', 'public void '.length + 1);
      void vscode.commands.executeCommand('refyntra.fileStructure');
      await waitFor(() => a.fileStructure.state().open && a.fileStructure.state().ready, 'File Structure list', 120000);
      // Defaults (stored filters of an earlier case would change the rows).
      for (const f of ['methods', 'properties', 'fields', 'events', 'nestedTypes']) await a.fileStructure.setFilter(f, true);
      await a.fileStructure.setFilter('inherited', false);
      let st = a.fileStructure.state();
      assert.equal(st.source, 'host');
      const rows = st.items.map((i) => `${i.section} | ${i.label} | ${i.description}`);
      assert.deepEqual(rows, [
        'EntityBase | EntityBase | class · public',
        'EntityBase | Id : int | property · public',
        'EntityBase | Touch() : void | method · protected',
        'EntityBase | Describe() : string | method · public',
        'Invoice : EntityBase | Invoice | class · public',
        'Invoice · #region State | _amount : decimal | field · private',
        'Invoice · #region State | Amount : decimal | property · public',
        'Invoice | Describe() : string | method · public',
        'Invoice | AddLine(decimal) : void | method · public',
        'Invoice.InvoiceLine | Invoice.InvoiceLine | class · public',
        'Invoice.InvoiceLine | Sku : string | property · public',
      ], rows.join('\n'));
      // Filters: no methods, no nested types.
      await a.fileStructure.setFilter('methods', false);
      await a.fileStructure.setFilter('nestedTypes', false);
      st = a.fileStructure.state();
      assert.deepEqual(st.items.map((i) => i.label), ['EntityBase', 'Id : int', 'Invoice', '_amount : decimal', 'Amount : decimal']);
      assert.match(st.title, /hidden: methods, nested types/);
      await a.fileStructure.setFilter('methods', true);
      await a.fileStructure.setFilter('nestedTypes', true);
      // Inherited members: from EntityBase, without the overridden Describe.
      await a.fileStructure.setFilter('inherited', true);
      await waitFor(() => a.fileStructure.state().ready && a.fileStructure.state().items.some((i) => i.section.includes('inherited')), 'inherited members', 60000);
      const inherited = a.fileStructure.state().items.filter((i) => i.section === 'Invoice · inherited from EntityBase');
      assert.deepEqual(inherited.map((i) => [i.label, i.navigable]), [['Id : int', true], ['Touch() : void', true]]);
      // Camel humps: "aL" finds AddLine only.
      a.fileStructure.setQuery('aL');
      await waitFor(() => a.fileStructure.state().ready && a.fileStructure.state().items.length === 1, 'filtered by camel humps', 10000);
      assert.equal(a.fileStructure.state().items[0].label, 'AddLine(decimal) : void');
      a.fileStructure.setQuery('');
      await waitFor(() => a.fileStructure.state().ready && a.fileStructure.state().items.length > 5, 'query cleared', 10000);
      // Enter on an inherited member opens its declaration.
      const touch = a.fileStructure.state().items.find((i) => i.section === 'Invoice · inherited from EntityBase' && i.label === 'Touch() : void');
      assert.equal(await a.fileStructure.accept(touch.id), true);
      await waitFor(() => /protected void Touch\(\)/.test(activeLine()) && !a.fileStructure.state().open, 'jumped to the inherited member', 10000);
      await a.fileStructure.setFilter('inherited', false);
      // A new list starts at the member at the cursor; Enter on an own member moves the cursor.
      await open('Shop.Api/Services/Invoices.cs', 'public void AddLine', 'public void '.length + 1);
      void vscode.commands.executeCommand('refyntra.fileStructure');
      await waitFor(() => a.fileStructure.state().open && a.fileStructure.state().ready, 'File Structure again', 60000);
      assert.match(a.fileStructure.state().activeId, /^Invoice\.AddLine@/);
      const amount = a.fileStructure.state().items.find((i) => i.label === 'Amount : decimal');
      assert.equal(await a.fileStructure.accept(amount.id), true);
      await waitFor(() => /public decimal Amount =>/.test(activeLine()) && !a.fileStructure.state().open, 'jumped to Amount', 10000);
    }],
    ['file structure: other languages use the document symbols (no host call)', async () => {
      const a = await api();
      // Built-in language extensions are off in this scenario: the test brings its own document symbol provider.
      const R = (l) => new vscode.Range(l, 0, l, 5);
      const provider = vscode.languages.registerDocumentSymbolProvider({ language: 'plaintext' }, {
        provideDocumentSymbols: () => {
          const store = new vscode.DocumentSymbol('Store', '', vscode.SymbolKind.Class, new vscode.Range(0, 0, 4, 1), R(0));
          store.children = [new vscode.DocumentSymbol('get', '(id)', vscode.SymbolKind.Method, R(1), R(1)), new vscode.DocumentSymbol('items', '', vscode.SymbolKind.Field, R(2), R(2))];
          return [store, new vscode.DocumentSymbol('load', '()', vscode.SymbolKind.Function, R(6), R(6))];
        },
      });
      try {
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'class Store {\n  get(id) {}\n  items = 1;\n\n}\n\nfunction load() {}\n' });
        await vscode.window.showTextDocument(doc);
        void vscode.commands.executeCommand('refyntra.fileStructure');
        await waitFor(() => a.fileStructure.state().open && a.fileStructure.state().ready, 'File Structure (symbols)', 30000);
        const st = a.fileStructure.state();
        assert.equal(st.source, 'symbols');
        const file = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
        assert.deepEqual(st.items.map((i) => `${i.section} | ${i.label} | ${i.description}`), ['Store | Store | class', 'Store | get(id) | method', 'Store | items | field', `${file} | load() | method`]);
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await waitFor(() => !a.fileStructure.state().open, 'list closed', 10000);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      } finally {
        provider.dispose();
      }
    }],
  ];
};
