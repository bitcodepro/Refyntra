import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { scanCSharpDeclarations } from './codeLensModel';
import { authorshipTitle, type BlameLine, type Commit, declarationRanges, LOG_FORMAT, parseBlamePorcelain, parseLog, relativeTime, summarizeRange } from './gitModel';

/**
 * Git history and authorship: Show History of a file or of the selected lines (who changed it, each change opened as a
 * diff) and an authorship CodeLens next to C# declarations ("Alice +1, 3 months ago"). Runs the git CLI (trusted
 * workspaces only: a repository's configuration can run programs), reads only.
 */

export const GIT_SCHEME = 'refyntra-git';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], cwd: string, stdin?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const roots = new Map<string, Promise<string | undefined>>();

/** The repository root of a file (cached per folder); undefined outside a repository or without git. */
export function repoRootOf(fsPath: string): Promise<string | undefined> {
  const dir = path.dirname(fsPath);
  let p = roots.get(dir);
  if (!p) {
    p = runGit(['rev-parse', '--show-toplevel'], dir).then((r) => (r.code === 0 ? path.normalize(r.stdout.trim()) : undefined));
    roots.set(dir, p);
  }
  return p;
}

function relPath(root: string, fsPath: string): string {
  return path.relative(root, fsPath).split(path.sep).join('/');
}

/** A read-only document with a file's content at a commit: refyntra-git:/<fsPath>?<sha>. */
export function gitUri(fsPath: string, ref: string, repoPath?: string): vscode.Uri {
  return vscode.Uri.file(fsPath).with({ scheme: GIT_SCHEME, query: JSON.stringify({ ref, path: repoPath }) });
}

class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query || '{}') as { ref?: string; path?: string };
    const root = await repoRootOf(uri.fsPath);
    if (!root || !q.ref) return '';
    const r = await runGit(['show', `${q.ref}:${q.path ?? relPath(root, uri.fsPath)}`], root);
    return r.code === 0 ? r.stdout : '';
  }
}

export class GitService {
  private readonly blames = new Map<string, { version: number; lines: Promise<BlameLine[] | undefined> }>();

  constructor(private readonly isTrusted: () => boolean) {}

  /** `git blame` of the document as it is in the editor (unsaved text included), cached per version. */
  blame(doc: vscode.TextDocument): Promise<BlameLine[] | undefined> {
    const key = doc.uri.toString();
    const hit = this.blames.get(key);
    if (hit && hit.version === doc.version) return hit.lines;
    const lines = (async () => {
      if (!this.isTrusted() || doc.uri.scheme !== 'file') return undefined;
      const root = await repoRootOf(doc.uri.fsPath);
      if (!root) return undefined;
      const r = await runGit(['blame', '--line-porcelain', '--contents', '-', '--', relPath(root, doc.uri.fsPath)], root, doc.getText());
      return r.code === 0 ? parseBlamePorcelain(r.stdout) : undefined;
    })();
    this.blames.set(key, { version: doc.version, lines });
    if (this.blames.size > 200) this.blames.delete(this.blames.keys().next().value!);
    return lines;
  }

  forget(uri: vscode.Uri): void {
    this.blames.delete(uri.toString());
  }

  /** Commits of a file (following renames), or of zero-based lines [from, to] of it (`git log -L`). */
  async history(fsPath: string, range?: { from: number; to: number }): Promise<{ root: string; commits: (Commit & { path: string })[] } | undefined> {
    const root = await repoRootOf(fsPath);
    if (!root) return undefined;
    const rel = relPath(root, fsPath);
    if (range) {
      const r = await runGit(['log', `--format=${LOG_FORMAT}`, '-s', '-n', '200', `-L${range.from + 1},${range.to + 1}:${rel}`], root);
      return { root, commits: parseLog(r.stdout).map((c) => ({ ...c, path: rel })) };
    }
    const r = await runGit(['log', '--follow', `--format=${LOG_FORMAT}`, '--name-only', '-n', '500', '--', rel], root);
    const commits = r.stdout.split('\x1e').flatMap((rec) => {
      const [c] = parseLog('\x1e' + rec);
      if (!c) return [];
      const file = rec.split('\n').slice(1).map((l) => l.trim()).find((l) => l.length > 0);
      return [{ ...c, path: file ?? rel }];
    });
    return { root, commits };
  }
}

/** Authorship next to C# declarations, in the same line as Refyntra's other lenses. */
class AuthorLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly git: GitService) {}

  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const c = vscode.workspace.getConfiguration('refyntra');
    if (!c.get<boolean>('codeLens.enabled', true) || !c.get<boolean>('codeLens.authors', false) || doc.uri.scheme !== 'file') return [];
    // No lens at all outside a repository (or in Restricted Mode), not an empty one.
    if (!(await this.git.blame(doc))) return [];
    const decls = scanCSharpDeclarations(doc.getText());
    const ranges = declarationRanges(decls.map((d) => d.line), doc.lineCount);
    return decls.map((d, i) => {
      const lens = new vscode.CodeLens(new vscode.Range(d.line, d.character, d.line, d.character + d.name.length));
      (lens as vscode.CodeLens & { span?: { from: number; to: number }; doc?: vscode.TextDocument }).span = ranges[i];
      (lens as vscode.CodeLens & { doc?: vscode.TextDocument }).doc = doc;
      return lens;
    });
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const { span, doc } = lens as vscode.CodeLens & { span: { from: number; to: number }; doc: vscode.TextDocument };
    const lines = await this.git.blame(doc);
    const text = doc.getText().split(/\r?\n/);
    const a = lines ? summarizeRange(lines, span.from, span.to, (i) => /^[\s{}();]*$/.test(text[i] ?? '')) : undefined;
    lens.command = a
      ? {
          title: `$(person) ${authorshipTitle(a, Date.now() / 1000)}`,
          tooltip: `Last change: ${a.lastAuthor}, ${relativeTime(a.lastTime, Date.now() / 1000)} — ${a.lastSummary}\n${a.authors} author(s). Click for the history of these lines.`,
          command: 'refyntra.git.rangeHistory',
          arguments: [doc.uri, span.from, span.to],
        }
      : { title: '$(person) not committed yet', command: '' };
    return lens;
  }
}

