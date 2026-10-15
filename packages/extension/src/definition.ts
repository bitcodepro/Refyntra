import * as vscode from 'vscode';
import { CancelledError, type EngineClient } from '@refyntra/application';
import { fromLocation } from './convert';
import { declarationHasNoBody, definitionTargets } from './definitionModel';
import { metadataService } from './metadata';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';

/** Ctrl+Click / F12 on C# without the C# extension (with it installed, its own Go to Definition is used). */
function active(): boolean {
  return vscode.workspace.getConfiguration('refyntra').get<boolean>('navigation.goToDefinition', true) && !vscode.extensions.getExtension(CSHARP_EXTENSION);
}

/**
 * Go to Definition (Ctrl+Click, F12) and Go to Implementation (Ctrl+F12) for C# from the host's symbol at the position (one
 * cheap request; implementations only when needed): a method
 * or class opens its source; an interface or abstract member (or a click on a declaration) opens its implementations
 * (a peek list when there are several); a library symbol opens its decompiled source.
 */
export class CSharpDefinitionProvider implements vscode.DefinitionProvider, vscode.ImplementationProvider {
  constructor(private readonly engine: EngineClient) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location[] | undefined> {
    return this.resolve(document, position, token, false);
  }

  provideImplementation(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location[] | undefined> {
    return this.resolve(document, position, token, true);
  }

  private async resolve(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, implementations: boolean): Promise<vscode.Location[] | undefined> {
    if (!active() || document.uri.scheme !== 'file' || !this.engine.definition) return undefined;
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const target = { uri: document.uri.toString(), position: { line: position.line, character: position.character } };
      // One cheap request (the symbol and its declaration); implementations only when they decide where to go.
      const first = await this.engine.definition(target, implementations, source.token);
      if (!first || token.isCancellationRequested) return undefined;
      const subject = first.subject;
      const decl = subject.location;
      if (subject.origin === 'metadata' && !decl && subject.symbolId) {
        // A library symbol: the decompiled (or embedded) source opens in a read-only editor.
        void metadataService()?.open({ symbolId: subject.symbolId }, subject.name);
        return [];
      }
      if (implementations) return (first.implementations.length ? first.implementations : decl ? [decl] : []).map(fromLocation);
      let declarationLine: string | undefined;
      let inInterface = false;
      if (decl) {
        try {
          const d = await vscode.workspace.openTextDocument(vscode.Uri.parse(decl.uri, true));
          declarationLine = d.lineAt(decl.range.start.line).text;
          const before = d.getText(new vscode.Range(0, 0, decl.range.start.line, 0));
          inInterface = /\binterface\s+\w+[^{]*\{[^}]*$/.test(before.slice(-4000));
        } catch {
          // The declaration's file cannot be read: no body check.
        }
      }
      const declarations = decl ? [decl] : [];
      const clickedOnDeclaration = !!decl && decl.uri === document.uri.toString() && decl.range.start.line === position.line && position.character >= decl.range.start.character && position.character <= decl.range.end.character;
      const needImplementations = subject.kind === 'interface' || inInterface || clickedOnDeclaration || (declarationLine !== undefined && declarationHasNoBody(declarationLine));
      const impls = needImplementations ? ((await this.engine.definition(target, true, source.token))?.implementations ?? []) : [];
      return definitionTargets({ subjectKind: subject.kind, declarations, implementations: impls, declarationLine, clickedOnDeclaration, inInterface }).map(fromLocation);
    } catch (e) {
      if (e instanceof CancelledError) return undefined;
      return undefined;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }
}

export function registerDefinition(engine: EngineClient): vscode.Disposable {
  const provider = new CSharpDefinitionProvider(engine);
  const selector: vscode.DocumentSelector = [{ language: 'csharp', scheme: 'file' }, { language: 'aspnetcorerazor', scheme: 'file' }, { language: 'razor', scheme: 'file' }];
  return vscode.Disposable.from(vscode.languages.registerDefinitionProvider(selector, provider), vscode.languages.registerImplementationProvider(selector, provider));
}
