// Code Cleanup e2e on a temp copy of the Cleanup fixture (runTest.mjs scenario "cleanup"; the repository fixture is
// never touched): clean up a folder, apply (edited in the editor, not saved), a second run finds nothing, Undo restores
// every file; a plan whose file changed after the preview is stale and nothing is applied.
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const ALL = ['removeUnnecessaryUsings', 'sortUsings', 'fileScopedNamespace', 'whitespace'];
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const openDoc = (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri && !d.isClosed);

  async function revertAll() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  return [
    [
      'the temp Cleanup copy loads; Code Cleanup is a registered command',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
        assert.ok(!file('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy');
        assert.ok((await vscode.commands.getCommands(true)).includes('refyntra.cleanup'));
      },
    ],
    [
      'clean up a folder: one preview, apply (not saved), a second run finds nothing, Undo restores every file',
      async () => {
        const a = await api();
        const folder = file('Cleanup.App/Services');
        const r = await a.engine.prepareCleanup({ scopeUris: [folder.toString()], fixes: ALL });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        assert.deepEqual(r.issues, []);
        assert.ok(r.plan.writeSet.every((c) => c.kind === 'text'));
        const messy = file('Cleanup.App/Services/Messy.cs').toString();
        const report = r.plan.cleanup;
        assert.deepEqual(report.files.find((f) => f.uri === messy).fixes.map((x) => x.fixId), ALL);
        assert.ok(report.skipped.some((s) => s.reasonCode === 'ConditionalCompilation'), JSON.stringify(report.skipped));
        // Originals (disk) and the previewed results.
        const entries = [];
        for (const c of r.plan.writeSet) {
          const original = await fsp.readFile(vscode.Uri.parse(c.uri).fsPath, 'utf8');
          assert.equal(sha256(original), c.expectedHash);
          entries.push({ uri: c.uri, original, expectedHash: c.expectedHash, resultHash: c.resultHash });
        }
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.equal(out.files.length, r.plan.writeSet.length);
        for (const e of entries) {
          const doc = openDoc(e.uri);
          assert.ok(doc && doc.isDirty, `${e.uri} is edited, not saved`);
          assert.equal(sha256(doc.getText()), e.resultHash);
          assert.equal(await fsp.readFile(vscode.Uri.parse(e.uri).fsPath, 'utf8'), e.original, 'disk keeps the original until saved');
        }
        assert.match(openDoc(messy).getText(), /^using System;\r?\nusing System\.Linq;\r?\nusing Cleanup\.App\.Models;\r?\n\r?\nnamespace Cleanup\.App\.Services;/);
        // Idempotent: the host sees the edited buffers; a second run has nothing to do.
        await waitFor(async () => {
          const again = await a.engine.prepareCleanup({ scopeUris: [folder.toString()], fixes: ALL });
          if (again.kind === 'preview') a.engine.discardPlan(again.planId);
          return again.kind === 'unavailable' && again.reasonCode === 'NoChanges';
        }, 'a second cleanup finds nothing to change', 60000);
        // Undo: every file is back to its original text.
        const lines = await a.undoCleanup(entries);
        assert.ok(lines.every((l) => /restored/.test(l)), lines.join(' '));
        for (const e of entries) assert.equal(openDoc(e.uri).getText(), e.original);
        await revertAll();
      },
    ],
    [
      'a file edited after the preview makes the plan stale; nothing is applied',
      async () => {
        const a = await api();
        const messy = file('Cleanup.App/Services/Messy.cs');
        const r = await a.engine.prepareCleanup({ scopeUris: [messy.toString()], fixes: ['whitespace'] });
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const doc = await vscode.workspace.openTextDocument(messy);
        const ed = await vscode.window.showTextDocument(doc);
        await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// typed\n'));
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'stale', out.message);
        assert.ok(doc.getText().startsWith('// typed\n'), 'the user edit stays');
        assert.ok(doc.getText().includes('class Messy   '), 'no cleanup edit was applied');
        await revertAll();
      },
    ],
  ];
};
