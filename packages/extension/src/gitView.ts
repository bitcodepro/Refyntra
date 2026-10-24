import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitUri, runGit } from './git';
import { liveWatchdogs, watchWebview, webviewNotices } from './webviewWatchdog';
import {
  BRANCH_FORMAT,
  type Branch,
  type FileChange,
  type FileStat,
  GRAPH_FORMAT,
  type GraphCommit,
  type GraphRow,
  gitHubRepoOf,
  layoutGraph,
  parseBranches,
  parseGraphLog,
  parseNumstat,
  parsePatch,
  parseStatus,
  type SearchMode,
  searchArgs,
} from './gitGraphModel';
import { type FetchLike, GitHubClient, type PullRequest } from './github';

/**
 * The Refyntra Git tab, a git client of its own: changes (stage, unstage, discard, commit, commit & push), branches
 * (checkout, create, merge into the current one, push, delete), fetch / pull / push, the commit graph of every branch,
 * search in commits (message, code changes, author; one branch or all), GitHub pull requests (list, create, merge,
 * check out). A commit opens in the editor area with its files and a coloured diff. git CLI, trusted workspaces only;
 * GitHub through VS Code's GitHub sign-in, only when asked.
 */

export const GIT_VIEW = 'refyntra.gitView';
const GRAPH_LIMIT = 400;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** The message of the stash that keeps a branch's changes while another branch is checked out. */
const STASH_PREFIX = 'refyntra: changes left on ';

/** A repository's state for the overview: its branch, ahead / behind its upstream, changed files. */
export interface RepoState {
  path: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: number;
}

/** `git status --porcelain=v2 --branch` → branch, upstream, ahead / behind and the number of changed entries. */
export function parseRepoState(repo: string, text: string): RepoState {
  let branch = '';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith('#')) changes++;
  }
  return { path: repo, branch, ...(upstream ? { upstream } : {}), ahead, behind, changes };
}

export interface GitViewModel {
  /** Every repository of the workspace with its state (the overview of a folder with several). */
  states?: RepoState[];
  repos: string[];
  repo?: string;
  head?: string;
  changes: FileChange[];
  branches: Branch[];
  remoteBranches: string[];
  rows: GraphRow[];
  /** The rows of the last search (shown instead of the graph), with its text. */
  search?: { text: string; mode: SearchMode; branch?: string; rows: GraphRow[] };
  /** The repository has a remote to push to. */
  hasRemote?: boolean;
  /** Changes left on the current branch when switching away (Restore brings them back). */
  stash?: { ref: string; branch: string };
  github?: { owner: string; repo: string };
  pulls?: PullRequest[];
  pullsError?: string;
  busy?: string;
  error?: string;
}

/** The repositories of the workspace folders: each folder's own and those up to three levels below. */
export function findRepos(folders: readonly string[]): string[] {
  const out = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) out.add(path.normalize(dir));
    if (depth === 0) return;
    for (const e of entries) if (e.isDirectory() && !/^(node_modules|bin|obj|\.git|\.vs|\.vscode-test|dist|out)$/.test(e.name)) walk(path.join(dir, e.name), depth - 1);
  };
  for (const f of folders) walk(f, 3);
  return [...out].sort();
}

/**
 * `git pull` as the repository wants it: its own pull.rebase setting when there is one, otherwise a merge (git refuses a
 * pull of diverged branches when nothing says how).
 */
async function pullArgs(repo: string): Promise<string[]> {
  const r = await runGit(['config', '--get', 'pull.rebase'], repo);
  return r.code === 0 ? ['pull'] : ['pull', '--no-rebase'];
}

/** A branch name git accepts and that cannot be read as an option. */
function safeRef(name: string): boolean {
  return /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
}

export interface GitHooks {
  /** Tests: the answer to every confirmation (no modal). */
  confirm?: boolean;
  /** Tests: the answers of input boxes, in order. */
  inputs?: string[];
  /** Tests: a GitHub client instead of signing in. */
  github?: (owner: string, repo: string) => GitHubClient;
  /** Tests: the fetch used by the GitHub client. */
  fetch?: FetchLike;
}

export class GitViewProvider implements vscode.WebviewViewProvider {
  private sideView: vscode.WebviewView | undefined;
  private readonly webviews = new Set<vscode.Webview>();
  private editorPanel: vscode.WebviewPanel | undefined;
  private repo: string | undefined;
  private current: GitViewModel = { repos: [], changes: [], branches: [], remoteBranches: [], rows: [] };
  private refreshing: Promise<GitViewModel> | undefined;
  private search: GitViewModel['search'];
  private pulls: { list?: PullRequest[]; error?: string } = {};
  private busy: string | undefined;
  readonly hooks: GitHooks = {};
  readonly commits = new CommitPanels(this);

  constructor(
    private readonly isTrusted: () => boolean,
    private readonly state: vscode.Memento,
  ) {}

  repoPath(): string | undefined {
    return this.repo;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sideView = view;
    this.attach(view.webview, false);
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    const webview = view.webview;
    view.onDidDispose(() => {
      this.detach(webview);
      if (this.sideView === view) this.sideView = undefined;
    });
    this.updateBadge();
  }

  /** The load watchdog of each attached page (ended when the page answers or its view closes). */
  private readonly watchdogs = new Map<vscode.Webview, vscode.Disposable>();

  /** Test hook: watchdogs still waiting and notices that would have been shown. */
  watchdogState(): { live: number; notices: number } {
    return { live: liveWatchdogs(), notices: webviewNotices.length };
  }

  private detach(webview: vscode.Webview): void {
    this.webviews.delete(webview);
    this.watchdogs.get(webview)?.dispose();
    this.watchdogs.delete(webview);
  }

