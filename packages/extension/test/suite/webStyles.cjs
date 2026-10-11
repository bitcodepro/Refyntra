// HTML/CSS/SCSS/LESS ↔ code links e2e on a temp copy of tests/fixtures/WebStyles (runTest.mjs scenario "web-styles"),
// in a VS Code with every extension disabled (also the built-in CSS/HTML/TypeScript language features): Refyntra's
// bundled CSS and HTML language services answer on their own. Read-only.
const assert = require('node:assert/strict');

exports.cases = ({ api, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri;
  const file = (rel) => vscode.Uri.joinPath(root(), ...rel.split('/'));
  const all = (view) => view.groups.flatMap((g) => g.relations);
  const tail = (uri) => decodeURIComponent(uri).replace(/\\/g, '/').split('/').slice(-2).join('/');

  async function at(rel, needle, offset = 0) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, `${needle} in ${rel}`);
    return { uri: doc.uri.toString(), position: doc.positionAt(i + offset) };
  }

  /** Related, retried while the first workspace scan runs. */
  async function related(a, target, ok) {
    let last;
    await waitFor(async () => {
      last = await a.engine.related(target);
      return last.kind === 'related' && ok(last);
    }, 'Related with HTML/CSS links', 60000).catch(() => assert.fail(JSON.stringify(last && (last.kind === 'related' ? last.groups.map((g) => [g.group, g.relations.map((r) => r.relationKind + ' ' + r.target.label)]) : last))));
    return last;
  }

  return [
    [
      'No other extension runs; the HTML/CSS route is ready',
      async () => {
        const a = await api();
        const others = vscode.extensions.all.filter((e) => e.id !== 'refyntra.refyntra' && e.isActive);
        // --disable-extensions leaves only VS Code's own non-language parts; no CSS/HTML/TypeScript language feature runs.
        const languageFeatures = others.filter((e) => /(css|html|typescript|json)-language-features/.test(e.id) || !e.id.startsWith('vscode.'));
        assert.deepEqual(languageFeatures.map((e) => e.id), [], `active: ${others.map((e) => e.id).join(', ')}`);
        const web = a.health().adapters.find((h) => h.providerRouteId === 'web.styles');
        assert.equal(web.state, 'Ready');
      },
    ],
    [
      'Related from styles.root (CSS Modules) shows the .root rule of the imported module (proven)',
      async () => {
        const a = await api();
        const view = await related(a, await at('react/Button.tsx', 'styles.root', 8), (v) => all(v).some((r) => r.relationKind === 'css.moduleClass'));
        const rule = all(view).find((r) => r.relationKind === 'css.moduleClass');
        assert.equal(rule.group, 'styles');
        assert.equal(rule.confidence, 'proven');
        assert.equal(tail(rule.target.location.uri), 'react/Button.module.css');
        assert.equal(rule.target.location.range.start.line, 0);
      },
    ],
    [
      'Related from the .root rule lists its users (Used by), and the file view lists possibly unused selectors',
      async () => {
        const a = await api();
        const view = await related(a, await at('react/Button.module.css', '.root', 2), (v) => all(v).some((r) => r.relationKind === 'css.moduleUse'));
        assert.equal(view.subject.displayName, '.root');
        const users = all(view).filter((r) => r.relationKind === 'css.moduleUse');
        assert.deepEqual(users.map((r) => [r.group, r.confidence, tail(r.target.location.uri)]), [['usedBy', 'proven', 'react/Button.tsx']]);
        const fileView = await related(a, await at('react/Button.module.css', '}', 1), (v) => v.groups.some((g) => g.group === 'unused'));
        const unused = fileView.groups.find((g) => g.group === 'unused').relations;
        assert.deepEqual(unused.map((r) => r.target.label), ['.unusedModule — Button.module.css:9, may be used dynamically']);
        assert.ok(unused[0].limitations[0].startsWith('Information only'));
      },
    ],
    [
      'Related from a class in HTML shows the rule of the linked stylesheet, labelled heuristic',
      async () => {
        const a = await api();
        const view = await related(a, await at('plain/index.html', 'class="card', 8), (v) => all(v).some((r) => r.relationKind === 'css.rule'));
        const rules = all(view).filter((r) => r.relationKind === 'css.rule');
        assert.ok(rules.length >= 1);
        assert.ok(rules.every((r) => r.group === 'styles' && r.confidence === 'heuristic' && r.provenances[0].kind === 'heuristic' && tail(r.target.location.uri) === 'css/site.css'));
        assert.match(rules[0].limitations[0], /^Heuristic/);
      },
    ],
    [
      'Actions on a CSS class explain that Rename CSS class is unavailable; Find css: lists selectors',
      async () => {
        const a = await api();
        const actions = await a.engine.actions(await at('plain/css/site.css', '.card', 2));
        const rename = actions.items.find((i) => i.capabilityId === 'css.renameClass');
        assert.equal(rename.state, 'unavailable');
        assert.match(rename.message, /Rename CSS class: unavailable — class names in strings can't be proven/);
        assert.equal(a.capabilityUi('css.renameClass').title, 'Rename CSS class');
        const found = await a.engine.find('css:card');
        assert.ok(found.items.some((i) => i.kind === 'style' && i.label === '.card'), JSON.stringify(found));
      },
    ],
  ];
};
