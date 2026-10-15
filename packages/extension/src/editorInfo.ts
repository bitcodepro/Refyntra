import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';

function active(setting: string): boolean {
  return vscode.workspace.getConfiguration('refyntra').get<boolean>(setting, true) && !vscode.extensions.getExtension(CSHARP_EXTENSION);
}

async function withToken<T>(token: vscode.CancellationToken, run: (t: vscode.CancellationToken) => Promise<T>): Promise<T | undefined> {
  const source = new vscode.CancellationTokenSource();
  const sub = token.onCancellationRequested(() => source.cancel());
  try {
    return await run(source.token);
  } catch {
    return undefined;
  } finally {
    sub.dispose();
    source.dispose();
  }
}

/** C# hover from Roslyn's QuickInfoService (signature, XML documentation, type); off while the C# extension is installed. */
export class CSharpHoverProvider implements vscode.HoverProvider {
  constructor(private readonly engine: EngineClient) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (!active('editor.hover') || !this.engine.hover || document.uri.scheme !== 'file') return undefined;
    const h = await withToken(token, (t) => this.engine.hover!({ uri: document.uri.toString(), position: { line: position.line, character: position.character } }, t));
    if (!h || (!h.signature && h.sections.length === 0)) return undefined;
    const md = new vscode.MarkdownString();
    if (h.signature) md.appendCodeblock(h.signature, 'csharp');
    for (const s of h.sections) {
      md.appendMarkdown('\n\n');
      md.appendText(s);
    }
    const range = h.range ? new vscode.Range(h.range.start.line, h.range.start.character, h.range.end.line, h.range.end.character) : undefined;
    return new vscode.Hover(md, range);
  }
}

/** C# signature help: the overloads of the call and the argument being typed; off while the C# extension is installed. */
export class CSharpSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly engine: EngineClient) {}

  async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
    if (!active('editor.signatureHelp') || !this.engine.signatureHelp || document.uri.scheme !== 'file') return undefined;
    const r = await withToken(token, (t) => this.engine.signatureHelp!({ uri: document.uri.toString(), position: { line: position.line, character: position.character } }, t));
    if (!r || r.signatures.length === 0) return undefined;
    const help = new vscode.SignatureHelp();
    help.signatures = r.signatures.map((s) => {
      const info = new vscode.SignatureInformation(s.label, s.documentation ?? undefined);
      info.parameters = s.parameters.map((p) => new vscode.ParameterInformation(p.label, p.documentation ?? undefined));
      return info;
    });
    help.activeSignature = r.activeSignature;
    help.activeParameter = r.activeParameter;
    return help;
  }
}

export function registerEditorInfo(engine: EngineClient): vscode.Disposable {
  const selector: vscode.DocumentSelector = [{ language: 'csharp', scheme: 'file' }, { language: 'aspnetcorerazor', scheme: 'file' }, { language: 'razor', scheme: 'file' }];
  return vscode.Disposable.from(
    vscode.languages.registerHoverProvider(selector, new CSharpHoverProvider(engine)),
    vscode.languages.registerSignatureHelpProvider(selector, new CSharpSignatureHelpProvider(engine), { triggerCharacters: ['(', ','], retriggerCharacters: [')'] }),
  );
}
