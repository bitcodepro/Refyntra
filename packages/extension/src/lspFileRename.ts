import * as vscode from 'vscode';
import type { LspLanguageAdapter } from '@refyntra/adapter-lsp';

/**
 * Renaming or moving files of a language server route (e.g. Rust) in VS Code: the server is asked first
 * (workspace/willRenameFiles) and its text edits — `mod` declarations, imports — are applied together with the rename,
 * as one Undo step. Afterwards the server hears workspace/didRenameFiles. A server that does not ask for it is left alone.
 */
export function forwardFileRenames(adapter: LspLanguageAdapter, extensions: readonly string[]): vscode.Disposable {
  const ours = (u: vscode.Uri) => u.scheme === 'file' && (extensions.some((e) => u.path.toLowerCase().endsWith(e)) || !/\.[^/]+$/.test(u.path));
  const pairs = (files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]) =>
    files.filter((f) => ours(f.oldUri)).map((f) => ({ oldUri: f.oldUri.toString(), newUri: f.newUri.toString() }));
  return vscode.Disposable.from(
    vscode.workspace.onWillRenameFiles((e) => {
      const files = pairs(e.files);
      if (files.length === 0) return;
      e.waitUntil(
        (async () => {
          const source = new vscode.CancellationTokenSource();
          const timer = setTimeout(() => source.cancel(), 5000);
          try {
            const changes = await adapter.willRenameFiles(files, source.token);
            const edit = new vscode.WorkspaceEdit();
            for (const c of changes) {
              const uri = vscode.Uri.parse(c.uri, true);
              for (const t of c.edits) edit.replace(uri, new vscode.Range(t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character), t.newText);
            }
            return edit;
          } catch {
            return new vscode.WorkspaceEdit();
          } finally {
            clearTimeout(timer);
            source.dispose();
          }
        })(),
      );
    }),
    vscode.workspace.onDidRenameFiles((e) => adapter.didRenameFiles(pairs(e.files))),
  );
}
