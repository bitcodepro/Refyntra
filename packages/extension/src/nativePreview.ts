import * as vscode from 'vscode';
import type { ApplyOutcome, EngineClient, RenamePreview } from '@refyntra/application';
import { shortPath } from './convert';
import { type PreviewStyle, confirmationFor, nativeOutcomeMessage, nativePreviewBlocker, outsideChangeNote, parsePreviewStyle } from './nativePreviewModel';

// Plan previews in the editor's own Refactor Preview panel (ADR-004 Amendment 6):
//   prepare (host) → revalidate (host, read set) → EditApplier: every hash checked synchronously → workspace.applyEdit
//   with "needsConfirmation" entries → the editor shows its Refactor Preview (grouped per file, labelled with the plan)
//   → the user applies or discards there → the EditApplier reconciles every file against the planned result.
// While the panel is open the editor refuses to apply when an involved file changes; Refyntra reports any other code
// change made meanwhile after the apply. Plans with created, renamed or deleted files keep the QuickPick preview.

export function previewStyle(): PreviewStyle {
  return parsePreviewStyle(vscode.workspace.getConfiguration('refyntra').get('preview.style', 'native'));
}

/** True when this prepared plan is shown in the Refactor Preview (setting, text-only, applicable). */
export function usesRefactorPreview(outcome: RenamePreview, canApply: boolean, hasExtraChoices = false): boolean {
  return nativePreviewBlocker({ style: previewStyle(), writeSet: outcome.plan.writeSet, canApply, hasExtraChoices }) === undefined;
}

export interface NativeApplyResult {
  /** undefined: the user declined the limited-plan confirmation (nothing was revalidated or applied). */
  result: ApplyOutcome | undefined;
  /** The user discarded the Refactor Preview. */
  discarded: boolean;
  /** Shown after a successful apply when other code changed meanwhile. */
  note?: string;
}

/**
 * Revalidates and hands the plan to the editor's Refactor Preview. A limited plan asks first (same modal as the QuickPick
 * flow). The returned outcome is the engine's own, reconciled per file.
 */
export async function applyInRefactorPreview(engine: EngineClient, outcome: RenamePreview, title: string): Promise<NativeApplyResult> {
  const plan = outcome.plan;
  let acceptLimited = false;
  if (plan.validation.status === 'limited') {
    const ok = await vscode.window.showWarningMessage(
      `${plan.title}: Refyntra could only partly validate this change.`,
      { modal: true, detail: `Not checked:\n${plan.limitations.map((l) => `• ${l}`).join('\n')}\n\nShow it in the Refactor Preview anyway? Files are not saved; Undo works in the editor.` },
      'Continue',
    );
    if (ok !== 'Continue') {
      engine.discardPlan(outcome.planId);
      return { result: undefined, discarded: true };
    }
    acceptLimited = true;
  }
  const edited = new Set(plan.writeSet.map((c) => ('uri' in c ? c.uri : '')));
  const changed = new Set<string>();
  const watch = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.contentChanges.length === 0 || e.document.uri.scheme !== 'file') return;
    const uri = e.document.uri.toString();
    if (engine.handlesDocument(uri, e.document.languageId)) changed.add(uri);
  });
  let result: ApplyOutcome;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Refyntra: ${title} — confirm or discard the changes in the Refactor Preview`, cancellable: false },
      () => engine.applyRename(outcome.planId, undefined, { acceptLimited, confirmation: confirmationFor(plan, outcome.issues) }),
    );
  } finally {
    watch.dispose();
  }
  const seen = nativeOutcomeMessage(result, shortPath);
  if (seen.kind === 'discarded') return { result: { ...result, status: 'cancelled', message: seen.message }, discarded: true };
  if (seen.kind === 'partial') return { result: { ...result, message: seen.message }, discarded: false };
  const note = result.status === 'applied' ? outsideChangeNote(changed, edited, shortPath) : undefined;
  return { result, discarded: false, ...(note ? { note } : {}) };
}
