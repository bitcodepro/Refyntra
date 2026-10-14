import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { CancelledError, type EngineClient, type RenameOutcome } from '@refyntra/application';
import { CSHARP_STRUCTURAL_REPLACE_ACTION, type StructuralMatch, type StructuralPattern, type StructuralSearchResult } from '@refyntra/contracts';
import { fromRange, shortPath } from './convert';
import { runCodePlan } from './codeRefactor';
import type { VsCodeEditApplier } from './editApplier';
import type { PreviewContentProvider } from './rename';
import { renderStructuralHtml } from './structuralSearchHtml';
import {
  DEFAULT_RESULT_LIMIT,
  EMPTY_EDITOR,
  type EditorState,
  type FileGroup,
  PATTERNS_FILE,
  PATTERN_SEVERITIES,
  type PanelView,
  type SavedPattern,
  editorFromPattern,
  groupMatches,
  inspectionPatterns,
  mergePatterns,
  nextResultLimit,
  panelView,
  parsePanelMessage,
  parsePatternsFile,
  patternFromEditor,
  patternProblems,
  previewOf,
  removePattern,
  resultsHeadline,
  serializePatterns,
  syncPlaceholders,
  toProtocol,
  upsertPattern,
  valuesText,
} from './structuralSearchModel';

// Structural Search and Replace (protocol 1.19, ADR-012): the "Refyntra: Structural Search…" panel, the "Structural
// Search Results" view, saved patterns (workspace .refyntra/patterns.json, the user's patterns in the extension's
// global storage) and the pattern inspections they feed into the "refyntra" diagnostics. Replacing goes through the
// shared plan → preview → revalidate → EditApplier pipeline (codeRefactor.runCodePlan); nothing is written here.

export const RESULTS_VIEW = 'refyntra.structuralResultsView';
const TITLE = 'Structural Search';

