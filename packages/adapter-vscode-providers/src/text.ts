import type { Position, TextEditDto } from '@refyntra/contracts';

// Pure text helpers (zero-based line, UTF-16 character, line ends \r\n, \n or \r as in VS Code).

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetOf(text: string, starts: number[], p: Position): number {
  const s = starts[p.line];
  if (s === undefined) throw new RangeError('edit outside the document');
  const end = p.line + 1 < starts.length ? starts[p.line + 1]! : text.length;
  if (s + p.character > end) throw new RangeError('edit outside the line');
  return s + p.character;
}

export function comparePos(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

/** Sorted by start (then end); stable for equal ranges. */
export function sortEdits(edits: readonly TextEditDto[]): TextEditDto[] {
  return [...edits].sort((a, b) => comparePos(a.range.start, b.range.start) || comparePos(a.range.end, b.range.end));
}

/** True when two sorted edits overlap (touching ranges are fine; two inserts at one point are not). */
export function hasOverlap(sorted: readonly TextEditDto[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (comparePos(prev.range.end, cur.range.start) > 0) return true;
    if (comparePos(prev.range.start, cur.range.start) === 0 && comparePos(prev.range.start, prev.range.end) === 0 && comparePos(cur.range.start, cur.range.end) === 0) return true;
  }
  return false;
}

/** Applies sorted, non-overlapping edits. Throws RangeError for a position outside the text. */
export function applyEdits(text: string, sorted: readonly TextEditDto[]): string {
  const starts = lineStarts(text);
  let out = '';
  let last = 0;
  for (const e of sorted) {
    const s = offsetOf(text, starts, e.range.start);
    const end = offsetOf(text, starts, e.range.end);
    if (s < last || end < s) throw new RangeError('overlapping edits');
    out += text.slice(last, s) + e.newText;
    last = end;
  }
  return out + text.slice(last);
}

/** More than one kind of line ending (VS Code normalizes such a file when it opens it: preview ≠ result). */
export function hasMixedLineEndings(text: string): boolean {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  return [crlf, lf, cr].filter((n) => n > 0).length > 1;
}

/** The text in a range, or undefined when the range does not fit. */
export function textInRange(text: string, start: Position, end: Position): string | undefined {
  try {
    const starts = lineStarts(text);
    return text.slice(offsetOf(text, starts, start), offsetOf(text, starts, end));
  } catch {
    return undefined;
  }
}

/** The JS/TS identifier around a position (`$` and `_` allowed). */
export function identifierAt(text: string, p: Position): string | undefined {
  const starts = lineStarts(text);
  const s = starts[p.line];
  if (s === undefined) return undefined;
  const end = p.line + 1 < starts.length ? starts[p.line + 1]! : text.length;
  const line = text.slice(s, end);
  const re = /[A-Za-z_$][\w$]*/g;
  for (const m of line.matchAll(re)) {
    const a = m.index ?? 0;
    if (a <= p.character && p.character <= a + m[0].length) return m[0];
  }
  return undefined;
}

export function basename(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? uri;
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
