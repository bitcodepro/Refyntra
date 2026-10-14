import * as vscode from 'vscode';
import { CancelledError, type EngineClient, type MetadataSourceRequest } from '@refyntra/application';
import type { MetadataDocument, SymbolRef } from '@refyntra/contracts';
import { type MergedRelation, relationLocation } from '@refyntra/domain';
import { fromRange, openLocation, toPosition } from './convert';
import { METADATA_SCHEME, MetadataDocumentStore, metadataAction, metadataDocumentRef, metadataHealthText, metadataHoverMarkdown, originLine, sourcePolicy } from './metadataModel';

/** What opening a metadata target did (test API and callers that report it). */
export type MetadataOpenResult =
  | { kind: 'document'; uri: string; line: number; origin: MetadataDocument['origin'] }
  | { kind: 'location'; uri: string; line: number }
  | { kind: 'none'; message: string };

/**
 * Go to metadata / decompiled sources (protocol 1.17): read-only `refyntra-metadata:` documents with the decompiled
 * (or PDB-embedded) C# of a referenced type, opened from Refyntra's own navigation entry points and the
 * "Go to Metadata / Decompiled Source" command. Refyntra registers no Definition provider: F12 in these documents is
 * a Refyntra key binding, hover is a Refyntra hover for this scheme only.
 */
export class MetadataService implements vscode.TextDocumentContentProvider, vscode.HoverProvider {
  readonly store = new MetadataDocumentStore();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  /** The decompiler the host reported last ("" until the first answer). */
  decompilerVersion = '';
  opened = 0;
  lastError: string | undefined;

  constructor(private readonly engine: EngineClient) {}

  private policy() {
    return sourcePolicy(vscode.workspace.getConfiguration('refyntra').get('metadata.sourceLink'));
  }

  /** Content for a URI: from this window's store, else asked again by its type (a restored editor after a reload). */
  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const key = uri.toString();
    const known = this.store.get(key);
    if (known) return known.text;
    const ref = metadataDocumentRef(key);
    if (!ref || !this.engine.metadataSource) return '// Not a Refyntra metadata document.\n';
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const o = await this.engine.metadataSource({ documentationId: ref.documentationId, assemblyName: ref.assemblyName, sourcePolicy: this.policy() }, source.token);
      if (o.kind === 'metadata' && o.result.document) {
        this.decompilerVersion = o.result.decompilerVersion || this.decompilerVersion;
        this.store.set(key, o.result.document);
        return o.result.document.text;
      }
      return `// Refyntra: ${o.kind === 'metadata' ? (o.result.message ?? 'no decompiled source is available') : o.message}\n`;
    } catch (e) {
      return `// Refyntra: ${e instanceof Error ? e.message : String(e)}\n`;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }

  /** Asks the host and opens the answer: a metadata document, a solution file (source symbol) or a message. */
  async open(params: MetadataSourceRequest, what: string, options: { preserveFocus?: boolean; quiet?: boolean } = {}): Promise<MetadataOpenResult> {
    if (!this.engine.metadataSource) return this.say({ kind: 'none', message: 'Refyntra Go to Metadata is not available.' }, options);
    const cts = new vscode.CancellationTokenSource();
    let outcome;
    try {
      outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: decompiling…' }, () =>
        this.engine.metadataSource!({ ...params, sourcePolicy: this.policy() }, cts.token),
      );
    } catch (e) {
      if (e instanceof CancelledError) return { kind: 'none', message: 'cancelled' };
      this.lastError = e instanceof Error ? e.message : String(e);
      return this.say({ kind: 'none', message: `Refyntra Go to Metadata (${what}): ${this.lastError}` }, options);
    } finally {
      cts.dispose();
    }
    if (outcome.kind === 'unavailable') {
      this.lastError = outcome.message;
      return this.say({ kind: 'none', message: `Refyntra Go to Metadata (${what}): ${outcome.message}` }, options);
    }
    this.decompilerVersion = outcome.result.decompilerVersion || this.decompilerVersion;
    const action = metadataAction(outcome.result, what);
    if (action.kind === 'message') {
      if (action.severity === 'warning') this.lastError = action.text;
      return this.say({ kind: 'none', message: action.text }, options, action.severity);
    }
    if (action.kind === 'location') {
      await openLocation({ uri: action.uri, range: action.range }, options.preserveFocus);
      return { kind: 'location', uri: action.uri, line: action.range.start.line };
    }
    const uri = vscode.Uri.parse(action.uri, true);
    const key = uri.toString();
    const before = this.store.get(key);
    this.store.set(key, action.document);
    if (before && before.text !== action.document.text) this.changed.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'csharp') await vscode.languages.setTextDocumentLanguage(doc, 'csharp');
    const selection = action.selection ? fromRange(action.selection) : new vscode.Range(0, 0, 0, 0);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: !!options.preserveFocus, selection: new vscode.Range(selection.start, selection.end) });
    this.opened++;
    this.lastError = undefined;
    return { kind: 'document', uri: key, line: selection.start.line, origin: action.document.origin };
  }

  private say(r: MetadataOpenResult & { kind: 'none' }, options: { quiet?: boolean }, severity: 'info' | 'warning' = 'warning'): MetadataOpenResult {
    if (!options.quiet) void (severity === 'info' ? vscode.window.showInformationMessage(r.message) : vscode.window.showWarningMessage(r.message));
    return r;
  }

  /** A symbol from a Refyntra result: its source, or its decompiled declaration. */
  openSymbol(symbol: SymbolRef, what: string): Promise<MetadataOpenResult> {
    if (symbol.location && symbol.origin !== 'metadata') {
      return openLocation(symbol.location).then(() => ({ kind: 'location' as const, uri: symbol.location!.uri, line: symbol.location!.range.start.line }));
    }
    if (!symbol.symbolId) return Promise.resolve(this.say({ kind: 'none', message: `Refyntra Go to Metadata (${what}): ${symbol.displayName} has no symbol id.` }, {}));
    return this.open({ symbolId: symbol.symbolId }, what);
  }

  /** The command at the cursor: in a C# file of the solution, or inside a metadata document (go to its definition). */
  async goToAtCursor(): Promise<MetadataOpenResult> {
    const ed = vscode.window.activeTextEditor;
    const ref = ed ? metadataDocumentRef(ed.document.uri.toString()) : undefined;
    if (ed && ref) return this.open({ document: ref, position: toPosition(ed.selection.active) }, 'at the cursor');
    if (!ed || ed.document.languageId !== 'csharp' || ed.document.uri.scheme !== 'file') {
      return this.say({ kind: 'none', message: 'Refyntra Go to Metadata: place the cursor on a symbol in a C# file.' }, {}, 'info');
    }
    return this.open({ uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) }, 'at the cursor');
  }

  async provideHover(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const ref = metadataDocumentRef(doc.uri.toString());
    if (!ref || !this.engine.metadataSource) return undefined;
    const range = doc.getWordRangeAtPosition(position, /@?[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) return undefined;
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    try {
      const o = await this.engine.metadataSource({ document: ref, position: toPosition(position), symbolOnly: true, sourcePolicy: this.policy() }, source.token);
      if (o.kind !== 'metadata' || !o.result.symbol || token.isCancellationRequested) return undefined;
      return new vscode.Hover(new vscode.MarkdownString(metadataHoverMarkdown(o.result.symbol, o.result.summary)), range);
    } catch {
      return undefined;
    } finally {
      sub.dispose();
      source.dispose();
    }
  }

  /** Health: the decompiler, the source policy and this window's documents, in one paragraph. */
  healthText(): string {
    return metadataHealthText({ decompilerVersion: this.decompilerVersion, policy: this.policy(), documents: this.store.size, ...(this.lastError ? { lastError: this.lastError } : {}) });
  }

  /** The origin line of an open metadata document (tests and the status tooltip). */
  describe(uri: string): string | undefined {
    const d = this.store.get(uri);
    return d ? originLine(d, this.decompilerVersion) : undefined;
  }
}

