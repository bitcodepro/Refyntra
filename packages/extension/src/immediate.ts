import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { IMMEDIATE_DEBUG_TYPES, type ImmediateEntry, type ImmediateNode, completionPrefix, normaliseInput, parseAssignment, parsePageMessage, renderImmediateHtml, toNode } from './immediateModel';

export const IMMEDIATE_VIEW = 'refyntra.immediateView';

interface Frame { session: vscode.DebugSession; frameId: number | undefined }

/**
 * Visual Studio-like Immediate Window in the panel. Bound to the selected stack frame of the active refyntra-dotnet /
 * refyntra-python session (vscode.debug.activeStackItem). Input is evaluated with DAP `evaluate` in the `repl`
 * context — assignments and method calls are allowed here because the user typed them.
 */
export class ImmediateViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private nodes = new Map<number, ImmediateNode>();
  private nextId = 1;
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    this.subs.push(
      vscode.debug.onDidChangeActiveStackItem(() => this.postStatus()),
      vscode.debug.onDidChangeActiveDebugSession(() => this.postStatus()),
      vscode.debug.onDidTerminateDebugSession(() => this.postStatus()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderImmediateHtml({ nonce: randomBytes(16).toString('base64'), cspSource: view.webview.cspSource });
    this.subs.push(view.webview.onDidReceiveMessage((m) => void this.onMessage(m)), view.onDidDispose(() => (this.view = undefined)));
  }

  /** The selected frame (Call Stack selection), else the first stopped thread's top frame is left to the adapter. */
  frame(): Frame | undefined {
    const item = vscode.debug.activeStackItem;
    const session = item?.session ?? vscode.debug.activeDebugSession;
    if (!session || !(IMMEDIATE_DEBUG_TYPES as readonly string[]).includes(session.type)) return undefined;
    return { session, frameId: item instanceof vscode.DebugStackFrame ? item.frameId : undefined };
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${IMMEDIATE_VIEW}.focus`);
    void this.view?.webview.postMessage({ type: 'focus' });
  }

  /** Evaluates and records an entry (also used by tests through the command `refyntra.immediate.evaluate`). */
  async evaluate(text: string): Promise<ImmediateEntry> {
    const f = this.frame();
    const input = normaliseInput(text);
    const entry: ImmediateEntry = { id: this.nextId++, input: text.trim() };
    if (!f) entry.error = 'No Refyntra debug session is stopped.';
    else {
      try {
        const r = (await f.session.customRequest('evaluate', { expression: input, context: 'repl', ...(f.frameId !== undefined ? { frameId: f.frameId } : {}) })) as { result?: string; type?: string; variablesReference?: number };
        entry.result = this.remember(toNode(this.nextId++, input, r, input));
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
        // netcoredbg does not evaluate assignments: send `x = 5` as DAP setExpression, then setVariable on the frame's scopes.
        const assignment = parseAssignment(input);
        if (assignment) {
          const set = await this.assign(f, assignment.target, assignment.value);
          if (set) {
            delete entry.error;
            entry.result = this.remember(toNode(this.nextId++, assignment.target, set, assignment.target));
          }
        }
      }
    }
    void this.view?.webview.postMessage({ type: 'entry', entry });
    return entry;
  }

  private async assign(f: Frame, target: string, value: string): Promise<{ value: string; type?: string; variablesReference?: number } | undefined> {
    const frame = f.frameId !== undefined ? { frameId: f.frameId } : {};
    try {
      return (await f.session.customRequest('setExpression', { expression: target, value, ...frame })) as { value: string; type?: string; variablesReference?: number };
    } catch {
      // not supported: try setVariable for a plain local or parameter
    }
    if (f.frameId === undefined || target.includes('.')) return undefined;
    try {
      const scopes = (await f.session.customRequest('scopes', { frameId: f.frameId })) as { scopes: { variablesReference: number; expensive?: boolean }[] };
      for (const sc of scopes.scopes.filter((s) => !s.expensive)) {
        const vars = (await f.session.customRequest('variables', { variablesReference: sc.variablesReference })) as { variables: { name: string }[] };
        if (vars.variables.some((v) => v.name === target)) return (await f.session.customRequest('setVariable', { variablesReference: sc.variablesReference, name: target, value })) as { value: string; type?: string; variablesReference?: number };
      }
    } catch {
      // fall through: the original evaluate error is shown
    }
    return undefined;
  }

  /** Children of a node (DAP variables). */
  async expand(nodeId: number): Promise<ImmediateNode[]> {
    const node = this.nodes.get(nodeId);
    const f = this.frame();
    if (!node || !f || node.ref <= 0) return [];
    const r = (await f.session.customRequest('variables', { variablesReference: node.ref })) as { variables?: { name: string; value: string; type?: string; variablesReference?: number; evaluateName?: string }[] };
    const children = (r.variables ?? []).map((v) => this.remember(toNode(this.nextId++, v.name, v, v.evaluateName ?? (node.evaluateName && /^[A-Za-z_]\w*$/.test(v.name) ? `${node.evaluateName}.${v.name}` : undefined))));
    void this.view?.webview.postMessage({ type: 'children', nodeId, children });
    return children;
  }

  clear(): void {
    this.nodes.clear();
    void this.view?.webview.postMessage({ type: 'clear' });
  }

  private remember(n: ImmediateNode): ImmediateNode {
    this.nodes.set(n.id, n);
    return n;
  }

  private postStatus(): void {
    const f = this.frame();
    const text = f ? `Evaluating in ${f.session.name}${vscode.debug.activeStackItem instanceof vscode.DebugStackFrame ? ' (selected frame)' : ''}.` : 'Start debugging and stop at a breakpoint to evaluate expressions.';
    void this.view?.webview.postMessage({ type: 'status', text, active: Boolean(f) });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const m = parsePageMessage(raw);
    if (!m) return;
    switch (m.type) {
      case 'ready':
        this.postStatus();
        return;
      case 'evaluate':
        await this.evaluate(m.text);
        return;
      case 'expand':
        await this.expand(m.nodeId).catch(() => undefined);
        return;
      case 'clear':
        this.clear();
        return;
      case 'copy': {
        const n = this.nodes.get(m.nodeId);
        if (n) await vscode.env.clipboard.writeText(n.value);
        return;
      }
      case 'watch': {
        const n = this.nodes.get(m.nodeId);
        if (n?.evaluateName) await addWatch(n.evaluateName);
        return;
      }
      case 'complete': {
        const items = await this.completions(m.text, m.caret).catch(() => []);
        void this.view?.webview.postMessage({ type: 'completions', items });
        return;
      }
    }
  }

  /** DAP completions (when the adapter supports them). */
  async completions(text: string, caret: number): Promise<string[]> {
    const f = this.frame();
    if (!f) return [];
    const { prefix } = completionPrefix(text, caret);
    const r = (await f.session.customRequest('completions', { text, column: caret + 1, ...(f.frameId !== undefined ? { frameId: f.frameId } : {}) })) as { targets?: { label: string; text?: string }[] };
    return (r.targets ?? []).map((t) => t.text ?? t.label).filter((t) => t.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 50);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}

/**
 * Adds an expression to the Watch view through VS Code's Variables-view command (it reads `variable.evaluateName`).
 * There is no public API for it; when the command is missing, the expression is copied and the user is told.
 */
async function addWatch(expression: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('debug.addToWatchExpressions', { variable: { evaluateName: expression, name: expression } });
  } catch {
    await vscode.env.clipboard.writeText(expression);
    void vscode.window.showInformationMessage(`Copied "${expression}": paste it into the Watch view.`);
  }
}

export function registerImmediate(): { provider: ImmediateViewProvider; disposable: vscode.Disposable } {
  const provider = new ImmediateViewProvider();
  return {
    provider,
    disposable: vscode.Disposable.from(
      provider,
      vscode.window.registerWebviewViewProvider(IMMEDIATE_VIEW, provider, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('refyntra.showImmediate', () => provider.show()),
      vscode.commands.registerCommand('refyntra.immediate.clear', () => provider.clear()),
      vscode.commands.registerCommand('refyntra.immediate.evaluate', (text: unknown) => (typeof text === 'string' ? provider.evaluate(text) : undefined)),
      vscode.commands.registerCommand('refyntra.immediate.expand', (nodeId: unknown) => (typeof nodeId === 'number' ? provider.expand(nodeId) : [])),
    ),
  };
}
