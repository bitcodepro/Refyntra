// Frontend ↔ backend HTTP links (heuristic) e2e on a temp copy of tests/fixtures/FullStack (runTest.mjs scenario
// "full-stack"): Related from a fetch/axios line shows the endpoint and its handler; Related on an action or a
// Minimal API handler shows the Clients group; Find client: lists the unlinked calls. Read-only.
const assert = require('node:assert/strict');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri;
  const file = (rel) => vscode.Uri.joinPath(root(), ...rel.split('/'));
  const all = (view) => view.groups.flatMap((g) => g.relations);
  const sameUri = (a, b) => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();

  async function ready() {
    const a = await api();
    await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
    const h = csharp(a.health());
    assert.equal(h.state, 'Ready', `${h.reasonCode}: ${h.message}`);
    return a;
  }

  async function at(rel, needle, offset = 0) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return { doc, target: { uri: doc.uri.toString(), position: doc.positionAt(i + offset) } };
  }

  /** Related, retried while the TS/JS providers warm up (the first answers may still be empty). */
  async function related(a, target, ok) {
    let last;
    await waitFor(async () => {
      last = await a.engine.related(target);
      return last.kind === 'related' && ok(last);
    }, 'Related with HTTP links', 120000).catch(() => assert.fail(JSON.stringify(last && (last.kind === 'related' ? last.groups.map((g) => [g.group, g.relations.map((r) => r.relationKind + ' ' + r.target.label)]) : last))));
    return last;
  }

  return [
    [
      'FullStack loads',
      async () => {
        await ready();
      },
    ],
    [
      'Related on a fetch call shows the MVC endpoint and, through it, the action (heuristic)',
      async () => {
        const a = await ready();
        const { target } = await at('web/src/api.ts', 'fetch(`${API}/orders/${id}`)', 1);
        const view = await related(a, target, (v) => all(v).some((r) => r.relationKind === 'http.handler'));
        const call = all(view).find((r) => r.relationKind === 'http.call');
        assert.equal(call.group, 'endpoints');
        assert.equal(call.target.endpoint.route, '/api/Orders/{id:int}');
        assert.equal(call.confidence, 'heuristic');
        assert.equal(call.provenances[0].kind, 'heuristic');
        assert.match(call.limitations[0], /^Heuristic/);
        const handler = all(view).find((r) => r.relationKind === 'http.handler');
        assert.equal(handler.group, 'handlers');
        assert.equal(handler.target.symbol.name, 'GetOrder');
        assert.ok(handler.target.symbol.location.uri.endsWith('OrdersController.cs'));
      },
    ],
    [
      'Related inside the URL string of a concatenated call links the POST action; axios links a Minimal API handler',
      async () => {
        const a = await ready();
        const cancel = await related(a, (await at('web/src/api.ts', "'/cancel'", 2)).target, (v) => all(v).some((r) => r.relationKind === 'http.handler'));
        assert.deepEqual(all(cancel).filter((r) => r.relationKind === 'http.handler').map((r) => r.target.symbol.name), ['Cancel']);
        const list = await related(a, (await at('web/src/api.ts', "axios.get('/api/products')", 1)).target, (v) => all(v).some((r) => r.relationKind === 'http.handler'));
        assert.deepEqual(all(list).filter((r) => r.relationKind === 'http.handler').map((r) => r.target.symbol.name), ['List']);
        assert.equal(all(list).find((r) => r.relationKind === 'http.call').target.endpoint.kind, 'minimal-api');
      },
    ],
    [
      'An ambiguous call lists both candidates (cursor in the URL); a call to another host or an unknown route is not linked',
      async () => {
        const a = await ready();
        const tag = await related(a, (await at('web/src/api.ts', '`/api/tags/${name}`', 3)).target, (v) => all(v).filter((r) => r.relationKind === 'http.call').length === 2);
        const calls = all(tag).filter((r) => r.relationKind === 'http.call');
        assert.ok(calls.every((r) => r.target.label.endsWith('(ambiguous)') && r.limitations.some((l) => l.startsWith('Ambiguous'))), JSON.stringify(calls.map((c) => c.target.label)));
        for (const needle of ["fetch('https://example.com", "fetch('/api/reports/legacy')"]) {
          const r = await a.engine.related((await at('web/src/api.ts', needle, needle.length - 3)).target);
          if (r.kind === 'related') assert.ok(!all(r).some((x) => x.relationKind.startsWith('http.')), needle);
        }
      },
    ],
    [
      'Related on an MVC action and on a Minimal API handler shows the Clients group with the call sites',
      async () => {
        const a = await ready();
        const api = file('web/src/api.ts').toString();
        const action = await related(a, (await at('FullStack.Api/Controllers/OrdersController.cs', 'GetOrder(int id)')).target, (v) => v.groups.some((g) => g.group === 'clients'));
        const clients = action.groups.find((g) => g.group === 'clients').relations;
        assert.equal(clients.length, 1, JSON.stringify(clients.map((c) => c.target.label)));
        assert.ok(sameUri(clients[0].target.location.uri, api));
        const doc = await vscode.workspace.openTextDocument(file('web/src/api.ts'));
        assert.match(doc.lineAt(clients[0].target.location.range.start.line).text, /fetch\(`\$\{API\}\/orders\/\$\{id\}`\)/);
        assert.equal(clients[0].confidence, 'heuristic');
        const handler = await related(a, (await at('FullStack.Api/Products/ProductHandlers.cs', 'IResult Create(', 'IResult '.length)).target, (v) => v.groups.some((g) => g.group === 'clients'));
        const c2 = handler.groups.find((g) => g.group === 'clients').relations;
        assert.deepEqual(c2.map((r) => doc.lineAt(r.target.location.range.start.line).text.trim()), ["return axios.post('/api/products', { name });"]);
      },
    ],
    [
      'The Related view shows the Clients group with accessible labels',
      async () => {
        const a = await ready();
        const { doc, target } = await at('FullStack.Api/Controllers/OrdersController.cs', 'Cancel(int id)');
        const ed = await vscode.window.showTextDocument(doc);
        ed.selection = new vscode.Selection(target.position, target.position);
        await vscode.commands.executeCommand('refyntra.related');
        await waitFor(() => !a.related.state.loading && a.related.current() && a.related.getChildren().some((n) => n.kind === 'group' && n.title === 'Clients'), 'Clients group in the Related view', 120000);
        const group = a.related.getChildren().find((n) => n.kind === 'group' && n.title === 'Clients');
        assert.equal(a.related.getTreeItem(group).accessibilityInformation.label, 'Clients, 1 item');
        const [child] = a.related.getChildren(group);
        const label = a.related.getTreeItem(child).accessibilityInformation.label;
        assert.match(label, /^Client call POST \/api\/orders\/\{id\}\/cancel — api\.ts:\d+, .*heuristic\. Limitations: Heuristic/);
      },
    ],
    [
      'Find client: lists the unlinked calls with the reason; client:all lists every call; edits on save update the index',
      async () => {
        const a = await ready();
        const r = await a.engine.find('client:');
        const labels = r.items.map((i) => `${i.label} | ${i.description}`);
        assert.ok(labels.includes('GET /api/reports/legacy | Client call (heuristic) · no matching route'), labels.join('\n'));
        assert.ok(labels.includes('GET https://example.com/api/orders/1 | Client call (heuristic) · another host'), labels.join('\n'));
        assert.ok(labels.some((l) => l.startsWith('GET /api/tags/{name} | ') && l.endsWith('ambiguous')), labels.join('\n'));
        assert.ok(!labels.some((l) => l.includes('/api/products')), labels.join('\n'));
        const everything = await a.engine.find('client:all');
        assert.equal(everything.items.length, 8, everything.items.map((i) => i.label).join('\n'));
        // A new file on disk is picked up by the watcher; files under node_modules are never scanned.
        await vscode.workspace.fs.writeFile(file('web/node_modules/lib/index.js'), Buffer.from("fetch('/api/never-scanned');\n"));
        await vscode.workspace.fs.writeFile(file('web/src/extra.ts'), Buffer.from("export const extra = () => fetch('/api/extra/one');\n"));
        await waitFor(async () => (await a.engine.find('client: extra')).items.length === 1, 'new file indexed', 30000);
        assert.equal((await a.engine.find('client: never-scanned')).items.length, 0);
      },
    ],
  ];
};
