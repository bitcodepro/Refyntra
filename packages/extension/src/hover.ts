import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { relationLocation } from '@refyntra/domain';
import { shortPath } from './convert';
import { mayBeMediatRRequest, mediatrHoverMarkdown } from './hoverModel';

/**
 * Hover on a MediatR request (C#): "handled by X" with a link that opens the handler. A text check keeps ordinary hovers
 * away from the backend; the Related request is cancelled with the hover. Links run only Refyntra's open command.
 */
export class MediatRHoverProvider implements vscode.HoverProvider {
  constructor(private readonly engine: EngineClient) {}

  async provideHover(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('refyntra').get<boolean>('hover.mediatr', true)) return undefined;
    const range = doc.getWordRangeAtPosition(position, /@?[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) return undefined;
    const word = doc.getText(range).replace(/^@/, '');
    if (!mayBeMediatRRequest(word, doc.lineAt(position.line).text)) return undefined;
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const o = await this.engine.related({ uri: doc.uri.toString(), position: { line: position.line, character: position.character } }, source.token);
      if (o.kind !== 'related' || token.isCancellationRequested) return undefined;
      const handlers = o.groups
        .flatMap((g) => g.relations)
        .filter((r) => r.relationKind === 'mediatr.handler' || r.relationKind === 'mediatr.notificationHandler' || r.relationKind === 'handler.handler')
        .map((r) => {
          const location = relationLocation(r);
          return { label: r.target.label, notification: r.relationKind === 'mediatr.notificationHandler', ...(location ? { location } : {}) };
        });
      const text = mediatrHoverMarkdown(o.subject?.name ?? word, handlers, shortPath);
      if (!text) return undefined;
      const md = new vscode.MarkdownString(text);
      md.isTrusted = { enabledCommands: ['refyntra.openLocation'] };
      return new vscode.Hover(md, range);
    } catch {
      return undefined;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }
}

export function registerMediatRHover(engine: EngineClient): vscode.Disposable {
  return vscode.languages.registerHoverProvider({ scheme: 'file', language: 'csharp' }, new MediatRHoverProvider(engine));
}
