import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { POSTFIX_SETTING, type PostfixTemplateData, postfixCacheKey, postfixCompletions, postfixDot } from './postfixModel';

const CACHE_SIZE = 16;

/**
 * Rider-style postfix templates for C#: after `expr.` the C# host lists the templates that fit the expression's type
 * (`.foreach` for collections, `.if` for bool, `.ifn` / `.notnull` for nullable values, `.await` for awaitables…)
 * with snippets formatted per the document's options. Answers are cached per document version and dot position;
 * the request is cancelled with the completion request. Items sort after the regular members.
 */
export class PostfixCompletionProvider implements vscode.CompletionItemProvider {
  private readonly cache = new Map<string, { templates: PostfixTemplateData[]; range: { start: { line: number; character: number }; end: { line: number; character: number } } | null }>();

  constructor(private readonly engine: EngineClient) {}

  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | undefined> {
    if (document.languageId !== 'csharp' || document.uri.scheme !== 'file' || !this.engine.postfix) return undefined;
    if (!vscode.workspace.getConfiguration('refyntra', document.uri).get<boolean>(POSTFIX_SETTING, true)) return undefined;
    if (!this.engine.handlesDocument(document.uri.toString(), document.languageId)) return undefined;
    const lineText = document.lineAt(position.line).text;
    const dot = postfixDot(lineText, position.character);
    if (dot === undefined) return undefined;
    const key = postfixCacheKey(document.uri.toString(), document.version, position.line, dot);
    let entry = this.cache.get(key);
    if (!entry) {
      const source = new vscode.CancellationTokenSource();
      const sub = token.onCancellationRequested(() => source.cancel());
      try {
        // The host drops the dot and the part of the name typed after it; the answer depends only on the expression.
        const r = await this.engine.postfix({ uri: document.uri.toString(), position: { line: position.line, character: position.character } }, source.token);
        if (r.kind !== 'templates') return undefined;
        entry = { templates: r.items, range: r.expressionRange };
        this.cache.set(key, entry);
        if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      } catch {
        return undefined;
      } finally {
        sub.dispose();
        source.dispose();
      }
    }
    if (token.isCancellationRequested) return undefined;
    return postfixCompletions(entry.templates, entry.range, lineText, { line: position.line, character: position.character }).map((c) => {
      const item = new vscode.CompletionItem({ label: c.label, description: 'postfix' }, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(c.snippet);
      item.range = new vscode.Range(c.range.start.line, c.range.start.character, c.range.end.line, c.range.end.character);
      item.filterText = c.filterText;
      item.sortText = c.sortText;
      item.detail = c.detail.split('\n')[0];
      item.documentation = new vscode.MarkdownString().appendCodeblock(c.detail, 'csharp');
      return item;
    });
  }
}

export function registerPostfix(engine: EngineClient): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider({ language: 'csharp', scheme: 'file' }, new PostfixCompletionProvider(engine), '.');
}
