import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';
const DEBOUNCE_MS = 600;

function active(): boolean {
  return vscode.workspace.getConfiguration('refyntra').get<boolean>('editor.diagnostics', true) && !vscode.extensions.getExtension(CSHARP_EXTENSION);
}

/**
 * The C# compiler's errors and warnings of the open C# files in Problems (collection "refyntra-csharp", source "C#"),
 * recomputed shortly after an edit. Off while the C# extension is installed (it reports them itself).
 */
export function registerCompilerDiagnostics(engine: EngineClient): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('refyntra-csharp');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const versions = new Map<string, number>();

  const refresh = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'csharp' || doc.uri.scheme !== 'file' || !engine.documentDiagnostics) return;
    if (!active()) {
      collection.delete(doc.uri);
      return;
    }
    const version = doc.version;
    versions.set(doc.uri.toString(), version);
    const list = await engine.documentDiagnostics(doc.uri.toString()).catch(() => undefined);
    if (!list || versions.get(doc.uri.toString()) !== version) return;
    collection.set(doc.uri, list.map((d) => {
      const diag = new vscode.Diagnostic(new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character), d.message,
        d.severity === 'error' ? vscode.DiagnosticSeverity.Error : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
      diag.code = d.code;
      diag.source = 'C#';
      if (d.unnecessary) {
        diag.tags = [vscode.DiagnosticTag.Unnecessary];
        diag.severity = vscode.DiagnosticSeverity.Hint;
      }
      return diag;
    }));
  };
  const schedule = (doc: vscode.TextDocument, delay = DEBOUNCE_MS) => {
    const key = doc.uri.toString();
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void refresh(doc);
    }, delay));
  };
  for (const d of vscode.workspace.textDocuments) schedule(d, 1500);
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 200)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      collection.delete(d.uri);
      versions.delete(d.uri.toString());
    }),
    // A change elsewhere (another file, a reload) can break or fix this one: the visible C# files are checked again.
    vscode.workspace.onDidSaveTextDocument(() => {
      for (const e of vscode.window.visibleTextEditors) schedule(e.document, 300);
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => e && schedule(e.document, 100)),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );
}
