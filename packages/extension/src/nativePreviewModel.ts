import type { PlannedChange } from '@refyntra/contracts';

// The editor's Refactor Preview as a plan preview (ADR-004 Amendment 6). Pure: unit-tested with vitest (no vscode).

export type PreviewStyle = 'native' | 'quickPick';

/** The `refyntra.preview.style` setting; anything unknown is the default (native). */
export function parsePreviewStyle(value: unknown): PreviewStyle {
  return value === 'quickPick' ? 'quickPick' : 'native';
}

export interface NativePreviewInput {
  style: PreviewStyle;
  writeSet: readonly PlannedChange[];
  /** Applying is allowed and the previewed files match the plan. */
  canApply: boolean;
  /** The flow has choices only the QuickPick offers (file rename toggle, EF Core migrations mode). */
  hasExtraChoices?: boolean;
}

/** Why the Refactor Preview is not used for this plan (undefined = it is used). */
export function nativePreviewBlocker(i: NativePreviewInput): string | undefined {
  if (i.style !== 'native') return 'the QuickPick preview is selected (refyntra.preview.style)';
  if (!i.canApply) return 'the plan cannot be applied';
  if (i.writeSet.length === 0) return 'the plan changes nothing';
  if (i.writeSet.some((c) => c.kind !== 'text')) return 'the plan creates, renames or deletes files (ordered steps the Refactor Preview cannot show)';
  if (i.hasExtraChoices) return 'the plan has choices only the QuickPick preview offers';
  return undefined;
}

/** Label and description of every entry in the Refactor Preview: the plan title, and its open points. */
export function confirmationFor(plan: { title: string; limitations: readonly string[]; validation: { status: string } }, issues: readonly unknown[] = []): { label: string; description?: string } {
  const notes: string[] = [];
  if (plan.validation.status === 'limited') notes.push('partly validated');
  if (plan.limitations.length) notes.push(`${plan.limitations.length} limitation${plan.limitations.length === 1 ? '' : 's'}`);
  if (issues.length) notes.push(`${issues.length} warning${issues.length === 1 ? '' : 's'}`);
  return { label: `Refyntra: ${plan.title}`, ...(notes.length ? { description: notes.join(' · ') } : {}) };
}

/**
 * The engine's outcome seen from the Refactor Preview: a preview the user discarded (the editor applied nothing and
 * every file is unchanged) is a cancellation, not a failure; files left out in the panel are reported as such.
 */
export function nativeOutcomeMessage(result: { status: string; message: string; files?: readonly { uri: string; status: string }[] }, label: (uri: string) => string): { kind: 'applied' | 'discarded' | 'partial' | 'other'; message: string } {
  const files = result.files ?? [];
  if (result.status === 'applied') return { kind: 'applied', message: result.message };
  if (result.status === 'failed' && files.length > 0 && files.every((f) => f.status === 'unchanged')) {
    return { kind: 'discarded', message: 'The Refactor Preview was discarded. No file was changed.' };
  }
  if (result.status === 'failed' && files.some((f) => f.status === 'confirmed') && files.every((f) => f.status !== 'unknown')) {
    const left = files.filter((f) => f.status === 'unchanged').map((f) => label(f.uri));
    return { kind: 'partial', message: `Only part of the change was applied: ${left.join(', ')} ${left.length === 1 ? 'was' : 'were'} left out in the Refactor Preview. The code may not compile; use Undo in the editor to revert.` };
  }
  return { kind: 'other', message: result.message };
}

/** Note after an apply when code outside the edited files changed while the Refactor Preview was open. */
export function outsideChangeNote(changedUris: ReadonlySet<string>, editedUris: ReadonlySet<string>, label: (uri: string) => string): string | undefined {
  const outside = [...changedUris].filter((u) => !editedUris.has(u));
  if (outside.length === 0) return undefined;
  const names = outside.slice(0, 3).map(label).join(', ') + (outside.length > 3 ? ` and ${outside.length - 3} more` : '');
  return `${names} changed while the Refactor Preview was open. Refyntra validated the plan before the preview; check the result (Undo reverts it).`;
}
