import * as vscode from 'vscode';
import type { ClientSourcePort } from '@refyntra/application';
import { ALWAYS_EXCLUDED, excludeGlob } from './httpClientFiles';

// Workspace side of HTML/CSS links: which files are scanned (stylesheets, HTML pages, TS/JS sources) and how the index
// stays current. Bounded like the HTTP client scan: at most MAX_FILES files of at most MAX_FILE_BYTES each; dependency
// and output folders, files.exclude and search.exclude are skipped. Files are only read, nothing is executed.

export const WEB_FILE_GLOB = '**/*.{css,scss,less,html,htm,ts,tsx,js,jsx,mjs,cjs,mts,cts}';
const WEB_FILE_RE = /\.(css|scss|less|html?|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;

export class VsCodeWebFiles implements ClientSourcePort {
  async listFiles(token?: vscode.CancellationToken): Promise<readonly string[]> {
    const files = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude') ?? {};
    const search = vscode.workspace.getConfiguration('search').get<Record<string, unknown>>('exclude') ?? {};
    const exclude = excludeGlob(files, search).replace(/^\{/, '{**/*.min.css,');
    const uris = await vscode.workspace.findFiles(WEB_FILE_GLOB, exclude, MAX_FILES + 1, token);
    // Stylesheets and pages first, so a large code base never pushes them past the limit.
    const rank = (p: string) => (/\.(css|scss|less|html?)$/i.test(p) ? 0 : 1);
    return uris.filter((u) => u.scheme === 'file').map((u) => u.toString()).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
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

interface WebIndexLike {
  fileChanged(uri: string, text: string): void;
  fileDeleted(uri: string): void;
  reset(): void;
}

/** Keeps the HTML/CSS index current: saves and file events update it, folder/exclude changes rescan. */
export function registerWebStyleIndexSync(index: WebIndexLike, files: VsCodeWebFiles): vscode.Disposable {
  const isWeb = (u: vscode.Uri) => u.scheme === 'file' && WEB_FILE_RE.test(u.path) && !/\.d\.[mc]?ts$/i.test(u.path) && !u.path.split('/').some((s) => ALWAYS_EXCLUDED.includes(s));
  const refresh = async (u: vscode.Uri) => {
    if (!isWeb(u)) return;
    // An open document is tracked from the editor (dirty text included); the disk state does not override it.
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString() && d.isDirty)) return;
    const text = await files.readFile(u.toString());
    if (text === undefined) index.fileDeleted(u.toString());
    else index.fileChanged(u.toString(), text);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(WEB_FILE_GLOB);
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange((u) => void refresh(u)),
    watcher.onDidCreate((u) => void refresh(u)),
    watcher.onDidDelete((u) => index.fileDeleted(u.toString())),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (isWeb(d.uri)) index.fileChanged(d.uri.toString(), d.getText());
    }),
    // TS/JS documents belong to the TS/JS route: their unsaved text reaches the index here.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isWeb(e.document.uri) && !/\.(css|scss|less|html?)$/i.test(e.document.uri.path)) index.fileChanged(e.document.uri.toString(), e.document.getText());
    }),
    vscode.workspace.onDidCloseTextDocument((d) => void refresh(d.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => index.reset()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) index.reset();
    }),
  );
}
