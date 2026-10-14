import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CancellationSource, CancelledError, type Clock, DocumentTracker, type LspConnection, type LspStartContext, RouteUnavailableError, RpcError, StaleResultError, StartupError } from '@refyntra/application';
import type { ReadResult } from '@refyntra/adapter-vscode-providers';
import { LspLanguageAdapter, PYTHON_LSP_LANGUAGE, RUST_LSP_LANGUAGE, readLspWorkspaceEdit } from '../src';

// The LSP route against an in-memory fake server: lifecycle, document sync, stale results, rename plans.

const ORDERS = 'file:///ws/app/orders.py';
const USE = 'file:///ws/app/use.py';
const CLOSED = 'file:///ws/app/closed.py';
const DISK: Record<string, string> = {
  [ORDERS]: 'def get_order(order_id):\n    return order_id\n',
  [USE]: 'from app.orders import get_order\nfirst = get_order(1)\n',
  [CLOSED]: 'from app.orders import get_order\nsecond = get_order(2)\n',
};
const hash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

type Handler = (params: any, s: FakeServer) => unknown;

class FakeServer implements LspConnection {
  serverCapabilities: Record<string, unknown> = { renameProvider: { prepareProvider: true }, definitionProvider: true, referencesProvider: true, implementationProvider: true, workspaceSymbolProvider: true };
  serverInfo = { name: 'fake', version: '1' };
  notes: { method: string; params: any }[] = [];
  requests: string[] = [];
  closeListeners: ((e?: Error) => void)[] = [];
  notifyListeners: ((m: string, p: unknown) => void)[] = [];
  shutDown = false;
  /** Server-side document view (what Refyntra sent). */
  docs = new Map<string, { version: number; text: string }>();
  handlers: Record<string, Handler> = {};
  /** Runs before answering (tests edit documents while the server works). */
  during?: () => void;
  async request(method: string, params: unknown, token?: { isCancellationRequested: boolean }): Promise<unknown> {
    this.requests.push(method);
    this.during?.();
    if (token?.isCancellationRequested) throw new CancelledError();
    const h = this.handlers[method];
    if (!h) throw new RpcError(-32601, 'no handler');
    return h(params, this);
  }
  notify(method: string, params: any): void {
    this.notes.push({ method, params });
    if (method === 'textDocument/didOpen') this.docs.set(params.textDocument.uri, { version: params.textDocument.version, text: params.textDocument.text });
    if (method === 'textDocument/didChange') this.docs.set(params.textDocument.uri, { version: params.textDocument.version, text: params.contentChanges[0].text });
    if (method === 'textDocument/didClose') this.docs.delete(params.textDocument.uri);
  }
  onClose(l: (e?: Error) => void) {
    this.closeListeners.push(l);
    return { dispose: () => undefined };
  }
  onNotification(l: (m: string, p: unknown) => void) {
    this.notifyListeners.push(l);
    return { dispose: () => undefined };
  }
  async shutdown() {
    this.shutDown = true;
  }
  crash() {
    for (const l of this.closeListeners) l(new Error('exited'));
  }
  /** The text the server currently sees for a document (open: what Refyntra sent; closed: disk). */
  text(uri: string) {
    return this.docs.get(uri)?.text ?? DISK[uri]!;
  }
}

class FakeClock implements Clock {
  t = 0;
  timers: { at: number; cb: () => void; done: boolean }[] = [];
  now() {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number) {
    const timer = { at: this.t + ms, cb, done: false };
    this.timers.push(timer);
    return { dispose: () => void (timer.done = true) };
  }
  advance(ms: number) {
    this.t += ms;
    for (const x of this.timers) if (!x.done && x.at <= this.t) {
      x.done = true;
      x.cb();
    }
  }
}

/** Renames every whole-word occurrence of the identifier at the position in ORDERS, USE and CLOSED (server view). */
function renameHandler(params: any, s: FakeServer) {
  const changes: any[] = [];
  for (const uri of [ORDERS, USE, CLOSED]) {
    const lines = s.text(uri).split('\n');
    const edits: any[] = [];
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bget_order\b/g)) edits.push({ range: { start: { line: i, character: m.index! }, end: { line: i, character: m.index! + 9 } }, newText: params.newName });
    });
    if (edits.length) changes.push({ textDocument: { uri, version: s.docs.get(uri)?.version ?? null }, edits });
  }
  return { documentChanges: changes };
}