async function showHistory(git: GitService, uri: vscode.Uri, range?: { from: number; to: number }, picks?: { pick?: (items: vscode.QuickPickItem[]) => Promise<vscode.QuickPickItem | undefined> }): Promise<number> {
  const h = await git.history(uri.fsPath, range);
  if (!h) {
    void vscode.window.showInformationMessage('Refyntra: this file is not in a git repository (or git is not installed).');
    return -1;
  }
  const now = Date.now() / 1000;
  const name = path.basename(uri.fsPath);
  const items = h.commits.map((c) => ({
    label: `$(git-commit) ${c.subject}`,
    description: `${c.author} · ${relativeTime(c.time, now)}`,
    detail: `${c.sha.slice(0, 8)} · ${new Date(c.time * 1000).toLocaleString()}${c.path !== path.relative(h.root, uri.fsPath).split(path.sep).join('/') ? ` · ${c.path}` : ''}`,
    commit: c,
  }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`Refyntra: no commits for ${range ? `lines ${range.from + 1}–${range.to + 1} of ` : ''}${name}.`);
    return 0;
  }
  const title = range ? `History of ${name}:${range.from + 1}–${range.to + 1}` : `History of ${name}`;
  const pick = (picks?.pick ? await picks.pick(items) : await vscode.window.showQuickPick(items, { title: `Refyntra: ${title}`, matchOnDescription: true, matchOnDetail: true })) as (typeof items)[number] | undefined;
  if (pick) {
    const c = pick.commit;
    const file = path.join(h.root, c.path);
    await vscode.commands.executeCommand('vscode.diff', gitUri(file, `${c.sha}^`, c.path), gitUri(file, c.sha, c.path), `${name} (${c.sha.slice(0, 8)}) — ${c.author}: ${c.subject}`, {
      preview: true,
      ...(range ? { selection: new vscode.Range(range.from, 0, range.from, 0) } : {}),
    });
  }
  return items.length;
}

const SELECTION_HISTORY_KIND = vscode.CodeActionKind.Refactor.append('refyntra.gitHistory');

/** The lines a selection covers (an end at column 0 of a later line does not count that line). */
export function selectionLines(sel: vscode.Range): { from: number; to: number } {
  return { from: sel.start.line, to: sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line };
}

class SelectionHistoryActions implements vscode.CodeActionProvider {
  constructor(private readonly isTrusted: () => boolean) {}

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    if (range.isEmpty || !this.isTrusted() || doc.uri.scheme !== 'file') return [];
    const { from, to } = selectionLines(range);
    const action = new vscode.CodeAction(from === to ? `Show Git History of Line ${from + 1}` : `Show Git History of Lines ${from + 1}–${to + 1}`, SELECTION_HISTORY_KIND);
    action.command = { command: 'refyntra.git.rangeHistory', title: action.title, arguments: [doc.uri, from, to] };
    return [action];
  }
}

export interface GitApi {
  service: GitService;
  /** Tests: the history items (no picker; the first is opened when `open`). */
  history(uri: vscode.Uri, range?: { from: number; to: number }, open?: boolean): Promise<number>;
  authorLens: { refresh(): void };
}

export function registerGit(context: vscode.ExtensionContext, isTrusted: () => boolean): GitApi {
  const service = new GitService(isTrusted);
  const lens = new AuthorLensProvider(service);
  const needsTrust = (): boolean => {
    if (isTrusted()) return true;
    void vscode.window.showInformationMessage('Refyntra: git history needs a trusted workspace (a repository configuration can run programs).');
    return false;
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()),
    vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'csharp' }, lens),
    vscode.workspace.onDidSaveTextDocument((d) => service.forget(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refyntra.codeLens')) lens.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => lens.refresh()),
    // Show History: the selected lines when there is a selection, else the whole file (editor, explorer, tab).
    vscode.commands.registerCommand('refyntra.git.history', async (arg?: unknown) => {
      if (!needsTrust()) return;
      const editor = vscode.window.activeTextEditor;
      const uri = arg instanceof vscode.Uri ? arg : editor?.document.uri;
      if (!uri || uri.scheme !== 'file') return;
      const sel = editor && editor.document.uri.toString() === uri.toString() && !editor.selection.isEmpty ? editor.selection : undefined;
      const range = sel ? { from: sel.start.line, to: sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line } : undefined;
      await showHistory(service, uri, range);
    }),
    // In the light bulb (Ctrl+.) of a selection, any language: the history of exactly those lines.
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new SelectionHistoryActions(isTrusted), { providedCodeActionKinds: [SELECTION_HISTORY_KIND] }),
    vscode.commands.registerCommand('refyntra.git.rangeHistory', async (uri: vscode.Uri, from: number, to: number) => {
      if (!needsTrust()) return;
      await showHistory(service, uri, { from, to });
    }),
  );
  return {
    service,
    history: (uri, range, open) => showHistory(service, uri, range, { pick: async (items) => (open ? items[0] : undefined) }),
    authorLens: lens,
  };
}
