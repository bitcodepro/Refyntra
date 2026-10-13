import * as vscode from 'vscode';
import { CancelledError, type DocumentTarget, type EngineClient } from '@refyntra/application';
import type { UsageItem, UsageKind } from '@refyntra/contracts';
import { fromRange, openLocation, toPosition } from './convert';
import {
  DEFAULT_GROUPINGS,
  GROUPING_ORDER,
  GROUPING_TITLES,
  type Grouping,
  KIND_ICONS,
  KIND_TITLES,
  NO_FILTERS,
  type TestsFilter,
  type UsageFilters,
  type UsageTreeNode,
  buildUsageTree,
  describeFilters,
  fileName,
  filtersActive,
  kindCounts,
  nextLimit,
  previewLabel,
  relativePath,
  stepIndex,
  usageDescription,
  usagesToMarkdown,
} from './usagesModel';

// "Refyntra Usages" tree view: Find Usages grouped by kind, project, folder, file, containing type and member, with
// filters, Next/Previous (F4 / Shift+F4), Markdown export and pinned result tabs. The classification is the host's
// (protocol 1.12, code/usages).

export const USAGES_VIEW = 'refyntra.usagesView';
export const USAGES_LIMIT = 1000;
const GROUPINGS_KEY = 'refyntra.usages.groupings';

interface Session {
  id: number;
  subject: string;
  target: DocumentTarget;
  items: UsageItem[];
  total: number;
  truncated: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  limit: number;
  pinned: boolean;
  current?: number;
}

type Node =
  | { kind: 'session'; session: Session }
  | { kind: 'tree'; session: Session; node: UsageTreeNode<UsageItem> }
  | { kind: 'more'; session: Session }
  | { kind: 'message'; text: string; icon: string };

export interface UsagesViewState {
  loading: boolean;
  message?: string;
  sessions: { subject: string; total: number; loaded: number; shown: number; truncated: boolean; pinned: boolean; active: boolean }[];
  groupings: Grouping[];
  filters: UsageFilters;
  /** The visible tree of the active session, one line per node: indentation, label and description. */
  lines: string[];
}