let adapter: LspLanguageAdapter | undefined;
afterEach(async () => {
  await adapter?.dispose();
  adapter = undefined;
});

function setup(o: { trusted?: boolean; connectError?: Error; env?: boolean } = {}) {
  const tracker = new DocumentTracker();
  const clock = new FakeClock();
  const servers: FakeServer[] = [];
  const contexts: LspStartContext[] = [];
  let trusted = o.trusted ?? true;
  const disk = { ...DISK };
  const documents = {
    async read(uri: string): Promise<ReadResult> {
      const open = tracker.get(uri);
      if (open) return { ok: true, text: open.text, open: true };
      return disk[uri] !== undefined ? { ok: true, text: disk[uri]!, open: false } : { ok: false, reason: 'unreadable' };
    },
  };
  adapter = new LspLanguageAdapter({
    language: PYTHON_LSP_LANGUAGE,
    workspaceId: 'w',
    connect: async (ctx) => {
      contexts.push(ctx);
      if (o.connectError) throw o.connectError;
      const s = new FakeServer();
      s.handlers['textDocument/prepareRename'] = (p) => ({ range: { start: p.position, end: { line: p.position.line, character: p.position.character + 9 } }, placeholder: 'get_order' });
      s.handlers['textDocument/rename'] = renameHandler;
      s.handlers['workspace/symbol'] = () => [
        { name: 'get_order', kind: 12, location: { uri: ORDERS, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } } } },
        { name: 'OrderService', kind: 5, location: { uri: 'file:///ws/notes.md' } },
        { bogus: true },
      ];
      s.handlers['textDocument/definition'] = () => [{ uri: ORDERS, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } } }];
      s.handlers['textDocument/references'] = () => [
        { uri: ORDERS, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } } },
        { uri: USE, range: { start: { line: 1, character: 8 }, end: { line: 1, character: 17 } } },
        { uri: 'not a uri', range: {} },
      ];
      s.handlers['textDocument/implementation'] = () => null;
      s.handlers['textDocument/documentSymbol'] = () => [{ name: 'get_order', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 19 } }, selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } } }];
      servers.push(s);
      return s;
    },
    tracker,
    trust: { isTrusted: () => trusted },
    clock,
    logger: { log: () => undefined },
    documents,
    hash,
    workspaceFolders: () => [{ uri: 'file:///ws', name: 'ws' }],
    ...(o.env ? { environment: async () => ({ reasonCode: 'CargoNotFound', message: 'cargo missing' }) } : {}),
    restartDelaysMs: [100, 200],
  });
  const a = adapter;
  tracker.onDidRecord((e) => a.handles(e.uri, e.languageId) && a.documentEvent(e));
  const open = (uri: string, text = disk[uri]!) => tracker.open(uri, 'python', 1, text);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { tracker, clock, servers, contexts, adapter: a, open, disk, settle, setTrusted: (v: boolean) => void (trusted = v) };
}

