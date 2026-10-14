// Go to metadata / decompiled sources (protocol 1.16), part of the runTest.mjs scenario "navigation" (a temp copy of
// Shop against the real host): a NuGet type (MediatR) and a BCL type (System.String) open as read-only
// refyntra-metadata: documents; F12 inside goes on to other metadata documents, hover answers, Find Usages from a
// metadata document lists the usages in the solution; File Structure and an external stack frame open decompiled code.
const assert = require('node:assert/strict');

/** Written into the temp copy before the host loads it (runTest.mjs copyOpts): a class with a library base class. */
exports.extraFiles = {
  'Shop.Api/Services/AppError.cs': ['namespace Shop.Api.Services;', '', 'public sealed class AppError : System.Exception', '{', '    public AppError() : base("app") { }', '}', ''].join('\n'),
};

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));

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

  const active = () => vscode.window.activeTextEditor;
  const activeLine = () => active().document.lineAt(active().selection.active.line).text;

  /** Puts the cursor of the active (metadata) editor on the first `needle` (+ offset). */
  function cursorAt(needle, offset = 0) {
    const ed = active();
    const i = ed.document.getText().indexOf(needle);
    assert.ok(i >= 0, `${needle} in ${ed.document.uri.toString()}`);
    const pos = ed.document.positionAt(i + offset);
    ed.selection = new vscode.Selection(pos, pos);
    return pos;
  }

  return [
    ['go to metadata: a NuGet type opens decompiled read-only; F12 inside goes on; hover; Find Usages lists the solution', async () => {
      const a = await ready();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await open('Shop.Api/Program.cs', 'IMediator mediator', 2);
      const r = await vscode.commands.executeCommand('refyntra.goToMetadata');
      assert.equal(r.kind, 'document', JSON.stringify(r));
      assert.equal(r.uri, 'refyntra-metadata:/MediatR/MediatR.IMediator.cs');
      assert.equal(r.origin, 'decompiled');
      const doc = active().document;
      assert.equal(doc.uri.scheme, 'refyntra-metadata');
      assert.equal(doc.languageId, 'csharp');
      assert.match(doc.getText(), /public interface IMediator : ISender, IPublisher/);
      assert.match(doc.getText(), /\/\/ Decompiled from MediatR\.dll with ICSharpCode\.Decompiler \d+\./);
      assert.match(activeLine(), /interface IMediator/);
      assert.match(a.metadata.describe(r.uri), /^Decompiled from MediatR\.dll with ICSharpCode\.Decompiler/);
      // Read-only: VS Code refuses edits to a document of a content provider.
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), 'x');
      await vscode.workspace.applyEdit(edit).then(() => undefined, () => undefined);
      assert.ok(!doc.getText().startsWith('x') || doc.isDirty === false, 'metadata documents are not edited on disk');
      // Hover on ISender: Refyntra's hover for this scheme.
      const pos = cursorAt('ISender,', 2);
      const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos);
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /ISender/);
      assert.match(text, /library \\\(metadata\\\)/);
      // F12 inside (the same command): the next metadata document.
      const inside = await vscode.commands.executeCommand('refyntra.goToMetadata');
      assert.equal(inside.uri, 'refyntra-metadata:/MediatR/MediatR.ISender.cs', JSON.stringify(inside));
      assert.match(activeLine(), /interface ISender/);
      // Find Usages from the metadata document: the usages in the solution.
      a.usages.clear();
      a.usages.setGroupings(['kind', 'file']);
      a.usages.setFilters({ kinds: [], tests: 'all' });
      const at = active().selection.active;
      await a.usages.find({ uri: active().document.uri.toString(), position: { line: at.line, character: at.character } });
      await waitFor(() => !a.usages.state().loading && a.usages.state().sessions.length === 1, 'usages of ISender', 120000);
      const st = a.usages.state();
      assert.match(st.sessions[0].subject, /ISender/);
      assert.ok(st.sessions[0].total >= 2, JSON.stringify(st.sessions));
      assert.match(a.usages.markdown(), /Program\.cs:\d+/);
      assert.ok(a.metadata.store.size >= 2);
      assert.match(a.metadata.healthText(), /ICSharpCode\.Decompiler \d+\.\d+.*nothing is downloaded/);
    }],
    ['go to metadata: System.String opens the decompiled implementation; Navigate To offers it; a source symbol opens its file', async () => {
      const a = await ready();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await open('Shop.Api/Services/OrderServices.cs', 'string customer', 1);
      const r = await vscode.commands.executeCommand('refyntra.goToMetadata');
      assert.equal(r.uri, 'refyntra-metadata:/System.Runtime/System.String.cs', JSON.stringify(r));
      assert.match(active().document.getText(), /public sealed class String/);
      assert.match(active().document.getText(), /\/\/ Implementation: System\.Private\.CoreLib\.dll/);
      assert.match(activeLine(), /class String/);
      // Navigate To on the same symbol lists "Decompiled declaration".
      await open('Shop.Api/Services/OrderServices.cs', 'string customer', 1);
      void vscode.commands.executeCommand('refyntra.navigateTo');
      await waitFor(() => a.navigateTo.state().ready && a.navigateTo.state().open, 'Navigate To list', 120000);
      const item = a.navigateTo.state().items.find((i) => i.id === 'metadata');
      assert.ok(item, JSON.stringify(a.navigateTo.state().items));
      assert.equal(item.label, 'Decompiled declaration');
      assert.equal(await a.navigateTo.accept('metadata'), true);
      await waitFor(() => active()?.document.uri.toString() === 'refyntra-metadata:/System.Runtime/System.String.cs', 'Navigate To opened the decompiled String', 60000);
      // A symbol with source: the command opens the declaration in the solution.
      await open('Shop.Api/Program.cs', 'CancelOrderCommand(id)', 1);
      const src = await vscode.commands.executeCommand('refyntra.goToMetadata');
      assert.equal(src.kind, 'location', JSON.stringify(src));
      assert.match(active().document.uri.path, /OrderRequests\.cs$/);
    }],
    ['go to metadata: File Structure opens inherited library members; an external stack frame opens decompiled code', async () => {
      const a = await ready();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await open('Shop.Api/Services/AppError.cs', 'public AppError()', 'public '.length + 1);
      void vscode.commands.executeCommand('refyntra.fileStructure');
      await waitFor(() => a.fileStructure.state().open && a.fileStructure.state().ready, 'File Structure list', 120000);
      await a.fileStructure.setFilter('properties', true);
      await a.fileStructure.setFilter('inherited', true);
      await waitFor(() => a.fileStructure.state().ready && a.fileStructure.state().items.some((i) => i.section.includes('inherited from Exception')), 'inherited from Exception', 60000);
      const stack = a.fileStructure.state().items.find((i) => i.section.includes('inherited from Exception') && i.label.startsWith('StackTrace'));
      assert.ok(stack, JSON.stringify(a.fileStructure.state().items.map((i) => `${i.section} | ${i.label}`)));
      assert.match(stack.description, /library: opens decompiled/);
      assert.equal(await a.fileStructure.accept(stack.id), true);
      await waitFor(() => active()?.document.uri.scheme === 'refyntra-metadata' && /StackTrace/.test(activeLine()), 'decompiled Exception at StackTrace', 120000);
      assert.match(active().document.uri.toString(), /^refyntra-metadata:\/System\.Runtime\/System\.Exception\.cs$/);
      await a.fileStructure.setFilter('inherited', false);
      // Stack trace: a framework frame without source in the solution opens its decompiled method.
      const parsed = await vscode.commands.executeCommand('refyntra.openStackTrace', ['System.InvalidOperationException: boom', '   at System.Text.StringBuilder.Append(String value)'].join('\n'));
      assert.equal(parsed.frameCount, 1);
      const opened = await a.stackTrace.openFrame(0);
      assert.equal(opened.kind, 'opened', JSON.stringify(opened));
      assert.match(opened.uri, /^refyntra-metadata:\/[^/]+\/System\.Text\.StringBuilder\.cs$/);
      assert.match(activeLine(), /Append/);
      assert.match(opened.notice, /decompiled source/);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }],
  ];
};
