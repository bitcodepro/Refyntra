import type {
  AdapterState,
  Availability,
  InputFingerprint,
  Location,
  PlannedTextChange,
  Position,
  PrepareResult,
  RecoveryAction,
  RefactorPlanDto,
  Relation,
  RelatedResult,
  RevalidateResult,
  SearchItem,
  SearchResult,
  SymbolRef,
} from '@refyntra/contracts';
import { type AdapterHealth, type DelegatedRefactorPlan, RECOVERY_MANAGE_TRUST, RECOVERY_RESTART, RECOVERY_SHOW_HEALTH, delegatedProvenance, locationKey } from '@refyntra/domain';
import {
  type AdapterDescriptor,
  type CancellationToken,
  type CapabilityTarget,
  type Clock,
  type DelegatedPrepareResult,
  type DelegatedRenamePort,
  type DelegatedRenameRequest,
  type Disposable,
  type DocumentEvent,
  type DocumentTracker,
  type LanguageAdapter,
  type Logger,
  type LspConnection,
  type LspConnectionFactory,
  type RelatedTarget,
  type RouteResult,
  type SearchRequest,
  type TrustProvider,
  CancelledError,
  Emitter,
  RouteUnavailableError,
  RpcError,
  StaleResultError,
  StartupError,
  describeError,
  descriptorHandles,
  throwIfCancelled,
} from '@refyntra/application';
import { type DocumentReader, type Hasher, type ProviderSymbol, applyEdits, basename, comparePos, hasMixedLineEndings, hasOverlap, identifierAt, isMemberSymbol, isTypeSymbol, sortEdits, textInRange } from '@refyntra/adapter-vscode-providers';
import { readLspDocumentSymbols, readLspLocations, readLspWorkspaceEdit, readLspWorkspaceSymbols } from './convert';
import type { LspLanguage } from './languages';

/** A note about the environment the server runs in (e.g. Rust: cargo is not installed), shown in Health. */
export interface EnvironmentNote {
  reasonCode: string;
  message: string;
  recoveryActions?: RecoveryAction[];
}

export interface LspLanguageAdapterOptions {
  language: LspLanguage;
  workspaceId: string;
  /** Starts one initialized server session (infrastructure: createLspConnectionFactory). */
  connect: LspConnectionFactory;
  tracker: DocumentTracker;
  trust: TrustProvider;
  clock: Clock;
  logger: Logger;
  /** Reads documents as the editor shows them (open buffer, or the file on disk). */
  documents: DocumentReader;
  hash: Hasher;
  workspaceFolders: () => readonly { uri: string; name: string }[];
  /** Checked when a session starts; a note makes the route Partial with that reason (it still answers). */
  environment?: () => Promise<EnvironmentNote | undefined>;
  /**
   * Canonical form of a URI the server returns (VS Code's `Uri.parse(u).toString()`): servers may spell the same file
   * differently (e.g. `c:` vs `c%3A`), and Refyntra compares URIs as strings.
   */
  normalizeUri?: (uri: string) => string;
  /** Files changed on disk (closed documents): forwarded as workspace/didChangeWatchedFiles. */
  onDidChangeFiles?: (listener: (changes: readonly { uri: string; type: 1 | 2 | 3 }[]) => void) => Disposable;
  /** Restart delays after unexpected exits; more exits than delays within `crashWindowMs` → Failed. */
  restartDelaysMs?: readonly number[];
  crashWindowMs?: number;
  /** How long a request may wait for a starting server (default 120 s). */
  startWaitMs?: number;
  /** How long to wait for rust-analyzer's quiescent status before reporting Ready anyway (default 90 s). */
  quiescenceTimeoutMs?: number;
}

interface Observation {
  epoch: string;
  revision: number;
  observationId: string;
  session: Session;
}

interface Session {
  conn: LspConnection;
  epoch: string;
  /** Versions and texts Refyntra sent for the documents the server has open. */
  open: Map<string, { version: number; text: string }>;
  subs: Disposable[];
  closedByUs: boolean;
}

type RenameObservation =
  | { kind: 'ok'; oldName: string; changes: PlannedTextChange[]; inputs: InputFingerprint[]; versions: { uri: string; version: number }[] }
  | { kind: 'unavailable'; reasonCode: string; message: string; nativeFallback: boolean };

const unavailableObs = (reasonCode: string, message: string, nativeFallback = false): RenameObservation => ({ kind: 'unavailable', reasonCode, message, nativeFallback });

