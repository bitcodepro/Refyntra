// Constructor / DI e2e (runTest.mjs scenario "ctor-di") on a temp copy of tests/fixtures/Ctor; the repository fixture is
// never touched. The constructor helpers come from the C# host (protocol 1.11, code/constructorActions): a field from a
// constructor parameter with a using added, an injected field for an undeclared `_name` whose type is inferred, Register
// in DI and Fix in scope (var -> explicit type in the whole solution) as plans applied through the editor's Refactor
// Preview, each undone.
const assert = require('node:assert/strict');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const app = (rel) => file(`Ctor.App/${rel}`);

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

  /** The code actions at the first occurrence of needle (+ offset), once the host lists `title`. */
  async function actionsAt(doc, needle, offset, title) {
    const at = doc.positionAt(doc.getText().indexOf(needle) + offset);
    const range = new vscode.Range(at, at);
    return waitFor(async () => {
      const list = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, range, undefined, 50)) ?? [];
      return list.find((x) => x.title === title) ? list : undefined;
    }, `code action "${title}"`, 60000);
  }

  return [
    [
      'the temp Ctor copy loads (apply on, Refactor Preview)',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
        assert.ok(!file('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy');
      },
    ],
    [
      'Create and initialize field (Roslyn): the semantic type gets a using; one Undo restores the file',
      async () => {
        const doc = await vscode.workspace.openTextDocument(app('Services/ReportFormatter.cs'));
        await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const list = await actionsAt(doc, 'repository)', 1, "Create and initialize field '_repository'");
        const titles = list.map((x) => x.title);
        assert.ok(titles.includes("Create and initialize property 'Repository'"), titles.join(' | '));
        const create = list.find((x) => x.title === "Create and initialize field '_repository'");
        assert.equal(await vscode.commands.executeCommand(create.command.command, ...create.command.arguments), true);
        const text = doc.getText().replace(/\r\n/g, '\n');
        assert.ok(text.includes('using Ctor.Lib.Data;'), text);
        assert.ok(text.includes('    private readonly SqlOrderRepository _repository;\n'), text);
        assert.ok(text.includes('        _repository = repository;\n'), text);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original, 'one Undo restores the file');
        await revertAll();
      },
    ],
    [
      'Create field and inject via constructor: the type of an undeclared _sender is inferred from its use',
      async () => {
        const doc = await vscode.workspace.openTextDocument(app('Services/OrderService.cs'));
        await vscode.window.showTextDocument(doc);
        const edit = new vscode.WorkspaceEdit();
        const at = doc.getText().indexOf('=> _audit.Record("place", id);');
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + '=> _audit.Record("place", id);'.length)), '{ _audit.Record("place", id); _sender.Notify("placed"); }');
        await vscode.workspace.applyEdit(edit);
        const list = await actionsAt(doc, '_sender.', 2, "Create field '_sender' and inject via constructor");
        const inject = list.find((x) => x.title === "Create field '_sender' and inject via constructor");
        assert.equal(await vscode.commands.executeCommand(inject.command.command, ...inject.command.arguments), true);
        const text = doc.getText().replace(/\r\n/g, '\n');
        assert.ok(text.includes('    private readonly INotifier _sender;\n'), text);
        // The unused INotifier parameter is reused for the new field.
        assert.ok(text.includes('        _sender = notifier;\n'), text);
        await revertAll();
      },
    ],
    [
      'Register in DI: lifetime + composition root, applied through the Refactor Preview; Undo restores Program.cs',
      async () => {
        const a = await api();
        const doc = await vscode.workspace.openTextDocument(app('Services/OrderService.cs'));
        const program = await vscode.workspace.openTextDocument(app('Program.cs'));
        const original = program.getText();
        const p = doc.positionAt(doc.getText().indexOf('orders,') + 1);
        const target = { uri: doc.uri.toString(), position: { line: p.line, character: p.character } };
        const d = await a.engine.constructorActions(target, { actionId: 'csharp.ctor.registerDi' });
        assert.equal(d.kind, 'registration', JSON.stringify(d));
        assert.deepEqual(d.info.implementations.map((x) => x.label), ['SqlOrderRepository']);
        assert.equal(d.info.roots.length, 2);
        const r = await a.engine.prepareAction(target, 'csharp.registerDi', undefined, { range: { start: target.position, end: target.position }, registration: { lifetime: 'Scoped', rootId: d.info.roots[0].id } });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const out = await throughPreview(a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: register' } }), 'refactorPreview.apply');
        assert.equal(out.status, 'applied', out.message);
        const text = program.getText().replace(/\r\n/g, '\n');
        assert.ok(text.includes('builder.Services.AddScoped<IOrderRepository, SqlOrderRepository>();'), text);
        assert.ok(text.includes('using Ctor.Lib.Contracts;') && text.includes('using Ctor.Lib.Data;'), text);
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.ok(undone.some((m) => m.endsWith('edit undone.')), undone.join(' '));
        assert.equal(program.getText(), original);
        await revertAll();
      },
    ],
    [
      'Fix in scope: "Use explicit type" in the solution (two projects) through the Refactor Preview; Undo restores every file',
      async () => {
        const a = await api();
        const styles = await vscode.workspace.openTextDocument(file('Ctor.Lib/Fix/Styles.cs'));
        await vscode.window.showTextDocument(styles);
        // The scope variant is offered next to the single action.
        const list = await actionsAt(styles, 'var a', 1, 'Use explicit type in document, project or solution… (Refyntra)');
        assert.ok(list.some((x) => x.title === 'Use explicit type (Refyntra)'));
        const appStyles = await vscode.workspace.openTextDocument(app('Fix/AppStyles.cs'));
        const originals = new Map([[styles.uri.toString(), styles.getText()], [appStyles.uri.toString(), appStyles.getText()]]);
        const target = { uri: styles.uri.toString(), position: { line: 0, character: 0 } };
        const r = await a.engine.prepareAction(target, 'csharp.fixAll', undefined, { range: { start: target.position, end: target.position }, fixAll: { actionId: 'csharp.edit.varToExplicit', scope: 'solution' } });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        assert.equal(r.plan.writeSet.length, 3, r.plan.writeSet.map((c) => c.uri).join(' '));
        const out = await throughPreview(a.engine.applyRename(r.planId, undefined, { confirmation: { label: 'Refyntra: fix in solution' } }), 'refactorPreview.apply');
        assert.equal(out.status, 'applied', out.message);
        assert.ok(styles.getText().includes('int a = 1;'), styles.getText());
        assert.ok(appStyles.getText().includes('int count = 3;'), appStyles.getText());
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(undone.filter((m) => m.endsWith('edit undone.')).length, 3, undone.join(' '));
        for (const [uri, text] of originals) assert.equal(vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri).getText(), text);
        await revertAll();
      },
    ],
  ];
};
