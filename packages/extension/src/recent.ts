import * as vscode from 'vscode';
import {
  type LineChange,
  type LocationsMode,
  RECENT_FILES_KEY,
  RECENT_LOCATIONS_KEY,
  type RecentLocation,
  type SymbolSpan,
  VISIT_REST_MS,
  applyChanges,
  deleteFiles,
  deleteLocations,
  fileName,
  filesStore,
  folderOf,
  insertedShape,
  loadFiles,
  loadLocations,
  locationId,
  locationSections,
  locationsStore,
  memberFromSymbols,
  memberFromText,
  recentFileOrder,
  recordLocation,
  refreshLineTexts,
  relativePath,
  removeFile,
  removeLocation,
  renameFiles,
  renameLocations,
  touchFile,
} from './recentModel';

// Recent Files (Ctrl+E) and Recent Locations (Ctrl+Shift+E), Rider-style. The lists are kept per workspace in
// workspaceState (local only); the pure rules (ordering, dedupe, re-anchoring) live in recentModel.ts.

export interface RecentPickState {
  open: boolean;
  /** The list is complete (containing members computed); tests and screenshots wait on it. */
  ready: boolean;
  kind?: 'files' | 'locations';
  mode: LocationsMode;
  items: { id: string; label: string; description: string; detail?: string; section?: string }[];
}

interface FileItem extends vscode.QuickPickItem {
  uri?: string;
}

interface LocationItem extends vscode.QuickPickItem {
  loc?: RecentLocation;
}

const RECORDED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);
const REMOVE_FILE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Remove from Recent Files' };
const REMOVE_LOCATION: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Remove from Recent Locations' };
const EDITED_ONLY: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('filter'), tooltip: 'Show edited locations only' };
const SHOW_ALL: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('filter-filled'), tooltip: 'Show edited and visited locations' };

const recorded = (uri: vscode.Uri): boolean => RECORDED_SCHEMES.has(uri.scheme);

export class RecentService implements vscode.Disposable {
  private files: string[] = [];
  private locations: RecentLocation[] = [];
  private mode: LocationsMode = 'all';
  private visitTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly subs: vscode.Disposable[] = [];
  private pick: RecentPickState = { open: false, ready: false, mode: 'all', items: [] };
  private current: { qp: vscode.QuickPick<FileItem | LocationItem>; kind: 'files' | 'locations'; refresh: () => void } | undefined;

