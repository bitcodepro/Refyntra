import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import type { Range } from '@refyntra/contracts';
import { fromRange } from './convert';
import { metadataService } from './metadata';
import {
  type DocSymbol,
  FILTER_ICONS,
  FILTER_ORDER,
  FILTER_TITLES,
  type StructureFilter,
  type StructureFilters,
  type StructureInput,
  type StructureRow,
  fromDocumentSymbols,
  hiddenFiltersText,
  loadFilters,
  rowAtLine,
  structureSections,
} from './fileStructureModel';

// Refyntra: File Structure (Rider's Ctrl+F12): a QuickPick of the members of the active file grouped by type and
// #region, with filter buttons, camel-hump type-to-filter, optional preview while moving, and a button that opens
// VS Code's Outline. C# asks the host (code/fileStructure, protocol 1.13, also inherited members); other languages
// use VS Code's document symbols.

export const FILE_STRUCTURE_FILTERS_KEY = 'refyntra.fileStructure.filters';

export interface FileStructureState {
  open: boolean;
  /** The rows are computed (also after a filter or query change). */
  ready: boolean;
  source?: 'host' | 'symbols';
  title?: string;
  filters: StructureFilters;
  message?: string;
  activeId?: string;
  items: { id: string; label: string; description: string; section: string; navigable: boolean }[];
}

interface PickItem extends vscode.QuickPickItem {
  row?: StructureRow;
}

const SHOW_IN_VIEW: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('list-tree'), tooltip: 'Show in the Outline view' };

let state: FileStructureState = { open: false, ready: false, filters: loadFilters(undefined), items: [] };
let current: { qp: vscode.QuickPick<PickItem>; choose: (row: StructureRow) => Promise<boolean>; setFilter: (f: StructureFilter, on: boolean) => Promise<void> } | undefined;

/** Test hook: the open File Structure list. */
export const fileStructureState = (): FileStructureState => state;

/** Test hook: choose a row by id (the same path as Enter); false when there is no such row or it is not navigable. */
export async function acceptStructureRow(id: string): Promise<boolean> {
  const item = current?.qp.items.find((i) => i.row?.id === id);
  if (!current || !item?.row) return false;
  return current.choose(item.row);
}

/** Test hook: a filter button (the same path as a click). */
export async function setStructureFilter(filter: StructureFilter, on: boolean): Promise<void> {
  await current?.setFilter(filter, on);
}

/** Test hook: type into the list. */
export function setStructureQuery(text: string): void {
  if (current) current.qp.value = text;
}

const toDocSymbol = (s: vscode.DocumentSymbol): DocSymbol => ({
  name: s.name,
  detail: s.detail,
  kind: s.kind,
  range: { start: { line: s.range.start.line, character: s.range.start.character }, end: { line: s.range.end.line, character: s.range.end.character } },
  selectionRange: { start: { line: s.selectionRange.start.line, character: s.selectionRange.start.character }, end: { line: s.selectionRange.end.line, character: s.selectionRange.end.character } },
  children: s.children.map(toDocSymbol),
});

const symbolRange = (s: vscode.SymbolInformation): Range => ({
  start: { line: s.location.range.start.line, character: s.location.range.start.character },
  end: { line: s.location.range.end.line, character: s.location.range.end.character },
});

