import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ResolveFrameOutcome } from '@refyntra/application';
import type { FrameCandidate, ResolveFrameRequest } from '@refyntra/contracts';
import { fromLocation, shortPath } from './convert';
import { type ExceptionGroup, type ParsedTrace, type StackFrame, parseStackTrace } from './stackTraceParse';
import { type PathResolution, basenameOf, caseRuleFor, lineMayHaveMoved, matchFramePath } from './stackTracePaths';
import { frameAccessibleLabel, frameDescription, groupAccessibleLabelFor, groupLabel, lineMovedNotice } from './stackTracePresentation';
import { CONFIDENCE_PHRASE, type FrameStatus, describeReason } from './terminology';

// Stack trace navigation: the user pastes a trace; frames are listed by exception and opened in the workspace.
// Nothing is executed and nothing goes to the network: files are matched by path, .NET frames without a usable file
// are looked up by symbol through the C# backend (code/resolveFrame). Missing symbols are not recovered.

export const STACK_TRACE_VIEW = 'refyntra.stackTraceView';
const EXCLUDE = '**/{node_modules,bin,obj,.git,target,__pycache__,.venv,venv}/**';

interface FrameEntry {
  id: number;
  frame: StackFrame;
  group: ExceptionGroup;
  indexInGroup: number;
  resolution?: PathResolution;
  status: FrameStatus;
}

type Node =
  | { kind: 'group'; group: ExceptionGroup; entries: FrameEntry[] }
  | { kind: 'external'; entries: FrameEntry[] }
  | { kind: 'frame'; entry: FrameEntry };

export type OpenFrameResult =
  | { kind: 'opened'; uri: string; line: number; notice?: string; confidence?: 'proven' | 'likely' }
  | { kind: 'none'; message: string }
  | { kind: 'cancelled' };

/** Test seam: replaces showQuickPick (e2e chooses an item; production never sets it). */
export type StackTracePicker = <T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions) => Promise<T | undefined>;

export interface StackTraceEngine {
  resolveFrame(req: ResolveFrameRequest): Promise<ResolveFrameOutcome>;
}

/** Status of a frame from its parse and its workspace file match (pure apart from the types). */
export function frameStatus(f: StackFrame, r: PathResolution | undefined): FrameStatus {
  if (f.external) return 'external';
  if (r && (r.kind === 'exact' || r.kind === 'unique')) return 'user';
  if (r && r.kind === 'ambiguous') return 'ambiguous';
  return f.language === 'dotnet' && f.typeName && f.methodName ? 'bySymbol' : 'missing';
}

