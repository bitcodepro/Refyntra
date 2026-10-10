import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';

/**
 * Forwards every open/change/save/close of documents a Refyntra route handles. Recording is immediate
 * (no debounce) and always full text; only the file: scheme is synchronised.
 */
export function registerDocumentSync(engine: EngineClient): vscode.Disposable {
  const relevant = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && engine.handlesDocument(doc.uri.toString(), doc.languageId);

  for (const doc of vscode.workspace.textDocuments) {
    if (relevant(doc)) engine.documentOpened(doc.uri.toString(), doc.languageId, doc.version, doc.getText(), doc.isDirty);
  }

  return vscode.Disposable.from(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (relevant(doc)) engine.documentOpened(doc.uri.toString(), doc.languageId, doc.version, doc.getText(), doc.isDirty);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0 || !relevant(e.document)) return;
      engine.documentChanged(e.document.uri.toString(), e.document.languageId, e.document.version, e.document.getText(), e.document.isDirty);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (relevant(doc)) engine.documentSaved(doc.uri.toString(), doc.languageId, doc.version, doc.getText());
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === 'file') engine.documentClosed(doc.uri.toString());
    }),
  );
}
