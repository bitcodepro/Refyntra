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
    [
      'razor: rename from a .razor editor a property of its @code block → declaration and markup use are renamed; Undo',
      async () => {
        const a = await api();
        const razor = await vscode.workspace.openTextDocument(file('Components/Pages/Counter.razor'));
        const original = razor.getText();
        const p = razor.positionAt(original.indexOf('Title { get'));
        const r = await waitFor(async () => {
          const x = await a.engine.prepareRename({ uri: razor.uri.toString(), position: { line: p.line, character: p.character } }, 'Heading');
          return x.kind === 'preview' ? x : undefined;
        }, 'a rename plan from the .razor file', 120000);
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.ok(razor.getText().includes('<h1>@Heading</h1>') && razor.getText().includes('private string Heading { get; set; }'), razor.getText());
        await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(razor.getText(), original);
        if (razor.isDirty) await razor.save();
      },
    ],
    [
      'razor: unsaved markup is seen by the host → a use typed in the .razor editor is found by Find Usages',
      async () => {
        const a = await api();
        const razor = await vscode.workspace.openTextDocument(file('Components/Pages/Counter.razor'));
        const editor = await vscode.window.showTextDocument(razor);
        const original = razor.getText();
        await editor.edit((e) => e.insert(razor.positionAt(original.indexOf('@code')), '<p>@Service.Describe(3)</p>\n'));
        const svc = await vscode.workspace.openTextDocument(file('Services/CounterService.cs'));
        const p = svc.positionAt(svc.getText().indexOf('Describe(int step)'));
        try {
          await waitFor(async () => {
            const r = await a.engine.usages({ uri: svc.uri.toString(), position: { line: p.line, character: p.character } }, 100);
            return r.kind === 'usages' && r.items.some((i) => i.lineText === '<p>@Service.Describe(3)</p>');
          }, 'the unsaved use in Counter.razor', 60000);
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
      },
    ],
    [
      'live templates: "fore" in a C# method offers the foreach template; accepting it inserts the loop',
      async () => {
        const svc = await vscode.workspace.openTextDocument(file('Services/CounterService.cs'));
        const editor = await vscode.window.showTextDocument(svc);
        const at = svc.positionAt(svc.getText().indexOf('public void Increment'));
        await editor.edit((e) => e.insert(at, 'fore'));
        try {
          const pos = at.translate(0, 4);
          const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', svc.uri, pos);
          const item = list.items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'foreach' && i.kind === vscode.CompletionItemKind.Snippet);
          assert.ok(item, JSON.stringify(list.items.slice(0, 20).map((i) => i.label)));
          assert.ok(item.insertText.value.startsWith('foreach (var ${1:item} in ${2:collection})'), item.insertText.value);
          assert.ok(!list.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'prop' && i.kind === vscode.CompletionItemKind.Snippet), 'only templates starting with the typed word');
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
      },
    ],
  ];
};
