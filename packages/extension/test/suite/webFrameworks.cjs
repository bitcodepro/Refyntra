// React / Next.js / Angular e2e on temp copies of tests/fixtures/Web{React,Next,Angular,AngularOld} (runTest.mjs
// scenario "web-frameworks"), in a VS Code with every extension disabled (also VS Code's built-in TypeScript
// features): Refyntra's own web worker (bundled TypeScript + Angular language service) answers alone. Read-only.
const assert = require('node:assert/strict');

function helpers({ api, waitFor }) {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri;
  const file = (rel) => vscode.Uri.joinPath(root(), ...rel.split('/'));
  const all = (view) => (view.kind === 'related' ? view.groups.flatMap((g) => g.relations) : []);
  const dump = (v) => JSON.stringify(v && (v.kind === 'related' ? v.groups.map((g) => [g.group, g.relations.map((r) => `${r.relationKind} ${r.target.label}`)]) : v));
  async function at(rel, needle, offset = 1) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return { uri: doc.uri.toString(), position: doc.positionAt(i + offset) };
  }
  async function related(target, ok, what) {
    const a = await api();
    let last;
    await waitFor(async () => {
      last = await a.engine.related(target);
      return ok(all(last), last);
    }, what, 90000).catch(() => assert.fail(`${what}: ${dump(last)}`));
    return all(last);
  }
  return { vscode, api, at, related, file };
}

exports.cases = (deps) => {
  const { vscode, api, at, related } = helpers(deps);
  return [
    [
      'No other extension runs; the worker starts lazily on the bundled TypeScript with a heap limit',
      async () => {
        const a = await api();
        const others = vscode.extensions.all.filter((e) => e.id !== 'refyntra.refyntra' && e.isActive && (!e.id.startsWith('vscode.') || /language-features/.test(e.id)));
        assert.deepEqual(others.map((e) => e.id), []);
        assert.equal(a.webFrameworks.launches().length, 0, 'not started before a request');
        await related(await at('WebReact/src/App.tsx', '<Button label="Save"', 2), (rs) => rs.some((r) => r.relationKind === 'react.component'), 'first Related');
        const l = a.webFrameworks.launches();
        assert.equal(l.length, 1);
        assert.ok(l[0].args.some((x) => /^--max-old-space-size=\d+$/.test(x)));
        assert.ok(l[0].args.some((x) => /webWorker\.js$/.test(x)));
        const st = a.webFrameworks.status();
        assert.equal(st.typescriptVersion, '6.0.3');
        assert.equal(st.angularLanguageServiceVersion, '22.2.1');
      },
    ],
    [
      'React: component usages and props are proven; missing required prop is information only',
      async () => {
        const rs = await related(await at('WebReact/src/components/Button.tsx', 'function Button', 10), (x) => x.some((r) => r.relationKind === 'react.usage'), 'Button relations');
        const usages = rs.filter((r) => r.relationKind === 'react.usage');
        assert.equal(usages.length, 2);
        assert.ok(usages.every((r) => r.confidence === 'proven' && r.provenance.providerRouteId === 'web.frameworks'));
        assert.ok(usages.some((r) => r.limitations.includes('Information: required props not passed here: size.')));
        assert.deepEqual(rs.filter((r) => r.relationKind === 'react.prop').map((r) => r.target.label.split(':')[0]).sort(), ['label', 'onClick?', 'size', 'variant?']);
        const diags = vscode.languages.getDiagnostics().filter(([, d]) => d.some((x) => x.source === 'refyntra' && /prop/i.test(x.message)));
        assert.deepEqual(diags, [], 'no Problems entries for props');
      },
    ],
    [
      'Next.js: a dynamic route with its Link client; route limitations named',
      async () => {
        const rs = await related(await at('WebNext/app/(shop)/orders/[id]/page.tsx', 'export default'), (x) => x.some((r) => r.relationKind === 'next.link'), 'Next route');
        const route = rs.find((r) => r.relationKind === 'next.route');
        assert.equal(route.target.endpoint.route, '/orders/[id]');
        assert.equal(route.target.endpoint.kind, 'next-page');
        assert.ok(route.limitations.some((l) => /middleware\.ts/.test(l)));
        assert.equal(rs.find((r) => r.relationKind === 'next.link').group, 'clients');
      },
    ],
    [
      'Angular: template element (inline) and the template file resolve through the Angular language service',
      async () => {
        const el = await related(await at('WebAngular/src/app/orders/order-list.component.ts', '<app-order-card', 3), (x) => x.some((r) => r.relationKind === 'angular.selectorTarget'), 'selector');
        assert.equal(el.find((r) => r.relationKind === 'angular.selectorTarget').confidence, 'proven');
        const html = await related(await at('WebAngular/src/app/orders/order-card.component.html', 'title'), (x) => x.some((r) => r.relationKind === 'angular.templateOwner'), 'template owner');
        assert.ok(html.some((r) => r.relationKind === 'angular.input' && r.target.label === 'OrderCardComponent.title (input)'));
      },
    ],
    [
      'Angular 12 project is refused with a reason',
      async () => {
        const a = await api();
        const view = await a.engine.related(await at('WebAngularOld/src/legacy.component.ts', 'class LegacyComponent', 7));
        const notes = view.kind === 'related' ? view.scopeNotes.join(' ') : view.message ?? '';
        assert.match(notes, /Angular 12 is older/);
      },
    ],
    [
      'Find component: and page:',
      async () => {
        const a = await api();
        const c = await a.engine.find('component:Order');
        assert.deepEqual(c.items.map((i) => i.label).sort(), ['Order', 'OrderCardComponent', 'OrderListComponent', 'Orders']);
        const p = await a.engine.find('page:orders');
        const labels = p.items.map((i) => i.label);
        assert.ok(labels.includes('/orders/[id] (dynamic)') && labels.includes('/orders/:id'), labels.join(', '));
        assert.ok(p.notes.some((n) => /middleware, rewrites/.test(n)));
      },
    ],
    [
      'Unsaved edits are seen: a new usage typed in the editor shows up',
      async () => {
        const doc = await vscode.workspace.openTextDocument(require('vscode').Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'WebReact', 'src', 'App.tsx'));
        const editor = await vscode.window.showTextDocument(doc);
        const pos = doc.positionAt(doc.getText().indexOf('<Badge'));
        await editor.edit((e) => e.insert(pos, '<Card title="typed" />\n      '));
        const rs = await related(await at('WebReact/src/components/Card.tsx', 'class Card', 7), (x) => x.filter((r) => r.relationKind === 'react.usage').length === 2, 'typed usage');
        assert.equal(rs.filter((r) => r.relationKind === 'react.usage').length, 2);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      },
    ],
  ];
};

exports.restricted = (deps) => {
  const { at, api } = helpers(deps);
  return [
    [
      'Restricted Mode: the web worker is never started; Related says why',
      async () => {
        const a = await api();
        const view = await a.engine.related(await at('WebReact/src/components/Button.tsx', 'function Button', 10));
        const text = view.kind === 'related' ? view.scopeNotes.join(' ') : `${view.reasonCode} ${view.message}`;
        assert.equal(a.webFrameworks.launches().length, 0, text);
        const f = await a.engine.find('component:Button');
        assert.deepEqual(f.items, []);
        assert.ok(f.notes.some((n) => /Restricted Mode/.test(n)), f.notes.join(' | '));
        assert.equal(a.webFrameworks.launches().length, 0);
      },
    ],
  ];
};
