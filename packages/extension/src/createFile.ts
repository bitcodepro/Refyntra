import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ApplyOutcome, CancelledError, type EngineClient, type RenamePreview } from '@refyntra/application';
import { CSHARP_GENERATE_HANDLER_ACTION, CSHARP_MOVE_TYPE_ACTION, type PlannedChange, type PlannedTextChange, type Position } from '@refyntra/contracts';
import { runRecovery } from './actions';
import { shortPath, toPosition } from './convert';
import { createPreviewSummary, createdFilePreview, folderChoices, folderLabel, plannedCreates } from './createFileSummary';
import type { VsCodeEditApplier } from './editApplier';
import { type PreviewContentProvider, type StoredPreview } from './rename';
import { decodeUtf8, previewFile, sha256 } from './textEdits';

// Move Type to File and Generate handler: prepare → preview (new file as a diff from empty, edits of existing files) →
// confirm → revalidate → apply (create first, then text) → honest report, Undo.

export interface CreateActionRequest {
  uri: string;
  position: Position;
  /** Generate handler: the folder picked from the preview's folder choices. */
  targetFolderUri?: string;
}

const TITLES: Record<string, string> = { [CSHARP_MOVE_TYPE_ACTION]: 'Move Type to File', [CSHARP_GENERATE_HANDLER_ACTION]: 'Generate Handler' };

async function currentText(uri: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri && !d.isClosed);
  if (open) return open.getText();
  const text = decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri, true)));
  if (text === undefined) throw new Error(`${shortPath(uri)} is not UTF-8`);
  return text;
}

export async function buildCreatePreview(preview: RenamePreview): Promise<StoredPreview> {
  const files = [];
  for (const change of preview.plan.writeSet as readonly PlannedChange[]) {
    if (change.kind === 'create') files.push(createdFilePreview(change));
    else if (change.kind === 'text') files.push(previewFile(change, await currentText(change.uri)));
  }
  const invalid = files.some((f) => f.problem !== undefined);
  return { summary: createPreviewSummary(preview, files, invalid, shortPath), files, invalid };
}

