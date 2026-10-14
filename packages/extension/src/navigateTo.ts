import * as vscode from 'vscode';
import { CancelledError, type EngineClient } from '@refyntra/application';
import type { SymbolRef } from '@refyntra/contracts';
import { fromLocation, openLocation, toPosition } from './convert';
import { metadataService } from './metadata';
import { type NavigateTarget, companionFiles, navigateTargets, targetOutcome } from './navigateToModel';

// Refyntra: Navigate To… (Rider's Alt+`): one QuickPick with every target of the symbol at the cursor that exists, each
// with its count. One location opens directly, several open VS Code's peek view, Usages opens the Refyntra Usages view
// and Call hierarchy VS Code's call hierarchy (answered by Refyntra's host).

export interface NavigateToState {
  /** The targets are computed (the list shows them, or a message said there are none). */
  ready: boolean;
  open: boolean;
  subject?: string;
  items: { id: string; label: string; description: string; detail?: string }[];
}

let state: NavigateToState = { ready: false, open: false, items: [] };
let current: { qp: vscode.QuickPick<PickItem>; choose: (t: NavigateTarget) => Promise<void> } | undefined;

/** Test hook: the open Navigate To list (tests wait on it instead of sleeping). */
export const navigateToState = (): NavigateToState => state;

/** Test hook: choose a target of the open list by id (the same path as Enter). */
export async function acceptNavigateTarget(id: string): Promise<boolean> {
  const c = current;
  const item = c?.qp.items.find((i) => i.target?.id === id);
  if (!c || !item?.target) return false;
  c.qp.hide();
  await c.choose(item.target);
  return true;
}

interface PickItem extends vscode.QuickPickItem {
  target?: NavigateTarget;
}

const CALLABLE = new Set(['method', 'constructor', 'property', 'event']);

async function hierarchyItems(engine: EngineClient, target: { uri: string; position: { line: number; character: number } }, direction: 'bases' | 'containing' | 'incoming', token: vscode.CancellationToken): Promise<SymbolRef[] | undefined> {
  try {
    const r = await engine.hierarchy(target, direction, token);
    return r.kind === 'hierarchy' ? r.items.map((i) => i.symbol) : undefined;
  } catch (e) {
    if (e instanceof CancelledError) return undefined;
    throw e;
  }
}

/** Companion files next to the declaration (same stem; bin/obj never: they are not next to sources). */
async function siblings(declUri: string): Promise<string[]> {
  const uri = vscode.Uri.parse(declUri, true);
  if (uri.scheme !== 'file') return [];
  const dir = vscode.Uri.joinPath(uri, '..');
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const stem = name.slice(0, name.indexOf('.') > 0 ? name.indexOf('.') : name.length);
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const candidates = entries.filter(([n, t]) => t === vscode.FileType.File && n.startsWith(stem)).map(([n]) => vscode.Uri.joinPath(dir, n).toString());
    return companionFiles(uri.toString(), candidates);
  } catch {
    return [];
  }
}

