import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { shouldTrackDocument } from './documentScope';

/**
 * Forwards every open/change/save/close of documents a Refyntra route handles. Recording is immediate
 * (no debounce) and always full text; only the file: scheme is synchronised.
 *
 * Documents outside the workspace folders (for example lib.dom.d.ts that a definition lookup opens inside
 * the VS Code installation) are tracked only once they have unsaved edits: merely opening or closing such a
 * read-only file is not a change of the workspace and must not make results stale.
 */
export function registerDocumentSync(engine: EngineClient): vscode.Disposable {
  const tracked = new Set<string>();
  const routed = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && engine.handlesDocument(doc.uri.toString(), doc.languageId);
  const relevant = (doc: vscode.TextDocument) =>
    routed(doc) && shouldTrackDocument({ inWorkspace: vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined, dirty: doc.isDirty, tracked: tracked.has(doc.uri.toString()) });
  const open = (doc: vscode.TextDocument) => {
    tracked.add(doc.uri.toString());
    engine.documentOpened(doc.uri.toString(), doc.languageId, doc.version, doc.getText(), doc.isDirty);
  };

  for (const doc of vscode.workspace.textDocuments) if (relevant(doc)) open(doc);

  return vscode.Disposable.from(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (relevant(doc)) open(doc);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0 || !relevant(e.document)) return;
      // An outside file becomes tracked with its first edit: send it as opened (full text) first.
      if (!tracked.has(e.document.uri.toString())) return open(e.document);
      engine.documentChanged(e.document.uri.toString(), e.document.languageId, e.document.version, e.document.getText(), e.document.isDirty);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (tracked.has(doc.uri.toString())) engine.documentSaved(doc.uri.toString(), doc.languageId, doc.version, doc.getText());
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (tracked.delete(doc.uri.toString())) engine.documentClosed(doc.uri.toString());
    }),
  );
}