  private attach(webview: vscode.Webview, wide: boolean): void {
    webview.options = { enableScripts: true };
    webview.html = sidebarHtml(webview, wide);
    this.watchdogs.set(webview, watchWebview(webview, 'Git'));
    webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void this.onMessage(m));
    this.webviews.add(webview);
    void this.refresh();
  }

  /** The client in a tab of the editor area (the whole width: two columns). */
  openInEditor(): vscode.WebviewPanel {
    if (this.editorPanel) {
      this.editorPanel.reveal();
      return this.editorPanel;
    }
    const panel = vscode.window.createWebviewPanel('refyntra.gitClient', 'Refyntra Git', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.editorPanel = panel;
    // Kept now: a disposed panel's .webview throws "Webview is disposed" (the dispose handler would fail, the panel be
    // remembered and the next Open in Editor reveal a disposed panel).
    const webview = panel.webview;
    this.attach(webview, true);
    panel.onDidDispose(() => {
      this.detach(webview);
      if (this.editorPanel === panel) this.editorPanel = undefined;
    });
    return panel;
  }

  /** The number of incoming commits (all repositories) on the tab's icon. */
  private updateBadge(): void {
    if (!this.sideView) return;
    const behind = (this.current.states ?? []).reduce((n, s) => n + s.behind, 0);
    this.sideView.badge = behind > 0 ? { value: behind, tooltip: `${behind} incoming commit(s) to pull` } : undefined;
  }

  model(): GitViewModel {
    return this.current;
  }

  /**
   * Re-reads the repository and redraws. A read that started before this call may miss what the caller just did
   * (a fetch, a commit), so a call during a read waits for it and then reads again; calls that arrive meanwhile share
   * that next read.
   */
  refresh(): Promise<GitViewModel> {
    if (this.refreshing) {
      this.queued ??= this.refreshing.then(() => {
        this.queued = undefined;
        return this.refresh();
      });
      return this.queued;
    }
    this.refreshing = this.read()
      .then((m) => {
        this.current = m;
        this.post();
        return m;
      })
      .finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private queued: Promise<GitViewModel> | undefined;

  private post(): void {
    const model = toWire({ ...this.current, ...(this.busy ? { busy: this.busy } : {}) });
    this.broadcast({ type: 'model', model });
    this.updateBadge();
  }

  /** Sends to every open page; a page closed meanwhile is dropped (posting to it throws "Webview is disposed"). */
  private broadcast(message: unknown): void {
    for (const w of [...this.webviews]) {
      try {
        void Promise.resolve(w.postMessage(message)).then(undefined, () => this.webviews.delete(w));
      } catch {
        this.webviews.delete(w);
      }
    }
  }

  private async read(): Promise<GitViewModel> {
    const empty = { changes: [], branches: [], remoteBranches: [], rows: [] };
    if (!this.isTrusted()) return { repos: [], ...empty, error: 'Trust the workspace to use Git here (a repository configuration can run programs).' };
    const repos = findRepos((vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath));
    if (repos.length === 0) return { repos, ...empty, error: 'No git repository in this workspace.' };
    const saved = this.state.get<string>('refyntra.git.repo');
    const repo = [this.repo, saved].find((r) => r && repos.includes(r)) ?? repos[0]!;
    if (repo !== this.repo) {
      this.search = undefined;
      this.pulls = {};
    }
    this.repo = repo;
    const [status, branches, remotes, log, head, origin] = await Promise.all([
      runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repo),
      runGit(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'], repo),
      runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repo),
      runGit(['log', '--all', '--date-order', `--format=${GRAPH_FORMAT}`, '-n', String(GRAPH_LIMIT)], repo),
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo),
      runGit(['remote', 'get-url', 'origin'], repo),
    ]);
    const hasRemote = (await runGit(['remote'], repo)).stdout.trim().length > 0;
    if (status.code !== 0) return { repos, repo, ...empty, error: status.stderr.trim() || 'git status failed.' };
    const github = origin.code === 0 ? gitHubRepoOf(origin.stdout) : undefined;
    // The overview of every repository is read separately (refreshStates); the selected one is updated here.
    const branchList = parseBranches(branches.stdout);
    const changes = parseStatus(status.stdout);
    const curBranch = branchList.find((b) => b.current);
    const own: RepoState = { path: repo, branch: head.stdout.trim(), ...(curBranch?.upstream ? { upstream: curBranch.upstream } : {}), ahead: curBranch?.ahead ?? 0, behind: curBranch?.behind ?? 0, changes: new Set(changes.map((c) => c.path)).size };
    const known = this.states.filter((x) => repos.includes(x.path) && x.path !== repo);
    const states = repos.map((r) => (r === repo ? own : known.find((x) => x.path === r) ?? { path: r, branch: '', ahead: 0, behind: 0, changes: 0 }));
    if (this.states.length === 0 && repos.length > 1) void this.refreshStates();
    const stash = await this.stashFor(repo, own.branch);
    return {
      states,
      ...(stash ? { stash } : {}),
      hasRemote,
      repos,
      repo,
      head: head.stdout.trim(),
      changes,
      branches: branchList,
      remoteBranches: remotes.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD')),
      rows: log.code === 0 ? layoutGraph(parseGraphLog(log.stdout)) : [],
      ...(this.search ? { search: this.search } : {}),
      ...(github ? { github } : {}),
      ...(this.pulls.list ? { pulls: this.pulls.list } : {}),
      ...(this.pulls.error ? { pullsError: this.pulls.error } : {}),
    };
  }

  private states: RepoState[] = [];
  private statesRunning: Promise<RepoState[]> | undefined;

  /** The overview: branch, ahead / behind and changes of every repository, four at a time. */
  refreshStates(): Promise<RepoState[]> {
    if (this.statesRunning) return this.statesRunning;
    this.statesRunning = (async () => {
      const repos = this.current.repos;
      const out: RepoState[] = new Array(repos.length);
      let next = 0;
      const worker = async () => {
        while (next < repos.length) {
          const i = next++;
          const r = repos[i]!;
          out[i] = parseRepoState(r, (await runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], r)).stdout);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, repos.length) }, worker));
      this.states = out.filter(Boolean);
      this.current = { ...this.current, states: this.states };
      this.post();
      return this.states;
    })().finally(() => (this.statesRunning = undefined));
    return this.statesRunning;
  }

  /** The stash Refyntra left for a branch when switching away from it with changes. */
  private async stashFor(repo: string, branch: string): Promise<{ ref: string; branch: string } | undefined> {
    if (!branch) return undefined;
    const r = await runGit(['stash', 'list', '--format=%gd%x1f%s'], repo);
    for (const line of r.stdout.split('\n')) {
      const [ref, subject] = line.split('\x1f');
      if (ref && subject?.endsWith(`${STASH_PREFIX}${branch}`)) return { ref, branch };
    }
    return undefined;
  }

  async selectRepo(repo: string): Promise<void> {
    this.repo = repo;
    this.search = undefined;
    this.pulls = {};
    await this.state.update('refyntra.git.repo', repo);
    await this.refresh();
  }

  // ---- running git

  /** Runs git in the repository; on failure shows git's own message (last lines) and returns false. */
  private async git(args: string[], what: string, stdin?: string): Promise<{ ok: boolean; stdout: string }> {
    if (!this.repo) return { ok: false, stdout: '' };
    const r = await runGit(args, this.repo, stdin);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-3).join(' ');
      void vscode.window.showErrorMessage(`Refyntra: ${what} failed: ${msg || `git exited with ${r.code}`}`);
      this.lastError = msg;
      return { ok: false, stdout: r.stdout };
    }
    return { ok: true, stdout: r.stdout };
  }

  /** Tests: git's message of the last failure. */
  lastError: string | undefined;

  /** A network operation (fetch, pull, push): progress in the tab and the window. */
  private async network(label: string, args: string[]): Promise<boolean> {
    this.busy = label;
    this.post();
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Refyntra: ${label}` }, async () => (await this.git(args, label)).ok);
    } finally {
      this.busy = undefined;
      await this.refresh();
    }
  }

  private async confirm(message: string, action: string): Promise<boolean> {
    if (this.hooks.confirm !== undefined) return this.hooks.confirm;
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }

  private async input(options: vscode.InputBoxOptions): Promise<string | undefined> {
    if (this.hooks.inputs) return this.hooks.inputs.shift();
    return vscode.window.showInputBox(options);
  }

  // ---- changes

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(['add', '--', ...paths], 'stage');
    await this.refresh();
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(['restore', '--staged', '--', ...paths], 'unstage');
    await this.refresh();
  }

  /** Discards working tree changes (asks first): tracked files are restored, untracked ones deleted. */
  async discard(paths: string[]): Promise<boolean> {
    if (paths.length === 0 || !this.repo) return false;
    const untracked = this.current.changes.filter((c) => c.status === '?' && paths.includes(c.path)).map((c) => c.path);
    const tracked = paths.filter((p) => !untracked.includes(p));
    if (!(await this.confirm(`Discard the changes of ${paths.length === 1 ? paths[0] : `${paths.length} files`}? ${untracked.length ? 'New files are deleted. ' : ''}This cannot be undone.`, 'Discard'))) return false;
    if (tracked.length) await this.git(['restore', '--worktree', '--', ...tracked], 'discard');
    if (untracked.length) await this.git(['clean', '-f', '-q', '--', ...untracked], 'discard');
    await this.refresh();
    return true;
  }

  /** Commits what is staged with the message (and pushes when asked); false when git refuses. */
  async commit(message: string, push = false): Promise<boolean> {
    if (!this.repo || !message.trim()) return false;
    if (!this.current.changes.some((c) => c.staged)) {
      void vscode.window.showInformationMessage('Refyntra: nothing is staged. Stage files first (+).');
      return false;
    }
    const ok = (await this.git(['commit', '-F', '-'], 'commit', message)).ok;
    await this.refresh();
    if (ok && push) return this.push();
    return ok;
  }

  // ---- branches and remotes

  /**
   * Switches branch the way GitHub Desktop does: with uncommitted changes the caller chooses — leave them on the
   * current branch (a stash Refyntra offers back when the branch is checked out again) or bring them along (git refuses
   * when they collide). 'needsChoice' when changes exist and no mode was given.
   */
  async switchBranch(branch: string, mode?: 'stash' | 'bring'): Promise<'ok' | 'needsChoice' | 'failed'> {
    if (!this.repo || !safeRef(branch)) return 'failed';
    if (this.current.changes.length > 0 && !mode) return 'needsChoice';
    const from = this.current.head ?? '';
    if (mode === 'stash' && this.current.changes.length > 0) {
      const s = await this.git(['stash', 'push', '--include-untracked', '-m', `${STASH_PREFIX}${from}`], 'stash the changes');
      if (!s.ok) return 'failed';
    }
    const ok = await this.checkout(branch);
    if (!ok && mode === 'stash') {
      // Switching failed: the changes come back where they were.
      await this.git(['stash', 'pop'], 'restore the changes');
      await this.refresh();
    }
    return ok ? 'ok' : 'failed';
  }

  /** Brings back the changes left on this branch (git stash pop). */
  async restoreStash(): Promise<boolean> {
    const st = this.current.stash;
    if (!st) return false;
    const ok = (await this.git(['stash', 'pop', st.ref], 'restore the stashed changes')).ok;
    await this.refresh();
    return ok;
  }

  async dropStash(): Promise<boolean> {
    const st = this.current.stash;
    if (!st || !(await this.confirm(`Discard the changes stashed on ${st.branch}? This cannot be undone.`, 'Discard'))) return false;
    const ok = (await this.git(['stash', 'drop', st.ref], 'discard the stash')).ok;
    await this.refresh();
    return ok;
  }

  /** What merging a branch into the current one would do: commits it brings, files that would conflict. */
  async mergePreview(branch: string): Promise<{ commits: number; conflicts: string[]; upToDate: boolean } | undefined> {
    if (!this.repo || !safeRef(branch)) return undefined;
    const count = await runGit(['rev-list', '--count', `HEAD..${branch}`], this.repo);
    const commits = Number(count.stdout.trim()) || 0;
    if (commits === 0) return { commits: 0, conflicts: [], upToDate: true };
    const t = await runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch], this.repo);
    const conflicts = t.code === 1 ? t.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
    return { commits, conflicts: [...new Set(conflicts)], upToDate: false };
  }

  async checkout(branch: string): Promise<boolean> {
    if (!safeRef(branch)) return false;
    // A remote branch (origin/x) without a local one: a local tracking branch named x.
    const local = this.current.branches.some((b) => b.name === branch);
    const remote = !local && this.current.remoteBranches.includes(branch);
    const args = remote ? ['switch', '--track', branch] : ['switch', branch];
    const ok = (await this.git(args, `checkout ${branch}`)).ok;
    await this.refresh();
    return ok;
  }

  async createBranch(name?: string, from?: string, checkout = true): Promise<boolean> {
    const n = name ?? (await this.input({ title: 'Refyntra: New Branch', prompt: `Name of the new branch${from ? ` (from ${from})` : ' (from the current commit)'}`, validateInput: (v) => (v && safeRef(v) ? undefined : 'Not a valid branch name') }));
    if (!n || !safeRef(n) || (from && !safeRef(from))) return false;
    const args = checkout ? ['switch', '-c', n, ...(from ? [from] : [])] : ['branch', n, ...(from ? [from] : [])];
    const ok = (await this.git(args, `create ${n}`)).ok;
    await this.refresh();
    return ok;
  }

  async deleteBranch(name: string): Promise<boolean> {
    if (!safeRef(name)) return false;
    if (!(await this.confirm(`Delete the local branch ${name}?`, 'Delete'))) return false;
    let r = await runGit(['branch', '-d', name], this.repo!);
    if (r.code !== 0 && /not fully merged/.test(r.stderr)) {
      if (!(await this.confirm(`${name} is not fully merged: its commits are lost when it is deleted. Delete anyway?`, 'Delete Anyway'))) return false;
      r = await runGit(['branch', '-D', name], this.repo!);
    }
    if (r.code !== 0) void vscode.window.showErrorMessage(`Refyntra: delete ${name} failed: ${r.stderr.trim()}`);
    await this.refresh();
    return r.code === 0;
  }

  /** Merges a branch into the current one (a merge commit when it does not fast-forward). */
  async mergeBranch(name: string, confirmed = false): Promise<boolean> {
    if (!safeRef(name)) return false;
    if (!confirmed && !(await this.confirm(`Merge ${name} into ${this.current.head}?`, 'Merge'))) return false;
    const ok = (await this.git(['merge', '--no-edit', name], `merge ${name}`)).ok;
    await this.refresh();
    return ok;
  }

  /** Applies one commit onto the current branch (git cherry-pick); a conflict is left for the user to resolve. */
  async cherryPick(sha: string, confirmed = false): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    if (!confirmed && !(await this.confirm(`Cherry-pick ${sha.slice(0, 8)} onto ${this.current.head}?`, 'Cherry-pick'))) return false;
    const ok = (await this.git(['cherry-pick', sha], `cherry-pick ${sha.slice(0, 8)}`)).ok;
    await this.refresh();
    return ok;
  }

  fetch(): Promise<boolean> {
    return this.network('Fetch', ['fetch', '--all', '--prune']);
  }

  async pull(): Promise<boolean> {
    return this.network('Pull', await pullArgs(this.repo!));
  }

  /** Pushes the current branch; a branch without an upstream is published to origin. */
  async push(branch?: string): Promise<boolean> {
    const name = branch ?? this.current.head;
    if (!name || name === 'HEAD' || !safeRef(name)) return false;
    const b = this.current.branches.find((x) => x.name === name);
    const args = b?.upstream ? ['push', 'origin', name] : ['push', '-u', 'origin', name];
    return this.network(b?.upstream ? 'Push' : `Publish ${name}`, args);
  }

  /** Fetch or pull in every repository of the workspace, one after another; a summary per repository. */
  async allRepos(op: 'fetch' | 'pull', quiet = false): Promise<{ repo: string; ok: boolean; message: string }[]> {
    const repos = this.current.repos.length ? this.current.repos : (await this.refresh()).repos;
    const results: { repo: string; ok: boolean; message: string }[] = [];
    this.busy = `${op === 'pull' ? 'Pull' : 'Fetch'} all (${repos.length})`;
    this.post();
    try {
      for (const repo of repos) {
        const state = this.current.states?.find((x) => x.path === repo);
        if (op === 'pull' && state && !state.upstream) {
          results.push({ repo, ok: true, message: 'no upstream (skipped)' });
          continue;
        }
        const r = await runGit(op === 'pull' ? await pullArgs(repo) : ['fetch', '--all', '--prune'], repo);
        void state;
        const text = (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n').filter(Boolean);
        results.push({ repo, ok: r.code === 0, message: r.code === 0 ? (text.find((l) => /Already up to date|Fast-forward|files? changed|Merge made/.test(l)) ?? (op === 'fetch' ? 'fetched' : 'done')) : text.slice(-2).join(' ') });
      }
    } finally {
      this.busy = undefined;
      await this.refresh();
      await this.refreshStates();
    }
    if (!quiet) {
      this.log.appendLine(`${new Date().toLocaleTimeString()} ${op} all:`);
      for (const r of results) this.log.appendLine(`  ${r.ok ? 'ok    ' : 'FAILED'} ${repoName(r.repo)}: ${r.message}`);
      const failed = results.filter((r) => !r.ok);
      const msg = `Refyntra: ${op === 'pull' ? 'pulled' : 'fetched'} ${results.length - failed.length} of ${results.length} repositories${failed.length ? `; failed: ${failed.map((r) => repoName(r.repo)).join(', ')}` : ''}.`;
      void (failed.length ? vscode.window.showWarningMessage(msg, 'Show Details') : vscode.window.showInformationMessage(msg, 'Show Details')).then((a) => {
        if (a) this.log.show(true);
      });
    }
    return results;
  }

  readonly log = vscode.window.createOutputChannel('Refyntra Git');

  private autoTimer: NodeJS.Timeout | undefined;

  /** Fetches every repository in the background every refyntra.git.autoFetch minutes (0: off); never pulls by itself. */
  startAutoFetch(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    const minutes = vscode.workspace.getConfiguration('refyntra').get<number>('git.autoFetch', 5);
    if (!minutes || minutes <= 0) return;
    this.autoTimer = setInterval(() => {
      if (!this.isTrusted() || this.busy || !vscode.window.state.focused) return;
      void this.allRepos('fetch', true);
    }, minutes * 60_000);
  }

  dispose(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.log.dispose();
  }

  // ---- search

  async runSearch(text: string, mode: SearchMode, branch?: string): Promise<GraphRow[]> {
    if (!this.repo || !text.trim() || (branch && !safeRef(branch))) {
      this.search = undefined;
      await this.refresh();
      return [];
    }
    const r = await runGit([...searchArgs(text, mode, branch), `--format=${GRAPH_FORMAT}`], this.repo);
    // Lanes are not meaningful for a filtered list: every hit in lane 0.
    const rows: GraphRow[] = parseGraphLog(r.stdout).map((c: GraphCommit) => ({ commit: c, lane: 0, pass: [], into: [], out: [], width: 1 }));
    this.search = { text, mode, ...(branch ? { branch } : {}), rows };
    await this.refresh();
    return rows;
  }

  async clearSearch(): Promise<void> {
    this.search = undefined;
    await this.refresh();
  }

  // ---- commit details

  async commitDetails(sha: string): Promise<{ sha: string; parent: string; author: string; email: string; time: number; message: string; parents: string[]; refs: string[]; files: FileStat[] } | undefined> {
    if (!this.repo || !/^[0-9a-f]{7,40}$/.test(sha)) return undefined;
    const h = await runGit(['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%B', sha], this.repo);
    if (h.code !== 0) return undefined;
    const [full, author, email, time, parents, refs, ...msg] = h.stdout.split('\x1f');
    const parentList = (parents ?? '').split(' ').filter(Boolean);
    const parent = parentList[0] ?? EMPTY_TREE;
    const n = await runGit(['diff', '--numstat', '-z', '-M', parent, full!], this.repo);
    return {
      sha: full!,
      parent,
      author: author ?? '',
      email: email ?? '',
      time: Number(time),
      message: msg.join('\x1f').trim(),
      parents: parentList,
      refs: (refs ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      files: parseNumstat(n.stdout),
    };
  }

  /** The diff of a changed file: staged (index vs HEAD), unstaged (working tree vs index) or a new file. */
  async workingPatch(file: string, staged: boolean): Promise<ReturnType<typeof parsePatch>> {
    if (!this.repo) return [];
    const c = this.current.changes.find((x) => x.path === file && x.staged === staged) ?? this.current.changes.find((x) => x.path === file);
    if (c?.status === '?') {
      // Untracked: the whole file as added (git diff --no-index exits 1 when the files differ).
      const r = await runGit(['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file], this.repo);
      return parsePatch(r.stdout);
    }
    const r = await runGit(['diff', '--no-color', '-M', ...(staged ? ['--cached'] : []), '--', file], this.repo);
    return parsePatch(r.stdout);
  }

  async filePatch(parent: string, sha: string, file: string, from?: string): Promise<ReturnType<typeof parsePatch>> {
    if (!this.repo) return [];
    const r = await runGit(['diff', '-M', '--no-color', '-U3', parent, sha, '--', ...(from ? [from] : []), file], this.repo);
    return parsePatch(r.stdout);
  }

  // ---- GitHub pull requests

  private async client(): Promise<GitHubClient | undefined> {
    const gh = this.current.github;
    if (!gh) {
      void vscode.window.showInformationMessage("Refyntra: the repository's origin is not on GitHub.");
      return undefined;
    }
    if (this.hooks.github) return this.hooks.github(gh.owner, gh.repo);
    // Tests: a fake GitHub (its fetch) without signing in.
    if (this.hooks.fetch) return new GitHubClient(gh.owner, gh.repo, 'test-token', this.hooks.fetch);
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    const f: FetchLike = this.hooks.fetch ?? ((url, init) => fetch(url, init));
    return new GitHubClient(gh.owner, gh.repo, session.accessToken, f);
  }

  async loadPulls(): Promise<PullRequest[]> {
    try {
      const c = await this.client();
      if (!c) return [];
      this.pulls = { list: await c.openPulls() };
    } catch (e) {
      this.pulls = { error: e instanceof Error ? e.message : String(e) };
    }
    await this.refresh();
    return this.pulls.list ?? [];
  }

  /** A pull request from the current branch (pushed first when it has no upstream). */
  async createPull(): Promise<PullRequest | undefined> {
    const head = this.current.head;
    if (!head || head === 'HEAD') return undefined;
    const c = await this.client();
    if (!c) return undefined;
    const b = this.current.branches.find((x) => x.name === head);
    if (!b?.upstream || b.ahead > 0) {
      if (!(await this.push(head))) return undefined;
    }
    let base: string;
    try {
      base = await c.defaultBranch();
    } catch {
      base = 'main';
    }
    const baseAnswer = await this.input({ title: 'Refyntra: Create Pull Request', prompt: `Merge ${head} into`, value: base });
    if (!baseAnswer) return undefined;
    const lastSubject = this.current.rows.find((r) => r.commit.refs.some((x) => x.includes(head)))?.commit.subject ?? head;
    const title = await this.input({ title: 'Refyntra: Create Pull Request', prompt: 'Title', value: lastSubject });
    if (!title) return undefined;
    const body = (await this.input({ title: 'Refyntra: Create Pull Request', prompt: 'Description (optional)', value: '' })) ?? '';
    try {
      const pr = await c.createPull(head, baseAnswer, title, body);
      void vscode.window.showInformationMessage(`Refyntra: pull request #${pr.number} created.`, 'Open').then((a) => {
        if (a) void vscode.env.openExternal(vscode.Uri.parse(pr.url));
      });
      await this.loadPulls();
      return pr;
    } catch (e) {
      void vscode.window.showErrorMessage(`Refyntra: the pull request was not created: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  async mergePull(number: number, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<boolean> {
    const pr = this.pulls.list?.find((p) => p.number === number);
    if (!(await this.confirm(`Merge pull request #${number}${pr ? ` "${pr.title}" (${pr.head} → ${pr.base})` : ''} on GitHub (${method})?`, 'Merge'))) return false;
    const c = await this.client();
    if (!c) return false;
    try {
      await c.mergePull(number, method);
      void vscode.window.showInformationMessage(`Refyntra: pull request #${number} merged.`);
      await this.loadPulls();
      await this.fetch();
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`Refyntra: #${number} was not merged: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Checks out a pull request's branch (fetched from origin as pr/<number>). */
  async checkoutPull(number: number): Promise<boolean> {
    if (!Number.isInteger(number) || number <= 0) return false;
    if (!(await this.network(`Fetch #${number}`, ['fetch', 'origin', `pull/${number}/head:pr/${number}`]))) return false;
    return this.checkout(`pr/${number}`);
  }

  // ---- messages of the page

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : undefined);
    const paths = Array.isArray(m.paths) ? (m.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.refresh();
        break;
      case 'repo':
        if (str('repo') && this.current.repos.includes(str('repo')!)) await this.selectRepo(str('repo')!);
        break;
      case 'stage':
        await this.stage(paths);
        break;
      case 'unstage':
        await this.unstage(paths);
        break;
      case 'discard':
        await this.discard(paths);
        break;
      case 'commit':
        if (str('message') !== undefined && (await this.commit(str('message')!, m.push === true))) this.broadcast({ type: 'committed' });
        break;
      case 'open': {
        const p = str('path');
        if (this.repo && p) {
          const abs = path.join(this.repo, p);
          if (m.staged === true) await vscode.commands.executeCommand('vscode.diff', gitUri(abs, 'HEAD', p), gitUri(abs, ':0', p), `${p} (staged)`, { preview: true });
          else if (m.status === '?' || m.status === 'A') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
          else await vscode.commands.executeCommand('vscode.diff', gitUri(abs, 'HEAD', p), vscode.Uri.file(abs), `${p} (working tree)`, { preview: true });
        }
        break;
      }
      case 'checkout':
      case 'switch': {
        const b = str('branch');
        if (!b) break;
        const mode = str('mode') === 'stash' || str('mode') === 'bring' ? (str('mode') as 'stash' | 'bring') : undefined;
        const r = await this.switchBranch(b, mode);
        if (r === 'needsChoice') this.broadcast({ type: 'switchChoice', branch: b, from: this.current.head, changes: new Set(this.current.changes.map((c) => c.path)).size });
        break;
      }
      case 'workDiff': {
        const p = str('path');
        if (p && this.current.changes.some((c) => c.path === p)) this.broadcast({ type: 'workDiff', path: p, lines: await this.workingPatch(p, m.staged === true) });
        break;
      }
      case 'restoreStash':
        await this.restoreStash();
        break;
      case 'dropStash':
        await this.dropStash();
        break;
      case 'states':
        await this.refreshStates();
        break;
      case 'mergePreview': {
        const b = str('branch');
        if (b) this.broadcast({ type: 'mergePreview', branch: b, into: this.current.head, preview: await this.mergePreview(b) });
        break;
      }
      case 'merge':
        if (str('branch')) await this.mergeBranch(str('branch')!, true);
        break;
      case 'createBranch':
        if (str('name')) await this.createBranch(str('name'), str('from') || undefined);
        break;
      case 'switchBranch': {
        const items = [
          { label: '$(add) Create new branch…', key: '+' },
          ...this.current.branches.map((b) => ({ label: `${b.current ? '$(check)' : '$(git-branch)'} ${b.name}`, description: b.upstream ?? 'local', key: b.name })),
          ...this.current.remoteBranches.filter((r) => !this.current.branches.some((b) => r.endsWith('/' + b.name))).map((r) => ({ label: `$(cloud) ${r}`, description: 'remote', key: r })),
        ];
        const pick = await vscode.window.showQuickPick(items, { title: 'Refyntra: Checkout' });
        if (pick?.key === '+') await this.createBranch();
        else if (pick) await this.checkout(pick.key);
        break;
      }
      case 'newBranch':
        await this.createBranch(undefined, str('from'));
        break;
      case 'deleteBranch':
        if (str('branch')) await this.deleteBranch(str('branch')!);
        break;
      case 'mergeBranch':
        if (str('branch')) await this.mergeBranch(str('branch')!);
        break;
      case 'pushBranch':
        await this.push(str('branch'));
        break;
      case 'fetch':
        await this.fetch();
        break;
      case 'fetchAll':
        await this.allRepos('fetch');
        break;
      case 'pullAll':
        await this.allRepos('pull');
        break;
      case 'openEditor':
        this.openInEditor();
        break;
      case 'pull':
        await this.pull();
        break;
      case 'push':
        await this.push();
        break;
      case 'search':
        await this.runSearch(str('text') ?? '', (str('mode') as SearchMode) ?? 'message', str('branch') || undefined);
        break;
      case 'clearSearch':
        await this.clearSearch();
        break;
      case 'copySha':
        if (str('sha')) {
          await vscode.env.clipboard.writeText(str('sha')!);
          void vscode.window.setStatusBarMessage(`Copied ${str('sha')!.slice(0, 8)}`, 3000);
        }
        break;
      case 'cherryPick':
        if (str('sha')) await this.cherryPick(str('sha')!);
        break;
      case 'commitDetails':
        if (str('sha')) await this.commits.show(str('sha')!);
        break;
      case 'loadPulls':
        await this.loadPulls();
        break;
      case 'createPull':
        await this.createPull();
        break;
      case 'mergePull':
        if (typeof m.number === 'number') await this.mergePull(m.number, (str('method') as 'merge' | 'squash' | 'rebase') ?? 'merge');
        break;
      case 'checkoutPull':
        if (typeof m.number === 'number') await this.checkoutPull(m.number);
        break;
      case 'openUrl':
        if (str('url')?.startsWith('https://github.com/')) await vscode.env.openExternal(vscode.Uri.parse(str('url')!));
        break;
    }
  }
}

