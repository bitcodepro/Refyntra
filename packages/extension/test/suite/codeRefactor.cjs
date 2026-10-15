// Code refactorings e2e (runTest.mjs scenario "code-refactor") on a temp copy of the Refactorings fixture; the repository
// fixture is never touched. Safe Delete of a type alone in its file (delete + host resync + Undo restores it), of a
// method (text only), a delete refused when the file changes in the last moment (text applied, file kept, reported),
// Extract Method from a selection and Change Signature with evaluation order kept; Introduce Field (constructor)
// and Introduce Parameter across files with Undo.
const assert = require('node:assert/strict');
const fs = require('node:fs');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const lib = (rel) => file(`Refactorings.Lib/${rel}`);

  async function revertAll() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  async function at(uri, needle, offset = 0) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const i = doc.getText().indexOf(needle);
    assert.ok(i >= 0, needle);
    return { doc, target: { uri: doc.uri.toString(), position: doc.positionAt(i + offset) } };
  }

  async function prepared(a, uri, needle, offset, action, options) {
    const { target } = await at(uri, needle, offset);
    const r = await a.engine.prepareAction(target, action, undefined, options);
    assert.equal(r.kind, 'preview', JSON.stringify(r));
    assert.deepEqual(r.issues, []);
    return r;
  }

  return [
    [
      'the temp Refactorings copy loads (apply on)',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
        assert.ok(!file('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy');
      },
    ],
    [
      'Actions offers Safe Delete, Change Signature and Extract Method, each with its command',
      async () => {
        const a = await api();
        const { target } = await at(lib('SafeDelete/Members.cs'), 'void UnusedMethod', 5);
        const actions = await a.engine.actions(target);
        // Extract Method is offered inside a body (it works on the selection), not on the declaration.
        const body = await at(lib('SafeDelete/Members.cs'), 'Console.WriteLine("unused")');
        const inBody = await a.engine.actions(body.target);
        for (const id of ['csharp.safeDelete', 'csharp.changeSignature', 'csharp.extractMethod']) {
          const item = (id === 'csharp.extractMethod' ? inBody : actions).items.find((x) => x.capabilityId === id);
          assert.ok(item, `${id} in ${JSON.stringify(actions.items.map((x) => x.capabilityId))}`);
          assert.equal(item.state, 'available');
          assert.ok(a.capabilityUi(id).command, id);
        }
      },
    ],
    [
      'Safe Delete of a type alone in its file: the file is deleted, the host drops it, Undo restores it',
      async () => {
        const a = await api();
        const uri = lib('SafeDelete/Unused.cs');
        const original = fs.readFileSync(uri.fsPath, 'utf8');
        const r = await prepared(a, uri, 'class UnusedType', 6, 'csharp.safeDelete');
        assert.deepEqual(r.plan.writeSet.map((c) => c.kind), ['delete']);
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.match(out.message, /Unused\.cs deleted/);
        assert.equal(fs.existsSync(uri.fsPath), false);
        await waitFor(async () => !(await a.engine.find('type: UnusedType')).items.some((i) => i.label === 'UnusedType'), 'host dropped UnusedType', 60000);
        const undo = await a.undoCode(r.plan.writeSet, new Map([[uri.toString(), original]]));
        assert.ok(undo.some((l) => l.includes('restored')), undo.join(' '));
        assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), original);
        await waitFor(() => csharp(a.health())?.state === 'Ready', 'host ready after the reload', 240000);
        await waitFor(async () => (await a.engine.find('type: UnusedType')).items.some((i) => i.label === 'UnusedType'), 'host sees UnusedType again', 120000);
      },
    ],
    [
      'Safe Delete of a method edits the file (not saved); the other members stay',
      async () => {
        const a = await api();
        const uri = lib('SafeDelete/Members.cs');
        const r = await prepared(a, uri, 'void UnusedMethod', 5, 'csharp.safeDelete');
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        assert.ok(doc && doc.isDirty);
        assert.ok(!doc.getText().includes('UnusedMethod'));
        assert.ok(doc.getText().includes('public void UsedMethod()'));
        await revertAll();
      },
    ],
    [
      'Safe Delete refuses a used member and names its uses',
      async () => {
        const a = await api();
        const { target } = await at(lib('SafeDelete/Members.cs'), 'void UsedMethod', 5);
        const r = await a.engine.prepareAction(target, 'csharp.safeDelete');
        assert.equal(r.kind, 'unavailable');
        assert.equal(r.reasonCode, 'ReferencesRemain');
        assert.match(r.message, /Program\.cs:/);
      },
    ],
    [
      'a file changed right before its delete: the text edit stays applied, the file is kept, nothing is rolled back',
      async () => {
        const a = await api();
        const partA = lib('SafeDelete/PartialA.cs');
        const r = await prepared(a, partA, 'class PartialThing', 6, 'csharp.safeDelete');
        assert.deepEqual(r.plan.writeSet.map((c) => c.kind), ['text', 'delete']);
        a.editApplier.faults.beforeDelete = (u) => {
          if (u === partA.toString()) fs.appendFileSync(partA.fsPath, '// changed by another program\n');
        };
        try {
          const out = await a.engine.applyRename(r.planId);
          assert.equal(out.status, 'failed', out.message);
          assert.equal(out.textAppliedOnly, true);
          assert.match(out.message, /file deletion did not complete/);
          assert.ok(fs.existsSync(partA.fsPath));
        } finally {
          a.editApplier.faults.beforeDelete = undefined;
          await revertAll();
        }
      },
    ],
    [
      'Extract Method from a selection: the call replaces it and the new method follows the member',
      async () => {
        const a = await api();
        const uri = lib('ExtractMethod/Calculator.cs');
        const { doc } = await at(uri, 'var total = a + b;');
        const text = doc.getText();
        const start = text.indexOf('var total = a + b;');
        const end = text.indexOf('total *= 2;') + 'total *= 2;'.length;
        const range = { start: doc.positionAt(start), end: doc.positionAt(end) };
        const r = await a.engine.prepareAction({ uri: doc.uri.toString(), position: range.start }, 'csharp.extractMethod', undefined, { range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } }, newName: 'Double' });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.ok(doc.getText().includes('var total = Double(a, b);'));
        assert.ok(doc.getText().includes('private static int Double(int a, int b)'));
        await revertAll();
      },
    ],
    [
      'Change Signature reorders parameters; arguments with side effects keep their order as named arguments',
      async () => {
        const a = await api();
        const uri = lib('ChangeSignature/Greeter.cs');
        const { target } = await at(uri, 'static int Combine', 11);
        const sig = await a.engine.signatureAt(target);
        assert.equal(sig.kind, 'signature', JSON.stringify(sig));
        assert.deepEqual(sig.info.parameters.map((p) => p.name), ['a', 'b']);
        const r = await a.engine.prepareAction(target, 'csharp.changeSignature', undefined, { signature: { parameters: [{ from: 1, name: 'b' }, { from: 0, name: 'a' }] } });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        assert.ok(doc.getText().includes('public static int Combine(int b, int a) => a - b;'));
        assert.ok(doc.getText().includes('Combine(a: Next(), b: Next())'));
        await revertAll();
      },
    ],
    [
      'Edit actions (protocol 1.9): Ctrl+. offers Invert if / Inline / Introduce from the host; applying is one Undo step',
      async () => {
        const a = await api();
        const uri = lib('EditActions/Samples.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const pos = (needle, offset = 0) => doc.positionAt(doc.getText().indexOf(needle) + offset);
        const offered = async (range, kind) => {
          let list = [];
          await waitFor(async () => {
            list = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, range, kind)) ?? [];
            return list.some((x) => x.command?.command === 'refyntra.editAction');
          }, `edit actions for ${kind}`, 120000);
          return list.filter((x) => x.command?.command === 'refyntra.editAction');
        };
        // Convert: Invert 'if'.
        const ifPos = pos('if (value > 0)', 1);
        const rewrite = await offered(new vscode.Range(ifPos, ifPos), 'refactor.rewrite');
        const invert = rewrite.find((x) => x.title === "Invert 'if' (Refyntra)");
        assert.ok(invert, rewrite.map((x) => x.title).join(', '));
        assert.equal(invert.kind.value, 'refactor.rewrite.refyntra.invertIf');
        assert.equal(await vscode.commands.executeCommand(invert.command.command, ...invert.command.arguments), true);
        assert.ok(doc.getText().includes('if (value <= 0)'));
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        // Inline Variable.
        const sumPos = pos('var sum', 4);
        const inline = (await offered(new vscode.Range(sumPos, sumPos), 'refactor.inline')).find((x) => x.kind.value === 'refactor.inline.refyntra.variable');
        assert.ok(inline);
        assert.equal(await vscode.commands.executeCommand(inline.command.command, ...inline.command.arguments), true);
        assert.ok(doc.getText().includes('return (a + b) * (a + b);'));
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        // Introduce Variable (the keyboard command on the selection).
        const s = pos('a * b + _factor');
        editor.selection = new vscode.Selection(s, s.translate(0, 5));
        assert.equal(await vscode.commands.executeCommand('refyntra.introduceVariable'), true);
        assert.ok(doc.getText().includes('var value = a * b;'));
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        // Inline Method (all call sites, declaration removed) in another document; one Undo step.
        const inlineUri = lib('EditActions/InlineSamples.cs');
        const idoc = await vscode.workspace.openTextDocument(inlineUri);
        await vscode.window.showTextDocument(idoc);
        const iOriginal = idoc.getText();
        const addPos = idoc.positionAt(idoc.getText().indexOf('var x = Add(') + 8);
        let methodActions = [];
        await waitFor(async () => {
          methodActions = ((await vscode.commands.executeCommand('vscode.executeCodeActionProvider', inlineUri, new vscode.Range(addPos, addPos), 'refactor.inline')) ?? [])
            .filter((x) => x.command?.command === 'refyntra.editAction');
          return methodActions.some((x) => x.kind.value === 'refactor.inline.refyntra.method');
        }, 'inline method actions', 120000);
        const inlineAll = methodActions.find((x) => x.kind.value === 'refactor.inline.refyntra.method');
        assert.equal(await vscode.commands.executeCommand(inlineAll.command.command, ...inlineAll.command.arguments), true);
        assert.ok(idoc.getText().includes('var x = 1 + 2;'), idoc.getText());
        assert.ok(!idoc.getText().includes('int Add('), 'the declaration is removed');
        await vscode.commands.executeCommand('undo');
        assert.equal(idoc.getText(), iOriginal);
        await revertAll();
      },
    ],
    [
      'Convert actions: if -> switch expression, foreach -> LINQ, constructor -> primary constructor; one Undo step each',
      async () => {
        const uri = lib('EditActions/ConvertSamples.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const nl = original.includes('\r\n') ? '\r\n' : '\n';
        const apply = async (needle, offset, kind) => {
          const p = doc.positionAt(doc.getText().indexOf(needle.split('\n').join(nl)) + offset);
          let list = [];
          await waitFor(async () => {
            list = ((await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(p, p), 'refactor.rewrite')) ?? [])
              .filter((x) => x.command?.command === 'refyntra.editAction');
            return list.some((x) => x.kind.value === kind);
          }, `code action ${kind}`, 120000);
          const action = list.find((x) => x.kind.value === kind);
          assert.equal(await vscode.commands.executeCommand(action.command.command, ...action.command.arguments), true);
        };
        await apply('if (code == 1) return', 1, 'refactor.rewrite.refyntra.ifToSwitchExpression');
        assert.ok(doc.getText().includes('return code switch'), doc.getText());
        assert.ok(doc.getText().includes('2 or 3 => "few",'));
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        await apply('foreach (var v in values)\n        {\n            if (v < 0)', 1, 'refactor.rewrite.refyntra.foreachToLinq');
        assert.ok(doc.getText().includes('return values.Any(v => v < 0);'), doc.getText());
        assert.ok(doc.getText().includes('using System.Linq;'));
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        await apply('public ConvAccount(string', 8, 'refactor.rewrite.refyntra.primaryConstructor');
        assert.ok(doc.getText().includes('public class ConvAccount(string owner, int limit)'), doc.getText());
        assert.ok(doc.getText().includes('private readonly string _owner = owner;'));
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        await revertAll();
      },
    ],
    [
      'Introduce Field (initialized in the constructor) is one action with choices; one Undo step',
      async () => {
        const uri = lib('EditActions/IntroduceSamples.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const start = doc.positionAt(doc.getText().indexOf('width * (60 * 60)') + 'width * ('.length);
        const range = new vscode.Range(start, start.translate(0, '60 * 60'.length));
        let list = [];
        await waitFor(async () => {
          list = ((await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, range, 'refactor.extract')) ?? []).filter((x) => x.command?.command === 'refyntra.editAction');
          return list.some((x) => x.title === 'Introduce field… (Refyntra)');
        }, 'introduce field action', 120000);
        const field = list.find((x) => x.title === 'Introduce field… (Refyntra)');
        const arg = field.command.arguments[0];
        assert.ok(arg.choices.some((c) => c.actionId === 'csharp.edit.introduceField.constructor'), JSON.stringify(arg.choices));
        assert.ok(list.some((x) => x.kind.value === 'refactor.extract.refyntra.parameter'), list.map((x) => x.title).join(', '));
        // The QuickPick answer: the constructor choice.
        assert.equal(await vscode.commands.executeCommand('refyntra.editAction', { ...arg, actionId: 'csharp.edit.introduceField.constructor', choices: undefined }), true);
        const text = doc.getText().replace(/\r\n/g, '\n');
        assert.ok(text.includes('private readonly int _value;'), text);
        assert.ok(text.includes('_value = 60 * 60;'), text);
        assert.ok(text.includes('return width * (_value);'), text);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        await revertAll();
      },
    ],
    [
      'Introduce Parameter across files: the plan updates the call sites in another file; Undo restores both',
      async () => {
        const a = await api();
        const uri = lib('EditActions/IntroduceSamples.cs');
        const callers = lib('EditActions/IntroduceCallers.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const cdoc = await vscode.workspace.openTextDocument(callers);
        const original = doc.getText();
        const cOriginal = cdoc.getText();
        const i = doc.getText().indexOf('net * (1 + TaxRate)') + 'net * ('.length;
        const s = doc.positionAt(i);
        const e = doc.positionAt(i + '1 + TaxRate'.length);
        const range = { start: { line: s.line, character: s.character }, end: { line: e.line, character: e.character } };
        const r = await a.engine.prepareAction({ uri: doc.uri.toString(), position: range.start }, 'csharp.introduceParameter', undefined, { range });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        assert.equal(r.plan.writeSet.length, 2);
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.ok(doc.getText().includes('internal decimal Gross(decimal net, decimal value)'), doc.getText());
        assert.ok(doc.getText().includes('return net * (value) + Fee();'));
        assert.ok(cdoc.getText().includes('calc.Gross(10m, 1 + PriceCalculator.TaxRate)'), cdoc.getText());
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(undone.filter((m) => m.endsWith('edit undone.')).length, 2, undone.join(' '));
        assert.equal(doc.getText(), original);
        assert.equal(cdoc.getText(), cOriginal);
        await revertAll();
      },
    ],
    [
      'Inline Method across files: the edit action is refused with CrossFile, the plan inlines every call (other file, other project) and removes the method; Undo restores all',
      async () => {
        const a = await api();
        const uri = lib('EditActions/InlineAcross.cs');
        const callers = lib('EditActions/InlineAcrossCallers.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const cdoc = await vscode.workspace.openTextDocument(callers);
        const original = doc.getText();
        const cOriginal = cdoc.getText();
        const p = doc.positionAt(doc.getText().indexOf('WithTax(decimal net)'));
        const range = { start: { line: p.line, character: p.character }, end: { line: p.line, character: p.character } };
        const edit = await a.engine.editActions({ uri: doc.uri.toString(), range }, 'csharp.edit.inlineMethodAll');
        assert.equal(edit.kind, 'unavailable', JSON.stringify(edit));
        assert.equal(edit.reasonCode, 'CrossFile');
        const r = await a.engine.prepareAction({ uri: doc.uri.toString(), position: range.start }, 'csharp.inlineMethodAll', undefined, { range });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        assert.equal(r.plan.writeSet.length, 3);
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.ok(!doc.getText().includes('WithTax'), doc.getText());
        assert.ok(cdoc.getText().includes('a * (1 + Pricing.Rate) + b * (1 + Pricing.Rate)'), cdoc.getText());
        const undone = await a.undoCode(r.plan.writeSet, new Map());
        assert.equal(undone.filter((m) => m.endsWith('edit undone.')).length, 3, undone.join(' '));
        assert.equal(doc.getText(), original);
        assert.equal(cdoc.getText(), cOriginal);
        await revertAll();
      },
    ],
    [
      'Postfix templates (protocol 1.10): .foreach on a list and .ifn on a nullable, inserted as snippets',
      async () => {
        const uri = lib('Postfix/Samples.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const postfix = async (code, name) => {
          const edit = new vscode.WorkspaceEdit();
          const marker = doc.getText().indexOf('/*S*/');
          edit.replace(uri, new vscode.Range(doc.positionAt(marker), doc.positionAt(marker + 5)), code);
          assert.ok(await vscode.workspace.applyEdit(edit));
          const pos = doc.positionAt(doc.getText().indexOf(code) + code.length);
          let item;
          await waitFor(async () => {
            const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, pos, '.');
            item = (list?.items ?? []).find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === name && i.kind === vscode.CompletionItemKind.Snippet);
            return !!item;
          }, `postfix .${name}`, 120000);
          assert.ok(item.sortText.startsWith('~'), item.sortText);
          const range = item.range instanceof vscode.Range ? item.range : item.range.replacing;
          assert.ok(await editor.insertSnippet(item.insertText, range));
          await vscode.commands.executeCommand('leaveSnippet');
        };
        await postfix('numbers.', 'foreach');
        assert.ok(doc.getText().includes('foreach (var number in numbers)'), doc.getText());
        assert.ok(!doc.getText().includes('numbers.'), 'the expression and the dot are replaced');
        await vscode.commands.executeCommand('workbench.action.files.revert');
        assert.equal(doc.getText(), original);
        await postfix('maybe.', 'ifn');
        assert.ok(doc.getText().includes('if (maybe is null)'), doc.getText());
        await revertAll();
      },
    ],
    [
      'Generate (protocol 1.10): Equals/GetHashCode and Implement interface computed by Roslyn; one Undo step each',
      async () => {
        const a = await api();
        const uri = lib('Generate/Samples.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const original = doc.getText();
        const cursorAt = (needle) => {
          const p = doc.positionAt(doc.getText().indexOf(needle) + 2);
          editor.selection = new vscode.Selection(p, p);
          return { uri: doc.uri.toString(), position: { line: p.line, character: p.character } };
        };
        // The kinds the picker would offer for Person.
        const listed = await a.engine.generate(cursorAt('class Person'));
        assert.equal(listed.kind, 'kinds', JSON.stringify(listed));
        assert.ok(listed.kinds.some((k) => k.kind === 'equality'));
        cursorAt('class Person');
        assert.equal(await vscode.commands.executeCommand('refyntra.generate', { kind: 'equality', members: ['_name', '_age'], equatable: true, operators: true }), true);
        const text = doc.getText();
        assert.ok(text.includes('public class Person : IEquatable<Person>'), text);
        assert.ok(text.includes('return HashCode.Combine(_name, _age);'), text);
        assert.ok(text.includes('public static bool operator ==(Person? left, Person? right)'), text);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), original);
        // Implement IShape on Circle (the class gets the interface first).
        const edit = new vscode.WorkspaceEdit();
        const circle = doc.getText().indexOf('public class Circle') + 'public class Circle'.length;
        edit.insert(uri, doc.positionAt(circle), ' : IShape');
        assert.ok(await vscode.workspace.applyEdit(edit));
        const withInterface = doc.getText();
        cursorAt('class Circle');
        assert.equal(await vscode.commands.executeCommand('refyntra.generate', { kind: 'implement' }), true);
        const implemented = doc.getText();
        assert.ok(implemented.includes('    public double Area()\n    {\n        throw new NotImplementedException();\n    }') || implemented.includes('public double Area()'), implemented);
        assert.ok(implemented.includes('public event EventHandler? Changed;'), implemented);
        await vscode.commands.executeCommand('undo');
        assert.equal(doc.getText(), withInterface);
        await revertAll();
      },
    ],
    [
      'Ctrl+Click (Go to Definition): a method call opens its body; an interface member opens its implementations; Ctrl+F12 too',
      async () => {
        await api();
        const uri = lib('ChangeSignature/Greeter.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const lineOf = (needle) => doc.positionAt(text.indexOf(needle)).line;
        const def = async (needle, offset) => {
          const pos = doc.positionAt(text.indexOf(needle) + offset);
          const r = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, pos);
          return (r ?? []).map((l) => (l.targetUri ?? l.uri).path.split('/').pop() + ':' + (l.targetRange ?? l.range).start.line);
        };
        // new Greeter().Greet(...) → Greeter.Greet (its body).
        const concrete = await def('new Greeter().Greet', 'new Greeter().'.length + 1);
        assert.deepEqual(concrete, [`Greeter.cs:${lineOf('public virtual string Greet')}`], JSON.stringify(concrete));
        // greeter.Greet(...) on IGreeter → the implementations (Greeter and the LoudGreeter override).
        const iface = await def('greeter.Greet("a"', 'greeter.'.length + 1);
        assert.ok(iface.includes(`Greeter.cs:${lineOf('public virtual string Greet')}`), JSON.stringify(iface));
        assert.ok(!iface.includes(`Greeter.cs:${lineOf('string Greet(string name, int times);')}`), 'not the interface declaration');
        // new Greeter() → the class.
        const type = await def('new Greeter()', 'new '.length + 1);
        assert.deepEqual(type, [`Greeter.cs:${lineOf('public class Greeter')}`], JSON.stringify(type));
        const impl = await vscode.commands.executeCommand('vscode.executeImplementationProvider', uri, doc.positionAt(text.indexOf('public interface IGreeter') + 'public interface '.length + 1));
        assert.ok(impl.some((l) => (l.targetRange ?? l.range).start.line === lineOf('public class Greeter')), JSON.stringify(impl));
      },
    ],
    [
      'Completion: after "Pricing." the members come from Roslyn (methods, constants, no private ones); resolving shows the signature',
      async () => {
        await api();
        const uri = lib('EditActions/InlineAcrossCallers.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const at = doc.positionAt(doc.getText().indexOf('Pricing.Doubled(a)'));
        await editor.edit((e) => e.insert(at, 'Pricing.'));
        try {
          const pos = at.translate(0, 'Pricing.'.length);
          const list = await waitFor(async () => {
            const l = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, pos, '.', 50);
            return l.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'WithTax') ? l : undefined;
          }, 'WithTax in the completion list', 60000);
          const labelOf = (i) => (typeof i.label === 'string' ? i.label : i.label.label);
          const withTax = list.items.find((i) => labelOf(i) === 'WithTax');
          assert.equal(withTax.kind, vscode.CompletionItemKind.Method);
          assert.ok(list.items.some((i) => labelOf(i) === 'Rate' && i.kind === vscode.CompletionItemKind.Constant));
          assert.ok(!list.items.some((i) => labelOf(i) === 'Secret'), 'private members are not offered');
          assert.match(withTax.detail ?? '', /WithTax\(decimal net\)/);
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
      },
    ],
    [
      'Hover shows the signature and the XML documentation; signature help shows the parameters and the active one',
      async () => {
        await api();
        const uri = lib('ChangeSignature/Greeter.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        let last = '';
        const hovers = await waitFor(async () => {
          const h = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, doc.positionAt(text.indexOf('new Greeter().Greet') + 'new Greeter().'.length + 1));
          const md = (h ?? []).flatMap((x) => x.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
          last = md;
          return /Greets(&nbsp;| )someone/.test(md) ? md : undefined;
        }, 'the hover with the documentation', 60000).catch((e) => {
          throw new Error(`${e.message}; last hover: ${JSON.stringify(last).slice(0, 600)}`);
        });
        assert.match(hovers, /Greet\(string name, int times\)/);
        const editor = await vscode.window.showTextDocument(doc);
        const call = 'new Greeter().Greet("c", 1)';
        const start = text.indexOf(call);
        await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(start), doc.positionAt(start + call.length)), 'new Greeter().Greet("c", '));
        try {
          const pos = doc.positionAt(start + 'new Greeter().Greet("c", '.length);
          const help = await waitFor(async () => {
            const h = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', uri, pos, ',');
            return h && h.signatures.length ? h : undefined;
          }, 'signature help', 60000);
          assert.match(help.signatures[help.activeSignature].label, /Greet\(string name, int times\)/);
          assert.equal(help.activeParameter, 1);
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
      },
    ],
    [
      'Compiler errors of an open C# file show up in Problems (source C#) and go away when fixed',
      async () => {
        await api();
        const uri = lib('ChangeSignature/Greeter.cs');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const call = 'new Greeter().Greet("c", 1)';
        const start = doc.getText().indexOf(call);
        await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(start), doc.positionAt(start + call.length)), 'new Greeter().Greet("c", "x")'));
        const errors = () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'C#' && d.severity === vscode.DiagnosticSeverity.Error);
        try {
          const e = await waitFor(() => (errors().length ? errors() : undefined), 'a C# error in Problems', 60000);
          assert.equal(e[0].code, 'CS1503');
        } finally {
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await waitFor(() => errors().length === 0, 'the error gone after the revert', 60000);
      },
    ],
  ];
};
