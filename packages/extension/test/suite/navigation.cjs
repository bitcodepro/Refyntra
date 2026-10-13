// Navigate To (Alt+`) and Find Usages grouped (runTest.mjs scenario "navigation") on a temp copy of the Shop fixture,
// against the real host (protocol 1.12: code/usages, code/hierarchy "bases" / "containing"). Nothing is edited.
const assert = require('node:assert/strict');

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
  ];
};
