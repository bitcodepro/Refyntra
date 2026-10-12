// Refactorings in the editor's native places (lightbulb, Ctrl+., Refactor…, Source Action…). Pure: unit-tested with
// vitest (no vscode). The provider (codeActions.ts) turns these into vscode.CodeAction objects.

/** Code action kinds Refyntra contributes (hierarchical: "refactor.rewrite.signature" is a "refactor.rewrite"). */
export const KIND = {
  extractMethod: 'refactor.extract.method',
  changeSignature: 'refactor.rewrite.signature',
  moveTypeToFile: 'refactor.move.typeToFile',
  safeDelete: 'refactor.rewrite.safeDelete',
  rename: 'refactor.rewrite.rename',
  generateHandler: 'refactor.rewrite.generateHandler',
  cleanup: 'source.refyntra.cleanup',
} as const;

export type ActionKey = keyof typeof KIND;

export interface ActionSpec {
  key: ActionKey;
  kind: string;
  title: string;
  command: string;
  /** The capability id that offers it (checked with capability/query when the user asks for code actions). */
  capabilityVerb: string;
}

export const ACTION_SPECS: readonly ActionSpec[] = [
  { key: 'extractMethod', kind: KIND.extractMethod, title: 'Extract Method… (Refyntra, preview first)', command: 'refyntra.extractMethod', capabilityVerb: 'extractMethod' },
  { key: 'changeSignature', kind: KIND.changeSignature, title: 'Change Signature… (Refyntra, preview first)', command: 'refyntra.changeSignature', capabilityVerb: 'changeSignature' },
  { key: 'moveTypeToFile', kind: KIND.moveTypeToFile, title: 'Move Type to File (Refyntra, preview first)', command: 'refyntra.moveTypeToFile', capabilityVerb: 'moveTypeToFile' },
  { key: 'safeDelete', kind: KIND.safeDelete, title: 'Safe Delete (Refyntra, only when unused)', command: 'refyntra.safeDelete', capabilityVerb: 'safeDelete' },
  { key: 'rename', kind: KIND.rename, title: 'Rename… (Refyntra, preview first)', command: 'refyntra.rename', capabilityVerb: 'rename' },
  { key: 'generateHandler', kind: KIND.generateHandler, title: 'Generate Handler (Refyntra, MediatR)', command: 'refyntra.generateHandler', capabilityVerb: 'generateHandler' },
];

export const CLEANUP_SPEC = { kind: KIND.cleanup, title: 'Code Cleanup of this File (Refyntra, preview first)', command: 'refyntra.cleanup' } as const;

/** True when `requested` (the `only` filter of a request) includes `kind`: equal, or a parent ("refactor" ⊇ "refactor.extract.method"). */
export function kindMatches(requested: string | undefined, kind: string): boolean {
  if (!requested) return true;
  return kind === requested || kind.startsWith(`${requested}.`) || requested.startsWith(`${kind}.`);
}

const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Cheap, text-only check that a selection can be extracted: not blank, brackets balanced, no unterminated string or
 * comment, not starting or ending in the middle of an expression, and no member or type declaration. The C# host still
 * decides (the prepare refuses with a reason); this only keeps the lightbulb quiet for selections that cannot work.
 */
export function looksExtractable(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 20000) return false;
  if (/^[.,;:)\]}=?|&+*/%<>!]/.test(t) && !/^!\w/.test(t)) return false;
  if (/[.,(\[{=?|&+\-*/%<>!:]$/.test(t)) return false;
  if (/\b(class|struct|interface|record|enum|namespace)\s+[A-Za-z_]/.test(t)) return false;
  if (/^(public|private|protected|internal|static|override|virtual|abstract|async\s+Task)\b[^=;]*\(/.test(t)) return false;
  const stack: string[] = [];
  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    const n = t[i + 1];
    if (c === '/' && n === '/') {
      const end = t.indexOf('\n', i);
      if (end < 0) return stack.length === 0;
      i = end + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = t.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const verbatim = c === '"' && t[i - 1] === '@';
      let j = i + 1;
      for (; j < t.length; j++) {
        if (verbatim && t[j] === '"' && t[j + 1] === '"') {
          j++;
          continue;
        }
        if (!verbatim && t[j] === '\\') {
          j++;
          continue;
        }
        if (t[j] === c) break;
        if (!verbatim && t[j] === '\n') return false;
      }
      if (j >= t.length) return false;
      i = j + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== OPEN[c]) return false;
    }
    i++;
  }
  return stack.length === 0;
}

export interface OfferInput {
  /** Capabilities the route reports as runnable at the position (ids like "csharp.safeDelete"). */
  runnable: readonly string[];
  /** Capabilities reported unavailable, with the reason (shown as disabled actions in the Refactor menu). */
  unavailable: readonly { capabilityId: string; reason: string }[];
  /** The selection is non-empty and passes looksExtractable. */
  extractable: boolean;
  /** The selection is empty (Extract Method needs one). */
  emptySelection: boolean;
  /** Requested kind filter (`context.only`). */
  only?: string;
}

export interface Offer {
  spec: ActionSpec;
  /** Present: shown greyed out with this reason (only in the Refactor menu / Ctrl+. list). */
  disabled?: string;
}

/** Which Refyntra actions to offer, in a stable order; extract needs a selection that looks extractable. */
export function planOffers(i: OfferInput): Offer[] {
  const verb = (id: string) => id.split('.').pop() ?? id;
  const runnable = new Set(i.runnable.map(verb));
  const why = new Map(i.unavailable.map((u) => [verb(u.capabilityId), u.reason]));
  const out: Offer[] = [];
  for (const spec of ACTION_SPECS) {
    if (!kindMatches(i.only, spec.kind)) continue;
    if (spec.key === 'extractMethod') {
      if (i.emptySelection) continue;
      if (!i.extractable) {
        out.push({ spec, disabled: 'Select complete statements or one complete expression.' });
        continue;
      }
      if (runnable.has(spec.capabilityVerb)) out.push({ spec });
      else if (why.has(spec.capabilityVerb)) out.push({ spec, disabled: why.get(spec.capabilityVerb)! });
      continue;
    }
    if (runnable.has(spec.capabilityVerb)) out.push({ spec });
    else if (why.has(spec.capabilityVerb)) out.push({ spec, disabled: why.get(spec.capabilityVerb)! });
  }
  return out;
}

export interface CodeActionTarget {
  uri: string;
  position: { line: number; character: number };
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const isPos = (p: unknown): p is { line: number; character: number } =>
  !!p && typeof p === 'object' && Number.isInteger((p as { line?: unknown }).line) && Number.isInteger((p as { character?: unknown }).character) && (p as { line: number }).line >= 0 && (p as { character: number }).character >= 0;

/**
 * The argument a code action passes to a Refyntra command: a file URI, a position and (Extract Method) a range.
 * Anything else (e.g. a command run from the palette, or a malformed argument) is undefined: the command then uses
 * the active editor.
 */
export function parseCodeActionTarget(arg: unknown): CodeActionTarget | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as { uri?: unknown; position?: unknown; range?: unknown };
  if (typeof a.uri !== 'string' || !a.uri.startsWith('file:') || !isPos(a.position)) return undefined;
  const r = a.range as { start?: unknown; end?: unknown } | undefined;
  const range = r && isPos(r.start) && isPos(r.end) ? { start: { ...r.start }, end: { ...r.end } } : undefined;
  return { uri: a.uri, position: { line: a.position.line, character: a.position.character }, ...(range ? { range } : {}) };
}
