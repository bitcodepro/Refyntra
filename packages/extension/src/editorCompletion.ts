import * as vscode from 'vscode';
import { CancelledError, type EngineClient } from '@refyntra/application';
import type { CompletionItemInfo, CompletionKind } from '@refyntra/contracts';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';

const KINDS: Readonly<Record<CompletionKind, vscode.CompletionItemKind>> = {
  method: vscode.CompletionItemKind.Method,
  property: vscode.CompletionItemKind.Property,
  field: vscode.CompletionItemKind.Field,
  constant: vscode.CompletionItemKind.Constant,
  variable: vscode.CompletionItemKind.Variable,
  class: vscode.CompletionItemKind.Class,
  interface: vscode.CompletionItemKind.Interface,
  struct: vscode.CompletionItemKind.Struct,
  enum: vscode.CompletionItemKind.Enum,
  enumMember: vscode.CompletionItemKind.EnumMember,
  event: vscode.CompletionItemKind.Event,
  module: vscode.CompletionItemKind.Module,
  keyword: vscode.CompletionItemKind.Keyword,
  typeParameter: vscode.CompletionItemKind.TypeParameter,
  snippet: vscode.CompletionItemKind.Snippet,
  operator: vscode.CompletionItemKind.Operator,
  text: vscode.CompletionItemKind.Text,
};

class RefyntraCompletionItem extends vscode.CompletionItem {
  constructor(
    info: CompletionItemInfo,
    readonly uri: string,
    readonly listId: string,
    readonly index: number,
  ) {
    super(info.labelDetail ? { label: info.label, description: info.labelDetail } : info.label, KINDS[info.kind] ?? vscode.CompletionItemKind.Text);
  }
}

function active(): boolean {
  return vscode.workspace.getConfiguration('refyntra').get<boolean>('editor.completion', true) && !vscode.extensions.getExtension(CSHARP_EXTENSION);
}

/**
 * C# completion in the editor from the host (Roslyn's CompletionService, as in Visual Studio): members after a dot,
 * locals, types, keywords, types of namespaces not imported yet (the using is added on accept). Resolving an item
 * adds its signature and documentation. Off while the C# extension is installed (it completes C# itself).
 */
export class CSharpCompletionProvider implements vscode.CompletionItemProvider<RefyntraCompletionItem> {
  constructor(private readonly engine: EngineClient) {}

  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionList<RefyntraCompletionItem> | undefined> {
    if (!active() || !this.engine.completion) return undefined;
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const trigger = context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
      const r = await this.engine.completion(document.uri.toString(), { line: position.line, character: position.character }, trigger, source.token);
      if (!r || !r.listId || token.isCancellationRequested) return undefined;
      const range = r.range ? new vscode.Range(r.range.start.line, r.range.start.character, r.range.end.line, r.range.end.character) : undefined;
      // Roslyn's own snippets are left out: Refyntra's live templates and postfix templates cover them.
      const items = r.items.filter((i) => i.kind !== 'snippet').map((i) => {
        const item = new RefyntraCompletionItem(i, document.uri.toString(), r.listId, i.index);
        item.insertText = i.insertText;
        item.sortText = i.sortText;
        item.filterText = i.filterText;
        if (i.preselect) item.preselect = true;
        if (range) item.range = range;
        return item;
      });
      return new vscode.CompletionList(items, false);
    } catch (e) {
      if (e instanceof CancelledError) return undefined;
      return undefined;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }

  async resolveCompletionItem(item: RefyntraCompletionItem, token: vscode.CancellationToken): Promise<RefyntraCompletionItem> {
    if (!this.engine.completionResolve) return item;
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const d = await this.engine.completionResolve(item.uri, item.listId, item.index, source.token);
      if (!d) return item;
      if (d.detail) item.detail = d.detail;
      if (d.documentation) item.documentation = new vscode.MarkdownString().appendText(d.documentation);
      if (d.additionalTextEdits.length)
        item.additionalTextEdits = d.additionalTextEdits.map((e) => vscode.TextEdit.replace(new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText));
      return item;
    } catch {
      return item;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }
}

export function registerEditorCompletion(engine: EngineClient): vscode.Disposable {
  const selector: vscode.DocumentSelector = [{ language: 'csharp', scheme: 'file' }, { language: 'aspnetcorerazor', scheme: 'file' }, { language: 'razor', scheme: 'file' }];
  return vscode.languages.registerCompletionItemProvider(selector, new CSharpCompletionProvider(engine), '.', '<', ' ');
}
