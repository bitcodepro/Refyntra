import type { RecoveryAction, RpcErrorData } from '@refyntra/contracts';
import { ErrorCodes } from '@refyntra/contracts';
import type { AdapterHealth } from '@refyntra/domain';


/** JSON-RPC error returned by a backend. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: RpcErrorData,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  get reasonCode(): string | undefined {
    return this.data?.reasonCode;
  }
}

/** The transport failed (process exit, malformed frame, oversized frame, closed stream). */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string = 'TransportFailed',
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** A response belonged to an epoch/snapshot/revision that is no longer current and was dropped. */
export class StaleResultError extends Error {
  constructor(readonly reason: 'epoch' | 'snapshot' | 'revision' | 'backend') {
    super(`Result dropped: ${reason} changed while the request was running`);
    this.name = 'StaleResultError';
  }
}

/** The adapter cannot accept semantic requests in its current state. */
export class AdapterUnavailableError extends Error {
  constructor(readonly health: AdapterHealth) {
    super(health.message ?? `${health.displayName} is ${health.state}`);
    this.name = 'AdapterUnavailableError';
  }
}

/**
 * A route cannot answer this request, with a machine reason (e.g. a delegated provider is absent, returned nothing
 * or threw). Shown as an explicit unavailable reason, never as an empty result.
 */
export class RouteUnavailableError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly recoveryActions: RecoveryAction[] = [],
  ) {
    super(message);
    this.name = 'RouteUnavailableError';
  }
}

/** Starting the backend failed with a known reason (host not found, SDK missing, ...). */
export class StartupError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * Only -33004 StaleSnapshot means "the snapshot moved on, barrier and ask again". -33005 UnknownSymbol is a real
 * error (the id cannot be resolved in the current snapshot) and is reported, not retried.
 */
export function isStaleRpcError(e: unknown): boolean {
  return e instanceof RpcError && e.code === ErrorCodes.StaleSnapshot;
}

/** -33008 BarrierTimeout (older hosts: -32602 with reasonCode BarrierTimeout): a document event was lost. */
export function isBarrierTimeout(e: unknown): boolean {
  return e instanceof RpcError && (e.code === ErrorCodes.BarrierTimeout || e.reasonCode === 'BarrierTimeout');
}

/** User-facing text of an error: the backend message plus its recovery hint (error.data.recovery), when present. */
export function describeErrorWithRecovery(e: unknown): string {
  if (e instanceof RpcError) {
    const message = e.data?.message ?? e.message;
    return e.data?.recovery ? `${message} ${e.data.recovery}` : message;
  }
  return describeError(e);
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
