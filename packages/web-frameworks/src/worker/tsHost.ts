import * as path from 'node:path';
import type * as TS from 'typescript';

// TypeScript project hosting inside the worker: tsserver's ProjectService (public `ts.server` API of the bundled
// TypeScript) on a host that never writes, never installs typings and loads exactly one plugin: the bundled Angular
// language service, and only when asked to. Project plugins named in a tsconfig are refused. File watching is done by
// the extension (VS Code's watcher); changes arrive as `filesChanged` and are dispatched to the registered callbacks.

type WatchCallback = (fileName: string, kind: number) => void;
type DirCallback = (fileName: string) => void;

export const norm = (p: string): string => p.split(path.sep).join('/');

export class WatchRegistry {
  private readonly files = new Map<string, Set<WatchCallback>>();
  private readonly dirs = new Map<string, { cb: DirCallback; recursive: boolean }[]>();

  watchFile(file: string, cb: WatchCallback): TS.FileWatcher {
    const key = norm(file).toLowerCase();
    let set = this.files.get(key);
    if (!set) this.files.set(key, (set = new Set()));
    set.add(cb);
    return { close: () => set!.delete(cb) };
  }

  watchDirectory(dir: string, cb: DirCallback, recursive: boolean | undefined): TS.FileWatcher {
    const key = norm(dir).toLowerCase().replace(/\/$/, '');
    const entry = { cb, recursive: !!recursive };
    const list = this.dirs.get(key) ?? [];
    list.push(entry);
    this.dirs.set(key, list);
    return {
      close: () => {
        const l = this.dirs.get(key);
        if (l) this.dirs.set(key, l.filter((e) => e !== entry));
      },
    };
  }

  /** kind: 0 created, 1 changed, 2 deleted (ts.FileWatcherEventKind). */
  fire(file: string, kind: 0 | 1 | 2): void {
    const n = norm(file);
    const lower = n.toLowerCase();
    for (const cb of [...(this.files.get(lower) ?? [])]) cb(n, kind);
    if (kind === 1) return;
    let dir = path.posix.dirname(lower);
    let direct = true;
    for (;;) {
      for (const e of [...(this.dirs.get(dir) ?? [])]) if (direct || e.recursive) e.cb(n);
      const up = path.posix.dirname(dir);
      if (up === dir) break;
      dir = up;
      direct = false;
    }
  }
}

const silentLogger = (ts: typeof TS): TS.server.Logger => ({
  close: () => undefined,
  hasLevel: () => false,
  loggingEnabled: () => false,
  perftrc: () => undefined,
  info: () => undefined,
  startGroup: () => undefined,
  endGroup: () => undefined,
  msg: (s: string, type?: TS.server.Msg) => {
    if (type === ts.server.Msg.Err) process.stderr.write(`[typescript] ${s.slice(0, 500)}\n`);
  },
  getLogFileName: () => undefined,
});

export interface ProjectHostOptions {
  ts: typeof TS;
  watches: WatchRegistry;
  /** The bundled Angular language service plugin factory (only for the Angular project service). */
  angularPlugin?: unknown;
  /** Passed to the Angular plugin as its config (angularCoreVersion of the projects). */
  angularConfig?: Record<string, unknown>;
}

export function createProjectService(o: ProjectHostOptions): TS.server.ProjectService {
  const { ts } = o;
  const host: TS.server.ServerHost = {
    ...ts.sys,
    // Never write: the worker only reads the workspace.
    writeFile: () => undefined,
    createDirectory: () => undefined,
    deleteFile: () => undefined,
    watchFile: (f: string, cb: WatchCallback) => o.watches.watchFile(f, cb),
    watchDirectory: (d: string, cb: DirCallback, recursive?: boolean) => o.watches.watchDirectory(d, cb, recursive),
    setTimeout: setTimeout as unknown as TS.server.ServerHost['setTimeout'],
    clearTimeout: clearTimeout as unknown as TS.server.ServerHost['clearTimeout'],
    setImmediate: setImmediate as unknown as TS.server.ServerHost['setImmediate'],
    clearImmediate: clearImmediate as unknown as TS.server.ServerHost['clearImmediate'],
    // Plugin loading: only the bundled Angular language service; everything else (tsconfig plugins) is refused.
    require: (_dir: string, name: string) =>
      name === '@angular/language-service' && o.angularPlugin
        ? { module: o.angularPlugin as TS.server.PluginModuleFactory, error: undefined }
        : { module: undefined, error: { message: `Refyntra does not load TypeScript plugins (${name}).` } },
  } as TS.server.ServerHost;
  const ps = new ts.server.ProjectService({
    host,
    logger: silentLogger(ts),
    cancellationToken: ts.server.nullCancellationToken,
    useSingleInferredProject: false,
    useInferredProjectPerProjectRoot: true,
    typingsInstaller: ts.server.nullTypingsInstaller,
    globalPlugins: o.angularPlugin ? ['@angular/language-service'] : [],
    pluginProbeLocations: o.angularPlugin ? [path.dirname(process.execPath)] : [],
    allowLocalPluginLoads: false,
    serverMode: ts.LanguageServiceMode.Semantic,
    session: undefined,
    jsDocParsingMode: ts.JSDocParsingMode.ParseForTypeErrors,
  } as TS.server.ProjectServiceOptions);
  ps.setHostConfiguration({
    preferences: { includeCompletionsForModuleExports: false },
    ...(o.angularPlugin ? { extraFileExtensions: [{ extension: '.html', isMixedContent: false, scriptKind: ts.ScriptKind.Deferred }] } : {}),
  });
  if (o.angularPlugin && o.angularConfig) ps.configurePlugin({ pluginName: '@angular/language-service', configuration: o.angularConfig });
  return ps;
}
