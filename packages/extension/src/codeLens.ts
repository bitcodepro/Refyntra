import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import { type CSharpDeclaration, type CodeLensSettings, type LensKind, type LensSummary, extraLensKinds, lensView, parseCodeLensSettings, scanCSharpDeclarations, summarize } from './codeLensModel';
import { fromLocation } from './convert';

class RefyntraLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    readonly uri: string,
    readonly version: number,
    readonly decl: CSharpDeclaration,
    readonly lensKind: LensKind,
  ) {
    super(range);
  }
}

interface DocCache {
  version: number;
  decls: CSharpDeclaration[];
  summaries: Map<string, Promise<LensSummary | undefined>>;
  /** Declarations whose extra lenses were already emitted (no further refresh needed). */
  emitted: Set<string>;
}

const declKey = (d: CSharpDeclaration) => `${d.line}:${d.character}`;

/**
 * CodeLens above C# types and methods: "N references · N implementations · N tests", MediatR "→ Handler: X" /
 * "← sent from N places", endpoints "GET /api/… · N frontend calls", EF Core "→ configuration · migrations".
 *
 * Cheap while typing: provideCodeLenses only scans the text (linear, cached per document version) and creates
 * unresolved lenses; the backend is asked in resolveCodeLens, i.e. only for lenses on screen, once per declaration and
 * document version (shared by all lenses of that declaration; the engine also caches Related per revision). Cancelled
 * with the request. Extra lenses (MediatR, endpoint, EF Core) appear after the main lens resolved and found them.
 */
