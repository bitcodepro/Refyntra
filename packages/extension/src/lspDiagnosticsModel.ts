import type { LspDiagnostic } from '@refyntra/adapter-lsp';

/**
 * Errors in `after` that were not in `before`. Positions move when a change inserts lines, so an error counts as the
 * same when its message, code and source match one that was there before (each old error matches at most once).
 */
export function newErrors(before: readonly LspDiagnostic[], after: readonly LspDiagnostic[]): LspDiagnostic[] {
  const key = (d: LspDiagnostic) => `${d.source ?? ''}\u0000${d.code ?? ''}\u0000${d.message}`;
  const left = new Map<string, number>();
  for (const d of before) if (d.severity === 1) left.set(key(d), (left.get(key(d)) ?? 0) + 1);
  const out: LspDiagnostic[] = [];
  for (const d of after) {
    if (d.severity !== 1) continue;
    const n = left.get(key(d)) ?? 0;
    if (n > 0) left.set(key(d), n - 1);
    else out.push(d);
  }
  return out;
}