export class UsagesViewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private sessions: Session[] = [];
  private activeId: number | undefined;
  private nextId = 1;
  private loading = false;
  private message: string | undefined;
  private groupings: Grouping[];
  private filters: UsageFilters = NO_FILTERS;
  private view: vscode.TreeView<Node> | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  /** Tree cache per session (rebuilt when groupings, filters or items change). */
  private trees = new Map<number, { nodes: UsageTreeNode<UsageItem>[]; ordered: UsageItem[]; parents: Map<string, Node> }>();
  private readonly nodeById = new Map<string, Node>();

  constructor(
    private readonly engine: EngineClient,
    private readonly memento: vscode.Memento,
  ) {
    const stored = memento.get<Grouping[]>(GROUPINGS_KEY);
    this.groupings = Array.isArray(stored) ? stored.filter((g) => GROUPING_ORDER.includes(g)) : [...DEFAULT_GROUPINGS];
    this.updateContext();
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateDescription();
  }

  private get active(): Session | undefined {
    return this.sessions.find((s) => s.id === this.activeId);
  }

  private roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString());
  }

  private tree(s: Session) {
    let t = this.trees.get(s.id);
    if (!t) {
      const built = buildUsageTree(s.items, this.groupings, this.filters, this.roots());
      t = { ...built, parents: new Map() };
      this.trees.set(s.id, t);
    }
    return t;
  }

  private invalidate(): void {
    this.trees.clear();
    this.nodeById.clear();
    this.updateContext();
    this.updateDescription();
    this.changed.fire(undefined);
  }

  /** Find Usages for the symbol at the cursor (or `target`); a pinned active result stays and a new tab is added. */
  async find(target?: DocumentTarget, limit = USAGES_LIMIT): Promise<void> {
    let t = target;
    if (!t) {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'csharp') {
        void vscode.window.showInformationMessage('Refyntra Find Usages: place the cursor on a symbol in a C# file.');
        return;
      }
      t = { uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) };
    }
    // The view is in the Refyntra side bar from the first search on (hidden before, so it takes no room).
    await vscode.commands.executeCommand('setContext', 'refyntra.usagesViewVisible', true);
    await vscode.commands.executeCommand(`${USAGES_VIEW}.focus`, { preserveFocus: true }).then(undefined, () => undefined);
    await this.load(t, limit, undefined);
  }

  private async load(target: DocumentTarget, limit: number, replace: Session | undefined): Promise<void> {
    this.cts?.cancel();
    this.cts?.dispose();
    const source = new vscode.CancellationTokenSource();
    this.cts = source;
    this.loading = true;
    this.message = undefined;
    this.invalidate();
    try {
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refyntra: Find Usages', cancellable: true },
        async (_p, token) => {
          const sub = token.onCancellationRequested(() => source.cancel());
          try {
            return await this.engine.usages(target, limit, source.token);
          } finally {
            sub.dispose();
          }
        },
      );
      if (this.cts !== source || source.token.isCancellationRequested) return;
      if (outcome.kind === 'unavailable') {
        this.message = outcome.message;
        return;
      }
      const session: Session = {
        id: replace?.id ?? this.nextId++,
        subject: outcome.subject.displayName ?? outcome.subject.name,
        target,
        items: outcome.items,
        total: outcome.total,
        truncated: outcome.truncated,
        completeness: outcome.completeness,
        limit,
        pinned: replace?.pinned ?? false,
      };
      if (replace) {
        this.sessions = this.sessions.map((s) => (s.id === replace.id ? session : s));
      } else {
        // An unpinned result is replaced; pinned ones stay as tabs. The new result is first.
        this.sessions = [session, ...this.sessions.filter((s) => s.pinned)];
      }
      this.activeId = session.id;
    } catch (e) {
      if (e instanceof CancelledError || source.token.isCancellationRequested) {
        if (this.cts === source) this.message = 'Find Usages was cancelled.';
        return;
      }
      this.message = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      if (this.cts === source) {
        this.loading = false;
        this.invalidate();
      }
    }
  }

  /** Show more: the same search with a higher limit (the session keeps its tab and pin). */
  async showMore(session?: Session): Promise<void> {
    const s = session ?? this.active;
    if (!s || !s.truncated) return;
    await this.load(s.target, nextLimit(s.limit), s);
  }

  async refresh(): Promise<void> {
    const s = this.active;
    if (s) await this.load(s.target, s.limit, s);
  }

  setPinned(pinned: boolean): void {
    const s = this.active;
    if (!s) return;
    s.pinned = pinned;
    this.invalidate();
  }

  closeSession(session?: Session): void {
    const s = session ?? this.active;
    if (!s) return;
    this.sessions = this.sessions.filter((x) => x.id !== s.id);
    if (this.activeId === s.id) this.activeId = this.sessions[0]?.id;
    this.invalidate();
  }

  clear(): void {
    this.cts?.cancel();
    this.sessions = [];
    this.activeId = undefined;
    this.message = undefined;
    this.loading = false;
    this.invalidate();
  }

  activate(session: Session): void {
    this.activeId = session.id;
    this.invalidate();
  }

  getGroupings(): Grouping[] {
    return [...this.groupings];
  }

  setGroupings(groupings: readonly Grouping[]): void {
    this.groupings = GROUPING_ORDER.filter((g) => groupings.includes(g));
    void this.memento.update(GROUPINGS_KEY, this.groupings);
    this.invalidate();
  }

  toggleGrouping(g: Grouping): void {
    this.setGroupings(this.groupings.includes(g) ? this.groupings.filter((x) => x !== g) : [...this.groupings, g]);
  }

  setFilters(filters: UsageFilters): void {
    this.filters = { kinds: [...filters.kinds], tests: filters.tests };
    for (const s of this.sessions) s.current = undefined;
    this.invalidate();
  }

  getFilters(): UsageFilters {
    return this.filters;
  }

  async pickGroupings(): Promise<void> {
    const picks = await vscode.window.showQuickPick(
      GROUPING_ORDER.map((g) => ({ label: GROUPING_TITLES[g], picked: this.groupings.includes(g), grouping: g })),
      { canPickMany: true, title: 'Refyntra Usages: Group By', placeHolder: 'Choose the groupings (none = a flat list)' },
    );
    if (picks) this.setGroupings(picks.map((p) => p.grouping));
  }

  async pickKinds(): Promise<void> {
    const s = this.active;
    const counts = new Map(kindCounts(s?.items ?? []).map((c) => [c.kind, c.count]));
    const kinds = (Object.keys(KIND_TITLES) as (UsageKind | 'tests')[]).filter((k): k is UsageKind => k !== 'tests');
    const picks = await vscode.window.showQuickPick(
      kinds.map((k) => ({ label: `$(${KIND_ICONS[k]}) ${KIND_TITLES[k]}`, description: `${counts.get(k) ?? 0}`, picked: this.filters.kinds.includes(k), usageKind: k })),
      { canPickMany: true, title: 'Refyntra Usages: Filter Usage Kinds', placeHolder: 'Show only these kinds (none checked = all kinds)' },
    );
    if (picks) this.setFilters({ ...this.filters, kinds: picks.length === kinds.length ? [] : picks.map((p) => p.usageKind) });
  }

  async pickTests(): Promise<void> {
    const items: { label: string; value: TestsFilter }[] = [
      { label: 'All usages', value: 'all' },
      { label: 'Only usages in tests', value: 'only' },
      { label: 'Exclude usages in tests', value: 'exclude' },
    ];
    const pick = await vscode.window.showQuickPick(items.map((i) => ({ ...i, description: i.value === this.filters.tests ? 'current' : undefined })), { title: 'Refyntra Usages: Tests' });
    if (pick) this.setFilters({ ...this.filters, tests: pick.value });
  }

  /** Next / previous usage of the active result (wraps); opens it and selects it in the view. */
  async step(direction: 1 | -1): Promise<UsageItem | undefined> {
    const s = this.active;
    if (!s) return undefined;
    const t = this.tree(s);
    const i = stepIndex(s.current, t.ordered.length, direction);
    if (i < 0) return undefined;
    s.current = i;
    const u = t.ordered[i]!;
    await openLocation({ uri: u.uri, range: u.range });
    if (this.view?.visible) {
      const leaf = this.findLeaf(s, i);
      if (leaf) await this.view.reveal(leaf, { select: true, focus: false }).then(undefined, () => undefined);
    }
    return u;
  }

  /** Markdown of the active result as shown (groupings and filters); opened in an untitled editor by the command. */
  markdown(): string | undefined {
    const s = this.active;
    if (!s) return undefined;
    return usagesToMarkdown({ subject: s.subject, total: s.total, truncated: s.truncated, items: s.items, groupings: this.groupings, filters: this.filters, roots: this.roots() });
  }

  async exportMarkdown(): Promise<void> {
    const md = this.markdown();
    if (!md) {
      void vscode.window.showInformationMessage('Refyntra Usages: nothing to export yet. Run Find Usages first.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  state(): UsagesViewState {
    const lines: string[] = [];
    const walk = (nodes: Node[], depth: number) => {
      for (const n of nodes) {
        const item = this.getTreeItem(n);
        const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
        lines.push(`${'  '.repeat(depth)}${label}${item.description ? ` — ${item.description}` : ''}`);
        walk(this.getChildren(n), depth + 1);
      }
    };
    walk(this.getChildren(), 0);
    return {
      loading: this.loading,
      ...(this.message ? { message: this.message } : {}),
      sessions: this.sessions.map((s) => ({ subject: s.subject, total: s.total, loaded: s.items.length, shown: this.tree(s).ordered.length, truncated: s.truncated, pinned: s.pinned, active: s.id === this.activeId })),
      groupings: [...this.groupings],
      filters: this.filters,
      lines,
    };
  }

  private findLeaf(s: Session, index: number): Node | undefined {
    const search = (nodes: UsageTreeNode<UsageItem>[]): UsageTreeNode<UsageItem> | undefined => {
      for (const n of nodes) {
        if (n.kind === 'usage' && n.index === index) return n;
        if (n.kind === 'group') {
          const f = search(n.children);
          if (f) return f;
        }
      }
      return undefined;
    };
    const leaf = search(this.tree(s).nodes);
    return leaf ? this.wrap(s, leaf) : undefined;
  }

  private wrap(s: Session, node: UsageTreeNode<UsageItem>): Node {
    const key = `${s.id}${node.id}`;
    let n = this.nodeById.get(key);
    if (!n) this.nodeById.set(key, (n = { kind: 'tree', session: s, node }));
    return n;
  }

  private sessionNode(s: Session): Node {
    const key = `session:${s.id}`;
    let n = this.nodeById.get(key);
    if (!n) this.nodeById.set(key, (n = { kind: 'session', session: s }));
    return n;
  }

  private updateContext(): void {
    const s = this.active;
    const shown = s ? this.tree(s).ordered.length : 0;
    void vscode.commands.executeCommand('setContext', 'refyntra.usagesHasResults', shown > 0);
    void vscode.commands.executeCommand('setContext', 'refyntra.usagesPinned', !!s?.pinned);
    void vscode.commands.executeCommand('setContext', 'refyntra.usagesFiltered', filtersActive(this.filters));
    for (const g of GROUPING_ORDER) void vscode.commands.executeCommand('setContext', `refyntra.usages.group.${g}`, this.groupings.includes(g));
  }

  private updateDescription(): void {
    if (!this.view) return;
    const s = this.active;
    const f = describeFilters(this.filters);
    this.view.description = [this.loading ? 'searching…' : undefined, s ? `${s.subject}` : undefined, s?.pinned ? 'pinned' : undefined, f].filter(Boolean).join(' · ') || undefined;
    this.view.message = s
      ? `${this.tree(s).ordered.length} of ${s.total} usages of ${s.subject}${s.truncated ? ' (more available)' : ''}${s.completeness !== 'complete' ? ' — some projects did not load completely' : ''}`
      : undefined;
  }

  getParent(node: Node): Node | undefined {
    if (node.kind !== 'tree') return node.kind === 'more' && this.sessions.length > 1 ? this.sessionNode(node.session) : undefined;
    const s = node.session;
    const find = (nodes: UsageTreeNode<UsageItem>[], parent: UsageTreeNode<UsageItem> | undefined): UsageTreeNode<UsageItem> | undefined | null => {
      for (const n of nodes) {
        if (n.id === node.node.id) return parent ?? null;
        if (n.kind === 'group') {
          const f = find(n.children, n);
          if (f !== undefined) return f;
        }
      }
      return undefined;
    };
    const p = find(this.tree(s).nodes, undefined);
    if (p) return this.wrap(s, p);
    return this.sessions.length > 1 ? this.sessionNode(s) : undefined;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const head: Node[] = [];
      if (this.loading) head.push({ kind: 'message', text: 'Searching for usages…', icon: 'loading~spin' });
      if (this.message) head.push({ kind: 'message', text: this.message, icon: this.message.startsWith('Error') ? 'warning' : 'info' });
      if (this.sessions.length > 1) return [...head, ...this.sessions.map((s) => this.sessionNode(s))];
      const s = this.sessions[0];
      return s ? [...head, ...this.sessionChildren(s)] : head;
    }
    if (node.kind === 'session') return this.sessionChildren(node.session);
    if (node.kind === 'tree' && node.node.kind === 'group') return node.node.children.map((c) => this.wrap(node.session, c));
    return [];
  }

  private sessionChildren(s: Session): Node[] {
    const t = this.tree(s);
    const nodes: Node[] = t.nodes.map((n) => this.wrap(s, n));
    if (t.ordered.length === 0) nodes.push({ kind: 'message', text: s.items.length === 0 ? `No usages of ${s.subject} found.` : 'No usages match the filters.', icon: 'info' });
    if (s.truncated) nodes.push({ kind: 'more', session: s });
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'session': {
        const s = node.session;
        const active = s.id === this.activeId;
        const item = new vscode.TreeItem(`Usages of ${s.subject}`, active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `session:${s.id}:${active ? 'a' : 'i'}`;
        item.description = [`${s.total}`, s.pinned ? 'pinned' : undefined, active ? 'active' : undefined].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(s.pinned ? 'pinned' : 'references');
        item.contextValue = 'refyntra.usagesSession';
        item.command = { command: 'refyntra.usages.activate', title: 'Make Active', arguments: [s] };
        item.accessibilityInformation = { label: `Usages of ${s.subject}, ${s.total} ${s.total === 1 ? 'usage' : 'usages'}${s.pinned ? ', pinned' : ''}${active ? ', active' : ''}` };
        return item;
      }
      case 'tree': {
        const n = node.node;
        if (n.kind === 'group') {
          const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
          item.id = `${node.session.id}${n.id}`;
          item.description = String(n.count);
          item.iconPath = new vscode.ThemeIcon(n.icon);
          item.contextValue = 'refyntra.usagesGroup';
          item.accessibilityInformation = { label: `${GROUPING_TITLES[n.grouping]} ${n.label}, ${n.count} ${n.count === 1 ? 'usage' : 'usages'}` };
          return item;
        }
        const u = n.usage;
        const rel = relativePath(u.uri, this.roots());
        const p = previewLabel(u.lineText, u.range.start.character, u.range.start.line === u.range.end.line ? u.range.end.character : u.lineText.length);
        const item = new vscode.TreeItem({ label: p.label || `${fileName(rel)}:${u.range.start.line + 1}`, highlights: p.highlights }, vscode.TreeItemCollapsibleState.None);
        item.id = `${node.session.id}${n.id}`;
        item.description = `${fileName(rel)}:${u.range.start.line + 1}`;
        item.iconPath = new vscode.ThemeIcon(KIND_ICONS[u.kind]);
        const md = new vscode.MarkdownString(undefined, false);
        md.appendText(usageDescription(u, rel));
        md.appendCodeblock(u.lineText.trim(), 'csharp');
        item.tooltip = md;
        item.accessibilityInformation = { label: `${usageDescription(u, fileName(rel))}: ${u.lineText.trim()}` };
        item.command = { command: 'refyntra.usages.open', title: 'Open', arguments: [node] };
        item.contextValue = 'refyntra.usage';
        return item;
      }
      case 'more': {
        const s = node.session;
        const item = new vscode.TreeItem(`Show more (${s.items.length} of ${s.total} loaded)`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.command = { command: 'refyntra.usages.showMore', title: 'Show More', arguments: [s] };
        item.accessibilityInformation = { label: `Action: show more usages, ${s.items.length} of ${s.total} loaded` };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.accessibilityInformation = { label: node.icon === 'warning' ? `Warning: ${node.text}` : node.text };
        return item;
      }
    }
  }

  /** Opening a usage from the tree also makes it the current one for Next/Previous. */
  async open(node: Node): Promise<void> {
    if (node.kind !== 'tree' || node.node.kind !== 'usage') return;
    node.session.current = node.node.index;
    if (this.activeId !== node.session.id) {
      this.activeId = node.session.id;
      this.invalidate();
    }
    const u = node.node.usage;
    await vscode.window.showTextDocument(vscode.Uri.parse(u.uri, true), { selection: fromRange(u.range), preview: true });
  }

  dispose(): void {
    this.cts?.cancel();
    this.cts?.dispose();
    this.changed.dispose();
  }
}

export function registerUsages(engine: EngineClient, memento: vscode.Memento): { provider: UsagesViewProvider; disposable: vscode.Disposable } {
  const provider = new UsagesViewProvider(engine, memento);
  const view = vscode.window.createTreeView(USAGES_VIEW, { treeDataProvider: provider, showCollapseAll: true });
  provider.attach(view);
  const subs: vscode.Disposable[] = [
    provider,
    view,
    vscode.commands.registerCommand('refyntra.findUsages', () => provider.find()),
    vscode.commands.registerCommand('refyntra.usages.next', () => provider.step(1)),
    vscode.commands.registerCommand('refyntra.usages.previous', () => provider.step(-1)),
    vscode.commands.registerCommand('refyntra.usages.groupBy', () => provider.pickGroupings()),
    vscode.commands.registerCommand('refyntra.usages.filterKinds', () => provider.pickKinds()),
    vscode.commands.registerCommand('refyntra.usages.filterTests', () => provider.pickTests()),
    vscode.commands.registerCommand('refyntra.usages.clearFilters', () => provider.setFilters(NO_FILTERS)),
    vscode.commands.registerCommand('refyntra.usages.export', () => provider.exportMarkdown()),
    vscode.commands.registerCommand('refyntra.usages.pin', () => provider.setPinned(true)),
    vscode.commands.registerCommand('refyntra.usages.unpin', () => provider.setPinned(false)),
    vscode.commands.registerCommand('refyntra.usages.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('refyntra.usages.clear', () => provider.clear()),
    vscode.commands.registerCommand('refyntra.usages.showMore', (s?: Parameters<UsagesViewProvider['showMore']>[0]) => provider.showMore(s)),
    vscode.commands.registerCommand('refyntra.usages.closeSession', (n?: { kind: string; session?: Parameters<UsagesViewProvider['closeSession']>[0] }) => provider.closeSession(n?.session)),
    vscode.commands.registerCommand('refyntra.usages.activate', (s: Parameters<UsagesViewProvider['activate']>[0]) => provider.activate(s)),
    vscode.commands.registerCommand('refyntra.usages.open', (n: Parameters<UsagesViewProvider['open']>[0]) => provider.open(n)),
  ];
  for (const g of GROUPING_ORDER) {
    subs.push(vscode.commands.registerCommand(`refyntra.usages.group.${g}`, () => provider.toggleGrouping(g)));
    subs.push(vscode.commands.registerCommand(`refyntra.usages.ungroup.${g}`, () => provider.toggleGrouping(g)));
  }
  return { provider, disposable: vscode.Disposable.from(...subs) };
}
