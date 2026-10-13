// Inspections e2e (runTest.mjs scenario "inspections") on a temp copy of tests/fixtures/Inspections; the repository
// fixture is never touched. The inspections OR1002–OR1010 come from the C# host (analysis/run with the open documents,
// protocol 1.16): a diagnostic appears in Refyntra's Problems collection, its quick fix (an edit action) applies as
// one undo step, Fix in scope in the solution goes through the editor's Refactor Preview and is undone, and a
// '#pragma warning disable' / [SuppressMessage] keeps a file silent.
const assert = require('node:assert/strict');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Inspections.App', ...rel.split('/'));
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
      'the Inspections fixture loads',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
      },
    ],
    [
      'opening a file shows its inspection results in Problems (rule id, help link, severity from the setting)',
      async () => {
        const doc = await open('Cases/Format.cs');
        const list = await waitFor(() => {
          const d = refyntra(doc.uri);
          return d.length >= 4 ? d : undefined;
        }, 'four OR1010 results', 90000);
        assert.deepEqual(list.map(codeOf), ['OR1010', 'OR1010', 'OR1010', 'OR1010']);
        assert.ok(list.every((d) => d.severity === vscode.DiagnosticSeverity.Information));
        assert.match(String(list[0].code.target), /docs\/rules\/OR1010\.md$/);
        const sync = await open('Cases/SyncOverAsync.cs');
        const warnings = await waitFor(() => {
          const d = refyntra(sync.uri);
          return d.length >= 7 ? d : undefined;
        }, 'seven OR1002 results', 90000);
        assert.ok(warnings.every((d) => codeOf(d) === 'OR1002' && d.severity === vscode.DiagnosticSeverity.Warning));
      },
    ],
    [
      'a quick fix applies as one edit and Undo restores the text; the result disappears and comes back',
      async () => {
        const doc = await open('Cases/Format.cs');
        const before = doc.getText();
        const d = await waitFor(() => refyntra(doc.uri).find((x) => doc.getText(x.range).includes('"hello"')), 'the OR1010 result on Plain()', 60000);
        const actions = await waitFor(async () => {
          const list = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range, vscode.CodeActionKind.QuickFix.value)) ?? [];
          return list.some((x) => x.title === 'Use the string directly (Refyntra)') ? list : undefined;
        }, 'the quick fix', 30000);
        const fix = actions.find((x) => x.title === 'Use the string directly (Refyntra)');
        assert.equal(fix.kind.value, 'quickfix');
        assert.ok(actions.some((x) => x.title === 'Use the string directly in document, project or solution… (Refyntra)'));
        await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
        await waitFor(() => doc.getText().includes('public string Plain() => "hello";'), 'fix applied', 30000);
        await waitFor(() => refyntra(doc.uri).length === 3, 'one result fewer', 60000);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), before);
        await waitFor(() => refyntra(doc.uri).length === 4, 'the result is back', 60000);
        await revertAll();
      },
    ],
    [
      'Fix in scope in the solution goes through the Refactor Preview; Undo restores every file',
      async () => {
        const a = await api();
        const doc = await open('Cases/Format.cs');
        const before = doc.getText();
        const target = { uri: doc.uri.toString(), position: { line: 0, character: 0 } };
        const r = await a.engine.prepareAction(target, 'csharp.fixAll', undefined, { range: { start: target.position, end: target.position }, fixAll: { actionId: 'csharp.edit.fix.removeFormat', scope: 'solution' } });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        assert.equal(r.plan.writeSet.length, 1, r.plan.writeSet.map((c) => c.uri).join(' '));
        const out = await throughPreview(a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: fix in solution' } }), 'refactorPreview.apply');
        assert.equal(out.status, 'applied', out.message);
        const text = doc.getText();
        assert.ok(text.includes('Plain() => "hello";') && text.includes('Braces() => "{x}";') && text.includes('Constant() => Fixed;'), text);
        assert.ok(text.includes('string.Format("{0}")'), 'the throwing format is reported, never "fixed"');
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(undone.filter((m) => m.endsWith('edit undone.')).length, 1, undone.join(' '));
        assert.equal(doc.getText(), before);
        await revertAll();
      },
    ],
    [
      "the compiler's CS4014 quick fix Add 'await' applies as one edit",
      async () => {
        const doc = await open('Cases/DiscardedTask.cs');
        const at = doc.positionAt(doc.getText().indexOf("SaveAsync(); // the compiler"));
        // The quick fix Refyntra attaches to CS4014 (diagnosticsModel.compilerQuickFixes) runs this command.
        const arg = { uri: doc.uri.toString(), range: { start: { line: at.line, character: at.character }, end: { line: at.line, character: at.character } }, actionId: 'csharp.edit.fix.addAwait', version: doc.version };
        const before = doc.getText();
        await vscode.commands.executeCommand('refyntra.editAction', arg);
        await waitFor(() => doc.getText().includes('await SaveAsync(); // the compiler'), 'await added', 30000);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), before);
        await revertAll();
      },
    ],
    [
      'suppressions are honoured: #pragma warning disable and [SuppressMessage] keep a file silent',
      async () => {
        const doc = await open('Cases/Suppressed.cs');
        // Another file opened after it is analysed, so the run that included Suppressed.cs has finished.
        const other = await open('Cases/AsyncVoid.cs');
        await waitFor(() => refyntra(other.uri).length >= 2, 'AsyncVoid.cs analysed', 90000);
        assert.deepEqual(refyntra(doc.uri).map(codeOf), []);
      },
    ],
  ];
};
