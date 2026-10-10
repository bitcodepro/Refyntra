import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Emitter, type Disposable } from '@refyntra/application';

export interface ProcessLaunch {
  command: string;
  /** Arguments as a separate array: never interpolated by a shell. */
  args: readonly string[];
  cwd?: string;
  /** Extra environment variables (merged over the parent environment). */
  env?: Record<string, string>;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ProcessStartError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessStartError';
  }
}

/** A supervised child process. `dispose` kills the whole process tree (MSBuild/BuildHost children included). */
export class SupervisedProcess {
  private exitInfo: ProcessExit | undefined;
  private readonly exitEmitter = new Emitter<ProcessExit>();
  readonly exited: Promise<ProcessExit>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise<ProcessExit>((resolve) => {
      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        this.exitEmitter.fire(this.exitInfo);
        resolve(this.exitInfo);
      });
    });
  }

  /** Spawns without a shell and resolves once the OS confirmed the process started. */
  static start(launch: ProcessLaunch): Promise<SupervisedProcess> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(launch.command, [...launch.args], {
          cwd: launch.cwd,
          env: launch.env ? { ...process.env, ...launch.env } : process.env,
          shell: false,
          windowsHide: true,
          // POSIX: own process group so the whole tree can be killed.
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new ProcessStartError((e as NodeJS.ErrnoException).code, (e as Error).message));
        return;
      }
      const onError = (e: NodeJS.ErrnoException) => reject(new ProcessStartError(e.code, e.message));
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        child.on('error', () => undefined);
        resolve(new SupervisedProcess(child));
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdin() {
    return this.child.stdin;
  }

  get stdout() {
    return this.child.stdout;
  }

  get stderr() {
    return this.child.stderr;
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  onExit(listener: (e: ProcessExit) => void): Disposable {
    if (this.exitInfo) {
      const info = this.exitInfo;
      queueMicrotask(() => listener(info));
      return { dispose: () => undefined };
    }
    return this.exitEmitter.event(listener);
  }

  /** Closes stdin, waits up to `graceMs` for a voluntary exit, then kills the process tree. */
  async dispose(graceMs = 1500): Promise<void> {
    if (this.hasExited) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const timedOut = await Promise.race([this.exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs).unref?.())]);
    if (timedOut && !this.hasExited) await this.killTree();
    else this.killGroupRemains();
  }

  /**
   * POSIX: the host ran in its own process group; after it exited voluntarily, members of that group (BuildHost,
   * MSBuild nodes) may still run — kill them. Windows: the host's Job Object (KILL_ON_JOB_CLOSE) already ended them.
   */
  private killGroupRemains(): void {
    const pid = this.child.pid;
    if (pid === undefined || process.platform === 'win32') return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ESRCH: the group is already empty.
    }
  }

  async killTree(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || this.hasExited) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('exit', () => resolve());
        killer.once('error', () => {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        });
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000).unref?.())]);
  }
}
