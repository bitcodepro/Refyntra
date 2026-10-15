// Ctrl+Click / F12 in C#: where the symbol is implemented.

import type { Location } from '@refyntra/contracts';

/** A declaration without a body: an interface member, `abstract`, `extern` or a partial definition (`…);`). */
export function declarationHasNoBody(lineText: string): boolean {
  const t = lineText.replace(/\/\/.*$/, '').trim();
  return /\babstract\b|\bextern\b/.test(t) || (/\)\s*;\s*$/.test(t) && !/=>/.test(t));
}

/**
 * Where Ctrl+Click goes: the implementations when the declaration has no body (interface and abstract members,
 * interfaces themselves) or when the click is on the declaration itself (Rider: from a declaration to its
 * implementations); otherwise the declaration (the source of a method or class is its implementation).
 */
export function definitionTargets(input: {
  subjectKind: string;
  declarations: readonly Location[];
  implementations: readonly Location[];
  declarationLine: string | undefined;
  clickedOnDeclaration: boolean;
  inInterface: boolean;
}): readonly Location[] {
  const impls = input.implementations;
  if (impls.length > 0) {
    if (input.subjectKind === 'interface' || input.inInterface || input.clickedOnDeclaration) return impls;
    if (input.declarationLine !== undefined && declarationHasNoBody(input.declarationLine)) return impls;
  }
  return input.declarations;
}
