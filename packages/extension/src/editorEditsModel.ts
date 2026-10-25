import type { ApplyOutcome, RenamePreview } from '@refyntra/application';

// F2 in C# (pure, no vscode import: unit-tested with vitest). The rename box has no place for a second confirmation, so
// F2 hands over only a plan that Refyntra Rename would apply without asking.

/** Why F2 must not hand this prepared plan to the editor; undefined when it may go to the checks of handOverRename. */
export function editorRenameRefusal(r: RenamePreview): string | undefined {
  if (r.issues.length > 0) return `The rename plan has problems: ${r.issues.map((i) => i.message).join('; ')}`;
  if (r.state !== 'Previewing') return `The rename plan is ${r.state} and cannot be applied.`;
  if (!r.applyEnabled) return 'Applying renames is turned off (refyntra.rename.apply). Use Refyntra: Rename to preview it.';
  if (r.plan.kind === 'delegated' || r.plan.validation.status !== 'valid') {
    return 'Refyntra could only partly validate this rename. Use Refyntra: Rename to review its limitations and confirm it.';
  }
  if (r.plan.writeSet.some((c) => c.kind !== 'text' && c.kind !== 'rename')) return 'This rename creates or deletes files. Use Refyntra: Rename.';
  return undefined;
}

/** The message for an F2 rename that did not pass the checks of handOverRename (nothing was handed to the editor). */
export function editorRenameFailure(result: ApplyOutcome): string {
  if (result.status === 'stale') return `The code changed since the rename was prepared; nothing was applied. Try F2 again. (${result.message})`;
  return `Rename not applied (${result.status}): ${result.message}`;
}
