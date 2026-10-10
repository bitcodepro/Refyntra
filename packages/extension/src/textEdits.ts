import { createHash } from 'node:crypto';
import type { PlannedTextChange, TextEditDto } from '@refyntra/contracts';

// Pure text helpers shared by the EditApplier and the rename preview (no vscode import: unit-tested with vitest).

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Offsets of line starts; a line ends at \r\n, \n or \r (as in VS Code and Roslyn). */
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

/** Applies sorted, non-overlapping edits (zero-based line, UTF-16 character) to a text. Throws on an invalid position. */
export function applyTextEditsToText(text: string, edits: readonly TextEditDto[]): string {
  const starts = lineStarts(text);
  const offset = (p: { line: number; character: number }): number => {
    const s = starts[p.line];
    if (s === undefined) throw new RangeError('edit outside the document');
    const end = p.line + 1 < starts.length ? starts[p.line + 1]! : text.length;
    if (s + p.character > end) throw new RangeError('edit outside the line');
    return s + p.character;
  };
  let out = '';
  let last = 0;
  for (const e of edits) {
    const s = offset(e.range.start);
    if (s < last) throw new RangeError('overlapping edits');
    out += text.slice(last, s) + e.newText;
    last = offset(e.range.end);
  }
  return out + text.slice(last);
}

/** Strict UTF-8 decode as VS Code shows it (a leading BOM is not part of the text). Undefined when not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
}

export interface PreviewFileModel {
  uri: string;
  original: string;
  modified: string;
  editCount: number;
  /** Why this file's preview does not match the plan (then the whole preview is invalid and Apply is disabled). */
  problem?: string;
}

/**
 * The preview of one planned change on the current text. The preview is only valid when the current text is the
 * text the plan was computed on and the edits produce exactly the planned result; otherwise `problem` is set.
 */
export function previewFile(change: PlannedTextChange, original: string): PreviewFileModel {
  const base = { uri: change.uri, original, editCount: change.edits.length };
  let modified: string;
  try {
    modified = applyTextEditsToText(original, change.edits);
  } catch {
    return { ...base, modified: original, problem: 'the edits do not fit the current text of the file' };
  }
  if (sha256(original) !== change.expectedHash) return { ...base, modified, problem: 'the file changed after the plan was computed' };
  if (sha256(modified) !== change.resultHash) return { ...base, modified, problem: 'the edits do not produce the planned result' };
  return { ...base, modified };
}
