import { describe, expect, it } from 'vitest';
import { type GraphCommit, layoutGraph, parseBranches, parseGraphLog, parseStatus, pushPlan } from '../../src/gitGraphModel';

describe('push.default=nothing: Publish names its target, a push without one is refused', () => {
  it.each([
    [{}, 'origin'],
    [{ remote: 'origin' }, 'origin'],
    [{ merge: 'refs/heads/topic' }, 'origin'],
    [{ pushRemote: 'upstream' }, 'upstream'],
  ])('a branch without a complete upstream (%j) is published to %s, as git push -u <remote> <branch> is', (config, remote) => {
    expect(pushPlan({ branch: 'topic', remotes: ['origin', 'upstream'], pushDefault: 'nothing', ...config })).toEqual({
      ok: true,
      args: ['push', '-u', remote, 'refs/heads/topic:refs/heads/topic'],
      label: `Publish topic to ${remote}`,
    });
  });

  it('a branch with an upstream is not pushed (git push without a target does nothing)', () => {
    expect(pushPlan({ branch: 'topic', remote: 'origin', merge: 'refs/heads/topic', remotes: ['origin'], pushDefault: 'nothing' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('push.default is "nothing"'),
    });
  });
});

describe('push target from the git configuration', () => {
  const tracking = { branch: 'feature', remote: 'upstream', merge: 'refs/heads/review', remotes: ['origin', 'upstream'] };

  it('a differently named upstream: refused with push.default simple (git default), pushed to it with upstream', () => {
    const simple = pushPlan(tracking);
    expect(simple.ok).toBe(false);
    expect(!simple.ok && simple.reason).toMatch(/upstream\/review/);
    expect(pushPlan({ ...tracking, pushDefault: 'upstream' })).toEqual({ ok: true, args: ['push', 'upstream', 'refs/heads/feature:refs/heads/review'], label: 'Push feature to upstream/review' });
    expect(pushPlan({ ...tracking, pushDefault: 'tracking' })).toMatchObject({ ok: true, args: ['push', 'upstream', 'refs/heads/feature:refs/heads/review'] });
  });

  it('never origin just because it exists: the upstream remote of a same-named branch', () => {
    expect(pushPlan({ ...tracking, merge: 'refs/heads/feature' })).toMatchObject({ ok: true, args: ['push', 'upstream', 'refs/heads/feature:refs/heads/feature'] });
  });

  it('pushRemote, then remote.pushDefault, take the push (triangular: the local name)', () => {
    expect(pushPlan({ ...tracking, pushRemote: 'origin', pushDefaultRemote: 'upstream' })).toMatchObject({ ok: true, args: ['push', 'origin', 'refs/heads/feature:refs/heads/feature'] });
    expect(pushPlan({ ...tracking, pushDefaultRemote: 'origin' })).toMatchObject({ ok: true, args: ['push', 'origin', 'refs/heads/feature:refs/heads/feature'] });
    expect(pushPlan({ ...tracking, pushDefaultRemote: 'origin', pushDefault: 'upstream' }).ok).toBe(false);
  });

  it('push.default current and nothing', () => {
    expect(pushPlan({ ...tracking, pushDefault: 'current' })).toMatchObject({ ok: true, args: ['push', 'upstream', 'refs/heads/feature:refs/heads/feature'] });
    expect(pushPlan({ ...tracking, pushDefault: 'nothing' }).ok).toBe(false);
  });

  it('no upstream: published to pushRemote, origin or the only remote; refused when none fits', () => {
    expect(pushPlan({ branch: 'solo', remotes: ['origin', 'fork'] })).toEqual({ ok: true, args: ['push', '-u', 'origin', 'refs/heads/solo:refs/heads/solo'], label: 'Publish solo to origin' });
    expect(pushPlan({ branch: 'solo', remotes: ['fork'] })).toMatchObject({ ok: true, args: ['push', '-u', 'fork', 'refs/heads/solo:refs/heads/solo'] });
    expect(pushPlan({ branch: 'solo', pushDefaultRemote: 'fork', remotes: ['origin', 'fork'] })).toMatchObject({ ok: true, args: ['push', '-u', 'fork', 'refs/heads/solo:refs/heads/solo'] });
    expect(pushPlan({ branch: 'solo', remotes: ['a', 'b'] }).ok).toBe(false);
    expect(pushPlan({ branch: 'solo', remotes: [] }).ok).toBe(false);
  });
});

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
