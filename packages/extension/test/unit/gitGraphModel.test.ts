import { describe, expect, it } from 'vitest';
import { type GraphCommit, layoutGraph, parseBranches, parseGraphLog, parseStatus } from '../../src/gitGraphModel';

const c = (sha: string, parents: string[], refs: string[] = []): GraphCommit => ({ sha, parents, refs, author: 'a', time: 0, subject: sha });

describe('git graph lanes', () => {
  it('a straight history stays in lane 0', () => {
    const rows = layoutGraph([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[2]!.out).toEqual([]);
  });

  it('a branch and its merge: the feature takes a second lane between the merge and the fork point', () => {
    //   m (merge of f2 into main)
    //   |\
    //   | f2
    //   b |
    //   | f1
    //   |/
    //   a
    const rows = layoutGraph([c('m', ['b', 'f2'], ['HEAD -> main']), c('f2', ['f1'], ['feature']), c('b', ['a']), c('f1', ['a']), c('a', [])]);
    const by = Object.fromEntries(rows.map((r) => [r.commit.sha, r]));
    expect(by.m!.lane).toBe(0);
    expect(by.m!.out).toEqual([0, 1]);
    expect(by.f2!.lane).toBe(1);
    expect(by.b!.lane).toBe(0);
    expect(by.b!.pass).toEqual([1]);
    expect(by.f1!.lane).toBe(1);
    // The fork point: both lanes end in it.
    expect(by.a!.lane).toBe(0);
    expect(by.a!.into).toEqual([0, 1]);
    expect(Math.max(...rows.map((r) => r.width))).toBe(2);
  });

  it('two branch tips without a merge start in their own lanes', () => {
    const rows = layoutGraph([c('x', ['a'], ['topic']), c('y', ['a'], ['main']), c('a', [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[2]!.into).toEqual([0, 1]);
  });
});

describe('git log, branches and status', () => {
  it('reads the graph log with refs', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const [x] = parseGraphLog(`\x1e${A}\x1f${B}\x1fHEAD -> main, origin/main, tag: v1\x1fAlice\x1f100\x1fFix: a, b\n`);
    expect(x).toMatchObject({ sha: A, parents: [B], refs: ['HEAD -> main', 'origin/main', 'tag: v1'], author: 'Alice', time: 100, subject: 'Fix: a, b' });
  });

  it('reads branches with ahead / behind / gone', () => {
    const b = parseBranches('*\x1fmain\x1forigin/main\x1f[ahead 2, behind 1]\x1fabc\n \x1ftopic\x1f\x1f\x1fdef\n \x1fold\x1forigin/old\x1f[gone]\x1f123\n');
    expect(b.map((x) => [x.name, x.current, x.upstream ?? '', x.ahead, x.behind, x.gone])).toEqual([
      ['main', true, 'origin/main', 2, 1, false],
      ['topic', false, '', 0, 0, false],
      ['old', false, 'origin/old', 0, 0, true],
    ]);
  });

  it('reads porcelain status: staged and unstaged parts, renames, untracked, conflicts', () => {
    const s = parseStatus(['M  a.cs', ' M b.cs', 'MM c.cs', 'R  new.cs', 'old.cs', '?? n.txt', 'UU d.cs', ''].join('\0'));
    expect(s.map((x) => `${x.staged ? 'S' : 'W'}:${x.status}:${x.path}${x.from ? '<' + x.from : ''}`)).toEqual([
      'S:M:a.cs', 'W:M:b.cs', 'S:M:c.cs', 'W:M:c.cs', 'S:R:new.cs<old.cs', 'W:?:n.txt', 'W:U:d.cs',
    ]);
  });
});