  constructor(private readonly memento: vscode.Memento) {
    this.reload();
    const ed = vscode.window.activeTextEditor;
    if (ed) this.onActive(ed);
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.onActive(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.scheduleVisit(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.files = renameFiles(this.files, f.oldUri.toString(), f.newUri.toString());
          this.locations = renameLocations(this.locations, f.oldUri.toString(), f.newUri.toString());
        }
        this.save();
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const f of e.files) {
          this.files = deleteFiles(this.files, f.toString());
          this.locations = deleteLocations(this.locations, f.toString());
        }
        this.save();
      }),
    );
  }

  /** Reads the stored lists again (e2e: what a new window would see). */
  reload(): void {
    this.files = loadFiles(this.memento.get<unknown>(RECENT_FILES_KEY));
    this.locations = loadLocations(this.memento.get<unknown>(RECENT_LOCATIONS_KEY));
  }

  /** Test hook: both lists emptied (screenshots start from a known state). */
  clear(): void {
    this.files = [];
    this.locations = [];
    this.save();
  }

  recentFiles(): string[] {
    return [...this.files];
  }

  recentLocations(): RecentLocation[] {
    return [...this.locations];
  }

  state(): RecentPickState {
    return this.pick;
  }

  /** Writes pending changes now (tests; deactivation). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.write();
    }
    await this.saving;
  }

  private write(): void {
    const files = filesStore(this.files);
    const locations = locationsStore(this.locations);
    this.saving = this.saving.then(async () => {
      await this.memento.update(RECENT_FILES_KEY, files);
      await this.memento.update(RECENT_LOCATIONS_KEY, locations);
    });
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.write();
    }, 500);
  }

  private onActive(ed: vscode.TextEditor): void {
    if (!recorded(ed.document.uri)) return;
    this.files = touchFile(this.files, ed.document.uri.toString());
    this.save();
    this.scheduleVisit(ed);
  }

  private scheduleVisit(ed: vscode.TextEditor): void {
    if (!recorded(ed.document.uri)) return;
    if (this.visitTimer) clearTimeout(this.visitTimer);
    this.visitTimer = setTimeout(() => {
      this.visitTimer = undefined;
      const active = vscode.window.activeTextEditor;
      if (active !== ed || ed.document.isClosed) return;
      const p = ed.selection.active;
      this.locations = recordLocation(this.locations, { uri: ed.document.uri.toString(), line: p.line, character: p.character, kind: 'visited', lineText: ed.document.lineAt(p.line).text, time: Date.now() });
      this.save();
    }, VISIT_REST_MS);
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0 || !recorded(e.document.uri)) return;
    const uri = e.document.uri.toString();
    const changes: LineChange[] = e.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      startCharacter: c.range.start.character,
      endLine: c.range.end.line,
      endCharacter: c.range.end.character,
      ...insertedShape(c.text),
    }));
    const doc = e.document;
    const lineAt = (l: number) => (l < doc.lineCount ? doc.lineAt(l).text : undefined);
    if (this.locations.some((l) => l.uri === uri)) this.locations = refreshLineTexts(applyChanges(this.locations, uri, changes), uri, lineAt);
    // Only edits typed in the active editor are recorded (a rename across files is not "where I edited").
    if (vscode.window.activeTextEditor?.document === doc) {
      const first = [...changes].sort((a, b) => a.startLine - b.startLine)[0]!;
      const line = Math.min(first.startLine + first.insertedLines, doc.lineCount - 1);
      const character = first.insertedLines === 0 ? first.startCharacter + first.insertedLastLineLength : first.insertedLastLineLength;
      this.locations = recordLocation(this.locations, { uri, line, character, kind: 'edited', lineText: doc.lineAt(line).text, time: Date.now() });
    }
    this.save();
  }

  // ---- Recent Files ----------------------------------------------------------------------------------------------

  showFiles(): void {
    this.current?.qp.hide();
    const qp = vscode.window.createQuickPick<FileItem>();
    qp.title = 'Refyntra: Recent Files';
    qp.placeholder = 'Type to filter recently opened files';
    qp.matchOnDescription = true;
    const refresh = () => {
      const openUris = vscode.window.tabGroups.all.flatMap((g) => g.tabs).flatMap((t) => (t.input instanceof vscode.TabInputText && recorded(t.input.uri) ? [t.input.uri.toString()] : []));
      const currentUri = vscode.window.activeTextEditor?.document.uri.toString();
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString());
      const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
      const items: FileItem[] = recentFileOrder(this.files, currentUri, openUris).map((uri) => {
        const folder = folderOf(relativePath(uri, folders));
        const description = [dirty.has(uri) ? 'modified' : '', folder].filter(Boolean).join(' · ');
        return { label: fileName(uri), description, iconPath: vscode.ThemeIcon.File, buttons: [REMOVE_FILE], uri };
      });
      const active = qp.activeItems[0]?.uri;
      qp.items = items.length ? items : [{ label: 'No recent files yet', alwaysShow: true }];
      const keep = active ? qp.items.find((i) => i.uri === active) : undefined;
      if (keep) qp.activeItems = [keep];
      this.pick = { open: true, ready: true, kind: 'files', mode: this.mode, items: items.map((i) => ({ id: i.uri!, label: i.label, description: i.description ?? '' })) };
    };
    this.wire(qp, 'files', refresh, async (item) => {
      const uri = (item as FileItem).uri;
      if (uri) await this.openFile(uri);
    });
    qp.onDidTriggerItemButton((e) => {
      const uri = e.item.uri;
      if (!uri) return;
      this.files = removeFile(this.files, uri);
      this.save();
      refresh();
    });
    refresh();
    qp.show();
  }

  private async openFile(uri: string): Promise<void> {
    try {
      await vscode.window.showTextDocument(vscode.Uri.parse(uri, true), { preview: false });
    } catch (e) {
      this.files = removeFile(this.files, uri);
      this.save();
      void vscode.window.showWarningMessage(`Refyntra: cannot open ${fileName(uri)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- Recent Locations ------------------------------------------------------------------------------------------

  showLocations(): void {
    this.current?.qp.hide();
    const qp = vscode.window.createQuickPick<LocationItem>();
    qp.title = 'Refyntra: Recent Locations';
    qp.placeholder = 'Type to filter by file, member or code';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const members = new Map<string, (line: number) => string | undefined>();
    let generation = 0;
    const refresh = () => {
      const gen = ++generation;
      const sections = locationSections(this.locations, this.mode);
      qp.buttons = [this.mode === 'all' ? EDITED_ONLY : SHOW_ALL];
      const items: LocationItem[] = [];
      const st: RecentPickState['items'] = [];
      for (const s of sections) {
        items.push({ label: s.title, kind: vscode.QuickPickItemKind.Separator });
        for (const l of s.items) {
          const member = members.get(l.uri)?.(l.line);
          const item: LocationItem = {
            label: `${fileName(l.uri)}:${l.line + 1}`,
            description: member ?? '',
            detail: l.lineText.trim() || ' ',
            iconPath: new vscode.ThemeIcon(l.kind === 'edited' ? 'edit' : 'eye'),
            buttons: [REMOVE_LOCATION],
            loc: l,
          };
          items.push(item);
          st.push({ id: locationId(l), label: item.label, description: item.description ?? '', detail: l.lineText.trim(), section: s.title });
        }
      }
      const active = qp.activeItems[0]?.loc;
      qp.items = st.length ? items : [{ label: this.mode === 'edited' ? 'No edited locations yet' : 'No recent locations yet', alwaysShow: true }];
      const keep = active ? qp.items.find((i) => i.loc && locationId(i.loc) === locationId(active)) : undefined;
      if (keep) qp.activeItems = [keep];
      const missing = [...new Set(this.locations.map((l) => l.uri))].filter((u) => !members.has(u));
      if (missing.length === 0) {
        this.pick = { open: true, ready: true, kind: 'locations', mode: this.mode, items: st };
        qp.busy = false;
        return;
      }
      this.pick = { open: true, ready: false, kind: 'locations', mode: this.mode, items: st };
      qp.busy = true;
      void Promise.all(missing.map(async (u) => members.set(u, await memberResolver(u)))).then(() => {
        if (gen === generation && this.current?.qp === qp) refresh();
      });
    };
    this.wire(qp, 'locations', refresh, async (item) => {
      const loc = (item as LocationItem).loc;
      if (loc) await this.openLocation(loc);
    });
    qp.onDidTriggerButton(() => {
      this.mode = this.mode === 'all' ? 'edited' : 'all';
      refresh();
    });
    qp.onDidTriggerItemButton((e) => {
      const loc = e.item.loc;
      if (!loc) return;
      this.locations = removeLocation(this.locations, locationId(loc));
      this.save();
      refresh();
    });
    refresh();
    qp.show();
  }

  private async openLocation(l: RecentLocation): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(l.uri, true));
      const line = Math.min(l.line, doc.lineCount - 1);
      const pos = new vscode.Position(line, Math.min(l.character, doc.lineAt(line).text.length));
      const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Selection(pos, pos) });
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (e) {
      this.locations = removeLocation(this.locations, locationId(l));
      this.save();
      void vscode.window.showWarningMessage(`Refyntra: cannot open ${fileName(l.uri)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Test hook: the edited-only toggle (the same path as the title button). */
  toggleEditedOnly(): void {
    this.mode = this.mode === 'all' ? 'edited' : 'all';
    if (this.current?.kind === 'locations') this.current.refresh();
  }

  /** Test hook: the remove button of a row (file uri or location id). */
  removeItem(id: string): boolean {
    const c = this.current;
    if (!c) return false;
    if (c.kind === 'files') {
      if (!this.files.includes(id)) return false;
      this.files = removeFile(this.files, id);
    } else {
      if (!this.locations.some((l) => locationId(l) === id)) return false;
      this.locations = removeLocation(this.locations, id);
    }
    this.save();
    c.refresh();
    return true;
  }

  /** Test hook: choose a row by id (the same path as Enter). */
  async accept(id: string): Promise<boolean> {
    const c = this.current;
    if (!c) return false;
    const item = c.qp.items.find((i) => ('uri' in i && i.uri === id) || ('loc' in i && i.loc && locationId(i.loc) === id));
    if (!item) return false;
    c.qp.hide();
    if ('uri' in item && item.uri) await this.openFile(item.uri);
    else if ('loc' in item && item.loc) await this.openLocation(item.loc);
    return true;
  }

  private wire<T extends FileItem | LocationItem>(qp: vscode.QuickPick<T>, kind: 'files' | 'locations', refresh: () => void, choose: (item: T) => Promise<void>): void {
    this.current = { qp: qp as unknown as vscode.QuickPick<FileItem | LocationItem>, kind, refresh };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] ?? qp.activeItems[0];
      qp.hide();
      if (item) void choose(item);
    });
    qp.onDidHide(() => {
      if (this.current?.qp === (qp as unknown)) {
        this.current = undefined;
        this.pick = { ...this.pick, open: false };
      }
      qp.dispose();
    });
  }

  dispose(): void {
    if (this.visitTimer) clearTimeout(this.visitTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.write();
    }
    this.current?.qp.hide();
    for (const s of this.subs) s.dispose();
  }
}