/** Commit panes in the editor area: header, files with +/− bars, a coloured diff per file. */
export class CommitPanels {
  private readonly open = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly provider: GitViewProvider) {}

  async show(sha: string): Promise<vscode.WebviewPanel | undefined> {
    const d = await this.provider.commitDetails(sha);
    if (!d) return undefined;
    const existing = this.open.get(d.sha);
    if (existing) {
      existing.reveal();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel('refyntra.gitCommit', `Commit ${d.sha.slice(0, 8)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.open.set(d.sha, panel);
    panel.onDidDispose(() => this.open.delete(d.sha));
    panel.webview.html = commitHtml(panel.webview);
    const watch = watchWebview(panel.webview, 'commit');
    panel.onDidDispose(() => watch.dispose());
    panel.webview.onDidReceiveMessage(async (m: { type: string; path?: string; from?: string }) => {
      if (m.type === 'ready') void panel.webview.postMessage({ type: 'details', details: d });
      if (m.type === 'patch' && typeof m.path === 'string' && d.files.some((f) => f.path === m.path)) {
        const lines = await this.provider.filePatch(d.parent, d.sha, m.path, typeof m.from === 'string' ? m.from : undefined);
        void panel.webview.postMessage({ type: 'patch', path: m.path, lines });
      }
      if (m.type === 'diffEditor' && typeof m.path === 'string' && this.provider.repoPath()) {
        const abs = path.join(this.provider.repoPath()!, m.path);
        await vscode.commands.executeCommand('vscode.diff', gitUri(abs, d.parent, typeof m.from === 'string' ? m.from : m.path), gitUri(abs, d.sha, m.path), `${m.path} (${d.sha.slice(0, 8)})`);
      }
    });
    return panel;
  }
}

/** What the page draws: plain data, the repository names relative to the workspace. */
function toWire(m: GitViewModel) {
  const row = (r: GraphRow) => ({ sha: r.commit.sha, author: r.commit.author, time: r.commit.time, subject: r.commit.subject, refs: r.commit.refs, parents: r.commit.parents.length, lane: r.lane, pass: r.pass, into: r.into, out: r.out, width: r.width });
  return {
    repos: m.repos.map((r) => ({ path: r, name: repoName(r) })),
    hasRemote: m.hasRemote,
    stash: m.stash,
    states: m.states,
    repo: m.repo,
    head: m.head,
    changes: m.changes,
    branches: m.branches,
    remoteBranches: m.remoteBranches,
    error: m.error,
    busy: m.busy,
    github: m.github,
    pulls: m.pulls,
    pullsError: m.pullsError,
    search: m.search ? { text: m.search.text, mode: m.search.mode, branch: m.search.branch, rows: m.search.rows.map(row) } : undefined,
    rows: m.rows.map(row),
  };
}

/** A repository's name: its path inside the workspace, or the folder name for a workspace folder itself. */
function repoName(repo: string): string {
  const rel = vscode.workspace.asRelativePath(repo, false);
  return !rel || path.isAbsolute(rel) || rel === repo ? path.basename(repo) : rel;
}

function nonce(): string {
  return Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
}

const BASE_CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 8px 16px;}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:3px 10px;cursor:pointer;border-radius:2px;font:inherit}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0 4px}
button:disabled{opacity:.5;cursor:default}
select,textarea,input{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font:inherit;padding:2px 4px}
.muted{opacity:.7}.err{color:var(--vscode-errorForeground)}
.ref{display:inline-block;border-radius:3px;padding:0 4px;margin-right:4px;font-size:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.ref.head{background:var(--vscode-gitDecoration-addedResourceForeground);color:var(--vscode-editor-background)}
.ref.tag{background:transparent;border:1px solid var(--vscode-badge-background);color:var(--vscode-foreground)}
`;

function sidebarHtml(webview: vscode.Webview, wide = false): string {
  const n = nonce();
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>${BASE_CSS}
body{padding:0;margin:0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
.top{display:flex;gap:1px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));flex:none}
.tb{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;padding:6px 10px;background:none;color:var(--vscode-foreground);border-radius:0;text-align:left}
.tb:hover{background:var(--vscode-list-hoverBackground)}
.tb .k{font-size:10px;opacity:.65;text-transform:uppercase;letter-spacing:.04em}
.tb .v{font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb .v .badge{font-weight:600;margin-left:6px;color:var(--vscode-charts-blue,var(--vscode-textLink-foreground))}
body:not(.wide) .top{flex-wrap:wrap}body:not(.wide) .tb{flex:1 1 45%}
.tabs{display:flex;gap:0;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));flex:none}
.tab{background:none;color:var(--vscode-foreground);opacity:.7;border-radius:0;padding:6px 12px;border-bottom:2px solid transparent}
.tab.on{opacity:1;border-bottom-color:var(--vscode-focusBorder)}
.main{flex:1;min-height:0;display:flex}
.pane{flex:1;min-width:0;overflow:auto;padding:6px 10px}
.banner{margin:6px 10px;padding:6px 8px;border-radius:3px;background:var(--vscode-editorInfo-background,rgba(55,148,255,.12));display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.banner .grow{flex:1}
.err{margin:6px 10px}
.busy{margin:2px 10px;color:var(--vscode-descriptionForeground);font-style:italic;font-size:12px}
.row{display:flex;align-items:center;gap:6px;padding:2px 4px;cursor:pointer;white-space:nowrap;overflow:hidden;border-radius:3px}
.row:hover{background:var(--vscode-list-hoverBackground)}
.row.sel{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.st{width:14px;text-align:center;font-weight:600;flex:none}
.st.M{color:var(--vscode-gitDecoration-modifiedResourceForeground)}.st.A,.st.U{color:var(--vscode-gitDecoration-untrackedResourceForeground)}
.st.D{color:var(--vscode-gitDecoration-deletedResourceForeground)}.st.C{color:var(--vscode-gitDecoration-conflictingResourceForeground)}
.path{overflow:hidden;text-overflow:ellipsis;flex:1}.dir{opacity:.6}
.act{visibility:hidden;flex:none}.row:hover .act{visibility:visible}
input[type=checkbox]{margin:0;flex:none}
.commitBox{border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));padding:8px 10px;flex:none}
.commitBox input,.commitBox textarea{width:100%;margin-bottom:6px}.commitBox textarea{min-height:44px;resize:vertical}
.commitBox button{width:100%;padding:5px}
.changes{display:flex;flex-direction:column;height:100%}
.changes .list{flex:1;overflow:auto;padding:6px 10px}
.g{display:flex;align-items:center;height:22px;cursor:pointer}.g:hover{background:var(--vscode-list-hoverBackground)}
.g svg{flex:none}.g .msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.g .sha{flex:none;font-family:var(--vscode-editor-font-family);opacity:.7;margin:0 4px}.g .act{flex:none;visibility:hidden}.g:hover .act{visibility:visible}
.bar{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin:4px 0}.bar input{flex:1;min-width:80px}
.in{color:var(--vscode-charts-blue,var(--vscode-textLink-foreground));font-weight:600}
.pop{position:fixed;z-index:10;background:var(--vscode-quickInput-background,var(--vscode-editorWidget-background));color:var(--vscode-quickInput-foreground,var(--vscode-foreground));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.4));box-shadow:0 4px 16px rgba(0,0,0,.35);border-radius:4px;padding:6px;max-height:70vh;overflow:auto;width:min(420px,calc(100vw - 16px))}
.pop input{width:100%;margin-bottom:6px}
.pop .sec{font-size:10px;text-transform:uppercase;opacity:.65;margin:8px 4px 2px}
.pop .foot{display:flex;gap:6px;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.3));margin-top:6px;padding-top:6px;flex-wrap:wrap}
.modalBack{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:20;display:flex;align-items:flex-start;justify-content:center;padding-top:10vh}
.modal{background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border,rgba(128,128,128,.4));border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,.4);width:min(520px,calc(100vw - 24px));padding:14px 16px}
.modal h2{font-size:1.1em;margin:0 0 10px}
.modal .choice{display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--vscode-widget-border,rgba(128,128,128,.3));border-radius:4px;margin:6px 0;cursor:pointer}
.modal .choice:hover{background:var(--vscode-list-hoverBackground)}
.modal .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.modal input,.modal select{width:100%;margin:4px 0}
.warn{color:var(--vscode-editorWarning-foreground)}.ok{color:var(--vscode-gitDecoration-addedResourceForeground)}
.empty{opacity:.7;padding:20px 10px;text-align:center}
#tab-changes{display:flex}#tab-changes[hidden]{display:none}
body.wide .changes{width:360px;flex:none;border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
body:not(.wide) .changes{flex:1}
.diff{flex:1;min-width:0;overflow:auto}
.diff .fh{padding:6px 10px;font-family:var(--vscode-editor-font-family);border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));position:sticky;top:0;background:var(--vscode-editor-background)}
.diff table{border-collapse:collapse;width:100%;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
.diff td{padding:0 6px;white-space:pre;vertical-align:top}.diff td.n{width:1%;text-align:right;opacity:.55;user-select:none}.diff td.s{width:1%;user-select:none}
.diff tr.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(155,185,85,.2))}.diff tr.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,.2))}
.diff tr.hunk td{color:var(--vscode-descriptionForeground);background:rgba(128,128,128,.08);padding:3px 6px}
</style></head><body class="${wide ? 'wide' : ''}">
<div class="top">
  <button class="tb" id="repoBtn" title="Current repository"><span class="k">Current repository</span><span class="v" id="repoV"></span></button>
  <button class="tb" id="branchBtn" title="Current branch: switch, create, merge"><span class="k">Current branch</span><span class="v" id="branchV"></span></button>
  <button class="tb" id="syncBtn" title="Fetch, pull or push"><span class="k" id="syncK">Fetch origin</span><span class="v" id="syncV"></span></button>
