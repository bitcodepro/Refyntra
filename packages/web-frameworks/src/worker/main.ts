import * as path from 'node:path';
import * as readline from 'node:readline';
import type * as TS from 'typescript';
import type { WorkerRequestMessage, WorkerResponseMessage } from '../protocol';
import { WebAnalyzer } from './analyzer';

// Entry of Refyntra's web worker process (dist/webWorker.js). Started by the extension on VS Code's own Node runtime
// (ELECTRON_RUN_AS_NODE=1) with --max-old-space-size. Arguments:
//   --typescript <dir>   the bundled TypeScript (servers/typescript)
//   --angular <dir>      the bundled @angular/language-service (servers/angular-language-service); optional
//   --memory-limit <MB>  exit with code 3 after a request when the heap grows past this (the extension restarts it)
// One JSON request per stdin line, one JSON response per stdout line. Nothing else is written to stdout.

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// Keep stdout for protocol messages only.
console.log = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
console.info = console.log;
console.warn = console.log;

const tsDir = arg('--typescript');
if (!tsDir) {
  process.stderr.write('--typescript is required\n');
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require(path.resolve(tsDir, 'typescript.js')) as typeof TS;
const angularDir = arg('--angular');
let angularPlugin: unknown;
if (angularDir) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundle = require(path.resolve(angularDir, 'bundles', 'language-service.js')) as (m: { typescript: typeof TS }) => { initialize(m: { typescript: typeof TS }): unknown };
    angularPlugin = (mod: { typescript: typeof TS }) => bundle(mod).initialize(mod);
  } catch (e) {
    process.stderr.write(`Angular language service could not be loaded: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
const memoryLimitMB = Number(arg('--memory-limit') ?? '0');

const analyzer = new WebAnalyzer({ ts, ...(angularPlugin ? { angularPlugin } : {}) });

function send(m: WorkerResponseMessage): void {
  process.stdout.write(`${JSON.stringify(m)}\n`);
}

function handle(req: WorkerRequestMessage): unknown {
  const p = req.params as never;
  switch (req.method) {
    case 'initialize':
      return analyzer.initialize((p as { roots: string[] }).roots);
    case 'related':
      return analyzer.related(p);
    case 'find':
      return analyzer.find(p);
    case 'filesChanged':
      analyzer.filesChanged((p as { changes: [] }).changes);
      return { ok: true };
    case 'memory':
      return analyzer.memory();
    case 'shutdown':
      analyzer.dispose();
      setImmediate(() => process.exit(0));
      return { ok: true };
    default:
      throw Object.assign(new Error(`Unknown method ${String(req.method)}`), { code: 'MethodNotFound' });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: WorkerRequestMessage;
  try {
    req = JSON.parse(line) as WorkerRequestMessage;
  } catch {
    process.stderr.write('malformed request line\n');
    return;
  }
  try {
    send({ id: req.id, result: handle(req) });
  } catch (e) {
    send({ id: req.id, error: { code: (e as { code?: string }).code ?? 'InternalError', message: e instanceof Error ? e.message : String(e) } });
  }
  if (memoryLimitMB > 0 && process.memoryUsage().heapUsed / 1048576 > memoryLimitMB) {
    process.stderr.write(`memory limit reached (${memoryLimitMB} MB); exiting for a restart\n`);
    process.exit(3);
  }
});
rl.on('close', () => process.exit(0));
