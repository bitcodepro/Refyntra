// Blazor / Razor e2e (runTest.mjs scenario "razor") on a temp copy of the Blazor fixture: a C# rename updates the uses
// in .razor and .cshtml markup (mapped from the Razor-generated code), Find References lists the markup lines; Undo.
'use strict';

const assert = require('node:assert/strict');

exports.cases = ({ api, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'BlazorApp', ...rel.split('/'));

  return [
    [
      'razor: rename a service method used in .razor and .cshtml → the markup is renamed too; Undo restores all files',
      async () => {
        const a = await api();
        const svc = await vscode.workspace.openTextDocument(file('Services/CounterService.cs'));
        const razor = await vscode.workspace.openTextDocument(file('Components/Pages/Counter.razor'));
        const cshtml = await vscode.workspace.openTextDocument(file('Pages/About.cshtml'));
        const originals = [svc.getText(), razor.getText(), cshtml.getText()];
        const p = svc.positionAt(svc.getText().indexOf('Describe(int step)'));
        const r = await waitFor(async () => {
          const x = await a.engine.prepareRename({ uri: svc.uri.toString(), position: { line: p.line, character: p.character } }, 'Explain');
          return x.kind === 'preview' ? x : undefined;
        }, 'a rename plan', 120000);
        assert.equal(r.plan.writeSet.length, 3, JSON.stringify(r.plan.writeSet.map((w) => w.uri)));
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.ok(razor.getText().includes('<p>@Service.Explain(1)</p>'), razor.getText());
        assert.ok(cshtml.getText().includes('<p>@Counter.Explain(2)</p>'), cshtml.getText());
        assert.ok(svc.getText().includes('public string Explain(int step)'));
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(undone.filter((m) => m.endsWith('edit undone.')).length, 3, undone.join(' '));
        assert.deepEqual([svc.getText(), razor.getText(), cshtml.getText()], originals);
        for (const d of [svc, razor, cshtml]) if (d.isDirty) await d.save();
      },
    ],
    [
      'razor: Find Usages from C# lists the .razor line with its markup text',
      async () => {
        const a = await api();
        const svc = await vscode.workspace.openTextDocument(file('Services/CounterService.cs'));
        const p = svc.positionAt(svc.getText().indexOf('Increment()'));
        const r = await a.engine.usages({ uri: svc.uri.toString(), position: { line: p.line, character: p.character } }, 100);
        assert.equal(r.kind, 'usages', JSON.stringify(r));
        const item = r.items.find((i) => i.uri.endsWith('Counter.razor'));
        assert.ok(item, JSON.stringify(r.items.map((i) => i.uri)));
        assert.equal(item.range.start.line, 7);
        assert.equal(item.lineText, '<button @onclick="Service.Increment">Add</button>');
      },
    ],
  ];
};