/** Runs Move Type to File or Generate handler at the cursor (or for `seed`). */
export async function runCreateAction(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, actionId: string, seed?: CreateActionRequest): Promise<void> {
  const title = TITLES[actionId] ?? actionId;
  let req = seed;
  if (!req) {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file' || ed.document.languageId !== 'csharp') {
      void vscode.window.showInformationMessage(`Refyntra ${title}: place the cursor on a type in a C# file of the loaded solution.`);
      return;
    }
    req = { uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) };
  }
  const request = req;
  let outcome;
  try {
    outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refyntra: preparing ${title} preview`, cancellable: true }, (_p, token) =>
      engine.prepareAction({ uri: request.uri, position: request.position }, actionId, token, request.targetFolderUri ? { targetFolderUri: request.targetFolderUri } : {}),
    );
  } catch (e) {
    if (e instanceof CancelledError) return;
    throw e;
  }
  if (outcome.kind === 'unavailable') {
    const pick = await vscode.window.showWarningMessage(`${title} unavailable: ${outcome.message}`, ...outcome.recoveryActions.map((r) => r.title));
    await runRecovery(outcome.recoveryActions.find((r) => r.title === pick));
    return;
  }
  const planId = outcome.planId;
  let stored: StoredPreview;
  try {
    stored = await buildCreatePreview(outcome);
  } catch (e) {
    engine.discardPlan(planId);
    void vscode.window.showWarningMessage(`Refyntra: the preview cannot be shown: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  previews.store(planId, stored);
  const summaryDoc = await vscode.workspace.openTextDocument(previews.summaryUri(planId, `${title} preview.md`));
  await vscode.languages.setTextDocumentLanguage(summaryDoc, 'markdown');
  await vscode.window.showTextDocument(summaryDoc, { preview: true, preserveFocus: true });

  type Pick = vscode.QuickPickItem & { action: 'diff' | 'apply' | 'disabled' | 'folder'; index?: number };
  const items: Pick[] = [];
  const canApply = outcome.applyEnabled && !stored.invalid;
  if (canApply) items.push({ label: `$(check) Apply`, description: 'revalidates first; creates the new file, then edits (not saved)', action: 'apply' });
  else items.push({ label: stored.invalid ? '$(error) Preview invalid — cannot be applied' : '$(lock) Preview only — applying is off', action: 'disabled' });
  const choices = folderChoices(outcome.plan);
  if (choices.length > 1) items.push({ label: '$(folder) Change folder…', description: `${choices.length} folders with handlers (default: where most handlers live)`, action: 'folder' });
  const created = new Set(plannedCreates(outcome.plan).map((c) => c.uri));
  items.push(...stored.files.map((f, index): Pick => ({ label: `$(diff) ${shortPath(f.uri)}`, description: created.has(f.uri) ? 'new file · open diff from empty' : `open diff · ${f.editCount} edit(s)`, action: 'diff', index })));

  const qp = vscode.window.createQuickPick<Pick>();
  qp.title = `${outcome.plan.title} — preview`;
  qp.placeholder = canApply ? 'Open a diff, or choose Apply; Esc cancels (nothing is changed)' : 'Select a file to open its diff; Esc closes the preview';
  qp.items = items;
  qp.ignoreFocusOut = true;
  let applying = false;
  qp.onDidAccept(async () => {
    try {
      const pick = qp.selectedItems[0];
      if (!pick) return;
      if (pick.action === 'diff' && pick.index !== undefined) {
        const f = stored.files[pick.index]!;
        await vscode.commands.executeCommand('vscode.diff', previews.fileUri(planId, pick.index, 'original', f.uri), previews.fileUri(planId, pick.index, 'modified', f.uri), `${path.posix.basename(vscode.Uri.parse(f.uri).path)} (${title} preview)`, { preview: true, preserveFocus: true });
        return;
      }
      if (pick.action === 'folder') {
        const folder = await vscode.window.showQuickPick(
          choices.map((c) => ({ ...folderLabel(c, shortPath), folderUri: c.folderUri })),
          { title: 'Refyntra: folder for the new handler', placeHolder: 'Existing handler folders (most handlers first), then the folder of the request' },
        );
        if (!folder) return;
        qp.hide();
        await runCreateAction(engine, previews, applier, actionId, { ...request, targetFolderUri: folder.folderUri });
        return;
      }
      if (pick.action === 'disabled' || !canApply) {
        void vscode.window.showInformationMessage(stored.invalid ? 'Refyntra: this preview is invalid and cannot be applied.' : 'Applying is turned off (refyntra.rename.apply). No file was changed.');
        return;
      }
      applying = true;
      qp.hide();
      const plan = outcome.plan;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refyntra: revalidating and applying ${title}`, cancellable: true }, (_p, token) =>
        engine.applyRename(planId, token),
      );
      await reportCreateApply(engine, previews, applier, actionId, request, plan.writeSet as readonly PlannedChange[], result);
    } catch (e) {
      if (e instanceof CancelledError) return;
      void vscode.window.showErrorMessage(`Refyntra ${title} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  qp.onDidHide(() => {
    if (!applying) engine.discardPlan(planId);
    qp.dispose();
  });
  qp.show();
}

/** Honest result: created/edited per file; Undo deletes the new file and undoes the edit (only while they are unchanged). */
export async function reportCreateApply(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, actionId: string, req: CreateActionRequest, writeSet: readonly PlannedChange[], result: ApplyOutcome): Promise<void> {
  if (result.status === 'applied') {
    const first = writeSet.find((c) => c.kind === 'create');
    if (first) await vscode.window.showTextDocument(vscode.Uri.parse(first.uri, true), { preview: false, preserveFocus: true });
    const pick = await vscode.window.showInformationMessage(`Refyntra: ${result.message}. The new file is on disk; edited files are not saved.`, 'Undo');
    if (pick === 'Undo') await showUndo(await undoCreate(engine, applier, writeSet));
    return;
  }
  if (result.status === 'stale' && result.canReprepare) {
    const pick = await vscode.window.showWarningMessage(`Refyntra: The code changed since the preview. Nothing was applied. ${result.message}`, 'Prepare again');
    if (pick === 'Prepare again') await runCreateAction(engine, previews, applier, actionId, req);
    return;
  }
  if (result.createdOnly) {
    const pick = await vscode.window.showWarningMessage(`Refyntra: ${result.message}`, 'Delete the new file');
    if (pick === 'Delete the new file') await showUndo(await undoCreate(engine, applier, writeSet));
    return;
  }
  void vscode.window.showWarningMessage(`Refyntra: not applied (${result.status}): ${result.message}`);
}

async function showUndo(lines: string[]): Promise<void> {
  void vscode.window.showInformationMessage(`Refyntra Undo: ${lines.join(' ')}`);
}

/**
 * Undo of a create-file plan, step by step and only on unchanged state: the edits of existing files are undone with the
 * editor's Undo while their text is still exactly the planned result; the new file is deleted while it still has exactly
 * the planned text (editor and disk) and has no unsaved changes. Every step is reported; nothing is forced.
 */
export async function undoCreate(engine: EngineClient, applier: VsCodeEditApplier, writeSet: readonly PlannedChange[]): Promise<string[]> {
  const out: string[] = [];
  let deleted = false;
  const openDoc = (uri: string) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri && !d.isClosed);
  for (const change of writeSet.filter((c): c is PlannedTextChange => c.kind === 'text')) {
    const doc = openDoc(change.uri);
    if (!doc || sha256(doc.getText()) !== change.resultHash) {
      out.push(`${shortPath(change.uri)} changed after the apply; its edit was not undone.`);
      continue;
    }
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('undo');
    out.push(sha256(doc.getText()) === change.expectedHash ? `${shortPath(change.uri)}: edit undone.` : `${shortPath(change.uri)}: Undo did not restore the original text; check the file.`);
  }
  for (const change of writeSet.filter((c) => c.kind === 'create')) {
    const uri = vscode.Uri.parse(change.uri, true);
    const doc = openDoc(change.uri);
    let disk: string | undefined;
    try {
      disk = decodeUtf8(await vscode.workspace.fs.readFile(uri));
    } catch {
      disk = undefined;
    }
    if (disk === undefined) {
      out.push(`${shortPath(change.uri)} no longer exists.`);
      continue;
    }
    if ((doc && (doc.isDirty || sha256(doc.getText()) !== change.resultHash)) || sha256(disk) !== change.resultHash) {
      out.push(`${shortPath(change.uri)} changed after the apply; it was not deleted.`);
      continue;
    }
    const ok = await applier.deleteCreatedFile(uri, change.resultHash);
    out.push(ok ? `${shortPath(change.uri)} deleted.` : `${shortPath(change.uri)} could not be deleted.`);
    deleted ||= ok;
  }
  // The backend added the created file as a document; a deleted file leaves it only with a reload of the C# route.
  if (deleted) {
    out.push('The C# analysis reloaded the workspace.');
    await engine.restart().catch(() => undefined);
  }
  return out;
}
