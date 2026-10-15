import * as vscode from 'vscode';
import { CancelledError, type EngineClient, type RelatedOutcome } from '@refyntra/application';
import type { Location, SymbolRef } from '@refyntra/contracts';
import { type FindItem, type MergedRelation, endpointLabel } from '@refyntra/domain';
import { fromPosition } from './convert';
import {
  type Candidate,
  type Descriptor,
  type FileRef,
  type Mutation,
  type Resolution,
  type ResolutionStatus,
  SHARED_TASK_CONTEXT_FOLDER,
  STATUS_WORD,
  TASK_CONTEXT_LIMITS,
  TASK_CONTEXT_STORAGE_KEY,
  type TaskContext,
  type TaskContextStore,
  type TaskItem,
  activeContext,
  branchOfHead,
  gitDirOfFile,
  addItem,
  clearItems,
  combineStatus,
  contextForBranch,
  contextToMarkdown,
  createContext,
  decideEndpoint,
  decideFile,
  decideLocation,
  decideSymbol,
  deleteContext,
  displayPath,
  emptyStore,
  fileKey,
  importContexts,
  itemTitle,
  lineAt,
  lineCountOf,
  lineFingerprint,
  linesWithFingerprint,
  loadStore,
  moveItem,
  sharedFileName,
  moveItemsTo,
  removeItem,
  renameContext,
  renameFileRefs,
  replaceWord,
  setNote,
  switchContext,
  toExportFile,
  updateDescriptor,
} from './taskContextModel';
import { relationKindLabel } from './terminology';

// Task context view: named lists of symbols, files, endpoints and pinned relations for the task at hand.
// Stored per workspace in workspaceState (local only, never synced, no telemetry). Items are descriptors that are
// resolved again on open and after edits (taskContextModel.ts has the decision table); they are not symbol ids.

export const TASK_CONTEXT_VIEW = 'refyntra.taskContextView';
const DND_MIME = 'application/vnd.code.tree.refyntra.taskcontextview';
const RESOLVE_DEBOUNCE_MS = 800;

type Node = { kind: 'item'; item: TaskItem } | { kind: 'note'; item: TaskItem };

export interface ItemState {
  status: ResolutionStatus;
  reason?: string;
  /** Ambiguous: what the user can choose from (for the target or, for a relation, the subject). */
  candidates?: Candidate[];
  candidatesFor?: 'target' | 'subject';
}

/** Test seams (e2e): replace the input box, the QuickPick and the confirmations. Production never sets them. */
export interface TaskContextTestHooks {
  input?: (prompt: string, value?: string) => string | undefined;
  pick?: (labels: string[]) => number | undefined;
  confirm?: (message: string) => boolean;
}

let idCounter = 0;
function newId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function multiRoot(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

/** Workspace-relative when inside a folder (no machine path is stored for workspace files). */
export function fileRefOf(uri: vscode.Uri): FileRef {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder && uri.scheme === 'file') {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const inFolder = multiRoot() && rel.startsWith(`${folder.name}/`) ? rel.slice(folder.name.length + 1) : rel;
    if (!inFolder.split('/').includes('..')) return { folder: folder.name, path: inFolder };
  }
  return { uri: uri.toString() };
}