function matchScore(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 50;
  return n.includes(q) ? 20 : 10;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * LanguageAdapter over a language server process Refyntra starts and owns (bundled Pyright / rust-analyzer). The
 * semantic engine is third-party, so results and plans stay `delegated` (ADR-002 amendment), but Refyntra owns the
 * process (trust gate, lazy start, restart with backoff, process-tree kill) and the server's view of the documents
 * (didOpen/didChange/didClose with recorded versions): a result computed while a document changed is dropped, and a
 * rename plan records the document versions the server used and is re-asked on the same versions before apply.
 */
export class LspLanguageAdapter implements LanguageAdapter {
  readonly descriptor: AdapterDescriptor;
  readonly language: LspLanguage;
  private readonly o: LspLanguageAdapterOptions;
  private state: AdapterState = 'NotStarted';
  private reason: { reasonCode?: string; message?: string; recoveryActions: RecoveryAction[] } = { recoveryActions: [] };
  private envNote: EnvironmentNote | undefined;
  private session: Session | undefined;
  private starting: Promise<Session> | undefined;
  private epochCounter = 0;
  private observationCounter = 0;
  private planCounter = 0;
  private restartCount = 0;
  private crashTimes: number[] = [];
  private restartTimer: Disposable | undefined;
  private disposed = false;
  private generation = 0;
  private filesSub: Disposable | undefined;
  private readonly healthEmitter = new Emitter<AdapterHealth>();
  private readonly epochEmitter = new Emitter<string | undefined>();
  readonly onDidChangeHealth = this.healthEmitter.event;
  readonly onDidChangeEpoch = this.epochEmitter.event;
  readonly delegatedRename: DelegatedRenamePort = {
    prepare: (req, token) => this.prepareDelegated(req, token),
    revalidate: (plan, token) => this.revalidateDelegated(plan, token),
  };
  /** Number of sessions started (tests: Restricted Mode never starts one). */
  sessionsStarted = 0;

  constructor(options: LspLanguageAdapterOptions) {
    this.o = options;
    this.language = options.language;
    this.descriptor = options.language.descriptor;
    this.filesSub = options.onDidChangeFiles?.((changes) => {
      const s = this.session;
      const mine = changes.filter((c) => this.handles(c.uri) || /\/(Cargo\.toml|Cargo\.lock|pyproject\.toml|pyrightconfig\.json)$/i.test(c.uri));
      if (!s || mine.length === 0) return;
      try {
        s.conn.notify('workspace/didChangeWatchedFiles', { changes: mine.map((c) => ({ uri: c.uri, type: c.type })) });
      } catch {
        // The session is closing; a new one reads the files afresh.
      }
    });
  }

  handles(uri: string, languageId?: string): boolean {
    return descriptorHandles(this.descriptor, uri, languageId);
  }

  health(): AdapterHealth {
    const message =
      this.state === 'Ready' ? this.language.readyMessage : this.state === 'Partial' ? this.envNote?.message ?? this.reason.message : this.reason.message ?? (this.state === 'NotStarted' ? this.language.notStartedMessage : undefined);
    const reasonCode = this.state === 'Partial' ? this.envNote?.reasonCode : this.reason.reasonCode;
    const recovery = this.state === 'Partial' ? this.envNote?.recoveryActions ?? [] : this.reason.recoveryActions;
    return {
      adapterId: this.descriptor.adapterId,
      providerRouteId: this.descriptor.providerRouteId,
      displayName: this.descriptor.displayName,
      state: this.state,
      ...(message ? { message } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      recoveryActions: recovery,
      ...(this.session ? { sessionEpoch: this.session.epoch } : {}),
      projects: [],
      diagnostics: [],
      restartCount: this.restartCount,
      hostDescription: `${this.language.serverName} language server bundled with Refyntra (own process, no other extension)`,
    };
  }

  currentEpoch(): string | undefined {
    return this.session?.epoch;
  }

  private setState(state: AdapterState, reason: { reasonCode?: string; message?: string; recoveryActions?: RecoveryAction[] } = {}): void {
    this.state = state;
    this.reason = { ...reason, recoveryActions: reason.recoveryActions ?? [] };
    if (!this.disposed) this.healthEmitter.fire(this.health());
  }

  private trusted(): boolean {
    return this.o.trust.isTrusted();
  }

  private trustRequired(): void {
    this.setState('TrustRequired', {
      reasonCode: 'TrustRequired',
      message: `Workspace is in Restricted Mode. Refyntra does not start ${this.language.serverName} (it reads project configuration${this.language.capabilityPrefix === 'rust' ? ' and runs cargo, build scripts and proc-macros' : ''}) until you trust the workspace.`,
      recoveryActions: [RECOVERY_MANAGE_TRUST],
    });
  }

  private hasOpenDocuments(): boolean {
    return this.o.tracker.openDocuments().some((d) => this.handles(d.uri, d.languageId));
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.trusted()) return this.trustRequired();
    if (this.session || this.starting) return;
    if (this.hasOpenDocuments()) {
      await this.ensureSession().catch(() => undefined);
      return;
    }
    this.setState('NotStarted');
  }

  async restart(_reason: string): Promise<void> {
    this.restartCount += 1;
    this.crashTimes = [];
    await this.stopSession();
    await this.start();
  }

  private async stopSession(): Promise<void> {
    this.generation += 1;
    this.restartTimer?.dispose();
    this.restartTimer = undefined;
    const s = this.session;
    this.session = undefined;
    this.starting = undefined;
    if (s) {
      s.closedByUs = true;
      for (const d of s.subs) d.dispose();
      this.epochEmitter.fire(undefined);
      await s.conn.shutdown().catch(() => undefined);
    }
  }

  /** Lazily starts the server (trusted workspaces only); single flight. */
  private ensureSession(): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    if (this.starting) return this.starting;
    if (!this.trusted()) {
      this.trustRequired();
      return Promise.reject(new RouteUnavailableError('TrustRequired', this.reason.message!, [RECOVERY_MANAGE_TRUST]));
    }
    const generation = this.generation;
    this.setState(this.restartCount > 0 || this.sessionsStarted > 0 ? 'Restarting' : 'Loading', { message: `Starting ${this.language.serverName}…` });
    const p = this.launch(generation);
    this.starting = p;
    p.then(
      () => {
        if (this.starting === p) this.starting = undefined;
      },
      () => {
        if (this.starting === p) this.starting = undefined;
      },
    );
    return p;
  }

  private async launch(generation: number): Promise<Session> {
    const attempt = this.sessionsStarted + 1;
    let conn: LspConnection;
    try {
      conn = await this.o.connect({ providerRouteId: this.descriptor.providerRouteId, attempt, workspaceFolders: this.o.workspaceFolders() });
    } catch (e) {
      const code = e instanceof StartupError ? e.reasonCode : 'ServerStartFailed';
      const message = describeError(e);
      this.o.logger.log('error', `lsp:${this.language.capabilityPrefix}`, 'language server start failed', { reasonCode: code, error: message });
      if (generation === this.generation && !this.disposed) this.setState('Failed', { reasonCode: code, message, recoveryActions: code === 'ServerNotFound' ? [RECOVERY_SHOW_HEALTH] : [RECOVERY_RESTART, RECOVERY_SHOW_HEALTH] });
      throw new RouteUnavailableError(code, message, [RECOVERY_SHOW_HEALTH]);
    }
    this.sessionsStarted += 1;
    if (generation !== this.generation || this.disposed) {
      await conn.shutdown().catch(() => undefined);
      throw new RouteUnavailableError('Restarting', `${this.language.serverName} was restarted.`);
    }
    this.epochCounter += 1;
    const session: Session = { conn, epoch: `${this.o.workspaceId}-${this.language.capabilityPrefix}-lsp-${this.epochCounter}`, open: new Map(), subs: [], closedByUs: false };
    session.subs.push(conn.onClose((err) => this.onSessionClosed(session, err)));
    // Replay: the server sees exactly the open documents of this language, with versions Refyntra assigns.
    for (const d of this.o.tracker.openDocuments()) if (this.handles(d.uri, d.languageId)) this.sendOpen(session, d.uri, d.text);
    let quiet: Promise<void> = Promise.resolve();
    if (this.language.waitForQuiescence) {
      quiet = new Promise<void>((resolve) => {
        const timer = this.o.clock.setTimeout(resolve, this.o.quiescenceTimeoutMs ?? 90000);
        session.subs.push(timer);
        session.subs.push(
          conn.onNotification((method, params) => {
            if (method !== 'experimental/serverStatus') return;
            const p = params as { quiescent?: unknown; health?: unknown; message?: unknown } | undefined;
            if (p?.health === 'error' || p?.health === 'warning') this.o.logger.log('warn', `lsp:${this.language.capabilityPrefix}`, 'server status', { health: String(p.health) });
            if (p?.quiescent === true) resolve();
          }),
        );
      });
    }
    this.session = session;
    this.epochEmitter.fire(session.epoch);
    this.setState('Loading', { message: `${this.language.serverName} is loading the workspace…` });
    const env = await (this.o.environment?.().catch(() => undefined) ?? Promise.resolve(undefined));
    await quiet;
    if (this.session !== session) throw new RouteUnavailableError('Restarting', `${this.language.serverName} was restarted.`);
    this.envNote = env;
    this.setState(env ? 'Partial' : 'Ready');
    return session;
  }

  private onSessionClosed(session: Session, err?: Error): void {
    if (session.closedByUs || this.session !== session || this.disposed) return;
    this.session = undefined;
    for (const d of session.subs) d.dispose();
    this.epochEmitter.fire(undefined);
    const now = this.o.clock.now();
    const windowMs = this.o.crashWindowMs ?? 180000;
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < windowMs), now];
    const delays = this.o.restartDelaysMs ?? [1000, 4000, 15000];
    this.o.logger.log('warn', `lsp:${this.language.capabilityPrefix}`, 'language server exited unexpectedly', { error: err ? describeError(err) : undefined, crashes: this.crashTimes.length });
    if (this.crashTimes.length > delays.length) {
      this.setState('Failed', { reasonCode: 'ServerCrashed', message: `${this.language.serverName} stopped ${this.crashTimes.length} times in a short time. Restart it from Health when the cause is fixed.`, recoveryActions: [RECOVERY_RESTART, RECOVERY_SHOW_HEALTH] });
      return;
    }
    this.restartCount += 1;
    this.setState('Restarting', { reasonCode: 'ServerExited', message: `${this.language.serverName} exited; restarting.` });
    const generation = this.generation;
    this.restartTimer = this.o.clock.setTimeout(() => {
      this.restartTimer = undefined;
      if (generation !== this.generation || this.disposed || this.session) return;
      if (!this.trusted()) return this.trustRequired();
      void this.ensureSession().catch(() => undefined);
    }, delays[this.crashTimes.length - 1]!);
  }

  // ---------------------------------------------------------------- document sync (Refyntra owns the server's view)

  private sendOpen(s: Session, uri: string, text: string): void {
    const version = this.o.tracker.sequence;
    s.open.set(uri, { version, text });
    this.safeNotify(s, 'textDocument/didOpen', { textDocument: { uri, languageId: this.language.languageId, version, text } });
  }

  private safeNotify(s: Session, method: string, params: unknown): void {
    try {
      s.conn.notify(method, params);
    } catch (e) {
      this.o.logger.log('warn', `lsp:${this.language.capabilityPrefix}`, 'notification failed', { method, error: describeError(e) });
    }
  }

  documentEvent(e: DocumentEvent): void {
    if (this.disposed) return;
    const s = this.session;
    if (!s) {
      if (e.kind === 'open' && !this.starting) {
        if (this.trusted()) void this.ensureSession().catch(() => undefined);
        else if (this.state !== 'TrustRequired') this.trustRequired();
      }
      return; // A starting session replays every open document once it is up.
    }
    if (e.kind === 'close') {
      if (s.open.delete(e.uri)) this.safeNotify(s, 'textDocument/didClose', { textDocument: { uri: e.uri } });
      return;
    }
    if (e.text === undefined) return;
    const known = s.open.get(e.uri);
    if (!known) return this.sendOpen(s, e.uri, e.text);
    if (known.text === e.text) return;
    // Versions are the tracker's global document sequence: strictly increasing for every document.
    const version = e.documentSequence;
    s.open.set(e.uri, { version, text: e.text });
    this.safeNotify(s, 'textDocument/didChange', { textDocument: { uri: e.uri, version }, contentChanges: [{ text: e.text }] });
  }

  discard(_planId: string): void {}

  async dispose(): Promise<void> {
    this.disposed = true;
    this.filesSub?.dispose();
    await this.stopSession();
    this.state = 'NotStarted';
    this.healthEmitter.dispose();
    this.epochEmitter.dispose();
  }

  // ---------------------------------------------------------------- request helpers

  private async begin(token?: CancellationToken): Promise<Observation> {
    throwIfCancelled(token);
    let session = this.session;
    if (!session) {
      if (this.state === 'Failed') throw new RouteUnavailableError(this.reason.reasonCode ?? 'Failed', this.reason.message ?? `${this.language.serverName} is not running.`, this.reason.recoveryActions);
      const wait = this.o.startWaitMs ?? 120000;
      let timer: Disposable | undefined;
      try {
        session = await Promise.race([
          this.ensureSession(),
          new Promise<never>((_, reject) => {
            timer = this.o.clock.setTimeout(() => reject(new RouteUnavailableError('Loading', `${this.language.serverName} is still starting; try again in a moment.`, [RECOVERY_SHOW_HEALTH])), wait);
          }),
        ]);
      } finally {
        timer?.dispose();
      }
    }
    throwIfCancelled(token);
    this.observationCounter += 1;
    return { epoch: session.epoch, revision: this.o.tracker.revision, observationId: `${session.epoch}-obs-${this.observationCounter}`, session };
  }

  /** A result computed while a document of the workspace changed (new server version) or the session changed is dropped. */
  private finish(b: Observation, token?: CancellationToken): void {
    throwIfCancelled(token);
    if (this.session?.epoch !== b.epoch) throw new StaleResultError('epoch');
    if (this.o.tracker.revision !== b.revision) throw new StaleResultError('revision');
  }

  private result<T>(b: Observation, value: T): RouteResult<T> {
    return { value, providerRouteId: this.descriptor.providerRouteId, sessionEpoch: b.epoch, snapshotId: 'unknown', workspaceRevision: b.revision };
  }

  private async req(b: Observation, method: string, params: unknown, token?: CancellationToken): Promise<unknown> {
    try {
      return await b.session.conn.request(method, params, token);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      // RequestCancelled / ContentModified / ServerCancelled: the server's view moved on → stale, retried by the engine.
      if (e instanceof RpcError && (e.code === -32800 || e.code === -32801 || e.code === -32802)) throw new StaleResultError('backend');
      if (this.session !== b.session) throw new StaleResultError('epoch');
      throw e;
    }
  }

  private async tryReq(b: Observation, method: string, params: unknown, token?: CancellationToken): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await this.req(b, method, params, token) };
    } catch (e) {
      if (e instanceof CancelledError || e instanceof StaleResultError) throw e;
      this.o.logger.log('warn', `lsp:${this.language.capabilityPrefix}`, 'request failed', { method, error: describeError(e) });
      return { ok: false, error: describeError(e) };
    }
  }

  private uri(u: string): string {
    try {
      return this.o.normalizeUri ? this.o.normalizeUri(u) : u;
    } catch {
      return u;
    }
  }

  private loc<T extends { uri: string }>(l: T): T {
    return { ...l, uri: this.uri(l.uri) };
  }

  private sym(s: ProviderSymbol): ProviderSymbol {
    return { ...s, location: this.loc(s.location) };
  }

  private symbolRef(s: ProviderSymbol, observationId: string): SymbolRef {
    return {
      name: s.name,
      displayName: s.containerName ? `${s.containerName}.${s.name}` : s.name,
      kind: s.kind,
      ...(s.containerName ? { containerName: s.containerName } : {}),
      location: s.location,
      origin: 'source',
      provenance: delegatedProvenance(this.descriptor.providerRouteId, observationId),
    };
  }

  private async documentSymbols(b: Observation, uri: string, token?: CancellationToken): Promise<ProviderSymbol[] | undefined> {
    const r = await this.tryReq(b, 'textDocument/documentSymbol', { textDocument: { uri } }, token);
    return r.ok ? readLspDocumentSymbols(r.value ?? [], uri) : undefined;
  }

  private static symbolAtPosition(symbols: readonly ProviderSymbol[], position: Position): ProviderSymbol | undefined {
    const hits = symbols.filter((s) => comparePos(s.location.range.start, position) <= 0 && comparePos(position, s.location.range.end) <= 0);
    return hits.sort((a, c) => comparePos(c.location.range.start, a.location.range.start))[0];
  }

  // ---------------------------------------------------------------- Find

  async search(req: SearchRequest, token?: CancellationToken): Promise<RouteResult<SearchResult>> {
    const b = await this.begin(token);
    const f = req.filters;
    let items: SearchItem[] = [];
    if (!f.route && !f.method && !f.project && !f.entity && f.table === undefined && req.query.trim().length > 0) {
      const r = await this.tryReq(b, 'workspace/symbol', { query: req.query.trim() }, token);
      if (!r.ok) throw new RouteUnavailableError('ServerError', `${this.language.serverName} failed to search symbols: ${r.error}`, [RECOVERY_SHOW_HEALTH]);
      const seen = new Set<string>();
      for (const s of (readLspWorkspaceSymbols(r.value ?? []) ?? []).map((x) => this.sym(x))) {
        if (!this.handles(s.location.uri)) continue;
        if (f.type && !isTypeSymbol(s)) continue;
        if (f.member && !isMemberSymbol(s)) continue;
        const key = `${locationKey(s.location)}|${s.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ symbol: this.symbolRef(s, b.observationId), score: matchScore(s.name, req.query.trim()) });
      }
    }
    items.sort((x, y) => y.score - x.score || cmpStr(x.symbol!.name, y.symbol!.name));
    const truncated = items.length > req.limit;
    items = items.slice(0, req.limit);
    this.finish(b, token);
    return this.result(b, { items, truncated, snapshotId: 'unknown' });
  }

  async symbolAt(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<SymbolRef | null>> {
    const b = await this.begin(token);
    const symbols = await this.documentSymbols(b, uri, token);
    if (symbols === undefined) throw new RouteUnavailableError('ServerError', `${this.language.serverName} did not return the symbols of ${basename(uri)}.`, [RECOVERY_SHOW_HEALTH]);
    const s = LspLanguageAdapter.symbolAtPosition(symbols, position);
    this.finish(b, token);
    return this.result(b, s ? this.symbolRef(s, b.observationId) : null);
  }

  // ---------------------------------------------------------------- Related

  async related(target: RelatedTarget, token?: CancellationToken): Promise<RouteResult<RelatedResult>> {
    if (!('uri' in target)) throw new RouteUnavailableError('NotSupported', `the ${this.language.name} route has no symbol ids.`);
    const b = await this.begin(token);
    const pos = { textDocument: { uri: target.uri }, position: { line: target.position.line, character: target.position.character } };
    const caps = b.session.conn.serverCapabilities;
    const [defs, refs, impls] = await Promise.all([
      this.tryReq(b, 'textDocument/definition', pos, token),
      this.tryReq(b, 'textDocument/references', { ...pos, context: { includeDeclaration: true } }, token),
      caps.implementationProvider ? this.tryReq(b, 'textDocument/implementation', pos, token) : Promise.resolve({ ok: true as const, value: null }),
    ]);
    if (!defs.ok && !refs.ok) throw new RouteUnavailableError('ServerError', `${this.language.serverName} failed: ${defs.error}`, [RECOVERY_SHOW_HEALTH]);
    const defList = defs.ok ? (readLspLocations(defs.value) ?? []).map((l) => this.loc(l)) : [];
    const refList = refs.ok ? (readLspLocations(refs.value) ?? []).map((l) => this.loc(l)) : [];
    const implList = impls.ok ? (readLspLocations(impls.value) ?? []).map((l) => this.loc(l)) : [];
    if (defList.length === 0 && refList.length === 0) {
      this.finish(b, token);
      throw new RouteUnavailableError('ProviderEmpty', `${this.language.serverName} found no definition or references at this position.`);
    }
    const subject = await this.subjectFor(b, target.uri, target.position, defList, token);
    const provenance = delegatedProvenance(this.descriptor.providerRouteId, b.observationId);
    const relation = (loc: Location, kind: 'declaration' | 'reference' | 'implementation', method: string): Relation => ({
      relationKind: kind,
      group: kind === 'declaration' ? 'declarations' : kind === 'implementation' ? 'implementations' : 'references',
      target: { location: loc, label: `${basename(loc.uri)}:${loc.range.start.line + 1}` },
      evidence: [{ description: `reported by ${this.language.serverName} (${method})`, location: loc }],
      confidence: 'likely',
      provenance,
      limitations: [this.language.findLimitation],
    });
    const declKeys = new Set(defList.map(locationKey));
    const implKeys = new Set(implList.map(locationKey).filter((k) => !declKeys.has(k)));
    const relations: Relation[] = [
      ...defList.map((l) => relation(l, 'declaration', 'textDocument/definition')),
      ...implList.filter((l) => implKeys.has(locationKey(l))).map((l) => relation(l, 'implementation', 'textDocument/implementation')),
      ...refList.filter((l) => !declKeys.has(locationKey(l)) && !implKeys.has(locationKey(l))).map((l) => relation(l, 'reference', 'textDocument/references')),
    ];
    const scopeNotes = [this.language.findLimitation, this.language.frameworkRelationsUnavailable];
    if (this.envNote) scopeNotes.push(this.envNote.message);
    if (!defs.ok) scopeNotes.push(`The definition request failed: ${defs.error}`);
    if (!refs.ok) scopeNotes.push(`The references request failed: ${refs.error}`);
    this.finish(b, token);
    return this.result(b, { subject, relations, completeness: 'unknown', scopeNotes, snapshotId: 'unknown' });
  }

  private async subjectFor(b: Observation, uri: string, position: Position, defs: Location[], token?: CancellationToken): Promise<SymbolRef | null> {
    const def = defs[0];
    if (def) {
      const symbols = await this.documentSymbols(b, def.uri, token);
      const s = symbols && LspLanguageAdapter.symbolAtPosition(symbols, def.range.start);
      if (s) return this.symbolRef(s, b.observationId);
    }
    const doc = await this.o.documents.read(uri);
    const name = doc.ok ? identifierAt(doc.text, position, this.language.rules.identifierPattern) : undefined;
    if (!name) return null;
    return { name, displayName: name, kind: 'other', ...(def ? { location: def } : {}), origin: 'source', provenance: delegatedProvenance(this.descriptor.providerRouteId, b.observationId) };
  }

  // ---------------------------------------------------------------- Actions

  async capabilities(target: CapabilityTarget, token?: CancellationToken): Promise<RouteResult<Availability[]>> {
    const b = await this.begin(token);
    const route = this.descriptor.providerRouteId;
    const scope = { workspaceId: this.o.workspaceId, ...(target.uri ? { documentUri: target.uri } : {}) };
    const item = (capabilityId: string, state: Availability['state'], limitations: string[], extra: Partial<Availability> = {}): Availability => ({
      capabilityId,
      providerRouteId: route,
      scope,
      state,
      recoveryActions: [],
      requiredTrust: 'workspace',
      guarantee: 'delegated',
      limitations,
      ...extra,
    });
    const L = this.language;
    const id = (verb: string) => `${L.capabilityPrefix}.${verb}`;
    const env = this.envNote ? [this.envNote.message] : [];
    const canRename = !!b.session.conn.serverCapabilities.renameProvider;
    const items = [
      item(id('find'), 'available', [L.findLimitation, 'Not a complete index of all languages and projects.', ...env]),
      item(id('related'), 'available', [L.findLimitation, 'Declarations, implementations and references only.', ...env]),
      item(id('references'), 'available', [L.findLimitation, ...env]),
      canRename ? item(id('rename'), 'limited', [...L.renameLimitations]) : item(id('rename'), 'unavailable', [], { reasonCode: 'RenameNotSupported', message: `${L.serverName} does not offer rename.` }),
      item(id('frameworkRelations'), 'unavailable', [], { reasonCode: 'NoFrameworkModule', message: L.frameworkRelationsUnavailable }),
    ];
    return this.result(b, items);
  }

  async prepare(): Promise<RouteResult<PrepareResult>> {
    const b = await this.begin();
    return this.result(b, { kind: 'unavailable', reasonCode: 'DelegatedRoute', message: `The ${this.language.name} route prepares delegated plans only.` });
  }

  async revalidate(_plan: RefactorPlanDto): Promise<RevalidateResult> {
    return { status: 'invalid', reasonCode: 'DelegatedRoute', message: `The ${this.language.name} route has no owned-semantic plans.` };
  }

  // ---------------------------------------------------------------- rename

  private async observeRename(req: DelegatedRenameRequest, b: Observation, token?: CancellationToken): Promise<RenameObservation> {
    const hash = this.o.hash;
    const L = this.language;
    const S = L.serverName;
    const source = await this.o.documents.read(req.uri);
    if (!source.ok) return unavailableObs('DocumentUnavailable', `${basename(req.uri)} cannot be read.`);
    const sourceHash = hash(source.text);
    const pos = { textDocument: { uri: req.uri }, position: { line: req.position.line, character: req.position.character } };
    const caps = b.session.conn.serverCapabilities;
    if (!caps.renameProvider) return unavailableObs('RenameNotSupported', `${S} does not offer rename.`);
    let range: { start: Position; end: Position } | undefined;
    let placeholder: string | undefined;
    const prepareSupported = typeof caps.renameProvider === 'object' && (caps.renameProvider as { prepareProvider?: unknown }).prepareProvider === true;
    if (prepareSupported) {
      const prep = await this.tryReq(b, 'textDocument/prepareRename', pos, token);
      if (!prep.ok) return unavailableObs('NotRenameable', `${S} cannot rename here: ${prep.error}`);
      if (prep.value === null || prep.value === undefined) return unavailableObs('NotRenameable', `${S} cannot rename the code at this position.`);
      const p = prep.value as { placeholder?: unknown; range?: { start?: Position; end?: Position }; start?: Position; end?: Position; defaultBehavior?: unknown };
      const r = p.range ?? (p.start && p.end ? { start: p.start, end: p.end } : undefined);
      if (r?.start && r.end) range = { start: r.start, end: r.end };
      if (typeof p.placeholder === 'string') placeholder = p.placeholder;
    }
    const oldName = placeholder || (range ? textInRange(source.text, range.start, range.end) : undefined) || identifierAt(source.text, req.position, L.rules.identifierPattern) || 'symbol';
    const invalidName = L.rules.validateNewName?.(req.newName, oldName);
    if (invalidName) return unavailableObs('InvalidName', invalidName);
    const refusedAt = L.rules.positionRefusal(source.text, range?.start ?? req.position);
    if (refusedAt) return unavailableObs(refusedAt.reasonCode, refusedAt.message, true);
    const edit = await this.tryReq(b, 'textDocument/rename', { ...pos, newName: req.newName }, token);
    if (!edit.ok) return unavailableObs('NotRenameable', `${S} cannot rename here: ${edit.error}`);
    if (edit.value === null || edit.value === undefined) return unavailableObs('ProviderEmpty', `${S} returned no rename edit.`);
    const read = readLspWorkspaceEdit(edit.value);
    if (!read.ok) return unavailableObs(read.reasonCode, read.message, true);
    if (read.changes.length === 0) return unavailableObs('ProviderEmpty', `${S} returned no changes.`);
    const changes: PlannedTextChange[] = [];
    const inputs = new Map<string, string>([[req.uri, sourceHash]]);
    const versions: { uri: string; version: number }[] = [];
    const bareOld = oldName.replace(/^r#/, '');
    const merged = new Map<string, (typeof read.changes)[number]>();
    for (const c of read.changes) {
      const u = this.uri(c.uri);
      const prev = merged.get(u);
      merged.set(u, prev ? { uri: u, version: prev.version ?? c.version ?? null, edits: [...prev.edits, ...c.edits] } : { ...c, uri: u });
    }
    for (const change of [...merged.values()].sort((x, y) => cmpStr(x.uri, y.uri))) {
      const name = basename(change.uri);
      const doc = change.uri === req.uri ? source : await this.o.documents.read(change.uri);
      if (!doc.ok) {
        if (doc.reason === 'not-utf8') return unavailableObs('UnsupportedEncoding', `${name} is not UTF-8; Refyntra applies text edits to UTF-8 files only.`, true);
        if (doc.reason === 'not-file') return unavailableObs('NonFileTarget', `${name} is not a local file.`, true);
        return unavailableObs('DocumentUnavailable', `${name} cannot be read.`, true);
      }
      const sent = b.session.open.get(change.uri);
      if (sent) {
        // An open document: the server must have edited exactly the text Refyntra sent it, at the version it sent.
        if (sent.text !== doc.text) return unavailableObs('DocumentChanged', `${name} changed while ${S} computed the rename. Run Rename again.`);
        if (typeof change.version === 'number' && change.version !== sent.version) return unavailableObs('DocumentChanged', `${S} computed the edit of ${name} on version ${change.version}, but Refyntra sent version ${sent.version}. Run Rename again.`);
        versions.push({ uri: change.uri, version: sent.version });
      } else if (hasMixedLineEndings(doc.text)) {
        return unavailableObs('MixedLineEndings', `${name} has mixed line endings; VS Code would normalize it when opening, so the preview could not match the result.`, true);
      }
      const edits = sortEdits(change.edits);
      if (hasOverlap(edits)) return unavailableObs('OverlappingEdits', `The ${S} edit for ${name} has overlapping changes.`, true);
      if (!sent) {
        // A closed file is read by the server from disk; its edits must replace the old name in the text we read.
        for (const e of edits) {
          const old = textInRange(doc.text, e.range.start, e.range.end);
          if (old === undefined || (old.length > 0 && !old.replace(/^r#/, '').includes(bareOld))) {
            return unavailableObs('ServerViewMismatch', `The ${S} edit for ${name} does not match the file on disk (it may have changed). Run Rename again.`);
          }
        }
      }
      const refused = L.rules.editRefusal?.(doc.text, edits, oldName);
      if (refused) return unavailableObs(refused.reasonCode, `${name}: ${refused.message}`, true);
      let resultText: string;
      try {
        resultText = applyEdits(doc.text, edits);
      } catch {
        return unavailableObs('EditOutsideDocument', `The ${S} edit does not fit the current text of ${name}.`, true);
      }
      const expectedHash = hash(doc.text);
      inputs.set(change.uri, expectedHash);
      changes.push({ kind: 'text', uri: change.uri, expectedHash, resultHash: hash(resultText), edits });
    }
    const again = await this.o.documents.read(req.uri);
    throwIfCancelled(token);
    if (!again.ok || hash(again.text) !== sourceHash || this.o.tracker.revision !== b.revision || this.session?.epoch !== b.epoch) {
      return unavailableObs('DocumentChanged', 'A document was edited while the rename was being prepared. Run Rename again.');
    }
    return {
      kind: 'ok',
      oldName,
      changes,
      inputs: [...inputs.entries()].map(([input, h]) => ({ input, hash: h })).sort((x, y) => cmpStr(x.input, y.input)),
      versions: versions.sort((x, y) => cmpStr(x.uri, y.uri)),
    };
  }

  private async prepareDelegated(req: DelegatedRenameRequest, token?: CancellationToken): Promise<RouteResult<DelegatedPrepareResult>> {
    const b = await this.begin(token);
    const obs = await this.observeRename(req, b, token);
    if (obs.kind === 'unavailable') return this.result(b, obs);
    this.planCounter += 1;
    const info = b.session.conn.serverInfo;
    const plan: DelegatedRefactorPlan = {
      planId: `${b.epoch}-plan-${this.planCounter}`,
      actionId: this.descriptor.renameActionId ?? `${this.language.capabilityPrefix}.rename`,
      providerRouteId: this.descriptor.providerRouteId,
      workspaceId: this.o.workspaceId,
      kind: 'delegated',
      bridgeEpoch: b.epoch,
      observationId: b.observationId,
      observedWorkspaceRevision: b.revision,
      observedInputs: obs.inputs,
      backendContext: 'unknown',
      backendSnapshot: 'unknown',
      semanticReadSet: 'unknown',
      coverage: 'provider-managed',
      origin: { uri: req.uri, position: { line: req.position.line, character: req.position.character }, newName: req.newName },
      writeSet: obs.changes,
      evidence: [{ description: `Edits returned by ${this.language.serverName} (textDocument/rename) for ${basename(req.uri)}:${req.position.line + 1}, computed on the document versions Refyntra sent` }],
      limitations: [...this.language.renameLimitations],
      validation: { status: 'limited', compilationDelta: 'not-run', providerReprepared: false, returnedEditsMatchedPreview: false },
      title: `Rename ${obs.oldName} to ${req.newName}`,
      serverSession: { server: this.language.serverName, ...(info?.version ? { serverVersion: info.version } : {}), processOwner: 'refyntra', documentVersions: obs.versions },
    };
    return this.result(b, { kind: 'prepared', plan });
  }

  /** Before apply: the same server session is asked again on the same document versions; only an identical edit passes. */
  private async revalidateDelegated(plan: DelegatedRefactorPlan, token?: CancellationToken): Promise<RevalidateResult> {
    if (!this.session || plan.bridgeEpoch !== this.session.epoch || plan.providerRouteId !== this.descriptor.providerRouteId) {
      return { status: 'stale', reasonCode: 'RouteChanged', message: `${this.language.serverName} was restarted since the preview` };
    }
    const b = await this.begin(token);
    const obs = await this.observeRename(plan.origin, b, token);
    plan.validation.providerReprepared = true;
    if (obs.kind === 'unavailable') return { status: 'stale', reasonCode: obs.reasonCode, message: obs.message };
    const norm = (changes: readonly PlannedTextChange[]) =>
      JSON.stringify(changes.map((c) => [c.uri, c.expectedHash, c.resultHash, c.edits.map((e) => [e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character, e.newText])]));
    if (norm(obs.changes) !== norm(plan.writeSet)) return { status: 'stale', reasonCode: 'ProviderEditChanged', message: `${this.language.serverName} now returns a different edit than the preview; a new preview is required` };
    const fingerprints = (list: readonly InputFingerprint[]) => JSON.stringify([...list].sort((x, y) => cmpStr(x.input, y.input)).map((i) => [i.input, i.hash]));
    if (fingerprints(obs.inputs) !== fingerprints(plan.observedInputs)) return { status: 'stale', reasonCode: 'DocumentChanged', message: 'a document changed since the preview' };
    if (JSON.stringify(obs.versions) !== JSON.stringify(plan.serverSession?.documentVersions ?? [])) {
      return { status: 'stale', reasonCode: 'DocumentChanged', message: `the documents ${this.language.serverName} sees changed since the preview` };
    }
    plan.validation.returnedEditsMatchedPreview = true;
    return { status: 'limited', limitations: [...plan.limitations] };
  }
}
