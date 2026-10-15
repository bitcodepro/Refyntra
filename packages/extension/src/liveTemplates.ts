import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type LiveTemplate, offerAt, parseTemplates, previewBody } from './liveTemplatesModel';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';

/**
 * C# live templates in completion (prop, ctor, foreach, try, test methods…), from snippets/csharp.json. Off with
 * refyntra.liveTemplates.enabled, and not offered while the C# extension is installed (it has its own snippets).
 */
export function registerLiveTemplates(context: vscode.ExtensionContext): vscode.Disposable {
  let templates: LiveTemplate[] = [];
  try {
    templates = parseTemplates(fs.readFileSync(path.join(context.extensionPath, 'snippets', 'csharp.json'), 'utf8'));
  } catch {
    templates = [];
  }
  return vscode.languages.registerCompletionItemProvider({ language: 'csharp' }, {
    provideCompletionItems(document, position) {
      if (!vscode.workspace.getConfiguration('refyntra').get<boolean>('liveTemplates.enabled', true)) return [];
      if (vscode.extensions.getExtension(CSHARP_EXTENSION)) return [];
      const at = offerAt(document.lineAt(position.line).text.slice(0, position.character));
      if (!at) return [];
      const range = new vscode.Range(position.translate(0, -at.word.length), position);
      return templates
        .filter((t) => t.prefix.toLowerCase().startsWith(at.word.toLowerCase()))
        .map((t) => {
          const item = new vscode.CompletionItem({ label: t.prefix, description: t.description.replace(/ \(Refyntra\)$/, '') }, vscode.CompletionItemKind.Snippet);
          item.insertText = new vscode.SnippetString(t.body);
          item.range = range;
          item.detail = `${t.name} (Refyntra live template)`;
          item.documentation = new vscode.MarkdownString().appendCodeblock(previewBody(t.body), 'csharp');
          item.sortText = `~${t.prefix}`;
          return item;
        });
    },
  });
}
