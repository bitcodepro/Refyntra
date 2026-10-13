import * as vscode from 'vscode';
import type { AnalysisView, EngineClient } from '@refyntra/application';
import type { RuleAbstention, RuleDiagnostic } from '@refyntra/contracts';
import { fromLocation, fromRange, shortPath, toPosition } from './convert';
import { type QuickFixOffer, compilerQuickFixes, explain, groupByUri, quickFixesOf, ruleLevel, severityOf } from './diagnosticsModel';
import { EDIT_ACTION_COMMAND, FIX_ALL_COMMAND, type EditActionTarget } from './editActionsModel';

/** Debounce after an edit before the rules run again (the host recomputes only components whose dependencies changed). */
export const RULES_DEBOUNCE_MS = 700;
export const EXPLAIN_COMMAND = 'refyntra.rules.explain';
export const EXPLAIN_SCHEME = 'refyntra-rules';

/**
 * Publishes the results of `analysis/run` (OR1001 for the workspace, the inspections OR1002–OR1010 for the open C#
 * files) in Refyntra's own DiagnosticCollection "refyntra". It never reads, hides or rewrites other collections.
 * Abstentions are never Problems entries: they are reachable through a code action "Explain" on the registration
 * line, which opens a read-only explanation. Inspection results carry quick fixes (edit actions computed by the host,
 * compile-checked, one undo step) and "… in document, project or solution" (Fix in scope, previewed); the compiler's
 * CS4014 gets "Add 'await'" and "Discard" the same way.
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
  // The editor hands code action providers copies of the published diagnostics, so the fixes are found by content.
  const fixesOf = new Map<string, QuickFixOffer[]>();
  const fixKey = (uri: string, d: { range: vscode.Range; message: string; code?: vscode.Diagnostic['code'] }) =>
    `${uri}#${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}#${typeof d.code === 'object' ? d.code.value : d.code}#${d.message}`;

  const level = (ruleId: string) => ruleLevel(ruleId, vscode.workspace.getConfiguration('refyntra').get(`rules.${ruleId}`));

  const publish = () => {
    collection.clear();
    fixesOf.clear();
    for (const [uri, list] of groupByUri(diagnostics, level)) {
      const items = list.map((d) => {
        const severity = severityOf(level(d.id));
        const diagnostic = new vscode.Diagnostic(fromRange(d.location.range), d.message,
          severity === 'hint' ? vscode.DiagnosticSeverity.Hint
            : severity === 'information' ? vscode.DiagnosticSeverity.Information
              : severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Refyntra';
        diagnostic.code = d.helpUri ? { value: d.id, target: vscode.Uri.parse(d.helpUri) } : d.id;
        diagnostic.relatedInformation = d.relatedLocations.map((r) => new vscode.DiagnosticRelatedInformation(fromLocation(r.location), r.message));
        const fixes = quickFixesOf(d.fixes);
        if (fixes.length) fixesOf.set(fixKey(vscode.Uri.parse(uri, true).toString(), diagnostic), fixes);
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
      // OR1001 for the workspace; the per-document inspections for the C# files open in the editor.
      const documents = vscode.workspace.textDocuments.filter((doc) => doc.languageId === 'csharp' && relevant(doc)).map((doc) => doc.uri.toString());
      const outcomes = await engine.analyze({ documents }, cts.token);
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

  /** Quick fixes (and their Fix in scope variants) of the Refyntra and CS4014 diagnostics the editor asks about. */
  const quickFixes = (document: vscode.TextDocument, context: vscode.CodeActionContext): vscode.CodeAction[] => {
    if (context.only && !vscode.CodeActionKind.QuickFix.contains(context.only) && !context.only.contains(vscode.CodeActionKind.QuickFix)) return [];
    if (!engine.editActions || !engine.handlesDocument(document.uri.toString(), document.languageId)) return [];
    const single: vscode.CodeAction[] = [];
    const scoped: vscode.CodeAction[] = [];
    const seen = new Set<string>();
    for (const d of context.diagnostics) {
      const offers = d.source === 'Refyntra' ? (fixesOf.get(fixKey(document.uri.toString(), d)) ?? []) : compilerQuickFixes(d.code);
      for (const f of offers) {
        const at = `${f.actionId}@${d.range.start.line}:${d.range.start.character}`;
        if (seen.has(at)) continue;
        seen.add(at);
        const action = new vscode.CodeAction(`${f.title} (Refyntra)`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        action.isPreferred = single.length === 0 && d.source === 'Refyntra';
        const start = toPosition(d.range.start);
        const arg: EditActionTarget = { uri: document.uri.toString(), range: { start, end: start }, actionId: f.actionId, version: document.version };
        action.command = { command: EDIT_ACTION_COMMAND, title: action.title, arguments: [arg] };
        single.push(action);
        if (seen.has(`scope:${f.actionId}`)) continue;
        seen.add(`scope:${f.actionId}`);
        const all = new vscode.CodeAction(`${f.title} in document, project or solution… (Refyntra)`, vscode.CodeActionKind.QuickFix);
        all.diagnostics = [d];
        all.command = { command: FIX_ALL_COMMAND, title: all.title, arguments: [{ uri: document.uri.toString(), actionId: f.actionId, title: f.title }] };
        scoped.push(all);
      }
    }
    return [...single, ...scoped];
  };

  const codeActions: vscode.CodeActionProvider = {
    provideCodeActions(document, range, context) {
      const fixes = quickFixes(document, context);
      const uri = document.uri.toString();
      const line = range.start.line;
      const onLine = (l: { uri: string; range: { start: { line: number }; end: { line: number } } } | undefined) => !!l && l.uri === uri && l.range.start.line <= line && line <= l.range.end.line;
      const hasWarning = diagnostics.some((d) => d.id === 'OR1001' && onLine(d.location));
      const hasAbstention = abstentions.some((a) => onLine(a.location));
      if (!hasWarning && !hasAbstention) return fixes;
      if (context.only && !context.only.contains(vscode.CodeActionKind.Empty) && !vscode.CodeActionKind.Empty.contains(context.only)) return fixes;
      const action = new vscode.CodeAction(hasWarning ? 'Refyntra: explain OR1001 (proof path)' : 'Refyntra: why OR1001 did not check this registration', vscode.CodeActionKind.Empty);
      action.command = { command: EXPLAIN_COMMAND, title: action.title, arguments: [uri, line] };
      return [...fixes, action];
    },
  };

  schedule(0);
  return vscode.Disposable.from(
    collection,
    changed,
    { dispose: () => { if (timer) clearTimeout(timer); running?.cancel(); } },
    vscode.workspace.registerTextDocumentContentProvider(EXPLAIN_SCHEME, { onDidChange: changed.event, provideTextDocumentContent: (u) => explanations.get(u.query) ?? '' }),
    vscode.commands.registerCommand(EXPLAIN_COMMAND, explainCommand),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file', language: 'csharp' }, codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty] }),
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
    // A newly opened C# file gets its inspections; a closed one drops them on the next run.
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'csharp' && relevant(doc)) schedule(150);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === 'csharp' && relevant(doc)) schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refyntra.rules')) publish();
    }),
  );
}
