import type { PlannedChange, PlannedFileRename } from '@refyntra/contracts';
import type { AnyRefactorPlan, PlanState, PlanValidationIssue } from '@refyntra/domain';
import type { PreviewFileModel } from './textEdits';

// Pure text of the rename preview (no vscode import: unit-tested with vitest). Owned and delegated plans share the
// preview UI; a delegated plan is labelled "provider-managed semantic coverage".

export interface SummaryInput {
  plan: AnyRefactorPlan;
  state: PlanState;
  issues: readonly PlanValidationIssue[];
  applyEnabled: boolean;
}

/** File rename: the file renames of a plan (resource operations applied after the text edits). */
export function plannedFileRenames(plan: AnyRefactorPlan): { oldUri: string; newUri: string }[] {
  return (plan.writeSet as readonly PlannedChange[]).filter((c): c is PlannedFileRename => c.kind === 'rename').map((c) => ({ oldUri: c.oldUri, newUri: c.newUri }));
}

const fileName = (uri: string) => {
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** The option line of the preview: "Also rename the file Foo.cs → Bar.cs" (several files: joined). */
export function fileRenameLabel(files: readonly { oldUri: string; newUri: string }[]): string {
  return `Also rename the file${files.length > 1 ? 's' : ''} ${files.map((f) => `${fileName(f.oldUri)} → ${fileName(f.newUri)}`).join(', ')}`;
}

function shortPath(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
  } catch {
    return uri;
  }
}

export function previewTitle(plan: AnyRefactorPlan): string {
  return plan.kind === 'delegated' ? `${plan.title} — preview (provider-managed semantic coverage)` : `${plan.title} — preview`;
}

const TS_JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const CSHARP_IDENTIFIER = /^@?[A-Za-z_][A-Za-z0-9_]*$/;

/** Identifier rule of the input box per language (TS/JS allow `$`, C# allows a leading `@`). */
export function identifierPattern(languageId: string): RegExp {
  return /^(typescript|javascript)(react)?$/.test(languageId) ? TS_JS_IDENTIFIER : CSHARP_IDENTIFIER;
}

export function renamePreviewSummary(preview: SummaryInput, files: readonly PreviewFileModel[], invalid: boolean, fileLabel: (uri: string) => string = shortPath): string {
  const plan = preview.plan;
  const delegated = plan.kind === 'delegated';
  const limited = plan.validation.status === 'limited';
  const lines = [`# ${plan.title}`, ''];
  lines.push(
    invalid
      ? '> **This preview is invalid** and cannot be applied: the planned edits do not match the current text (see Problems). Run Rename again.'
      : preview.applyEnabled
        ? delegated
          ? '> Review the diffs, then choose **Apply rename**. Before applying, Refyntra asks the provider again and applies only if it returns exactly this edit and no file changed since this preview. Edited files are not saved; Undo works in the editor.'
          : '> Review the diffs, then choose **Apply rename**. Refyntra revalidates the plan after you confirm and refuses to apply if any file changed since this preview. Edited files are not saved; Undo works in the editor.'
        : '> **Preview only.** Applying is turned off (`refyntra.rename.apply`). No file is changed.',
    '',
  );
  if (delegated) {
    lines.push(
      '## Provider-managed semantic coverage',
      '',
      'The edits come from the installed TypeScript/JavaScript rename provider (public VS Code commands). They are **not validated semantically by Refyntra**: Refyntra only checks that the files and the provider edit are unchanged between this preview and the apply.',
      '',
    );
  }
  if (limited) {
    lines.push(
      '## Validation is limited',
      '',
      delegated ? 'Applying asks for an extra confirmation of these limitations:' : 'Refyntra could not check every input of this rename. Applying asks for an extra confirmation of these limitations:',
      '',
      ...plan.limitations.map((l) => `- ${l}`),
      '',
    );
  }
  if (invalid) lines.push('## Problems (apply disabled)', '', ...files.filter((f) => f.problem).map((f) => `- ${fileLabel(f.uri)}: ${f.problem}`), '');
  const renames = plannedFileRenames(plan);
  lines.push(`- Files: ${files.length}, edits: ${files.reduce((n, f) => n + f.editCount, 0)}${renames.length ? `, file renames: ${renames.length}` : ''}`);
  if (plan.kind === 'delegated') {
    lines.push('- Project contexts, compiler snapshot and read set of the provider: unknown', `- Validation: ${plan.validation.status}; compilation delta: ${plan.validation.compilationDelta}`);
  } else {
    lines.push(
      `- Project contexts checked: ${plan.validation.checkedContexts.length}${plan.validation.uncheckedContexts.length ? `, not checked: ${plan.validation.uncheckedContexts.length}` : ''}`,
      `- Validation: ${plan.validation.status}; compilation delta (new compiler errors compared with before): ${plan.validation.compilationDelta}`,
    );
  }
  lines.push(`- Plan state: ${preview.state}`, '');
  if (preview.issues.length) {
    lines.push('## Problems (apply blocked)', '', ...preview.issues.map((i) => `- ${i.message}${i.uri ? ` (${fileLabel(i.uri)})` : ''}`), '');
  }
  lines.push('## Limitations', '', ...plan.limitations.map((l) => `- ${l}`));
  if (!delegated) {
    lines.push(
      '- String literals, comments, reflection names, JSON, routes and serialization contracts are not renamed.',
      '- Public API may have consumers outside this solution; they are not updated.',
    );
  }
  lines.push('- A write by another program in the very last moment before the apply cannot be excluded with the VS Code API; the result is checked afterwards and reported per file.', '');
  if (plan.evidence.length) lines.push('## Evidence', '', ...plan.evidence.map((e) => `- ${e.description}`), '');
  lines.push('## Files', '', ...files.map((f) => `- ${fileLabel(f.uri)} — ${f.editCount} edit(s)`), '');
  lines.push(...fileRenameSection(plan, renames, fileLabel));
  return lines.join('\n');
}