/** Saved patterns: the workspace file and the user's file, with a change event (the inspections follow it). */
export class PatternStore implements vscode.Disposable {
  private workspace: SavedPattern[] = [];
  private user: SavedPattern[] = [];
  errors: string[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private loading: Promise<void> | undefined;

  constructor(private readonly userFile: vscode.Uri) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${PATTERNS_FILE}`);
    this.subs.push(watcher, watcher.onDidChange(() => void this.load()), watcher.onDidCreate(() => void this.load()), watcher.onDidDelete(() => void this.load()), this.changed);
  }

  workspaceFile(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, ...PATTERNS_FILE.split('/')) : undefined;
  }

  /** Reads both files (a missing file is an empty list; a malformed one is reported in `errors`). */
  load(): Promise<void> {
    this.loading = (async () => {
      const errors: string[] = [];
      const read = async (uri: vscode.Uri | undefined, origin: 'workspace' | 'user'): Promise<SavedPattern[]> => {
        if (!uri) return [];
        let text: string;
        try {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          return [];
        }
        const r = parsePatternsFile(text, origin);
        errors.push(...r.errors.map((e) => `${origin === 'workspace' ? PATTERNS_FILE : 'user patterns'}: ${e}`));
        return r.patterns;
      };
      this.workspace = await read(this.workspaceFile(), 'workspace');
      this.user = await read(this.userFile, 'user');
      this.errors = errors;
      this.changed.fire();
    })();
    return this.loading;
  }

  ready(): Promise<void> {
    return this.loading ?? this.load();
  }

  all(): SavedPattern[] {
    return mergePatterns(this.workspace, this.user);
  }

  /** The enabled pattern inspections (protocol patterns with rule ids ORS-<name>). */
  inspections(): StructuralPattern[] {
    return inspectionPatterns([...this.workspace, ...this.user]);
  }

  async save(p: SavedPattern): Promise<void> {
    if (p.origin === 'builtin') throw new Error('Built-in patterns are read-only.');
    const target = p.origin === 'workspace' ? this.workspaceFile() : this.userFile;
    if (!target) throw new Error('Open a folder to save workspace patterns.');
    const list = upsertPattern(p.origin === 'workspace' ? this.workspace : this.user, p);
    await this.write(target, list);
    if (p.origin === 'workspace') this.workspace = list;
    else this.user = list;
    this.changed.fire();
  }

  async delete(id: string): Promise<void> {
    const ws = this.workspace.some((p) => p.id === id);
    const target = ws ? this.workspaceFile() : this.userFile;
    if (!target) return;
    const list = removePattern(ws ? this.workspace : this.user, id);
    await this.write(target, list);
    if (ws) this.workspace = list;
    else this.user = list;
    this.changed.fire();
  }

  private async write(uri: vscode.Uri, list: readonly SavedPattern[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializePatterns(list)));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}

type ResultNode = { kind: 'file'; group: FileGroup } | { kind: 'match'; group: FileGroup; index: number } | { kind: 'more' } | { kind: 'message'; text: string };

/** The "Structural Search Results" view: files with their match count, each match with its line preview. */
export class StructuralResultsProvider implements vscode.TreeDataProvider<ResultNode> {
  private readonly emitter = new vscode.EventEmitter<ResultNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private groups: FileGroup[] = [];
  private matches: readonly StructuralMatch[] = [];
  private headline = '';
  private truncated = false;

  set(result: StructuralSearchResult | undefined): void {
    this.matches = result?.matches ?? [];
    this.groups = groupMatches(this.matches, shortPath);
    this.headline = result ? resultsHeadline(result) : '';
    this.truncated = !!result?.truncated;
    void vscode.commands.executeCommand('setContext', 'refyntra.structuralResultsVisible', !!result);
    void vscode.commands.executeCommand('setContext', 'refyntra.structuralHasResults', this.matches.length > 0);
    this.emitter.fire(undefined);
  }

  match(index: number): StructuralMatch | undefined {
    return this.matches[index];
  }

  state(): { headline: string; files: { label: string; count: number }[]; total: number; truncated: boolean } {
    return { headline: this.headline, files: this.groups.map((g) => ({ label: g.label, count: g.count })), total: this.matches.length, truncated: this.truncated };
  }

  getChildren(node?: ResultNode): ResultNode[] {
    if (!node) {
      if (!this.headline) return [];
      const out: ResultNode[] = [{ kind: 'message', text: this.headline }, ...this.groups.map((group): ResultNode => ({ kind: 'file', group }))];
      if (this.truncated) out.push({ kind: 'more' });
      return out;
    }
    if (node.kind === 'file') return node.group.rows.map((r): ResultNode => ({ kind: 'match', group: node.group, index: r.index }));
    return [];
  }

  getTreeItem(node: ResultNode): vscode.TreeItem {
    switch (node.kind) {
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        item.accessibilityInformation = { label: node.text };
        return item;
      }
      case 'more': {
        const item = new vscode.TreeItem('Show more matches…', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('add');
        item.command = { command: 'refyntra.structuralSearch.showMore', title: 'Show more' };
        item.accessibilityInformation = { label: 'Show more matches', role: 'button' };
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${node.group.count} match${node.group.count === 1 ? '' : 'es'}`;
        item.resourceUri = vscode.Uri.parse(node.group.uri, true);
        item.iconPath = vscode.ThemeIcon.File;
        item.accessibilityInformation = { label: `${node.group.label}, ${item.description}` };
        return item;
      }
      case 'match': {
        const m = this.matches[node.index]!;
        const preview = previewOf(m.lineText, 120);
        const item = new vscode.TreeItem(preview || '(empty line)', vscode.TreeItemCollapsibleState.None);
        item.description = `line ${m.range.start.line + 1}`;
        const values = valuesText(m.values);
        item.tooltip = values ? `${preview}\n${values}` : preview;
        item.contextValue = 'structuralMatch';
        item.command = { command: 'refyntra.structuralSearch.openMatch', title: 'Open match', arguments: [node.index] };
        item.accessibilityInformation = { label: `Line ${m.range.start.line + 1}: ${preview}${values ? `; ${values}` : ''}` };
        return item;
      }
    }
  }
}

/** Test and command surface of structural search. */
export interface StructuralSearchService {
  /** Opens (or reveals) the panel, optionally with a pattern. */
  open(seed?: Partial<EditorState>): Promise<void>;
  /** The panel's view model (undefined when closed). */
  view(): PanelView | undefined;
  /** A message as the page would post it (validated). */
  dispatch(raw: unknown): Promise<void>;
  /** Runs the search of the current pattern; resolves with the result (undefined when cancelled or invalid). */
  search(): Promise<StructuralSearchResult | undefined>;
  /** Prepares the replace plan of the current pattern (all matches, or the given ones) without showing it. */
  prepareReplace(matches?: readonly StructuralMatch[]): Promise<RenameOutcome>;
  results: StructuralResultsProvider;
  store: PatternStore;
}

class StructuralSearchPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  editor: EditorState = { ...EMPTY_EDITOR };
  private selectedId: string | undefined;
  private busy = false;
  private result: StructuralSearchResult | undefined;
  private message: string | undefined;
  private limit = DEFAULT_RESULT_LIMIT;
  private lastCSharp: vscode.Uri | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly previews: PreviewContentProvider,
    private readonly applier: VsCodeEditApplier,
    readonly store: PatternStore,
    readonly results: StructuralResultsProvider,
  ) {
    const track = (ed: vscode.TextEditor | undefined) => {
      if (ed && ed.document.languageId === 'csharp' && ed.document.uri.scheme === 'file') this.lastCSharp = ed.document.uri;
    };
    track(vscode.window.activeTextEditor);
    this.subs.push(vscode.window.onDidChangeActiveTextEditor(track), store.onDidChange(() => this.render()));
  }

  async open(seed?: Partial<EditorState>): Promise<void> {
    await this.store.ready();
    if (seed) {
      const text = seed.text ?? this.editor.text;
      this.editor = { ...this.editor, ...seed, text, placeholders: syncPlaceholders(text, seed.placeholders ?? this.editor.placeholders) };
      this.selectedId = undefined;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel('refyntra.structuralSearch', `Refyntra: ${TITLE}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.panel = panel;
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = renderStructuralHtml({ nonce, cspSource: panel.webview.cspSource, title: TITLE, severities: PATTERN_SEVERITIES });
    panel.webview.onDidReceiveMessage((m: unknown) => void this.dispatch(m));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
  }

  view(): PanelView | undefined {
    if (!this.panel) return undefined;
    return panelView({ editor: this.editor, patterns: this.store.all(), selectedId: this.selectedId, busy: this.busy, result: this.result, message: this.message, label: shortPath });
  }

  private render(announce?: string): void {
    const v = this.view();
    if (v) void this.panel!.webview.postMessage({ type: 'render', view: v, ...(announce ? { announce } : {}) });
  }

  async dispatch(raw: unknown): Promise<void> {
    const msg = parsePanelMessage(raw);
    if (!msg) return;
    try {
      switch (msg.type) {
        case 'ready':
          return this.render();
        case 'change':
          this.editor = msg.editor;
          return this.render();
        case 'search':
          this.limit = DEFAULT_RESULT_LIMIT;
          await this.search();
          return;
        case 'showMore':
          this.limit = nextResultLimit(this.limit);
          await this.search();
          return;
        case 'replaceAll':
          return await this.replace();
        case 'replaceMatch': {
          const m = this.result?.matches[msg.index];
          if (m) await this.replace([m]);
          return;
        }
        case 'openMatch':
          return await this.openMatch(msg.index);
        case 'load': {
          const p = this.store.all().find((x) => x.id === msg.id);
          if (!p) return;
          this.editor = editorFromPattern(p, this.editor.scope);
          this.selectedId = p.id;
          return this.render(`Loaded ${p.name}.`);
        }
        case 'delete': {
          const p = this.store.all().find((x) => x.id === msg.id);
          if (!p || p.origin === 'builtin') return;
          const ok = await vscode.window.showWarningMessage(`Delete the pattern "${p.name}"?`, { modal: true }, 'Delete');
          if (ok !== 'Delete') return;
          await this.store.delete(p.id);
          return this.render(`Deleted ${p.name}.`);
        }
        case 'save': {
          const name = msg.name.trim();
          const inspection = msg.inspection ? { enabled: true, severity: msg.severity } : undefined;
          const problems = patternProblems({ ...this.editor, name, ...(inspection ? { inspection } : {}) }, 'save');
          if (problems.length) {
            this.message = problems.join(' ');
            return this.render(this.message);
          }
          const p = patternFromEditor(this.editor, name, msg.target, inspection);
          await this.store.save(p);
          this.selectedId = this.store.all().find((x) => x.origin === msg.target && x.name.toLowerCase() === name.toLowerCase())?.id;
          return this.render(`Saved ${name}${msg.target === 'workspace' ? ` in ${PATTERNS_FILE}` : ' for you'}.`);
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) return;
      void vscode.window.showErrorMessage(`Refyntra ${TITLE}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private target(): string | undefined {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'csharp' && ed.document.uri.scheme === 'file') this.lastCSharp = ed.document.uri;
    return this.lastCSharp?.toString();
  }

  async search(): Promise<StructuralSearchResult | undefined> {
    const problems = patternProblems(this.editor, 'search');
    if (problems.length) {
      this.message = problems.join(' ');
      this.render(this.message);
      return undefined;
    }
    if (!this.engine.structuralSearch) return undefined;
    const uri = this.target();
    if (this.editor.scope !== 'solution' && !uri) {
      this.message = 'Open a C# file of the solution first (the scope is the current file or project), or search the solution.';
      this.render(this.message);
      return undefined;
    }
    this.busy = true;
    this.message = 'Searching…';
    this.render();
    try {
      const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refyntra: ${TITLE}`, cancellable: true }, (_p, token) =>
        this.engine.structuralSearch!({ pattern: toProtocol({ ...this.editor, replacement: undefined }), scope: this.editor.scope, ...(uri ? { uri } : {}), limit: this.limit }, token),
      );
      if (outcome.kind === 'unavailable') {
        this.message = outcome.message;
        this.result = undefined;
        this.results.set(undefined);
        return undefined;
      }
      this.result = outcome.result;
      this.message = undefined;
      this.results.set(outcome.result.reasonCode ? undefined : outcome.result);
      return outcome.result;
    } catch (e) {
      if (e instanceof CancelledError) {
        this.message = 'Search cancelled.';
        return undefined;
      }
      throw e;
    } finally {
      this.busy = false;
      this.render(this.message ?? (this.result ? resultsHeadline(this.result) : undefined));
    }
  }

  prepareReplace(matches?: readonly StructuralMatch[], token?: vscode.CancellationToken): Promise<RenameOutcome> {
    const uri = matches?.[0]?.uri ?? this.target() ?? this.result?.matches[0]?.uri;
    if (!uri) return Promise.resolve({ kind: 'unavailable', reasonCode: 'NoDocument', message: 'Open a C# file of the solution first.', recoveryActions: [] });
    const at = { line: 0, character: 0 };
    return this.engine.prepareAction({ uri, position: at }, CSHARP_STRUCTURAL_REPLACE_ACTION, token, {
      range: { start: at, end: at },
      structural: {
        pattern: toProtocol(this.editor),
        scope: matches ? 'solution' : this.editor.scope,
        ...(this.target() ? { uri: this.target()! } : {}),
        ...(matches ? { matches: matches.map((m) => ({ uri: m.uri, start: m.range.start })) } : {}),
      },
    });
  }

  private async replace(matches?: readonly StructuralMatch[]): Promise<void> {
    const problems = patternProblems(this.editor, 'replace');
    if (problems.length) {
      this.message = problems.join(' ');
      return this.render(this.message);
    }
    const title = matches ? 'Structural Replace (one match)' : 'Structural Replace';
    await runCodePlan(this.engine, this.previews, this.applier, title, (token) => this.prepareReplace(matches, token), () => this.replace(matches));
  }

  async openMatch(index: number): Promise<void> {
    const m = this.result?.matches[index] ?? this.results.match(index);
    if (!m) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(m.uri, true));
    const range = fromRange(m.range);
    await vscode.window.showTextDocument(doc, { selection: range, preview: true, viewColumn: vscode.ViewColumn.One });
  }

  async showMore(): Promise<void> {
    this.limit = nextResultLimit(this.limit);
    await this.search();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const s of this.subs) s.dispose();
  }
}

/** The pattern text to start with: the selection of a C# editor (its code as the pattern), else the last one. */
function seedFromSelection(): Partial<EditorState> | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'csharp' || ed.selection.isEmpty) return undefined;
  const text = ed.document.getText(ed.selection).trim();
  return text && text.length < 2000 ? { text, replacement: '' } : undefined;
}

export function registerStructuralSearch(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  previews: PreviewContentProvider,
  applier: VsCodeEditApplier,
): { service: StructuralSearchService; inspections: { patterns(): readonly StructuralPattern[]; onDidChange: vscode.Event<void> }; disposable: vscode.Disposable } {
  const store = new PatternStore(vscode.Uri.joinPath(context.globalStorageUri, 'patterns.json'));
  const results = new StructuralResultsProvider();
  const panel = new StructuralSearchPanel(engine, previews, applier, store, results);
  const view = vscode.window.createTreeView(RESULTS_VIEW, { treeDataProvider: results, showCollapseAll: true });
  void store.load();
  const service: StructuralSearchService = {
    open: (seed) => panel.open(seed),
    view: () => panel.view(),
    dispatch: (raw) => panel.dispatch(raw),
    search: () => panel.search(),
    prepareReplace: (matches) => panel.prepareReplace(matches),
    results,
    store,
  };
  const disposable = vscode.Disposable.from(
    store,
    panel,
    view,
    vscode.commands.registerCommand('refyntra.structuralSearch', () => panel.open(seedFromSelection())),
    vscode.commands.registerCommand('refyntra.structuralSearch.replaceAll', async () => {
      await panel.open();
      await panel.dispatch({ type: 'replaceAll' });
    }),
    vscode.commands.registerCommand('refyntra.structuralSearch.rerun', async () => {
      await panel.open();
      await panel.dispatch({ type: 'search' });
    }),
    vscode.commands.registerCommand('refyntra.structuralSearch.clear', () => results.set(undefined)),
    vscode.commands.registerCommand('refyntra.structuralSearch.showMore', () => panel.showMore()),
    vscode.commands.registerCommand('refyntra.structuralSearch.openMatch', (index: unknown) => (typeof index === 'number' ? panel.openMatch(index) : undefined)),
    vscode.commands.registerCommand('refyntra.structuralSearch.replaceMatch', (node?: { kind?: string; index?: unknown }) => {
      const index = typeof node?.index === 'number' ? node.index : undefined;
      return index === undefined ? undefined : panel.dispatch({ type: 'replaceMatch', index });
    }),
  );
  return { service, inspections: { patterns: () => store.inspections(), onDidChange: store.onDidChange }, disposable };
}