describe('lifecycle', () => {
  it('starts lazily: nothing before the first Python document; then one initialized session with workspace folders', async () => {
    const w = setup();
    await w.adapter.start();
    expect(w.servers).toHaveLength(0);
    expect(w.adapter.health()).toMatchObject({ state: 'NotStarted', message: PYTHON_LSP_LANGUAGE.notStartedMessage });
    w.open(ORDERS);
    await w.settle();
    await w.settle();
    expect(w.servers).toHaveLength(1);
    expect(w.contexts[0]!.workspaceFolders).toEqual([{ uri: 'file:///ws', name: 'ws' }]);
    expect(w.adapter.health().state).toBe('Ready');
    expect(w.adapter.health().hostDescription).toMatch(/Pyright language server bundled with Refyntra/);
    expect(w.servers[0]!.docs.get(ORDERS)?.text).toBe(DISK[ORDERS]);
  });

  it('Restricted Mode: never starts a server, every feature explains TrustRequired', async () => {
    const w = setup({ trusted: false });
    await w.adapter.start();
    w.open(ORDERS);
    await w.settle();
    expect(w.contexts).toHaveLength(0);
    expect(w.adapter.health()).toMatchObject({ state: 'TrustRequired', reasonCode: 'TrustRequired' });
    expect(w.adapter.health().recoveryActions[0]!.command).toBe('workbench.trust.manage');
    const e = await w.adapter.related({ uri: ORDERS, position: { line: 0, character: 6 } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RouteUnavailableError);
    expect((e as RouteUnavailableError).reasonCode).toBe('TrustRequired');
    expect(w.contexts).toHaveLength(0);
  });

  it('a missing server binary → Failed with ServerNotFound and the message', async () => {
    const w = setup({ connectError: new StartupError('ServerNotFound', 'not bundled for this platform') });
    w.open(ORDERS);
    await w.settle();
    await w.settle();
    expect(w.adapter.health()).toMatchObject({ state: 'Failed', reasonCode: 'ServerNotFound', message: 'not bundled for this platform' });
  });

  it('an environment note (e.g. cargo missing) makes the route Partial but it still answers', async () => {
    const w = setup({ env: true });
    w.open(ORDERS);
    const r = await w.adapter.search({ query: 'get_order', filters: {}, limit: 10 });
    expect(r.value.items).toHaveLength(1);
    expect(w.adapter.health()).toMatchObject({ state: 'Partial', reasonCode: 'CargoNotFound', message: 'cargo missing' });
  });

  it('crash → new epoch after the backoff delay with all open documents replayed; too many crashes → Failed', async () => {
    const w = setup();
    const epochs: (string | undefined)[] = [];
    w.adapter.onDidChangeEpoch((e) => epochs.push(e));
    w.open(ORDERS);
    w.open(USE);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    w.servers[0]!.crash();
    expect(w.adapter.health().state).toBe('Restarting');
    expect(w.servers).toHaveLength(1);
    w.clock.advance(100);
    await w.settle();
    await w.settle();
    expect(w.servers).toHaveLength(2);
    expect([...w.servers[1]!.docs.keys()].sort()).toEqual([ORDERS, USE]);
    expect(w.adapter.health()).toMatchObject({ state: 'Ready', restartCount: 1 });
    expect(epochs.filter((e) => e === undefined)).toHaveLength(1);
    w.servers[1]!.crash();
    w.clock.advance(200);
    await w.settle();
    await w.settle();
    w.servers[2]!.crash();
    expect(w.adapter.health()).toMatchObject({ state: 'Failed', reasonCode: 'ServerCrashed' });
  });

  it('dispose shuts the server down (shutdown/exit + process-tree kill in infrastructure)', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    await w.adapter.dispose();
    adapter = undefined;
    expect(w.servers[0]!.shutDown).toBe(true);
  });
});

