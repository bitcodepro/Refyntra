import { PassThrough } from 'node:stream';
import type { MethodMap, MethodName, NotificationMap, NotificationName } from '@refyntra/contracts';
import { type CancellationToken, CancellationSource, CancelledError, type Disposable, Emitter, type Transport, TransportError } from '@refyntra/application';
import { JsonRpcConnection } from '@refyntra/infrastructure';
import type { FixtureEngine } from './fixtureEngine';

/** A transport whose backend can be crashed by tests. */
export interface CrashableTransport extends Transport {
  readonly engine: FixtureEngine;
  crash(reason?: string): void;
}

/**
 * In-memory transport: no framing, but params/results are deep-cloned (structuredClone) so neither side can share
 * object identity, and every call is asynchronous like a real connection.
 */
export class InMemoryTransport implements CrashableTransport {
  private closed = false;
  private readonly closeEmitter = new Emitter<Error | undefined>();
  private readonly inflight = new Set<(e: Error) => void>();

  constructor(readonly engine: FixtureEngine) {}

  async request<M extends MethodName>(method: M, params: MethodMap[M][0], token?: CancellationToken): Promise<MethodMap[M][1]> {
    if (this.closed) throw new TransportError('closed', 'Closed');
    if (token?.isCancellationRequested) throw new CancelledError();
    const source = new CancellationSource(token);
    let onCrash: (e: Error) => void = () => undefined;
    const interrupted = new Promise<never>((_, reject) => {
      source.token.onCancellationRequested(() => reject(new CancelledError()));
      onCrash = reject;
    });
    interrupted.catch(() => undefined);
    this.inflight.add(onCrash);
    try {
      const copy = structuredClone(params);
      await Promise.resolve();
      const result = await Promise.race([this.engine.handle(method, copy, source.token), interrupted]);
      if (this.closed) throw new TransportError('Backend closed', 'BackendExited');
      return structuredClone(result) as MethodMap[M][1];
    } finally {
      this.inflight.delete(onCrash);
      source.dispose();
    }
  }

  notify<N extends NotificationName>(method: N, params: NotificationMap[N]): void {
    if (this.closed) throw new TransportError('closed', 'Closed');
    this.engine.notify(method, structuredClone(params));
  }

  onClose(listener: (error?: Error) => void): Disposable {
    return this.closeEmitter.event(listener);
  }

  crash(reason = 'crashed by test'): void {
    if (this.closed) return;
    this.closed = true;
    this.engine.stop();
    const error = new TransportError(reason, 'BackendExited');
    for (const reject of this.inflight) reject(error);
    this.closeEmitter.fire(error);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.engine.stop();
  }
}

/**
 * Serializing loopback: the real infrastructure JsonRpcConnection (Content-Length framing, ids, $/cancelRequest)
 * on both ends of two in-process pipes.
 */
export class LoopbackTransport implements CrashableTransport {
  private readonly c2s = new PassThrough();
  private readonly s2c = new PassThrough();
  readonly client: JsonRpcConnection;
  readonly server: JsonRpcConnection;

  constructor(
    readonly engine: FixtureEngine,
    maxMessageBytes?: number,
  ) {
    this.client = new JsonRpcConnection(this.s2c, this.c2s, { name: 'loopback-client', ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}) });
    this.server = new JsonRpcConnection(this.c2s, this.s2c, { name: 'loopback-server' });
    this.server.onRequest((method, params, token) => engine.handle(method, params, token));
    this.server.onNotification((method, params) => engine.notify(method, params));
  }

  request: Transport['request'] = (method, params, token) => this.client.request(method, params, token);
  notify: Transport['notify'] = (method, params) => this.client.notify(method, params);
  onClose: Transport['onClose'] = (listener) => this.client.onClose(listener);

  /** Simulates a process death: the server side ends its output stream. */
  crash(): void {
    this.engine.stop();
    this.server.fail(new TransportError('server crashed', 'BackendExited'), false);
    this.s2c.end();
  }

  /** Writes raw bytes to the client as if the backend sent them (malformed frame tests). */
  injectRaw(bytes: Buffer | string): void {
    this.s2c.write(bytes);
  }

  async dispose(): Promise<void> {
    this.engine.stop();
    await this.client.dispose();
    await this.server.dispose();
    this.c2s.end();
    this.s2c.end();
  }
}

export type FixtureTransportKind = 'memory' | 'loopback';
