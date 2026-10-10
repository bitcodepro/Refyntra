import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ApplyOutcome, CancelledError, type EngineClient, type RenamePreview } from '@refyntra/application';
import type { Position } from '@refyntra/contracts';
import { runRecovery } from './actions';
import { shortPath, toPosition } from './convert';
import { fileRenameItems, identifierPattern, previewTitle, renamePreviewSummary } from './renameSummary';
import { type PreviewFileModel, decodeUtf8, previewFile } from './textEdits';

export const PREVIEW_SCHEME = 'refyntra-preview';
const MAX_PREVIEWS = 5;

type PreviewFile = PreviewFileModel;

export interface StoredPreview {
  summary: string;
  files: PreviewFile[];
  /** A file's preview does not match the plan (the edits do not fit the current text): Apply is disabled. */
  invalid: boolean;
}

/** Read-only virtual documents for the rename preview (summary + per-file original/modified for diff). */
export class PreviewContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly previews = new Map<string, StoredPreview>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  get(planId: string): StoredPreview | undefined {
    return this.previews.get(planId);
  }

  store(planId: string, p: StoredPreview): void {
    this.previews.set(planId, p);
    while (this.previews.size > MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value as string);
  }

  summaryUri(planId: string, name = 'Rename preview.md'): vscode.Uri {
    return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${encodeURIComponent(planId)}/${name}` });
  }

  fileUri(planId: string, index: number, side: 'original' | 'modified', fileUri: string): vscode.Uri {
    const base = path.posix.basename(vscode.Uri.parse(fileUri).path);
    return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${encodeURIComponent(planId)}/${index}/${side}/${base}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = uri.path.split('/').filter(Boolean);
    const p = this.previews.get(decodeURIComponent(parts[0] ?? ''));
    if (!p) return 'This preview has expired. Run the Refyntra action again.';
    if (parts.length === 2) return p.summary;
    const f = p.files[Number(parts[1])];
    if (!f) return '';
    return parts[2] === 'modified' ? f.modified : f.original;
  }

  dispose(): void {
    this.changed.dispose();
    this.previews.clear();
  }
}

const isTsJs = (languageId: string) => /^(typescript|javascript)(react)?$/.test(languageId);

function identifierAt(doc: vscode.TextDocument, pos: vscode.Position): string {
  const range = doc.getWordRangeAtPosition(pos, isTsJs(doc.languageId) ? /[A-Za-z_$][\w$]*/ : /@?[A-Za-z_][A-Za-z0-9_]*/);
  return range ? doc.getText(range) : '';
}

/**
 * The editor's own Rename (F2) for a delegated route whose safety Refyntra cannot confirm. Explicitly
 * not validated by Refyntra; the editor and the language extension own the result.
 */
export async function runNativeRename(uri?: unknown, position?: unknown): Promise<void> {
  if (typeof uri === 'string' && position && typeof position === 'object') {
    const p = position as { line?: unknown; character?: unknown };
    if (typeof p.line !== 'number' || typeof p.character !== 'number') return;
    const target = vscode.Uri.parse(uri, true);
    if (target.scheme !== 'file') return;
    const doc = await vscode.workspace.openTextDocument(target);
    const ed = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(p.line, p.character);
    ed.selection = new vscode.Selection(pos, pos);
  }
  void vscode.window.showInformationMessage('Refyntra: using the editor Rename. This rename is not previewed or validated by Refyntra.');
  await vscode.commands.executeCommand('editor.action.rename');
}

/** Current text of a target without opening it (opening a document is an editor event that ends the apply lease). */
async function currentText(uri: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri && !d.isClosed);
  if (open) return open.getText();
  const text = decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri, true)));
  if (text === undefined) throw new Error(`${shortPath(uri)} is not UTF-8`);
  return text;
}

export async function buildPreview(preview: RenamePreview): Promise<StoredPreview> {
  const files: PreviewFile[] = [];
  for (const change of preview.plan.writeSet) {
    if (change.kind !== 'text') continue;
    files.push(previewFile(change, await currentText(change.uri)));
  }
  const invalid = files.some((f) => f.problem !== undefined);
  return { summary: renamePreviewSummary(preview, files, invalid, shortPath), files, invalid };
}

export interface RenameRequest {
  uri: string;
  position: Position;
  oldName: string;
  newName: string;
  /** File rename: also rename the file named after the type (default on; included only when proven safe). */
  renameFile?: boolean;
}

/** Rename: prepare → preview (summary + diffs) → confirm → revalidate → apply → reconcile. */
export async function runRename(engine: EngineClient, previews: PreviewContentProvider, seed?: RenameRequest): Promise<void> {
  let request = seed;
  if (!request) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      void vscode.window.showInformationMessage('Refyntra Rename: place the cursor on a symbol in a C#, TypeScript or JavaScript file.');
      return;
    }
    const doc = ed.document;
    const position = ed.selection.active;
    if (doc.uri.scheme !== 'file' || !engine.handlesDocument(doc.uri.toString(), doc.languageId)) {
      void vscode.window.showInformationMessage('Refyntra Rename works on C# files of the loaded solution and on TypeScript/JavaScript files. Use the editor Rename (F2) elsewhere.');
      return;
    }
    const current = identifierAt(doc, position);
    const pattern = identifierPattern(doc.languageId);
    const newName = await vscode.window.showInputBox({
      title: 'Refyntra: Rename',
      prompt: 'New name — a preview is shown first; nothing changes until you apply it',
      value: current,
      valueSelection: [0, current.length],
      validateInput: (v) => (pattern.test(v.trim()) ? undefined : 'Enter a valid identifier'),
    });
    if (!newName || newName.trim() === current) return;
    request = { uri: doc.uri.toString(), position: toPosition(position), oldName: current, newName: newName.trim() };
  }
  const req = request;

  let outcome;
  try {
    outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Refyntra: preparing rename preview', cancellable: true },
      (_p, token) => engine.prepareRename({ uri: req.uri, position: req.position }, req.newName, token, { renameFile: req.renameFile ?? true }),
    );
  } catch (e) {
    if (e instanceof CancelledError) return;
    throw e;
  }
  if (outcome.kind === 'unavailable') {
    const pick = await vscode.window.showWarningMessage(`Rename unavailable: ${outcome.message}`, ...outcome.recoveryActions.map((r) => r.title));
    await runRecovery(outcome.recoveryActions.find((r) => r.title === pick));
    return;
  }

  const planId = outcome.planId;
  let stored: StoredPreview;
  try {
    stored = await buildPreview(outcome);
  } catch (e) {
    engine.discardPlan(planId);
    void vscode.window.showWarningMessage(`Refyntra: the preview cannot be shown: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  previews.store(planId, stored);
  const summaryDoc = await vscode.workspace.openTextDocument(previews.summaryUri(planId));
  await vscode.languages.setTextDocumentLanguage(summaryDoc, 'markdown');
  await vscode.window.showTextDocument(summaryDoc, { preview: true, preserveFocus: true });

  type Pick = vscode.QuickPickItem & { action: 'diff' | 'apply' | 'disabled' | 'toggleFile' | 'fileInfo'; index?: number };
  const items: Pick[] = [];
  const limited = outcome.plan.validation.status === 'limited';
  const canApply = outcome.applyEnabled && !stored.invalid;
  const delegated = outcome.plan.kind === 'delegated';
  if (canApply) items.push({ label: '$(check) Apply rename', description: delegated ? 'provider-managed semantic coverage: asks the provider again and for confirmation; files are not saved' : limited ? 'validation is limited: asks for confirmation; files are not saved' : 'revalidates first; files are not saved', action: 'apply' });
  else if (stored.invalid) items.push({ label: '$(error) Preview invalid — cannot be applied', detail: 'The planned edits do not match the current text (see the summary). Run Rename again.', action: 'disabled' });
  else items.push({ label: '$(lock) Preview only — applying is off', detail: outcome.issues.length ? 'The plan has problems (see the summary).' : 'Turn on refyntra.rename.apply to apply renames.', action: 'disabled' });
  items.push(...fileRenameItems(outcome.plan));
  items.push(...stored.files.map((f, index): Pick => ({ label: `$(diff) ${shortPath(f.uri)}`, description: `open diff · ${f.editCount} edit(s)`, action: 'diff', index })));

  const qp = vscode.window.createQuickPick<Pick>();
  qp.title = previewTitle(outcome.plan);
  qp.placeholder = canApply ? 'Open a diff, or choose Apply rename; Esc cancels (nothing is changed)' : 'Select a file to open its diff; Esc closes the preview';
  qp.items = items;
  qp.ignoreFocusOut = true;
  let applying = false;
  qp.onDidAccept(async () => {
    try {
      const pick = qp.selectedItems[0];
      if (!pick) return;
      if (pick.action === 'diff' && pick.index !== undefined) {
        const f = stored.files[pick.index]!;
        await vscode.commands.executeCommand('vscode.diff', previews.fileUri(planId, pick.index, 'original', f.uri), previews.fileUri(planId, pick.index, 'modified', f.uri), `${path.posix.basename(vscode.Uri.parse(f.uri).path)} (Rename preview)`, { preview: true, preserveFocus: true });
        return;
      }
      if (pick.action === 'toggleFile') {
        // A different plan (with or without the file rename): this one is discarded, a new preview is prepared.
        qp.hide();
        await runRename(engine, previews, { ...req, renameFile: !(outcome.plan.kind === 'owned-semantic' && outcome.plan.fileRename?.included) });
        return;
      }
      if (pick.action === 'fileInfo') {
        void vscode.window.showInformationMessage(`Refyntra: ${pick.detail ?? pick.label}`);
        return;
      }
      if (pick.action === 'disabled' || !canApply) {
        void vscode.window.showInformationMessage(stored.invalid ? 'Refyntra: this preview is invalid and cannot be applied. Run Rename again.' : 'Rename is preview-only (refyntra.rename.apply is off). No file was changed.');
        return;
      }
      // A limited plan needs a second, explicit confirmation that lists what could not be validated.
      let acceptLimited = false;
      if (limited) {
        const ok = await vscode.window.showWarningMessage(
          delegated
            ? `${outcome.plan.title}: provider-managed semantic coverage — the edits come from the installed TypeScript/JavaScript provider and are not validated semantically by Refyntra.`
            : `${outcome.plan.title}: Refyntra could only partly validate this rename.`,
          { modal: true, detail: `Not checked:\n${outcome.plan.limitations.map((l) => `• ${l}`).join('\n')}\n\nApply anyway? Files are not saved; Undo works in the editor.` },
          'Apply anyway',
        );
        if (ok !== 'Apply anyway') return;
        acceptLimited = true;
      }
      applying = true;
      qp.hide();
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refyntra: revalidating and applying rename', cancellable: true }, (_p, token) =>
        engine.applyRename(planId, token, { acceptLimited }),
      );
      await reportApply(engine, previews, req, result);
    } catch (e) {
      if (e instanceof CancelledError) return;
      void vscode.window.showErrorMessage(`Refyntra Rename failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  qp.onDidHide(() => {
    if (!applying) engine.discardPlan(planId);
    qp.dispose();
  });
  qp.show();
}

/** Honest result: confirmed/unknown per file; stale → "The code changed since the preview" + prepare again. */
export async function reportApply(engine: EngineClient, previews: PreviewContentProvider, req: RenameRequest, result: ApplyOutcome): Promise<void> {
  if (result.status === 'applied') {
    void vscode.window.showInformationMessage(`Refyntra: ${result.message}. The files are not saved; use Undo in the editor to revert.`);
    return;
  }
  if (result.status === 'stale' && result.canReprepare) {
    const pick = await vscode.window.showWarningMessage(`Refyntra: The code changed since the preview. Nothing was applied. ${result.message}`, 'Prepare again');
    if (pick !== 'Prepare again') return;
    // The symbol may have moved: re-prepare only when the same name is still at the position.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === req.uri) ?? (await vscode.workspace.openTextDocument(vscode.Uri.parse(req.uri, true)));
    const pos = new vscode.Position(req.position.line, req.position.character);
    if (pos.line >= doc.lineCount || identifierAt(doc, pos) !== req.oldName) {
      void vscode.window.showInformationMessage(`Refyntra: ${req.oldName} is no longer at the original position. Place the cursor on it and run Rename again.`);
      return;
    }
    await runRename(engine, previews, req);
    return;
  }
  if (result.status === 'limited') {
    void vscode.window.showWarningMessage(`Refyntra: ${result.message} Not checked: ${(result.limitations ?? []).join(' ')}`);
    return;
  }
  if (result.textAppliedOnly) {
    // File rename failure path: the text edits are applied, the file rename is not. Never rolled back automatically.
    const pick = await vscode.window.showWarningMessage(`Refyntra: ${result.message}`, 'Undo text edits');
    const first = result.files?.find((f) => f.status === 'confirmed');
    if (pick === 'Undo text edits' && first) {
      await vscode.window.showTextDocument(vscode.Uri.parse(first.uri, true));
      await vscode.commands.executeCommand('undo');
    }
    return;
  }
  if (result.files?.length) {
    const lines = result.files.map((f) => `${shortPath(f.uri)}: ${f.status}`).join('; ');
    void vscode.window.showWarningMessage(`Refyntra: rename ${result.status}: ${result.message} (${lines})`);
    return;
  }
  void vscode.window.showWarningMessage(`Refyntra: rename not applied (${result.status}): ${result.message}`);
}
