// Task context: named lists of symbols, files, endpoints and pinned relations the user collects for a task.
// Pure (no vscode import): model, storage schema (version + migration), limits, Markdown export and the resolution
// decision table. Unit-tested with vitest (test/unit/taskContext.test.ts).
//
// What is stored is a resolvable DESCRIPTOR, never a symbol id: route, kind, names, a workspace-relative file, the last
// known position and a small fingerprint (a hash of the declaration line, not the text). After code changes an item
// can be stale; it is resolved again when the view opens and after edits. Nothing here leaves the machine.

export const TASK_CONTEXT_STORAGE_KEY = 'refyntra.taskContexts';
export const TASK_CONTEXT_SCHEMA_VERSION = 1;
export const TASK_CONTEXT_EXPORT_FORMAT = 'refyntra.taskContext';

/** Size limits (storage stays small; workspaceState is not a database). */
export const TASK_CONTEXT_LIMITS = {
  contexts: 50,
  itemsPerContext: 500,
  nameLength: 200,
  noteLength: 2000,
  /** Serialized size of everything stored for the workspace. */
  storeBytes: 1_000_000,
  /** Largest import file read. */
  importBytes: 2_000_000,
} as const;

export interface Pos {
  line: number;
  character: number;
}

/** Where a file is: relative to a workspace folder (by folder name), or an absolute URI outside the workspace. */
export type FileRef = { folder: string; path: string } | { uri: string };

export type ItemKind = 'symbol' | 'file' | 'endpoint' | 'location' | 'relation';

/** A resolvable descriptor of one thing in the code. Not an id: it is looked up again. */
export interface Descriptor {
  /** `location`: a place without a symbol (a call site, a DI registration, a client call). */
  kind: 'symbol' | 'file' | 'endpoint' | 'location';
  /** Language route that produced it (csharp.roslyn, ts-js…, python.pyright, rust.rust-analyzer). */
  route?: string;
  /** class, method, … (symbols only). */
  symbolKind?: string;
  /** Short display name (symbol name, file name, "GET /orders/{id}"). */
  name: string;
  /** Fully qualified name as the route reports it, e.g. "Shop.Api.Services.OrderService". */
  qualifiedName?: string;
  container?: string;
  file?: FileRef;
  /** Last known position (start of the declaration). */
  position?: Pos;
  /** Hash of the trimmed text of the line at `position` (fnv1a32). Never the text itself. */
  fingerprint?: string;
  /** Line count of the file when the position was last confirmed (a rename does not change it). */
  lineCount?: number;
  endpoint?: { methods: string[]; route: string };
}

export interface TaskItem {
  id: string;
  kind: ItemKind;
  /** The item itself; for a relation: its target. */
  target: Descriptor;
  /** Relations only: the subject the relation starts from. */
  subject?: Descriptor;
  /** Relations only, e.g. "implements", "calls". */
  relationKind?: string;
  note?: string;
  createdAt: number;
}

export interface TaskContext {
  id: string;
  name: string;
  createdAt: number;
  items: TaskItem[];
  /** The git branch this context follows (it becomes active when the branch is checked out). */
  branch?: string;
}

/** Folder of the contexts shared through the repository (committed like any file, reviewed like code). */
export const SHARED_TASK_CONTEXT_FOLDER = '.refyntra/task-contexts';

export interface TaskContextStore {
  version: number;
  activeId?: string;
  contexts: TaskContext[];
}

