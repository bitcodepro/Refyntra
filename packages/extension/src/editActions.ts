import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { CSHARP_FIX_ALL_ACTION } from '@refyntra/contracts';
import { runCodePlan } from './codeRefactor';
import { toPosition } from './convert';
import type { VsCodeEditApplier } from './editApplier';
import {
  EDIT_ACTION_COMMAND,
  FIX_ALL_COMMAND,
  FIX_ALL_SCOPE_ITEMS,
  INTRODUCE_PARAMETER_COMMAND,
  INTRODUCE_PARAMETER_EDIT_ACTION,
  KEYBOARD_ACTIONS,
  type EditActionTarget,
  canApply,
  choicePickItems,
  editActionTitle,
  fixAllVariant,
  groupEditActions,
  offerEditActions,
  parseEditActionTarget,
  parseFixAllTarget,
} from './editActionsModel';
import type { PreviewContentProvider } from './rename';

const CACHE_MS = 4000;

/**
 * Rider-style C# edit actions in the lightbulb / Ctrl+. / Refactor… menu: Convert (expression ↔ block body, var ↔
 * explicit type, invert / merge / split if, conditional ↔ if, interpolated string), Inline Variable and Introduce
 * Variable, Introduce Field / Constant (one action per family; its choices in a QuickPick) and Introduce Parameter
 * (run as a previewed plan). The C# host lists them and computes the edits with Roslyn, refusing a result with a new compiler error.
 * Only an explicit request (Ctrl+., the Refactor menu) or a non-empty selection asks the host; the edits are applied
 * as one undo step, only while the document is still the version they were computed for.
 */