export async function runNavigateTo(engine: EngineClient): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Refyntra Navigate To: place the cursor on a symbol in a C# file.');
    return;
  }
  const target = { uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) };
  const origin = { uri: ed.document.uri, position: ed.selection.active };
  const qp = vscode.window.createQuickPick<PickItem>();
  qp.title = 'Refyntra: Navigate To';
  qp.placeholder = 'Finding targets of the symbol at the cursor…';
  qp.matchOnDescription = true;
  qp.busy = true;
  const cts = new vscode.CancellationTokenSource();
  state = { ready: false, open: true, items: [] };
  const choose = async (t: NavigateTarget) => {
    const o = targetOutcome(t);
    switch (o.kind) {
      case 'open':
        return openLocation(o.location);
      case 'peek':
        await vscode.window.showTextDocument(origin.uri, { selection: new vscode.Range(origin.position, origin.position) });
        await vscode.commands.executeCommand('editor.action.peekLocations', origin.uri, origin.position, o.locations.map(fromLocation), 'peek');
        return;
      case 'usages':
        await vscode.window.showTextDocument(origin.uri, { selection: new vscode.Range(origin.position, origin.position) });
        await vscode.commands.executeCommand('refyntra.findUsages');
        return;
      case 'callHierarchy':
        await vscode.window.showTextDocument(origin.uri, { selection: new vscode.Range(origin.position, origin.position) });
        await vscode.commands.executeCommand('references-view.showCallHierarchy');
        return;
      case 'metadata':
        await metadataService()?.open({ symbolId: o.symbolId }, 'Navigate To');
        return;
    }
  };
  current = { qp, choose };
  qp.onDidAccept(() => {
    const t = qp.selectedItems[0]?.target;
    qp.hide();
    if (t) void choose(t);
  });
  qp.onDidHide(() => {
    cts.cancel();
    cts.dispose();
    state = { ...state, open: false };
    if (current?.qp === qp) current = undefined;
    qp.dispose();
  });
  qp.show();

  try {
    const related = await engine.related(target, cts.token);
    if (cts.token.isCancellationRequested) return;
    if (related.kind === 'unavailable' || !related.subject) {
      const message = related.kind === 'unavailable' ? related.message : 'There is no symbol at the cursor.';
      qp.items = [{ label: `$(info) ${message}`, alwaysShow: true }];
      qp.placeholder = 'Nothing to navigate to';
      state = { ready: true, open: true, items: [{ id: 'message', label: message, description: '' }] };
      return;
    }
    const subject = related.subject;
    const callable = CALLABLE.has(subject.kind);
    const [bases, containing, callers] = await Promise.all([
      hierarchyItems(engine, target, 'bases', cts.token),
      hierarchyItems(engine, target, 'containing', cts.token),
      callable ? hierarchyItems(engine, target, 'incoming', cts.token) : Promise.resolve(undefined),
    ]);
    const declUri = subject.location?.uri ?? target.uri;
    const files = await siblings(declUri);
    if (cts.token.isCancellationRequested) return;
    const targets = navigateTargets({ subject, currentUri: target.uri, groups: related.groups, bases: bases ?? [], containing: containing ?? [], ...(callers ? { callers: callers.length } : {}), siblingFiles: files });
    const incomplete = related.completeness !== 'complete' ? ' (some projects did not load completely)' : '';
    qp.title = `Refyntra: Navigate To — ${subject.displayName ?? subject.name}`;
    if (targets.length === 0) {
      const message = `Nothing to navigate to from ${subject.name}${incomplete}.`;
      qp.items = [{ label: `$(info) ${message}`, alwaysShow: true }];
      qp.placeholder = 'Nothing to navigate to';
      state = { ready: true, open: true, subject: subject.name, items: [{ id: 'message', label: message, description: '' }] };
      return;
    }
    qp.items = targets.map((t) => ({
      label: `$(${t.icon}) ${t.label}`,
      description: t.countText,
      detail: t.action === 'locations' ? (t.locations.length === 1 ? 'opens it' : 'opens the peek view') : t.action === 'usages' ? 'opens the Refyntra Usages view' : t.action === 'metadata' ? 'opens the read-only decompiled source' : 'opens the call hierarchy',
      target: t,
    }));
    qp.placeholder = `Navigate from ${subject.name} to…${incomplete}`;
    state = { ready: true, open: true, subject: subject.name, items: qp.items.map((i) => ({ id: i.target!.id, label: i.target!.label, description: i.description ?? '', ...(i.detail ? { detail: i.detail } : {}) })) };
  } catch (e) {
    if (e instanceof CancelledError || cts.token.isCancellationRequested) return;
    const message = e instanceof Error ? e.message : String(e);
    qp.items = [{ label: `$(warning) Error: ${message}`, alwaysShow: true }];
    state = { ready: true, open: true, items: [{ id: 'error', label: message, description: '' }] };
  } finally {
    if (!cts.token.isCancellationRequested) qp.busy = false;
  }
}
