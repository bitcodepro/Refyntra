import type { FolderChoice, PlannedChange, PlannedFileCreate } from '@refyntra/contracts';
import type { AnyRefactorPlan, PlanState, PlanValidationIssue } from '@refyntra/domain';
import type { PreviewFileModel } from './textEdits';

// Pure text of the create-file previews (Move Type to File, Generate handler). No vscode import: unit-tested with vitest.

export interface CreateSummaryInput {
  plan: AnyRefactorPlan;
  state: PlanState;
  issues: readonly PlanValidationIssue[];
  applyEnabled: boolean;
}

export function plannedCreates(plan: AnyRefactorPlan): PlannedFileCreate[] {
  return (plan.writeSet as readonly PlannedChange[]).filter((c): c is PlannedFileCreate => c.kind === 'create');
}

/** The preview model of a created file: a diff from an empty file. */
export function createdFilePreview(change: PlannedFileCreate): PreviewFileModel {
  return { uri: change.uri, original: '', modified: change.text, editCount: 1 };
}

const fileName = (uri: string) => {
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** Folder choices of a Generate handler plan (first = default), or none. */
export function folderChoices(plan: AnyRefactorPlan): FolderChoice[] {
  return plan.kind === 'owned-semantic' ? (plan.fileCreate?.folderChoices ?? []) : [];
}

/** QuickPick label of a folder choice, e.g. "App/Handlers — 2 handler(s) — namespace App.Handlers". */
export function folderLabel(choice: FolderChoice, fileLabel: (uri: string) => string): { label: string; description: string } {
  return { label: fileLabel(choice.folderUri), description: `${choice.projectName} · ${choice.handlerCount} handler(s) · namespace ${choice.namespace}` };
}

export function createPreviewSummary(input: CreateSummaryInput, files: readonly PreviewFileModel[], invalid: boolean, fileLabel: (uri: string) => string): string {
  const plan = input.plan;
  const creates = plannedCreates(plan);
  const createdUris = new Set(creates.map((c) => c.uri));
  const edited = files.filter((f) => !createdUris.has(f.uri));
  const lines = [`# ${plan.title}`, ''];
  lines.push(
    invalid
      ? '> **This preview is invalid** and cannot be applied: the planned edits do not match the current text. Run the action again.'
      : input.applyEnabled
        ? '> Review the new file and the edits, then choose **Apply**. Refyntra revalidates the plan after you confirm and refuses to apply if anything changed since this preview or the new file appeared meanwhile.'
        : '> **Preview only.** Applying is turned off (`refyntra.rename.apply`). No file is changed.',
    '',
  );
  lines.push('## New file', '');
  for (const c of creates) lines.push(`- ${fileLabel(c.uri)} (${c.text.split('\n').length - (c.text.endsWith('\n') ? 1 : 0)} line(s)) — created on disk first, as its own step`);
  const choices = folderChoices(plan);
  if (choices.length > 0) {
    const selected = plan.kind === 'owned-semantic' ? plan.fileCreate?.selectedFolderUri : undefined;
    lines.push('', `Folder: ${selected ? fileLabel(selected) : fileLabel(choices[0]!.folderUri)}${choices.length > 1 ? ` (one of ${choices.length} folders; choose **Change folder** to pick another)` : ''}`);
  }
  lines.push('');
  if (edited.length > 0) {
    lines.push('## Edits to existing files', '', ...edited.map((f) => `- ${fileLabel(f.uri)} — ${f.editCount} edit(s), not saved`), '');
  }
  lines.push(
    '## Order and failure',
    '',
    edited.length > 0
      ? `The new file is created first. Only when it exists with exactly the previewed text is ${edited.map((f) => fileName(f.uri)).join(', ')} edited. If creating fails, nothing is changed. If the edit fails after the file was created, the new file stays (the code then exists in both files), Refyntra says exactly that and offers to delete the new file; nothing is rolled back automatically.`
      : 'The new file is created on disk. If creating fails, nothing is changed.',
    '',
  );
  if (invalid) lines.push('## Problems (apply disabled)', '', ...files.filter((f) => f.problem).map((f) => `- ${fileLabel(f.uri)}: ${f.problem}`), '');
  if (input.issues.length) lines.push('## Problems (apply blocked)', '', ...input.issues.map((i) => `- ${i.message}${i.uri ? ` (${fileLabel(i.uri)})` : ''}`), '');
  if (plan.kind === 'owned-semantic') {
    lines.push(`- Project contexts checked: ${plan.validation.checkedContexts.length}`, `- Validation: ${plan.validation.status}; compilation delta (new compiler errors compared with before, the new file included): ${plan.validation.compilationDelta}`, `- Plan state: ${input.state}`, '');
  }
  lines.push('## Limitations', '', ...plan.limitations.map((l) => `- ${l}`), '- A write by another program in the very last moment cannot be excluded with the VS Code API; the result is checked afterwards and reported per file.', '');
  if (plan.evidence.length) lines.push('## Evidence', '', ...plan.evidence.map((e) => `- ${e.description}`), '');
  return lines.join('\n');
}
