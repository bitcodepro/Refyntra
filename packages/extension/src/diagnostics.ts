import * as vscode from 'vscode';
import type { AnalysisView, EngineClient } from '@refyntra/application';
import type { RuleAbstention, RuleDiagnostic } from '@refyntra/contracts';
import { fromLocation, fromRange, shortPath } from './convert';
import { explain, groupByUri, ruleLevel } from './diagnosticsModel';

/** Debounce after an edit before the rules run again (the host recomputes only components whose dependencies changed). */
export const RULES_DEBOUNCE_MS = 700;
export const EXPLAIN_COMMAND = 'refyntra.rules.explain';
export const EXPLAIN_SCHEME = 'refyntra-rules';

/**
 * Publishes the results of `analysis/run` (OR1001) in Refyntra's own DiagnosticCollection "refyntra". It never reads,
 * hides or rewrites other collections. Abstentions are never Problems entries: they are reachable through a
 * code action "Explain" on the registration line, which opens a read-only explanation.
 */
export function registerRuleDiagnostics(engine: EngineClient): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('refyntra');
  let diagnostics: RuleDiagnostic[] = [];
  let abstentions: RuleAbstention[] = [];
  let completeness = 'unknown';
  let generation = 0; // bumped on every invalidation; results of an older generation are dropped
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: vscode.CancellationTokenSource | undefined;
  const explanations = new Map<string, string>();
  const changed = new vscode.EventEmitter<vscode.Uri>();

  const level = (ruleId: string) => ruleLevel(ruleId, vscode.workspace.getConfiguration('refyntra').get(`rules.${ruleId}`));

  const publish = () => {
    collection.clear();
    for (const [uri, list] of groupByUri(diagnostics, level)) {
      const items = list.map((d) => {
        const diagnostic = new vscode.Diagnostic(fromRange(d.location.range), d.message,
          level(d.id) === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Refyntra';
        diagnostic.code = d.helpUri ? { value: d.id, target: vscode.Uri.parse(d.helpUri) } : d.id;
        diagnostic.relatedInformation = d.relatedLocations.map((r) => new vscode.DiagnosticRelatedInformation(fromLocation(r.location), r.message));
        return diagnostic;
      });
      collection.set(vscode.Uri.parse(uri, true), items);
    }
  };

  const run = async () => {
    const mine = generation;
    running?.cancel();
    const cts = new vscode.CancellationTokenSource();
    running = cts;
    try {
      const outcomes = await engine.analyze({}, cts.token);
      if (mine !== generation || cts.token.isCancellationRequested) return;
      const ok = outcomes.filter((o): o is AnalysisView => o.kind === 'analysis');
      if (ok.length === 0 && outcomes.some((o) => o.kind === 'unavailable' && o.reasonCode === 'Stale')) {
        schedule(); // outdated by newer edits: keep what is shown and try again after the next pause
        return;
      }
      if (ok.length === 0) {
        // No route answered (host down, starting, no C#): results are unknown, nothing is shown.
        diagnostics = [];
        abstentions = [];
        completeness = 'unknown';
      } else {
        diagnostics = ok.flatMap((o) => o.diagnostics);
        abstentions = ok.flatMap((o) => o.abstentions);
        completeness = ok.every((o) => o.completeness === 'complete') ? 'complete' : 'partial';
      }
      publish();
    } catch {
      // Cancelled by a newer run.
    } finally {
      if (running === cts) running = undefined;
      cts.dispose();
    }
  };

  const schedule = (delay = RULES_DEBOUNCE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  const invalidate = () => {
    generation++;
    running?.cancel();
    diagnostics = [];
    abstentions = [];
    collection.clear();
  };

  const relevant = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && engine.handlesDocument(doc.uri.toString(), doc.languageId);

  const explainCommand = async (uri?: string, line?: number) => {
    const text = explain(diagnostics, abstentions, completeness, uri, line, shortPath);
    const key = `${Date.now().toString(36)}-${explanations.size}`;
    explanations.set(key, text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${EXPLAIN_SCHEME}:/Refyntra%20rules.md?${key}`));
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    return text;
  };

  const codeActions: vscode.CodeActionProvider = {
    provideCodeActions(document, range) {
      const uri = document.uri.toString();
      const line = range.start.line;
      const onLine = (l: { uri: string; range: { start: { line: number }; end: { line: number } } } | undefined) => !!l && l.uri === uri && l.range.start.line <= line && line <= l.range.end.line;
      const hasWarning = diagnostics.some((d) => onLine(d.location));
      const hasAbstention = abstentions.some((a) => onLine(a.location));
      if (!hasWarning && !hasAbstention) return [];
      const action = new vscode.CodeAction(hasWarning ? 'Refyntra: explain OR1001 (proof path)' : 'Refyntra: why OR1001 did not check this registration', vscode.CodeActionKind.Empty);
      action.command = { command: EXPLAIN_COMMAND, title: action.title, arguments: [uri, line] };
      return [action];
    },
  };

  schedule(0);
  return vscode.Disposable.from(
    collection,
    changed,
    { dispose: () => { if (timer) clearTimeout(timer); running?.cancel(); } },
    vscode.workspace.registerTextDocumentContentProvider(EXPLAIN_SCHEME, { onDidChange: changed.event, provideTextDocumentContent: (u) => explanations.get(u.query) ?? '' }),
    vscode.commands.registerCommand(EXPLAIN_COMMAND, explainCommand),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file', language: 'csharp' }, codeActions),
    engine.onDidInvalidate(() => {
      invalidate();
      schedule();
    }),
    engine.onDidChangeHealth(() => schedule()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0 && relevant(e.document)) schedule();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (relevant(doc)) schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refyntra.rules')) publish();
    }),
  );
}
