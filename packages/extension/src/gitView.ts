import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitUri, runGit } from './git';
import { BRANCH_FORMAT, type Branch, type FileChange, GRAPH_FORMAT, type GraphRow, layoutGraph, parseBranches, parseGraphLog, parseStatus } from './gitGraphModel';

/**
 * The Refyntra Git tab: the changes of the working tree (stage, unstage, commit), the local branches with their upstream
 * state, and the commit graph of every branch (where a branch was cut, where it was merged). One repository at a time;
 * a folder with several repositories has a picker. git CLI, trusted workspaces only.
 */

export const GIT_VIEW = 'refyntra.gitView';
const GRAPH_LIMIT = 400;

export interface GitViewModel {
  repos: string[];
  repo?: string;
  head?: string;
  changes: FileChange[];
  branches: Branch[];
  rows: GraphRow[];
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

export class GitViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private repo: string | undefined;
  private current: GitViewModel = { repos: [], changes: [], branches: [], rows: [] };
  private refreshing: Promise<GitViewModel> | undefined;
  /** Tests: the message the commit box would send, and answers to confirmations. */
  readonly hooks: { confirm?: boolean } = {};

  constructor(
    private readonly isTrusted: () => boolean,
    private readonly state: vscode.Memento,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => void this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
    void this.refresh();
  }

  model(): GitViewModel {
    return this.current;
  }

