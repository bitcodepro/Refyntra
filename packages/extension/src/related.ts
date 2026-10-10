import * as vscode from 'vscode';
import { CancelledError, type EngineClient, type RelatedOutcome } from '@refyntra/application';
import type { RecoveryAction } from '@refyntra/contracts';
import { type MergedRelation, relationGroupTitle, relationLocation } from '@refyntra/domain';
import { isAllowedRecoveryCommand, runRecovery } from './actions';
import { openLocation, shortPath, toPosition } from './convert';
import { RelatedViewState, findSameRelation } from './relatedState';
import { scopeLines } from './scopePresentation';
import { describeReason, groupAccessibleLabel, messageAccessibleLabel, relationAccessibleLabel, relationDescription, relationKindLabel } from './terminology';

type Node =
  | { kind: 'group'; title: string; relations: MergedRelation[] }
  | { kind: 'relation'; relation: MergedRelation }
  | { kind: 'message'; text: string; icon: string; recovery?: RecoveryAction; tooltip?: string };

const FOLLOW_DEBOUNCE_MS = 350;
/** Delay before an outdated view (an edit in the subject or a target file) is computed again. */
export const STALE_REFRESH_MS = 600;

/** "Refyntra Related" tree: groups in RELATION_GROUP_ORDER, pinnable, follows the cursor unless pinned. */
export class RelatedViewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly state = new RelatedViewState();
  private pinned = false;
  private view: vscode.TreeView<Node> | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private timer: NodeJS.Timeout | undefined;
  private staleTimer: NodeJS.Timeout | undefined;
  private lastTarget: { uri: string; position: vscode.Position } | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly isTrusted: () => boolean = () => vscode.workspace.isTrusted,
  ) {
    this.subs.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.onCursor(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((ed) => ed && this.onCursor(ed)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      engine.onDidInvalidate(() => {
        this.state.invalidate();
        this.updateDescription();
        this.changed.fire(undefined);
        if (this.lastTarget) void this.refresh();
      }),
      vscode.commands.registerCommand('refyntra.related.open', (r: MergedRelation) => this.openRelation(r)),
    );
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateDescription();
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    void vscode.commands.executeCommand('setContext', 'refyntra.relatedPinned', pinned);
    this.updateDescription();
  }

  /** Explicit command: compute for the active cursor (even when pinned the explicit request wins). */
  async showForActiveEditor(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      void vscode.window.showInformationMessage('Refyntra Related: open a C#, TypeScript or JavaScript file and place the cursor on a symbol.');
      return;
    }
    await this.load(ed.document.uri.toString(), ed.selection.active);
  }

  async refresh(): Promise<void> {
    if (this.lastTarget) await this.load(this.lastTarget.uri, this.lastTarget.position);
  }

  current(): RelatedOutcome | undefined {
    return this.state.outcome;
  }

  private onCursor(editor: vscode.TextEditor): void {
    if (this.pinned || !this.view?.visible) return;
    if (!vscode.workspace.getConfiguration('refyntra').get<boolean>('related.followCursor', true)) return;
    const doc = editor.document;
    if (doc.uri.scheme !== 'file' || !this.engine.handlesDocument(doc.uri.toString(), doc.languageId)) return;
    if (this.timer) clearTimeout(this.timer);
    const pos = editor.selection.active;
    this.timer = setTimeout(() => void this.load(doc.uri.toString(), pos), FOLLOW_DEBOUNCE_MS);
  }

  /** An edit in the subject's file or a target file outdates the shown line numbers: mark and refresh (debounced). */
  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const uri = e.document.uri.toString();
    if (this.lastTarget?.uri === uri) this.lastTarget = { uri, position: shiftPosition(this.lastTarget.position, e.contentChanges) };
    if (!this.state.documentChanged(uri)) return;
    this.updateDescription();
    this.changed.fire(undefined);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => void this.refresh(), STALE_REFRESH_MS);
  }

  private async load(uri: string, position: vscode.Position): Promise<void> {
    this.cts?.cancel();
    this.cts?.dispose();
    if (this.staleTimer) clearTimeout(this.staleTimer);
    const source = new vscode.CancellationTokenSource();
    this.cts = source;
    this.lastTarget = { uri, position };
    this.state.begin();
    this.updateDescription();
    this.changed.fire(undefined);
    let outcome: RelatedOutcome;
    try {
      outcome = await this.engine.related({ uri, position: toPosition(position) }, source.token);
      if (source.token.isCancellationRequested) return;
    } catch (e) {
      if (e instanceof CancelledError || source.token.isCancellationRequested) {
        if (this.cts === source) this.state.abandon();
        return;
      }
      outcome = { kind: 'unavailable', reasonCode: 'Error', message: e instanceof Error ? e.message : String(e), recoveryActions: [] };
    }
    if (this.cts !== source) return;
    this.state.complete(outcome, uri);
    this.updateDescription();
    this.changed.fire(undefined);
  }

  /** Opens a relation; from an outdated view the relation is resolved again first (never an old line number). */
  async openRelation(r: MergedRelation): Promise<void> {
    if (this.state.canOpenDirectly) return openLocation(relationLocation(r));
    await this.refresh();
    const fresh = findSameRelation(this.state.outcome, r);
    if (!fresh || !this.state.canOpenDirectly) {
      void vscode.window.showInformationMessage(`Refyntra Related: "${r.target.label}" is no longer related to the symbol; the view was refreshed.`);
      return;
    }
    await openLocation(relationLocation(fresh));
  }

  private updateDescription(): void {
    if (!this.view) return;
    const o = this.state.outcome;
    const subject = o?.kind === 'related' ? o.subject?.name : undefined;
    const status = this.state.loading ? 'loading…' : this.state.stale ? 'outdated — refreshing' : undefined;
    this.view.description = [subject, status, this.pinned ? 'pinned' : undefined].filter(Boolean).join(' · ') || undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.relations.length);
        item.contextValue = 'refyntra.relatedGroup';
        item.accessibilityInformation = { label: groupAccessibleLabel(node.title, node.relations.length) };
        return item;
      }
      case 'relation': {
        const r = node.relation;
        const loc = relationLocation(r);
        const item = new vscode.TreeItem(r.target.label, vscode.TreeItemCollapsibleState.None);
        const place = loc ? `${shortPath(loc.uri)}:${loc.range.start.line + 1}` : undefined;
        item.description = relationDescription(r, place);
        const md = new vscode.MarkdownString(undefined, false);
        md.appendText(`${relationKindLabel(r.relationKind)} (${r.confidence})\n\n`);
        for (const e of r.evidence) md.appendText(`• ${e.description}\n`);
        for (const l of r.limitations) md.appendText(`Limitation: ${l}\n`);
        md.appendText(`\nSource: ${[...new Set(r.provenances.map((p) => `${p.providerRouteId} (${p.kind})`))].join(', ')}`);
        item.tooltip = md;
        // The tooltip is not reachable by keyboard: everything essential is in the label and the description.
        item.accessibilityInformation = { label: relationAccessibleLabel(r, place) };
        item.iconPath = r.confidence === 'proven' ? new vscode.ThemeIcon('arrow-right') : new vscode.ThemeIcon('question', new vscode.ThemeColor('list.warningForeground'));
        if (loc) item.command = { command: 'refyntra.related.open', title: 'Open', arguments: [r] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon, node.icon === 'warning' ? new vscode.ThemeColor('list.warningForeground') : undefined);
        if (node.tooltip) item.tooltip = node.tooltip;
        item.accessibilityInformation = { label: messageAccessibleLabel(node.icon, node.text, !!node.recovery) };
        if (node.recovery && isAllowedRecoveryCommand(node.recovery.command)) item.command = { command: node.recovery.command, title: node.recovery.title, arguments: node.recovery.args ?? [] };
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'group') return node.relations.map((relation) => ({ kind: 'relation', relation }));
    if (node) return [];
    if (this.state.loading) return [{ kind: 'message', text: 'Loading…', icon: 'loading~spin' }];
    const o = this.state.visibleOutcome;
    if (!o) return [];
    const head: Node[] = this.state.stale ? [{ kind: 'message', text: 'Outdated by an edit — refreshing…', icon: 'sync', tooltip: 'Line numbers below may have moved. Opening an item resolves it again first.' }] : [];
    if (o.kind === 'unavailable') {
      return [...head, { kind: 'message', text: o.message, icon: 'warning', tooltip: describeReason(o.reasonCode) }, ...o.recoveryActions.map((r): Node => ({ kind: 'message', text: r.title, icon: 'tools', recovery: r }))];
    }
    const nodes: Node[] = [...head];
    if (!o.subject) nodes.push({ kind: 'message', text: 'No symbol at the cursor.', icon: 'info' });
    for (const g of o.groups) nodes.push({ kind: 'group', title: relationGroupTitle(g.group), relations: g.relations });
    if (o.subject && o.groups.length === 0) nodes.push({ kind: 'message', text: 'No relations found.', icon: 'info' });
    // Plain-language scope notes, only when relevant (scopePresentation.ts).
    for (const l of scopeLines(o, { trusted: this.isTrusted() })) {
      nodes.push({ kind: 'message', text: l.text, icon: l.icon, ...(l.tooltip ? { tooltip: l.tooltip } : {}), ...(l.command ? { recovery: { command: l.command.command, title: l.command.title, args: l.command.args } } : {}) });
    }
    return nodes;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.cts?.cancel();
    this.cts?.dispose();
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}