/**
 * Preview section: the file rename is its own line (a separate step after the text edits, with its own failure
 * semantics), or why the file keeps its name.
 */
function fileRenameSection(plan: AnyRefactorPlan, renames: readonly { oldUri: string; newUri: string }[], fileLabel: (uri: string) => string): string[] {
  const offer = plan.kind === 'owned-semantic' ? plan.fileRename : undefined;
  if (!offer) return [];
  const lines = ['## File rename', ''];
  if (renames.length) {
    lines.push(
      ...renames.map((r) => `- Rename ${fileLabel(r.oldUri)} → ${fileName(r.newUri)} (after the text edits, as a separate step)`),
      '',
      'The text edits are applied first, all together. Only when every edited file is confirmed is the file renamed; the editor keeps unsaved changes and moves open editors with it. If the file rename fails, the text edits stay applied (nothing is rolled back) and Refyntra says exactly what happened; Undo in the editor reverts the text edits.',
      '',
    );
  } else if (offer.available) {
    lines.push(...offer.files.map((f) => `- ${fileName(f.oldUri)} keeps its name (renaming it was turned off for this preview).`), '');
  } else {
    lines.push(...offer.files.map((f) => `- ${fileName(f.oldUri)} keeps its name: ${offer.message ?? offer.reasonCode ?? 'renaming it is not proven safe'}`), '');
  }
  return lines;
}
/**
 * Quick-pick lines of the preview: the "Also rename the file Foo.cs → Bar.cs" option (on by default when proven
 * safe; choosing it prepares a new preview with the option flipped), or an information line why the file keeps its
 * name. Nothing for plans without a file named after the type.
 */
export function fileRenameItems(plan: AnyRefactorPlan): { label: string; description?: string; detail?: string; action: 'toggleFile' | 'fileInfo' }[] {
  const offer = plan.kind === 'owned-semantic' ? plan.fileRename : undefined;
  if (!offer || offer.files.length === 0) return [];
  if (!offer.available) {
    return [{ label: `$(info) ${offer.files.map((f) => fileName(f.oldUri)).join(', ')} keeps its name`, detail: offer.message ?? offer.reasonCode ?? 'Renaming the file is not proven safe.', action: 'fileInfo' }];
  }
  return [
    {
      label: `${offer.included ? '$(pass-filled)' : '$(circle-large-outline)'} ${fileRenameLabel(offer.files)}`,
      description: offer.included ? 'on — renamed after the text edits; choose to turn off' : 'off — choose to turn on (new preview)',
      action: 'toggleFile',
    },
  ];
}