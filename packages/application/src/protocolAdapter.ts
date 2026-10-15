import type {
  AdapterState,
  Availability,
  EngineStatus,
  InitializeResult,
  NotificationMap,
  Position,
  PrepareResult,
  RecoveryAction,
  RefactorPlanDto,
  RelatedResult,
  ResolveFrameRequest,
  ResolveFrameResult,
  RevalidateResult,
  ScopeDetails,
  SearchResult,
  SymbolRef,
} from '@refyntra/contracts';
import { ErrorCodes, PROTOCOL_MAJOR, PROTOCOL_MINOR } from '@refyntra/contracts';
import {
  type AdapterHealth,
  RECOVERY_MANAGE_TRUST,
  RECOVERY_RESTART,
  RECOVERY_SELECT_SOLUTION,
  RECOVERY_SHOW_HEALTH,
  acceptsSemanticRequests,
  createIdFactory,
  isWellFormedAvailability,
} from '@refyntra/domain';
import {
  type AdapterDescriptor,
  type CapabilityTarget,
  type LanguageAdapter,
  type PrepareRequest,
  type RelatedTarget,
  type RouteResult,
  type SearchRequest,
  descriptorHandles,
} from './adapters';
import { type CancellationToken, CancelledError, raceCancellation, throwIfCancelled } from './cancellation';
import type { DocumentEvent, DocumentTracker } from './documents';
import { AdapterUnavailableError, RpcError, StaleResultError, StartupError, TransportError, describeError, isBarrierTimeout, isStaleRpcError } from './errors';
import type { Clock, Logger, Transport, TransportFactory, TrustProvider, WorkspaceTargetProvider } from './ports';
import { type Deferred, type Disposable, Emitter, deferred } from './util';

export interface RestartPolicy {
  /** Max automatic restarts inside `windowMs`; beyond that the route goes to Failed (no infinite loop). */
  maxRestarts: number;
  windowMs: number;
  /** Delay before automatic restart N (index clamps to the last entry). */
  backoffMs: readonly number[];
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = { maxRestarts: 4, windowMs: 5 * 60_000, backoffMs: [500, 2_000, 5_000, 10_000] };

export interface ProtocolAdapterOptions {
  descriptor: AdapterDescriptor;
  workspaceId: string;
  transportFactory: TransportFactory;
  tracker: DocumentTracker;
  trust: TrustProvider;
  target: WorkspaceTargetProvider;
  clock: Clock;
  logger: Logger;
  client: { name: string; version: string };
  restartPolicy?: RestartPolicy;
  /** Graceful shutdown budget before the transport is torn down. */
  shutdownTimeoutMs?: number;
  /** Human description of the host launch (shown in health; no environment values). */
  hostDescription?: () => string | undefined;
}

interface Session {
  transport: Transport;
  epoch: string;
  /** Wire sequence of the last document event sent in this session: 0-based and contiguous per session, -1 = none (the host starts at -1). */
  sentSequence: number;
  /** Documents this session currently has open (uri → wire version). */
  open: Set<string>;
  closeSub: Disposable;
  maxMessageBytes: number;
  /** False until startup (open + replay + barrier) finished: a close during startup is handled by the startup path. */
  started: boolean;
  /** Protocol minor of the backend (1.2+ understands workspace/didRenameFiles, 1.3+ workspace/didCreateFiles). */
  protocolMinor: number;
}

/** Bytes of the JSON-RPC frame body for a notification (UTF-8), plus room for the Content-Length header. */
function frameBytes(method: string, params: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', method, params })).length + 64;
}

/**
 * LanguageAdapter that speaks protocol v1 to a backend process (the .NET host, or any conforming engine such as
 * the fixture engine in adapter-testing). Owns: handshake, workspace/open, document overlay sync, barrier before
 * every semantic request, stale-result rejection, restart with epoch change + full replay, bounded backoff.
 */
export class ProtocolLanguageAdapter implements LanguageAdapter {
  readonly descriptor: AdapterDescriptor;
  private readonly opts: ProtocolAdapterOptions;
  private readonly policy: RestartPolicy;
  private readonly traceIds;
  private session: Session | undefined;
  private state: AdapterState = 'NotStarted';
  private status: EngineStatus | undefined;
  private reasonCode: string | undefined;
  private message: string | undefined;
  private recovery: RecoveryAction[] = [];
  private hint: string | undefined;
  private restartCount = 0;
  private backendInfo: { engineVersion?: string; protocol: string } | undefined;
  private lastLoadDurationMs: number | undefined;
  /** Documents not sent because their frame would exceed limits.maxMessageBytes (uri → bytes). */
  private readonly tooLarge = new Map<string, number>();
  private autoRestarts: number[] = [];
  private restartTimer: Disposable | undefined;
  private startPromise: Promise<void> | undefined;
  private readyWaiters: Deferred<void>[] = [];
  private disposed = false;
  private attempt = 0;
  private readonly healthEmitter = new Emitter<AdapterHealth>();
  private readonly epochEmitter = new Emitter<string | undefined>();
  readonly onDidChangeHealth = this.healthEmitter.event;
  readonly onDidChangeEpoch = this.epochEmitter.event;

  constructor(opts: ProtocolAdapterOptions) {
    this.opts = opts;
    this.descriptor = opts.descriptor;
    this.policy = opts.restartPolicy ?? DEFAULT_RESTART_POLICY;
    this.traceIds = createIdFactory(`${opts.descriptor.adapterId}-t`);
  }

  handles(uri: string, languageId?: string): boolean {
    return descriptorHandles(this.descriptor, uri, languageId);
  }

  currentEpoch(): string | undefined {
    return this.session?.epoch;
  }

  health(): AdapterHealth {
    const s = this.status;
    return {
      adapterId: this.descriptor.adapterId,
      providerRouteId: this.descriptor.providerRouteId,
      displayName: this.descriptor.displayName,
      state: this.state,
      ...(this.reasonCode ? { reasonCode: this.reasonCode } : {}),
      ...(this.message ? { message: this.message } : {}),
      recoveryActions: [...this.recovery],
      ...(this.hint ? { recoveryHint: this.hint } : {}),
      ...(this.session ? { sessionEpoch: this.session.epoch } : {}),
      ...(s ? { sdk: s.sdk, solutionPath: s.solutionPath } : {}),
      projects: s?.projects ?? [],
      diagnostics: [
        ...(s?.diagnostics ?? []),
        ...[...this.tooLarge].map(([uri, bytes]) => ({
          severity: 'warning' as const,
          message: `Not sent to the backend: ${uri} is too large (${bytes} bytes; the limit is ${this.session?.maxMessageBytes ?? 'unknown'} bytes). Results for it use the saved file, if any.`,
        })),
      ],
      restartCount: this.restartCount,
      ...(this.opts.hostDescription?.() ? { hostDescription: this.opts.hostDescription() } : {}),
      ...(this.backendInfo ? { backend: { ...this.backendInfo } } : {}),
      ...(this.lastLoadDurationMs !== undefined ? { lastLoadDurationMs: this.lastLoadDurationMs } : {}),
    };
  }

  // ------------------------------------------------------------------ lifecycle

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.session && acceptsSemanticRequests(this.state)) return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  async restart(reason: string): Promise<void> {
    this.log('info', 'restart requested', { reason });
    this.restartTimer?.dispose();
    this.restartTimer = undefined;
    this.autoRestarts = [];
    await this.startPromise?.catch(() => undefined);
    await this.teardownSession('restart');
    this.restartCount += 1;
    this.setState('Restarting', { reasonCode: 'RestartRequested', message: 'Restarting backend' });
    await this.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.restartTimer?.dispose();
    await this.teardownSession('dispose');
    this.rejectWaiters(new AdapterUnavailableError(this.health()));
    this.healthEmitter.dispose();
    this.epochEmitter.dispose();
  }

