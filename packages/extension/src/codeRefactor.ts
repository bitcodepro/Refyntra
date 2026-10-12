import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ApplyOutcome, CancelledError, type EngineClient, type RenameOutcome, type RenamePreview } from '@refyntra/application';
import {
  CSHARP_CHANGE_SIGNATURE_ACTION,
  CSHARP_EXTRACT_METHOD_ACTION,
  CSHARP_SAFE_DELETE_ACTION,
  type PlannedChange,
  type PlannedTextChange,
  type Position,
  type Range,
  type SignatureInfo,
} from '@refyntra/contracts';
import { runRecovery } from './actions';
import {
  type SignatureRow,
  addRow,
  codeRefactorSummary,
  deletedFilePreview,
  identifierProblem,
  initialRows,
  isUnchanged,
  moveRow,
  removeRow,
  removedNames,
  renameRow,
  rowDescription,
  rowsProblem,
  signatureText,
  toSpec,
} from './codeRefactorSummary';
import { shortPath, toPosition } from './convert';
import { currentText } from './createFile';
import type { VsCodeEditApplier } from './editApplier';
import type { PreviewContentProvider, StoredPreview } from './rename';
import { previewFile, sha256 } from './textEdits';
import { applyInRefactorPreview, usesRefactorPreview } from './nativePreview';
import { ChangeSignatureDialog } from './changeSignaturePanel';
import { summarize } from './codeLensModel';

// Safe Delete, Extract Method and Change Signature: prepare → preview (diffs, deleted files as a diff to empty) →
// confirm (a limited plan asks again) → revalidate → apply through the single EditApplier → honest report, Undo.

export interface CodeTarget {
  uri: string;
  position: Position;
}

function activeCSharp(title: string): vscode.TextEditor | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file' || ed.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage(`Refyntra ${title}: place the cursor in a C# file of the loaded solution.`);
    return undefined;
  }
  return ed;
}

/** Safe Delete of the symbol at the cursor (or at `seed`). */
export async function runSafeDelete(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, seed?: CodeTarget): Promise<void> {
  const title = 'Safe Delete';
  let target = seed;
  if (!target) {
    const ed = activeCSharp(title);
    if (!ed) return;
    target = { uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) };
  }
  const t = target;
  await runCodePlan(engine, previews, applier, title, (token) => engine.prepareAction(t, CSHARP_SAFE_DELETE_ACTION, token), () => runSafeDelete(engine, previews, applier, t));
}

/** Extract Method of the editor selection (or of `seed`; without a name the name is asked for). */
export async function runExtractMethod(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, seed?: { uri: string; range: Range; name?: string }): Promise<void> {
  const title = 'Extract Method';
  let target: { uri: string; range: Range } | undefined = seed;
  if (!target) {
    const ed = activeCSharp(title);
    if (!ed) return;
    if (ed.selection.isEmpty) {
      void vscode.window.showInformationMessage('Refyntra Extract Method: select the statements or the expression to extract first.');
      return;
    }
    target = { uri: ed.document.uri.toString(), range: { start: toPosition(ed.selection.start), end: toPosition(ed.selection.end) } };
  }
  let name = seed?.name;
  if (!name) {
    const entered = await vscode.window.showInputBox({
      title: 'Refyntra: Extract Method',
      prompt: 'Name of the new method (private, in the same type)',
      value: 'ExtractedMethod',
      validateInput: (v) => identifierProblem(v.trim()),
    });
    if (!entered) return;
    name = entered.trim();
  }
  const r = { ...target, name };
  await runCodePlan(engine, previews, applier, title, (token) => engine.prepareAction({ uri: r.uri, position: r.range.start }, CSHARP_EXTRACT_METHOD_ACTION, token, { range: r.range, newName: r.name }), () =>
    runExtractMethod(engine, previews, applier, r),
  );
}