async function documentSymbols(doc: vscode.TextDocument): Promise<StructureInput> {
  const symbols = (await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
  const tree: DocSymbol[] = symbols.map((s) => ('children' in s ? toDocSymbol(s) : { name: s.name, kind: s.kind, range: symbolRange(s), selectionRange: symbolRange(s), children: [] }));
  const name = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
  return fromDocumentSymbols(tree, name);
}

export async function runFileStructure(engine: EngineClient, memento: vscode.Memento): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showInformationMessage('Refyntra File Structure: open a file first.');
    return;
  }
  current?.qp.hide();
  const doc = ed.document;
  const fileName = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
  const csharp = doc.languageId === 'csharp' && typeof engine.fileStructure === 'function';
  const origin = { selection: ed.selection, visible: ed.visibleRanges[0] };
  let filters = loadFilters(memento.get<unknown>(FILE_STRUCTURE_FILTERS_KEY));
  const inputs: { plain?: StructureInput; inherited?: StructureInput } = {};
  let source: 'host' | 'symbols' = csharp ? 'host' : 'symbols';
  let message: string | undefined;
  let accepted = false;
  let generation = 0;

  const qp = vscode.window.createQuickPick<PickItem>();
  qp.placeholder = 'Type to filter members (camel humps: gO finds GetOrder)';
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.busy = true;
  const cts = new vscode.CancellationTokenSource();
  state = { open: true, ready: false, filters, items: [] };

  const titleOf = (input: StructureInput | undefined) => {
    const extra = hiddenFiltersText(filters, !!input?.inheritedAvailable);
    return `Refyntra: File Structure — ${fileName}${extra ? ` (${extra})` : ''}`;
  };

  const buttons = (input: StructureInput | undefined): vscode.QuickInputButton[] => [
    ...FILTER_ORDER.filter((f) => f !== 'inherited' || input?.inheritedAvailable).map((f) => ({
      iconPath: new vscode.ThemeIcon(filters[f] ? FILTER_ICONS[f] : 'circle-slash'),
      tooltip: f === 'inherited' ? (filters[f] ? 'Hide inherited members' : 'Show inherited members') : filters[f] ? `Hide ${FILTER_TITLES[f]}` : `Show ${FILTER_TITLES[f]}`,
      filter: f,
    })),
    SHOW_IN_VIEW,
  ];

  async function load(): Promise<StructureInput | undefined> {
    const withInherited = csharp && filters.inherited;
    const cached = withInherited ? inputs.inherited : inputs.plain;
    if (cached) return cached;
    if (csharp) {
      const r = await engine.fileStructure!(doc.uri.toString(), withInherited, cts.token);
      if (r.kind === 'structure') {
        const input: StructureInput = { types: r.result.types, accessibility: true, inheritedAvailable: true };
        if (withInherited) inputs.inherited = input;
        else inputs.plain = input;
        return input;
      }
      // Not in the solution (or no host): VS Code's document symbols instead.
      message = r.message;
      source = 'symbols';
    }
    inputs.plain ??= await documentSymbols(doc);
    return inputs.plain;
  }

  const render = async (selectAtCursor: boolean) => {
    const gen = ++generation;
    state = { ...state, ready: false, filters };
    qp.busy = true;
    let input: StructureInput | undefined;
    try {
      input = await load();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (gen !== generation || cts.token.isCancellationRequested) return;
    qp.busy = false;
    qp.title = titleOf(input);
    qp.buttons = buttons(input);
    const sections = input ? structureSections(input, filters, qp.value) : [];
    const items: PickItem[] = [];
    for (const s of sections) {
      items.push({ label: s.title, kind: vscode.QuickPickItemKind.Separator });
      for (const r of s.rows) items.push({ label: r.label, description: r.description, iconPath: new vscode.ThemeIcon(r.icon), alwaysShow: true, row: r });
    }
    const previous = qp.activeItems[0]?.row?.id;
    qp.items = items.length ? items : [{ label: input && input.types.length ? '$(search-stop) No members match' : `$(info) ${message ?? 'No types or members in this file'}`, alwaysShow: true }];
    const at = selectAtCursor ? rowAtLine(sections, origin.selection.active.line) : undefined;
    const keep = (at && items.find((i) => i.row?.id === at.id)) ?? (previous ? items.find((i) => i.row?.id === previous) : undefined);
    if (keep) qp.activeItems = [keep];
    state = {
      open: true,
      ready: true,
      source,
      title: qp.title,
      filters,
      ...(message ? { message } : {}),
      ...(qp.activeItems[0]?.row ? { activeId: qp.activeItems[0].row.id } : {}),
      items: sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, label: r.label, description: r.description, section: s.title, navigable: r.navigable }))),
    };
  };

  const reveal = async (row: StructureRow, preview: boolean): Promise<void> => {
    const sel = fromRange(row.selectionRange);
    if (!row.uri || row.uri === doc.uri.toString()) {
      const target = await vscode.window.showTextDocument(doc, { preserveFocus: preview, preview: false, selection: new vscode.Selection(sel.start, sel.start), viewColumn: ed.viewColumn });
      target.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    if (preview) return; // inherited members in other files open on Enter only
    const other = await vscode.workspace.openTextDocument(vscode.Uri.parse(row.uri, true));
    const target = await vscode.window.showTextDocument(other, { preview: false, selection: new vscode.Selection(sel.start, sel.start) });
    target.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const choose = async (row: StructureRow): Promise<boolean> => {
    if (!row.navigable && row.metadata && metadataService()) {
      // A library member: its decompiled source (go to metadata, protocol 1.17).
      accepted = true;
      qp.hide();
      const r = await metadataService()!.open({ documentationId: row.metadata.documentationId, ...(row.metadata.assemblyName ? { assemblyName: row.metadata.assemblyName } : {}) }, 'File Structure');
      return r.kind !== 'none';
    }
    if (!row.navigable) {
      void vscode.window.showInformationMessage(`Refyntra File Structure: ${row.label} is declared in a referenced assembly; File Structure opens only members with source in the solution.`);
      return false;
    }
    accepted = true;
    qp.hide();
    await reveal(row, false);
    return true;
  };

  const setFilter = async (f: StructureFilter, on: boolean) => {
    filters = { ...filters, [f]: on };
    await memento.update(FILE_STRUCTURE_FILTERS_KEY, filters);
    await render(false);
  };

  current = { qp, choose, setFilter };
  qp.onDidChangeValue(() => void render(false));
  qp.onDidAccept(() => {
    const row = qp.activeItems[0]?.row;
    if (row) void choose(row);
  });
  qp.onDidChangeActive((items) => {
    const row = items[0]?.row;
    if (!row) return;
    state = { ...state, activeId: row.id };
    if (vscode.workspace.getConfiguration('refyntra').get<boolean>('fileStructure.preview', false) && row.navigable) void reveal(row, true);
  });
  qp.onDidTriggerButton((b) => {
    if (b === SHOW_IN_VIEW) {
      accepted = true;
      qp.hide();
      void vscode.commands.executeCommand('outline.focus');
      return;
    }
    const f = (b as vscode.QuickInputButton & { filter?: StructureFilter }).filter;
    if (f) void setFilter(f, !filters[f]);
  });
  qp.onDidHide(() => {
    cts.cancel();
    cts.dispose();
    state = { ...state, open: false };
    if (current?.qp === qp) current = undefined;
    qp.dispose();
    // Esc after previewing: back where the cursor was.
    if (!accepted && vscode.workspace.getConfiguration('refyntra').get<boolean>('fileStructure.preview', false) && !ed.document.isClosed) {
      ed.selection = origin.selection;
      if (origin.visible) ed.revealRange(origin.visible, vscode.TextEditorRevealType.AtTop);
    }
  });
  qp.title = titleOf(undefined);
  qp.show();
  await render(true);
}