  private async startInternal(): Promise<void> {
    if (!this.opts.trust.isTrusted()) {
      // Restricted Mode: never spawn the host, never evaluate projects.
      this.setState('TrustRequired', {
        reasonCode: 'TrustRequired',
        message: 'Workspace is in Restricted Mode. Refyntra does not start the C# host or evaluate projects until you trust the workspace.',
        recovery: [RECOVERY_MANAGE_TRUST],
      });
      return;
    }
    const target = await this.opts.target.resolveTarget(this.descriptor.adapterId);
    if (this.disposed) return;
    if (target.kind === 'none') {
      this.setState('NotStarted', { reasonCode: target.reasonCode, message: target.message, recovery: [RECOVERY_SELECT_SOLUTION, RECOVERY_SHOW_HEALTH] });
      return;
    }
    if (this.state !== 'Restarting') this.setState('Loading', { message: 'Starting backend' });
    this.attempt += 1;
    const startedAt = this.opts.clock.now();
    let transport: Transport | undefined;
    try {
      transport = await this.opts.transportFactory({ providerRouteId: this.descriptor.providerRouteId, attempt: this.attempt });
      if (this.disposed) {
        await transport.dispose();
        return;
      }
      const traceId = this.traceIds.next();
      let init: InitializeResult;
      try {
        init = await transport.request('initialize', {
          traceId,
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: PROTOCOL_MINOR,
          clientName: this.opts.client.name,
          clientVersion: this.opts.client.version,
        });
      } catch (e) {
        if (e instanceof RpcError && e.code === ErrorCodes.ProtocolMismatch) throw new StartupError('ProtocolMismatch', e.message, false);
        throw e;
      }
      if (!init || init.protocolMajor !== PROTOCOL_MAJOR) {
        throw new StartupError('ProtocolMismatch', `Backend speaks protocol ${String(init?.protocolMajor)}.x; this extension needs ${PROTOCOL_MAJOR}.x. Update the extension and the host together.`, false);
      }
      if (typeof init.sessionEpoch !== 'string' || init.sessionEpoch.length === 0) throw new StartupError('ProtocolViolation', 'Backend did not report a session epoch', false);

      const session: Session = {
        transport,
        epoch: init.sessionEpoch,
        sentSequence: -1,
        open: new Set(),
        closeSub: { dispose: () => undefined },
        maxMessageBytes: init.limits?.maxMessageBytes ?? 32 * 1024 * 1024,
        started: false,
        protocolMinor: typeof init.protocolMinor === 'number' ? init.protocolMinor : 0,
      };
      session.closeSub = transport.onClose((err) => this.onSessionClosed(session, err));
      this.session = session;
      this.epochEmitter.fire(session.epoch);
      this.backendInfo = { ...(typeof init.engineVersion === 'string' ? { engineVersion: init.engineVersion } : {}), protocol: `${init.protocolMajor}.${init.protocolMinor ?? 0}` };
      this.log('info', 'initialized', { epoch: session.epoch, engineVersion: init.engineVersion, protocolMinor: init.protocolMinor });

      const status = await transport.request('workspace/open', {
        traceId: this.traceIds.next(),
        workspaceId: this.opts.workspaceId,
        path: target.path,
        trusted: true,
      });
      if (this.session !== session) return;
      this.status = status;
      this.lastLoadDurationMs = this.opts.clock.now() - startedAt;

      // Full replay of every open document (dirty text included) before any semantic request.
      this.replay(session);
      const barrier = await transport.request('workspace/snapshotBarrier', {
        traceId: this.traceIds.next(),
        workspaceId: this.opts.workspaceId,
        sequence: session.sentSequence,
      });
      if (this.session !== session) return;
      if (barrier.acknowledgedSequence < session.sentSequence) throw new StartupError('ProtocolViolation', 'Backend did not acknowledge the replayed documents', true);
      session.started = true;
      this.applyStatus(status);
      // Opened from the persistent project index: MSBuild is still loading; its final status replaces this one.
      if (status.fromProjectIndex) void this.followIndexLoad(session);
    } catch (e) {
      if (transport && this.session?.transport !== transport) await transport.dispose().catch(() => undefined);
      if (this.disposed) return;
      if (e instanceof StartupError) {
        await this.teardownSession('startup-failed');
        if (e.retryable) {
          this.scheduleAutoRestart(e.reasonCode, e.message);
        } else {
          this.setState('Failed', { reasonCode: e.reasonCode, message: e.message, recovery: [RECOVERY_SHOW_HEALTH, RECOVERY_RESTART] });
        }
        return;
      }
      if (e instanceof RpcError) {
        await this.teardownSession('startup-failed');
        const code = e.reasonCode ?? 'StartupFailed';
        if (e.code === ErrorCodes.TrustRequired) {
          this.setState('TrustRequired', { reasonCode: code, message: e.message, recovery: [RECOVERY_MANAGE_TRUST] });
        } else {
          this.setState('Failed', { reasonCode: code, message: e.data?.message ?? e.message, ...(typeof e.data?.recovery === 'string' ? { hint: e.data.recovery } : {}), recovery: [RECOVERY_SHOW_HEALTH, RECOVERY_RESTART] });
        }
        return;
      }
      // Transport failure during startup → bounded automatic restart.
      await this.teardownSession('startup-failed');
      this.scheduleAutoRestart('StartupFailed', describeError(e));
    }
  }

  private async followIndexLoad(session: NonNullable<typeof this.session>): Promise<void> {
    for (let i = 0; i < 1800 && this.session === session && !this.disposed; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (this.session !== session) return;
      try {
        const s = await session.transport.request('engine/status', { traceId: this.traceIds.next() });
        if (this.session !== session) return;
        if (!s.fromProjectIndex) {
          this.status = s;
          this.applyStatus(s);
          return;
        }
      } catch {
        return;
      }
    }
  }

  private applyStatus(status: EngineStatus): void {
    const state: AdapterState = (['Ready', 'Partial', 'Loading', 'Failed', 'Unsupported', 'TrustRequired', 'NotStarted', 'Restarting'] as const).includes(status.state)
      ? status.state
      : 'Failed';
    const recovery: RecoveryAction[] = state === 'Ready' ? [] : [RECOVERY_SHOW_HEALTH];
    if (state === 'Failed') recovery.push(RECOVERY_RESTART);
    this.setState(state, { ...(status.reasonCode ? { reasonCode: status.reasonCode } : {}), ...(status.message ? { message: status.message } : {}), recovery });
  }

  /** Sends didOpen for every open document (startup, and after a BarrierTimeout). Oversized documents are skipped. */
  private replay(session: Session): void {
    let sent = 0;
    for (const doc of this.opts.tracker.openDocuments()) {
      if (!this.handles(doc.uri, doc.languageId)) continue;
      const params = { workspaceId: this.opts.workspaceId, uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text, workspaceRevision: this.opts.tracker.revision };
      if (!this.fits(session, doc.uri, 'textDocument/didOpen', params)) continue;
      if (this.send(session, 'textDocument/didOpen', params)) {
        session.open.add(doc.uri);
        sent++;
      }
    }
    this.log('info', 'replayed open documents', { count: sent, tooLarge: this.tooLarge.size });
  }

  /**
   * Sends one document notification with the next wire sequence. The sequence is consumed only when the send
   * succeeded, so a failed send never leaves a gap that would make every later barrier wait for it.
   */
  private send<N extends 'textDocument/didOpen' | 'textDocument/didChange' | 'textDocument/didSave' | 'textDocument/didClose' | 'workspace/didRenameFiles' | 'workspace/didCreateFiles' | 'workspace/didDeleteFiles'>(
    session: Session,
    method: N,
    params: Omit<NotificationMap[N], 'sequence'>,
  ): boolean {
    const sequence = session.sentSequence + 1;
    try {
      session.transport.notify(method, { ...params, sequence } as NotificationMap[N]);
      session.sentSequence = sequence;
      return true;
    } catch (err) {
      this.log('warn', 'document notification failed', { method, error: describeError(err) });
      return false;
    }
  }