let active: MetadataService | undefined;

/** The window's metadata service (undefined before activation); navigation entry points open library symbols with it. */
export function metadataService(): MetadataService | undefined {
  return active;
}

/** Opens a relation target: its source location, or the decompiled declaration of a library symbol. */
export async function openRelationTarget(r: MergedRelation): Promise<void> {
  const loc = relationLocation(r);
  if (loc) return openLocation(loc);
  const s = r.target.symbol;
  if (s && s.origin === 'metadata' && s.symbolId && active) await active.openSymbol(s, 'Related');
}

export function registerMetadata(engine: EngineClient): { service: MetadataService; disposable: vscode.Disposable } {
  const service = new MetadataService(engine);
  active = service;
  const status = vscode.window.createStatusBarItem('refyntra.metadataOrigin', vscode.StatusBarAlignment.Right, 90);
  status.name = 'Refyntra: Decompiled Source';
  const update = (ed: vscode.TextEditor | undefined) => {
    const line = ed && ed.document.uri.scheme === METADATA_SCHEME ? service.describe(ed.document.uri.toString()) : undefined;
    void vscode.commands.executeCommand('setContext', 'refyntra.metadataDocument', !!(ed && ed.document.uri.scheme === METADATA_SCHEME));
    if (!line) {
      status.hide();
      return;
    }
    const d = service.store.get(ed!.document.uri.toString())!;
    status.text = d.origin === 'embeddedSource' ? '$(file-code) Embedded source' : '$(file-binary) Decompiled';
    status.tooltip = `${d.assemblyName} ${d.assemblyVersion}\n${line}`;
    status.show();
  };
  const disposable = vscode.Disposable.from(
    { dispose: () => (active = active === service ? undefined : active) },
    status,
    vscode.workspace.registerTextDocumentContentProvider(METADATA_SCHEME, service),
    vscode.languages.registerHoverProvider({ scheme: METADATA_SCHEME }, service),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (d.uri.scheme === METADATA_SCHEME && d.languageId !== 'csharp') void vscode.languages.setTextDocumentLanguage(d, 'csharp');
      if (vscode.window.activeTextEditor?.document === d) update(vscode.window.activeTextEditor);
    }),
    vscode.commands.registerCommand('refyntra.goToMetadata', async () => {
      const r = await service.goToAtCursor();
      update(vscode.window.activeTextEditor);
      return r;
    }),
    vscode.commands.registerCommand('refyntra.openMetadata', async (args: { documentationId: string; assemblyName?: string; memberName?: string } | undefined) => {
      if (!args || typeof args.documentationId !== 'string') return undefined;
      const r = await service.open({ documentationId: args.documentationId, ...(args.assemblyName ? { assemblyName: args.assemblyName } : {}), ...(args.memberName ? { memberName: args.memberName } : {}) }, args.documentationId.slice(2));
      update(vscode.window.activeTextEditor);
      return r;
    }),
  );
  return { service, disposable };
}