describe('document sync (Refyntra owns what the server sees)', () => {
  it('didOpen/didChange/didClose with strictly increasing versions; unchanged saves send nothing', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    const s = w.servers[0]!;
    const v1 = s.docs.get(ORDERS)!.version;
    w.tracker.change(ORDERS, 'python', 2, 'def get_order(x):\n    return x\n');
    const v2 = s.docs.get(ORDERS)!.version;
    expect(v2).toBeGreaterThan(v1);
    expect(s.docs.get(ORDERS)!.text).toBe('def get_order(x):\n    return x\n');
    const before = s.notes.length;
    w.tracker.save(ORDERS, 'python', 2, 'def get_order(x):\n    return x\n');
    expect(s.notes.length).toBe(before);
    w.tracker.close(ORDERS);
    expect(s.docs.has(ORDERS)).toBe(false);
    expect(s.notes.at(-1)!.method).toBe('textDocument/didClose');
  });

  it('a result computed while a document changed is dropped as stale (the engine retries)', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    w.servers[0]!.during = () => {
      w.servers[0]!.during = undefined;
      w.tracker.change(ORDERS, 'python', 2, 'def get_order(y):\n    return y\n');
    };
    await expect(w.adapter.related({ uri: ORDERS, position: { line: 0, character: 6 } })).rejects.toBeInstanceOf(StaleResultError);
  });

  it('ContentModified from the server → stale; cancellation → CancelledError', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    w.servers[0]!.handlers['workspace/symbol'] = () => {
      throw new RpcError(-32801, 'content modified');
    };
    await expect(w.adapter.search({ query: 'get', filters: {}, limit: 5 })).rejects.toBeInstanceOf(StaleResultError);
    const c = new CancellationSource();
    c.cancel();
    await expect(w.adapter.search({ query: 'get', filters: {}, limit: 5 }, c.token)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('features', () => {
  it('Find keeps Python symbols only and drops malformed entries; LSP kinds are mapped', async () => {
    const w = setup();
    w.open(ORDERS);
    const r = await w.adapter.search({ query: 'get_order', filters: {}, limit: 10 });
    expect(r.value.items.map((i) => [i.symbol!.name, i.symbol!.kind])).toEqual([['get_order', 'method']]);
    expect(r.value.items[0]!.symbol!.provenance).toMatchObject({ kind: 'delegated', providerRouteId: 'python.pyright' });
  });

  it('Related: declarations and references (malformed locations dropped), completeness unknown', async () => {
    const w = setup();
    w.open(USE);
    const r = await w.adapter.related({ uri: USE, position: { line: 1, character: 10 } });
    expect(r.value.subject?.name).toBe('get_order');
    expect(r.value.relations.map((x) => [x.group, x.target.location!.uri])).toEqual([
      ['declarations', ORDERS],
      ['references', USE],
    ]);
    expect(r.value.completeness).toBe('unknown');
  });

  it('Actions: rename limited, requires a trusted workspace, framework relations unavailable', async () => {
    const w = setup();
    w.open(USE);
    const r = await w.adapter.capabilities({ uri: USE });
    const byId = Object.fromEntries(r.value.map((a) => [a.capabilityId, a]));
    expect(byId['python.rename']).toMatchObject({ state: 'limited', guarantee: 'delegated', requiredTrust: 'workspace' });
    expect(byId['python.frameworkRelations']!.reasonCode).toBe('NoFrameworkModule');
  });
});

describe('rename', () => {
  const at = { uri: ORDERS, position: { line: 0, character: 4 } };

  it('prepare: a limited delegated plan that records the server document versions; revalidate passes on identical edits', async () => {
    const w = setup();
    w.open(ORDERS);
    w.open(USE);
    const r = await w.adapter.delegatedRename.prepare({ ...at, newName: 'fetch_order' });
    expect(r.value.kind).toBe('prepared');
    if (r.value.kind !== 'prepared') return;
    const plan = r.value.plan;
    expect(plan.writeSet.map((c) => c.uri).sort()).toEqual([CLOSED, ORDERS, USE]);
    expect(plan.serverSession).toMatchObject({ server: 'Pyright', processOwner: 'refyntra' });
    expect(plan.serverSession!.documentVersions.map((v) => v.uri)).toEqual([ORDERS, USE]);
    expect(plan.validation).toMatchObject({ status: 'limited', compilationDelta: 'not-run' });
    const v = await w.adapter.delegatedRename.revalidate(plan);
    expect(v.status).toBe('limited');
    expect(plan.validation.returnedEditsMatchedPreview).toBe(true);
  });

  it('revalidate: a different edit, a changed document or a restarted server → stale', async () => {
    const w = setup();
    w.open(ORDERS);
    const r = await w.adapter.delegatedRename.prepare({ ...at, newName: 'fetch_order' });
    if (r.value.kind !== 'prepared') throw new Error('not prepared');
    w.servers[0]!.handlers['textDocument/rename'] = (p, s) => {
      const out = renameHandler(p, s) as any;
      out.documentChanges[0].edits.pop();
      return out;
    };
    expect((await w.adapter.delegatedRename.revalidate(r.value.plan)).status).toBe('stale');
    w.servers[0]!.handlers['textDocument/rename'] = renameHandler;
    w.disk[CLOSED] = 'from app.orders import get_order\nthird = get_order(3)\n';
    expect((await w.adapter.delegatedRename.revalidate(r.value.plan)).status).toBe('stale');
    w.disk[CLOSED] = DISK[CLOSED]!;
    w.servers[0]!.crash();
    expect(await w.adapter.delegatedRename.revalidate(r.value.plan)).toMatchObject({ status: 'stale', reasonCode: 'RouteChanged' });
  });

  it('a server edit on an older version of an open document is refused (DocumentChanged)', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    w.servers[0]!.handlers['textDocument/rename'] = (p, s) => {
      const out = renameHandler(p, s) as any;
      out.documentChanges[0].textDocument.version -= 1;
      return out;
    };
    const r = await w.adapter.delegatedRename.prepare({ ...at, newName: 'fetch_order' });
    expect(r.value).toMatchObject({ kind: 'unavailable', reasonCode: 'DocumentChanged' });
  });

  it('file operations (resource changes) are refused in this version', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    w.servers[0]!.handlers['textDocument/rename'] = () => ({ documentChanges: [{ kind: 'rename', oldUri: ORDERS, newUri: 'file:///ws/app/x.py' }] });
    const r = await w.adapter.delegatedRename.prepare({ ...at, newName: 'fetch_order' });
    expect(r.value).toMatchObject({ kind: 'unavailable', reasonCode: 'ResourceOperation' });
  });

  it('a closed-file edit that does not replace the old name (server saw other text) is refused', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    w.servers[0]!.handlers['textDocument/rename'] = (p) => ({ changes: { [CLOSED]: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, newText: p.newName }] } });
    const r = await w.adapter.delegatedRename.prepare({ ...at, newName: 'fetch_order' });
    expect(r.value).toMatchObject({ kind: 'unavailable', reasonCode: 'ServerViewMismatch' });
  });

  it('malformed rename answers are refused, never guessed; invalid names never reach the server', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.search({ query: 'x', filters: {}, limit: 1 });
    expect((await w.adapter.delegatedRename.prepare({ ...at, newName: 'class' })).value).toMatchObject({ kind: 'unavailable', reasonCode: 'InvalidName' });
    expect(w.servers[0]!.requests).not.toContain('textDocument/rename');
    w.servers[0]!.handlers['textDocument/rename'] = () => ({ changes: { [ORDERS]: [{ range: { start: { line: 0 } }, newText: 1 }] } });
    expect((await w.adapter.delegatedRename.prepare({ ...at, newName: 'fetch_order' })).value).toMatchObject({ kind: 'unavailable', reasonCode: 'OpaqueEdit' });
    expect(readLspWorkspaceEdit({ changes: { 'untitled:1': [] } })).toMatchObject({ ok: false, reasonCode: 'NonFileTarget' });
  });
});

