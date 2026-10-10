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
  /** Protocol minor of the backend (1.2+ understands workspace/didRenameFiles). */
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
  private send<N extends 'textDocument/didOpen' | 'textDocument/didChange' | 'textDocument/didSave' | 'textDocument/didClose' | 'workspace/didRenameFiles'>(
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
    return this.semantic('refactor/prepare', token, (s, snapshotId, traceId) =>
      s.transport.request('refactor/prepare', { traceId, workspaceId: this.opts.workspaceId, snapshotId, actionId: req.actionId, symbolId: req.symbolId, newName: req.newName, ...(req.renameFile ? { renameFile: true } : {}) }, token),
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
  analyze(params: { uri?: string }, token?: CancellationToken): Promise<RouteResult<import('@refyntra/contracts').AnalysisRunResult>> {
    return this.semantic(
      'analysis/run',
      token,
      async (s, snapshotId, traceId) => {
        const r = await s.transport.request('analysis/run', { traceId, workspaceId: this.opts.workspaceId, snapshotId, ...(params.uri ? { uri: params.uri } : {}) }, token);
        const isLoc = (l: unknown): boolean => !!l && typeof (l as { uri?: unknown }).uri === 'string' && !!(l as { range?: unknown }).range;
        return {
          diagnostics: Array.isArray(r?.diagnostics)
            ? r.diagnostics
                .filter((d) => d && typeof d.id === 'string' && typeof d.message === 'string' && isLoc(d.location))
                .map((d) => ({ ...d, relatedLocations: Array.isArray(d.relatedLocations) ? d.relatedLocations.filter((x) => x && isLoc(x.location)) : [], evidence: Array.isArray(d.evidence) ? d.evidence : [] }))
            : [],
          abstentions: Array.isArray(r?.abstentions) ? r.abstentions.filter((a) => a && typeof a.reason === 'string') : [],
          completeness: r?.completeness ?? 'unknown',
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