export function emptyStore(): TaskContextStore {
  return { version: TASK_CONTEXT_SCHEMA_VERSION, contexts: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fingerprint

/** FNV-1a 32-bit of the trimmed line: a small, stable, non-reversible fingerprint (not a security hash). */
export function lineFingerprint(lineText: string): string {
  const s = lineText.trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a32:${h.toString(16).padStart(8, '0')}`;
}

/** Line `n` (0-based) of a text, without the line break; undefined when out of range. */
export function lineAt(text: string, n: number): string | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  return n >= 0 && n < lines.length ? lines[n] : undefined;
}

export function lineCountOf(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/** 0-based lines whose fingerprint equals `fp` (bounded). */
export function linesWithFingerprint(text: string, fp: string, max = 20): number[] {
  const out: number[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) if (lineFingerprint(lines[i]!) === fp) out.push(i);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The line with every whole-word `from` replaced by `to` (used to prove "only the name changed"). */
export function replaceWord(line: string, from: string, to: string): string {
  if (!from) return line;
  return line.replace(new RegExp(`(?<![\\w$])${escapeRegExp(from)}(?![\\w$])`, 'g'), to);
}

// ---------------------------------------------------------------------------------------------------------------------
// Schema: parse, migrate, validate (storage and import share it)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

function parsePos(v: unknown): Pos | undefined {
  if (!isObj(v)) return undefined;
  const line = num(v.line);
  const character = num(v.character);
  return line === undefined || character === undefined ? undefined : { line, character };
}

function parseFile(v: unknown): FileRef | undefined {
  if (!isObj(v)) return undefined;
  const folder = str(v.folder, 500);
  const path = str(v.path, 2000);
  if (folder !== undefined && path !== undefined && !path.split('/').includes('..')) return { folder, path };
  const uri = str(v.uri, 4000);
  if (uri !== undefined && /^file:/i.test(uri)) return { uri };
  return undefined;
}

export function parseDescriptor(v: unknown): Descriptor | undefined {
  if (!isObj(v)) return undefined;
  const kind = v.kind;
  if (kind !== 'symbol' && kind !== 'file' && kind !== 'endpoint' && kind !== 'location') return undefined;
  const name = str(v.name, TASK_CONTEXT_LIMITS.nameLength);
  if (!name) return undefined;
  const d: Descriptor = { kind, name };
  const route = str(v.route, 100);
  if (route) d.route = route;
  const symbolKind = str(v.symbolKind, 50);
  if (symbolKind) d.symbolKind = symbolKind;
  const qualifiedName = str(v.qualifiedName, 1000);
  if (qualifiedName) d.qualifiedName = qualifiedName;
  const container = str(v.container, 1000);
  if (container) d.container = container;
  const file = parseFile(v.file);
  if (file) d.file = file;
  const position = parsePos(v.position);
  if (position) d.position = position;
  const fingerprint = typeof v.fingerprint === 'string' && /^fnv1a32:[0-9a-f]{8}$/.test(v.fingerprint) ? v.fingerprint : undefined;
  if (fingerprint) d.fingerprint = fingerprint;
  const lineCount = num(v.lineCount);
  if (lineCount !== undefined) d.lineCount = lineCount;
  if (isObj(v.endpoint) && typeof v.endpoint.route === 'string') {
    const methods = Array.isArray(v.endpoint.methods) ? v.endpoint.methods.filter((m): m is string => typeof m === 'string').slice(0, 10).map((m) => m.slice(0, 10)) : [];
    d.endpoint = { methods, route: v.endpoint.route.slice(0, 1000) };
  }
  if ((kind === 'file' || kind === 'location') && !d.file) return undefined;
  if (kind === 'endpoint' && !d.endpoint) return undefined;
  return d;
}

export function parseItem(v: unknown): TaskItem | undefined {
  if (!isObj(v)) return undefined;
  const kind = v.kind;
  if (kind !== 'symbol' && kind !== 'file' && kind !== 'endpoint' && kind !== 'location' && kind !== 'relation') return undefined;
  const id = str(v.id, 100);
  const target = parseDescriptor(v.target);
  if (!id || !target) return undefined;
  const item: TaskItem = { id, kind, target, createdAt: num(v.createdAt) ?? 0 };
  if (kind === 'relation') {
    const subject = parseDescriptor(v.subject);
    const relationKind = str(v.relationKind, 100);
    if (!subject || !relationKind) return undefined;
    item.subject = subject;
    item.relationKind = relationKind;
  } else if (kind !== target.kind) return undefined;
  const note = str(v.note, TASK_CONTEXT_LIMITS.noteLength);
  if (note) item.note = note;
  return item;
}

export function parseContext(v: unknown): TaskContext | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id, 100);
  const name = str(v.name, TASK_CONTEXT_LIMITS.nameLength);
  if (!id || !name || !Array.isArray(v.items)) return undefined;
  const items: TaskItem[] = [];
  const seen = new Set<string>();
  for (const raw of v.items) {
    const it = parseItem(raw);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
    if (items.length >= TASK_CONTEXT_LIMITS.itemsPerContext) break;
  }
  const branch = str(v.branch, 250);
  return { id, name, createdAt: num(v.createdAt) ?? 0, items, ...(branch ? { branch } : {}) };
}

export type LoadResult = { kind: 'ok'; store: TaskContextStore; dropped: number } | { kind: 'newer'; version: number };

/**
 * Migration table: version n → n+1. Version 1 is the first schema, so the table is empty; a later schema adds its
 * step here and the stored data is upgraded on load. A NEWER version than this build understands is never
 * overwritten: the caller keeps it untouched and works read-only.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

/** Reads the stored value (or an import): migrates, validates and drops what is malformed. */
export function loadStore(raw: unknown): LoadResult {
  if (raw === undefined || raw === null) return { kind: 'ok', store: emptyStore(), dropped: 0 };
  if (!isObj(raw)) return { kind: 'ok', store: emptyStore(), dropped: 1 };
  let version = num(raw.version) ?? 0;
  if (version > TASK_CONTEXT_SCHEMA_VERSION) return { kind: 'newer', version };
  let data = raw;
  while (version < TASK_CONTEXT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return { kind: 'ok', store: emptyStore(), dropped: 1 };
    data = step(data);
    version++;
  }
  const contexts: TaskContext[] = [];
  let dropped = 0;
  const ids = new Set<string>();
  for (const c of Array.isArray(data.contexts) ? data.contexts : []) {
    const ctx = parseContext(c);
    if (!ctx || ids.has(ctx.id) || contexts.length >= TASK_CONTEXT_LIMITS.contexts) {
      dropped++;
      continue;
    }
    if (isObj(c) && Array.isArray(c.items)) dropped += c.items.length - ctx.items.length;
    ids.add(ctx.id);
    contexts.push(ctx);
  }
  const activeId = typeof data.activeId === 'string' && ids.has(data.activeId) ? data.activeId : contexts[0]?.id;
  return { kind: 'ok', store: { version: TASK_CONTEXT_SCHEMA_VERSION, ...(activeId ? { activeId } : {}), contexts }, dropped };
}

export function serializedSize(store: TaskContextStore): number {
  return new TextEncoder().encode(JSON.stringify(store)).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mutations (pure: return a new store or an error message)

export type Mutation = { ok: true; store: TaskContextStore } | { ok: false; message: string };

function withinSize(store: TaskContextStore): Mutation {
  return serializedSize(store) > TASK_CONTEXT_LIMITS.storeBytes ? { ok: false, message: `Task contexts are limited to ${Math.round(TASK_CONTEXT_LIMITS.storeBytes / 1000)} KB; remove items or contexts first.` } : { ok: true, store };
}

export function activeContext(store: TaskContextStore): TaskContext | undefined {
  return store.contexts.find((c) => c.id === store.activeId);
}

/** A name not used yet: "Task", "Task (2)", … */
export function uniqueName(store: TaskContextStore, wanted: string): string {
  const base = wanted.trim().slice(0, TASK_CONTEXT_LIMITS.nameLength - 6) || 'Task';
  const names = new Set(store.contexts.map((c) => c.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

export function createContext(store: TaskContextStore, name: string, id: string, now: number): Mutation {
  if (store.contexts.length >= TASK_CONTEXT_LIMITS.contexts) return { ok: false, message: `At most ${TASK_CONTEXT_LIMITS.contexts} task contexts per workspace.` };
  const ctx: TaskContext = { id, name: uniqueName(store, name), createdAt: now, items: [] };
  return withinSize({ ...store, activeId: id, contexts: [...store.contexts, ctx] });
}

export function renameContext(store: TaskContextStore, id: string, name: string): Mutation {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: 'A task context needs a name.' };
  const others = { ...store, contexts: store.contexts.filter((c) => c.id !== id) };
  const finalName = uniqueName(others, trimmed);
  return withinSize({ ...store, contexts: store.contexts.map((c) => (c.id === id ? { ...c, name: finalName } : c)) });
}

export function deleteContext(store: TaskContextStore, id: string): TaskContextStore {
  const contexts = store.contexts.filter((c) => c.id !== id);
  const activeId = store.activeId === id ? contexts[0]?.id : store.activeId;
  return { version: store.version, ...(activeId ? { activeId } : {}), contexts };
}

/** The branch of a .git/HEAD file ("ref: refs/heads/feature/x" → "feature/x"); undefined for a detached HEAD. */
export function branchOfHead(head: string): string | undefined {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return m?.[1];
}

/**
 * The context that follows `branch` becomes active; when there is none, a new one named after the branch is created
 * for it (a context is never deleted or emptied by a branch switch).
 */
export function contextForBranch(store: TaskContextStore, branch: string, id: string, now: number): Mutation & { created?: boolean } {
  const existing = store.contexts.find((c) => c.branch === branch);
  if (existing) return { ok: true, store: switchContext(store, existing.id) };
  const created = createContext(store, branch, id, now);
  if (!created.ok) return created;
  return { ok: true, created: true, store: { ...created.store, contexts: created.store.contexts.map((c) => (c.id === id ? { ...c, branch } : c)) } };
}

/** A file name for a shared context: the name with anything but letters, digits, '.', '-' and '_' replaced. */
export function sharedFileName(name: string): string {
  return `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task'}.json`;
}

export function switchContext(store: TaskContextStore, id: string): TaskContextStore {
  return store.contexts.some((c) => c.id === id) ? { ...store, activeId: id } : store;
}

function updateActive(store: TaskContextStore, f: (c: TaskContext) => TaskContext | string): Mutation {
  const ctx = activeContext(store);
  if (!ctx) return { ok: false, message: 'No task context is active. Create one first.' };
  const next = f(ctx);
  if (typeof next === 'string') return { ok: false, message: next };
  return withinSize({ ...store, contexts: store.contexts.map((c) => (c.id === ctx.id ? next : c)) });
}

/** Two items are the same thing (adding it twice is a no-op). */
export function sameItem(a: TaskItem, b: TaskItem): boolean {
  if (a.kind !== b.kind) return false;
  const key = (d: Descriptor | undefined) => (d ? `${d.kind}|${d.route ?? ''}|${d.symbolKind ?? ''}|${d.qualifiedName ?? d.name}|${fileKey(d.file)}|${d.endpoint ? `${d.endpoint.methods.join(',')} ${d.endpoint.route}` : ''}` : '');
  return key(a.target) === key(b.target) && key(a.subject) === key(b.subject) && (a.relationKind ?? '') === (b.relationKind ?? '');
}

export function fileKey(f: FileRef | undefined): string {
  if (!f) return '';
  return 'uri' in f ? f.uri : `${f.folder}/${f.path}`;
}

export type AddResult = (Mutation & { ok: true; added: boolean }) | { ok: false; message: string };

export function addItem(store: TaskContextStore, item: TaskItem): AddResult {
  let added = true;
  const r = updateActive(store, (c) => {
    if (c.items.some((x) => sameItem(x, item))) {
      added = false;
      return c;
    }
    if (c.items.length >= TASK_CONTEXT_LIMITS.itemsPerContext) return `A task context holds at most ${TASK_CONTEXT_LIMITS.itemsPerContext} items.`;
    return { ...c, items: [...c.items, item] };
  });
  return r.ok ? { ...r, added } : r;
}

export function removeItem(store: TaskContextStore, itemId: string): Mutation {
  return updateActive(store, (c) => ({ ...c, items: c.items.filter((i) => i.id !== itemId) }));
}

export function clearItems(store: TaskContextStore): Mutation {
  return updateActive(store, (c) => ({ ...c, items: [] }));
}

/** Moves an item by `delta` places (keyboard Move Up/Down), clamped to the list. */
export function moveItem(store: TaskContextStore, itemId: string, delta: number): Mutation {
  return updateActive(store, (c) => {
    const i = c.items.findIndex((x) => x.id === itemId);
    if (i < 0) return c;
    const j = Math.max(0, Math.min(c.items.length - 1, i + delta));
    return { ...c, items: reorder(c.items, [itemId], j) };
  });
}

/** Drag and drop: moves the given items (in their current order) so that they start at index `to` (of the result). */
export function moveItemsTo(store: TaskContextStore, itemIds: readonly string[], beforeItemId: string | undefined): Mutation {
  return updateActive(store, (c) => {
    const moving = new Set(itemIds);
    const rest = c.items.filter((x) => !moving.has(x.id));
    let to = beforeItemId === undefined ? rest.length : rest.findIndex((x) => x.id === beforeItemId);
    if (to < 0) to = rest.length;
    return { ...c, items: reorder(c.items, itemIds, to) };
  });
}

function reorder(items: readonly TaskItem[], ids: readonly string[], to: number): TaskItem[] {
  const moving = new Set(ids);
  const picked = items.filter((x) => moving.has(x.id));
  const rest = items.filter((x) => !moving.has(x.id));
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, ...picked);
  return rest;
}

export function setNote(store: TaskContextStore, itemId: string, note: string): Mutation {
  const n = note.trim().slice(0, TASK_CONTEXT_LIMITS.noteLength);
  return updateActive(store, (c) => ({ ...c, items: c.items.map((i) => (i.id === itemId ? withNote(i, n) : i)) }));
}

function withNote(i: TaskItem, note: string): TaskItem {
  const { note: _old, ...rest } = i;
  return note ? { ...rest, note } : rest;
}

/** Replaces the target (or the subject) descriptor of an item after a resolution moved or renamed it. */
export function updateDescriptor(store: TaskContextStore, contextId: string, itemId: string, part: 'target' | 'subject', d: Descriptor): TaskContextStore {
  return {
    ...store,
    contexts: store.contexts.map((c) => (c.id !== contextId ? c : { ...c, items: c.items.map((i) => (i.id !== itemId ? i : { ...i, [part]: d })) })),
  };
}

/** A file was renamed or moved: every descriptor in it follows. */
export function renameFileRefs(store: TaskContextStore, from: FileRef, to: FileRef): TaskContextStore {
  const k = fileKey(from);
  const fix = (d: Descriptor | undefined): Descriptor | undefined => {
    if (!d || fileKey(d.file) !== k) return d;
    const next: Descriptor = { ...d, file: to };
    if (d.kind === 'file') next.name = baseName(to);
    return next;
  };
  return {
    ...store,
    contexts: store.contexts.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, target: fix(i.target)!, ...(i.subject ? { subject: fix(i.subject)! } : {}) })) })),
  };
}