</div>
<div id="busy" class="busy"></div>
<div id="err" class="err"></div>
<div id="banners"></div>
<div class="tabs"><button class="tab on" data-tab="changes">Changes <span id="nChanges"></span></button><button class="tab" data-tab="history">History</button><button class="tab" data-tab="pulls">Pull requests</button>${wide ? '' : '<span style="flex:1"></span><button class="link" id="openEditor" title="Open in an editor tab (full width)">⤢</button>'}</div>
<div class="main">
  <div class="pane" id="tab-changes" style="padding:0"><div class="changes"><div class="list" id="changeList"></div>
    <div class="commitBox"><input id="summary" placeholder="Summary (required)"><textarea id="desc" placeholder="Description"></textarea><button id="commitBtn" disabled>Commit</button></div></div>
    ${wide ? '<div class="diff" id="workDiff"><div class="empty">Select a file to see its changes</div></div>' : ''}</div>
  <div class="pane" id="tab-history" hidden>
    <div class="bar"><input id="sText" placeholder="Search commits (Enter)"><select id="sMode" title="Search in"><option value="message">message</option><option value="code">code</option><option value="author">author</option></select></div>
    <div class="bar"><select id="sBranch" title="Branch"></select><button class="link" id="clearSearch" style="display:none">✕ clear</button></div>
    <div id="graphTitle" class="muted"></div><div id="graph"></div>
  </div>
  <div class="pane" id="tab-pulls" hidden><div class="bar"><button id="createPull">New pull request</button><button class="secondary" id="loadPulls">Refresh</button></div><div id="pulls"></div></div>