/** The containing member of a line: document symbols of an open document, else a text scan (never opens a document). */
async function memberResolver(uri: string): Promise<(line: number) => string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  if (open) {
    try {
      const symbols = await withTimeout(vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', open.uri), 2000);
      const spans = (symbols ?? []).map(toSpan);
      if (spans.length) return (line) => memberFromSymbols(spans, line);
    } catch {
      /* no provider: the text scan below */
    }
    const lines = open.getText().split(/\r\n|\r|\n/);
    return (line) => memberFromText(lines, line);
  }
  try {
    const u = vscode.Uri.parse(uri, true);
    if (u.scheme !== 'file' && u.scheme !== 'vscode-remote') return () => undefined;
    const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(u));
    const lines = text.split(/\r\n|\r|\n/);
    return (line) => memberFromText(lines, line);
  } catch {
    return () => undefined;
  }
}

function toSpan(s: vscode.DocumentSymbol | vscode.SymbolInformation): SymbolSpan {
  if ('children' in s) return { name: s.name, kind: s.kind, startLine: s.range.start.line, endLine: s.range.end.line, children: s.children.map(toSpan) };
  return { name: s.name, kind: s.kind, startLine: s.location.range.start.line, endLine: s.location.range.end.line, children: [] };
}

function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function registerRecent(memento: vscode.Memento): { service: RecentService; disposable: vscode.Disposable } {
  const service = new RecentService(memento);
  const disposable = vscode.Disposable.from(
    service,
    vscode.commands.registerCommand('refyntra.recentFiles', () => service.showFiles()),
    vscode.commands.registerCommand('refyntra.recentLocations', () => service.showLocations()),
  );
  return { service, disposable };
}
