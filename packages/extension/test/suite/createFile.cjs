// Created files e2e: Move Type to File and Generate handler on a temp copy of Shop (runTest.mjs scenario "create-file"
// adds the files below and restores the copy; the repository fixture is never touched).
//   Shop.Api/Services/MovePair.cs     Mover moves to Mover.cs (apply, host resync, Undo)
//   Shop.Api/Services/RacePair.cs     Racer.cs created by another program between preview and apply (stale)
//   Shop.Api/Services/FailPair.cs     the create is rejected (failed, nothing changed)
//   Shop.Api/Services/HalfPair.cs     the create succeeds, the text edit is rejected (createdOnly, delete offered)
//   Shop.Contracts/Orders/ArchiveRequests.cs  ArchiveOrderCommand without a handler (Generate handler)
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const pair = (first, second) =>
  `namespace Shop.Api.Services;\n\npublic sealed class ${first}\n{\n    public int Value() => 1;\n}\n\npublic sealed class ${second}\n{\n    public int Other() => new ${first}().Value();\n}\n`;

exports.extraFiles = {
  'Shop.Api/Services/MovePair.cs': pair('Mover', 'Stayer'),
  'Shop.Api/Services/RacePair.cs': pair('Racer', 'Waiter'),
  'Shop.Api/Services/FailPair.cs': pair('Failer', 'Holder'),
  'Shop.Api/Services/HalfPair.cs': pair('Halver', 'Keeper'),
  'Shop.Contracts/Orders/ArchiveRequests.cs': 'using MediatR;\n\nnamespace Shop.Contracts.Orders;\n\npublic sealed record ArchiveOrderCommand(int Id) : IRequest<bool>;\n',
};