</div>
<div id="layer"></div>
<script nonce="${n}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const send = (m) => vs.postMessage(m);
const COLORS = ['var(--vscode-charts-blue)','var(--vscode-charts-orange)','var(--vscode-charts-green)','var(--vscode-charts-purple)','var(--vscode-charts-red)','var(--vscode-charts-yellow)'];
let model = null, tab = (vs.getState() || {}).tab || 'changes', selected = null;
function renderDiff(path, lines) {
  const pane = $('workDiff'); if (!pane) return; pane.textContent = '';
  const h = el('div', 'fh'); h.append(document.createTextNode(path + '  '));
  const add = lines.filter(l => l.kind === 'add').length, del = lines.filter(l => l.kind === 'del').length;
  h.append(el('span', 'ok', '+' + add), document.createTextNode(' '), el('span', 'warn', '−' + del));
  const open = el('button', 'link', 'open in diff editor'); open.onclick = () => { const c = model.changes.find(x => x.path === path); send({ type: 'open', path, staged: !!(c && c.staged), status: c ? c.status : 'M' }); }; h.append(open);
  pane.append(h);
  if (!lines.length) { pane.append(el('div', 'empty', 'No text changes (binary, or only the file mode changed).')); return; }
  const t = el('table');
  for (const l of lines) { const tr = el('tr', l.kind);
    if (l.kind === 'hunk') { const td = el('td', '', l.text); td.colSpan = 4; tr.append(td); }
    else tr.append(el('td', 'n', l.old === undefined ? '' : String(l.old)), el('td', 'n', l.new === undefined ? '' : String(l.new)), el('td', 's', l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '), el('td', '', l.text));
    t.append(tr); }
  pane.append(t);
}
const layer = $('layer');
const closeLayer = () => { layer.textContent = ''; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLayer(); });
function setTab(t) { tab = t; vs.setState({ tab }); for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === t); for (const id of ['changes','history','pulls']) $('tab-' + id).hidden = id !== t; if (t === 'pulls' && model && model.github && !model.pulls && !model.pullsError) send({ type: 'loadPulls' }); }
for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);
setTab(tab);
if ($('openEditor')) $('openEditor').onclick = () => send({ type: 'openEditor' });

