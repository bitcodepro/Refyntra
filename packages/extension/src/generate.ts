import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { toPosition } from './convert';
import type { VsCodeEditApplier } from './editApplier';
import { canApply } from './editActionsModel';
import {
  EQUALITY_OPTIONS,
  GENERATE_COMMAND,
  type GenerateKindData,
  type GenerateKindId,
  type GenerateRequestData,
  allowsEmptySelection,
  delegationGroups,
  generateKinds,
  generateRequest,
  kindPickItems,
  memberPickItems,
  needsMemberPick,
  parseGenerateRequest,
} from './generateModel';

export interface GenerateTarget {
  uri: string;
  position: { line: number; character: number };
}

/**
 * Computes `request` on the host for the document at `target` and applies the edits as one undo step, only while the
 * document is still the version they were computed for. Returns true when applied; undefined when the host cannot
 * answer (no route, older host), so a caller may fall back.
 */
export async function applyGenerate(engine: EngineClient, applier: VsCodeEditApplier, target: GenerateTarget, request: GenerateRequestData, fallbackReasons: readonly string[] = []): Promise<boolean | undefined> {
  if (!engine.generate) return undefined;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri, true));
  const before = doc.version;
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: generating…' }, (_p, token) =>
    engine.generate!({ uri: target.uri, position: target.position }, request, token),
  );
  if (r.kind !== 'edits') {
    if (r.kind === 'unavailable' && ['ProtocolTooOld', 'ActionNotSupported', 'NoLanguageRoute', ...fallbackReasons].includes(r.reasonCode)) return undefined;
    if (r.kind === 'unavailable') void vscode.window.showInformationMessage(`Refyntra: ${r.message}`);
    return false;
  }
  if (!canApply(before, before, doc.version)) {
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
 * Refyntra: Generate… (Alt+Insert): what applies to the type at the cursor, then its members and options. With a
 * request argument (`{ kind, members?, equatable?, operators? }`, e.g. from a keybinding) it generates without asking.
 */
export async function runGenerate(engine: EngineClient, applier: VsCodeEditApplier, preset?: GenerateRequestData): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp' || editor.document.uri.scheme !== 'file' || !engine.generate) {
    void vscode.window.showInformationMessage('Refyntra: Generate works in a C# editor of the loaded solution.');
    return false;
  }
  const doc = editor.document;
  const target: GenerateTarget = { uri: doc.uri.toString(), position: toPosition(editor.selection.active) };
  const version = doc.version;
  if (preset) return (await applyGenerate(engine, applier, target, preset)) === true;
  const listed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: Generate…' }, (_p, token) => engine.generate!(target, undefined, token));
  if (listed.kind !== 'kinds') {
    void vscode.window.showInformationMessage(`Refyntra: ${listed.kind === 'unavailable' ? listed.message : 'Generate is not available here.'}`);
    return false;
  }
  const kinds = generateKinds(listed.kinds as GenerateKindData[]);
  if (kinds.length === 0) {
    void vscode.window.showInformationMessage('Refyntra: place the cursor inside a class, struct or record to generate members.');
    return false;
  }
  const typeName = listed.typeName ?? 'the type';
  const pick = await vscode.window.showQuickPick(kindPickItems(kinds), { title: `Refyntra: Generate (${typeName})`, placeHolder: 'What to generate' });
  if (!pick) return false;
  const kind = kinds.find((k) => k.kind === pick.kindId)!;
  const ids = await pickMembers(kind, typeName);
  if (ids === undefined) return false;
  let options: string[] = [];
  if (kind.kind === 'equality') {
    const chosen = await vscode.window.showQuickPick(EQUALITY_OPTIONS.map((o) => ({ ...o })), { title: `Refyntra: Equality members (${typeName})`, placeHolder: 'Options (Space toggles, Enter generates)', canPickMany: true });
    if (!chosen) return false;
    options = chosen.map((o) => o.id);
  }
  if (doc.version !== version) {
    void vscode.window.showWarningMessage('Refyntra: the document changed; nothing was generated. Try again.');
    return false;
  }
  return (await applyGenerate(engine, applier, target, generateRequest(kind.kind as GenerateKindId, ids, options))) === true;
}

/** The picked member ids (undefined: cancelled). Delegating first asks for the field to delegate through. */
async function pickMembers(kind: GenerateKindData, typeName: string): Promise<string[] | undefined> {
  if (!needsMemberPick(kind.kind)) return kind.members.map((m) => m.id);
  let group: string | undefined;
  if (kind.kind === 'delegating') {
    const groups = delegationGroups(kind.members);
    group = groups.length === 1 ? groups[0] : (await vscode.window.showQuickPick(groups, { title: `Refyntra: Delegating members (${typeName})`, placeHolder: 'Field or property to delegate to' }));
    if (!group) return undefined;
  }
  const items = memberPickItems(kind.members, group);
  if (items.length === 0 && allowsEmptySelection(kind.kind)) return [];
  const picks = await vscode.window.showQuickPick(items, { title: `Refyntra: ${kind.title} (${typeName})`, placeHolder: 'Members (Space toggles, Enter generates)', canPickMany: true });
  if (!picks) return undefined;
  if (picks.length === 0 && !allowsEmptySelection(kind.kind)) {
    void vscode.window.showInformationMessage('Refyntra: choose at least one member.');
    return undefined;
  }
  return picks.map((p) => p.id);
}

export function registerGenerate(engine: EngineClient, applier: VsCodeEditApplier): vscode.Disposable {
  return vscode.commands.registerCommand(GENERATE_COMMAND, (arg?: unknown) => runGenerate(engine, applier, parseGenerateRequest(arg)));
}
