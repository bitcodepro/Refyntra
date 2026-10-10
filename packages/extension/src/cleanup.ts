import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ApplyOutcome, CancelledError, type EngineClient, type RenamePreview } from '@refyntra/application';
import type { PlannedChange, PlannedTextChange } from '@refyntra/contracts';
import { runRecovery } from './actions';
import { CLEANUP_FIXES, type UndoEntry, cleanupPreviewSummary, cleanupReport, fixTitle, profileFromSetting, undoDecision } from './cleanupSummary';
import { shortPath } from './convert';
import type { PreviewContentProvider, StoredPreview } from './rename';
import { decodeUtf8, previewFile, sha256 } from './textEdits';
import type { VsCodeEditApplier } from './editApplier';

// Code Cleanup: scope (file / folder / project / solution) → fixes (profile + per-run toggle) → prepare → preview
// (summary with per-fix counts and skipped files, per-file diffs) → confirm → revalidate → apply (one EditApplier, not
// saved) → honest report, Undo.

async function currentText(uri: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri && !d.isClosed);
  if (open) return open.getText();
  const text = decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri, true)));
  if (text === undefined) throw new Error(`${shortPath(uri)} is not UTF-8`);
  return text;
}

export async function buildCleanupPreview(preview: RenamePreview): Promise<StoredPreview> {
  const files = [];
  for (const change of preview.plan.writeSet) if (change.kind === 'text') files.push(previewFile(change, await currentText(change.uri)));
  const invalid = files.some((f) => f.problem !== undefined);
  return { summary: cleanupPreviewSummary(preview, files, invalid, shortPath), files, invalid };
}

/** The scope: the URI the command was run on (Explorer), or a choice of file / folder / project / whole workspace. */
async function pickScope(arg?: unknown): Promise<string[] | undefined> {
  if (arg instanceof vscode.Uri && arg.scheme === 'file') return [arg.toString()];
  type Pick = vscode.QuickPickItem & { scope: () => Promise<string[] | undefined> };
  const items: Pick[] = [];
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file' && ed.document.languageId === 'csharp') {
    const file = ed.document.uri;
    items.push({ label: '$(file-code) Current file', description: shortPath(file.toString()), scope: async () => [file.toString()] });
    const folder = vscode.Uri.file(path.dirname(file.fsPath));
    items.push({ label: '$(folder) Folder of the current file', description: shortPath(folder.toString()), scope: async () => [folder.toString()] });
  }
  items.push({
    label: '$(folder-opened) Folder…',
    scope: async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: 'Clean up this folder' });
      return picked?.[0] ? [picked[0].toString()] : undefined;
    },
  });
  items.push({
    label: '$(project) Project…',
    scope: async () => {
      const projects = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 500);
      const pick = await vscode.window.showQuickPick(projects.map((u) => ({ label: path.basename(u.fsPath), description: shortPath(u.toString()), uri: u })), { title: 'Refyntra Code Cleanup: project' });
      return pick ? [pick.uri.toString()] : undefined;
    },
  });
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length) items.push({ label: '$(root-folder) Whole workspace', description: `${folders.length} folder(s)`, scope: async () => folders.map((f) => f.uri.toString()) });
  const pick = await vscode.window.showQuickPick(items, { title: 'Refyntra Code Cleanup: what to clean up', placeHolder: 'Every C# file of the loaded solution in the scope; a preview comes first' });
  return pick ? pick.scope() : undefined;
}

/** The fixes of this run: the profile (setting refyntra.cleanup.profile) pre-selected, toggled per run. */
async function pickFixes(): Promise<string[] | undefined> {
  const profile = profileFromSetting(vscode.workspace.getConfiguration('refyntra').get('cleanup.profile'));
  type Pick = vscode.QuickPickItem & { id: string };
  const items: Pick[] = CLEANUP_FIXES.filter((f) => f.offered).map((f) => ({ label: f.label, detail: f.detail, id: f.id, picked: profile.includes(f.id) }));
  const notOffered = CLEANUP_FIXES.filter((f) => !f.offered);
  const picks = await vscode.window.showQuickPick(items, {
    title: 'Refyntra Code Cleanup: fixes',
    placeHolder: `Profile: refyntra.cleanup.profile. ${notOffered.map((f) => `${f.label}: not available`).join('; ')}`,
    canPickMany: true,
  });
  if (!picks) return undefined;
  return picks.map((p) => p.id);
}

