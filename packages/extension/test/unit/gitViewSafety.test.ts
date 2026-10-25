import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The Git tab against real repositories (the git CLI); only the VS Code API is replaced.

const ws = vi.hoisted(() => ({ folders: [] as { uri: { scheme: string; fsPath: string } }[], errors: [] as string[], infos: [] as string[] }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return ws.folders;
    },
    asRelativePath: (p: string) => p,
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
    showErrorMessage: (m: string) => (ws.errors.push(m), Promise.resolve(undefined)),
    showInformationMessage: (m: string) => (ws.infos.push(m), Promise.resolve(undefined)),
    showWarningMessage: () => Promise.resolve(undefined),
    withProgress: (_o: unknown, task: () => Promise<unknown>) => task(),
    state: { focused: false },
  },
  ProgressLocation: { Window: 10 },
  CodeActionKind: { Refactor: { append: (s: string) => s } },
}));

import { GitViewProvider } from '../../src/gitView';

const env = { ...process.env, GIT_AUTHOR_NAME: 'Dana', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'Dana', GIT_COMMITTER_EMAIL: '' };
const git = (cwd: string, ...args: string[]) => String(execFileSync('git', args, { cwd, env }));
const roots: string[] = [];

function memento() {
  const m = new Map<string, unknown>();
  return { get: (k: string) => m.get(k), update: (k: string, v: unknown) => (m.set(k, v), Promise.resolve()), keys: () => [...m.keys()] };
}

/** A workspace folder with two repositories, a and b: each has a modified tracked file and a new file. */
function twoRepos(): { a: string; b: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-gitview-'));
  roots.push(root);
  const make = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\nchanged\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), `${name} work\n`);
    return path.normalize(dir);
  };
  const a = make('a');
  const b = make('b');
  ws.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  return { a, b };
}

function provider(): GitViewProvider {
  const p = new GitViewProvider(() => true, memento() as never);
  p.hooks.confirm = true;
  return p;
}

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  ws.errors.length = 0;
  ws.infos.length = 0;
});

