import * as vscode from 'vscode';
import type { LspDiagnostic, LspLanguageAdapter } from '@refyntra/adapter-lsp';
import { newErrors } from './lspDiagnosticsModel';

/**
 * Errors and warnings of the language servers Refyntra runs itself (Pyright, rust-analyzer) in the editor and the
 * Problems panel. Without this their diagnostics were dropped: the servers are not VS Code providers.
 */
const adapters = new Map<string, LspLanguageAdapter>();

function toVs(d: LspDiagnostic, source: string): vscode.Diagnostic {
  const r = new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character);
  const severity = d.severity === 1 ? vscode.DiagnosticSeverity.Error : d.severity === 2 ? vscode.DiagnosticSeverity.Warning : d.severity === 3 ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint;
  const out = new vscode.Diagnostic(r, d.message, severity);
  out.source = d.source ?? source;
  if (d.code !== undefined) out.code = d.code;
  return out;
}

export function forwardLspDiagnostics(adapter: LspLanguageAdapter, serverName: string): vscode.Disposable {
  adapters.set(adapter.descriptor.providerRouteId, adapter);
  const collection = vscode.languages.createDiagnosticCollection(`refyntra-${serverName}`);
  const sub = adapter.onDidPublishDiagnostics((e) => {
    if (e.kind === 'clear') return collection.clear();
    const uri = vscode.Uri.parse(e.uri, true);
    if (uri.scheme !== 'file') return;
    collection.set(uri, e.diagnostics.map((d) => toVs(d, serverName)));
  });
  return vscode.Disposable.from(collection, sub, { dispose: () => adapters.delete(adapter.descriptor.providerRouteId) });
}

/** The errors a language server route currently reports for these documents (before a change is applied). */
export function errorsBefore(providerRouteId: string, uris: readonly string[]): Map<string, readonly LspDiagnostic[]> | undefined {
  const a = adapters.get(providerRouteId);
  if (!a) return undefined;
  return new Map(uris.map((u) => [u, a.diagnosticsFor(u).filter((d) => d.severity === 1)]));
}

/**
 * After an applied change: waits until the server has published diagnostics again for every changed document (or
 * `timeoutMs`), then returns the errors that were not there before. `undefined`: the server did not answer in time.
 */
export async function errorsAfter(providerRouteId: string, before: Map<string, readonly LspDiagnostic[]>, timeoutMs = 10000): Promise<{ uri: string; diagnostic: LspDiagnostic }[] | undefined> {
  const a = adapters.get(providerRouteId);
  if (!a) return undefined;
  const pending = new Set(before.keys());
  const done = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const sub = a.onDidPublishDiagnostics((e) => {
      if (e.kind === 'publish') pending.delete(e.uri);
      if (pending.size === 0) finish(true);
    });
    function finish(ok: boolean) {
      clearTimeout(timer);
      sub.dispose();
      resolve(ok);
    }
  });
  if (!done) return undefined;
  const out: { uri: string; diagnostic: LspDiagnostic }[] = [];
  for (const [uri, old] of before) for (const d of newErrors(old, a.diagnosticsFor(uri))) out.push({ uri, diagnostic: d });
  return out;
}