export class StackTraceViewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private parsed: ParsedTrace = { groups: [], frameCount: 0 };
  private entries: FrameEntry[] = [];
  private roots: Node[] = [];
  private view: vscode.TreeView<Node> | undefined;
  /** e2e: the last notice shown (line may have moved, likely match). */
  lastNotice: string | undefined;
  testPicker: StackTracePicker | undefined;

  constructor(private readonly engine: StackTraceEngine) {}

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
  }

  dispose(): void {
    this.changed.dispose();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = undefined;
    flashType?.dispose();
    flashType = undefined;
  }

  /** e2e: the line the last opened frame highlighted. */
  lastHighlight(): { uri: string; line: number } | undefined {
    return lastFlash;
  }

  /** Parses the text and matches the frames' files to workspace files. Returns the number of frames found. */
  async load(text: string): Promise<ParsedTrace> {
    this.parsed = parseStackTrace(text);
    const entries: FrameEntry[] = [];
    for (const group of this.parsed.groups) group.frames.forEach((frame, i) => entries.push({ id: entries.length, frame, group, indexInGroup: i, status: 'missing' }));
    await this.matchFiles(entries);
    for (const e of entries) e.status = frameStatus(e.frame, e.resolution);
    this.entries = entries;
    this.roots = this.parsed.groups.map((group) => ({ kind: 'group', group, entries: entries.filter((e) => e.group === group) }) as Node);
    void vscode.commands.executeCommand('setContext', 'refyntra.stackTraceLoaded', this.parsed.frameCount > 0);
    if (this.view) this.view.description = this.parsed.frameCount ? `${this.parsed.frameCount} ${this.parsed.frameCount === 1 ? 'frame' : 'frames'}` : undefined;
    this.changed.fire(undefined);
    return this.parsed;
  }

  frames(): ReadonlyArray<{ id: number; frame: StackFrame; status: FrameStatus; matches: string[] }> {
    return this.entries.map((e) => ({ id: e.id, frame: e.frame, status: e.status, matches: e.resolution?.matches.map((m) => m.path) ?? [] }));
  }

  private async matchFiles(entries: FrameEntry[]): Promise<void> {
    const rule = caseRuleFor(process.platform);
    const byBase = new Map<string, string[]>();
    for (const e of entries) {
      const f = e.frame.file;
      if (!f || e.frame.external) continue;
      const base = basenameOf(f);
      if (!base || byBase.has(base)) continue;
      byBase.set(base, []);
    }
    await Promise.all(
      [...byBase.keys()].map(async (base) => {
        try {
          const uris = await vscode.workspace.findFiles(`**/${escapeGlob(base)}`, EXCLUDE, 500);
          byBase.set(base, uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath));
        } catch {
          /* no workspace folder: nothing to match */
        }
      }),
    );
    for (const e of entries) {
      const f = e.frame.file;
      if (!f || e.frame.external) continue;
      const candidates = [...(byBase.get(basenameOf(f)) ?? [])];
      // The printed path itself when it exists on this machine (a local build) — even outside the workspace folders.
      if (path.isAbsolute(f) && (await exists(f))) candidates.unshift(f);
      e.resolution = matchFramePath(f, candidates, rule);
    }
  }

  // ---------------------------------------------------------------- tree

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots;
    if (node.kind === 'external') return node.entries.map((entry) => ({ kind: 'frame', entry }));
    if (node.kind !== 'group') return [];
    // Runs of two or more external frames collapse into one node.
    const out: Node[] = [];
    let run: FrameEntry[] = [];
    const flush = () => {
      if (run.length === 1) out.push({ kind: 'frame', entry: run[0]! });
      else if (run.length > 1) out.push({ kind: 'external', entries: run });
      run = [];
    };
    for (const e of node.entries) {
      if (e.status === 'external') run.push(e);
      else {
        flush();
        out.push({ kind: 'frame', entry: e });
      }
    }
    flush();
    return out;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(groupLabel(node.group), vscode.TreeItemCollapsibleState.Expanded);
      item.description = [node.group.depth > 0 ? 'inner exception' : undefined, `${node.entries.length} ${node.entries.length === 1 ? 'frame' : 'frames'}`].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon(node.group.depth > 0 ? 'debug-stackframe-dot' : 'error');
      item.accessibilityInformation = { label: groupAccessibleLabelFor(node.group, node.entries.length) };
      item.tooltip = groupLabel(node.group);
      item.contextValue = 'refyntra.stackGroup';
      return item;
    }
    if (node.kind === 'external') {
      const label = `${node.entries.length} external frames`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = 'framework or package code';
      item.iconPath = new vscode.ThemeIcon('library');
      item.accessibilityInformation = { label: `${label}, framework or package code, collapsed` };
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.frame.function, vscode.TreeItemCollapsibleState.None);
    item.description = frameDescription(e.frame, e.status);
    // Own code stands out (stack frame colour); package/framework frames are a library icon.
    item.iconPath = new vscode.ThemeIcon(FRAME_ICON[e.status], e.status === 'user' || e.status === 'bySymbol' ? new vscode.ThemeColor('debugIcon.breakpointCurrentStackframeForeground') : undefined);
    item.accessibilityInformation = { label: frameAccessibleLabel(e.frame, { index: e.indexInGroup, count: e.group.frames.length, status: e.status }) };
    item.tooltip = new vscode.MarkdownString().appendCodeblock(e.frame.raw, 'text');
    item.contextValue = e.status === 'external' && !e.frame.file ? 'refyntra.stackFrame.external' : 'refyntra.stackFrame';
    item.command = { command: 'refyntra.stackTrace.openFrame', title: 'Open Frame', arguments: [e.id] };
    return item;
  }

  // ---------------------------------------------------------------- open

  private async pick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T | undefined> {
    return this.testPicker ? this.testPicker(items, options) : vscode.window.showQuickPick(items, options);
  }

  private notice(text: string): void {
    this.lastNotice = text;
    void vscode.window.showWarningMessage(`Refyntra: ${text}`);
  }

  /** Opens a frame (by id or the tree node): its file at the line, or the symbol the backend finds. */
  async openFrame(arg: number | Node | undefined): Promise<OpenFrameResult> {
    const entry = typeof arg === 'number' ? this.entries[arg] : arg && arg.kind === 'frame' ? arg.entry : undefined;
    if (!entry) return { kind: 'none', message: 'No frame selected.' };
    this.lastNotice = undefined;
    const f = entry.frame;
    const r = entry.resolution;
    let file: string | undefined;
    if (r && (r.kind === 'exact' || r.kind === 'unique')) file = r.matches[0].path;
    else if (r && r.kind === 'ambiguous') {
      const choice = await this.pick(
        r.matches.map((m) => ({ label: vscode.workspace.asRelativePath(m.path, true), description: `${m.score} matching path ${m.score === 1 ? 'part' : 'parts'}`, path: m.path })),
        { title: `Several files match ${basenameOf(f.file!)}`, placeHolder: 'Choose the file this frame means' },
      );
      if (!choice) return { kind: 'cancelled' };
      file = choice.path;
    }
    if (file) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (!lineMayHaveMoved(f.line, doc.lineCount)) return this.show(doc, f.line, f.column);
      const moved = lineMovedNotice(file, f.line!, doc.lineCount);
      if (f.language === 'dotnet' && f.typeName && f.methodName) {
        const bySymbol = await this.openBySymbol(f, moved);
        if (bySymbol.kind !== 'none') return bySymbol;
      }
      this.notice(moved);
      const opened = await this.show(doc, doc.lineCount, undefined);
      return opened.kind === 'opened' ? { ...opened, notice: moved } : opened;
    }
    if (f.language === 'dotnet' && f.typeName && f.methodName) return this.openBySymbol(f, undefined);
    const message = f.file ? `${basenameOf(f.file)} was not found in the workspace.` : `The frame ${f.function} names no file.`;
    void vscode.window.showInformationMessage(`Refyntra: ${message}`);
    return { kind: 'none', message };
  }

  private async show(doc: vscode.TextDocument, line: number | undefined, column: number | undefined): Promise<OpenFrameResult> {
    const l = Math.min(Math.max(0, (line ?? 1) - 1), Math.max(0, doc.lineCount - 1));
    const text = doc.lineAt(l).text;
    const c = column !== undefined ? Math.min(Math.max(0, column - 1), text.length) : text.length - text.trimStart().length;
    const pos = new vscode.Position(l, c);
    const ed = await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    flashLine(ed, l);
    return { kind: 'opened', uri: doc.uri.toString(), line: l + 1 };
  }

  private async openBySymbol(f: StackFrame, movedNotice: string | undefined): Promise<OpenFrameResult> {
    const req: ResolveFrameRequest = {
      typeName: f.typeName!,
      methodName: f.methodName!,
      ...(f.localFunctionName ? { localFunctionName: f.localFunctionName } : {}),
      ...(f.methodArity !== undefined ? { methodArity: f.methodArity } : {}),
      ...(f.parameterTypes ? { parameterTypes: f.parameterTypes } : {}),
    };
    const out = await this.engine.resolveFrame(req);
    if (out.kind === 'unavailable') {
      const message = `Refyntra could not look up ${f.function} by symbol: ${out.message || describeReason(out.reasonCode)}`;
      void vscode.window.showWarningMessage(message);
      return { kind: 'none', message };
    }
    if (out.candidates.length === 0) {
      const message = `No source for ${f.function} was found in the loaded solution. It may have been removed or renamed, or come from a package; Refyntra does not recover missing symbols.`;
      void vscode.window.showInformationMessage(`Refyntra: ${message}`);
      return { kind: 'none', message };
    }
    let chosen: FrameCandidate | undefined = out.candidates.length === 1 ? out.candidates[0] : undefined;
    if (!chosen) {
      const items = out.candidates.map((c) => ({
        label: c.symbol.displayName,
        description: [CONFIDENCE_PHRASE[c.confidence], c.symbol.projectName, shortPath(c.location.uri)].filter(Boolean).join(' · '),
        detail: c.reason,
        candidate: c,
      }));
      const choice = await this.pick(items, { title: `Several symbols match ${f.function}`, placeHolder: 'Choose the method this frame means', matchOnDescription: true });
      if (!choice) return { kind: 'cancelled' };
      chosen = choice.candidate;
    }
    const loc = fromLocation(chosen.location);
    if (loc.uri.scheme !== 'file') return { kind: 'none', message: 'The backend returned a non-file location.' };
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const ed = await vscode.window.showTextDocument(doc, { selection: new vscode.Range(loc.range.start, loc.range.start), preview: true });
    flashLine(ed, loc.range.start.line);
    const notes = [movedNotice, chosen.confidence === 'likely' ? `${f.function} was matched by name only (likely, not proven): ${chosen.reason}` : undefined].filter((x): x is string => !!x);
    if (notes.length) this.notice(notes.join(' '));
    return { kind: 'opened', uri: doc.uri.toString(), line: loc.range.start.line + 1, confidence: chosen.confidence, ...(notes.length ? { notice: notes.join(' ') } : {}) };
  }

  /** "Related" on a frame: open it, then show Related for the code there. */
  async related(arg: number | Node | undefined): Promise<void> {
    const r = await this.openFrame(arg);
    if (r.kind === 'opened') await vscode.commands.executeCommand('refyntra.related');
  }

  clear(): void {
    void this.load('');
  }
}