  /** Re-reads the repository and redraws (a refresh in progress is shared). */
  refresh(): Promise<GitViewModel> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.read().finally(() => (this.refreshing = undefined));
    return this.refreshing.then((m) => {
      this.current = m;
      void this.view?.webview.postMessage({ type: 'model', model: toWire(m) });
      return m;
    });
  }

  private async read(): Promise<GitViewModel> {
    if (!this.isTrusted()) return { repos: [], changes: [], branches: [], rows: [], error: 'Trust the workspace to use Git here (a repository configuration can run programs).' };
    const repos = findRepos((vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath));
    if (repos.length === 0) return { repos, changes: [], branches: [], rows: [], error: 'No git repository in this workspace.' };
    const saved = this.state.get<string>('refyntra.git.repo');
    const repo = [this.repo, saved].find((r) => r && repos.includes(r)) ?? repos[0]!;
    this.repo = repo;
    const [status, branches, log, head] = await Promise.all([
      runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repo),
      runGit(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'], repo),
      runGit(['log', '--all', '--date-order', `--format=${GRAPH_FORMAT}`, '-n', String(GRAPH_LIMIT)], repo),
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo),
    ]);
    if (status.code !== 0) return { repos, repo, changes: [], branches: [], rows: [], error: status.stderr.trim() || 'git status failed.' };
    return {
      repos,
      repo,
      head: head.stdout.trim(),
      changes: parseStatus(status.stdout),
      branches: parseBranches(branches.stdout),
      rows: log.code === 0 ? layoutGraph(parseGraphLog(log.stdout)) : [],
    };
  }

  async selectRepo(repo: string): Promise<void> {
    this.repo = repo;
    await this.state.update('refyntra.git.repo', repo);
    await this.refresh();
  }

  async stage(paths: string[]): Promise<void> {
    if (!this.repo || paths.length === 0) return;
    await runGit(['add', '--', ...paths], this.repo);
    await this.refresh();
  }

  async unstage(paths: string[]): Promise<void> {
    if (!this.repo || paths.length === 0) return;
    await runGit(['restore', '--staged', '--', ...paths], this.repo);
    await this.refresh();
  }

  /** Commits what is staged with the message; false (and a message) when git refuses. */
  async commit(message: string): Promise<boolean> {
    if (!this.repo || !message.trim()) return false;
    if (!this.current.changes.some((c) => c.staged)) {
      void vscode.window.showInformationMessage('Refyntra: nothing is staged. Stage files first (+).');
      return false;
    }
    const r = await runGit(['commit', '-F', '-'], this.repo, message);
    await this.refresh();
    if (r.code !== 0) {
      void vscode.window.showErrorMessage(`Refyntra: git commit failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
      return false;
    }
    return true;
  }

  /** The files of a commit; picking one opens its change as a diff. */
  async showCommit(sha: string, pick?: (items: vscode.QuickPickItem[]) => Promise<vscode.QuickPickItem | undefined>): Promise<number> {
    if (!this.repo) return 0;
    const r = await runGit(['show', '--name-status', '--format=%s', '-M', sha], this.repo);
    const [subject, ...lines] = r.stdout.split('\n');
    const files = lines
      .map((l) => l.split('\t'))
      .filter((p) => p.length >= 2 && /^[AMDRCT]/.test(p[0]!))
      .map((p) => ({ status: p[0]![0]!, path: p[p.length - 1]!, from: p.length > 2 ? p[1] : undefined }));
    const items = files.map((f) => ({ label: f.path, description: { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' }[f.status] ?? f.status, file: f }));
    const chosen = (pick ? await pick(items) : await vscode.window.showQuickPick(items, { title: `Refyntra: ${sha.slice(0, 8)} ${subject ?? ''}` })) as (typeof items)[number] | undefined;
    if (chosen) {
      const abs = path.join(this.repo, chosen.file.path);
      await vscode.commands.executeCommand('vscode.diff', gitUri(abs, `${sha}^`, chosen.file.from ?? chosen.file.path), gitUri(abs, sha, chosen.file.path), `${chosen.file.path} (${sha.slice(0, 8)})`, { preview: true });
    }
    return items.length;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    const paths = Array.isArray(m.paths) ? (m.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.refresh();
        break;
      case 'repo':
        if (typeof m.repo === 'string' && this.current.repos.includes(m.repo)) await this.selectRepo(m.repo);
        break;
      case 'stage':
        await this.stage(paths);
        break;
      case 'unstage':
        await this.unstage(paths);
        break;
      case 'commit':
        if (typeof m.message === 'string' && (await this.commit(m.message))) void this.view?.webview.postMessage({ type: 'committed' });
        break;
      case 'open':
        if (this.repo && typeof m.path === 'string') {
          const abs = path.join(this.repo, m.path);
          if (m.staged === true) await vscode.commands.executeCommand('vscode.diff', gitUri(abs, 'HEAD', m.path), gitUri(abs, ':0', m.path), `${m.path} (staged)`, { preview: true });
          else await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
        }
        break;
      case 'commitFiles':
        if (typeof m.sha === 'string' && /^[0-9a-f]{40}$/.test(m.sha)) await this.showCommit(m.sha);
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 8px 16px;}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));display:flex;justify-content:space-between;align-items:center}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:3px 10px;cursor:pointer;border-radius:2px}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0 4px}
button:disabled{opacity:.5;cursor:default}
select,textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font:inherit}
textarea{min-height:44px;resize:vertical;margin:4px 0}
.row{display:flex;align-items:center;gap:6px;padding:1px 0;cursor:pointer;white-space:nowrap;overflow:hidden}
.row:hover{background:var(--vscode-list-hoverBackground)}
.st{width:14px;text-align:center;font-weight:600;flex:none}
.st.M{color:var(--vscode-gitDecoration-modifiedResourceForeground)}.st.A,.st.\\?{color:var(--vscode-gitDecoration-untrackedResourceForeground)}
.st.D{color:var(--vscode-gitDecoration-deletedResourceForeground)}.st.U{color:var(--vscode-gitDecoration-conflictingResourceForeground)}
.path{overflow:hidden;text-overflow:ellipsis;flex:1}
.act{visibility:hidden;flex:none}.row:hover .act{visibility:visible}
.muted{opacity:.7}.cur{font-weight:600}
.ref{display:inline-block;border-radius:3px;padding:0 4px;margin-right:4px;font-size:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.ref.head{background:var(--vscode-gitDecoration-addedResourceForeground);color:var(--vscode-editor-background)}
.ref.tag{background:transparent;border:1px solid var(--vscode-badge-background);color:var(--vscode-foreground)}
.g{display:flex;align-items:center;height:22px;cursor:pointer}.g:hover{background:var(--vscode-list-hoverBackground)}
.g svg{flex:none}.g .msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.err{color:var(--vscode-errorForeground)}
</style></head><body>
<div id="repoBox"></div>
<div id="err" class="err"></div>
<h3><span>Changes</span><span><button class="link" id="stageAll" title="Stage all">+ all</button><button class="link" id="unstageAll" title="Unstage all">− all</button></span></h3>
<textarea id="msg" placeholder="Commit message"></textarea>
<button id="commit">Commit staged</button>
<div id="staged"></div><div id="unstaged"></div>
<h3><span>Branches</span></h3><div id="branches"></div>
<h3><span>Graph</span></h3><div id="graph"></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const COLORS = ['var(--vscode-charts-blue)','var(--vscode-charts-orange)','var(--vscode-charts-green)','var(--vscode-charts-purple)','var(--vscode-charts-red)','var(--vscode-charts-yellow)'];
let model = null;
$('stageAll').onclick = () => vs.postMessage({ type: 'stage', paths: model.changes.filter(c => !c.staged).map(c => c.path) });
$('unstageAll').onclick = () => vs.postMessage({ type: 'unstage', paths: model.changes.filter(c => c.staged).map(c => c.path) });
$('commit').onclick = () => vs.postMessage({ type: 'commit', message: $('msg').value });
function fileRow(c) {
  const r = el('div', 'row');
  r.append(el('span', 'st ' + c.status, c.status === '?' ? 'U' : c.status), el('span', 'path', c.path));
  const b = el('button', 'link act', c.staged ? '−' : '+');
  b.title = c.staged ? 'Unstage' : 'Stage';
  b.onclick = (e) => { e.stopPropagation(); vs.postMessage({ type: c.staged ? 'unstage' : 'stage', paths: [c.path] }); };
  r.append(b);
  r.onclick = () => vs.postMessage({ type: 'open', path: c.path, staged: c.staged });
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
  g.onclick = () => vs.postMessage({ type: 'commitFiles', sha: row.sha });
  return g;
}
function render() {
  $('err').textContent = model.error || '';
  const box = $('repoBox'); box.textContent = '';
  if (model.repos.length > 1) {
    const s = el('select'); s.title = 'Repository';
    for (const r of model.repos) { const o = el('option', '', r.name); o.value = r.path; o.selected = r.path === model.repo; s.append(o); }
    s.onchange = () => vs.postMessage({ type: 'repo', repo: s.value });
    box.append(s);
  }
  const st = $('staged'), un = $('unstaged'); st.textContent = ''; un.textContent = '';
  const staged = model.changes.filter(c => c.staged), work = model.changes.filter(c => !c.staged);
  if (staged.length) { st.append(el('div', 'muted', 'Staged (' + staged.length + ')')); staged.forEach(c => st.append(fileRow(c))); }
  un.append(el('div', 'muted', work.length ? 'Changes (' + work.length + ')' : (staged.length ? '' : 'No changes')));
  work.forEach(c => un.append(fileRow(c)));
  $('commit').disabled = staged.length === 0;
  const br = $('branches'); br.textContent = '';
  for (const b of model.branches) {
    const r = el('div', 'row' + (b.current ? ' cur' : ''));
    r.append(el('span', '', (b.current ? '● ' : '  ') + b.name));
    const state = b.gone ? 'upstream gone' : b.upstream ? (b.ahead || b.behind ? '↑' + b.ahead + ' ↓' + b.behind : 'up to date') + ' · ' + b.upstream : 'local only';
    r.append(el('span', 'muted', state));
    br.append(r);
  }
  const gr = $('graph'); gr.textContent = '';
  const width = Math.max(1, ...model.rows.map(r => r.width));
  for (const row of model.rows) gr.append(graphRow(row, width));
}
window.addEventListener('message', (e) => {
  if (e.data.type === 'model') { model = e.data.model; render(); }
  if (e.data.type === 'committed') $('msg').value = '';
});
vs.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

/** What the page draws: plain data, the repository names relative to the workspace. */
function toWire(m: GitViewModel) {
  return {
    repos: m.repos.map((r) => ({ path: r, name: vscode.workspace.asRelativePath(r, false) || path.basename(r) })),
    repo: m.repo,
    changes: m.changes,
    branches: m.branches,
    error: m.error,
    rows: m.rows.map((r) => ({ sha: r.commit.sha, author: r.commit.author, time: r.commit.time, subject: r.commit.subject, refs: r.commit.refs, parents: r.commit.parents.length, lane: r.lane, pass: r.pass, into: r.into, out: r.out, width: r.width })),
  };
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
  );
  return provider;
}