/** Moves a position through text changes made before it (so a refresh asks for the same symbol). */
function shiftPosition(pos: vscode.Position, changes: readonly vscode.TextDocumentContentChangeEvent[]): vscode.Position {
  let line = pos.line;
  let character = pos.character;
  // Content changes of one event refer to the document before the event and do not overlap: apply from the end.
  for (const c of [...changes].sort((a, b) => b.range.start.compareTo(a.range.start))) {
    const end = c.range.end;
    if (end.line > line || (end.line === line && end.character > character)) continue;
    const insertedLines = c.text.split(/\r\n|\r|\n/);
    const removedLines = end.line - c.range.start.line;
    if (end.line === line) {
      const lastLen = insertedLines[insertedLines.length - 1]!.length;
      character = (insertedLines.length > 1 ? lastLen : c.range.start.character + lastLen) + (character - end.character);
    }
    line += insertedLines.length - 1 - removedLines;
  }
  return new vscode.Position(Math.max(0, line), Math.max(0, character));
}

/** Alias commands (Find Handler / Find DI Registration): same Related use case, filtered to one group. */
export async function runRelatedGroupPick(engine: EngineClient, group: 'handlers' | 'registrations', title: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showInformationMessage(`${title}: place the cursor on a symbol in a C# file.`);
    return;
  }
  const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title, cancellable: true }, (_p, token) =>
    engine.related({ uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) }, token),
  );
  if (outcome.kind === 'unavailable') {
    const pick = await vscode.window.showWarningMessage(`${title}: ${outcome.message}`, ...outcome.recoveryActions.map((r) => r.title));
    const action = outcome.recoveryActions.find((r) => r.title === pick);
    await runRecovery(action);
    return;
  }
  const relations = outcome.groups.find((g) => g.group === group)?.relations ?? [];
  if (relations.length === 0) {
    void vscode.window.showInformationMessage(`${title}: none found for ${outcome.subject?.name ?? 'the symbol at the cursor'}${outcome.completeness !== 'complete' ? ' (results may be incomplete: some projects did not load completely; see Refyntra: Show Health)' : ''}.`);
    return;
  }
  if (relations.length === 1) return openLocation(relationLocation(relations[0]!));
  const pick = await vscode.window.showQuickPick(
    relations.map((r) => {
      const loc = relationLocation(r);
      return { label: r.target.label, description: `${r.relationKind} · ${r.confidence}`, detail: loc ? `${shortPath(loc.uri)}:${loc.range.start.line + 1}` : undefined, relation: r };
    }),
    { placeHolder: title },
  );
  if (pick) await openLocation(relationLocation(pick.relation));
}