/** Runs Code Cleanup on `arg` (an Explorer URI) or a picked scope. */
export async function runCleanup(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, arg?: unknown, seed?: { scopeUris: string[]; fixes: string[] }): Promise<void> {
  const scopeUris = seed?.scopeUris ?? (await pickScope(arg));
  if (!scopeUris?.length) return;
  const fixes = seed?.fixes ?? (await pickFixes());
  if (!fixes) return;
  if (fixes.length === 0) {
    void vscode.window.showInformationMessage('Refyntra Code Cleanup: no fix selected; nothing to do.');
    return;
  }
  let outcome;
  try {
    outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refyntra: preparing Code Cleanup preview', cancellable: true }, (_p, token) =>
      engine.prepareCleanup({ scopeUris, fixes }, token),
    );
  } catch (e) {
    if (e instanceof CancelledError) return;
    throw e;
  }
  if (outcome.kind === 'unavailable') {
    if (outcome.reasonCode === 'NoChanges') {
      void vscode.window.showInformationMessage(`Refyntra: ${outcome.message}`);
      return;
    }
    const pick = await vscode.window.showWarningMessage(`Code Cleanup unavailable: ${outcome.message}`, ...outcome.recoveryActions.map((r) => r.title));
    await runRecovery(outcome.recoveryActions.find((r) => r.title === pick));
    return;
  }
  const planId = outcome.planId;
  let stored: StoredPreview;
  try {
    stored = await buildCleanupPreview(outcome);
  } catch (e) {
    engine.discardPlan(planId);
    void vscode.window.showWarningMessage(`Refyntra: the preview cannot be shown: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  previews.store(planId, stored);
  const summaryDoc = await vscode.workspace.openTextDocument(previews.summaryUri(planId, 'Code Cleanup preview.md'));
  await vscode.languages.setTextDocumentLanguage(summaryDoc, 'markdown');
  await vscode.window.showTextDocument(summaryDoc, { preview: true, preserveFocus: true });

  type Pick = vscode.QuickPickItem & { action: 'diff' | 'apply' | 'disabled'; index?: number };
  const report = cleanupReport(outcome.plan);
  const canApply = outcome.applyEnabled && !stored.invalid;
  const items: Pick[] = [];
  if (canApply) items.push({ label: '$(check) Apply', description: 'revalidates first; edits the files in the editor (not saved)', action: 'apply' });
  else items.push({ label: stored.invalid ? '$(error) Preview invalid — cannot be applied' : '$(lock) Preview only — applying is off', action: 'disabled' });
  items.push(
    ...stored.files.map((f, index): Pick => {
      const counts = report?.files.find((x) => x.uri === f.uri)?.fixes.map((x) => `${fixTitle(x.fixId)} ${x.count}`).join(' · ');
      return { label: `$(diff) ${shortPath(f.uri)}`, description: counts ?? `${f.editCount} edit(s)`, action: 'diff', index };
    }),
  );
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
        await vscode.commands.executeCommand('vscode.diff', previews.fileUri(planId, pick.index, 'original', f.uri), previews.fileUri(planId, pick.index, 'modified', f.uri), `${path.posix.basename(vscode.Uri.parse(f.uri).path)} (Code Cleanup preview)`, { preview: true, preserveFocus: true });
        return;
      }
      if (pick.action === 'disabled' || !canApply) {
        void vscode.window.showInformationMessage(stored.invalid ? 'Refyntra: this preview is invalid and cannot be applied.' : 'Applying is turned off (refyntra.rename.apply). No file was changed.');
        return;
      }
      applying = true;
      qp.hide();
      const undo = undoEntries((outcome.plan.writeSet as readonly PlannedChange[]).filter((c): c is PlannedTextChange => c.kind === 'text'), stored);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refyntra: revalidating and applying Code Cleanup', cancellable: true }, (_p, token) =>
        engine.applyRename(planId, token),
      );
      await reportCleanupApply(engine, previews, applier, { scopeUris, fixes }, undo, result);
    } catch (e) {
      if (e instanceof CancelledError) return;
      void vscode.window.showErrorMessage(`Refyntra Code Cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  qp.onDidHide(() => {
    if (!applying) engine.discardPlan(planId);
    qp.dispose();
  });
  qp.show();
}

/** The Undo data of a plan: the previewed original text of every file. */
export function undoEntries(changes: readonly PlannedTextChange[], stored: StoredPreview): UndoEntry[] {
  return changes.flatMap((c) => {
    const f = stored.files.find((x) => x.uri === c.uri);
    return f ? [{ uri: c.uri, original: f.original, expectedHash: c.expectedHash, resultHash: c.resultHash }] : [];
  });
}

async function reportCleanupApply(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, seed: { scopeUris: string[]; fixes: string[] }, undo: UndoEntry[], result: ApplyOutcome): Promise<void> {
  if (result.status === 'applied') {
    const pick = await vscode.window.showInformationMessage(`Refyntra: ${result.message}. The files are not saved.`, 'Undo');
    if (pick === 'Undo') void vscode.window.showInformationMessage(`Refyntra Undo: ${(await undoCleanup(applier, undo)).join(' ')}`);
    return;
  }
  if (result.status === 'stale' && result.canReprepare) {
    const pick = await vscode.window.showWarningMessage(`Refyntra: The code changed since the preview. Nothing was applied. ${result.message}`, 'Prepare again');
    if (pick === 'Prepare again') await runCleanup(engine, previews, applier, undefined, seed);
    return;
  }
  const lines = result.files?.map((f) => `${shortPath(f.uri)}: ${f.status}`).join('; ');
  void vscode.window.showWarningMessage(`Refyntra: Code Cleanup not applied (${result.status}): ${result.message}${lines ? ` (${lines})` : ''}`);
}

/**
 * Undo of an applied cleanup: every file that is still exactly the planned result gets its previewed original back, in
 * one workspace edit (not saved); a file changed meanwhile is left alone. Reported per file; nothing is forced.
 */
export async function undoCleanup(applier: VsCodeEditApplier, entries: readonly UndoEntry[]): Promise<string[]> {
  const out: string[] = [];
  const restoring: UndoEntry[] = [];
  for (const e of entries) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === e.uri && !d.isClosed);
    const decision = undoDecision(e, doc?.getText());
    if (!decision.restore) {
      out.push(`${shortPath(e.uri)} ${decision.why}.`);
      continue;
    }
    restoring.push(e);
  }
  if (restoring.length === 0) return out;
  const ok = await applier.restoreTexts(restoring.map((e) => ({ uri: e.uri, fromHash: e.resultHash, text: e.original })));
  for (const e of restoring) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === e.uri && !d.isClosed);
    out.push(ok && doc && sha256(doc.getText()) === e.expectedHash ? `${shortPath(e.uri)}: restored.` : `${shortPath(e.uri)}: Undo did not restore the original text; check the file.`);
  }
  return out;
}
