import { describe, expect, it } from 'vitest';
import { authorshipTitle, declarationRanges, parseBlamePorcelain, parseLog, relativeTime, summarizeRange, UNCOMMITTED } from '../../src/gitModel';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const block = (sha: string, author: string, time: number, summary: string, text: string) =>
  `${sha} 1 1 1\nauthor ${author}\nauthor-mail <x@y>\nauthor-time ${time}\nauthor-tz +0000\ncommitter ${author}\nsummary ${summary}\nfilename f.cs\n\t${text}\n`;

describe('git blame and log', () => {
  it('reads blame porcelain line by line', () => {
    const lines = parseBlamePorcelain(block(A, 'Alice', 100, 'first', 'class A') + block(B, 'Bob', 200, 'fix', '{') + block(UNCOMMITTED, 'Not Committed Yet', 300, 'Version of f.cs from f.cs', '}'));
    expect(lines.map((l) => [l.author, l.time])).toEqual([['Alice', 100], ['Bob', 200], ['Not Committed Yet', 300]]);
  });

  it('summarises a range: main author, number of authors, newest change, uncommitted lines', () => {
    const lines = parseBlamePorcelain(block(A, 'Alice', 100, 'first', 'a') + block(A, 'Alice', 100, 'first', 'b') + block(B, 'Bob', 200, 'fix', 'c') + block(UNCOMMITTED, 'x', 300, 's', 'd'));
    const s = summarizeRange(lines, 0, 3)!;
    expect(s).toMatchObject({ mainAuthor: 'Alice', authors: 2, lastAuthor: 'Bob', lastTime: 200, lastSummary: 'fix', uncommitted: 1 });
    expect(authorshipTitle(s, 200 + 3 * 30 * 24 * 3600)).toBe('Alice +1, 3 months ago (Bob)');
    expect(summarizeRange(lines, 3, 3)).toBeUndefined();
    // Skipped lines (lone braces) do not count.
    expect(summarizeRange(lines, 0, 3, (i) => i < 2)).toMatchObject({ mainAuthor: 'Bob', authors: 1 });
  });

  it('gives each declaration the lines up to the next one', () => {
    expect(declarationRanges([2, 10, 5], 20)).toEqual([{ from: 2, to: 4 }, { from: 10, to: 19 }, { from: 5, to: 9 }]);
  });

  it('relative times', () => {
    expect(relativeTime(0, 30)).toBe('just now');
    expect(relativeTime(0, 3600)).toBe('1 hour ago');
    expect(relativeTime(0, 2 * 365 * 24 * 3600)).toBe('2 years ago');
  });

  it('reads log records, also with file names after them', () => {
    const text = `\x1e${A}\x1fAlice\x1fa@x\x1f100\x1fAdd A\n\nsrc/a.cs\n\x1e${B}\x1fBob\x1fb@x\x1f200\x1fRename\n\nsrc/old.cs\n`;
    expect(parseLog(text).map((c) => [c.sha.slice(0, 1), c.author, c.time, c.subject])).toEqual([['a', 'Alice', 100, 'Add A'], ['b', 'Bob', 200, 'Rename']]);
  });
});
