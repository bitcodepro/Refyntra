import type { SymbolRef } from '@refyntra/contracts';

// Call / type hierarchy presentation. Pure: unit-tested with vitest (no vscode).

const KNOWN = new Set(['namespace', 'class', 'interface', 'struct', 'record', 'enum', 'delegate', 'method', 'property', 'field', 'event', 'constructor', 'parameter', 'local']);

/** The protocol symbol kind, or "other" for kinds unknown to this client (newer hosts). */
export function symbolKindName(kind: string): string {
  return KNOWN.has(kind) ? kind : 'other';
}

/** The detail shown next to a hierarchy item: the containing type or namespace, and the project. */
export function hierarchyDetail(s: Pick<SymbolRef, 'containerName' | 'projectName'>): string {
  return [s.containerName, s.projectName ? `(${s.projectName})` : undefined].filter(Boolean).join(' ');
}