export function uriOf(f: FileRef | undefined): vscode.Uri | undefined {
  if (!f) return undefined;
  if ('uri' in f) {
    try {
      const u = vscode.Uri.parse(f.uri, true);
      return u.scheme === 'file' ? u : undefined;
    } catch {
      return undefined;
    }
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((x) => x.uri.scheme === 'file');
  // An import from another machine may name another folder: a single-folder workspace takes it.
  const folder = folders.find((x) => x.name === f.folder) ?? (folders.length === 1 ? folders[0] : undefined);
  return folder ? vscode.Uri.joinPath(folder.uri, ...f.path.split('/')) : undefined;
}

/** Current text: the editor buffer when open (unsaved edits count), else the file on disk. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

/** Persistence: one JSON value in workspaceState. A store written by a newer Refyntra is left untouched (read-only). */
export class TaskContextStorage {
  private store: TaskContextStore = emptyStore();
  readOnlyVersion: number | undefined;
  dropped = 0;

  constructor(private readonly memento: vscode.Memento) {
    this.reload();
  }

  reload(): void {
    const r = loadStore(this.memento.get<unknown>(TASK_CONTEXT_STORAGE_KEY));
    if (r.kind === 'newer') {
      this.readOnlyVersion = r.version;
      this.store = emptyStore();
      return;
    }
    this.readOnlyVersion = undefined;
    this.store = r.store;
    this.dropped = r.dropped;
  }

  get value(): TaskContextStore {
    return this.store;
  }

  async set(store: TaskContextStore): Promise<void> {
    this.store = store;
    if (this.readOnlyVersion !== undefined) return;
    await this.memento.update(TASK_CONTEXT_STORAGE_KEY, store);
  }
}

export class TaskContextViewProvider implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dropMimeTypes = [DND_MIME];
  readonly dragMimeTypes = [DND_MIME];
  readonly storage: TaskContextStorage;
  private readonly states = new Map<string, ItemState>();
  private view: vscode.TreeView<Node> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private running: Promise<void> | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private lastReady = '';
  testHooks: TaskContextTestHooks = {};
  /** e2e: the last message shown to the user. */
  lastMessage: string | undefined;

  constructor(
    private readonly engine: EngineClient,
    memento: vscode.Memento,
    private readonly related: { current(): RelatedOutcome | undefined; showForActiveEditor(): Promise<void> },
  ) {
    this.storage = new TaskContextStorage(memento);
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length > 0 && this.affects(e.document.uri) && this.schedule()),
      vscode.workspace.onDidSaveTextDocument((d) => this.affects(d.uri) && this.schedule()),
      vscode.workspace.onDidDeleteFiles(() => this.schedule()),
      vscode.workspace.onDidCreateFiles(() => this.schedule()),
      vscode.workspace.onDidRenameFiles((e) => void this.followRenames(e.files)),
      engine.onDidInvalidate(() => this.schedule()),
      engine.onDidChangeHealth((h) => {
        // A route that becomes ready resolves the items that waited for it ("not checked yet").
        const ready = h.adapters.filter((a) => a.state === 'Ready' || a.state === 'Partial').map((a) => a.providerRouteId).sort().join(',');
        if (ready === this.lastReady) return;
        this.lastReady = ready;
        this.schedule();
      }),
    );
    void this.updateContextKeys();
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.subs.push(view.onDidChangeVisibility((e) => e.visible && this.schedule(0)));
    this.updateDescription();
    this.schedule(0);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // State

  get store(): TaskContextStore {
    return this.storage.value;
  }

  active(): TaskContext | undefined {
    return activeContext(this.store);
  }

  stateOf(itemId: string): ItemState | undefined {
    return this.states.get(itemId);
  }

  /** e2e: re-read workspaceState as a fresh window would (the stored value is the only state that survives). */
  async reloadFromStorage(): Promise<void> {
    this.states.clear();
    this.storage.reload();
    this.refreshUi();
    await this.resolveNow();
  }

  private async apply(r: Mutation | TaskContextStore): Promise<boolean> {
    if ('ok' in r) {
      if (!r.ok) {
        this.say(r.message, 'warning');
        return false;
      }
      r = r.store;
    }
    if (this.storage.readOnlyVersion !== undefined) {
      this.say(`Task contexts were saved by a newer Refyntra (version ${this.storage.readOnlyVersion}); they are not changed by this version.`, 'warning');
      return false;
    }
    await this.storage.set(r);
    this.refreshUi();
    return true;
  }

  private refreshUi(): void {
    this.updateDescription();
    void this.updateContextKeys();
    this.changed.fire(undefined);
  }

  private async updateContextKeys(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'refyntra.taskContextActive', this.active() !== undefined);
  }

  private updateDescription(): void {
    if (!this.view) return;
    const ctx = this.active();
    if (!ctx) {
      this.view.description = undefined;
      return;
    }
    const attention = ctx.items.filter((i) => {
      const s = this.states.get(i.id)?.status;
      return s === 'ambiguous' || s === 'missing';
    }).length;
    this.view.description = attention ? `${ctx.name} · ${attention} need attention` : ctx.name;
  }

  private say(message: string, level: 'info' | 'warning' = 'info'): void {
    this.lastMessage = message;
    if (level === 'warning') void vscode.window.showWarningMessage(`Refyntra Task Context: ${message}`);
    else void vscode.window.showInformationMessage(`Refyntra Task Context: ${message}`);
  }

  private async input(prompt: string, value?: string): Promise<string | undefined> {
    if (this.testHooks.input) return this.testHooks.input(prompt, value);
    return vscode.window.showInputBox({ prompt, value, validateInput: (v) => (v.length > TASK_CONTEXT_LIMITS.nameLength ? `At most ${TASK_CONTEXT_LIMITS.nameLength} characters.` : undefined) });
  }

  private async pick<T extends vscode.QuickPickItem>(items: T[], placeHolder: string): Promise<T | undefined> {
    if (this.testHooks.pick) {
      const i = this.testHooks.pick(items.map((x) => x.label));
      return i === undefined ? undefined : items[i];
    }
    return vscode.window.showQuickPick(items, { placeHolder });
  }

  private async confirm(message: string, action: string): Promise<boolean> {
    if (this.testHooks.confirm) return this.testHooks.confirm(message);
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Contexts

  async newContext(name?: string): Promise<boolean> {
    const n = name ?? (await this.input('Name of the new task context', 'Task'));
    if (n === undefined) return false;
    return this.apply(createContext(this.store, n.trim() || 'Task', newId(), Date.now()));
  }

  /** Makes sure a context is active before something is added (creates "Task" when there is none). */
  private async ensureActive(): Promise<boolean> {
    if (this.active()) return true;
    return this.apply(createContext(this.store, 'Task', newId(), Date.now()));
  }

  async switchContext(id?: string): Promise<void> {
    let target = id;
    if (!target) {
      const items = this.store.contexts.map((c) => ({ label: c.name, description: `${c.items.length} items${c.id === this.store.activeId ? ' · active' : ''}`, id: c.id }));
      if (items.length === 0) {
        await this.newContext();
        return;
      }
      target = (await this.pick(items, 'Switch to task context'))?.id;
    }
    if (!target) return;
    this.states.clear();
    await this.apply(switchContext(this.store, target));
    this.schedule(0);
  }

  async renameContext(name?: string): Promise<void> {
    const ctx = this.active();
    if (!ctx) return;
    const n = name ?? (await this.input('New name of the task context', ctx.name));
    if (n === undefined) return;
    await this.apply(renameContext(this.store, ctx.id, n));
  }

  async deleteContext(): Promise<void> {
    const ctx = this.active();
    if (!ctx) return;
    if (!(await this.confirm(`Delete the task context "${ctx.name}" with ${ctx.items.length} items? This cannot be undone.`, 'Delete'))) return;
    this.states.clear();
    await this.apply(deleteContext(this.store, ctx.id));
    this.schedule(0);
  }

  async clear(): Promise<void> {
    const ctx = this.active();
    if (!ctx || ctx.items.length === 0) return;
    if (!(await this.confirm(`Remove all ${ctx.items.length} items from "${ctx.name}"?`, 'Clear'))) return;
    this.states.clear();
    await this.apply(clearItems(this.store));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Adding

  private async add(item: TaskItem): Promise<TaskItem | undefined> {
    if (!(await this.ensureActive())) return undefined;
    const r = addItem(this.store, item);
    if (!r.ok) {
      this.say(r.message, 'warning');
      return undefined;
    }
    if (!r.added) {
      this.say(`"${itemTitle(item)}" is already in "${this.active()!.name}".`);
      return this.active()!.items.find((x) => x.target.name === item.target.name && x.kind === item.kind);
    }
    await this.apply(r.store);
    this.states.set(item.id, { status: 'resolved' });
    this.say(`Added "${itemTitle(item)}" to "${this.active()!.name}".`);
    this.changed.fire(undefined);
    return item;
  }

  /** "Add Symbol at Cursor": the symbol the language route reports at the cursor (any route: C#, TS/JS, Python, Rust). */
  async addSymbolAtCursor(): Promise<TaskItem | undefined> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') {
      this.say('open a file and place the cursor on a symbol.');
      return undefined;
    }
    let outcome: RelatedOutcome;
    try {
      outcome = await this.engine.related({ uri: ed.document.uri.toString(), position: { line: ed.selection.active.line, character: ed.selection.active.character } });
    } catch (e) {
      this.say(`no symbol could be read at the cursor (${e instanceof Error ? e.message : String(e)}).`, 'warning');
      return undefined;
    }
    if (outcome.kind !== 'related' || !outcome.subject) {
      this.say(outcome.kind === 'unavailable' ? outcome.message : 'no symbol at the cursor.', 'warning');
      return undefined;
    }
    const d = await this.symbolDescriptor(outcome.subject, outcome.providerRouteId);
    if (!d) return undefined;
    return this.add({ id: newId(), kind: 'symbol', target: d, createdAt: Date.now() });
  }

  async addFile(arg?: unknown): Promise<TaskItem | undefined> {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      this.say('open a file or choose one in the Explorer.');
      return undefined;
    }
    const file = fileRefOf(uri);
    const name = uri.path.split('/').pop() || uri.path;
    return this.add({ id: newId(), kind: 'file', target: { kind: 'file', name, file }, createdAt: Date.now() });
  }

  /** From Find: a symbol, an endpoint or a client call. */
  async addFindItem(it: FindItem | undefined): Promise<TaskItem | undefined> {
    if (!it?.location) {
      this.say('this result has no place in the source and cannot be added.');
      return undefined;
    }
    let d: Descriptor | undefined;
    if (it.kind === 'symbol' && it.symbol) d = await this.symbolDescriptor(it.symbol, it.providerRouteId);
    else if (it.kind === 'endpoint' && it.endpoint) d = await this.endpointDescriptor(it.endpoint.httpMethods, it.endpoint.route, it.endpoint.location, it.providerRouteId);
    else d = await this.locationDescriptor(it.label, it.location);
    if (!d) return undefined;
    return this.add({ id: newId(), kind: d.kind, target: d, createdAt: Date.now() });
  }

  /** From Related: a relation node pins subject + relation + target; without a node the subject is added. */
  async addFromRelated(node?: { kind?: string; relation?: MergedRelation }): Promise<TaskItem | undefined> {
    const outcome = this.related.current();
    if (outcome?.kind !== 'related' || !outcome.subject) {
      this.say('Related shows no symbol yet. Open Related on a symbol first.');
      return undefined;
    }
    const subject = await this.symbolDescriptor(outcome.subject, outcome.providerRouteId);
    if (!subject) return undefined;
    const r = node?.kind === 'relation' ? node.relation : undefined;
    if (!r) return this.add({ id: newId(), kind: 'symbol', target: subject, createdAt: Date.now() });
    const target = await this.relationTargetDescriptor(r, outcome.providerRouteId);
    if (!target) return undefined;
    return this.add({ id: newId(), kind: 'relation', subject, relationKind: relationKindLabel(r.relationKind), target, createdAt: Date.now() });
  }

  private async relationTargetDescriptor(r: MergedRelation, fallbackRoute: string): Promise<Descriptor | undefined> {
    const t = r.target;
    if (t.symbol) {
      if (t.symbol.location) return this.symbolDescriptor(t.symbol, t.symbol.provenance?.providerRouteId ?? r.provenances[0]?.providerRouteId ?? fallbackRoute);
      // A library symbol (no source): kept by name; there is nothing to resolve or open.
      return { kind: 'symbol', name: t.symbol.name, qualifiedName: t.symbol.displayName, symbolKind: t.symbol.kind, ...(t.symbol.containerName ? { container: t.symbol.containerName } : {}) };
    }
    if (t.endpoint) return this.endpointDescriptor(t.endpoint.httpMethods, t.endpoint.route, t.endpoint.location, r.provenances[0]?.providerRouteId ?? fallbackRoute);
    const loc = t.location ?? t.registration?.location;
    if (loc) return this.locationDescriptor(t.label, loc);
    this.say(`"${t.label}" has no place in the source and cannot be pinned.`, 'warning');
    return undefined;
  }

  private async placeOf(loc: Location): Promise<{ file: FileRef; position: { line: number; character: number }; fingerprint?: string; lineCount?: number } | undefined> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(loc.uri, true);
    } catch {
      return undefined;
    }
    if (uri.scheme !== 'file') return undefined;
    const text = await readText(uri);
    const position = { line: loc.range.start.line, character: loc.range.start.character };
    const line = text === undefined ? undefined : lineAt(text, position.line);
    return { file: fileRefOf(uri), position, ...(line !== undefined ? { fingerprint: lineFingerprint(line) } : {}), ...(text !== undefined ? { lineCount: lineCountOf(text) } : {}) };
  }

  private async symbolDescriptor(s: SymbolRef, route: string): Promise<Descriptor | undefined> {
    if (!s.location) {
      this.say(`${s.name} has no source location (it comes from a library) and cannot be added.`, 'warning');
      return undefined;
    }
    const p = await this.placeOf(s.location);
    if (!p) {
      this.say(`${s.name} is not in a local file and cannot be added.`, 'warning');
      return undefined;
    }
    return { kind: 'symbol', route: this.languageRoute(route), symbolKind: s.kind, name: s.name, qualifiedName: s.displayName, ...(s.containerName ? { container: s.containerName } : {}), ...p };
  }

  private async endpointDescriptor(methods: string[], route: string, loc: Location, providerRoute: string): Promise<Descriptor | undefined> {
    const p = await this.placeOf(loc);
    if (!p) return undefined;
    const name = endpointLabel({ httpMethods: methods, route, routeIsDynamic: false, location: loc, kind: 'minimal-api' });
    return { kind: 'endpoint', route: this.languageRoute(providerRoute), name, endpoint: { methods: [...methods], route }, ...p };
  }

  private async locationDescriptor(label: string, loc: Location): Promise<Descriptor | undefined> {
    const p = await this.placeOf(loc);
    if (!p) {
      this.say(`"${label}" is not in a local file and cannot be added.`, 'warning');
      return undefined;
    }
    return { kind: 'location', name: label.slice(0, TASK_CONTEXT_LIMITS.nameLength), ...p };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Item actions

  private itemOf(arg: unknown): TaskItem | undefined {
    if (arg && typeof arg === 'object' && 'item' in arg) return (arg as Node).item;
    if (typeof arg === 'string') return this.active()?.items.find((i) => i.id === arg);
    // Keyboard from the Command Palette: the selected item of the view.
    const sel = this.view?.selection[0];
    return sel?.item;
  }

  async remove(arg?: unknown): Promise<void> {
    const item = this.itemOf(arg);
    if (!item) return;
    this.states.delete(item.id);
    await this.apply(removeItem(this.store, item.id));
  }

  async move(arg: unknown, delta: number): Promise<void> {
    const item = this.itemOf(arg);
    if (!item) return;
    if (await this.apply(moveItem(this.store, item.id, delta))) await this.reveal(item);
  }

  private async reveal(item: TaskItem): Promise<void> {
    try {
      await this.view?.reveal({ kind: 'item', item }, { select: true, focus: true });
    } catch {
      // The view is hidden: nothing to reveal.
    }
  }

  async editNote(arg?: unknown, text?: string): Promise<void> {
    const item = this.itemOf(arg);
    if (!item) return;
    const n = text ?? (this.testHooks.input ? this.testHooks.input('Note', item.note) : await vscode.window.showInputBox({ prompt: `Note for ${itemTitle(item)} (empty removes it)`, value: item.note ?? '', validateInput: (v) => (v.length > TASK_CONTEXT_LIMITS.noteLength ? `At most ${TASK_CONTEXT_LIMITS.noteLength} characters.` : undefined) }));
    if (n === undefined) return;
    await this.apply(setNote(this.store, item.id, n));
  }

  /** Opens an item. It is resolved again first: an old line number is never opened. */
  async open(arg?: unknown): Promise<'opened' | 'ambiguous' | 'missing' | 'pending' | 'none'> {
    const item = this.itemOf(arg);
    if (!item) return 'none';
    await this.resolveNow();
    const fresh = this.active()?.items.find((i) => i.id === item.id);
    if (!fresh) return 'none';
    const st = this.states.get(fresh.id);
    if (st?.status === 'ambiguous') {
      if (!(await this.choose(fresh))) return 'ambiguous';
    } else if (st?.status === 'missing') {
      this.say(`${itemTitle(fresh)} is missing: ${st.reason ?? 'not found'}. The item is kept; remove it or choose another symbol.`, 'warning');
      return 'missing';
    }
    const now = this.active()?.items.find((i) => i.id === item.id) ?? fresh;
    const d = now.kind === 'relation' ? now.target : now.target;
    const uri = uriOf(d.file) ?? (now.subject ? uriOf(now.subject.file) : undefined);
    if (!uri) {
      this.say(`${itemTitle(now)} has no place in the source to open.`);
      return 'none';
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = fromPosition(d.position ?? { line: 0, character: 0 });
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    return st?.status === 'pending' ? 'pending' : 'opened';
  }

  /** Show Related for the item (for a relation: its subject). */
  async showRelated(arg?: unknown): Promise<void> {
    const item = this.itemOf(arg);
    if (!item) return;
    if (item.kind === 'relation') {
      const subjectOnly: TaskItem = { ...item, kind: 'symbol', target: item.subject! };
      delete subjectOnly.subject;
      const st = this.states.get(item.id);
      if (st?.status === 'missing') {
        this.say(`${itemTitle(item)} is missing: ${st.reason ?? 'not found'}.`, 'warning');
        return;
      }
      const uri = uriOf(subjectOnly.target.file);
      if (!uri) return;
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = fromPosition(subjectOnly.target.position ?? { line: 0, character: 0 });
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    } else if ((await this.open(item)) !== 'opened') return;
    await vscode.commands.executeCommand('refyntra.relatedView.focus');
    await this.related.showForActiveEditor();
  }

  /** Ambiguous: the user chooses the right symbol (or keeps the item unresolved). */
  async choose(arg?: unknown): Promise<boolean> {
    const item = this.itemOf(arg);
    const ctx = this.active();
    if (!item || !ctx) return false;
    const st = this.states.get(item.id);
    if (st?.status !== 'ambiguous' || !st.candidates?.length) return false;
    const mr = multiRoot();
    const picks = st.candidates.map((c) => ({
      label: c.qualifiedName ?? c.name,
      description: [c.symbolKind, c.container ? `in ${c.container}` : undefined].filter(Boolean).join(' '),
      detail: `${displayPath(c.file, mr) ?? ''}:${c.position.line + 1}`,
      candidate: c,
    }));
    const chosen = await this.pick(picks, `${itemTitle(item)}: ${st.reason ?? 'choose the symbol'}`);
    if (!chosen) return false;
    const part = st.candidatesFor ?? 'target';
    const old = part === 'subject' ? item.subject! : item.target;
    const c = chosen.candidate;
    const next: Descriptor = { ...old, name: c.name, file: c.file, position: c.position };
    if (c.qualifiedName) next.qualifiedName = c.qualifiedName;
    if (c.symbolKind) next.symbolKind = c.symbolKind;
    if (c.container) next.container = c.container;
    else delete next.container;
    if (c.fingerprint) next.fingerprint = c.fingerprint;
    if (c.lineCount !== undefined) next.lineCount = c.lineCount;
    await this.apply(updateDescriptor(this.store, ctx.id, item.id, part, next));
    this.states.set(item.id, { status: 'resolved', reason: 'chosen by you' });
    this.schedule();
    this.refreshUi();
    return true;
  }

  async copyMarkdown(): Promise<string | undefined> {
    const ctx = this.active();
    if (!ctx) return undefined;
    const md = contextToMarkdown(ctx, multiRoot(), (i) => this.states.get(i.id)?.status);
    await vscode.env.clipboard.writeText(md);
    this.say(`copied "${ctx.name}" as Markdown (names, relative paths and notes; no source code).`);
    return md;
  }

  async exportTo(target?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const ctx = this.active();
    if (!ctx) return undefined;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const safe = ctx.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'task';
    const uri = target ?? (await vscode.window.showSaveDialog({ title: 'Export Task Context', saveLabel: 'Export', filters: { JSON: ['json'] }, ...(folder ? { defaultUri: vscode.Uri.joinPath(folder, `${safe}.refyntra-context.json`) } : {}) }));
    if (!uri) return undefined;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${JSON.stringify(toExportFile([ctx]), null, 2)}\n`));
    this.say(`exported "${ctx.name}".`);
    return uri;
  }

  /** Writes the active context to .refyntra/task-contexts/<name>.json in the workspace: shared with the team through the repository. */
  async share(): Promise<vscode.Uri | undefined> {
    const ctx = this.active();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ctx || !folder) {
      this.say(ctx ? 'open a folder first.' : 'no task context is active.', 'warning');
      return undefined;
    }
    const dir = vscode.Uri.joinPath(folder, ...SHARED_TASK_CONTEXT_FOLDER.split('/'));
    await vscode.workspace.fs.createDirectory(dir);
    const uri = await this.exportTo(vscode.Uri.joinPath(dir, sharedFileName(ctx.name)));
    if (uri) this.say(`"${ctx.name}" is in ${SHARED_TASK_CONTEXT_FOLDER}; commit it to share it with your team (it holds file paths, symbol names and notes, no code).`);
    return uri;
  }

  /** The contexts shared in the repository (.refyntra/task-contexts/*.json). */
  async sharedFiles(): Promise<vscode.Uri[]> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) return [];
    const dir = vscode.Uri.joinPath(folder, ...SHARED_TASK_CONTEXT_FOLDER.split('/'));
    try {
      return (await vscode.workspace.fs.readDirectory(dir)).filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json')).map(([n]) => vscode.Uri.joinPath(dir, n));
    } catch {
      return [];
    }
  }

  /** On a checkout: the context of the new branch becomes active (created for it when there is none). */
  async followBranch(branch: string | undefined): Promise<void> {
    if (!branch || !vscode.workspace.getConfiguration('refyntra').get<boolean>('taskContext.followBranch', true)) return;
    const r = contextForBranch(this.store, branch, newId(), Date.now());
    if (!r.ok || activeContext(r.store)?.id === this.store.activeId) return;
    this.states.clear();
    await this.apply(r);
    this.schedule(0);
  }

  async importFrom(source?: vscode.Uri): Promise<string[]> {
    let picked = source;
    if (!picked) {
      const shared = await this.sharedFiles();
      if (shared.length) {
        const choice = await vscode.window.showQuickPick(
          [...shared.map((u) => ({ label: `$(repo) ${u.path.split('/').pop()}`, description: SHARED_TASK_CONTEXT_FOLDER, uri: u as vscode.Uri | undefined })), { label: '$(folder-opened) Browse…', description: 'another file', uri: undefined }],
          { title: 'Import Task Context' },
        );
        if (!choice) return [];
        picked = choice.uri;
      }
    }
    const uri = picked ?? (await vscode.window.showOpenDialog({ title: 'Import Task Context', openLabel: 'Import', canSelectMany: false, filters: { JSON: ['json'] } }))?.[0];
    if (!uri) return [];
    let text: string;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > TASK_CONTEXT_LIMITS.importBytes) {
        this.say('the file is too large for a task context export.', 'warning');
        return [];
      }
      text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)).replace(/^﻿/, '');
    } catch (e) {
      this.say(`the file could not be read (${e instanceof Error ? e.message : String(e)}).`, 'warning');
      return [];
    }
    const r = importContexts(this.store, text, newId);
    if (!r.ok) {
      this.say(r.message, 'warning');
      return [];
    }
    this.states.clear();
    await this.apply(r.store);
    this.say(`imported ${r.imported.map((n) => `"${n}"`).join(', ')}${r.dropped ? ` (${r.dropped} invalid entries skipped)` : ''}.`);
    this.schedule(0);
    return r.imported;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Resolution

  private affects(uri: vscode.Uri): boolean {
    const ctx = this.active();
    if (!ctx || uri.scheme !== 'file') return false;
    const k = fileKey(fileRefOf(uri));
    // Any C#/TS/Python/Rust edit can move a symbol to another file: edits in item files and in code files count.
    return ctx.items.some((i) => fileKey(i.target.file) === k || fileKey(i.subject?.file) === k) || this.engine.handlesDocument(uri.toString());
  }

  private schedule(delay = RESOLVE_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.active()?.items.length) return;
    this.timer = setTimeout(() => void this.resolveNow(), delay);
  }

  /** Resolves every item of the active context (a newer run cancels an older one). */
  async resolveNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.cts?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.cts = source;
    const previous = this.running;
    const run = (async () => {
      await previous?.catch(() => undefined);
      if (source.token.isCancellationRequested) return;
      await this.resolveAll(source.token);
    })();
    this.running = run;
    try {
      await run;
    } finally {
      if (this.cts === source) {
        this.cts = undefined;
        source.dispose();
      }
    }
  }

  private async resolveAll(token: vscode.CancellationToken): Promise<void> {
    const ctx = this.active();
    if (!ctx) return;
    for (const item of ctx.items) {
      if (token.isCancellationRequested) return;
      try {
        await this.resolveItem(ctx.id, item, token);
      } catch (e) {
        if (e instanceof CancelledError || token.isCancellationRequested) return;
        this.states.set(item.id, { status: 'pending', reason: `could not be checked (${e instanceof Error ? e.message : String(e)})` });
      }
    }
    this.refreshUi();
  }

  private async resolveItem(contextId: string, item: TaskItem, token: vscode.CancellationToken): Promise<void> {
    const t = await this.resolveDescriptor(item.target, token);
    let store = this.store;
    let changed = false;
    if (t.status === 'resolved' || t.status === 'moved') {
      if (JSON.stringify(t.descriptor) !== JSON.stringify(item.target)) {
        store = updateDescriptor(store, contextId, item.id, 'target', t.descriptor);
        changed = true;
      }
    }
    let state: ItemState = stateOf(t, 'target');
    if (item.kind === 'relation' && item.subject) {
      const s = await this.resolveDescriptor(item.subject, token);
      if ((s.status === 'resolved' || s.status === 'moved') && JSON.stringify(s.descriptor) !== JSON.stringify(item.subject)) {
        store = updateDescriptor(store, contextId, item.id, 'subject', s.descriptor);
        changed = true;
      }
      const combined = combineStatus(t.status, s.status);
      const worse = combined === t.status ? state : stateOf(s, 'subject');
      const reasons = [t.status !== 'resolved' && 'reason' in t && t.reason ? `target: ${t.reason}` : undefined, s.status !== 'resolved' && 'reason' in s && s.reason ? `subject: ${s.reason}` : undefined].filter(Boolean);
      state = { ...worse, status: combined, ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
    }
    if (token.isCancellationRequested) return;
    if (changed && this.storage.readOnlyVersion === undefined) await this.storage.set(store);
    this.states.set(item.id, state);
  }

  /** A module route ("csharp.roslyn/di") belongs to its language route ("csharp.roslyn"): that one is asked again. */
  private languageRoute(route: string): string {
    const a = this.engine.health().adapters.find((x) => route === x.providerRouteId || route.startsWith(`${x.providerRouteId}/`));
    return a?.providerRouteId ?? route;
  }

  private routeReady(route: string | undefined): boolean {
    const h = this.engine.health();
    if (!route) return false;
    const r = this.languageRoute(route);
    const a = h.adapters.find((x) => x.providerRouteId === r);
    if (!a) return false;
    return a.state === 'Ready' || a.state === 'Partial';
  }

  private async resolveDescriptor(d: Descriptor, token: vscode.CancellationToken): Promise<Resolution> {
    if (d.kind === 'symbol' && !d.file) return { status: 'resolved', descriptor: d, reason: 'from a library (not in the source)' };
    const uri = uriOf(d.file);
    const text = uri ? await readText(uri) : undefined;
    const fileExists = text !== undefined;
    const line = text !== undefined && d.position ? lineAt(text, d.position.line) : undefined;
    const exactLine = line !== undefined && d.fingerprint !== undefined && lineFingerprint(line) === d.fingerprint;
    const lineCount = text !== undefined ? lineCountOf(text) : undefined;
    switch (d.kind) {
      case 'file':
        return decideFile(d, fileExists);
      case 'location': {
        const sameLines = text !== undefined && d.fingerprint && !exactLine ? linesWithFingerprint(text, d.fingerprint, 10).map((l) => ({ name: d.name, file: d.file!, position: { line: l, character: d.position?.character ?? 0 }, fingerprint: d.fingerprint! })) : [];
        return decideLocation(d, { fileExists, exactLine, sameLines });
      }
      case 'endpoint': {
        const ready = this.routeReady(d.route);
        const candidates = !exactLine && ready && d.endpoint ? await this.endpointCandidates(d, token) : [];
        return decideEndpoint(d, { routeReady: ready, exactLine, candidates });
      }
      case 'symbol': {
        if (exactLine) return decideSymbol(d, { routeReady: true, fileExists, exactLine, candidates: [], ...(lineCount !== undefined ? { lineCount } : {}) });
        const ready = this.routeReady(d.route);
        if (!ready) return decideSymbol(d, { routeReady: false, fileExists, exactLine, candidates: [] });
        const candidates = await this.symbolCandidates(d, token);
        if (uri && text !== undefined && d.fingerprint) candidates.push(...(await this.sameLineCandidates(d, uri, text, token)));
        const renamedAt = uri && text !== undefined && line !== undefined ? await this.renamedAt(d, uri, line, text, token) : undefined;
        return decideSymbol(d, { routeReady: true, fileExists, exactLine, candidates, ...(renamedAt ? { renamedAt } : {}), ...(lineCount !== undefined ? { lineCount } : {}) });
      }
    }
  }

  private async candidateOf(s: SymbolRef): Promise<Candidate | undefined> {
    if (!s.location) return undefined;
    const p = await this.placeOf(s.location);
    if (!p) return undefined;
    return { name: s.name, qualifiedName: s.displayName, symbolKind: s.kind, ...(s.containerName ? { container: s.containerName } : {}), ...p };
  }

  /** Find on the same route by the simple name: every result with that name (any kind, any container). */
  private async symbolCandidates(d: Descriptor, token: vscode.CancellationToken): Promise<Candidate[]> {
    const r = await this.engine.find(d.name, token, 100);
    const out: Candidate[] = [];
    for (const it of r.items) {
      if (it.kind !== 'symbol' || !it.symbol || this.languageRoute(it.providerRouteId) !== d.route || it.symbol.name !== d.name) continue;
      const c = await this.candidateOf(it.symbol);
      if (c) out.push(c);
      if (out.length >= 20) break;
    }
    return out;
  }

  /** Lines of the same file with the stored fingerprint, identified by the symbol the route reports there (bounded). */
  private async sameLineCandidates(d: Descriptor, uri: vscode.Uri, text: string, token: vscode.CancellationToken): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const l of linesWithFingerprint(text, d.fingerprint!, 3)) {
      const s = await this.symbolAt(uri, l, nameColumn(lineAt(text, l) ?? '', d.name, d.position?.character ?? 0), token);
      if (s && s.name === d.name) {
        const c = await this.candidateOf(s);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** The symbol at the stored line has the same kind and container and the line differs only by its name. */
  private async renamedAt(d: Descriptor, uri: vscode.Uri, line: string, _text: string, token: vscode.CancellationToken): Promise<Candidate | undefined> {
    if (!d.position || !d.fingerprint) return undefined;
    const s = await this.symbolAt(uri, d.position.line, d.position.character, token);
    if (!s || s.name === d.name || (s.kind as string) !== d.symbolKind || (s.containerName ?? '') !== (d.container ?? '')) return undefined;
    if (lineFingerprint(replaceWord(line, s.name, d.name)) !== d.fingerprint) return undefined;
    return this.candidateOf(s);
  }

  private async symbolAt(uri: vscode.Uri, line: number, character: number, token: vscode.CancellationToken): Promise<SymbolRef | undefined> {
    const outcome = await this.engine.related({ uri: uri.toString(), position: { line, character } }, token);
    return outcome.kind === 'related' ? outcome.subject ?? undefined : undefined;
  }

  private async endpointCandidates(d: Descriptor, token: vscode.CancellationToken): Promise<Candidate[]> {
    const r = await this.engine.find(`route:${d.endpoint!.route}`, token, 100);
    const methods = [...d.endpoint!.methods].sort().join(',');
    const out: Candidate[] = [];
    for (const it of r.items) {
      const e = it.endpoint;
      if (it.kind !== 'endpoint' || !e || e.route !== d.endpoint!.route || [...e.httpMethods].sort().join(',') !== methods) continue;
      const p = await this.placeOf(e.location);
      if (p) out.push({ name: d.name, ...p });
    }
    return out;
  }

  private async followRenames(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    let store = this.store;
    for (const f of files) store = renameFileRefs(store, fileRefOf(f.oldUri), fileRefOf(f.newUri));
    if (store !== this.store && JSON.stringify(store) !== JSON.stringify(this.store)) await this.apply(store);
    this.schedule();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tree

  getTreeItem(node: Node): vscode.TreeItem {
    const item = node.item;
    if (node.kind === 'note') {
      const t = new vscode.TreeItem(item.note ?? '', vscode.TreeItemCollapsibleState.None);
      t.iconPath = new vscode.ThemeIcon('note');
      t.accessibilityInformation = { label: `Note: ${item.note ?? ''}` };
      t.contextValue = 'refyntra.taskNote';
      return t;
    }
    const st = this.states.get(item.id) ?? { status: 'pending' as const };
    const mr = multiRoot();
    const where = item.kind === 'relation' ? displayPath(item.subject?.file, mr) : displayPath(item.target.file, mr);
    const line = (item.kind === 'relation' ? item.subject : item.target)?.position;
    const placeText = where ? (line && item.kind !== 'file' ? `${where}:${line.line + 1}` : where) : undefined;
    const t = new vscode.TreeItem(itemTitle(item), item.note ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    t.id = item.id;
    // The state is a word (never only a colour or an icon).
    const word = STATUS_WORD[st.status];
    t.description = [st.status === 'resolved' ? undefined : word, placeText].filter(Boolean).join(' · ');
    const kindWord = item.kind === 'symbol' ? item.target.symbolKind ?? 'symbol' : item.kind === 'location' ? 'place' : item.kind;
    const md = new vscode.MarkdownString(undefined, false);
    md.appendText(`${itemTitle(item)} (${kindWord}) — ${word}${st.reason ? `: ${st.reason}` : ''}\n\n`);
    if (placeText) md.appendText(`${placeText}\n\n`);
    if (item.note) md.appendText(`Note: ${item.note}`);
    t.tooltip = md;
    t.accessibilityInformation = { label: [itemTitle(item), kindWord, word, st.reason, placeText ? `in ${placeText.replace(/:(\d+)$/, ' line $1')}` : undefined, item.note ? `note: ${item.note}` : undefined].filter(Boolean).join(', ') };
    t.iconPath = iconFor(item, st.status);
    t.contextValue = `refyntra.taskItem.${st.status}`;
    t.command = { command: 'refyntra.taskContext.open', title: 'Open', arguments: [node] };
    return t;
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'item') return node.item.note ? [{ kind: 'note', item: node.item }] : [];
    if (node) return [];
    return (this.active()?.items ?? []).map((item) => ({ kind: 'item', item }));
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'note' ? { kind: 'item', item: node.item } : undefined;
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const ids = source.filter((n) => n.kind === 'item').map((n) => n.item.id);
    data.set(DND_MIME, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const raw = data.get(DND_MIME)?.value as unknown;
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return;
    await this.apply(moveItemsTo(this.store, ids, target?.item.id));
  }

  /** e2e: the same reorder a drop performs. */
  async dropBefore(ids: string[], beforeItemId: string | undefined): Promise<void> {
    await this.apply(moveItemsTo(this.store, ids, beforeItemId));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.cts?.cancel();
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}

function stateOf(r: Resolution, part: 'target' | 'subject'): ItemState {
  switch (r.status) {
    case 'resolved':
      return { status: 'resolved', ...(r.reason ? { reason: r.reason } : {}) };
    case 'moved':
      return { status: 'moved', reason: r.reason };
    case 'ambiguous':
      return { status: 'ambiguous', reason: r.reason, candidates: r.candidates, candidatesFor: part };
    case 'missing':
    case 'pending':
      return { status: r.status, reason: r.reason };
  }
}

/** Column of the name in a line (the stored column when the name is not found). */
function nameColumn(line: string, name: string, fallback: number): number {
  const m = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).exec(line);
  return m ? m.index : fallback;
}

function iconFor(item: TaskItem, status: ResolutionStatus): vscode.ThemeIcon {
  if (status === 'missing') return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  if (status === 'ambiguous') return new vscode.ThemeIcon('question', new vscode.ThemeColor('list.warningForeground'));
  switch (item.kind) {
    case 'file':
      return vscode.ThemeIcon.File;
    case 'endpoint':
      return new vscode.ThemeIcon('globe');
    case 'relation':
      return new vscode.ThemeIcon('arrow-right');
    case 'location':
      return new vscode.ThemeIcon('location');
    default:
      return new vscode.ThemeIcon(`symbol-${symbolIcon(item.target.symbolKind)}`);
  }
}

function symbolIcon(kind: string | undefined): string {
  switch (kind) {
    case 'class':
    case 'record':
      return 'class';
    case 'interface':
      return 'interface';
    case 'struct':
      return 'struct';
    case 'enum':
      return 'enum';
    case 'method':
    case 'constructor':
    case 'function':
      return 'method';
    case 'property':
      return 'property';
    case 'field':
      return 'field';
    case 'namespace':
      return 'namespace';
    default:
      return 'misc';
  }
}

/** Registers the view and its commands. */
export function registerTaskContext(engine: EngineClient, memento: vscode.Memento, related: { current(): RelatedOutcome | undefined; showForActiveEditor(): Promise<void> }): { provider: TaskContextViewProvider; disposable: vscode.Disposable } {
  const provider = new TaskContextViewProvider(engine, memento, related);
  const view = vscode.window.createTreeView(TASK_CONTEXT_VIEW, { treeDataProvider: provider, dragAndDropController: provider, canSelectMany: true, showCollapseAll: false });
  provider.attach(view);
  const cmd = (id: string, f: (...args: never[]) => unknown) => vscode.commands.registerCommand(`refyntra.taskContext.${id}`, f as (...args: unknown[]) => unknown);
  const disposable = vscode.Disposable.from(
    provider,
    view,
    cmd('new', (name?: string) => provider.newContext(typeof name === 'string' ? name : undefined)),
    cmd('switch', (id?: string) => provider.switchContext(typeof id === 'string' ? id : undefined)),
    cmd('rename', (name?: string) => provider.renameContext(typeof name === 'string' ? name : undefined)),
    cmd('delete', () => provider.deleteContext()),
    cmd('clear', () => provider.clear()),
    cmd('addSymbol', () => provider.addSymbolAtCursor()),
    cmd('addFile', (uri?: unknown) => provider.addFile(uri)),
    cmd('addFindItem', (it?: FindItem) => provider.addFindItem(it)),
    cmd('addFromRelated', (node?: { kind?: string; relation?: MergedRelation }) => provider.addFromRelated(node)),
    cmd('open', (n?: unknown) => provider.open(n)),
    cmd('showRelated', (n?: unknown) => provider.showRelated(n)),
    cmd('moveUp', (n?: unknown) => provider.move(n, -1)),
    cmd('moveDown', (n?: unknown) => provider.move(n, 1)),
    cmd('remove', (n?: unknown) => provider.remove(n)),
    cmd('editNote', (n?: unknown) => provider.editNote(n)),
    cmd('choose', (n?: unknown) => provider.choose(n)),
    cmd('copyMarkdown', () => provider.copyMarkdown()),
    cmd('export', () => provider.exportTo()),
    cmd('import', () => provider.importFrom()),
    cmd('refresh', () => provider.resolveNow()),
    cmd('share', () => provider.share()),
  );
  // Follow the git branch of every workspace folder: HEAD is read directly (no git extension needed). In a linked
  // worktree (or a submodule) .git is a file "gitdir: <path>"; its HEAD is in that directory.
  const watches: vscode.Disposable[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    let branch: string | undefined;
    let head: vscode.Uri | undefined;
    const locate = async (): Promise<vscode.Uri | undefined> => {
      const dotGit = vscode.Uri.joinPath(folder.uri, '.git');
      try {
        const stat = await vscode.workspace.fs.stat(dotGit);
        if (stat.type & vscode.FileType.Directory) return vscode.Uri.joinPath(dotGit, 'HEAD');
        const gitdir = gitDirOfFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(dotGit)));
        if (!gitdir) return undefined;
        const dir = /^([a-zA-Z]:[\\/]|\/)/.test(gitdir) ? vscode.Uri.file(gitdir) : vscode.Uri.joinPath(folder.uri, gitdir);
        return vscode.Uri.joinPath(dir, 'HEAD');
      } catch {
        return undefined;
      }
    };
    const read = async () => {
      head ??= await locate();
      if (!head) return undefined;
      try {
        return branchOfHead(new TextDecoder().decode(await vscode.workspace.fs.readFile(head)));
      } catch {
        return undefined;
      }
    };
    const changed = async () => {
      const next = await read();
      if (next === branch) return;
      branch = next;
      await provider.followBranch(next);
    };
    // .git (a folder or a worktree's file) and .git/HEAD of the folder: created later, switched, or a checkout.
    let outside: vscode.Disposable[] = [];
    const relocate = async () => {
      head = undefined;
      head = await locate();
      for (const d of outside) d.dispose();
      outside = [];
      // A worktree's HEAD lives outside the folder: watch it there too.
      if (head && !head.path.startsWith(`${folder.uri.path}/`)) {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(head, '..'), 'HEAD'));
        outside.push(w, w.onDidChange(() => void changed()), w.onDidCreate(() => void changed()));
      }
      await changed();
    };
    const local = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '{.git,.git/HEAD}'));
    watches.push(local, local.onDidChange(() => void relocate()), local.onDidCreate(() => void relocate()), local.onDidDelete(() => void relocate()), { dispose: () => outside.forEach((d) => d.dispose()) });
    void (async () => {
      branch = await read();
      if (head && !head.path.startsWith(`${folder.uri.path}/`)) await relocate();
    })();
  }
  return { provider, disposable: vscode.Disposable.from(disposable, { dispose: () => { for (const w of watches) w.dispose(); } }) };
}