/** Change Signature of the method at the cursor: an editor of the parameter list, then the preview. */
export async function runChangeSignature(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, seed?: CodeTarget & { rows?: SignatureRow[] }): Promise<void> {
  const title = 'Change Signature';
  let target: CodeTarget | undefined = seed;
  if (!target) {
    const ed = activeCSharp(title);
    if (!ed) return;
    target = { uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) };
  }
  const t = target;
  let info: SignatureInfo;
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: reading the signature' }, () => engine.signatureAt(t));
    if (r.kind !== 'signature') {
      void vscode.window.showWarningMessage(`${title} unavailable: ${r.message}`);
      return;
    }
    info = r.info;
  } catch (e) {
    if (e instanceof CancelledError) return;
    throw e;
  }
  const rows = seed?.rows ?? (signatureEditor() === 'dialog' ? await editSignatureInDialog(engine, t, info) : await editSignature(info));
  if (!rows) return;
  await runCodePlan(engine, previews, applier, title, (token) => engine.prepareAction(t, CSHARP_CHANGE_SIGNATURE_ACTION, token, { signature: { parameters: toSpec(rows) } }), () =>
    runChangeSignature(engine, previews, applier, { ...t, rows }),
  );
}

/** `refyntra.changeSignature.editor`: the dialog (default) or the QuickPick steps. */
function signatureEditor(): 'dialog' | 'quickPick' {
  return vscode.workspace.getConfiguration('refyntra').get<string>('changeSignature.editor', 'dialog') === 'quickPick' ? 'quickPick' : 'dialog';
}

/** The Change Signature dialog (webview); the call-site count is filled in when Related answers. */
async function editSignatureInDialog(engine: EngineClient, t: CodeTarget, info: SignatureInfo): Promise<SignatureRow[] | undefined> {
  const dialog = new ChangeSignatureDialog(info);
  const cts = new vscode.CancellationTokenSource();
  void engine
    .related(t, cts.token)
    .then((o) => {
      if (o.kind !== 'related') return;
      const s = summarize(!!o.subject, o.groups.flatMap((g) => g.relations));
      dialog.setCallSites({ count: s.references.count, more: s.references.more });
    })
    .catch(() => undefined);
  try {
    return await dialog.result;
  } finally {
    cts.cancel();
    cts.dispose();
  }
}