exports.cases = ({ api, csharp, waitFor }) => {
  const vscode = require('vscode'); // only inside the Extension Host (runTest.mjs reads extraFiles outside it)
  const file = (rel) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, ...rel.split('/'));
  const svc = (name) => file(`Shop.Api/Services/${name}.cs`);
  const openDoc = (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString() && !d.isClosed);
  const exists = (uri) => fs.existsSync(uri.fsPath);

  /** Move Type to File prepared on the declaration of `type` in `pairFile`. */
  async function prepareMove(a, pairFile, type) {
    const doc = await vscode.workspace.openTextDocument(svc(pairFile));
    const i = doc.getText().indexOf(`class ${type}`);
    assert.ok(i >= 0);
    const r = await a.engine.prepareAction({ uri: doc.uri.toString(), position: doc.positionAt(i + 6) }, 'csharp.moveTypeToFile');
    assert.equal(r.kind, 'preview', JSON.stringify(r));
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.plan.writeSet.map((c) => c.kind), ['create', 'text']);
    return r;
  }

  async function revertAll() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  async function hostSees(a, typeName, uri) {
    await waitFor(async () => {
      const found = await a.engine.find(`type: ${typeName}`);
      return found.items.some((i) => i.label === typeName && JSON.stringify(i).includes(uri.toString()));
    }, `host sees ${typeName} in ${uri.path}`, 60000);
  }

  return [
    [
      'the temp Shop copy with the create-file files loads (apply on)',
      async () => {
        const a = await api();
        await waitFor(() => ['Ready', 'Partial', 'Failed'].includes(csharp(a.health())?.state), 'host ready', 240000);
        assert.equal(csharp(a.health()).state, 'Ready');
        assert.ok(!file('').fsPath.includes(`tests${require('node:path').sep}fixtures`), 'runs on a temp copy');
      },
    ],
    [
      'Actions offers Move Type to File on the declaration and Generate handler on a request without a handler',
      async () => {
        const a = await api();
        const doc = await vscode.workspace.openTextDocument(svc('MovePair'));
        const move = await a.engine.actions({ uri: doc.uri.toString(), position: doc.positionAt(doc.getText().indexOf('class Mover') + 6) });
        assert.equal(move.items.find((x) => x.capabilityId === 'csharp.moveTypeToFile')?.state, 'available', JSON.stringify(move.items.map((x) => x.capabilityId)));
        const req = await vscode.workspace.openTextDocument(file('Shop.Contracts/Orders/ArchiveRequests.cs'));
        const gen = await a.engine.actions({ uri: req.uri.toString(), position: req.positionAt(req.getText().indexOf('ArchiveOrderCommand')) });
        assert.equal(gen.items.find((x) => x.capabilityId === 'csharp.generateHandler')?.state, 'available');
        const handled = await vscode.workspace.openTextDocument(file('Shop.Contracts/Orders/OrderRequests.cs'));
        const exists = await a.engine.actions({ uri: handled.uri.toString(), position: handled.positionAt(handled.getText().indexOf('GetOrderQuery')) });
        const g = exists.items.find((x) => x.capabilityId === 'csharp.generateHandler');
        assert.equal(g?.state, 'unavailable');
        assert.equal(g?.reasonCode, 'HandlerExists');
        assert.equal(a.capabilityUi('csharp.moveTypeToFile').command, 'refyntra.moveTypeToFile');
      },
    ],
    [
      'Move Type to File: create first, then the edit (not saved); host resynced without reload; Undo restores both',
      async () => {
        const a = await api();
        const source = svc('MovePair');
        const target = svc('Mover');
        const sourceDisk = await fsp.readFile(source.fsPath);
        const r = await prepareMove(a, 'MovePair', 'Mover');
        const created = r.plan.writeSet[0];
        assert.equal(created.uri, target.toString());
        const epoch = csharp(a.health()).sessionEpoch;
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.match(out.message, /Mover\.cs created and 1 file\(s\) changed/);
        assert.deepEqual(out.resources.map((x) => [x.kind, x.status]), [['create', 'confirmed']]);
        assert.equal(await fsp.readFile(target.fsPath, 'utf8'), created.text, 'the new file has exactly the previewed text');
        const src = openDoc(source);
        assert.ok(src && src.isDirty, 'the original is edited, not saved');
        assert.ok(!src.getText().includes('class Mover'));
        assert.deepEqual(await fsp.readFile(source.fsPath), sourceDisk, 'disk keeps the original until saved');
        await hostSees(a, 'Mover', target);
        assert.equal(csharp(a.health()).sessionEpoch, epoch, 'no restart: resynced by didCreateFiles');
        // Undo: the edit through the editor's Undo, then the unchanged new file is deleted.
        const lines = await a.undoCreate(r.plan.writeSet);
        assert.notEqual(csharp(a.health()).sessionEpoch, epoch, 'the deleted file left the host by a reload');
        assert.ok(lines.some((l) => /edit undone/.test(l)), lines.join(' '));
        assert.ok(lines.some((l) => /deleted/.test(l)), lines.join(' '));
        assert.ok(!exists(target), 'the new file is gone');
        assert.equal(openDoc(source).getText(), sourceDisk.toString('utf8').replace(/^﻿/, ''), 'the original text is back');
        await waitFor(() => csharp(a.health()).state === 'Ready', 'route ready after the reload', 240000);
        await revertAll();
      },
    ],
    [
      'Move Type to File: the target created between preview and apply → stale, nothing applied',
      async () => {
        const a = await api();
        await waitFor(() => csharp(a.health()).state === 'Ready', 'route ready', 240000);
        const source = svc('RacePair');
        const target = svc('Racer');
        const before = await fsp.readFile(source.fsPath);
        const r = await prepareMove(a, 'RacePair', 'Racer');
        await fsp.writeFile(target.fsPath, '// created by another program\n');
        try {
          const out = await a.engine.applyRename(r.planId);
          assert.equal(out.status, 'stale', out.message);
          assert.match(out.message, /changed since the preview/);
          assert.equal(await fsp.readFile(target.fsPath, 'utf8'), '// created by another program\n');
          assert.ok(openDoc(source).getText().includes('class Racer'), 'the original is not edited');
          assert.deepEqual(await fsp.readFile(source.fsPath), before);
        } finally {
          await fsp.rm(target.fsPath, { force: true });
        }
      },
    ],
    [
      'Move Type to File: the create fails (fault injection) → failed, honest, nothing changed',
      async () => {
        const a = await api();
        const source = svc('FailPair');
        const r = await prepareMove(a, 'FailPair', 'Failer');
        a.editApplier.faults.rejectNextCreate = true;
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'failed', out.message);
        assert.match(out.message, /the file was not created .*no file was changed/);
        assert.deepEqual(out.resources.map((x) => [x.kind, x.status]), [['create', 'failed']]);
        assert.deepEqual(out.files.map((f) => f.status), ['unchanged']);
        assert.ok(!exists(svc('Failer')));
        assert.ok(openDoc(source).getText().includes('class Failer'));
        assert.ok(!openDoc(source).isDirty);
      },
    ],
    [
      'Move Type to File: created, then the text edit is rejected → createdOnly, exact report, the new file can be deleted',
      async () => {
        const a = await api();
        const source = svc('HalfPair');
        const r = await prepareMove(a, 'HalfPair', 'Halver');
        a.editApplier.faults.rejectNextApply = true;
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'failed', out.message);
        assert.equal(out.createdOnly, true);
        assert.match(out.message, /Halver\.cs was created, but the edit of HalfPair\.cs was not applied.*Nothing was rolled back/);
        assert.ok(exists(svc('Halver')));
        assert.ok(openDoc(source).getText().includes('class Halver'), 'the original is unchanged');
        const lines = await a.undoCreate(r.plan.writeSet);
        assert.ok(lines.some((l) => /HalfPair\.cs changed after the apply|edit was not undone/.test(l)), lines.join(' '));
        assert.ok(!exists(svc('Halver')), 'the new file was deleted');
        await waitFor(() => csharp(a.health()).state === 'Ready', 'route ready after the reload', 240000);
      },
    ],
    [
      'Generate handler: created in the folder with most handlers; the host sees the handler (Related on the request)',
      async () => {
        const a = await api();
        await waitFor(() => csharp(a.health()).state === 'Ready', 'route ready', 240000);
        const req = await vscode.workspace.openTextDocument(file('Shop.Contracts/Orders/ArchiveRequests.cs'));
        const at = { uri: req.uri.toString(), position: req.positionAt(req.getText().indexOf('ArchiveOrderCommand')) };
        const r = await a.engine.prepareAction(at, 'csharp.generateHandler');
        assert.equal(r.kind, 'preview', JSON.stringify(r));
        const target = file('Shop.Api/Handlers/ArchiveOrderCommandHandler.cs');
        assert.deepEqual(r.plan.writeSet.map((c) => [c.kind, c.uri]), [['create', target.toString()]]);
        assert.match(r.plan.writeSet[0].text, /public sealed class ArchiveOrderCommandHandler : IRequestHandler<ArchiveOrderCommand, bool>/);
        assert.match(r.plan.writeSet[0].text, /throw new NotImplementedException\(\);/);
        assert.match(r.plan.writeSet[0].text, /namespace Shop\.Api\.Handlers;/);
        assert.ok(r.plan.limitations.some((l) => /No DI registration is generated/.test(l)));
        assert.ok(r.plan.fileCreate.folderChoices.length >= 2);
        const out = await a.engine.applyRename(r.planId);
        assert.equal(out.status, 'applied', out.message);
        assert.equal(await fsp.readFile(target.fsPath, 'utf8'), r.plan.writeSet[0].text);
        await waitFor(async () => {
          const rel = await a.engine.related(at);
          return rel.kind === 'related' && rel.groups.some((g) => g.relations.some((x) => x.relationKind === 'mediatr.handler' && JSON.stringify(x).includes('ArchiveOrderCommandHandler')));
        }, 'Related shows the generated handler', 60000);
      },
    ],
  ];
};