export function baseName(f: FileRef): string {
  const p = 'uri' in f ? decodeURIComponentSafe(f.uri) : f.path;
  return p.split(/[\\/]/).pop() || p;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Import / export

export interface ExportFile {
  format: typeof TASK_CONTEXT_EXPORT_FORMAT;
  version: number;
  contexts: TaskContext[];
}

export function toExportFile(contexts: readonly TaskContext[]): ExportFile {
  return { format: TASK_CONTEXT_EXPORT_FORMAT, version: TASK_CONTEXT_SCHEMA_VERSION, contexts: contexts.map((c) => ({ ...c, items: [...c.items] })) };
}

export type ImportResult = { ok: true; store: TaskContextStore; imported: string[]; dropped: number } | { ok: false; message: string };

/** Adds the contexts of an export file as new contexts (new ids, unique names). The imported one becomes active. */
export function importContexts(store: TaskContextStore, text: string, newId: () => string): ImportResult {
  if (text.length > TASK_CONTEXT_LIMITS.importBytes) return { ok: false, message: 'The file is too large for a task context export.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The file is not valid JSON.' };
  }
  if (!isObj(raw) || raw.format !== TASK_CONTEXT_EXPORT_FORMAT) return { ok: false, message: 'The file is not a Refyntra task context export.' };
  const loaded = loadStore({ version: raw.version, contexts: raw.contexts });
  if (loaded.kind === 'newer') return { ok: false, message: `The file was written by a newer Refyntra (format version ${loaded.version}). Update Refyntra to import it.` };
  let next = store;
  const imported: string[] = [];
  for (const c of loaded.store.contexts) {
    const created = createContext(next, c.name, newId(), c.createdAt);
    if (!created.ok) return created;
    const ctx = activeContext(created.store)!;
    const items = c.items.map((i) => ({ ...i, id: newId() }));
    const withItems = withinSize({ ...created.store, contexts: created.store.contexts.map((x) => (x.id === ctx.id ? { ...x, items } : x)) });
    if (!withItems.ok) return withItems;
    next = withItems.store;
    imported.push(ctx.name);
  }
  if (imported.length === 0) return { ok: false, message: 'The file contains no task context.' };
  return { ok: true, store: next, imported, dropped: loaded.dropped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Presentation (Markdown export and words; shared with the tree's accessible labels)

export type ResolutionStatus = 'resolved' | 'moved' | 'ambiguous' | 'missing' | 'pending';

/** One word per state: the same word in the tree, the screen-reader label and docs/accessibility.md. */
export const STATUS_WORD: Readonly<Record<ResolutionStatus, string>> = {
  resolved: 'resolved',
  moved: 'moved',
  ambiguous: 'ambiguous',
  missing: 'missing',
  pending: 'not checked yet',
};

/** "Shop.Api/Services/OrderServices.cs" (workspace-relative; the folder name prefixes it in a multi-root workspace). */
export function displayPath(f: FileRef | undefined, multiRoot: boolean): string | undefined {
  if (!f) return undefined;
  if ('uri' in f) return `${baseName(f)} (outside the workspace)`;
  return multiRoot ? `${f.folder}/${f.path}` : f.path;
}

export function itemTitle(item: TaskItem): string {
  if (item.kind === 'relation') return `${item.subject!.name} ${item.relationKind} ${item.target.name}`;
  return item.target.name;
}

function place(d: Descriptor, multiRoot: boolean): string | undefined {
  const p = displayPath(d.file, multiRoot);
  if (!p) return undefined;
  return d.position && d.kind !== 'file' ? `${p}:${d.position.line + 1}` : p;
}

/** Copy as Markdown: names, relative paths and notes only — never source text, never absolute paths. */
export function contextToMarkdown(ctx: TaskContext, multiRoot: boolean, status?: (item: TaskItem) => ResolutionStatus | undefined): string {
  const out = [`# ${mdEscape(ctx.name)}`, ''];
  if (ctx.items.length === 0) out.push('_No items._');
  for (const item of ctx.items) {
    const s = status?.(item);
    const where = item.kind === 'relation' ? place(item.subject!, multiRoot) : place(item.target, multiRoot);
    const kind = item.kind === 'symbol' ? item.target.symbolKind ?? 'symbol' : item.kind;
    let line = `- **${mdEscape(itemTitle(item))}** (${kind})`;
    if (where) line += ` — \`${where.replace(/`/g, "'")}\``;
    if (item.kind === 'relation') {
      const t = place(item.target, multiRoot);
      if (t) line += ` → \`${t.replace(/`/g, "'")}\``;
    }
    if (s && s !== 'resolved') line += ` _(${STATUS_WORD[s]})_`;
    out.push(line);
    if (item.note) for (const l of item.note.split(/\r\n|\r|\n/)) out.push(`  > ${mdEscape(l)}`);
  }
  return `${out.join('\n')}\n`;
}

