import { type ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { WorkerMethod, WorkerMethods, WorkerResponseMessage } from '../protocol';
import type { WorkerPort, WorkerPortEvents } from '../service';

// The extension-side end of the web worker: spawn, JSON-line requests with timeouts, crash restart policy, idle
// shutdown. Node only (no vscode); the extension passes the launch and the logger.

export interface WorkerLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface WorkerProcessOptions {
  resolveLaunch: () => WorkerLaunch;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  onSpawn?: (launch: WorkerLaunch, pid: number | undefined) => void;
  /** Per-request timeout (default 60 s). */
  requestTimeoutMs?: number;
  /** Stop the process after this long without a request (default 10 min); it starts again on the next request. */
  idleShutdownMs?: number;
  /** Crashes within `crashWindowMs` that stop automatic restarts (default 3 in 5 min). */
  maxCrashes?: number;
  crashWindowMs?: number;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export class WorkerProcessError extends Error {
  constructor(
    readonly code: 'WorkerCrashed' | 'WorkerTimeout' | 'WorkerStopped' | 'WorkerFailed',
    message: string,
  ) {
    super(message);
  }
}

export class WorkerProcess implements WorkerPort {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private crashes: number[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private epoch = 0;
  private readonly listeners: WorkerPortEvents[] = [];
  private lastStderr: string[] = [];

  constructor(private readonly o: WorkerProcessOptions) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** Increments on every (re)start: results of an older process are never mixed with a newer one. */
  sessionEpoch(): string {
    return `web-${this.epoch}`;
  }

  onEvents(l: WorkerPortEvents): void {
    this.listeners.push(l);
  }

  private start(): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < (this.o.crashWindowMs ?? 300_000));
    if (this.crashes.length >= (this.o.maxCrashes ?? 3)) {
      throw new WorkerProcessError('WorkerFailed', `The web worker stopped ${this.crashes.length} times in a short time; it is not restarted automatically now. Last output: ${this.lastStderr.slice(-3).join(' | ') || 'none'}. Use "Refyntra: Restart Backend" or reload the window.`);
    }
    const launch = this.o.resolveLaunch();
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.epoch++;
    this.o.onSpawn?.(launch, child.pid);
    this.o.log?.('info', 'web worker started', { pid: child.pid });
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      this.lastStderr.push(line.slice(0, 300));
      if (this.lastStderr.length > 20) this.lastStderr.shift();
      this.o.log?.('warn', 'web worker stderr', { line: line.slice(0, 300) });
    });
    child.on('error', (e) => this.onExit(child, null, e));
    child.on('exit', (code) => this.onExit(child, code));
    for (const l of this.listeners) l.onStart?.();
  }

  private onLine(line: string): void {
    let m: WorkerResponseMessage;
    try {
      m = JSON.parse(line) as WorkerResponseMessage;
    } catch {
      this.o.log?.('warn', 'web worker sent a malformed line');
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    else p.resolve(m.result);
  }

  private onExit(child: ChildProcess, code: number | null, error?: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    const expected = this.disposed || code === 0;
    if (!expected) {
      this.crashes.push(Date.now());
      this.o.log?.(code === 3 ? 'warn' : 'error', code === 3 ? 'web worker reached its memory limit; it restarts on the next request' : 'web worker exited', { code, error: error?.message });
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WorkerProcessError(expected ? 'WorkerStopped' : 'WorkerCrashed', code === 3 ? 'The web worker reached its memory limit and is restarted.' : `The web worker stopped (exit code ${code ?? 'none'}${error ? `, ${error.message}` : ''}).`));
    }
    this.pending.clear();
    for (const l of this.listeners) l.onExit?.(expected);
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.o.idleShutdownMs ?? 600_000;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) void this.stop();
    }, ms);
    this.idleTimer.unref?.();
  }

  request<M extends WorkerMethod>(method: M, params: WorkerMethods[M][0]): Promise<WorkerMethods[M][1]> {
    if (this.disposed) return Promise.reject(new WorkerProcessError('WorkerStopped', 'The web worker was shut down.'));
    if (!this.running) this.start();
    this.armIdle();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerProcessError('WorkerTimeout', `The web worker did not answer ${method} within ${Math.round((this.o.requestTimeoutMs ?? 60_000) / 1000)} s.`));
      }, this.o.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Stops the process (it starts again on demand). */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await Promise.race([this.request('shutdown', {}), new Promise((r) => setTimeout(r, 2000))]);
    } catch {
      // already gone
    }
    if (child.exitCode === null) child.kill();
  }

  /** Clears the crash history (explicit restart by the user). */
  resetCrashes(): void {
    this.crashes = [];
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.stop();
    this.disposed = true;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }
}