/** The parameter list editor (QuickPick loop). Returns the new rows, or undefined when cancelled. */
async function editSignature(info: SignatureInfo): Promise<SignatureRow[] | undefined> {
  let rows = initialRows(info);
  for (;;) {
    type Item = vscode.QuickPickItem & { act: 'row' | 'add' | 'preview'; index?: number };
    const removed = removedNames(rows, info);
    const items: Item[] = [
      ...rows.map((r, index): Item => ({ label: `${index + 1}. ${r.modifiers ? `${r.modifiers} ` : ''}${r.type} ${r.name}${r.defaultValue ? ` = ${r.defaultValue}` : ''}`, description: rowDescription(r, info), act: 'row', index })),
      { label: '$(add) Add parameter…', act: 'add' },
      { label: '$(eye) Preview', description: removed.length ? `removes ${removed.join(', ')}` : '', act: 'preview' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Refyntra: Change Signature of ${info.name ?? 'the method'} ${signatureText(rows)}`, placeHolder: 'Select a parameter to move, rename or remove; add one; or preview' });
    if (!pick) return undefined;
    if (pick.act === 'preview') {
      const problem = rowsProblem(rows);
      if (problem) {
        void vscode.window.showWarningMessage(`Refyntra Change Signature: ${problem}`);
        continue;
      }
      if (isUnchanged(rows, info)) {
        void vscode.window.showInformationMessage('Refyntra Change Signature: the signature is unchanged.');
        continue;
      }
      return rows;
    }
    if (pick.act === 'add') {
      const type = await vscode.window.showInputBox({ title: 'New parameter: type', prompt: 'C# type, e.g. int, string?, CancellationToken', validateInput: (v) => (v.trim() ? undefined : 'Enter a type.') });
      if (!type) continue;
      const name = await vscode.window.showInputBox({ title: 'New parameter: name', validateInput: (v) => identifierProblem(v.trim()) ?? (rows.some((r) => r.name === v.trim()) ? 'That name is taken.' : undefined) });
      if (!name) continue;
      const callSiteValue = await vscode.window.showInputBox({ title: 'New parameter: value at existing call sites', prompt: 'Expression passed by every existing call (empty: use the default value)' });
      if (callSiteValue === undefined) continue;
      const defaultValue = await vscode.window.showInputBox({ title: 'New parameter: default value (optional)', prompt: 'Makes the parameter optional; empty: required' });
      if (defaultValue === undefined) continue;
      rows = addRow(rows, { name: name.trim(), type: type.trim(), ...(defaultValue.trim() ? { defaultValue: defaultValue.trim() } : {}), ...(callSiteValue.trim() ? { callSiteValue: callSiteValue.trim() } : {}) });
      continue;
    }
    const index = pick.index!;
    const row = rows[index]!;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-up) Move up', act: 'up' as const },
        { label: '$(arrow-down) Move down', act: 'down' as const },
        { label: '$(edit) Rename…', act: 'rename' as const },
        { label: '$(trash) Remove', act: 'remove' as const, description: row.from !== undefined ? 'only when it is unused; call-site arguments must be free of side effects' : '' },
      ],
      { title: `Parameter ${row.name}` },
    );
    if (!action) continue;
    if (action.act === 'up') rows = moveRow(rows, index, -1);
    else if (action.act === 'down') rows = moveRow(rows, index, 1);
    else if (action.act === 'remove') rows = removeRow(rows, index);
    else {
      const name = await vscode.window.showInputBox({ title: `Rename parameter ${row.name}`, value: row.name, validateInput: (v) => identifierProblem(v.trim()) });
      if (name) rows = renameRow(rows, index, name.trim());
    }
  }
}

async function buildPreview(preview: RenamePreview): Promise<StoredPreview> {
  const files = [];
  for (const change of preview.plan.writeSet as readonly PlannedChange[]) {
    if (change.kind === 'text') files.push(previewFile(change, await currentText(change.uri)));
    else if (change.kind === 'delete') files.push(deletedFilePreview(change, await currentText(change.uri)));
  }
  const invalid = files.some((f) => f.problem !== undefined);
  return { summary: codeRefactorSummary(preview, files, invalid, shortPath), files, invalid };
}

/** Shared flow of the code refactorings: prepare, preview, confirm, apply, report. */
async function runCodePlan(
  engine: EngineClient,
  previews: PreviewContentProvider,
  applier: VsCodeEditApplier,
  title: string,
  prepare: (token: vscode.CancellationToken) => Promise<RenameOutcome>,
  again: () => Promise<void>,
): Promise<void> {
  let outcome: RenameOutcome;
  try {
    outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refyntra: preparing ${title} preview`, cancellable: true }, (_p, token) => prepare(token));
  } catch (e) {
    if (e instanceof CancelledError) return;
    throw e;
  }
  if (outcome.kind === 'unavailable') {
    if (outcome.reasonCode === 'ReferencesRemain') {
      const pick = await vscode.window.showWarningMessage(`${title} refused: ${outcome.message}`, 'Show usages');
      if (pick === 'Show usages') await vscode.commands.executeCommand('refyntra.related');
      return;
    }
    const pick = await vscode.window.showWarningMessage(`${title} unavailable: ${outcome.message}`, ...outcome.recoveryActions.map((r) => r.title));
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
  const summaryDoc = await vscode.workspace.openTextDocument(previews.summaryUri(planId, `${title} preview.md`));
  await vscode.languages.setTextDocumentLanguage(summaryDoc, 'markdown');
  await vscode.window.showTextDocument(summaryDoc, { preview: true, preserveFocus: true });

  const plan = outcome.plan;
  if (usesRefactorPreview(outcome, outcome.applyEnabled && !stored.invalid)) {
    // The editor's Refactor Preview (setting refyntra.preview.style): revalidated first, every hash checked again.
    try {
      const native = await applyInRefactorPreview(engine, outcome, title);
      if (!native.result) return;
      if (native.discarded) {
        void vscode.window.showInformationMessage(`Refyntra ${title}: ${native.result.message}`);
        return;
      }
      await reportCodeApply(engine, applier, plan.writeSet as readonly PlannedChange[], new Map(), native.result, again);
      if (native.note) void vscode.window.showWarningMessage(`Refyntra ${title}: ${native.note}`);
    } catch (e) {
      if (e instanceof CancelledError) return;
      void vscode.window.showErrorMessage(`Refyntra ${title} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  const limited = plan.validation.status === 'limited';
  const deletes = new Set((plan.writeSet as readonly PlannedChange[]).flatMap((c) => (c.kind === 'delete' ? [c.uri] : [])));
  type Pick = vscode.QuickPickItem & { action: 'diff' | 'apply' | 'disabled'; index?: number };
  const canApply = outcome.applyEnabled && !stored.invalid;
  const items: Pick[] = [
    canApply
      ? { label: '$(check) Apply', description: limited ? 'partly validated: asks for confirmation; files are not saved' : 'revalidates first; files are not saved', action: 'apply' }
      : { label: stored.invalid ? '$(error) Preview invalid — cannot be applied' : '$(lock) Preview only — applying is off', action: 'disabled' },
    ...stored.files.map((f, index): Pick => ({ label: `$(diff) ${shortPath(f.uri)}`, description: deletes.has(f.uri) ? 'deleted · open diff to empty' : `open diff · ${f.editCount} edit(s)`, action: 'diff', index })),
  ];
  const qp = vscode.window.createQuickPick<Pick>();
  qp.title = `${plan.title} — preview`;
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
      if (pick.action === 'disabled' || !canApply) {
        void vscode.window.showInformationMessage(stored.invalid ? 'Refyntra: this preview is invalid and cannot be applied.' : 'Applying is turned off (refyntra.rename.apply). No file was changed.');
        return;
      }
      let acceptLimited = false;
      if (limited) {
        const ok = await vscode.window.showWarningMessage(`${plan.title}: Refyntra could only partly validate this change.`, { modal: true, detail: `Not checked:\n${plan.limitations.map((l) => `• ${l}`).join('\n')}\n\nApply anyway? Files are not saved; Undo works in the editor.` }, 'Apply anyway');
        if (ok !== 'Apply anyway') return;
        acceptLimited = true;
      }
      applying = true;
      qp.hide();
      const originals = new Map(stored.files.filter((f) => deletes.has(f.uri)).map((f) => [f.uri, f.original]));
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refyntra: revalidating and applying ${title}`, cancellable: true }, (_p, token) =>
        engine.applyRename(planId, token, { acceptLimited }),
      );
      await reportCodeApply(engine, applier, plan.writeSet as readonly PlannedChange[], originals, result, again);
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

async function reportCodeApply(engine: EngineClient, applier: VsCodeEditApplier, writeSet: readonly PlannedChange[], originals: ReadonlyMap<string, string>, result: ApplyOutcome, again: () => Promise<void>): Promise<void> {
  if (result.status === 'applied') {
    const pick = await vscode.window.showInformationMessage(`Refyntra: ${result.message}. Edited files are not saved.`, 'Undo');
    if (pick === 'Undo') void vscode.window.showInformationMessage(`Refyntra Undo: ${(await undoCode(engine, applier, writeSet, originals)).join(' ')}`);
    return;
  }
  if (result.status === 'stale' && result.canReprepare) {
    const pick = await vscode.window.showWarningMessage(`Refyntra: The code changed since the preview. Nothing was applied. ${result.message}`, 'Prepare again');
    if (pick === 'Prepare again') await again();
    return;
  }
  if (result.textAppliedOnly) {
    const pick = await vscode.window.showWarningMessage(`Refyntra: ${result.message}`, 'Undo text edits');
    if (pick === 'Undo text edits') void vscode.window.showInformationMessage(`Refyntra Undo: ${(await undoCode(engine, applier, writeSet, new Map())).join(' ')}`);
    return;
  }
  void vscode.window.showWarningMessage(`Refyntra: not applied (${result.status}): ${result.message}`);
}

/**
 * Undo of an applied code refactoring, step by step and only on unchanged state: each edited file is undone with the
 * editor's Undo while its text is still exactly the planned result; each deleted file is created again with its
 * previewed text while it is still absent (the C# analysis then reloads the workspace). Every step is reported; nothing
 * is forced.
 */
export async function undoCode(engine: EngineClient, applier: VsCodeEditApplier, writeSet: readonly PlannedChange[], originals: ReadonlyMap<string, string>): Promise<string[]> {
  const out: string[] = [];
  let restored = false;
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
  for (const change of writeSet.filter((c) => c.kind === 'delete')) {
    const text = originals.get(change.uri);
    if (text === undefined || sha256(text) !== change.expectedHash) {
      out.push(`${shortPath(change.uri)}: its original text is not available; restore it from source control.`);
      continue;
    }
    const ok = await applier.restoreDeletedFile(vscode.Uri.parse(change.uri, true), text);
    out.push(ok ? `${shortPath(change.uri)} restored.` : `${shortPath(change.uri)} was not restored (it exists again or cannot be created).`);
    restored ||= ok;
  }
  // The backend dropped the deleted file's documents; a restored file comes back only with a reload of the C# route.
  if (restored) {
    out.push('The C# analysis reloaded the workspace.');
    await engine.restart().catch(() => undefined);
  }
  return out;
}