/** How long the target line of an opened frame stays highlighted. */
export const FLASH_MS = 1500;
let flashType: vscode.TextEditorDecorationType | undefined;
let flashTimer: NodeJS.Timeout | undefined;
/** Last highlighted line (e2e checks it). */
export let lastFlash: { uri: string; line: number } | undefined;

/** Highlights one line briefly (whole line, also in the overview ruler); a later flash replaces it. Visual only. */
export function flashLine(editor: vscode.TextEditor, line: number): void {
  flashType ??= vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  const type = flashType;
  if (flashTimer) clearTimeout(flashTimer);
  for (const ed of vscode.window.visibleTextEditors) if (ed !== editor) ed.setDecorations(type, []);
  editor.setDecorations(type, [new vscode.Range(line, 0, line, 0)]);
  lastFlash = { uri: editor.document.uri.toString(), line };
  flashTimer = setTimeout(() => {
    flashTimer = undefined;
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(type, []);
  }, FLASH_MS);
}

const FRAME_ICON: Readonly<Record<FrameStatus, string>> = {
  user: 'debug-stackframe',
  external: 'library',
  ambiguous: 'files',
  missing: 'question',
  bySymbol: 'symbol-method',
};

function escapeGlob(s: string): string {
  return s.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}

interface SourceItem extends vscode.QuickPickItem {
  source: 'clipboard' | 'selection' | 'editor' | 'terminal' | 'paste';
}

