import { Emitter, type Disposable } from './util';

/** Structural subset of vscode.CancellationToken so presentation can pass its own tokens through. */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

export const CancellationToken_None: CancellationToken = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
});

export class CancellationSource {
  private cancelled = false;
  private readonly emitter = new Emitter<void>();
  private parentSub: Disposable | undefined;

  constructor(parent?: CancellationToken) {
    if (parent) {
      if (parent.isCancellationRequested) this.cancelled = true;
      else this.parentSub = parent.onCancellationRequested(() => this.cancel());
    }
  }

  readonly token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void): Disposable => {
      if (this.cancelled) {
        listener();
        return { dispose: () => undefined };
      }
      return this.emitter.event(listener);
    },
  };

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    this.emitter.fire();
    this.emitter.dispose();
  }

  dispose(): void {
    this.parentSub?.dispose();
    this.emitter.dispose();
  }
}

/** Throws CancelledError when the token is cancelled. */
export function throwIfCancelled(token: CancellationToken | undefined): void {
  if (token?.isCancellationRequested) throw new CancelledError();
}

export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'CancelledError';
  }
}

export function isCancelledError(e: unknown): e is CancelledError {
  return e instanceof CancelledError;
}

/** Resolves/rejects like `promise`, or rejects with CancelledError as soon as the token is cancelled. */
export function raceCancellation<T>(promise: Promise<T>, token: CancellationToken | undefined): Promise<T> {
  if (!token) return promise;
  if (token.isCancellationRequested) return Promise.reject(new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const sub = token.onCancellationRequested(() => reject(new CancelledError()));
    promise.then(
      (v) => {
        sub.dispose();
        resolve(v);
      },
      (e) => {
        sub.dispose();
        reject(e);
      },
    );
  });
}