// ---- popovers and dialogs
function popover(anchor, build) {
  closeLayer();
  const back = el('div'); back.style.cssText = 'position:fixed;inset:0;z-index:9'; back.onclick = closeLayer;
  const p = el('div', 'pop'); const r = anchor.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - Math.min(420, window.innerWidth - 16) - 8)) + 'px'; p.style.top = (r.bottom + 2) + 'px';
  build(p); layer.append(back, p);
  const f = p.querySelector('input'); if (f) f.focus();
}
function modal(title, build) {
  closeLayer();
  const back = el('div', 'modalBack'); back.onclick = (e) => { if (e.target === back) closeLayer(); };
  const m = el('div', 'modal'); m.append(el('h2', '', title)); build(m); back.append(m); layer.append(back);
  const f = m.querySelector('input,button.primary'); if (f) f.focus();
}
function btns(m, list) { const b = el('div', 'btns'); for (const [label, cls, fn] of list) { const x = el('button', cls, label); x.onclick = fn; b.append(x); } m.append(b); }

// ---- repository picker
$('repoBtn').onclick = () => {
  send({ type: 'states' });
  popover($('repoBtn'), (p) => {
    const f = el('input'); f.placeholder = 'Filter repositories'; p.append(f);
    const list = el('div'); p.append(list);
    const draw = () => { list.textContent = ''; const q = f.value.toLowerCase();
      for (const s of (model.states || []).filter(s => repoName(s.path).toLowerCase().includes(q))) {
        const r = el('div', 'row' + (s.path === model.repo ? ' sel' : ''));
        r.append(el('span', 'path', repoName(s.path)), el('span', 'muted', s.branch || ''));
        if (s.behind) r.append(el('span', 'in', '↓' + s.behind)); if (s.ahead) r.append(el('span', 'muted', '↑' + s.ahead)); if (s.changes) r.append(el('span', 'muted', '✎' + s.changes));
        r.onclick = () => { closeLayer(); if (s.path !== model.repo) { $('repoV').textContent = repoName(s.path) + ' …'; send({ type: 'repo', repo: s.path }); } };
        list.append(r);
      } };
    f.oninput = draw; draw(); popover.redraw = draw;
    const foot = el('div', 'foot'); const fa = el('button', 'secondary', '⟳ Fetch all'); fa.onclick = () => { closeLayer(); send({ type: 'fetchAll' }); };
    const pa = el('button', 'secondary', '↓ Pull all'); pa.onclick = () => { closeLayer(); send({ type: 'pullAll' }); }; foot.append(fa, pa); p.append(foot);
  });
};
function repoName(p) { const r = (model.repos || []).find(x => x.path === p); return r ? r.name : p; }

// ---- branch picker
$('branchBtn').onclick = () => popover($('branchBtn'), (p) => {
  const f = el('input'); f.placeholder = 'Filter branches'; p.append(f);
  const list = el('div'); p.append(list);
  const draw = () => {
    list.textContent = ''; const q = f.value.toLowerCase();
    const local = model.branches.filter(b => b.name.toLowerCase().includes(q));
    const remote = model.remoteBranches.filter(r => r.toLowerCase().includes(q) && !model.branches.some(b => r.endsWith('/' + b.name)));
    if (local.length) list.append(el('div', 'sec', 'Branches'));
    for (const b of local) {
      const r = el('div', 'row' + (b.current ? ' sel' : ''));
      r.append(el('span', 'path', (b.current ? '✓ ' : '') + b.name));
      r.append(el('span', 'muted', b.gone ? 'gone' : b.upstream ? (b.ahead || b.behind ? '↑' + b.ahead + ' ↓' + b.behind : '') : 'local'));
      if (!b.current) {
        const mg = el('button', 'link act', 'merge'); mg.title = 'Merge ' + b.name + ' into ' + model.head; mg.onclick = (e) => { e.stopPropagation(); mergeDialog(b.name); };
        const del = el('button', 'link act', '✕'); del.title = 'Delete ' + b.name; del.onclick = (e) => { e.stopPropagation(); closeLayer(); send({ type: 'deleteBranch', branch: b.name }); };
        r.append(mg, del);
        r.onclick = () => { closeLayer(); send({ type: 'switch', branch: b.name }); };
      }
      list.append(r);
    }
    if (remote.length) list.append(el('div', 'sec', 'Remote only'));
    for (const rb of remote) { const r = el('div', 'row'); r.append(el('span', 'path', rb)); r.title = 'Check out ' + rb + ' as a local branch'; r.onclick = () => { closeLayer(); send({ type: 'switch', branch: rb }); }; list.append(r); }
    if (!local.length && !remote.length) list.append(el('div', 'muted', 'No branch matches.'));
  };
  f.oninput = draw; draw();
  const foot = el('div', 'foot');
  const nb = el('button', '', '+ New branch'); nb.onclick = () => newBranchDialog(f.value);
  const mb = el('button', 'secondary', 'Merge into ' + model.head + '…'); mb.onclick = () => mergeDialog();
  foot.append(nb, mb); p.append(foot);
});
function newBranchDialog(name) {
  modal('Create a branch', (m) => {
    const i = el('input'); i.placeholder = 'Name'; i.value = name || ''; m.append(i);
    m.append(el('div', 'muted', 'From'));
    const s = el('select'); for (const b of model.branches) { const o = el('option', '', b.name); o.value = b.name; o.selected = b.current; s.append(o); } m.append(s);
    const go = () => { if (i.value.trim()) { closeLayer(); send({ type: 'createBranch', name: i.value.trim(), from: s.value }); } };
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    btns(m, [['Cancel', 'secondary', closeLayer], ['Create branch', 'primary', go]]);
  });
}
function mergeDialog(branch) {
  modal('Merge into ' + model.head, (m) => {
    const s = el('select'); for (const b of model.branches.filter(b => !b.current)) { const o = el('option', '', b.name); o.value = b.name; o.selected = b.name === branch; s.append(o); }
    for (const r of model.remoteBranches) { const o = el('option', '', r); o.value = r; o.selected = r === branch; s.append(o); }
    m.append(el('div', 'muted', 'Choose a branch to merge into ' + model.head), s);
    const info = el('div', 'muted', 'Checking…'); info.id = 'mergeInfo'; info.style.margin = '8px 0'; m.append(info);
    const ask = () => { info.className = 'muted'; info.textContent = 'Checking…'; send({ type: 'mergePreview', branch: s.value }); };
    s.onchange = ask;
    btns(m, [['Cancel', 'secondary', closeLayer], ['Merge', 'primary', () => { closeLayer(); send({ type: 'merge', branch: s.value }); }]]);
    if (s.value) ask(); else info.textContent = 'No other branch.';
  });
}
function switchChoice(d) {
  modal('Switch to ' + d.branch, (m) => {
    m.append(el('div', '', 'You have ' + d.changes + ' changed file(s) on ' + d.from + '.'));
    const c1 = el('div', 'choice'); c1.append(el('div', '', '')); const t1 = el('div'); t1.append(el('b', '', 'Leave my changes on ' + d.from), el('div', 'muted', 'They are stashed; Refyntra offers them back when you switch to ' + d.from + ' again.')); c1.append(t1);
    c1.onclick = () => { closeLayer(); send({ type: 'switch', branch: d.branch, mode: 'stash' }); };
    const c2 = el('div', 'choice'); const t2 = el('div'); t2.append(el('b', '', 'Bring my changes to ' + d.branch), el('div', 'muted', 'Git refuses when they collide with ' + d.branch + '.')); c2.append(t2);
    c2.onclick = () => { closeLayer(); send({ type: 'switch', branch: d.branch, mode: 'bring' }); };
    m.append(c1, c2); btns(m, [['Cancel', 'secondary', closeLayer]]);
  });
}

