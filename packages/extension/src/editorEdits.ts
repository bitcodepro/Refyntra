import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import type { TextEditDto } from '@refyntra/contracts';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';

function active(setting: string): boolean {
  return vscode.workspace.getConfiguration('refyntra').get<boolean>(setting, true) && !vscode.extensions.getExtension(CSHARP_EXTENSION);
}

const toEdit = (e: TextEditDto) => vscode.TextEdit.replace(new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);

/**
 * F2 in C#: the same rename plan as Refyntra Rename (Roslyn Renamer, compile-checked, .razor / .cshtml and EF Core
 * migrations included); the editor applies it (Shift+Enter in the rename box shows VS Code's own preview). Refused
 * renames show the host's reason. Off while the C# extension is installed.
 */
export class CSharpRenameProvider implements vscode.RenameProvider {
  constructor(private readonly engine: EngineClient) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    if (!active('editor.rename')) throw new Error('Rename in the editor is provided by the C# extension.');
    const range = document.getWordRangeAtPosition(position, /@?[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) throw new Error('Place the cursor on a name.');
    return range;
  }

  async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | undefined> {
    if (!active('editor.rename')) return undefined;
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const r = await this.engine.prepareRename({ uri: document.uri.toString(), position: { line: position.line, character: position.character } }, newName.trim(), source.token, {});
      if (r.kind !== 'preview') throw new Error(r.message);
      const edit = new vscode.WorkspaceEdit();
      for (const c of r.plan.writeSet) {
        if (c.kind === 'text') for (const e of c.edits) edit.replace(vscode.Uri.parse(c.uri, true), toEdit(e).range, e.newText);
        else if (c.kind === 'rename') edit.renameFile(vscode.Uri.parse(c.oldUri, true), vscode.Uri.parse(c.newUri, true));
      }
      this.engine.discardPlan(r.planId);
      return edit;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }
}

/** Format Document / Format Selection / format on save for C#: Roslyn's formatter with the .editorconfig options. */
export class CSharpFormattingProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
  constructor(private readonly engine: EngineClient) {}

  async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | undefined> {
    if (!active('editor.formatting') || !this.engine.format) return undefined;
    return (await this.engine.format(document.uri.toString()))?.map(toEdit);
  }

  async provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.TextEdit[] | undefined> {
    if (!active('editor.formatting') || !this.engine.format) return undefined;
    return (await this.engine.format(document.uri.toString(), { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } }))?.map(toEdit);
  }
}

export function registerEditorEdits(engine: EngineClient): vscode.Disposable {
  const selector: vscode.DocumentSelector = { language: 'csharp', scheme: 'file' };
  const formatting = new CSharpFormattingProvider(engine);
  return vscode.Disposable.from(
    vscode.languages.registerRenameProvider(selector, new CSharpRenameProvider(engine)),
    vscode.languages.registerDocumentFormattingEditProvider(selector, formatting),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, formatting),
  );
}
