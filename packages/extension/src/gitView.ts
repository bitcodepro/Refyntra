import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitUri, runGit } from './git';
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
    view.onDidDispose(() => {
      this.webviews.delete(view.webview);
      this.sideView = undefined;
    });
    this.updateBadge();
  }

  private attach(webview: vscode.Webview, wide: boolean): void {
    webview.options = { enableScripts: true };
    webview.html = sidebarHtml(webview, wide);
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
    this.attach(panel.webview, true);
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      this.editorPanel = undefined;
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
    for (const w of this.webviews) void w.postMessage({ type: 'model', model });
    this.updateBadge();
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
    const states = await Promise.all(repos.map(async (r) => parseRepoState(r, (await runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], r)).stdout)));
    return {
      states,
      hasRemote,
      repos,
      repo,
      head: head.stdout.trim(),
      changes: parseStatus(status.stdout),
      branches: parseBranches(branches.stdout),
      remoteBranches: remotes.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD')),
      rows: log.code === 0 ? layoutGraph(parseGraphLog(log.stdout)) : [],
      ...(this.search ? { search: this.search } : {}),
      ...(github ? { github } : {}),
      ...(this.pulls.list ? { pulls: this.pulls.list } : {}),
      ...(this.pulls.error ? { pullsError: this.pulls.error } : {}),
    };
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
  async mergeBranch(name: string): Promise<boolean> {
    if (!safeRef(name)) return false;
    if (!(await this.confirm(`Merge ${name} into ${this.current.head}?`, 'Merge'))) return false;
    const ok = (await this.git(['merge', '--no-edit', name], `merge ${name}`)).ok;
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
        const text = (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n').filter(Boolean);
        results.push({ repo, ok: r.code === 0, message: r.code === 0 ? (text.find((l) => /Already up to date|Fast-forward|files? changed|Merge made/.test(l)) ?? (op === 'fetch' ? 'fetched' : 'done')) : text.slice(-2).join(' ') });
      }
    } finally {
      this.busy = undefined;
      await this.refresh();
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
        if (str('message') !== undefined && (await this.commit(str('message')!, m.push === true))) for (const w of this.webviews) void w.postMessage({ type: 'committed' });
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
        if (str('branch')) await this.checkout(str('branch')!);
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
h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none}
h3 .tools{text-transform:none;letter-spacing:0;font-weight:400}
.bar{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin:6px 0}
.bar .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
select.full,textarea,input.full{width:100%}
textarea{min-height:44px;resize:vertical;margin:4px 0}
.row{display:flex;align-items:center;gap:6px;padding:1px 0;cursor:pointer;white-space:nowrap;overflow:hidden}
.row:hover{background:var(--vscode-list-hoverBackground)}
.st{width:14px;text-align:center;font-weight:600;flex:none}
.st.M{color:var(--vscode-gitDecoration-modifiedResourceForeground)}.st.A,.st.\\?{color:var(--vscode-gitDecoration-untrackedResourceForeground)}
.st.D{color:var(--vscode-gitDecoration-deletedResourceForeground)}.st.U{color:var(--vscode-gitDecoration-conflictingResourceForeground)}
.path{overflow:hidden;text-overflow:ellipsis;flex:1}
.act{visibility:hidden;flex:none}.row:hover .act{visibility:visible}
.cur{font-weight:600}
.g{display:flex;align-items:center;height:22px;cursor:pointer}.g:hover{background:var(--vscode-list-hoverBackground)}
.g svg{flex:none}.g .msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.collapsed>.body{display:none}
.busy{color:var(--vscode-descriptionForeground);font-style:italic}
.in{color:var(--vscode-charts-blue,var(--vscode-textLink-foreground));font-weight:600}
body.wide{padding:12px 20px}
body.wide #cols{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:28px;align-items:start}
body.wide .g{height:24px}
</style></head><body class="${wide ? 'wide' : ''}">
<div class="bar"><span class="grow muted" id="title"></span>${wide ? '' : '<button class="link" id="openEditor" title="Open the Git client in an editor tab (full width)">⤢ open in editor</button>'}</div>
<section id="sRepos" style="display:none"><h3><span>Repositories</span><span class="tools"><button class="link" id="fetchAll" title="Fetch every repository">⟳ fetch all</button><button class="link" id="pullAll" title="Pull every repository">↓ pull all</button></span></h3><div class="body"><div id="repos"></div></div></section>
<div class="bar"><button class="secondary grow" id="branchBtn" title="Checkout another branch or create one"></button></div>
<div class="bar"><button class="secondary" id="fetch" title="Fetch (all remotes, prune)">⟳ Fetch</button><button class="secondary" id="pull" title="Pull">↓ Pull</button><button class="secondary" id="push" title="Push">↑ Push</button></div>
<div id="busy" class="busy"></div><div id="err" class="err"></div>
<div id="cols"><div>
<section id="sChanges"><h3><span>Changes</span><span class="tools"><button class="link" id="unstageAll" title="Unstage all">− unstage all</button><button class="link" id="discardAll" title="Discard all changes">↺ discard all</button></span></h3><div class="body">
<textarea id="msg" placeholder="Commit message"></textarea>
<div class="bar"><button class="secondary" id="stageAll" title="Stage every change">+ Stage all</button><button id="commit">Commit</button><button class="secondary" id="commitPush">Commit &amp; Push</button></div>
<div id="staged"></div><div id="unstaged"></div></div></section>
<section id="sBranches"><h3><span>Branches</span><span class="tools"><button class="link" id="newBranch" title="New branch from the current commit">+ new</button></span></h3><div class="body"><div id="branches"></div><div id="remotes"></div></div></section>
<section id="sPulls"><h3><span>Pull requests</span><span class="tools"><button class="link" id="createPull" title="Create a pull request from the current branch">+ new</button><button class="link" id="loadPulls" title="Load from GitHub">load</button></span></h3><div class="body"><div id="pulls"></div></div></section>
</div><div>
<section id="sSearch"><h3><span>Search commits</span></h3><div class="body">
<div class="bar"><select id="sBranch" title="Branch"></select><select id="sMode" title="Search in"><option value="message">message</option><option value="code">code change</option><option value="author">author</option></select></div>
<div class="bar"><input class="full" id="sText" placeholder="Word to find (Enter)"></div></div></section>
<section id="sGraph"><h3><span id="graphTitle">Graph</span><span class="tools"><button class="link" id="clearSearch" title="Back to the graph" style="display:none">✕ clear search</button></span></h3><div class="body"><div id="graph"></div></div></section>
</div></div>
<script nonce="${n}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const send = (m) => vs.postMessage(m);
const COLORS = ['var(--vscode-charts-blue)','var(--vscode-charts-orange)','var(--vscode-charts-green)','var(--vscode-charts-purple)','var(--vscode-charts-red)','var(--vscode-charts-yellow)'];
let model = null;
for (const s of document.querySelectorAll('section')) s.querySelector('h3').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') s.classList.toggle('collapsed'); });
$('branchBtn').onclick = () => send({ type: 'switchBranch' });
$('fetch').onclick = () => send({ type: 'fetch' });
$('pull').onclick = () => send({ type: 'pull' });
$('push').onclick = () => send({ type: 'push' });
$('stageAll').onclick = () => send({ type: 'stage', paths: model.changes.filter(c => !c.staged).map(c => c.path) });
$('unstageAll').onclick = () => send({ type: 'unstage', paths: model.changes.filter(c => c.staged).map(c => c.path) });
$('discardAll').onclick = () => send({ type: 'discard', paths: [...new Set(model.changes.filter(c => !c.staged).map(c => c.path))] });
// The main button: Commit while something is staged, Push once the commits wait to be pushed.
$('commit').onclick = () => { if ($('commit').dataset.mode === 'push') send({ type: 'push' }); else send({ type: 'commit', message: $('msg').value }); };
$('fetchAll').onclick = () => send({ type: 'fetchAll' });
$('pullAll').onclick = () => send({ type: 'pullAll' });
if ($('openEditor')) $('openEditor').onclick = () => send({ type: 'openEditor' });
$('commitPush').onclick = () => send({ type: 'commit', message: $('msg').value, push: true });
$('newBranch').onclick = () => send({ type: 'newBranch' });
$('createPull').onclick = () => send({ type: 'createPull' });
$('loadPulls').onclick = () => send({ type: 'loadPulls' });
$('clearSearch').onclick = () => { $('sText').value = ''; send({ type: 'clearSearch' }); };
$('sText').addEventListener('keydown', (e) => { if (e.key === 'Enter') send({ type: 'search', text: $('sText').value, mode: $('sMode').value, branch: $('sBranch').value }); });
function act(label, title, fn) { const b = el('button', 'link act', label); b.title = title; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; }
function fileRow(c) {
  const r = el('div', 'row');
  r.append(el('span', 'st ' + c.status, c.status === '?' ? 'U' : c.status), el('span', 'path', c.path));
  r.title = c.path;
  if (!c.staged) r.append(act('↺', 'Discard changes', () => send({ type: 'discard', paths: [c.path] })));
  r.append(act(c.staged ? '−' : '+', c.staged ? 'Unstage' : 'Stage', () => send({ type: c.staged ? 'unstage' : 'stage', paths: [c.path] })));
  r.onclick = () => send({ type: 'open', path: c.path, staged: c.staged, status: c.status });
  return r;
}
function graphRow(row, width) {
  const W = 14, H = 22, x = (l) => l * W + 8, cy = H / 2;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(width * W + 8)); svg.setAttribute('height', String(H));
  const line = (x1, y1, x2, y2, lane) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + y2) / 2 + ', ' + x2 + ' ' + (y1 + y2) / 2 + ', ' + x2 + ' ' + y2); p.setAttribute('stroke', COLORS[lane % COLORS.length]); p.setAttribute('stroke-width', '1.6'); p.setAttribute('fill', 'none'); svg.append(p); };
  for (const l of row.pass) line(x(l), 0, x(l), H, l);
  for (const l of row.into) line(x(l), 0, x(row.lane), cy, l);
  for (const l of row.out) line(x(row.lane), cy, x(l), H, l);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', String(x(row.lane))); dot.setAttribute('cy', String(cy)); dot.setAttribute('r', row.parents > 1 ? '3' : '4');
  dot.setAttribute('fill', row.parents > 1 ? 'var(--vscode-editor-background)' : COLORS[row.lane % COLORS.length]);
  dot.setAttribute('stroke', COLORS[row.lane % COLORS.length]); dot.setAttribute('stroke-width', '2');
  svg.append(dot);
  const g = el('div', 'g');
  g.title = row.sha.slice(0, 8) + ' · ' + row.author + ' · ' + new Date(row.time * 1000).toLocaleString() + (row.parents > 1 ? ' · merge' : '');
  const msg = el('span', 'msg');
  for (const r of row.refs) msg.append(el('span', 'ref' + (r.startsWith('HEAD') ? ' head' : r.startsWith('tag:') ? ' tag' : ''), r.replace('HEAD -> ', '● ').replace('tag: ', '')));
  msg.append(document.createTextNode(row.subject + ' '), el('span', 'muted', row.author));
  g.append(svg, msg);
  g.onclick = () => send({ type: 'commitDetails', sha: row.sha });
  return g;
}
function render() {
  $('err').textContent = model.error || '';
  $('busy').textContent = model.busy ? model.busy + '…' : '';
  const curRepo = model.repos.find(r => r.path === model.repo);
  $('title').textContent = curRepo ? curRepo.name : '';
  $('sRepos').style.display = model.states && model.states.length > 1 ? '' : 'none';
  const rl = $('repos'); rl.textContent = '';
  for (const s of model.states || []) {
    const r = el('div', 'row' + (s.path === model.repo ? ' cur' : ''));
    const name = (model.repos.find(x => x.path === s.path) || { name: s.path }).name;
    r.append(el('span', 'path', (s.path === model.repo ? '● ' : '') + name), el('span', 'muted', s.branch));
    if (s.behind) r.append(el('span', 'in', '↓' + s.behind));
    if (s.ahead) r.append(el('span', 'muted', '↑' + s.ahead));
    if (s.changes) r.append(el('span', 'muted', '✎' + s.changes));
    r.title = name + ' · ' + s.branch + (s.upstream ? ' → ' + s.upstream : ' (no upstream)');
    r.onclick = () => send({ type: 'repo', repo: s.path });
    rl.append(r);
  }
  const cur = model.branches.find(b => b.current);
  $('branchBtn').textContent = '⎇ ' + (model.head || '—') + (cur && cur.upstream ? '  ↑' + cur.ahead + ' ↓' + cur.behind : cur ? '  (not published)' : '');
  $('push').textContent = '↑ Push' + (cur && cur.ahead ? ' ' + cur.ahead : '');
  $('pull').textContent = '↓ Pull' + (cur && cur.behind ? ' ' + cur.behind : '');
  $('pull').className = cur && cur.behind ? '' : 'secondary';
  const st = $('staged'), un = $('unstaged'); st.textContent = ''; un.textContent = '';
  const staged = model.changes.filter(c => c.staged), work = model.changes.filter(c => !c.staged);
  if (staged.length) { st.append(el('div', 'muted', 'Staged (' + staged.length + ')')); staged.forEach(c => st.append(fileRow(c))); }
  un.append(el('div', 'muted', work.length ? 'Changes (' + work.length + ')' : (staged.length ? '' : 'No changes')));
  work.forEach(c => un.append(fileRow(c)));
  const ahead = cur ? cur.ahead : 0, unpublished = cur && !cur.upstream;
  const c = $('commit');
  if (staged.length) { c.dataset.mode = 'commit'; c.textContent = 'Commit (' + staged.length + ')'; c.disabled = false; }
  else if (model.hasRemote && (ahead || (unpublished && model.rows.length))) { c.dataset.mode = 'push'; c.textContent = unpublished ? '↑ Publish branch' : '↑ Push ' + ahead; c.disabled = false; }
  else { c.dataset.mode = 'commit'; c.textContent = 'Commit'; c.disabled = true; }
  $('commitPush').style.display = staged.length ? '' : 'none';
  $('stageAll').style.display = work.length ? '' : 'none';
  const br = $('branches'); br.textContent = '';
  for (const b of model.branches) {
    const r = el('div', 'row' + (b.current ? ' cur' : ''));
    r.append(el('span', 'path', (b.current ? '● ' : '') + b.name));
    const state = b.gone ? 'upstream gone' : b.upstream ? (b.ahead || b.behind ? '↑' + b.ahead + ' ↓' + b.behind : 'up to date') : 'local only';
    r.append(el('span', 'muted', state));
    r.title = b.name + (b.upstream ? ' → ' + b.upstream : '');
    if (!b.current) {
      r.append(act('merge', 'Merge ' + b.name + ' into ' + model.head, () => send({ type: 'mergeBranch', branch: b.name })));
      r.append(act('✕', 'Delete ' + b.name, () => send({ type: 'deleteBranch', branch: b.name })));
      r.onclick = () => send({ type: 'checkout', branch: b.name });
    } else {
      r.append(act('↑', b.upstream ? 'Push' : 'Publish to origin', () => send({ type: 'pushBranch', branch: b.name })));
    }
    br.append(r);
  }
  const rem = $('remotes'); rem.textContent = '';
  const onlyRemote = model.remoteBranches.filter(r => !model.branches.some(b => r.endsWith('/' + b.name)));
  if (onlyRemote.length) {
    rem.append(el('div', 'muted', 'Remote only (' + onlyRemote.length + ')'));
    for (const r of onlyRemote) { const row = el('div', 'row'); row.append(el('span', 'path muted', r)); row.title = 'Checkout ' + r; row.onclick = () => send({ type: 'checkout', branch: r }); rem.append(row); }
  }
  const pl = $('pulls'); pl.textContent = '';
  if (!model.github) pl.append(el('div', 'muted', 'origin is not on GitHub'));
  else if (model.pullsError) pl.append(el('div', 'err', model.pullsError));
  else if (!model.pulls) pl.append(el('div', 'muted', model.github.owner + '/' + model.github.repo + ' — click "load" (signs in to GitHub)'));
  else if (!model.pulls.length) pl.append(el('div', 'muted', 'No open pull requests'));
  else for (const p of model.pulls) {
    const r = el('div', 'row');
    r.append(el('span', 'path', '#' + p.number + ' ' + p.title + (p.draft ? ' (draft)' : '')), el('span', 'muted', p.head + ' → ' + p.base));
    r.title = p.author + ' · ' + p.head + ' → ' + p.base;
    r.append(act('checkout', 'Check out the branch of #' + p.number, () => send({ type: 'checkoutPull', number: p.number })));
    r.append(act('merge', 'Merge #' + p.number + ' on GitHub', () => send({ type: 'mergePull', number: p.number, method: 'merge' })));
    r.onclick = () => send({ type: 'openUrl', url: p.url });
    pl.append(r);
  }
  const sb = $('sBranch'); const keep = sb.value; sb.textContent = '';
  const all = el('option', '', 'all branches'); all.value = ''; sb.append(all);
  for (const b of model.branches) { const o = el('option', '', b.name); o.value = b.name; sb.append(o); }
  for (const r of model.remoteBranches) { const o = el('option', '', r); o.value = r; sb.append(o); }
  sb.value = model.search ? (model.search.branch || '') : keep;
  const gr = $('graph'); gr.textContent = '';
  const rows = model.search ? model.search.rows : model.rows;
  $('graphTitle').textContent = model.search ? 'Found ' + rows.length + ' commit(s): "' + model.search.text + '" in ' + model.search.mode + (model.search.branch ? ' on ' + model.search.branch : '') : 'Graph';
  $('clearSearch').style.display = model.search ? '' : 'none';
  const width = Math.max(1, ...rows.map(r => r.width));
  for (const row of rows) gr.append(graphRow(row, width));
}
window.addEventListener('message', (e) => {
  if (e.data.type === 'model') { model = e.data.model; render(); }
  if (e.data.type === 'committed') $('msg').value = '';
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
