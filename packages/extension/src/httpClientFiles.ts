import * as vscode from 'vscode';
import type { ClientSourcePort, HttpLinkService, HttpLinkSettings } from '@refyntra/application';

// Workspace side of HTTP linking: which TS/JS files are scanned for client calls, and how the index stays current.
// Bounded: at most MAX_FILES files of at most MAX_FILE_BYTES each; dependency and output folders are skipped, and
// files.exclude / search.exclude apply. Nothing is executed; files are only read.

export const CLIENT_FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}';
/** Folders never scanned (dependencies, build output, VCS). */
export const ALWAYS_EXCLUDED = ['node_modules', 'bower_components', 'dist', 'build', 'out', 'bin', 'obj', '.git', 'coverage', '.next', '.nuxt', '.angular', 'wwwroot/lib'];
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;

/** One exclude glob: always-excluded folders + `true` entries of files.exclude and search.exclude; minified and .d.ts files. */
export function excludeGlob(filesExclude: Record<string, unknown> = {}, searchExclude: Record<string, unknown> = {}): string {
  const patterns = new Set<string>([...ALWAYS_EXCLUDED.map((d) => `**/${d}/**`), '**/*.min.js', '**/*.d.ts', '**/*.bundle.js']);
  for (const [k, v] of [...Object.entries(filesExclude), ...Object.entries(searchExclude)]) if (v === true && !k.includes('{') && !k.includes(',')) patterns.add(k);
  return `{${[...patterns].join(',')}}`;
}

export class VsCodeClientFiles implements ClientSourcePort {
  async listFiles(token?: vscode.CancellationToken): Promise<readonly string[]> {
    const files = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude') ?? {};
    const search = vscode.workspace.getConfiguration('search').get<Record<string, unknown>>('exclude') ?? {};
    const uris = await vscode.workspace.findFiles(CLIENT_FILE_GLOB, excludeGlob(files, search), MAX_FILES + 1, token);
    return uris.filter((u) => u.scheme === 'file').map((u) => u.toString()).sort();
  }

  async readFile(uri: string): Promise<string | undefined> {
    try {
      const u = vscode.Uri.parse(uri);
      const stat = await vscode.workspace.fs.stat(u);
      if (stat.size > MAX_FILE_BYTES) return undefined;
      return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(u));
    } catch {
      return undefined;
    }
  }
}

export function httpLinkSettings(): HttpLinkSettings {
  const cfg = () => vscode.workspace.getConfiguration('refyntra.http');
  const list = (key: string) => (cfg().get<unknown[]>(key) ?? []).filter((x): x is string => typeof x === 'string');
  return { basePaths: () => list('basePaths'), origins: () => list('origins') };
}

/** Keeps the client call index current: saves and file events update it, folder/exclude changes rescan. */
export function registerClientIndexSync(service: HttpLinkService, files: VsCodeClientFiles): vscode.Disposable {
  const isClient = (u: vscode.Uri) => u.scheme === 'file' && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(u.path) && !/\.d\.ts$/i.test(u.path) && !u.path.split('/').some((s) => ALWAYS_EXCLUDED.includes(s));
  const refresh = async (u: vscode.Uri) => {
    if (!isClient(u)) return;
    const text = await files.readFile(u.toString());
    if (text === undefined) service.index.fileDeleted(u.toString());
    else service.index.fileChanged(u.toString(), text);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(CLIENT_FILE_GLOB);
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange((u) => void refresh(u)),
    watcher.onDidCreate((u) => void refresh(u)),
    watcher.onDidDelete((u) => service.index.fileDeleted(u.toString())),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (isClient(d.uri)) service.index.fileChanged(d.uri.toString(), d.getText());
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => service.index.reset()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) service.index.reset();
    }),
  );
}
