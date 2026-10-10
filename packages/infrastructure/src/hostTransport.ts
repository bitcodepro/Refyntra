import { StartupError, type Logger, type Transport, type TransportFactory, TransportError } from '@refyntra/application';
import { DEFAULT_MAX_MESSAGE_BYTES } from './framing';
import { JsonRpcConnection } from './jsonRpc';
import { type ProcessLaunch, ProcessStartError, SupervisedProcess } from './process';

export interface HostTransportOptions {
  /** Resolves how to start the host; throw StartupError (e.g. HostNotFound) when it cannot be started. */
  resolveLaunch: () => Promise<ProcessLaunch>;
  logger: Logger;
  maxMessageBytes?: number;
  /** Observes every successful spawn (used by tests to prove Restricted Mode never spawns). */
  onSpawn?: (launch: ProcessLaunch, pid: number | undefined) => void;
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Forwards the host's structured stderr lines (JSON per line, never source text) to the logger. */
function pipeStderr(proc: SupervisedProcess, logger: Logger): void {
  let rest = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    rest += chunk;
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        const level = typeof j.level === 'string' && LEVELS.has(j.level.toLowerCase()) ? (j.level.toLowerCase() as 'info') : 'info';
        const { msg, level: _l, component, ts: _ts, ...fields } = j;
        logger.log(level, `host:${typeof component === 'string' ? component : 'host'}`, typeof msg === 'string' ? msg : '', fields);
      } catch {
        logger.log('info', 'host:stderr', line.length > 500 ? `${line.slice(0, 500)}…` : line);
      }
    }
    if (rest.length > 64 * 1024) rest = '';
  });
}

class ProcessTransport implements Transport {
  constructor(
    private readonly proc: SupervisedProcess,
    private readonly conn: JsonRpcConnection,
  ) {
    proc.onExit((e) => conn.fail(new TransportError(`Host exited (code ${e.code ?? 'none'}${e.signal ? `, ${e.signal}` : ''})`, 'BackendExited')));
  }

  request: Transport['request'] = (method, params, token) => this.conn.request(method, params, token);
  notify: Transport['notify'] = (method, params) => this.conn.notify(method, params);
  onClose: Transport['onClose'] = (l) => this.conn.onClose(l);

  async dispose(): Promise<void> {
    await this.conn.dispose();
    await this.proc.dispose();
  }
}

export function createHostTransportFactory(options: HostTransportOptions): TransportFactory {
  return async () => {
    const launch = await options.resolveLaunch();
    let proc: SupervisedProcess;
    try {
      proc = await SupervisedProcess.start(launch);
    } catch (e) {
      if (e instanceof ProcessStartError && e.code === 'ENOENT') {
        throw new StartupError('ExecutableNotFound', `Cannot start "${launch.command}": not found. Install the .NET SDK/runtime or set refyntra.hostPath.`, false);
      }
      throw new StartupError('HostStartFailed', `Cannot start the Refyntra host: ${(e as Error).message}`, true);
    }
    options.onSpawn?.(launch, proc.pid);
    options.logger.log('info', 'host', 'host process started', { pid: proc.pid });
    pipeStderr(proc, options.logger);
    const conn = new JsonRpcConnection(proc.stdout, proc.stdin, {
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      logger: options.logger,
      name: 'host-rpc',
    });
    conn.onClose(() => {
      // Any fatal transport error (malformed frame etc.) tears the process down; the adapter restarts it.
      void proc.dispose(500);
    });
    return new ProcessTransport(proc, conn);
  };
}
