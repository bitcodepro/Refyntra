import type { Readable, Writable } from 'node:stream';
import type { MethodMap, MethodName, NotificationMap, NotificationName, RpcErrorData } from '@refyntra/contracts';
import { ErrorCodes } from '@refyntra/contracts';
import {
  type CancellationToken,
  CancellationSource,
  CancelledError,
  type Disposable,
  Emitter,
  type Logger,
  NullLogger,
  RpcError,
  type Transport,
  TransportError,
} from '@refyntra/application';
import { DEFAULT_MAX_MESSAGE_BYTES, FramingError, MessageReader, encodeMessage } from './framing';

type Id = number | string;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cancelSub?: Disposable;
}

export type RequestHandler = (method: string, params: unknown, token: CancellationToken) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface JsonRpcConnectionOptions {
  maxMessageBytes?: number;
  logger?: Logger;
  /** Component name used in logs. */
  name?: string;
}

/**
 * JSON-RPC 2.0 peer over a Content-Length framed stream pair. Used as the client Transport to the host and, in
 * tests, as the server side of a serializing loopback. Malformed/oversized incoming frames are fatal.
 */
export class JsonRpcConnection implements Transport {
  private nextId = 1;
  private readonly pending = new Map<Id, Pending>();
  private readonly incoming = new Map<Id, CancellationSource>();
  private closed = false;
  private closeError: Error | undefined;
  private readonly closeEmitter = new Emitter<Error | undefined>();
  private readonly reader: MessageReader;
  private requestHandler: RequestHandler | undefined;
  private notificationHandler: NotificationHandler | undefined;
  private readonly maxMessageBytes: number;
  private readonly logger: Logger;
  private readonly name: string;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: JsonRpcConnectionOptions = {},
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.logger = options.logger ?? NullLogger;
    this.name = options.name ?? 'rpc';
    this.reader = new MessageReader(
      (m) => this.dispatch(m),
      (e) => this.fail(new TransportError(e.message, e.reasonCode)),
      this.maxMessageBytes,
    );
    input.on('data', (chunk: Buffer | string) => this.reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    input.on('end', () => this.fail(new TransportError('Backend closed its output stream', 'StreamClosed')));
    input.on('error', (e) => this.fail(new TransportError(`Input stream error: ${e.message}`, 'StreamError')));
    output.on('error', (e) => this.fail(new TransportError(`Output stream error: ${e.message}`, 'StreamError')));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onClose(listener: (error?: Error) => void): Disposable {
    if (this.closed) {
      queueMicrotask(() => listener(this.closeError));
      return { dispose: () => undefined };
    }
    return this.closeEmitter.event(listener);
  }

  request<M extends MethodName>(method: M, params: MethodMap[M][0], token?: CancellationToken): Promise<MethodMap[M][1]> {
    return this.sendRequest(method, params, token) as Promise<MethodMap[M][1]>;
  }

  sendRequest(method: string, params: unknown, token?: CancellationToken): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new TransportError('Connection is closed', 'Closed'));
    if (token?.isCancellationRequested) return Promise.reject(new CancelledError());
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      this.pending.set(id, entry);
      if (token) {
        entry.cancelSub = token.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.trySend({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
          // A late reply for this id is ignored (no publication after cancel).
          reject(new CancelledError());
        });
      }
      if (!this.trySend({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        entry.cancelSub?.dispose();
        reject(new TransportError(`Request ${method} could not be sent`, 'SendFailed'));
      }
    });
  }

  notify<N extends NotificationName>(method: N, params: NotificationMap[N]): void {
    this.sendNotification(method, params);
  }

  sendNotification(method: string, params: unknown): void {
    if (this.closed) throw this.closeError ?? new TransportError('Connection is closed', 'Closed');
    if (!this.trySend({ jsonrpc: '2.0', method, params })) throw new TransportError(`Notification ${method} could not be sent`, 'SendFailed');
  }

  async dispose(): Promise<void> {
    this.fail(new TransportError('Connection disposed', 'Disposed'), false);
  }

  /** Closes the connection; rejects every pending request. */
  fail(error: Error, log = true): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    if (log) this.logger.log('warn', this.name, 'connection closed', { reason: error.message, code: error instanceof TransportError ? error.reasonCode : undefined });
    for (const [, p] of this.pending) {
      p.cancelSub?.dispose();
      p.reject(error);
    }
    this.pending.clear();
    for (const [, s] of this.incoming) s.cancel();
    this.incoming.clear();
    this.input.removeAllListeners('data');
    this.closeEmitter.fire(error);
    this.closeEmitter.dispose();
  }

  private trySend(message: object): boolean {
    if (this.closed) return false;
    const frame = encodeMessage(message);
    if (frame.length > this.maxMessageBytes) {
      this.logger.log('error', this.name, 'outgoing frame too large', { bytes: frame.length });
      return false;
    }
    try {
      this.output.write(frame);
      return true;
    } catch (e) {
      this.fail(new TransportError(`Write failed: ${(e as Error).message}`, 'StreamError'));
      return false;
    }
  }

  private dispatch(raw: unknown): void {
    const m = raw as { id?: Id | null; method?: unknown; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: RpcErrorData } };
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) this.handleRequest(m.id, m.method, m.params);
      else this.handleNotification(m.method, m.params);
      return;
    }
    if (m.id === undefined || m.id === null) {
      if (m.error) this.logger.log('warn', this.name, 'peer reported an error without id', { code: m.error.code });
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return; // Cancelled or unknown: drop silently.
    this.pending.delete(m.id);
    p.cancelSub?.dispose();
    if (m.error) {
      if (m.error.code === ErrorCodes.Cancelled) p.reject(new CancelledError());
      else p.reject(new RpcError(typeof m.error.code === 'number' ? m.error.code : -32603, String(m.error.message ?? 'error'), m.error.data));
    } else if ('result' in m) {
      p.resolve(m.result);
    } else {
      const error = new TransportError(`Response to ${p.method} has neither result nor error`, 'MalformedFrame');
      p.reject(error);
      this.fail(error);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === '$/cancelRequest') {
      const id = (params as { id?: Id } | undefined)?.id;
      if (id !== undefined) this.incoming.get(id)?.cancel();
      return;
    }
    try {
      this.notificationHandler?.(method, params);
    } catch (e) {
      this.logger.log('warn', this.name, 'notification handler failed', { method, error: (e as Error).message });
    }
  }

  private handleRequest(id: Id, method: string, params: unknown): void {
    const handler = this.requestHandler;
    if (!handler) {
      this.trySend({ jsonrpc: '2.0', id, error: { code: ErrorCodes.MethodNotFound, message: `Method ${method} is not handled by this peer` } });
      return;
    }
    const source = new CancellationSource();
    this.incoming.set(id, source);
    handler(method, params, source.token).then(
      (result) => {
        this.incoming.delete(id);
        if (source.token.isCancellationRequested) {
          this.trySend({ jsonrpc: '2.0', id, error: { code: ErrorCodes.Cancelled, message: 'Request cancelled' } });
        } else {
          this.trySend({ jsonrpc: '2.0', id, result: result ?? null });
        }
      },
      (e: unknown) => {
        this.incoming.delete(id);
        if (e instanceof CancelledError || source.token.isCancellationRequested) {
          this.trySend({ jsonrpc: '2.0', id, error: { code: ErrorCodes.Cancelled, message: 'Request cancelled' } });
        } else if (e instanceof RpcError) {
          this.trySend({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
        } else {
          this.trySend({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
        }
      },
    );
  }
}

export { FramingError };