export class EditActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite.append('refyntra'),
    vscode.CodeActionKind.RefactorInline.append('refyntra'),
    vscode.CodeActionKind.RefactorExtract.append('refyntra'),
  ];

  private cache: { key: string; at: number; items: { actionId: string; title: string; kind: string }[] } | undefined;

  constructor(private readonly engine: EngineClient) {}

  async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
    if (document.languageId !== 'csharp' || document.uri.scheme !== 'file' || !this.engine.editActions) return [];
    if (!this.engine.handlesDocument(document.uri.toString(), document.languageId)) return [];
    const explicit = context.triggerKind === vscode.CodeActionTriggerKind.Invoke;
    if (!explicit && range.isEmpty) return [];
    const target = { uri: document.uri.toString(), range: { start: toPosition(range.start), end: toPosition(range.end) } };
    const key = `${target.uri}#${document.version}#${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
    let items: { actionId: string; title: string; kind: string }[];
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < CACHE_MS) items = this.cache.items;
    else {
      const source = new vscode.CancellationTokenSource();
      const sub = token.onCancellationRequested(() => source.cancel());
      try {
        const r = await this.engine.editActions(target, undefined, source.token);
        items = r.kind === 'actions' ? r.items : [];
        this.cache = { key, at: Date.now(), items };
      } catch {
        return [];
      } finally {
        sub.dispose();
        source.dispose();
      }
    }
    if (token.isCancellationRequested) return [];
    const out: vscode.CodeAction[] = [];
    const scoped: vscode.CodeAction[] = [];
    for (const i of groupEditActions(offerEditActions(items, context.only?.value))) {
      const a = new vscode.CodeAction(editActionTitle(i), vscode.CodeActionKind.Empty.append(i.kind));
      const arg: EditActionTarget = { ...target, actionId: i.actionId, version: document.version, ...(i.choices.length ? { choices: i.choices } : {}) };
      a.command = { command: EDIT_ACTION_COMMAND, title: a.title, arguments: [arg] };
      out.push(a);
      // Fix in scope (protocol 1.11): the same action in the document, the project or the solution (listed after the single actions).
      const v = fixAllVariant(i);
      if (v) {
        const f = new vscode.CodeAction(editActionTitle(v), vscode.CodeActionKind.Empty.append(v.kind));
        f.command = { command: FIX_ALL_COMMAND, title: f.title, arguments: [{ uri: target.uri, actionId: v.actionId, title: i.title }] };
        scoped.push(f);
      }
    }
    return [...out, ...scoped];
  }
}

/** Computes the action on the host and applies its edits as one undo step (only to the same document version). */
export async function runEditAction(engine: EngineClient, applier: VsCodeEditApplier, arg: unknown): Promise<boolean> {
  const t = parseEditActionTarget(arg);
  if (!t || !engine.editActions) return false;
  if (t.choices && t.choices.length > 1) {
    const pick = await vscode.window.showQuickPick(choicePickItems(t.choices), { title: 'Refyntra: choose how to introduce it', placeHolder: 'Where the value is initialized / declared' });
    if (!pick) return false;
    t.actionId = pick.actionId;
  }
  if (t.actionId === INTRODUCE_PARAMETER_EDIT_ACTION) {
    // A plan over every call site (other files too): preview, revalidation and Undo of the code refactorings.
    await vscode.commands.executeCommand(INTRODUCE_PARAMETER_COMMAND, { uri: t.uri, position: t.range.start, range: t.range });
    return true;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri, true));
  const before = doc.version;
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: computing the edit…' }, (_p, token) =>
    engine.editActions!({ uri: t.uri, range: t.range }, t.actionId, token),
  );
  if (r.kind !== 'edits') {
    if (r.kind === 'unavailable') void vscode.window.showInformationMessage(`Refyntra: ${r.message}`);
    return false;
  }
  if (!canApply(t.version, before, doc.version)) {
    void vscode.window.showWarningMessage('Refyntra: the document changed; nothing was applied. Try again.');
    return false;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const e of r.edits) edit.replace(doc.uri, new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);
  const ok = await applier.applyCodeActionEdit(edit);
  if (!ok) void vscode.window.showWarningMessage('Refyntra: the document changed; nothing was applied. Try again.');
  return ok;
}

/**
 * Fix in scope: the scope (QuickPick), then the host applies the action to every place in it as one plan
 * (refactor/prepare csharp.fixAll) — preview, revalidation, EditApplier and Undo like the other code refactorings.
 */
export async function runFixAll(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier, arg: unknown): Promise<void> {
  const t = parseFixAllTarget(arg);
  if (!t) return;
  let scope = t.scope;
  if (!scope) {
    const pick = await vscode.window.showQuickPick([...FIX_ALL_SCOPE_ITEMS], { title: `Refyntra: ${t.title}`, placeHolder: 'Apply it in…' });
    if (!pick) return;
    scope = pick.scope;
  }
  const s = scope;
  const title = `${t.title} in ${s}`;
  await runCodePlan(engine, previews, applier, title, (token) => engine.prepareAction({ uri: t.uri, position: { line: 0, character: 0 } }, CSHARP_FIX_ALL_ACTION, token, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, fixAll: { actionId: t.actionId, scope: s } }), () =>
    runFixAll(engine, previews, applier, { ...t, scope: s }),
  );
}

/** Keyboard commands (Introduce / Inline Variable) at the active editor's selection. */
async function runKeyboardAction(engine: EngineClient, applier: VsCodeEditApplier, command: string): Promise<boolean> {
  const spec = KEYBOARD_ACTIONS[command];
  const editor = vscode.window.activeTextEditor;
  if (!spec || !editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage(`Refyntra: ${spec?.label ?? 'this action'} works in a C# editor.`);
    return false;
  }
  const sel = editor.selection;
  if (spec.needsSelection && sel.isEmpty) {
    void vscode.window.showInformationMessage(`Refyntra: select an expression first (${spec.label}).`);
    return false;
  }
  const range = spec.needsSelection ? sel : new vscode.Range(sel.active, sel.active);
  return runEditAction(engine, applier, { uri: editor.document.uri.toString(), range: { start: toPosition(range.start), end: toPosition(range.end) }, actionId: spec.actionId, version: editor.document.version });
}

export function registerEditActions(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(FIX_ALL_COMMAND, (arg?: unknown) => runFixAll(engine, previews, applier, arg)),
    vscode.languages.registerCodeActionsProvider({ language: 'csharp', scheme: 'file' }, new EditActionProvider(engine), { providedCodeActionKinds: EditActionProvider.providedCodeActionKinds }),
    vscode.commands.registerCommand(EDIT_ACTION_COMMAND, (arg?: unknown) => runEditAction(engine, applier, arg)),
    ...Object.keys(KEYBOARD_ACTIONS).map((c) => vscode.commands.registerCommand(c, () => runKeyboardAction(engine, applier, c))),
  );
}
