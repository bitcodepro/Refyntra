// File rename e2e: rename a type together with its file, on a temp copy of Shop (runTest.mjs
// scenario "rename-file" adds the files below and restores the copy; the repository fixture is never touched).
//   Shop.Api/Services/ReportBuilder.cs  closed file, renamed with its type
//   Shop.Api/Services/Exporter.cs       open + dirty file, renamed with its type
//   Shop.Api/Services/Archiver.cs       target created between preview and apply (stale)
//   Shop.Api/Services/Packer.cs         target created after the text edits (rename refused, text applied), Undo
//   Shop.Api/Services/Sealer.cs         the editor rejects the file rename (failed, text applied)
//   Shop.Api/Services/Stamper.cs        the text apply is rejected (rename not attempted, nothing changed)
//   Shop.Api/Services/ServiceUsers.cs   uses every type above
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const USERS = 'Shop.Api/Services/ServiceUsers.cs';

exports.extraFiles = {
  'Shop.Api/Services/ReportBuilder.cs': 'namespace Shop.Api.Services;\n\npublic sealed class ReportBuilder\n{\n    public string Build() => nameof(ReportBuilder);\n}\n',
  'Shop.Api/Services/Exporter.cs': 'namespace Shop.Api.Services;\n\npublic sealed class Exporter\n{\n    public int Export() => 1;\n}\n',
  'Shop.Api/Services/Archiver.cs': 'namespace Shop.Api.Services;\n\npublic sealed class Archiver\n{\n}\n',
  'Shop.Api/Services/Packer.cs': 'namespace Shop.Api.Services;\n\npublic sealed class Packer\n{\n}\n',
  'Shop.Api/Services/Sealer.cs': 'namespace Shop.Api.Services;\n\npublic sealed class Sealer\n{\n}\n',
  'Shop.Api/Services/Stamper.cs': 'namespace Shop.Api.Services;\n\npublic sealed class Stamper\n{\n}\n',
  [USERS]:
    'namespace Shop.Api.Services;\n\npublic static class ServiceUsers\n{\n    public static ReportBuilder Report() => new ReportBuilder();\n    public static Exporter Export() => new Exporter();\n    public static Archiver Archive() => new Archiver();\n    public static Packer Pack() => new Packer();\n    public static Sealer Seal() => new Sealer();\n    public static Stamper Stamp() => new Stamper();\n}\n',
};

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode'); // only inside the Extension Host (runTest.mjs reads extraFiles outside it)
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const svc = (name) => `Shop.Api/Services/${name}.cs`;
  const openDoc = (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString() && !d.isClosed);
  const exists = (uri) => fs.existsSync(uri.fsPath);
  const tabUris = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input && t.input.uri && t.input.uri.toString()).filter(Boolean);

  /** Prepare from the usage in ServiceUsers.cs (so the declaring file can stay closed), with the file rename requested. */
  async function prepare(a, type, newName, renameFile = true) {
    const doc = await vscode.workspace.openTextDocument(file(USERS));
    const i = doc.getText().indexOf(`new ${type}()`);
    assert.ok(i >= 0, `${type} used in ServiceUsers.cs`);
    const r = await a.engine.prepareRename({ uri: doc.uri.toString(), position: doc.positionAt(i + 4) }, newName, undefined, { renameFile });
    assert.equal(r.kind, 'preview', JSON.stringify(r));
    assert.deepEqual(r.issues, []);
    return r;
  }

  async function revertAll() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  /** The host sees the renamed type in the file at `uri` (resynced through didRenameFiles, no reload). */
  async function hostSees(a, typeName, uri) {
    await waitFor(async () => {
      const found = await a.engine.find(`type: ${typeName}`);
      return found.items.some((i) => i.label === typeName && JSON.stringify(i).includes(uri.toString()));
    }, `host sees ${typeName} in ${uri.path}`, 60000);
  }

  return [
    [
      'the temp Shop copy with the file-rename files loads (apply on)',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
        assert.ok(!file('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy');
      },
    ],
    [
      'preview: the file rename is its own operation after the text edits; turned off, the plan is text-only',
      async () => {
        const a = await api();
        const r = await prepare(a, 'ReportBuilder', 'Summarizer');
        const kinds = r.plan.writeSet.map((c) => c.kind);
        assert.equal(kinds.at(-1), 'rename');
        assert.ok(kinds.indexOf('rename') > kinds.lastIndexOf('text'));
        const ren = r.plan.writeSet.find((c) => c.kind === 'rename');
        assert.equal(ren.oldUri, file(svc('ReportBuilder')).toString());
        assert.equal(ren.newUri, file(svc('Summarizer')).toString());
        assert.equal(r.plan.fileRename.included, true);
        a.engine.discardPlan(r.planId);
        const off = await prepare(a, 'ReportBuilder', 'Summarizer', false);
        assert.ok(off.plan.writeSet.every((c) => c.kind === 'text'));
        assert.equal(off.plan.fileRename.available, true);
        assert.equal(off.plan.fileRename.included, false);
        a.engine.discardPlan(off.planId);
      },
    ],
    [
      'closed file: text edits, then the file rename; reconciled, not saved, host resynced without reload',
      async () => {
        const a = await api();
        const oldUri = file(svc('ReportBuilder'));
        const newUri = file(svc('Summarizer'));
        assert.equal(openDoc(oldUri), undefined, 'ReportBuilder.cs is closed');
        const oldDisk = await fsp.readFile(oldUri.fsPath);
        const r = await prepare(a, 'ReportBuilder', 'Summarizer');
        const epoch = csharp(a.health()).sessionEpoch;
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.match(out.message, /ReportBuilder\.cs renamed to Summarizer\.cs/);
        assert.deepEqual(out.resources.map((x) => x.status), ['confirmed']);
        assert.ok(out.files.every((f) => f.status === 'confirmed'));
        assert.ok(!exists(oldUri), 'old file is gone');
        assert.ok(exists(newUri), 'new file exists');
        assert.deepEqual(await fsp.readFile(newUri.fsPath), oldDisk, 'the file was moved, not saved (disk keeps the old text)');
        const doc = openDoc(newUri);
        assert.ok(doc, 'the renamed document is loaded at the new path');
        assert.ok(doc.isDirty, 'not saved automatically');
        assert.match(doc.getText(), /class Summarizer/);
        assert.match(doc.getText(), /nameof\(Summarizer\)/);
        assert.equal(openDoc(oldUri), undefined);
        await hostSees(a, 'Summarizer', newUri);
        assert.equal(csharp(a.health()).sessionEpoch, epoch, 'no restart: resynced by didRenameFiles');
        await vscode.workspace.saveAll(false);
      },
    ],
    [
      'open dirty file: the unsaved text is kept, the editor follows the rename, Undo reverts the text edits',
      async () => {
        const a = await api();
        const oldUri = file(svc('Exporter'));
        const newUri = file(svc('Publisher'));
        const doc = await vscode.workspace.openTextDocument(oldUri);
        const ed = await vscode.window.showTextDocument(doc);
        await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// unsaved line\n'));
        assert.ok(doc.isDirty);
        const r = await prepare(a, 'Exporter', 'Publisher');
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.ok(!exists(oldUri) && exists(newUri));
        const moved = await waitFor(() => openDoc(newUri), 'document at the new path');
        assert.ok(moved.isDirty);
        assert.ok(moved.getText().startsWith('// unsaved line\n'), 'the dirty buffer is preserved');
        assert.match(moved.getText(), /class Publisher/);
        assert.ok(tabUris().includes(newUri.toString()), 'the open editor follows the rename');
        assert.ok(!tabUris().includes(oldUri.toString()));
        assert.equal(openDoc(oldUri), undefined);
        await hostSees(a, 'Publisher', newUri);
        // Undo of the text edits in the other edited file (ServiceUsers.cs) through the editor.
        const users = openDoc(file(USERS));
        assert.match(users.getText(), /new Publisher\(\)/);
        await vscode.window.showTextDocument(users);
        await vscode.commands.executeCommand('undo');
        await waitFor(() => !openDoc(file(USERS)).getText().includes('Publisher'), 'undo reverts the text edit in ServiceUsers.cs');
        await revertAll();
        await vscode.workspace.saveAll(false);
      },
    ],
    [
      'target created between preview and apply: stale, nothing applied, nothing renamed',
      async () => {
        const a = await api();
        const oldUri = file(svc('Archiver'));
        const target = file(svc('Vault'));
        const users = await fsp.readFile(file(USERS).fsPath);
        const r = await prepare(a, 'Archiver', 'Vault');
        await fsp.writeFile(target.fsPath, '// created by another program\n');
        try {
          const out = await a.engine.applyRename(r.planId);
          assert.equal(out.status, 'stale', out.message);
          assert.match(out.message, /changed since the preview/);
          assert.ok(exists(oldUri));
          assert.equal(await fsp.readFile(target.fsPath, 'utf8'), '// created by another program\n');
          assert.ok(!(openDoc(file(USERS))?.getText() ?? '').includes('Vault'));
          assert.deepEqual(await fsp.readFile(file(USERS).fsPath), users);
        } finally {
          await fsp.rm(target.fsPath, { force: true });
        }
      },
    ],
    [
      'the file rename fails after the text edits (target appears in that moment): reported honestly, text kept, Undo restores',
      async () => {
        const a = await api();
        await revertAll();
        const oldUri = file(svc('Packer'));
        const target = file(svc('Boxer'));
        const r = await prepare(a, 'Packer', 'Boxer');
        a.editApplier.faults.beforeFileRename = async () => {
          await fsp.writeFile(target.fsPath, '// raced in\n');
        };
        let out;
        try {
          out = await a.engine.applyRename(r.planId);
        } finally {
          a.editApplier.faults.beforeFileRename = undefined;
        }
        assert.equal(out.status, 'failed', out.message);
        assert.equal(out.textAppliedOnly, true);
        assert.deepEqual(out.resources.map((x) => x.status), ['refused']);
        assert.match(out.message, /text edits were applied to \d+ file\(s\).*Packer\.cs → Boxer\.cs: refused.*Nothing was rolled back/);
        assert.ok(out.files.every((f) => f.status === 'confirmed'));
        assert.ok(exists(oldUri), 'the old file is still there');
        assert.equal(await fsp.readFile(target.fsPath, 'utf8'), '// raced in\n', 'the other file is untouched');
        const packer = openDoc(oldUri);
        assert.match(packer.getText(), /class Boxer/, 'the text edits stay applied (no automatic rollback)');
        // Undo through the editor reverts the text edits.
        for (const uri of [oldUri, file(USERS)]) {
          const d = openDoc(uri);
          if (!d || !d.getText().includes('Boxer')) continue;
          await vscode.window.showTextDocument(d);
          await vscode.commands.executeCommand('undo');
        }
        await waitFor(() => !openDoc(oldUri).getText().includes('Boxer') && !openDoc(file(USERS)).getText().includes('Boxer'), 'undo restores both files');
        await fsp.rm(target.fsPath, { force: true });
        await revertAll();
      },
    ],
    [
      'the editor rejects the file rename: failed, text applied, the old file stays',
      async () => {
        const a = await api();
        const oldUri = file(svc('Sealer'));
        const r = await prepare(a, 'Sealer', 'Closer');
        a.editApplier.faults.rejectNextFileRename = true;
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'failed', out.message);
        assert.equal(out.textAppliedOnly, true);
        assert.deepEqual(out.resources.map((x) => x.status), ['failed']);
        assert.ok(exists(oldUri) && !exists(file(svc('Closer'))));
        assert.match(openDoc(oldUri).getText(), /class Closer/);
        await revertAll();
      },
    ],
    [
      'the text apply is rejected: the file rename is not attempted, nothing changed',
      async () => {
        const a = await api();
        const oldUri = file(svc('Stamper'));
        const disk = await fsp.readFile(oldUri.fsPath);
        const r = await prepare(a, 'Stamper', 'Marker');
        a.editApplier.faults.rejectNextApply = true;
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'failed', out.message);
        assert.match(out.message, /no file was changed/);
        assert.deepEqual(out.resources.map((x) => x.status), ['not-attempted']);
        assert.ok(exists(oldUri) && !exists(file(svc('Marker'))));
        assert.deepEqual(await fsp.readFile(oldUri.fsPath), disk);
      },
    ],
  ];
};
