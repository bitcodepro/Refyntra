import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { StartupError, type Logger } from '@refyntra/application';
import { type FileChange, WebFrameworkService } from '@refyntra/web-frameworks';
import { type WorkerLaunch, WorkerProcess, hasWebProject } from '@refyntra/web-frameworks/node';

// Refyntra's web worker (React / Next.js / Angular, ADR-007): dist/webWorker.js on VS Code's own Node runtime with
// the TypeScript and Angular language service bundled in servers/. Started lazily, trusted workspaces only.

/** Heap limit of the worker process (V8 --max-old-space-size) and the soft limit after which it restarts itself. */
export const WEB_WORKER_HEAP_MB = 3072;
export const WEB_WORKER_SOFT_LIMIT_MB = 2560;

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function webWorkerLaunch(extensionPath: string, devFallback: boolean): WorkerLaunch {
  const worker = path.join(extensionPath, 'dist', 'webWorker.js');
  const pkgModules = path.resolve(extensionPath, '..', 'web-frameworks', 'node_modules');
  const tsCandidates = [path.join(extensionPath, 'servers', 'typescript'), ...(devFallback ? [path.join(pkgModules, 'typescript', 'lib')] : [])];
  const ngCandidates = [path.join(extensionPath, 'servers', 'angular-language-service'), ...(devFallback ? [path.join(pkgModules, '@angular', 'language-service')] : [])];
  const tsDir = tsCandidates.find((d) => isFile(path.join(d, 'typescript.js')));
  const ngDir = ngCandidates.find((d) => isFile(path.join(d, 'bundles', 'language-service.js')));
  if (!isFile(worker) || !tsDir) throw new StartupError('ServerNotFound', 'The bundled web worker (TypeScript compiler) is missing from this installation of Refyntra. Reinstall the extension.');
  return {
    command: process.execPath,
    args: [`--max-old-space-size=${WEB_WORKER_HEAP_MB}`, worker, '--typescript', tsDir, ...(ngDir ? ['--angular', ngDir] : []), '--memory-limit', String(WEB_WORKER_SOFT_LIMIT_MB)],
    cwd: path.dirname(worker),
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export interface WebFrameworksSetup {
  service: WebFrameworkService;
  process: WorkerProcess;
  launches: WorkerLaunch[];
  disposable: vscode.Disposable;
}

export function setupWebFrameworks(o: {
  extensionPath: string;
  devFallback: boolean;
  logger: Logger;
  isTrusted: () => boolean;
  openDocuments: () => readonly { uri: string; languageId: string; text: string; dirty: boolean }[];
  routeIds: readonly string[];
  revision: () => number;
}): WebFrameworksSetup {
  const launches: WorkerLaunch[] = [];
  const folders = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const proc = new WorkerProcess({
    resolveLaunch: () => webWorkerLaunch(o.extensionPath, o.devFallback),
    log: (level, message, fields) => o.logger.log(level, 'web-worker', message, fields),
    onSpawn: (l) => launches.push(l),
  });
  const service = new WebFrameworkService({
    port: proc,
    roots: () => folders().map((f) => f.uri.toString()),
    isTrusted: o.isTrusted,
    hasWebProject: async () => hasWebProject(folders().map((f) => f.uri.fsPath)),
    openDocuments: o.openDocuments,
    routeIds: o.routeIds,
    normalizeUri: (u) => vscode.Uri.parse(u, true).toString(),
    revision: o.revision,
  });
  const watcher = vscode.workspace.createFileSystemWatcher('**/{*.ts,*.tsx,*.js,*.jsx,*.mjs,*.cjs,*.mts,*.cts,*.html,package.json,tsconfig*.json,jsconfig*.json}');
  const pending: FileChange[] = [];
  let timer: NodeJS.Timeout | undefined;
  const push = (uri: vscode.Uri, type: FileChange['type']) => {
    if (/[\\/]node_modules[\\/]/.test(uri.fsPath)) return;
    pending.push({ uri: uri.toString(), type });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => service.filesChanged(pending.splice(0)), 300);
  };
  const disposable = vscode.Disposable.from(
    watcher,
    watcher.onDidCreate((u) => push(u, 'created')),
    watcher.onDidChange((u) => push(u, 'changed')),
    watcher.onDidDelete((u) => push(u, 'deleted')),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      service.resetDetection();
      void proc.stop();
    }),
    { dispose: () => void proc.dispose() },
  );
  return { service, process: proc, launches, disposable };
}
