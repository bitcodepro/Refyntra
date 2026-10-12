// Rider-style C# postfix templates (`items.foreach`, `flag.if`…) offered by the C# host (protocol 1.10, code/postfix).
// Pure: unit-tested with vitest (no vscode). The completion provider (postfix.ts) turns these into CompletionItems.

export const POSTFIX_SETTING = 'postfix.enabled';

/** Templates sort after the regular members: '~' sorts after letters, digits and '_'. */
export const POSTFIX_SORT_PREFIX = '~';

export interface PostfixTemplateData {
  name: string;
  detail: string;
  snippet: string;
}

export interface Pos {
  line: number;
  character: number;
}

export interface PostfixCompletion {
  label: string;
  /** Text VS Code matches against what is typed from the expression start (expression, dot, partial name). */
  filterText: string;
  snippet: string;
  detail: string;
  sortText: string;
  /** Replaced range: the expression, the dot and the typed name (single line). */
  range: { start: Pos; end: Pos };
}

const isIdent = (ch: string): boolean => /[\p{L}\p{Nd}_]/u.test(ch);

/**
 * The character index of the dot the cursor follows (the cursor may be after part of a template name: `list.fo|`), or
 * undefined: no dot, `..` (a range), `?.`, a space before the dot, or a number literal (`1.5`).
 */
export function postfixDot(lineText: string, character: number): number | undefined {
  let i = Math.min(character, lineText.length);
  while (i > 0 && isIdent(lineText[i - 1]!)) i--;
  const dot = i - 1;
  if (dot < 1 || lineText[dot] !== '.') return undefined;
  const before = lineText[dot - 1]!;
  if (/\s/.test(before) || before === '.' || before === '?') return undefined;
  if (/\d/.test(before)) {
    let j = dot - 1;
    while (j >= 0 && /\d/.test(lineText[j]!)) j--;
    if (j < 0 || !isIdent(lineText[j]!)) return undefined; // 1. / 2.5: a number, not an expression
  }
  return dot;
}

/** Cache key: the same document version and dot answer the same templates. */
export function postfixCacheKey(uri: string, version: number, line: number, dot: number): string {
  return `${uri}#${version}#${line}:${dot}`;
}

/**
 * Completion items for the host's templates. Only expressions on the cursor's line are offered (a completion range
 * must be single-line); the range covers the expression, the dot and the name typed so far.
 */
export function postfixCompletions(
  templates: readonly PostfixTemplateData[],
  expressionRange: { start: Pos; end: Pos } | null | undefined,
  lineText: string,
  position: Pos,
): PostfixCompletion[] {
  if (!expressionRange || expressionRange.start.line !== position.line || expressionRange.end.line !== position.line) return [];
  const dot = postfixDot(lineText, position.character);
  if (dot === undefined || expressionRange.end.character !== dot || expressionRange.start.character > dot) return [];
  const expr = lineText.slice(expressionRange.start.character, dot);
  const seen = new Set<string>();
  const out: PostfixCompletion[] = [];
  templates.forEach((t, i) => {
    if (!t || typeof t.name !== 'string' || !/^[a-z]+$/.test(t.name) || typeof t.snippet !== 'string' || seen.has(t.name)) return;
    seen.add(t.name);
    out.push({
      label: t.name,
      filterText: `${expr}.${t.name}`,
      snippet: t.snippet,
      detail: typeof t.detail === 'string' ? t.detail : '',
      sortText: `${POSTFIX_SORT_PREFIX}${String(i).padStart(2, '0')}`,
      range: { start: { line: position.line, character: expressionRange.start.character }, end: { line: position.line, character: position.character } },
    });
  });
  return out;
}
