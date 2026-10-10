// EF Core migrations in a rename (protocol 1.5), on a temp copy of the EfCore fixture (runTest.mjs scenario
// "rename-efcore"; the repository fixture is never touched). The fixture has a migration, its Designer file and the
// model snapshot, all referencing ShopDbContext through [DbContext(typeof(ShopDbContext))].
//   (A) "Rename the class and update EF Core migrations": apply, the migrations get typeof(StoreDbContext) and keep
//       every string; Undo restores every file.
//   (B) "Rename only the class": the migrations are not edited, the plan is limited with the warning "The project
//       will not build until the migrations are updated", and applying needs the second confirmation.
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');

const CONTEXT = 'EfCore.Api/Data/ShopDbContext.cs';
const DESIGNER = 'EfCore.Api/Migrations/20250101000000_Initial.Designer.cs';
const SNAPSHOT = 'EfCore.Api/Migrations/ShopDbContextModelSnapshot.cs';

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode');
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const openDoc = (rel) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === file(rel).toString() && !d.isClosed);
  const name = (uri) => decodeURIComponent(uri.split('/').pop());

  async function prepare(a, generatedEdits) {
    const doc = await vscode.workspace.openTextDocument(file(CONTEXT));
    const i = doc.getText().indexOf('class ShopDbContext') + 6;
    const r = await a.engine.prepareRename({ uri: doc.uri.toString(), position: doc.positionAt(i) }, 'StoreDbContext', undefined, { generatedEdits });
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

  return [
    [
      'the temp EfCore copy loads (apply on)',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
        assert.ok(!file('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy');
      },
    ],
    [
      '(B) rename only the class: migrations untouched, limited with "will not build", apply needs the second confirmation',
      async () => {
        const a = await api();
        const disk = await fsp.readFile(file(DESIGNER).fsPath, 'utf8');
        const r = await prepare(a, 'none');
        assert.equal(r.plan.validation.status, 'limited');
        assert.equal(r.plan.efMigrations.mode, 'none');
        assert.deepEqual(r.plan.efMigrations.files.map(name).sort(), ['20250101000000_Initial.Designer.cs', 'ShopDbContextModelSnapshot.cs']);
        assert.ok(!r.plan.writeSet.some((c) => /Designer|Snapshot/.test(name(c.uri))), 'no edit in the migrations');
        assert.ok(r.plan.limitations.some((l) => l.startsWith('The project will not build until the migrations are updated')), JSON.stringify(r.plan.limitations));
        const first = await a.engine.applyRename(r.planId);
        assert.equal(first.status, 'limited', 'never applied without the explicit confirmation');
        assert.ok((first.limitations ?? []).some((l) => l.includes('will not build')));
        a.engine.discardPlan(r.planId);
        assert.ok(!openDoc(CONTEXT)?.isDirty);
        assert.equal(await fsp.readFile(file(DESIGNER).fsPath, 'utf8'), disk);
      },
    ],
    [
      '(A) rename the class and update EF Core migrations: apply (typeof only, strings kept), not saved, Undo restores',
      async () => {
        const a = await api();
        await revertAll();
        const before = new Map();
        for (const t of [CONTEXT, DESIGNER, SNAPSHOT]) before.set(t, await fsp.readFile(file(t).fsPath, 'utf8'));
        const r = await prepare(a, 'efMigrations');
        assert.equal(r.plan.validation.status, 'valid');
        assert.equal(r.plan.efMigrations.mode, 'efMigrations');
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        for (const t of [DESIGNER, SNAPSHOT]) {
          const doc = openDoc(t);
          assert.ok(doc && doc.isDirty, `${t} edited, not saved`);
          assert.equal(doc.getText().replace(/\r\n/g, '\n'), before.get(t).replace(/\r\n/g, '\n').replace('typeof(ShopDbContext)', 'typeof(StoreDbContext)'), `${t}: only typeof(...) changed`);
          assert.ok(doc.getText().includes('"EfCore.Domain.Order"'), 'strings are kept');
        }
        assert.ok(openDoc(SNAPSHOT).getText().includes('class ShopDbContextModelSnapshot'), 'the snapshot class keeps its name');
        assert.equal(await fsp.readFile(file(DESIGNER).fsPath, 'utf8'), before.get(DESIGNER), 'disk unchanged (no auto-save)');

        // Undo through the editor (one undo of a multi-file edit may undo every file).
        for (const d of vscode.workspace.textDocuments.filter((x) => x.uri.scheme === 'file' && x.getText().includes('StoreDbContext'))) {
          if (!d.getText().includes('StoreDbContext')) continue;
          await vscode.window.showTextDocument(d);
          await vscode.commands.executeCommand('undo');
        }
        await waitFor(() => !vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && d.getText().includes('StoreDbContext')), 'undo restored every file', 20000);
        for (const t of [DESIGNER, SNAPSHOT]) {
          const doc = openDoc(t);
          if (doc) assert.equal(doc.getText().replace(/\r\n/g, '\n'), before.get(t).replace(/\r\n/g, '\n'), `undo restored ${t}`);
        }
        await revertAll();
      },
    ],
  ];
};
