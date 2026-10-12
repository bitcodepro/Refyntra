import * as vscode from 'vscode';
import { evaluatableChain, inlineValueEntries, truncateValue } from './inlineValuesModel';

const DEBUG_TYPES = new Set(['refyntra-dotnet']);
const MAX_ENTRIES = 60;

function enabled(): boolean {
  return vscode.workspace.getConfiguration('refyntra.debug').get<boolean>('inlineValues', true);
}

function refyntraSession(): vscode.DebugSession | undefined {
  const s = vscode.debug.activeDebugSession;
  return s && DEBUG_TYPES.has(s.type) ? s : undefined;
}

/**
 * Rider-like inline values for C#: while stopped, names declared, assigned or used on the lines of the stopped method
 * (up to the stopped line, visible range only) show `name = value` after the line. Values are evaluated with the DAP
 * `evaluate` request in the `watch` context on the stopped frame — only names and `this.member`, never a call —
 * and shortened. VS Code shows them when `debug.inlineValues` is `on` or `auto` (auto uses providers like this one).
 */
export class CSharpInlineValuesProvider implements vscode.InlineValuesProvider {
  async provideInlineValues(document: vscode.TextDocument, viewPort: vscode.Range, context: vscode.InlineValueContext, token: vscode.CancellationToken): Promise<vscode.InlineValue[]> {
    if (!enabled()) return [];
    const stopped = context.stoppedLocation.start.line;
    const lines = document.getText().split(/\r?\n/);
    const entries = inlineValueEntries(lines, stopped, viewPort.start.line, Math.min(viewPort.end.line, stopped)).slice(-MAX_ENTRIES);
    const session = refyntraSession();
    const out: vscode.InlineValue[] = [];
    for (const e of entries) {
      if (token.isCancellationRequested) return [];
      const range = new vscode.Range(e.line, e.start, e.line, e.end);
      if (!session) {
        out.push(e.kind === 'lookup' ? new vscode.InlineValueVariableLookup(range, e.name, false) : new vscode.InlineValueEvaluatableExpression(range, e.expression));
        continue;
      }
      try {
        const r = (await session.customRequest('evaluate', { expression: e.expression ?? e.name, frameId: context.frameId, context: 'watch' })) as { result?: string };
        if (typeof r?.result === 'string') out.push(new vscode.InlineValueText(range, `${e.name} = ${truncateValue(r.result)}`));
      } catch {
        // Not in scope yet (declared later in a branch) or not evaluatable: show nothing for it.
      }
    }
    return out;
  }
}

/** Hover over `a.B.C` evaluates the whole member chain up to the hovered segment; calls are never evaluated. */
export class CSharpEvaluatableExpressionProvider implements vscode.EvaluatableExpressionProvider {
  provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.EvaluatableExpression | undefined {
    const chain = evaluatableChain(document.lineAt(position.line).text, position.character);
    if (!chain) return undefined;
    return new vscode.EvaluatableExpression(new vscode.Range(position.line, chain.start, position.line, chain.end), chain.expression);
  }
}

export function registerInlineValues(): { values: CSharpInlineValuesProvider; hover: CSharpEvaluatableExpressionProvider; disposable: vscode.Disposable } {
  const selector: vscode.DocumentSelector = { language: 'csharp', scheme: 'file' };
  const values = new CSharpInlineValuesProvider();
  const hover = new CSharpEvaluatableExpressionProvider();
  return {
    values,
    hover,
    disposable: vscode.Disposable.from(vscode.languages.registerInlineValuesProvider(selector, values), vscode.languages.registerEvaluatableExpressionProvider(selector, hover)),
  };
}
