/**
 * Git history and authorship (pure): `git blame --line-porcelain` and `git log` output parsed into lines, authors and
 * commits. The extension runs git (git.ts); this file only reads its text.
 */

export interface BlameLine {
  sha: string;
  author: string;
  /** Unix seconds of the author date. */
  time: number;
  summary: string;
}

/** Commits that are not committed yet appear with this sha in `git blame`. */
export const UNCOMMITTED = '0000000000000000000000000000000000000000';

/** `git blame --line-porcelain` → one entry per line of the file, in order. */
export function parseBlamePorcelain(text: string): BlameLine[] {
  const out: BlameLine[] = [];
  let cur: Partial<BlameLine> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      out.push({ sha: cur.sha ?? '', author: cur.author ?? '', time: cur.time ?? 0, summary: cur.summary ?? '' });
      cur = {};
      continue;
    }
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m) cur.sha = m[1];
    else if (line.startsWith('author ')) cur.author = line.slice(7);
    else if (line.startsWith('author-time ')) cur.time = Number(line.slice(12));
    else if (line.startsWith('summary ')) cur.summary = line.slice(8);
  }
  return out;
}

export interface Authorship {
  /** The author of most lines of the range (committed lines only). */
  mainAuthor: string;
  /** Distinct authors of the range. */
  authors: number;
  /** The newest change of the range. */
  lastAuthor: string;
  lastTime: number;
  lastSha: string;
  lastSummary: string;
  /** Lines of the range not committed yet. */
  uncommitted: number;
}

/**
 * Authorship of zero-based lines [from, to] (inclusive); undefined when no line is committed. Lines for which `skip`
 * is true (blank lines, lone braces: they belong to whoever wrote the enclosing block) are not counted.
 */
export function summarizeRange(lines: readonly BlameLine[], from: number, to: number, skip?: (line: number) => boolean): Authorship | undefined {
  const counts = new Map<string, number>();
  let last: BlameLine | undefined;
  let uncommitted = 0;
  for (let i = Math.max(0, from); i <= Math.min(to, lines.length - 1); i++) {
    const l = lines[i]!;
    if (skip?.(i)) continue;
    if (l.sha === UNCOMMITTED) {
      uncommitted++;
      continue;
    }
    counts.set(l.author, (counts.get(l.author) ?? 0) + 1);
    if (!last || l.time > last.time) last = l;
  }
  if (!last) return undefined;
  const mainAuthor = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  return { mainAuthor, authors: counts.size, lastAuthor: last.author, lastTime: last.time, lastSha: last.sha, lastSummary: last.summary, uncommitted };
}

/** The lines each declaration covers: from its line to the line before the next declaration (or the end). */
export function declarationRanges(lines: readonly number[], lineCount: number): { from: number; to: number }[] {
  const sorted = [...lines].sort((a, b) => a - b);
  return lines.map((l) => {
    const next = sorted.find((x) => x > l);
    return { from: l, to: (next ?? lineCount) - 1 };
  });
}

/** "3 months ago" style, from Unix seconds. */
export function relativeTime(time: number, nowSeconds: number): string {
  const s = Math.max(0, nowSeconds - time);
  const units: [number, string][] = [
    [365 * 24 * 3600, 'year'],
    [30 * 24 * 3600, 'month'],
    [7 * 24 * 3600, 'week'],
    [24 * 3600, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** The lens text of a declaration: "Alice, 3 months ago" or "Alice +2, 3 months ago (Bob)". */
export function authorshipTitle(a: Authorship, nowSeconds: number): string {
  const who = a.authors > 1 ? `${a.mainAuthor} +${a.authors - 1}` : a.mainAuthor;
  const last = a.lastAuthor !== a.mainAuthor ? ` (${a.lastAuthor})` : '';
  return `${who}, ${relativeTime(a.lastTime, nowSeconds)}${last}`;
}

export interface Commit {
  sha: string;
  author: string;
  email: string;
  time: number;
  subject: string;
}

/** The `git log` format these records are read from: fields separated by 0x1f, records by 0x1e. */
export const LOG_FORMAT = '%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s';

/** `git log --format=LOG_FORMAT` (also with -L or --name-only noise after each record) → commits. */
export function parseLog(text: string): Commit[] {
  const out: Commit[] = [];
  for (const rec of text.split('\x1e')) {
    const head = rec.split('\n')[0] ?? '';
    const f = head.split('\x1f');
    if (f.length < 5 || !/^[0-9a-f]{40}$/.test(f[0]!)) continue;
    out.push({ sha: f[0]!, author: f[1]!, email: f[2]!, time: Number(f[3]), subject: f.slice(4).join('\x1f') });
  }
  return out;
}