// ---- sync button: Publish / Push / Pull / Fetch
$('syncBtn').onclick = () => { const a = $('syncBtn').dataset.action; if (a) send({ type: a }); };
// ---- changes
$('commitBtn').onclick = () => { const msg = $('summary').value.trim() + ($('desc').value.trim() ? '\\n\\n' + $('desc').value.trim() : ''); if ($('summary').value.trim()) send({ type: 'commit', message: msg }); };
$('summary').addEventListener('input', () => renderCommitBtn());
function renderCommitBtn() {
  const staged = model ? model.changes.filter(c => c.staged).length : 0;
  const b = $('commitBtn'); b.textContent = staged ? 'Commit ' + staged + ' file(s) to ' + model.head : 'Commit to ' + (model ? model.head : '');
  b.disabled = !staged || !$('summary').value.trim();
}
function fileRows() {
  const byPath = new Map();
  for (const c of model.changes) { const e = byPath.get(c.path) || { path: c.path, staged: false, unstaged: false, status: c.status }; if (c.staged) e.staged = true; else { e.unstaged = true; e.status = c.status; } byPath.set(c.path, e); }
  return [...byPath.values()];
}
function renderChanges() {
  const list = $('changeList'); list.textContent = '';
  const rows = fileRows();
  $('nChanges').textContent = rows.length ? '(' + rows.length + ')' : '';
  if (!rows.length) { list.append(el('div', 'empty', 'No local changes')); return; }
  const head = el('div', 'row'); const all = el('input'); all.type = 'checkbox';
  const nStaged = rows.filter(r => r.staged && !r.unstaged).length; all.checked = nStaged === rows.length; all.indeterminate = nStaged > 0 && nStaged < rows.length;
  all.onclick = (e) => { e.stopPropagation(); send(all.checked ? { type: 'stage', paths: rows.map(r => r.path) } : { type: 'unstage', paths: rows.filter(r => r.staged).map(r => r.path) }); };
  head.append(all, el('span', 'path muted', rows.length + ' changed file(s)'));
  const da = el('button', 'link act', 'discard all'); da.onclick = (e) => { e.stopPropagation(); send({ type: 'discard', paths: rows.filter(r => r.unstaged).map(r => r.path) }); }; head.append(da);
  list.append(head);
  for (const f of rows) {
    const r = el('div', 'row'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = f.staged && !f.unstaged; cb.indeterminate = f.staged && f.unstaged;
    cb.title = 'Include in the commit (stage)';
    cb.onclick = (e) => { e.stopPropagation(); send({ type: cb.checked ? 'stage' : 'unstage', paths: [f.path] }); };
    const slash = f.path.lastIndexOf('/');
    const p = el('span', 'path'); if (slash > 0) p.append(el('span', 'dir', f.path.slice(0, slash + 1))); p.append(document.createTextNode(f.path.slice(slash + 1)));
    const st = f.status === '?' ? 'A' : f.status === 'U' ? 'C' : f.status;
    r.append(cb, p, el('span', 'st ' + st, st));
    if (f.unstaged) { const d = el('button', 'link act', '↺'); d.title = 'Discard changes'; d.onclick = (e) => { e.stopPropagation(); send({ type: 'discard', paths: [f.path] }); }; r.insertBefore(d, r.lastChild); }
    r.title = f.path;
    if (f.path === selected) r.classList.add('sel');
    // Wide: the diff next to the list; narrow: VS Code's diff editor.
    r.onclick = () => { if (document.body.classList.contains('wide')) { selected = f.path; renderChanges(); send({ type: 'workDiff', path: f.path, staged: f.staged && !f.unstaged }); } else send({ type: 'open', path: f.path, staged: f.staged && !f.unstaged, status: f.status }); };
    r.ondblclick = () => send({ type: 'open', path: f.path, staged: f.staged && !f.unstaged, status: f.status });
    list.append(r);
  }
}
// ---- history
$('sText').addEventListener('keydown', (e) => { if (e.key === 'Enter') send({ type: 'search', text: $('sText').value, mode: $('sMode').value, branch: $('sBranch').value }); });
$('clearSearch').onclick = () => { $('sText').value = ''; send({ type: 'clearSearch' }); };
function graphRow(row, width) {
  const W = 14, H = 22, x = (l) => l * W + 8, cy = H / 2, ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', String(width * W + 8)); svg.setAttribute('height', String(H));
  const line = (x1, y1, x2, y2, lane) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + y2) / 2 + ', ' + x2 + ' ' + (y1 + y2) / 2 + ', ' + x2 + ' ' + y2); p.setAttribute('stroke', COLORS[lane % COLORS.length]); p.setAttribute('stroke-width', '1.6'); p.setAttribute('fill', 'none'); svg.append(p); };
  for (const l of row.pass) line(x(l), 0, x(l), H, l); for (const l of row.into) line(x(l), 0, x(row.lane), cy, l); for (const l of row.out) line(x(row.lane), cy, x(l), H, l);
  const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', String(x(row.lane))); dot.setAttribute('cy', String(cy)); dot.setAttribute('r', row.parents > 1 ? '3' : '4');
  dot.setAttribute('fill', row.parents > 1 ? 'var(--vscode-editor-background)' : COLORS[row.lane % COLORS.length]); dot.setAttribute('stroke', COLORS[row.lane % COLORS.length]); dot.setAttribute('stroke-width', '2'); svg.append(dot);
  const g = el('div', 'g'); g.title = row.sha.slice(0, 8) + ' · ' + row.author + ' · ' + new Date(row.time * 1000).toLocaleString() + (row.parents > 1 ? ' · merge' : '');
  const msg = el('span', 'msg');
  for (const r of row.refs) msg.append(el('span', 'ref' + (r.startsWith('HEAD') ? ' head' : r.startsWith('tag:') ? ' tag' : ''), r.replace('HEAD -> ', '● ').replace('tag: ', '')));
  msg.append(document.createTextNode(row.subject + ' '), el('span', 'muted', row.author));
  const sha = el('span', 'sha', row.sha.slice(0, 8)); sha.title = row.sha;
  const cp = el('button', 'link act', 'copy'); cp.title = 'Copy the full hash'; cp.onclick = (e) => { e.stopPropagation(); send({ type: 'copySha', sha: row.sha }); };
  const pick = el('button', 'link act', 'cherry-pick'); pick.title = 'Apply this commit onto the current branch'; pick.onclick = (e) => { e.stopPropagation(); send({ type: 'cherryPick', sha: row.sha }); };
  g.append(svg, msg, sha, cp, pick); g.onclick = () => send({ type: 'commitDetails', sha: row.sha }); return g;
}
function renderHistory() {
  const sb = $('sBranch'); const keep = sb.value; sb.textContent = '';
  const all = el('option', '', 'all branches'); all.value = ''; sb.append(all);
  for (const b of model.branches) { const o = el('option', '', b.name); o.value = b.name; sb.append(o); }
  for (const r of model.remoteBranches) { const o = el('option', '', r); o.value = r; sb.append(o); }
  sb.value = model.search ? (model.search.branch || '') : keep;
  const rows = model.search ? model.search.rows : model.rows;
  $('graphTitle').textContent = model.search ? 'Found ' + rows.length + ' commit(s): "' + model.search.text + '" in ' + model.search.mode + (model.search.branch ? ' on ' + model.search.branch : '') : '';
  $('clearSearch').style.display = model.search ? '' : 'none';
  const gr = $('graph'); gr.textContent = ''; const width = Math.max(1, ...rows.map(r => r.width));
  for (const row of rows) gr.append(graphRow(row, width));
}
function renderPulls() {
  const pl = $('pulls'); pl.textContent = '';
  $('createPull').disabled = !model.github; $('loadPulls').disabled = !model.github;
  if (!model.github) { pl.append(el('div', 'empty', "This repository's origin is not on GitHub.")); return; }
  if (model.pullsError) { pl.append(el('div', 'err', model.pullsError)); return; }
  if (!model.pulls) { pl.append(el('div', 'empty', 'Loading (signs in to GitHub)…')); return; }
  if (!model.pulls.length) { pl.append(el('div', 'empty', 'No open pull requests')); return; }
  for (const p of model.pulls) {
    const r = el('div', 'row'); r.append(el('span', 'path', '#' + p.number + ' ' + p.title + (p.draft ? ' (draft)' : '')), el('span', 'muted', p.head + ' → ' + p.base));
    r.title = p.author + ' · open on GitHub';
    const co = el('button', 'link act', 'checkout'); co.onclick = (e) => { e.stopPropagation(); send({ type: 'checkoutPull', number: p.number }); };
    const mg = el('button', 'link act', 'merge'); mg.onclick = (e) => { e.stopPropagation(); send({ type: 'mergePull', number: p.number, method: 'merge' }); };
    r.append(co, mg); r.onclick = () => send({ type: 'openUrl', url: p.url }); pl.append(r);
  }
}
$('createPull').onclick = () => send({ type: 'createPull' });
$('loadPulls').onclick = () => send({ type: 'loadPulls' });
function render() {
  $('err').textContent = model.error || '';
  $('busy').textContent = model.busy ? model.busy + '…' : '';
  const cur = model.branches.find(b => b.current);
  $('repoV').textContent = model.repo ? repoName(model.repo) : '—';
  const bv = $('branchV'); bv.textContent = model.head || '—';
  // The sync button: what the branch needs now.
  let k = 'Fetch origin', v = '', a = 'fetch';
  if (!model.hasRemote) { k = 'No remote'; v = ''; a = ''; }
  else if (cur && !cur.upstream) { k = 'Publish branch'; v = 'to origin'; a = 'push'; }
  else if (cur && cur.behind) { k = 'Pull origin'; v = '↓ ' + cur.behind + (cur.ahead ? '  ↑ ' + cur.ahead : ''); a = 'pull'; }
  else if (cur && cur.ahead) { k = 'Push origin'; v = '↑ ' + cur.ahead; a = 'push'; }
  else { v = 'up to date'; }
  $('syncK').textContent = k; $('syncV').textContent = v; $('syncBtn').dataset.action = a; $('syncBtn').disabled = !a;
  const ban = $('banners'); ban.textContent = '';
  if (model.stash) {
    const b = el('div', 'banner'); b.append(el('span', 'grow', 'You have changes stashed on ' + model.stash.branch + '.'));
    const r = el('button', '', 'Restore'); r.onclick = () => send({ type: 'restoreStash' });
    const d = el('button', 'secondary', 'Discard'); d.onclick = () => send({ type: 'dropStash' }); b.append(r, d); ban.append(b);
  }
  if (selected && !model.changes.some(c => c.path === selected)) { selected = null; const pane = $('workDiff'); if (pane) { pane.textContent = ''; pane.append(el('div', 'empty', 'Select a file to see its changes')); } }
  else if (selected) { const c = model.changes.find(x => x.path === selected); send({ type: 'workDiff', path: selected, staged: !!(c && c.staged && !model.changes.some(x => x.path === selected && !x.staged)) }); }
  renderChanges(); renderCommitBtn(); renderHistory(); renderPulls();
}
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d.type === 'model') { model = d.model; render(); if (popover.redraw && layer.childElementCount) popover.redraw(); }
  if (d.type === 'committed') { $('summary').value = ''; $('desc').value = ''; renderCommitBtn(); }
  if (d.type === 'switchChoice') switchChoice(d);
  if (d.type === 'workDiff' && d.path === selected) { try { renderDiff(d.path, d.lines || []); } catch (err) { const pane = $('workDiff'); if (pane) { pane.textContent = ''; pane.append(el('div', 'err', 'Cannot show the diff: ' + err)); } } }
  if (d.type === 'selectFile' && model && document.body.classList.contains('wide')) { selected = d.path; renderChanges(); const c = model.changes.find(x => x.path === d.path); send({ type: 'workDiff', path: d.path, staged: !!(c && c.staged) }); }
  if (d.type === 'mergePreview') { const info = document.getElementById('mergeInfo'); if (!info) return; const p = d.preview;
    if (!p) { info.textContent = 'Cannot compare.'; return; }
    if (p.upToDate) { info.className = 'ok'; info.textContent = 'This branch is up to date with ' + d.branch + ': nothing to merge.'; return; }
    info.className = p.conflicts.length ? 'warn' : 'ok';
    info.textContent = 'This will merge ' + p.commits + ' commit(s) from ' + d.branch + ' into ' + d.into + '. ' + (p.conflicts.length ? 'Conflicts in ' + p.conflicts.length + ' file(s): ' + p.conflicts.slice(0, 6).join(', ') + (p.conflicts.length > 6 ? '…' : '') : 'No conflicts.'); }
});
send({ type: 'ready' });
</script></body></html>`;
}

function commitHtml(webview: vscode.Webview): string {
  const n = nonce();
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>${BASE_CSS}
body{padding:12px 20px 40px;max-width:1400px}
h1{font-size:1.3em;margin:4px 0 2px;font-weight:600;white-space:pre-wrap}
.meta{margin:4px 0 14px}.meta span{margin-right:14px}
pre.body{white-space:pre-wrap;font-family:var(--vscode-editor-font-family);margin:0 0 14px;opacity:.9}
.sum{margin:6px 0 10px}
.file{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:4px;margin:8px 0;overflow:hidden}
.fh{display:flex;align-items:center;gap:10px;padding:5px 8px;background:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.12));cursor:pointer}
.fh .name{flex:1;font-family:var(--vscode-editor-font-family)}
.plus{color:var(--vscode-gitDecoration-addedResourceForeground)}.minus{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.bars{display:inline-flex;gap:1px}.bars i{display:inline-block;width:7px;height:7px;border-radius:1px;background:var(--vscode-disabledForeground,rgba(128,128,128,.4))}
.bars i.a{background:var(--vscode-gitDecoration-addedResourceForeground)}.bars i.d{background:var(--vscode-gitDecoration-deletedResourceForeground)}
table{border-collapse:collapse;width:100%;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
td{padding:0 6px;white-space:pre;vertical-align:top}
td.n{width:1%;text-align:right;opacity:.55;user-select:none}
td.s{width:1%;user-select:none}
tr.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(155,185,85,.2))}
tr.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,.2))}
tr.hunk td{color:var(--vscode-descriptionForeground);background:rgba(128,128,128,.08);padding:3px 6px}
.code{overflow-x:auto}
</style></head><body><div id="root" class="muted">Loading…</div>
<script nonce="${n}">
const vs = acquireVsCodeApi();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const bodies = new Map();
function bars(f) {
  const total = f.added + f.deleted, w = el('span', 'bars');
  const a = total ? Math.round(5 * f.added / total) : 0, d = total ? Math.min(5 - a, Math.round(5 * f.deleted / total)) : 0;
  for (let i = 0; i < 5; i++) w.append(el('i', i < a ? 'a' : i < a + d ? 'd' : ''));
  return w;
}
function render(d) {
  const root = document.getElementById('root'); root.className = ''; root.textContent = '';
  const [subject, ...rest] = d.message.split('\\n');
  root.append(el('h1', '', subject));
  const meta = el('div', 'meta muted');
  for (const r of d.refs) meta.append(el('span', 'ref' + (r.startsWith('HEAD') ? ' head' : ''), r.replace('HEAD -> ', '● ')));
  meta.append(el('span', '', d.author + ' <' + d.email + '>'), el('span', '', new Date(d.time * 1000).toLocaleString()), el('span', '', d.sha.slice(0, 12)));
  if (d.parents.length > 1) meta.append(el('span', '', 'merge of ' + d.parents.map(p => p.slice(0, 8)).join(' + ') + ' (changes against the first parent)'));
  root.append(meta);
  const body = rest.join('\\n').trim(); if (body) root.append(el('pre', 'body', body));
  const add = d.files.reduce((s, f) => s + f.added, 0), del = d.files.reduce((s, f) => s + f.deleted, 0);
  const sum = el('div', 'sum'); sum.append(document.createTextNode(d.files.length + ' file(s) changed, '), el('span', 'plus', '+' + add), document.createTextNode(' '), el('span', 'minus', '−' + del)); root.append(sum);
  for (const f of d.files) {
    const box = el('div', 'file'), head = el('div', 'fh');
    head.append(el('span', 'name', (f.from ? f.from + ' → ' : '') + f.path));
    if (f.binary) head.append(el('span', 'muted', 'binary'));
    else head.append(el('span', 'plus', '+' + f.added), el('span', 'minus', '−' + f.deleted), bars(f));
    const ed = el('button', 'link', 'open in diff editor'); ed.onclick = (e) => { e.stopPropagation(); vs.postMessage({ type: 'diffEditor', path: f.path, from: f.from }); }; head.append(ed);
    const code = el('div', 'code'); code.style.display = 'none';
    head.onclick = () => { const open = code.style.display === 'none'; code.style.display = open ? '' : 'none'; if (open && !code.childElementCount) { code.append(el('div', 'muted', ' Loading…')); vs.postMessage({ type: 'patch', path: f.path, from: f.from }); } };
    bodies.set(f.path, code);
    box.append(head, code); root.append(box);
  }
  // The first few files open at once.
  [...document.querySelectorAll('.fh')].slice(0, 5).forEach(h => h.click());
}
function renderPatch(p, lines) {
  const code = bodies.get(p); if (!code) return; code.textContent = '';
  if (!lines.length) { code.append(el('div', 'muted', ' No text changes.')); return; }
  const t = el('table');
  for (const l of lines) {
    const tr = el('tr', l.kind);
    if (l.kind === 'hunk') { const td = el('td', '', l.text); td.colSpan = 4; tr.append(td); }
    else tr.append(el('td', 'n', l.old === undefined ? '' : String(l.old)), el('td', 'n', l.new === undefined ? '' : String(l.new)), el('td', 's ' + (l.kind === 'add' ? 'plus' : l.kind === 'del' ? 'minus' : ''), l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '), el('td', '', l.text));
    t.append(tr);
  }
  code.append(t);
}
window.addEventListener('message', (e) => {
  if (e.data.type === 'details') render(e.data.details);
  if (e.data.type === 'patch') renderPatch(e.data.path, e.data.lines);
});
vs.postMessage({ type: 'ready' });
</script></body></html>`;
}