  /** False (and the document is marked "too large" in health) when its frame would exceed limits.maxMessageBytes. */
  private fits(session: Session, uri: string, method: string, params: unknown): boolean {
    const bytes = frameBytes(method, params);
    const was = this.tooLarge.has(uri);
    if (bytes > session.maxMessageBytes) {
      this.tooLarge.set(uri, bytes);
      if (!was) {
        this.log('warn', 'document too large for the backend; not sent', { bytes, limit: session.maxMessageBytes });
        this.healthEmitter.fire(this.health());
      }
      return false;
    }
    if (was) {
      this.tooLarge.delete(uri);
      this.healthEmitter.fire(this.health());
    }
    return true;
  }

  private onSessionClosed(session: Session, err: Error | undefined): void {
    if (this.session !== session) return;
    this.session = undefined;
    session.closeSub.dispose();
    this.epochEmitter.fire(undefined);
    if (this.disposed) return;
    if (!session.started) {
      // Closed during startup: the pending startup request fails and the startup path schedules the (one) restart.
      this.log('warn', 'backend session closed during startup', { epoch: session.epoch, reason: err ? describeError(err) : 'exit' });
      void session.transport.dispose().catch(() => undefined);
      return;
    }
    this.log('warn', 'backend session closed', { epoch: session.epoch, reason: err ? describeError(err) : 'exit' });
    void session.transport.dispose().catch(() => undefined);
    this.scheduleAutoRestart(err instanceof TransportError ? err.reasonCode : 'BackendExited', err ? describeError(err) : 'The backend process exited');
  }

