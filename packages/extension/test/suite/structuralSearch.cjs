// Structural Search and Replace e2e (runTest.mjs scenario "structural-search") on a temp copy of
// tests/fixtures/StructuralSearch; the repository fixture is never touched. The panel searches with a type-constrained
// placeholder (protocol 1.19, code/structuralSearch), Replace all goes through the editor's Refactor Preview and is
// undone, and a saved pattern marked "show as inspection" becomes a diagnostic with a quick fix.
const assert = require('node:assert/strict');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const root = () => vscode.workspace.workspaceFolders[0].uri;
  const file = (rel) => vscode.Uri.joinPath(root(), 'Ssr.App', ...rel.split('/'));
  const codeOf = (d) => (typeof d.code === 'object' ? d.code.value : d.code);
  const refyntra = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Refyntra');

  async function revertAll() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  /** Confirms the editor's Refactor Preview once it is open; resolves with the apply outcome. */
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

  async function open(rel) {
    const doc = await vscode.workspace.openTextDocument(file(rel));
    await vscode.window.showTextDocument(doc);
    return doc;
  }

  return [
    [
      'the StructuralSearch fixture loads',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
      },
    ],
    [
      'the panel searches the solution with a type-constrained placeholder; the results view lists the matches',
      async () => {
        const a = await api();
        const ss = a.structuralSearch;
        await ss.open({ text: '$x$.Result', replacement: '', placeholders: [{ name: 'x', kind: 'expression', type: 'System.Threading.Tasks.Task' }], scope: 'solution' });
        await waitFor(() => ss.view(), 'panel open', 10000);
        const r = await ss.search();
        assert.ok(r, 'a result');
        assert.equal(r.patternKind, 'expression');
        // Tasks.cs: Sync, Nested, Parens, InAsync — not Box.Result (an int field).
        assert.deepEqual(r.matches.map((m) => `${m.uri.split('/').pop()}:${m.range.start.line + 1}`), ['Tasks.cs:12', 'Tasks.cs:13', 'Tasks.cs:14', 'Tasks.cs:20']);
        assert.equal(ss.view().headline, '4 matches in 1 file.');
        const state = ss.results.state();
        assert.equal(state.total, 4);
        assert.deepEqual(state.files.map((f) => f.count), [4]);
        // The page message path: the placeholder table follows the pattern text.
        await ss.dispatch({ type: 'change', editor: { text: '$a$ + $a$', replacement: '', placeholders: [], scope: 'solution' } });
        assert.deepEqual(ss.view().editor.placeholders, [{ name: 'a', kind: 'any' }]);
        const twice = await ss.search();
        assert.deepEqual(twice.matches.map((m) => m.lineText.trim()), ['public bool F(int x, int y) => x + x > y + x; // m: twice']);
      },
    ],
    [
      'Replace all goes through the Refactor Preview, is compile-checked and Undo restores the file',
      async () => {
        const a = await api();
        const ss = a.structuralSearch;
        const doc = await open('Cases/Strings.cs');
        const before = doc.getText();
        await ss.open({ text: '$s$ == null || $s$ == ""', replacement: 'string.IsNullOrEmpty($s$)', placeholders: [], scope: 'solution' });
        const r = await ss.prepareReplace();
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        assert.equal(r.plan.actionId, 'csharp.structuralReplace');
        assert.equal(r.plan.writeSet.length, 1);
        const out = await throughPreview(a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: structural replace' } }), 'refactorPreview.apply');
        assert.equal(out.status, 'applied', out.message);
        const text = doc.getText();
        assert.ok(text.includes('public bool A(string? s) => string.IsNullOrEmpty(s); // m: empty'), text);
        assert.ok(text.includes('public bool D() => string.IsNullOrEmpty(_name); // m: empty'), text);
        assert.ok(text.includes('s == null || t == ""'), 'different placeholders stay');
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(undone.filter((m) => m.endsWith('edit undone.')).length, 1, undone.join(' '));
        assert.equal(doc.getText(), before);
        // Replacements that would not compile are refused and listed (await in methods that are not async).
        await ss.open({ text: '$x$.Result', replacement: 'await $x$', placeholders: [{ name: 'x', type: 'System.Threading.Tasks.Task' }], scope: 'solution' });
        const tasks = await ss.prepareReplace();
        assert.equal(tasks.kind, 'preview', JSON.stringify(tasks));
        assert.ok(tasks.plan.limitations.some((l) => l.includes('3 match(es) not replaced') && l.includes('Tasks.cs:12')), tasks.plan.limitations.join(' | '));
        a.engine.discardPlan(tasks.planId);
        await revertAll();
      },
    ],
    [
      'a saved pattern shown as inspection is a diagnostic with a quick fix; deleting it removes the diagnostics',
      async () => {
        const a = await api();
        const ss = a.structuralSearch;
        await ss.store.save({
          id: 'workspace.empty-string',
          name: 'empty-string',
          text: '$s$ == null || $s$ == ""',
          replacement: 'string.IsNullOrEmpty($s$)',
          placeholders: [{ name: 's', kind: 'expression' }],
          origin: 'workspace',
          inspection: { enabled: true, severity: 'information' },
        });
        const saved = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root(), '.refyntra', 'patterns.json'))));
        assert.equal(saved.patterns[0].name, 'empty-string');
        const doc = await open('Cases/Strings.cs');
        const list = await waitFor(() => {
          const d = refyntra(doc.uri).filter((x) => codeOf(x) === 'ORS-empty-string');
          return d.length >= 3 ? d : undefined;
        }, 'three ORS-empty-string results', 90000);
        assert.ok(list.every((d) => d.severity === vscode.DiagnosticSeverity.Information));
        const before = doc.getText();
        const d = list.find((x) => x.range.start.line === 6);
        assert.ok(d, 'the result on A()');
        const actions = await waitFor(async () => {
          const l = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range, vscode.CodeActionKind.QuickFix.value)) ?? [];
          return l.some((x) => x.title === 'Replace: empty-string (Refyntra)') ? l : undefined;
        }, 'the quick fix', 30000);
        const fix = actions.find((x) => x.title === 'Replace: empty-string (Refyntra)');
        await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
        await waitFor(() => doc.getText().includes('public bool A(string? s) => string.IsNullOrEmpty(s);'), 'fix applied', 30000);
        await waitFor(() => refyntra(doc.uri).filter((x) => codeOf(x) === 'ORS-empty-string').length === 2, 'one result fewer', 60000);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), before);
        await ss.store.delete('workspace.empty-string');
        await waitFor(() => refyntra(doc.uri).filter((x) => codeOf(x) === 'ORS-empty-string').length === 0, 'results gone', 60000);
        await revertAll();
      },
    ],
  ];
};
