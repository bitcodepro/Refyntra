import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { isRunnable } from '@refyntra/domain';
import { CLEANUP_SPEC, KIND, type Offer, kindMatches, looksExtractable, planOffers } from './codeActionsModel';
import { toPosition } from './convert';
import { unavailableDescription } from './terminology';

/** Languages whose routes can offer actions (C# owned; TS/JS, Python, Rust: rename through their routes). */
export const CODE_ACTION_SELECTOR: vscode.DocumentSelector = ['csharp', 'typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'rust'].map((language) => ({ scheme: 'file', language }));

const CACHE_MS = 4000;

/**
 * Refyntra's refactorings in the lightbulb, Ctrl+. and the Refactor… / Source Action… menus. Every action runs the
 * normal Refyntra command (prepare → preview → revalidate → single EditApplier); nothing is applied from here.
 *
 * Cheap by design: the automatic lightbulb request (every cursor move) never reaches the backend — it offers only
 * Extract Method for a selection that passes a text check. Only an explicit request (Ctrl+., the Refactor menu) asks the
 * route which actions apply at the position (capability/query), cached briefly per document version and position.
 */
export class RefyntraCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorExtract.append('method'),
    vscode.CodeActionKind.RefactorRewrite.append('signature'),
    vscode.CodeActionKind.RefactorMove.append('typeToFile'),
    vscode.CodeActionKind.RefactorRewrite.append('safeDelete'),
    vscode.CodeActionKind.RefactorRewrite.append('rename'),
    vscode.CodeActionKind.RefactorRewrite.append('generateHandler'),
    vscode.CodeActionKind.Source.append('refyntra').append('cleanup'),
  ];

  private cache: { key: string; at: number; runnable: string[]; unavailable: { capabilityId: string; reason: string }[] } | undefined;

  constructor(private readonly engine: EngineClient) {}

  async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
    if (document.uri.scheme !== 'file' || !this.engine.handlesDocument(document.uri.toString(), document.languageId)) return [];
    const csharp = document.languageId === 'csharp';
    const only = context.only?.value;
    const explicit = context.triggerKind === vscode.CodeActionTriggerKind.Invoke;
    const empty = range.isEmpty;
    const extractable = csharp && !empty && looksExtractable(document.getText(range));
    const out: vscode.CodeAction[] = [];

    if (!explicit) {
      // Lightbulb: no backend request. Extract Method only, and only for a selection that looks extractable.
      if (extractable && kindMatches(only, KIND.extractMethod)) out.push(this.toAction({ spec: planOffers({ runnable: ['csharp.extractMethod'], unavailable: [], extractable, emptySelection: false })[0]!.spec }, document, range));
      return out;
    }

    let runnable: string[] = [];
    let unavailable: { capabilityId: string; reason: string }[] = [];
    const key = `${document.uri.toString()}#${document.version}#${range.start.line}:${range.start.character}`;
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < CACHE_MS) {
      ({ runnable, unavailable } = this.cache);
    } else {
      const source = new vscode.CancellationTokenSource();
      const sub = token.onCancellationRequested(() => source.cancel());
      try {
        const r = await this.engine.actions({ uri: document.uri.toString(), position: toPosition(range.start) }, source.token);
        runnable = r.items.filter(isRunnable).map((a) => a.capabilityId);
        unavailable = r.items.filter((a) => !isRunnable(a)).map((a) => ({ capabilityId: a.capabilityId, reason: unavailableDescription(a) }));
        this.cache = { key, at: Date.now(), runnable, unavailable };
      } catch {
        return [];
      } finally {
        sub.dispose();
        source.dispose();
      }
    }
    if (token.isCancellationRequested) return [];
    for (const offer of planOffers({ runnable, unavailable, extractable, emptySelection: empty, ...(only ? { only } : {}) })) out.push(this.toAction(offer, document, range));
    if (csharp && only && kindMatches(only, CLEANUP_SPEC.kind) && only.startsWith('source')) {
      const a = new vscode.CodeAction(CLEANUP_SPEC.title, vscode.CodeActionKind.Source.append('refyntra').append('cleanup'));
      a.command = { command: CLEANUP_SPEC.command, title: CLEANUP_SPEC.title, arguments: [document.uri] };
      out.push(a);
    }
    return out;
  }

  private toAction(offer: Offer, document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction {
    const kind = vscode.CodeActionKind.Empty.append(offer.spec.kind);
    const a = new vscode.CodeAction(offer.spec.title, kind);
    if (offer.disabled) {
      a.disabled = { reason: offer.disabled };
      return a;
    }
    const target = { uri: document.uri.toString(), position: toPosition(range.start), ...(offer.spec.key === 'extractMethod' ? { range: { start: toPosition(range.start), end: toPosition(range.end) } } : {}) };
    a.command = { command: offer.spec.command, title: offer.spec.title, arguments: [target] };
    return a;
  }
}

export function registerCodeActions(engine: EngineClient): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(CODE_ACTION_SELECTOR, new RefyntraCodeActionProvider(engine), {
    providedCodeActionKinds: RefyntraCodeActionProvider.providedCodeActionKinds,
    documentation: [{ kind: vscode.CodeActionKind.Refactor, command: { command: 'refyntra.showMenu', title: 'About Refyntra refactorings' } }],
  });
}