describe('Rust language rules', () => {
  it('descriptor and limitations name the bundled rust-analyzer and the toolchain', () => {
    expect(RUST_LSP_LANGUAGE.descriptor).toMatchObject({ providerRouteId: 'rust.rust-analyzer', fileExtensions: ['.rs'], ownership: 'delegated' });
    expect(RUST_LSP_LANGUAGE.renameLimitations.join(' ')).toMatch(/cargo/);
    expect(RUST_LSP_LANGUAGE.rules.validateNewName!('r#match', 'x')).toBeUndefined();
  });
});

describe('refactoring code actions', () => {
  const range = { start: { line: 1, character: 11 }, end: { line: 1, character: 19 } };
  // "Extract into variable": `order_id` on line 2 becomes a local.
  const extractEdit = (s: FakeServer) => ({
    documentChanges: [
      {
        textDocument: { uri: ORDERS, version: s.docs.get(ORDERS)!.version },
        edits: [
          { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } }, newText: 'value = order_id\n    ' },
          { range, newText: 'value' },
        ],
      },
    ],
  });
  const withActions = (w: ReturnType<typeof setup>, resolve = false) => {
    const s = w.servers[0]!;
    s.serverCapabilities = { ...s.serverCapabilities, codeActionProvider: resolve ? { resolveProvider: true } : true };
    s.handlers['textDocument/codeAction'] = (p: any, srv) => {
      expect(p.context.only).toEqual(['refactor']);
      return [
        { title: 'Extract into variable', kind: 'refactor.extract', ...(resolve ? { data: 1 } : { edit: extractEdit(srv) }) },
        { title: 'Run a command', kind: 'refactor.rewrite', command: { title: 'x', command: 'server.cmd' } },
        { title: 'Disabled', kind: 'refactor.inline', disabled: { reason: 'no' }, edit: extractEdit(srv) },
        { title: 'Organize imports', kind: 'source.organizeImports', edit: extractEdit(srv) },
        { title: 'Bare command', command: 'x' },
      ];
    };
    s.handlers['codeAction/resolve'] = (a: any, srv) => ({ ...a, edit: extractEdit(srv) });
  };

  it('lists only edit-based refactor actions; prepare builds a limited delegated plan; revalidate re-asks and compares', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.delegatedRename.listActions!(ORDERS, range); // starts the server
    withActions(w);
    const list = await w.adapter.delegatedRename.listActions!(ORDERS, range);
    expect(list.value).toEqual([{ title: 'Extract into variable', kind: 'refactor.extract' }]);
    const r = await w.adapter.delegatedRename.prepareAction!({ uri: ORDERS, range, kind: 'refactor.extract', title: 'Extract into variable' });
    if (r.value.kind !== 'prepared') throw new Error(JSON.stringify(r.value));
    const plan = r.value.plan;
    expect(plan.origin.codeAction).toEqual({ range, kind: 'refactor.extract', title: 'Extract into variable' });
    expect(plan.title).toBe('Extract into variable');
    expect(plan.writeSet.map((c) => c.uri)).toEqual([ORDERS]);
    expect(plan.validation).toMatchObject({ status: 'limited', compilationDelta: 'not-run' });
    expect((await w.adapter.delegatedRename.revalidate(plan)).status).toBe('limited');
    expect(plan.validation.returnedEditsMatchedPreview).toBe(true);
    // The server now returns a different edit for the same action → stale.
    const s = w.servers[0]!;
    const h = s.handlers['textDocument/codeAction']!;
    s.handlers['textDocument/codeAction'] = (p, srv) => (h(p, srv) as any[]).map((a) => (a.edit && a.title === 'Extract into variable' ? { ...a, edit: { changes: { [ORDERS]: [{ range, newText: 'other' }] } } } : a));
    expect((await w.adapter.delegatedRename.revalidate(plan)).status).toBe('stale');
    // The action is no longer offered → stale.
    s.handlers['textDocument/codeAction'] = () => [];
    expect(await w.adapter.delegatedRename.revalidate(plan)).toMatchObject({ status: 'stale', reasonCode: 'ActionNotOffered' });
  });

  it('resolves an action without an edit (codeAction/resolve); refuses command actions', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.delegatedRename.listActions!(ORDERS, range); // starts the server
    withActions(w, true);
    const r = await w.adapter.delegatedRename.prepareAction!({ uri: ORDERS, range, kind: 'refactor.extract', title: 'Extract into variable' });
    expect(r.value.kind).toBe('prepared');
    expect(w.servers[0]!.requests).toContain('codeAction/resolve');
    const cmd = await w.adapter.delegatedRename.prepareAction!({ uri: ORDERS, range, kind: 'refactor.rewrite', title: 'Run a command' });
    expect(cmd.value).toMatchObject({ kind: 'unavailable', reasonCode: 'CommandOnly' });
  });

  it('no codeActionProvider: nothing is listed', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.delegatedRename.listActions!(ORDERS, range); // starts the server
    expect((await w.adapter.delegatedRename.listActions!(ORDERS, range)).value).toEqual([]);
  });
});

describe('file renames (workspace/willRenameFiles)', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  it('asks a server that wants it and returns its text edits; others are never asked', async () => {
    const w = setup();
    w.open(ORDERS);
    await w.adapter.delegatedRename.listActions!(ORDERS, range); // starts the server
    const s = w.servers[0]!;
    const files = [{ oldUri: USE, newUri: 'file:///ws/app/usage.py' }];
    expect(await w.adapter.willRenameFiles(files)).toEqual([]);
    expect(s.requests).not.toContain('workspace/willRenameFiles');
    s.serverCapabilities = { ...s.serverCapabilities, workspace: { fileOperations: { willRename: { filters: [] }, didRename: { filters: [] } } } };
    s.handlers['workspace/willRenameFiles'] = (p: any) => {
      expect(p.files).toEqual(files);
      return { changes: { [ORDERS]: [{ range, newText: 'x' }] } };
    };
    expect(await w.adapter.willRenameFiles(files)).toEqual([{ uri: ORDERS, edits: [{ range, newText: 'x' }] }]);
    w.adapter.didRenameFiles(files);
    expect(s.notes.some((n) => n.method === 'workspace/didRenameFiles')).toBe(true);
  });
});
