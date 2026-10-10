// Maps a file path printed in a stack trace to workspace files (pure: no vscode import, unit-tested).
// Order: the exact path, then the longest path-suffix match; ties are reported as ambiguous so the user chooses.
// Case rules follow the OS: Windows and macOS compare case-insensitively, Linux case-sensitively. '\' and '/' are equal.

export type PathCase = 'insensitive' | 'sensitive';

export function caseRuleFor(platform: string): PathCase {
  return platform === 'win32' || platform === 'darwin' ? 'insensitive' : 'sensitive';
}

/** Forward slashes, no "./" segments, no duplicate separators, no trailing separator. */
export function normalizeFramePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  s = s.split('/').filter((seg, i) => seg !== '.' && !(seg === '' && i > 0)).join('/');
  return s.replace(/\/$/, '');
}

/** Path segments without leading "..", "." or an empty root. */
export function pathSegments(p: string): string[] {
  return normalizeFramePath(p)
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..');
}

export function basenameOf(p: string): string {
  const segs = pathSegments(p);
  return segs[segs.length - 1] ?? '';
}

export interface PathMatch {
  path: string;
  /** Number of trailing path segments equal to the frame's path (1 = file name only). */
  score: number;
}

export type PathResolution =
  | { kind: 'exact'; matches: [PathMatch] }
  | { kind: 'unique'; matches: [PathMatch] }
  | { kind: 'ambiguous'; matches: PathMatch[] }
  | { kind: 'none'; matches: [] };

function eq(a: string, b: string, rule: PathCase): boolean {
  return rule === 'insensitive' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Picks the workspace file(s) a frame path means. `candidates` are absolute paths of workspace files (any separator);
 * only those with the same file name can match.
 */
export function matchFramePath(framePath: string, candidates: readonly string[], rule: PathCase): PathResolution {
  const frame = normalizeFramePath(framePath);
  const fSegs = pathSegments(framePath);
  if (fSegs.length === 0) return { kind: 'none', matches: [] };
  const exact = candidates.find((c) => eq(normalizeFramePath(c), frame, rule));
  if (exact) return { kind: 'exact', matches: [{ path: exact, score: fSegs.length }] };
  const scored: PathMatch[] = [];
  for (const c of candidates) {
    const cSegs = pathSegments(c);
    let n = 0;
    while (n < fSegs.length && n < cSegs.length && eq(fSegs[fSegs.length - 1 - n]!, cSegs[cSegs.length - 1 - n]!, rule)) n++;
    if (n > 0) scored.push({ path: c, score: n });
  }
  if (scored.length === 0) return { kind: 'none', matches: [] };
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).sort((a, b) => a.path.localeCompare(b.path));
  // Distinct files only (the same file can be listed twice through overlapping workspace folders).
  const unique = top.filter((m, i) => top.findIndex((o) => eq(normalizeFramePath(o.path), normalizeFramePath(m.path), rule)) === i);
  return unique.length === 1 ? { kind: 'unique', matches: [unique[0]!] } : { kind: 'ambiguous', matches: unique };
}

/** "Line 120 of Orders.cs is past its end (80 lines)": the line moved when the file is shorter than the frame says. */
export function lineMayHaveMoved(line: number | undefined, lineCount: number): boolean {
  return line !== undefined && line > lineCount;
}