export class RefyntraCodeLensProvider implements vscode.CodeLensProvider<RefyntraLens>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly docs = new Map<string, DocCache>();
  private readonly subs: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  /** Scan durations (ms) of the last documents, for the performance note and tests. */
  readonly scanTimes: number[] = [];

  constructor(private readonly engine: EngineClient) {
    this.subs.push(
      engine.onDidInvalidate(() => {
        this.docs.clear();
        this.changed.fire();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.docs.delete(d.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('refyntra.codeLens')) this.changed.fire();
      }),
    );
  }

  private settings(): CodeLensSettings {
    const c = vscode.workspace.getConfiguration('refyntra');
    return parseCodeLensSettings((k, f) => c.get<boolean>(k, f));
  }

  private cacheFor(doc: vscode.TextDocument): DocCache {
    const uri = doc.uri.toString();
    let c = this.docs.get(uri);
    if (!c || c.version !== doc.version) {
      const t0 = performance.now();
      const decls = scanCSharpDeclarations(doc.getText());
      this.scanTimes.push(performance.now() - t0);
      if (this.scanTimes.length > 50) this.scanTimes.shift();
      c = { version: doc.version, decls, summaries: new Map(), emitted: new Set() };
      this.docs.set(uri, c);
    }
    return c;
  }

  provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): RefyntraLens[] {
    const s = this.settings();
    if (!s.enabled || doc.uri.scheme !== 'file' || doc.languageId !== 'csharp' || !this.engine.handlesDocument(doc.uri.toString(), doc.languageId)) return [];
    if (token.isCancellationRequested) return [];
    const c = this.cacheFor(doc);
    const uri = doc.uri.toString();
    const out: RefyntraLens[] = [];
    for (const d of c.decls) {
      const range = new vscode.Range(d.line, d.character, d.line, d.character + d.name.length);
      out.push(new RefyntraLens(range, uri, c.version, d, 'main'));
      if (c.emitted.has(declKey(d))) {
        const known = this.knownSummary(c, d);
        for (const k of known ? extraLensKinds(known, s) : []) out.push(new RefyntraLens(range, uri, c.version, d, k));
      }
    }
    return out;
  }

  private readonly settled = new Map<string, LensSummary | undefined>();

  private knownSummary(c: DocCache, d: CSharpDeclaration): LensSummary | undefined {
    return this.settled.get(`${c.version}#${declKey(d)}`);
  }

  async resolveCodeLens(lens: RefyntraLens, token: vscode.CancellationToken): Promise<RefyntraLens> {
    const s = this.settings();
    const summary = await this.summary(lens, token);
    if (!summary) {
      lens.command = { title: 'Refyntra: not available yet', command: 'refyntra.showHealth', tooltip: 'The C# analysis is not ready or the request was cancelled.' };
      return lens;
    }
    let kind = lens.lensKind;
    if (kind === 'main' && !s.references) {
      kind = extraLensKinds(summary, s)[0] ?? 'main';
    }
    if (kind === 'main' && !s.references) {
      lens.command = { title: 'Related', command: 'refyntra.related', tooltip: 'Open the Refyntra Related view' };
      return lens;
    }
    const v = lensView(kind, summary, lens.decl);
    const pos = new vscode.Position(lens.decl.line, lens.decl.character);
    lens.command = v.locations.length
      ? { title: v.title, tooltip: v.tooltip, command: 'editor.action.peekLocations', arguments: [vscode.Uri.parse(lens.uri, true), pos, v.locations.map(fromLocation), 'peek'] }
      : { title: v.title, tooltip: `${v.tooltip} Opens the Related view.`, command: 'refyntra.codeLens.related', arguments: [lens.uri, { line: pos.line, character: pos.character }] };
    return lens;
  }

  private summary(lens: RefyntraLens, token: vscode.CancellationToken): Promise<LensSummary | undefined> {
    const c = this.docs.get(lens.uri);
    if (!c || c.version !== lens.version) return Promise.resolve(undefined);
    const key = declKey(lens.decl);
    let p = c.summaries.get(key);
    if (!p) {
      const source = new vscode.CancellationTokenSource();
      const sub = token.onCancellationRequested(() => source.cancel());
      p = this.engine
        .related({ uri: lens.uri, position: { line: lens.decl.line, character: lens.decl.character } }, source.token)
        .then(async (o) => {
          if (o.kind !== 'related') return undefined;
          const s = summarize(!!o.subject, o.groups.flatMap((g) => g.relations));
          // A handler's "sent from" places are relations of its request type: one more Related request, only for handlers.
          if (s.isHandler && s.sends.length === 0 && s.requests[0] && this.settings().mediatr) {
            const req = s.requests[0];
            const r = await this.engine.related({ uri: req.uri, position: req.range.start }, source.token);
            if (r.kind === 'related') s.sends = summarize(true, r.groups.flatMap((g) => g.relations)).sends;
          }
          return s;
        })
        .catch(() => undefined)
        .finally(() => {
          sub.dispose();
          source.dispose();
        });
      c.summaries.set(key, p);
      void p.then((sum) => {
        // A cancelled or failed request is asked again next time.
        if (!sum) {
          if (c.summaries.get(key) === p) c.summaries.delete(key);
          return;
        }
        this.settled.set(`${c.version}#${key}`, sum);
        if (this.settled.size > 5000) this.settled.clear();
        if (!c.emitted.has(key) && extraLensKinds(sum, this.settings()).length > 0) {
          c.emitted.add(key);
          this.scheduleRefresh();
        }
      });
    }
    return p;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changed.fire();
    }, 150);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
    this.docs.clear();
  }
}

export function registerCodeLens(engine: EngineClient): { provider: RefyntraCodeLensProvider; disposable: vscode.Disposable } {
  const provider = new RefyntraCodeLensProvider(engine);
  const disposable = vscode.Disposable.from(
    provider,
    vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'csharp' }, provider),
    vscode.commands.registerCommand('refyntra.codeLens.related', async (uri: unknown, pos: unknown) => {
      if (typeof uri !== 'string' || !pos || typeof pos !== 'object') return;
      const p = pos as { line?: unknown; character?: unknown };
      if (typeof p.line !== 'number' || typeof p.character !== 'number') return;
      const target = vscode.Uri.parse(uri, true);
      if (target.scheme !== 'file') return;
      const ed = await vscode.window.showTextDocument(target, { preserveFocus: false });
      const at = new vscode.Position(p.line, p.character);
      ed.selection = new vscode.Selection(at, at);
      await vscode.commands.executeCommand('refyntra.related');
    }),
  );
  return { provider, disposable };
}