  private scheduleAutoRestart(reasonCode: string, message: string): void {
    const now = this.opts.clock.now();
    this.autoRestarts = this.autoRestarts.filter((t) => now - t < this.policy.windowMs);
    if (this.autoRestarts.length >= this.policy.maxRestarts) {
      this.setState('Failed', {
        reasonCode: 'RestartLimitReached',
        message: `The backend failed ${this.autoRestarts.length + 1} times in a row (${message}). Automatic restarts stopped.`,
        recovery: [RECOVERY_RESTART, RECOVERY_SHOW_HEALTH],
      });
      return;
    }
    const delay = this.policy.backoffMs[Math.min(this.autoRestarts.length, this.policy.backoffMs.length - 1)] ?? 1000;
    this.autoRestarts.push(now);
    this.restartCount += 1;
    this.setState('Restarting', { reasonCode, message: `${message}. Restarting in ${Math.round(delay / 100) / 10}s.`, recovery: [RECOVERY_SHOW_HEALTH] });
    this.restartTimer?.dispose();
    this.restartTimer = this.opts.clock.setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, delay);
  }

  private async teardownSession(why: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    session.closeSub.dispose();
    this.epochEmitter.fire(undefined);
    const timeout = this.opts.shutdownTimeoutMs ?? 2000;
    try {
      await Promise.race([
        session.transport.request('shutdown', { traceId: this.traceIds.next() }),
        new Promise((resolve) => this.opts.clock.setTimeout(() => resolve(undefined), timeout)),
      ]);
      session.transport.notify('exit', {});
    } catch {
      // Already gone.
    }
    await session.transport.dispose().catch(() => undefined);
    this.log('info', 'session closed', { epoch: session.epoch, why });
  }

  private setState(state: AdapterState, info: { reasonCode?: string; message?: string; hint?: string; recovery?: RecoveryAction[] } = {}): void {
    this.state = state;
    this.hint = info.hint;
    this.reasonCode = info.reasonCode;
    this.message = info.message;
    this.recovery = info.recovery ?? [];
    if (state !== 'Loading' && state !== 'Restarting') {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w.resolve();
    }
    this.healthEmitter.fire(this.health());
  }

  private rejectWaiters(e: unknown): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(e);
  }

  /** Waits until the route has settled (not Loading/Restarting), starting it when never started. */
  private async whenReady(token?: CancellationToken): Promise<Session> {
    if (this.state === 'NotStarted' && !this.startPromise) await this.start();
    for (;;) {
      throwIfCancelled(token);
      if (this.startPromise) {
        await raceCancellation(this.startPromise, token);
        continue;
      }
      if (this.state !== 'Loading' && this.state !== 'Restarting') break;
      const w = deferred<void>();
      this.readyWaiters.push(w);
      const sub = token?.onCancellationRequested(() => w.reject(new CancelledError()));
      try {
        await w.promise;
      } finally {
        sub?.dispose();
      }
      throwIfCancelled(token);
    }
    if (!this.session || !acceptsSemanticRequests(this.state)) throw new AdapterUnavailableError(this.health());
    return this.session;
  }

  // ------------------------------------------------------------------ documents

  documentEvent(e: DocumentEvent): void {
    const session = this.session;
    if (!session) return; // Replay on (re)start sends the tracker's current state.
    const base = { workspaceId: this.opts.workspaceId, uri: e.uri, workspaceRevision: e.workspaceRevision };
    switch (e.kind) {
      case 'open':
      case 'change': {
        const text = e.text ?? '';
        const asOpen = e.kind === 'open' || !session.open.has(e.uri);
        const params = asOpen ? { ...base, languageId: e.languageId, version: e.version, text } : { ...base, version: e.version, text };
        if (!this.fits(session, e.uri, asOpen ? 'textDocument/didOpen' : 'textDocument/didChange', params)) {
          // Too large to send: the backend must not keep an older overlay of it, so close it there (disk text).
          if (session.open.delete(e.uri)) this.send(session, 'textDocument/didClose', base);
          return;
        }
        if (asOpen) {
          if (this.send(session, 'textDocument/didOpen', params as Omit<NotificationMap['textDocument/didOpen'], 'sequence'>)) session.open.add(e.uri);
        } else {
          this.send(session, 'textDocument/didChange', params as Omit<NotificationMap['textDocument/didChange'], 'sequence'>);
        }
        break;
      }
      case 'save':
        if (!session.open.has(e.uri)) return;
        this.send(session, 'textDocument/didSave', base);
        break;
      case 'close':
        if (this.tooLarge.delete(e.uri)) this.healthEmitter.fire(this.health());
        if (!session.open.delete(e.uri)) return;
        this.send(session, 'textDocument/didClose', base);
        break;
    }
  }

  // ------------------------------------------------------------------ semantic requests

  /**
   * Barrier, then the request on the acknowledged snapshot. The result is dropped (StaleResultError) when the
   * epoch, the snapshot or the workspace revision changed while it was computed.
   */
  private async semantic<T>(
    op: string,
    token: CancellationToken | undefined,
    run: (session: Session, snapshotId: string, traceId: string) => Promise<T>,
    resultSnapshot?: (value: T) => string | undefined,
  ): Promise<RouteResult<T>> {
    throwIfCancelled(token);
    const session = await this.whenReady(token);
    const revision = this.opts.tracker.revision;
    const sequence = session.sentSequence;
    const traceId = this.traceIds.next();
    const started = this.opts.clock.now();
    try {
      const barrier = await session.transport.request('workspace/snapshotBarrier', { traceId, workspaceId: this.opts.workspaceId, sequence }, token);
      throwIfCancelled(token);
      this.assertCurrent(session, revision);
      if (!barrier || typeof barrier.snapshotId !== 'string' || barrier.acknowledgedSequence < sequence) throw new StaleResultError('backend');
      const value = await run(session, barrier.snapshotId, traceId);
      throwIfCancelled(token);
      this.assertCurrent(session, revision);
      const reported = resultSnapshot?.(value);
      if (reported !== undefined && reported !== barrier.snapshotId) throw new StaleResultError('snapshot');
      this.log('debug', op, { traceId, epoch: session.epoch, snapshot: barrier.snapshotId, durationMs: this.opts.clock.now() - started, status: 'ok' });
      return { value, providerRouteId: this.descriptor.providerRouteId, sessionEpoch: session.epoch, snapshotId: barrier.snapshotId, workspaceRevision: revision };
    } catch (e) {
      const status = e instanceof CancelledError ? 'cancelled' : e instanceof StaleResultError ? 'stale' : 'error';
      this.log(status === 'error' ? 'warn' : 'debug', op, { traceId, epoch: session.epoch, durationMs: this.opts.clock.now() - started, status, error: describeError(e) });
      if (isStaleRpcError(e)) throw new StaleResultError('backend');
      if (isBarrierTimeout(e) && this.session === session) {
        // A document event never reached the backend: send the full current state again, then retry (stale).
        this.log('warn', 'barrier timeout: replaying open documents', { epoch: session.epoch, sequence });
        this.replay(session);
        throw new StaleResultError('backend');
      }
      if (e instanceof TransportError && this.session !== session) throw new StaleResultError('epoch');
      throw e;
    }
  }

  private assertCurrent(session: Session, revision: number): void {
    if (this.session !== session) throw new StaleResultError('epoch');
    if (this.opts.tracker.revision !== revision) throw new StaleResultError('revision');
  }

  search(req: SearchRequest, token?: CancellationToken): Promise<RouteResult<SearchResult>> {
    return this.semantic(
      'code/search',
      token,
      async (s, snapshotId, traceId) => {
        const r = await s.transport.request('code/search', { traceId, workspaceId: this.opts.workspaceId, snapshotId, query: req.query, filters: req.filters, limit: req.limit }, token);
        return { items: Array.isArray(r?.items) ? r.items : [], truncated: !!r?.truncated, snapshotId: r?.snapshotId ?? snapshotId };
      },
      (v) => v.snapshotId,
    );
  }

  symbolAt(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<SymbolRef | null>> {
    return this.semantic('code/symbolAt', token, async (s, snapshotId, traceId) => {
      const r = await s.transport.request('code/symbolAt', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      return r && typeof r === 'object' && typeof r.name === 'string' ? r : null;
    });
  }

  implementations(symbolId: string, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').Location[]>> {
    return this.semantic('code/implementations', token, async (s, snapshotId, traceId) => {
      const r = await s.transport.request('code/implementations', { traceId, workspaceId: this.opts.workspaceId, snapshotId, symbolId }, token);
      return Array.isArray(r?.locations) ? r.locations : [];
    });
  }

  related(target: RelatedTarget, token?: CancellationToken): Promise<RouteResult<RelatedResult>> {
    return this.semantic(
      'code/related',
      token,
      async (s, snapshotId, traceId) => {
        const r = await s.transport.request('code/related', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...target }, token);
        return {
          subject: r?.subject ?? null,
          relations: Array.isArray(r?.relations) ? r.relations.filter((x) => x && typeof x.group === 'string' && x.target) : [],
          completeness: r?.completeness ?? 'unknown',
          scopeNotes: Array.isArray(r?.scopeNotes) ? r.scopeNotes : [],
          ...(isScopeDetails(r?.scopeDetails) ? { scopeDetails: r.scopeDetails } : {}),
          snapshotId: r?.snapshotId ?? snapshotId,
        };
      },
      (v) => v.snapshotId,
    );
  }

  capabilities(target: CapabilityTarget, token?: CancellationToken): Promise<RouteResult<Availability[]>> {
    return this.semantic('capability/query', token, async (s, snapshotId, traceId) => {
      const r = await s.transport.request('capability/query', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...target }, token);
      return Array.isArray(r) ? r.filter(isWellFormedAvailability) : [];
    });
  }

  prepare(req: PrepareRequest, token?: CancellationToken): Promise<RouteResult<PrepareResult>> {
    if (req.structural) {
      // Structural replace (protocol 1.19): code/structuralReplace answers like refactor/prepare.
      const structural = req.structural;
      return this.semantic('code/structuralReplace', token, async (s, snapshotId, traceId): Promise<PrepareResult> => {
        if (s.protocolMinor < 19) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for structural replace; update the extension.' };
        return s.transport.request('code/structuralReplace', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...structural }, token);
      });
    }
    return this.semantic('refactor/prepare', token, (s, snapshotId, traceId) =>
      s.transport.request('refactor/prepare', { traceId, workspaceId: this.opts.workspaceId, snapshotId, actionId: req.actionId, symbolId: req.symbolId, newName: req.newName, ...(req.renameFile ? { renameFile: true } : {}), ...(req.targetFolderUri ? { targetFolderUri: req.targetFolderUri } : {}), ...(req.documentUri ? { documentUri: req.documentUri } : {}), ...(req.cleanup ? { cleanup: req.cleanup } : {}), ...(req.generatedEdits ? { generatedEdits: req.generatedEdits } : {}), ...(req.range ? { range: req.range } : {}), ...(req.signature ? { signature: req.signature } : {}), ...(req.registration ? { registration: req.registration } : {}), ...(req.fixAll ? { fixAll: req.fixAll } : {}) }, token),
    );
  }

  async revalidate(plan: RefactorPlanDto, token?: CancellationToken): Promise<RevalidateResult> {
    if (!this.session || this.session.epoch !== plan.sessionEpoch) return { status: 'stale', reasonCode: 'EpochChanged', message: 'The backend restarted after the plan was prepared' };
    try {
      const r = await this.semantic('refactor/revalidate', token, (s, snapshotId, traceId) =>
        s.transport.request('refactor/revalidate', { traceId, workspaceId: this.opts.workspaceId, planId: plan.planId, snapshotId }, token),
      );
      if (r.sessionEpoch !== plan.sessionEpoch) return { status: 'stale', reasonCode: 'EpochChanged', message: 'The backend restarted after the plan was prepared' };
      return r.value ?? { status: 'invalid', reasonCode: 'ProtocolViolation', message: 'Empty revalidation result' };
    } catch (e) {
      if (e instanceof StaleResultError) return { status: 'stale', reasonCode: `Stale:${e.reason}`, message: e.message };
      throw e;
    }
  }

  /** `analysis/run` (rules such as OR1001). Backend output is untrusted: malformed entries are dropped. */
  analyze(params: import('./adapters').AnalyzeRequest, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').AnalysisRunResult>> {
    return this.semantic(
      'analysis/run',
      token,
      async (s, snapshotId, traceId) => {
        const documents = s.protocolMinor >= 16 && params.documents?.length ? { documents: [...params.documents] } : {};
        const patterns = s.protocolMinor >= 19 && params.structuralPatterns?.length && params.documents?.length ? { structuralPatterns: [...params.structuralPatterns] } : {};
        const r = await s.transport.request('analysis/run', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...(params.uri ? { uri: params.uri } : {}), ...documents, ...patterns }, token);
        const isLoc = (l: unknown): boolean => !!l && typeof (l as { uri?: unknown }).uri === 'string' && !!(l as { range?: unknown }).range;
        return {
          diagnostics: Array.isArray(r?.diagnostics)
            ? r.diagnostics
                .filter((d) => d && typeof d.id === 'string' && typeof d.message === 'string' && isLoc(d.location))
                .map((d) => ({
                  ...d,
                  relatedLocations: Array.isArray(d.relatedLocations) ? d.relatedLocations.filter((x) => x && isLoc(x.location)) : [],
                  evidence: Array.isArray(d.evidence) ? d.evidence : [],
                  // Quick fixes are edit actions only (csharp.edit.fix.*); anything else is dropped.
                  fixes: Array.isArray(d.fixes)
                    ? d.fixes.filter((f) => f && typeof f.actionId === 'string' && f.actionId.startsWith('csharp.edit.fix.') && typeof f.title === 'string').map((f) => ({ actionId: f.actionId, title: f.title }))
                    : [],
                }))
            : [],
          abstentions: Array.isArray(r?.abstentions) ? r.abstentions.filter((a) => a && typeof a.reason === 'string') : [],
          completeness: r?.completeness ?? 'unknown',
          snapshotId: r?.snapshotId ?? snapshotId,
        };
      },
      (v) => v.snapshotId,
    );
  }

  /** Stack trace navigation (protocol 1.4): candidate source symbols of a .NET frame. */
  resolveFrame(req: ResolveFrameRequest, token?: CancellationToken): Promise<RouteResult<ResolveFrameResult>> {
    return this.semantic(
      'code/resolveFrame',
      token,
      async (s, snapshotId, traceId) => {
        if (s.protocolMinor < 4) return { candidates: [], snapshotId };
        const r = await s.transport.request('code/resolveFrame', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...req }, token);
        return {
          candidates: Array.isArray(r?.candidates) ? r.candidates.filter((c) => c && c.symbol && c.location && typeof c.location.uri === 'string') : [],
          snapshotId: r?.snapshotId ?? snapshotId,
        };
      },
      (v) => v.snapshotId,
    );
  }

  /** File rename: the host moves the documents of renamed files (same document sequence as didOpen/didClose). */
  filesRenamed(files: readonly { oldUri: string; newUri: string }[], workspaceRevision: number): boolean {
    const session = this.session;
    if (!session || session.protocolMinor < 2 || files.length === 0) return false;
    return this.send(session, 'workspace/didRenameFiles', { workspaceId: this.opts.workspaceId, workspaceRevision, files: files.map((f) => ({ oldUri: f.oldUri, newUri: f.newUri })) });
  }

  /** Created files: the host adds the documents of created files (same document sequence as didOpen/didClose). */
  filesCreated(uris: readonly string[], workspaceRevision: number): boolean {
    const session = this.session;
    if (!session || session.protocolMinor < 3 || uris.length === 0) return false;
    return this.send(session, 'workspace/didCreateFiles', { workspaceId: this.opts.workspaceId, workspaceRevision, files: uris.map((uri) => ({ uri })) });
  }

  /** Deleted files (protocol 1.6): the host removes the documents of deleted files (same document sequence as didOpen/didClose). */
  filesDeleted(uris: readonly string[], workspaceRevision: number): boolean {
    const session = this.session;
    if (!session || session.protocolMinor < 6 || uris.length === 0) return false;
    return this.send(session, 'workspace/didDeleteFiles', { workspaceId: this.opts.workspaceId, workspaceRevision, files: uris.map((uri) => ({ uri })) });
  }

  /** Change Signature (protocol 1.6): the parameters of the method at the position (symbolAt, then code/signature). */
  signatureAt(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').SignatureInfo | null>> {
    return this.semantic('code/signature', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 6) return { parameters: [], reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for Change Signature; update the extension.', snapshotId };
      const sym = await s.transport.request('code/symbolAt', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      if (!sym || !sym.symbolId) return null;
      const r = await s.transport.request('code/signature', { traceId, workspaceId: this.opts.workspaceId, snapshotId, symbolId: sym.symbolId }, token);
      if (!r || !Array.isArray(r.parameters)) return null;
      return { ...r, parameters: r.parameters.filter((p) => p && typeof p.name === 'string' && typeof p.type === 'string'), snapshotId: r.snapshotId ?? snapshotId };
    });
  }

  /** Call / type hierarchy (protocol 1.7): symbolAt, then code/hierarchy on the same snapshot ("subject" only resolves). */
  hierarchy(uri: string, position: Position, direction: import('@refyntra/contracts').HierarchyDirection | 'subject', token?: CancellationToken): Promise<RouteResult<{ subject: SymbolRef | null; result: import('@refyntra/contracts').HierarchyResult | null }>> {
    return this.semantic('code/hierarchy', token, async (s, snapshotId, traceId) => {
      const sym = await s.transport.request('code/symbolAt', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      const subject = sym && typeof sym === 'object' && typeof sym.name === 'string' ? sym : null;
      if (!subject || direction === 'subject' || s.protocolMinor < 7 || !subject.symbolId) return { subject, result: null };
      if ((direction === 'bases' || direction === 'containing') && s.protocolMinor < 12) return { subject, result: null };
      const r = await s.transport.request('code/hierarchy', { traceId, workspaceId: this.opts.workspaceId, snapshotId, symbolId: subject.symbolId, direction }, token);
      const items = Array.isArray(r?.items)
        ? r.items.filter((i) => i && i.symbol && typeof i.symbol.name === 'string' && i.symbol.location && typeof i.symbol.location.uri === 'string').map((i) => ({ ...i, fromRanges: Array.isArray(i.fromRanges) ? i.fromRanges : [] }))
        : [];
      return { subject, result: { items, completeness: r?.completeness ?? 'unknown', truncated: !!r?.truncated, snapshotId: r?.snapshotId ?? snapshotId } };
    });
  }

  /** Find Usages grouped (protocol 1.12): symbolAt, then code/usages on the same snapshot. */
  usages(uri: string, position: Position, limit: number, token?: CancellationToken): Promise<RouteResult<{ subject: SymbolRef | null; result: import('@refyntra/contracts').UsagesResult | null }>> {
    return this.semantic('code/usages', token, async (s, snapshotId, traceId) => {
      const sym = await s.transport.request('code/symbolAt', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      const subject = sym && typeof sym === 'object' && typeof sym.name === 'string' ? sym : null;
      if (!subject || s.protocolMinor < 12 || !subject.symbolId) return { subject, result: null };
      const r = await s.transport.request('code/usages', { traceId, workspaceId: this.opts.workspaceId, snapshotId, symbolId: subject.symbolId, limit }, token);
      const items = Array.isArray(r?.items)
        ? r.items
            .filter((i) => i && typeof i.uri === 'string' && i.range && i.range.start && i.range.end && typeof i.kind === 'string')
            .map((i) => ({ ...i, isTest: !!i.isTest, lineText: typeof i.lineText === 'string' ? i.lineText : '' }))
        : [];
      return {
        subject: r?.subject && typeof r.subject.name === 'string' ? r.subject : subject,
        result: { items, total: typeof r?.total === 'number' ? r.total : items.length, truncated: !!r?.truncated, completeness: r?.completeness ?? 'unknown', snapshotId: r?.snapshotId ?? snapshotId },
      };
    });
  }

  /** Go to metadata (protocol 1.17): a decompiled / embedded-source document or the symbol in one; null for an older host. */
  metadataSource(params: import('./adapters').MetadataSourceRequest, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').MetadataSourceResult | null>> {
    return this.semantic('code/metadataSource', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 17) return null;
      const r = await s.transport.request('code/metadataSource', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...params }, token);
      const isRange = (x: unknown): boolean => !!x && typeof x === 'object' && !!(x as { start?: unknown }).start && !!(x as { end?: unknown }).end;
      const d = r?.document;
      const document =
        d && typeof d.path === 'string' && typeof d.text === 'string' && typeof d.assemblyName === 'string'
          ? { ...d, symbols: Array.isArray(d.symbols) ? d.symbols.filter((x) => x && typeof x.documentationId === 'string' && isRange(x.nameRange) && isRange(x.range)) : [] }
          : null;
      return {
        document,
        symbolRange: isRange(r?.symbolRange) ? r.symbolRange : null,
        symbol: r?.symbol && typeof r.symbol.name === 'string' ? r.symbol : null,
        location: r?.location && typeof r.location.uri === 'string' && isRange(r.location.range) ? r.location : null,
        summary: typeof r?.summary === 'string' ? r.summary : null,
        reasonCode: r?.reasonCode ?? null,
        message: typeof r?.message === 'string' ? r.message : null,
        decompilerVersion: typeof r?.decompilerVersion === 'string' ? r.decompilerVersion : '',
        snapshotId: r?.snapshotId ?? snapshotId,
      };
    });
  }

  /** Structural search (protocol 1.19); null for an older host. Matches without a uri or range are dropped. */
  structuralSearch(params: import('./adapters').StructuralSearchRequest, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').StructuralSearchResult | null>> {
    return this.semantic('code/structuralSearch', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 19) return null;
      const r = await s.transport.request('code/structuralSearch', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...params }, token);
      const matches = Array.isArray(r?.matches)
        ? r.matches
            .filter((m) => m && typeof m.uri === 'string' && m.range && m.range.start && m.range.end)
            .map((m) => ({ uri: m.uri, range: m.range, lineText: typeof m.lineText === 'string' ? m.lineText : '', values: m.values && typeof m.values === 'object' ? m.values : {} }))
        : [];
      return {
        patternKind: r?.patternKind ?? null,
        matches,
        truncated: !!r?.truncated,
        filesSearched: typeof r?.filesSearched === 'number' ? r.filesSearched : 0,
        filesWithMatches: typeof r?.filesWithMatches === 'number' ? r.filesWithMatches : 0,
        notes: Array.isArray(r?.notes) ? r.notes.filter((n) => typeof n === 'string') : [],
        reasonCode: r?.reasonCode ?? null,
        message: typeof r?.message === 'string' ? r.message : null,
        elapsedMs: typeof r?.elapsedMs === 'number' ? r.elapsedMs : 0,
        snapshotId: r?.snapshotId ?? snapshotId,
      };
    });
  }

  /** Usages of a symbol id (code/usages, protocol 1.12) without symbolAt; null result for an older host. */
  usagesOfSymbol(symbolId: string, limit: number, token?: CancellationToken): Promise<RouteResult<{ subject: SymbolRef | null; result: import('@refyntra/contracts').UsagesResult | null }>> {
    return this.semantic('code/usages', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 12) return { subject: null, result: null };
      const r = await s.transport.request('code/usages', { traceId, workspaceId: this.opts.workspaceId, snapshotId, symbolId, limit }, token);
      const items = Array.isArray(r?.items)
        ? r.items
            .filter((i) => i && typeof i.uri === 'string' && i.range && i.range.start && i.range.end && typeof i.kind === 'string')
            .map((i) => ({ ...i, isTest: !!i.isTest, lineText: typeof i.lineText === 'string' ? i.lineText : '' }))
        : [];
      return {
        subject: r?.subject && typeof r.subject.name === 'string' ? r.subject : null,
        result: { items, total: typeof r?.total === 'number' ? r.total : items.length, truncated: !!r?.truncated, completeness: r?.completeness ?? 'unknown', snapshotId: r?.snapshotId ?? snapshotId },
      };
    });
  }

  /** File Structure (protocol 1.13): the types and members of a document; null for an older host. */
  fileStructure(uri: string, includeInherited: boolean, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').FileStructureResult | null>> {
    return this.semantic('code/fileStructure', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 13) return null;
      const r = await s.transport.request('code/fileStructure', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, includeInherited }, token);
      const isRange = (x: unknown): boolean => !!x && typeof x === 'object' && !!(x as { start?: unknown }).start && !!(x as { end?: unknown }).end;
      const member = (m: import('@refyntra/contracts').StructureMember): boolean => !!m && typeof m.name === 'string' && typeof m.kind === 'string' && isRange(m.range) && isRange(m.selectionRange);
      const types = Array.isArray(r?.types)
        ? r.types
            .filter((t) => t && typeof t.name === 'string' && typeof t.fullName === 'string' && isRange(t.range) && isRange(t.selectionRange))
            .map((t) => ({
              ...t,
              members: Array.isArray(t.members) ? t.members.filter(member).map((m) => ({ ...m, navigable: m.navigable !== false })) : [],
              inherited: Array.isArray(t.inherited) ? t.inherited.filter(member).map((m) => ({ ...m, navigable: m.navigable !== false && typeof m.uri === 'string' })) : [],
            }))
        : [];
      const regions = Array.isArray(r?.regions) ? r.regions.filter((x) => x && typeof x.name === 'string' && isRange(x.range)) : [];
      return { types, regions, reasonCode: r?.reasonCode ?? null, completeness: r?.completeness ?? 'unknown', snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Compiler diagnostics of a document (protocol 1.24); null for an older host. */
  documentDiagnostics(uri: string, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').DocumentDiagnosticsResult | null>> {
    return this.semantic('code/diagnostics', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 24) return null;
      const r = await s.transport.request('code/diagnostics', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri }, token);
      return { diagnostics: Array.isArray(r?.diagnostics) ? r.diagnostics : [], reasonCode: r?.reasonCode ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Hover (protocol 1.23); null for an older host. */
  hover(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').HoverResult | null>> {
    return this.semantic('code/hover', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 23) return null;
      const r = await s.transport.request('code/hover', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      return { signature: r?.signature ?? null, sections: Array.isArray(r?.sections) ? r.sections : [], range: r?.range ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Signature help (protocol 1.23); null for an older host. */
  signatureHelp(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').SignatureHelpResult | null>> {
    return this.semantic('code/signatureHelp', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 23) return null;
      const r = await s.transport.request('code/signatureHelp', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      return { signatures: Array.isArray(r?.signatures) ? r.signatures : [], activeSignature: r?.activeSignature ?? 0, activeParameter: r?.activeParameter ?? 0, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Editor completion (protocol 1.22); null for an older host. */
  completion(uri: string, position: Position, triggerCharacter: string | undefined, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').CompletionResult | null>> {
    return this.semantic('code/completion', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 22) return null;
      const r = await s.transport.request('code/completion', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position, ...(triggerCharacter ? { triggerCharacter } : {}) }, token);
      return { listId: String(r?.listId ?? ''), range: r?.range ?? null, items: Array.isArray(r?.items) ? r.items : [], reasonCode: r?.reasonCode ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  completionResolve(listId: string, index: number, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').CompletionResolveResult | null>> {
    return this.semantic('code/completionResolve', token, async (s, _snapshotId, traceId) => {
      if (s.protocolMinor < 22) return null;
      const r = await s.transport.request('code/completionResolve', { traceId, workspaceId: this.opts.workspaceId, listId, index }, token);
      return { detail: r?.detail ?? null, documentation: r?.documentation ?? null, textEdit: r?.textEdit ?? null, additionalTextEdits: Array.isArray(r?.additionalTextEdits) ? r.additionalTextEdits : [] };
    });
  }

  /** Immediate window completions (protocol 1.21); null for an older host. */
  expressionCompletions(uri: string, position: Position, text: string, caret: number, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').ExpressionCompletionsResult | null>> {
    return this.semantic('code/expressionCompletions', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 21) return null;
      const r = await s.transport.request('code/expressionCompletions', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position, text, caret }, token);
      return { items: Array.isArray(r?.items) ? r.items.filter((x): x is string => typeof x === 'string') : [], reasonCode: r?.reasonCode ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Smart Step Into (protocol 1.14): the calls of the stopped statement; null for an older host. */
  stepIntoTargets(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').StepIntoTargetsResult | null>> {
    return this.semantic('code/stepIntoTargets', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 14) return null;
      const r = await s.transport.request('code/stepIntoTargets', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      const isRange = (x: unknown): boolean => !!x && typeof x === 'object' && !!(x as { start?: unknown }).start && !!(x as { end?: unknown }).end;
      const targets = Array.isArray(r?.targets)
        ? r.targets
            .filter((t) => t && typeof t.label === 'string' && typeof t.kind === 'string' && isRange(t.callRange))
            .map((t) => ({ ...t, detail: typeof t.detail === 'string' ? t.detail : '', isVirtual: !!t.isVirtual, breakAt: t.breakAt && typeof t.breakAt.uri === 'string' && isRange(t.breakAt.range) ? t.breakAt : null }))
        : [];
      return { targets, statement: isRange(r?.statement) ? r.statement : null, nextStatement: r?.nextStatement ?? null, reasonCode: r?.reasonCode ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Test discovery (protocol 1.15): every test project, or only `uris`; null for an older host. */
  tests(uris: string[] | undefined, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').TestsResult | null>> {
    return this.semantic('code/tests', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 15) return null;
      const r = await s.transport.request('code/tests', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...(uris && uris.length ? { uris } : {}) }, token);
      const isRange = (x: unknown): boolean => !!x && typeof x === 'object' && !!(x as { start?: unknown }).start && !!(x as { end?: unknown }).end;
      const strings = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
      const tests = Array.isArray(r?.tests)
        ? r.tests
            .filter((t) => t && typeof t.fullyQualifiedName === 'string' && typeof t.uri === 'string' && typeof t.projectUri === 'string' && typeof t.method === 'string' && isRange(t.range) && isRange(t.nameRange))
            .map((t) => ({
              ...t,
              namespace: typeof t.namespace === 'string' ? t.namespace : '',
              framework: typeof t.framework === 'string' ? t.framework : '',
              classes: Array.isArray(t.classes) ? t.classes.filter((c) => c && typeof c.name === 'string' && isRange(c.range) && isRange(c.nameRange)) : [],
              cases: Array.isArray(t.cases) ? t.cases.filter((c) => c && typeof c.label === 'string' && isRange(c.range)).map((c) => ({ ...c, arguments: strings(c.arguments) })) : [],
              dynamicCases: !!t.dynamicCases,
              skipReason: typeof t.skipReason === 'string' ? t.skipReason : null,
            }))
            .filter((t) => t.classes.length > 0)
        : [];
      const projects = Array.isArray(r?.projects)
        ? r.projects.filter((p) => p && typeof p.name === 'string' && typeof p.projectUri === 'string').map((p) => ({ ...p, frameworks: strings(p.frameworks) }))
        : [];
      return { projects, tests, documents: Array.isArray(r?.documents) ? strings(r.documents) : null, state: typeof r?.state === 'string' ? r.state : 'unknown', snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** EF Core migrations (protocol 1.18): DbContexts with migrations, snapshot and configurations; null for an older host. */
  efMigrations(token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').EfMigrationsResult | null>> {
    return this.semantic('efcore/migrations', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 18) return null;
      const r = await s.transport.request('efcore/migrations', { traceId, workspaceId: this.opts.workspaceId, snapshotId }, token);
      return sanitizeEfMigrations(r, snapshotId);
    });
  }

  /** Edit actions (protocol 1.9): list at a range, or compute one action; null for an older host. */
  editActions(uri: string, range: import('@refyntra/contracts').Range, actionId: string | undefined, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').EditActionsResult | null>> {
    return this.semantic('code/editActions', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 9) return null;
      const r = await s.transport.request('code/editActions', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, range, ...(actionId ? { actionId } : {}) }, token);
      const items = Array.isArray(r?.items) ? r.items.filter((i) => i && typeof i.actionId === 'string' && typeof i.title === 'string' && typeof i.kind === 'string') : [];
      const edits = Array.isArray(r?.edits) ? r.edits.filter((e) => e && e.range && e.range.start && e.range.end && typeof e.newText === 'string') : null;
      return { items, edits, documentHash: r?.documentHash ?? null, reasonCode: r?.reasonCode ?? null, message: r?.message ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Postfix templates (protocol 1.10); null for an older host. */
  postfix(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').PostfixResult | null>> {
    return this.semantic('code/postfix', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 10) return null;
      const r = await s.transport.request('code/postfix', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position }, token);
      const items = Array.isArray(r?.items)
        ? r.items.filter((i) => i && typeof i.name === 'string' && typeof i.snippet === 'string').map((i) => ({ name: i.name, detail: typeof i.detail === 'string' ? i.detail : '', snippet: i.snippet }))
        : [];
      const range = r?.expressionRange && r.expressionRange.start && r.expressionRange.end ? r.expressionRange : null;
      return { items, expressionRange: range, typeName: typeof r?.typeName === 'string' ? r.typeName : null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Generate (protocol 1.10): list the kinds (no request) or compute one; null for an older host. */
  generate(uri: string, position: Position, request: import('./adapters').GenerateRequest | undefined, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').GenerateResult | null>> {
    return this.semantic('code/generate', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 10) return null;
      const r = await s.transport.request('code/generate', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position, ...(request ?? {}) }, token);
      const kinds = Array.isArray(r?.kinds)
        ? r.kinds
            .filter((k) => k && typeof k.kind === 'string' && typeof k.title === 'string')
            .map((k) => ({ ...k, members: Array.isArray(k.members) ? k.members.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string').map((m) => ({ ...m, detail: typeof m.detail === 'string' ? m.detail : '', picked: !!m.picked })) : [] }))
        : [];
      const edits = Array.isArray(r?.edits) ? r.edits.filter((e) => e && e.range && e.range.start && e.range.end && typeof e.newText === 'string') : null;
      return { typeName: r?.typeName ?? null, kinds, edits, documentHash: r?.documentHash ?? null, reasonCode: r?.reasonCode ?? null, message: r?.message ?? null, snapshotId: r?.snapshotId ?? snapshotId };
    });
  }

  /** Constructor / DI actions (protocol 1.11): list (no request) or compute one; null for an older host. */
  constructorActions(uri: string, position: Position, request: import('./adapters').ConstructorRequest | undefined, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').ConstructorActionsResult | null>> {
    return this.semantic('code/constructorActions', token, async (s, snapshotId, traceId) => {
      if (s.protocolMinor < 11) return null;
      const r = await s.transport.request('code/constructorActions', { traceId, workspaceId: this.opts.workspaceId, snapshotId, uri, position, ...(request ?? {}) }, token);
      const choices = (x: unknown) => (Array.isArray(x) ? x.filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string').map((c) => ({ id: c.id, label: c.label, detail: typeof c.detail === 'string' ? c.detail : null, picked: !!c.picked })) : []);
      const items = Array.isArray(r?.items) ? r.items.filter((i) => i && typeof i.actionId === 'string' && typeof i.title === 'string').map((i) => ({ ...i, kind: (i.kind === 'quickfix' ? 'quickfix' : 'rewrite') as 'quickfix' | 'rewrite', preferred: !!i.preferred })) : [];
      const files = Array.isArray(r?.files)
        ? r.files.filter((f) => f && typeof f.uri === 'string' && typeof f.documentHash === 'string' && Array.isArray(f.edits)).map((f) => ({ ...f, edits: f.edits.filter((e) => e && e.range && e.range.start && e.range.end && typeof e.newText === 'string') }))
        : null;
      const reg = r?.registration ? { service: r.registration.service ?? null, serviceId: r.registration.serviceId ?? null, implementations: choices(r.registration.implementations), roots: choices(r.registration.roots), lifetimes: Array.isArray(r.registration.lifetimes) ? r.registration.lifetimes : [] } : null;
      return {
        items, files, need: r?.need ?? null, choices: r?.choices ? choices(r.choices) : null, note: r?.note ?? null, registerTypeId: r?.registerTypeId ?? null, registerTypeName: r?.registerTypeName ?? null,
        registration: reg, reasonCode: r?.reasonCode ?? null, message: r?.message ?? null, snapshotId: r?.snapshotId ?? snapshotId,
      };
    });
  }

  /** Run and Debug (protocol 1.8): the runnable-project model of the loaded workspace; null for an older host. */
  async runnableProjects(token?: CancellationToken): Promise<import('@refyntra/contracts').RunnableProjectsResult | null> {
    const session = await this.whenReady(token);
    if (session.protocolMinor < 8) return null;
    const r = await session.transport.request('workspace/runnableProjects', { traceId: this.traceIds.next(), workspaceId: this.opts.workspaceId }, token);
    const projects = Array.isArray(r?.projects)
      ? r.projects
          .filter((p) => p && typeof p.name === 'string' && typeof p.projectUri === 'string' && typeof p.kind === 'string')
          .map((p) => ({ ...p, runnable: !!p.runnable, windowsOnly: !!p.windowsOnly, targetFrameworks: Array.isArray(p.targetFrameworks) ? p.targetFrameworks.filter((t) => typeof t === 'string') : [], outputs: Array.isArray(p.outputs) ? p.outputs.filter((o) => o && typeof o.outputUri === 'string') : [] }))
      : [];
    return { projects, state: typeof r?.state === 'string' ? r.state : 'unknown', snapshotId: r?.snapshotId ?? null };
  }

  /** Solution Explorer (protocol 1.20): the solution model of the loaded workspace; null for an older host. */
  async solutionStructure(token?: CancellationToken): Promise<import('@refyntra/contracts').SolutionStructureResult | null> {
    const session = await this.whenReady(token);
    if (session.protocolMinor < 20) return null;
    const r = await session.transport.request('solution/structure', { traceId: this.traceIds.next(), workspaceId: this.opts.workspaceId }, token);
    return normalizeSolutionStructure(r);
  }

  /** workspace/reload in the running host (project files changed). False when no session is up. */
  async reloadWorkspace(token?: CancellationToken): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    await session.transport.request('workspace/reload', { traceId: this.traceIds.next(), workspaceId: this.opts.workspaceId }, token);
    return true;
  }

  discard(planId: string): void {
    try {
      this.session?.transport.notify('refactor/discard', { workspaceId: this.opts.workspaceId, planId });
    } catch {
      // Session gone: the plan died with it.
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
    this.opts.logger.log(level, this.descriptor.providerRouteId, message, fields);
  }
}

/** A well-formed `RelatedResult.scopeDetails` (anything else is dropped; the client then uses scopeNotes). */
export function isScopeDetails(v: unknown): v is ScopeDetails {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const c = d.causes as Record<string, unknown> | undefined;
  return (
    ['projectsTotal', 'projectsComplete', 'projectsPartial', 'projectsFailed'].every((k) => num(d[k])) &&
    !!c && typeof c === 'object' && ['missingAssets', 'missingPackages', 'missingProjectReferences', 'loadFailures', 'otherErrors'].every((k) => num(c[k])) &&
    typeof d.restoreRecommended === 'boolean' &&
    (d.solutionPath === null || typeof d.solutionPath === 'string') &&
    Array.isArray(d.frameworks) &&
    d.frameworks.every((f) => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.evidence === 'string' && typeof f.versionVerified === 'boolean')
  );
}

/** Untrusted host data → the EF Core view's model: drops malformed entries, keeps the host's order. */
export function sanitizeEfMigrations(r: unknown, snapshotId: string): import('@refyntra/contracts').EfMigrationsResult {
  const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === 'string';
  const loc = (x: unknown): import('@refyntra/contracts').Location | null => {
    const l = x as { uri?: unknown; range?: { start?: unknown; end?: unknown } } | null | undefined;
    return l && str(l.uri) && l.range && l.range.start && l.range.end ? (l as import('@refyntra/contracts').Location) : null;
  };
  const named = (x: unknown): import('@refyntra/contracts').EfNamedLocation | null => {
    const n = x as { name?: unknown; location?: unknown } | null | undefined;
    return n && str(n.name) ? { name: n.name, location: loc(n.location) } : null;
  };
  const contexts = Array.isArray(o.contexts)
    ? o.contexts
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && str((c as Record<string, unknown>).name) && str((c as Record<string, unknown>).projectUri))
        .map((c) => ({
          name: c.name as string,
          fullName: str(c.fullName) ? c.fullName : (c.name as string),
          projectName: str(c.projectName) ? c.projectName : '',
          projectUri: c.projectUri as string,
          migrationsProjectUri: str(c.migrationsProjectUri) ? c.migrationsProjectUri : (c.projectUri as string),
          migrationsNamespace: str(c.migrationsNamespace) ? c.migrationsNamespace : null,
          location: loc(c.location),
          onModelCreating: loc(c.onModelCreating),
          migrations: Array.isArray(c.migrations)
            ? c.migrations
                .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && str((m as Record<string, unknown>).id))
                .map((m) => ({ id: m.id as string, name: str(m.name) ? m.name : (m.id as string), className: str(m.className) ? m.className : '', location: loc(m.location), designerLocation: loc(m.designerLocation) }))
            : [],
          snapshot: named(c.snapshot),
          configurations: Array.isArray(c.configurations) ? c.configurations.map(named).filter((x): x is import('@refyntra/contracts').EfNamedLocation => !!x) : [],
        }))
    : [];
  return { contexts, state: str(o.state) ? o.state : 'unknown', snapshotId: str(o.snapshotId) ? o.snapshotId : snapshotId };
}

/** A well-formed solution/structure result: malformed entries are dropped (the host is a separate process). */
export function normalizeSolutionStructure(r: unknown): import('@refyntra/contracts').SolutionStructureResult {
  const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === 'string';
  const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const rec = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined);
  const ok = (x: Record<string, unknown> | undefined, ...keys: string[]): x is Record<string, unknown> => !!x && keys.every((k) => str(x[k]));
  const opt = (x: unknown): string | null => (str(x) ? x : null);
  const folders = arr(o.folders)
    .map(rec)
    .filter((f): f is Record<string, unknown> => ok(f, 'id', 'name'))
    .map((f) => ({ id: f.id as string, name: f.name as string, parentId: opt(f.parentId), fileUris: arr(f.fileUris).filter(str) }));
  const projects = arr(o.projects)
    .map(rec)
    .filter((p): p is Record<string, unknown> => ok(p, 'name', 'projectUri'))
    .map((p) => ({
      name: p.name as string,
      projectUri: p.projectUri as string,
      folderId: opt(p.folderId),
      kind: opt(p.kind) ?? 'unknown',
      targetFrameworks: arr(p.targetFrameworks).filter(str),
      state: opt(p.state) ?? 'unknown',
      sdk: opt(p.sdk),
      centralPackageManagement: p.centralPackageManagement === true,
      packagesPropsUri: opt(p.packagesPropsUri),
      projectReferences: arr(p.projectReferences).map(rec).filter((x): x is Record<string, unknown> => ok(x, 'name', 'projectUri')).map((x) => ({ name: x.name as string, projectUri: x.projectUri as string })),
      packages: arr(p.packages)
        .map(rec)
        .filter((x): x is Record<string, unknown> => ok(x, 'id'))
        .map((x) => ({ id: x.id as string, version: opt(x.version), resolvedVersion: opt(x.resolvedVersion), central: x.central === true, versionOverride: x.versionOverride === true })),
      frameworks: arr(p.frameworks).filter(str),
      analyzers: arr(p.analyzers).map(rec).filter((x): x is Record<string, unknown> => ok(x, 'name')).map((x) => ({ name: x.name as string, uri: opt(x.uri) })),
      items: arr(p.items)
        .map(rec)
        .filter((x): x is Record<string, unknown> => ok(x, 'uri', 'virtualPath'))
        .map((x) => ({ uri: x.uri as string, itemType: opt(x.itemType) ?? 'None', virtualPath: x.virtualPath as string, linked: x.linked === true })),
      excludedUris: arr(p.excludedUris).filter(str),
      itemsTruncated: p.itemsTruncated === true,
    }));
  return { state: opt(o.state) ?? 'unknown', snapshotId: opt(o.snapshotId), solutionUri: opt(o.solutionUri), format: opt(o.format) ?? 'unknown', folders, projects };
}