/**
 * "Refyntra: Open Stack Trace". A string argument is the trace; from the terminal context menu the selection is
 * copied first. Otherwise a QuickPick offers the clipboard, the editor selection, the terminal selection or an empty
 * editor to paste into.
 */
export async function runOpenStackTrace(provider: StackTraceViewProvider, arg?: unknown): Promise<ParsedTrace | undefined> {
  let text: string | undefined;
  if (typeof arg === 'string') text = arg;
  else if (arg && typeof arg === 'object' && 'sendText' in arg) text = await terminalSelection();
  else {
    const editor = vscode.window.activeTextEditor;
    const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
    const clip = (await vscode.env.clipboard.readText()).trim();
    const items: SourceItem[] = [];
    if (selection) items.push({ label: '$(selection) Editor selection', description: firstLine(selection), source: 'selection' });
    if (clip) items.push({ label: '$(clippy) Clipboard', description: firstLine(clip), source: 'clipboard' });
    if (editor && !selection && editor.document.lineCount > 1) items.push({ label: '$(file) Whole active editor', description: vscode.workspace.asRelativePath(editor.document.uri, false), source: 'editor' });
    if (vscode.window.activeTerminal) items.push({ label: '$(terminal) Terminal selection', description: 'copies the selection of the active terminal to the clipboard', source: 'terminal' });
    items.push({ label: '$(new-file) Paste into a new editor', description: 'then run Open Stack Trace again and choose Whole active editor', source: 'paste' });
    const pick = await (provider.testPicker ?? vscode.window.showQuickPick)(items, { title: 'Refyntra: Open Stack Trace', placeHolder: 'Where is the stack trace? (Debug Console: copy it first, then choose Clipboard)' });
    if (!pick) return undefined;
    if (pick.source === 'paste') {
      const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: '' });
      await vscode.window.showTextDocument(doc);
      return undefined;
    }
    text = pick.source === 'selection' ? selection : pick.source === 'clipboard' ? clip : pick.source === 'editor' ? editor?.document.getText() : await terminalSelection();
  }
  if (!text?.trim()) {
    void vscode.window.showInformationMessage('Refyntra: there is no text to read a stack trace from.');
    return undefined;
  }
  const parsed = await provider.load(text);
  await vscode.commands.executeCommand(`${STACK_TRACE_VIEW}.focus`);
  if (parsed.frameCount === 0) {
    void vscode.window.showInformationMessage('Refyntra: no stack frames were recognised. Supported: .NET (including Mono and Unity), JavaScript/TypeScript (V8, Firefox), Python and Rust.');
  }
  return parsed;
}

async function terminalSelection(): Promise<string | undefined> {
  if (!vscode.window.activeTerminal) return undefined;
  await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
  return vscode.env.clipboard.readText();
}

function firstLine(s: string): string {
  const l = s.trim().split(/\r?\n/)[0] ?? '';
  return l.length > 80 ? `${l.slice(0, 77)}...` : l;
}