describe('Git tab: a changing operation stays in its repository', { timeout: 30000 }, () => {
  it('Discard started in a finishes in a when b is selected meanwhile (b keeps its new file)', async () => {
    const { a, b } = twoRepos();
    const g = provider();
    expect((await g.refresh()).repo).toBe(a);
    const discard = g.discard(['tracked.txt', 'new.txt']);
    const select = g.selectRepo(b); // the page switches while restore runs in a
    expect(await discard).toBe(true);
    await select;
    expect(g.model().repo).toBe(b);
    expect(fs.existsSync(path.join(a, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(a, 'tracked.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(b, 'new.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(b, 'tracked.txt'), 'utf8')).toBe('one\nchanged\n');
  });

  it("a page message for a is not run after b was selected (the page's paths belong to a)", async () => {
    const { a, b } = twoRepos();
    const g = provider();
    await g.refresh();
    const onMessage = (m: Record<string, unknown>) => (g as unknown as { onMessage(m: unknown): Promise<void> }).onMessage(m);
    const select = onMessage({ type: 'repo', repo: b, forRepo: a });
    const discard = onMessage({ type: 'discard', paths: ['tracked.txt', 'new.txt'], forRepo: a });
    await Promise.all([select, discard]);
    expect(g.model().repo).toBe(b);
    expect(fs.existsSync(path.join(b, 'new.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(b, 'tracked.txt'), 'utf8')).toBe('one\nchanged\n');
    expect(fs.existsSync(path.join(a, 'new.txt'))).toBe(true);
    expect(ws.infos.some((m) => m.includes('nothing was done'))).toBe(true);
  });

  it('changing operations run one at a time: stage then commit, sent together, commit what was staged', async () => {
    const { a } = twoRepos();
    const g = provider();
    await g.refresh();
    const stage = g.stage(['tracked.txt']);
    const commit = g.commit('Tracked change');
    await stage;
    expect(await commit).toBe(true);
    expect(git(a, 'log', '-1', '--format=%s').trim()).toBe('Tracked change');
  });

  it('Discard ignores paths that are not changes of the repository', async () => {
    const { a } = twoRepos();
    const g = provider();
    await g.refresh();
    fs.writeFileSync(path.join(a, 'ignored-by-list.txt'), 'x');
    expect(await g.discard(['not-a-change.txt'])).toBe(false);
    expect(fs.existsSync(path.join(a, 'ignored-by-list.txt'))).toBe(true);
  });
});

describe('Git tab: a failed branch switch restores only its own stash', { timeout: 30000 }, () => {
  it('a stale dirty model and a no-op stash push leave an older user stash alone', async () => {
    const { a } = twoRepos();
    git(a, 'stash', 'push', '-u', '-m', 'older user work');
    const older = git(a, 'rev-parse', 'refs/stash').trim();
    fs.writeFileSync(path.join(a, 'tracked.txt'), 'temporary change\n');
    const g = provider();
    await g.refresh();
    // Another tool clears the changes after Refyntra read them; stash push will save nothing.
    git(a, 'restore', '--worktree', '--', 'tracked.txt');
    expect(await g.switchBranch('missing-branch', 'stash')).toBe('failed');
    expect(git(a, 'rev-parse', 'refs/stash').trim()).toBe(older);
    expect(fs.readFileSync(path.join(a, 'tracked.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(a, 'new.txt'))).toBe(false);
  });

  it('a clean model with stash mode also leaves an older stash alone', async () => {
    const { a } = twoRepos();
    git(a, 'stash', 'push', '-u', '-m', 'older user work');
    const older = git(a, 'rev-parse', 'refs/stash').trim();
    const g = provider();
    await g.refresh();
    expect(await g.switchBranch('missing-branch', 'stash')).toBe('failed');
    expect(git(a, 'rev-parse', 'refs/stash').trim()).toBe(older);
    expect(fs.existsSync(path.join(a, 'new.txt'))).toBe(false);
  });

  it('restores newly stashed work on failure and keeps a recovery stash and older stashes', async () => {
    const { a } = twoRepos();
    git(a, 'stash', 'push', '-u', '-m', 'older user work');
    const older = git(a, 'rev-parse', 'refs/stash').trim();
    fs.writeFileSync(path.join(a, 'tracked.txt'), 'new work\n');
    const g = provider();
    await g.refresh();
    expect(await g.switchBranch('missing-branch', 'stash')).toBe('failed');
    expect(fs.readFileSync(path.join(a, 'tracked.txt'), 'utf8')).toBe('new work\n');
    const saved = git(a, 'stash', 'list', '--format=%H').trim().split('\n');
    expect(saved).toHaveLength(2);
    expect(saved[1]).toBe(older);
    expect(ws.infos.some((m) => /recovery stash/i.test(m))).toBe(true);
  });
});

describe('Git tab: Push follows the configured upstream and push settings', { timeout: 30000 }, () => {
  function withRemotes(): { repo: string; origin: string; upstream: string } {
    const { a } = twoRepos();
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-origin-'));
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-upstream-'));
    roots.push(origin, upstream);
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(upstream, 'init', '-q', '--bare', '-b', 'main');
    git(a, 'remote', 'add', 'origin', origin);
    git(a, 'remote', 'add', 'upstream', upstream);
    git(a, 'push', '-q', 'upstream', 'main:review');
    git(a, 'fetch', '-q', 'upstream');
    git(a, 'switch', '-q', '-c', 'feature', '--track', 'upstream/review');
    git(a, 'commit', '-q', '-am', 'Feature work');
    return { repo: a, origin, upstream };
  }
  const heads = (bare: string) => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

  it('push.default=nothing refuses publication of a branch without an upstream', async () => {
    const { repo, origin } = withRemotes();
    git(repo, 'switch', '-q', '-c', 'unpublished');
    git(repo, 'config', 'push.default', 'nothing');
    const g = provider();
    await g.refresh();
    expect(await g.push()).toBe(false);
    expect(g.lastError).toContain('push.default is "nothing"');
    expect(heads(origin)).toEqual([]);
    expect(git(repo, 'for-each-ref', '--format=%(upstream)', 'refs/heads/unpublished').trim()).toBe('');
  });

  it('feature tracking upstream/review with push.default=upstream goes to upstream review, not origin/feature', async () => {
    const { repo, origin, upstream } = withRemotes();
    git(repo, 'config', 'push.default', 'upstream');
    const g = provider();
    await g.refresh();
    expect(await g.push()).toBe(true);
    expect(git(upstream, 'log', '-1', '--format=%s', 'review').trim()).toBe('Feature work');
    expect(heads(origin)).toEqual([]);
  });

  it('with push.default simple (git default) a differently named upstream is refused, as git refuses it; nothing is pushed', async () => {
    const { origin, upstream } = withRemotes();
    const g = provider();
    await g.refresh();
    expect(await g.push()).toBe(false);
    expect(g.lastError).toMatch(/push\.default "simple"/);
    expect(heads(origin)).toEqual([]);
    expect(git(upstream, 'log', '-1', '--format=%s', 'review').trim()).toBe('Initial');
  });

  it('branch.<name>.pushRemote sends the push there under the local name', async () => {
    const { repo, origin } = withRemotes();
    git(repo, 'config', 'branch.feature.pushRemote', 'origin');
    const g = provider();
    await g.refresh();
    expect(await g.push()).toBe(true);
    expect(heads(origin)).toEqual(['feature']);
  });

  it('a branch without an upstream is published to origin and tracks it', async () => {
    const { repo, origin } = withRemotes();
    git(repo, 'switch', '-q', '-c', 'solo');
    const g = provider();
    await g.refresh();
    expect(await g.push()).toBe(true);
    expect(heads(origin)).toEqual(['solo']);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'solo@{upstream}').trim()).toBe('origin/solo');
  });
});
