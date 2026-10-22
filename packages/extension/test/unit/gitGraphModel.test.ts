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

describe('commit details, diff, GitHub remote, search', async () => {
  const { parseNumstat, parsePatch, gitHubRepoOf, searchArgs } = await import('../../src/gitGraphModel');

  it('reads numstat: counts, binary files, renames', () => {
    const s = parseNumstat(['3\t1\tsrc/a.cs', '-\t-\timg.png', '0\t0\t', 'old.cs', 'new.cs', ''].join('\0'));
    expect(s).toEqual([
      { path: 'src/a.cs', added: 3, deleted: 1, binary: false },
      { path: 'img.png', added: 0, deleted: 0, binary: true },
      { path: 'new.cs', from: 'old.cs', added: 0, deleted: 0, binary: false },
    ]);
  });

  it('reads a unified diff with line numbers on both sides', () => {
    const d = parsePatch('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ class X\n a\n-b\n+B\n c\n');
    expect(d.map((l) => `${l.kind}:${l.old ?? ''}:${l.new ?? ''}:${l.text}`)).toEqual(['hunk:::@@ -1,3 +1,3 @@ class X', 'ctx:1:1:a', 'del:2::b', 'add::2:B', 'ctx:3:3:c']);
  });

  it('finds owner/repo of GitHub remotes only', () => {
    expect(gitHubRepoOf('https://github.com/bitcodepro/Refyntra.git')).toEqual({ owner: 'bitcodepro', repo: 'Refyntra' });
    expect(gitHubRepoOf('git@github.com:a/b.git')).toEqual({ owner: 'a', repo: 'b' });
    expect(gitHubRepoOf('https://user@github.com/a/b')).toEqual({ owner: 'a', repo: 'b' });
    expect(gitHubRepoOf('https://gitlab.com/a/b.git')).toBeUndefined();
  });

  it('builds the search: message, code change, author; a branch or all', () => {
    expect(searchArgs('fix', 'message', 'main')).toEqual(['log', 'main', '--date-order', '-i', '--grep=fix', '--fixed-strings', '-n', '200']);
    expect(searchArgs('Triple', 'code', undefined)).toEqual(['log', '--all', '--date-order', '-STriple', '-n', '200']);
    expect(searchArgs('alice', 'author', undefined)).toContain('--author=alice');
  });
});