function mdEscape(s: string): string {
  return s.replace(/([\\*_[\]<>#|])/g, '\\$1');
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution decision table

/** A place where the descriptor's symbol might be now (from Find, or from a symbol lookup at a line). */
export interface Candidate {
  name: string;
  qualifiedName?: string;
  symbolKind?: string;
  container?: string;
  file: FileRef;
  position: Pos;
  fingerprint?: string;
  lineCount?: number;
}

export interface ResolutionEvidence {
  /** The route that owns the descriptor answers requests now (false: loading, restricted, failed). */
  routeReady: boolean;
  /** The stored file exists (open or on disk). */
  fileExists: boolean;
  /** The line at the stored position has the stored fingerprint. */
  exactLine: boolean;
  /** Candidates from Find on the same route (same simple name, any kind/container) and from lines of the same file. */
  candidates: Candidate[];
  /**
   * The symbol now declared at the stored position, when it has the same kind and container but another name and the
   * stored line equals the current one with that name replaced by the old name (proof that only the name changed).
   */
  renamedAt?: Candidate;
  /** Line count of the stored file now (a rename keeps it; deleting or adding code changes it). */
  lineCount?: number;
}

export type Resolution =
  | { status: 'resolved'; descriptor: Descriptor; reason?: string }
  | { status: 'moved'; descriptor: Descriptor; reason: string }
  | { status: 'ambiguous'; candidates: Candidate[]; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'pending'; reason: string };

/** Same symbol identity apart from the place: name, kind, container and (when both known) qualified name. */
export function sameIdentity(d: Descriptor, c: Candidate): boolean {
  if (c.name !== d.name) return false;
  if ((c.symbolKind ?? '') !== (d.symbolKind ?? '')) return false;
  if ((c.container ?? '') !== (d.container ?? '')) return false;
  if (d.qualifiedName && c.qualifiedName && d.qualifiedName !== c.qualifiedName) return false;
  return true;
}

function samePlace(d: Descriptor, c: Candidate): boolean {
  return fileKey(d.file) === fileKey(c.file) && d.position?.line === c.position.line;
}

function descriptorAt(d: Descriptor, c: Candidate, rename = false): Descriptor {
  const next: Descriptor = { ...d, file: c.file, position: c.position };
  if (c.fingerprint) next.fingerprint = c.fingerprint;
  if (c.lineCount !== undefined) next.lineCount = c.lineCount;
  if (rename) {
    next.name = c.name;
    if (c.qualifiedName) next.qualifiedName = c.qualifiedName;
    else delete next.qualifiedName;
  }
  return next;
}

function dedupe(cs: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = `${fileKey(c.file)}:${c.position.line}|${c.symbolKind ?? ''}|${c.qualifiedName ?? c.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The decision table for a symbol descriptor. In order:
 *  1. the stored line still has the fingerprint                       → resolved (same place)
 *  2. the route is not ready (loading, Restricted Mode, failed)       → pending (nothing is marked missing meanwhile)
 *  3. exactly one candidate with the same identity                    → moved (or resolved when it is the same line)
 *     more than one                                                   → ambiguous (the user chooses)
 *  4. the symbol at the stored line differs only by its name, and the
 *     file has the same number of lines (a rename keeps both)         → resolved, renamed (name updated)
 *     the same, but the line count changed                            → ambiguous (possibly renamed: the user confirms)
 *  5. candidates with the same name but another kind or container     → ambiguous (never silently a different symbol)
 *  6. nothing                                                         → missing (kept; the reason is shown)
 */
export function decideSymbol(d: Descriptor, ev: ResolutionEvidence): Resolution {
  if (ev.exactLine) return { status: 'resolved', descriptor: ev.lineCount !== undefined ? { ...d, lineCount: ev.lineCount } : d };
  if (!ev.routeReady) return { status: 'pending', reason: 'the language support for this item is not ready yet' };
  const all = dedupe(ev.candidates);
  const same = all.filter((c) => sameIdentity(d, c));
  if (same.length === 1) {
    const c = same[0]!;
    if (samePlace(d, c)) return { status: 'resolved', descriptor: descriptorAt(d, c) };
    return { status: 'moved', descriptor: descriptorAt(d, c), reason: `found at a new place by its name ${d.qualifiedName ?? d.name}` };
  }
  if (same.length > 1) return { status: 'ambiguous', candidates: same, reason: `${same.length} symbols match ${d.qualifiedName ?? d.name}; choose one` };
  if (ev.renamedAt) {
    const r = ev.renamedAt;
    if (d.lineCount !== undefined && ev.lineCount === d.lineCount) return { status: 'resolved', descriptor: descriptorAt(d, r, true), reason: `renamed from ${d.name} to ${r.name}` };
    return { status: 'ambiguous', candidates: [r], reason: `possibly renamed to ${r.name}, but the file changed elsewhere too; choose to confirm` };
  }
  if (all.length > 0) return { status: 'ambiguous', candidates: all, reason: `${d.name} was not found as the same ${d.symbolKind ?? 'symbol'}${d.container ? ` in ${d.container}` : ''}; similar symbols exist — choose one or remove the item` };
  if (!ev.fileExists) return { status: 'missing', reason: 'its file no longer exists and the name was not found' };
  return { status: 'missing', reason: `${d.qualifiedName ?? d.name} was not found (deleted or renamed outside Refyntra)` };
}

/** A file descriptor: it exists or it is missing (renames and moves are followed when VS Code reports them). */
export function decideFile(d: Descriptor, fileExists: boolean): Resolution {
  return fileExists ? { status: 'resolved', descriptor: d } : { status: 'missing', reason: 'the file no longer exists' };
}

/**
 * A place without a symbol (call site, registration): the stored line, else the one line in the same file with the
 * same fingerprint (moved), several such lines (ambiguous), none (missing).
 */
export function decideLocation(d: Descriptor, ev: { fileExists: boolean; exactLine: boolean; sameLines: Candidate[] }): Resolution {
  if (ev.exactLine) return { status: 'resolved', descriptor: d };
  if (!ev.fileExists) return { status: 'missing', reason: 'its file no longer exists' };
  if (ev.sameLines.length === 1) return { status: 'moved', descriptor: descriptorAt(d, ev.sameLines[0]!), reason: 'the same line was found at a new place in the file' };
  if (ev.sameLines.length > 1) return { status: 'ambiguous', candidates: ev.sameLines, reason: `${ev.sameLines.length} identical lines in the file; choose one` };
  return { status: 'missing', reason: 'the line was changed or removed' };
}

/** An endpoint: same HTTP methods and route among the C# route's endpoints. */
export function decideEndpoint(d: Descriptor, ev: { routeReady: boolean; candidates: Candidate[]; exactLine: boolean }): Resolution {
  if (ev.exactLine) return { status: 'resolved', descriptor: d };
  if (!ev.routeReady) return { status: 'pending', reason: 'the language support for this item is not ready yet' };
  const all = dedupe(ev.candidates);
  if (all.length === 1) {
    const c = all[0]!;
    return samePlace(d, c) ? { status: 'resolved', descriptor: descriptorAt(d, c) } : { status: 'moved', descriptor: descriptorAt(d, c), reason: 'the endpoint was found at a new place by its route' };
  }
  if (all.length > 1) return { status: 'ambiguous', candidates: all, reason: `${all.length} endpoints match ${d.name}; choose one` };
  return { status: 'missing', reason: `no endpoint ${d.name} was found` };
}

const ORDER: Readonly<Record<ResolutionStatus, number>> = { resolved: 0, moved: 1, pending: 2, ambiguous: 3, missing: 4 };

/** A relation is as good as its worse end. */
export function combineStatus(a: ResolutionStatus, b: ResolutionStatus): ResolutionStatus {
  return ORDER[a] >= ORDER[b] ? a : b;
}
