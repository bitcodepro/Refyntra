import type { MethodMap, MethodName, NotificationMap, NotificationName, PlannedChange } from '@refyntra/contracts';
import type { CancellationToken } from './cancellation';
import type { Disposable } from './util';

/** A JSON-RPC connection to one backend session (one process lifetime). */
export interface Transport {
  request<M extends MethodName>(method: M, params: MethodMap[M][0], token?: CancellationToken): Promise<MethodMap[M][1]>;
  notify<N extends NotificationName>(method: N, params: NotificationMap[N]): void;
  /** Fires once when the connection is gone: process exit, stream end, malformed/oversized frame. */
  onClose(listener: (error?: Error) => void): Disposable;
  /** Tear down the connection and the process tree behind it. */
  dispose(): Promise<void>;
}

export interface TransportStartContext {
  providerRouteId: string;
  attempt: number;
}

/** Creates a new backend session; rejects with StartupError for known startup problems. */
export type TransportFactory = (ctx: TransportStartContext) => Promise<Transport>;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): Disposable;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured logger. Callers pass operation metadata only — never source text, edit text or environment values
 * values. Implementations additionally redact known text-bearing keys.
 */
export interface Logger {
  log(level: LogLevel, component: string, message: string, fields?: Record<string, unknown>): void;
}

export const NullLogger: Logger = { log: () => undefined };

/**
 * Edit application is owned by the presentation layer. The only caller of the editor's
 * apply. Text edits are applied in one all-or-nothing edit; file renames (if any) follow as separate operations
 * only after every text target was confirmed, and are reconciled one by one. Nothing is rolled back.
 */
export interface EditApplier {
  /**
   * Async part, run AFTER the final backend revalidation: reads the current text of every closed target from disk
   * (open buffers are read synchronously in `commit`). Must not open documents (that would be an editor event).
   * Resolves `{ ok: false }` for a non-text change, a non-file target or an unreadable file.
   */
  capture(writeSet: readonly PlannedChange[]): Promise<CapturedEdit | { ok: false; reason: string; uri?: string }>;
}

export interface CapturedEdit {
  ok: true;
  /**
   * Fully synchronous: checks every target's current text hash against `expectedHash` (open buffer text, or the
   * disk text read by `capture` for closed files) and that the edits produce `resultHash`; then starts the editor
   * apply without any await in between. `result` resolves after the apply with a post-state reconciliation.
   */
  commit(): CommitResult;
}

export type CommitResult = { started: true; result: Promise<ApplyReport> } | { started: false; reason: string; uri?: string };

/** confirmed = text hash equals resultHash; unchanged = still expectedHash; unknown = anything else / unreadable. */
export type TargetStatus = 'confirmed' | 'unchanged' | 'unknown';

export interface ApplyFileReport {
  uri: string;
  status: TargetStatus;
  detail?: string;
}

/**
 * File rename post-state. confirmed = the new file exists with the planned text and the old one is
 * gone; not-attempted = the text edits were not all confirmed, so the rename was not started; refused = a check right
 * before the rename failed (e.g. the target appeared), nothing was renamed; failed = the editor rejected the rename and
 * the old file is still there; unknown = anything else.
 */
export type ResourceStatus = 'confirmed' | 'not-attempted' | 'refused' | 'failed' | 'unknown';

export interface ApplyResourceReport {
  kind: 'rename';
  oldUri: string;
  newUri: string;
  status: ResourceStatus;
  detail?: string;
}

export interface ApplyReport {
  /** What the editor's apply returned. Never trusted on its own: `files` is the reconciled post-state. */
  editorAccepted: boolean;
  files: ApplyFileReport[];
  /** File rename: one entry per planned file rename, in plan order (absent for a text-only plan). */
  resources?: ApplyResourceReport[];
}

export interface TrustProvider {
  isTrusted(): boolean;
}

export type WorkspaceTarget =
  | { kind: 'path'; path: string }
  | { kind: 'none'; reasonCode: string; message: string };

export interface WorkspaceTargetProvider {
  /** The solution/project (or other root) the adapter should open. Reading only, no evaluation. */
  resolveTarget(adapterId: string): Promise<WorkspaceTarget>;
}

export interface ApplicationSettings {
  /** refyntra.rename.apply */
  applyRenameEnabled(): boolean;
}