export function registerGitView(context: vscode.ExtensionContext, isTrusted: () => boolean): GitViewProvider {
  const provider = new GitViewProvider(isTrusted, context.workspaceState);
  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void provider.refresh(), 400);
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GIT_VIEW, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidSaveTextDocument(later),
    vscode.workspace.onDidCreateFiles(later),
    vscode.workspace.onDidDeleteFiles(later),
    vscode.workspace.onDidRenameFiles(later),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) later();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(later),
    vscode.commands.registerCommand('refyntra.git.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.refyntraGit');
      await vscode.commands.executeCommand(`${GIT_VIEW}.focus`);
    }),
    vscode.commands.registerCommand('refyntra.git.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('refyntra.git.openInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('refyntra.git.fetchAll', () => provider.allRepos('fetch')),
    vscode.commands.registerCommand('refyntra.git.pullAll', () => provider.allRepos('pull')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refyntra.git.autoFetch')) provider.startAutoFetch();
    }),
    provider,
    vscode.commands.registerCommand('refyntra.git.fetch', () => provider.fetch()),
    vscode.commands.registerCommand('refyntra.git.pull', () => provider.pull()),
    vscode.commands.registerCommand('refyntra.git.push', () => provider.push()),
    vscode.commands.registerCommand('refyntra.git.checkout', async () => {
      await provider.refresh();
      const m = provider.model();
      const pick = await vscode.window.showQuickPick([...m.branches.map((b) => b.name), ...m.remoteBranches], { title: 'Refyntra: Checkout' });
      if (pick) await provider.checkout(pick);
    }),
    vscode.commands.registerCommand('refyntra.git.newBranch', async () => {
      await provider.refresh();
      await provider.createBranch();
    }),
    vscode.commands.registerCommand('refyntra.git.createPullRequest', async () => {
      await provider.refresh();
      await provider.createPull();
    }),
  );
  provider.startAutoFetch();
  return provider;
}
