import type { EndpointInfo, HeuristicProvenance, OwnedProvenance, Position, Provenance, SymbolKind, SymbolRef } from '@refyntra/contracts';
import type { AnyRelation, FindItem } from '@refyntra/domain';
import { type CancellationToken, type FrameworkAdapter, RouteUnavailableError, raceCancellation, throwIfCancelled } from '@refyntra/application';
import type { DocumentSync, FileChange, InitializeResult, WebProjectInfo, WorkerEndpoint, WorkerFindItem, WorkerLocation, WorkerMethod, WorkerMethods, WorkerRelation, WorkerSymbol } from './protocol';
import { WEB_WORKER_PROTOCOL_VERSION } from './protocol';

// React, Next.js and Angular relations for the application: a framework module on the TS/JS route (and the HTML
// route, for Angular templates) plus Find `component:` / `page:`. All analysis happens in Refyntra's web worker
// process; this side only decides when it may run (trusted workspace with a web project), syncs unsaved editor text
// and converts the worker's answers. Pure: no node, no vscode (the process lives behind WorkerPort).

export const WEB_FRAMEWORKS_ID = 'web.frameworks';
export const WEB_FRAMEWORKS_DISPLAY = 'React / Next.js / Angular';

export interface WorkerPortEvents {
  onStart?(): void;
  onExit?(expected: boolean): void;
}

export interface WorkerPort {
  request<M extends WorkerMethod>(method: M, params: WorkerMethods[M][0]): Promise<WorkerMethods[M][1]>;
  readonly running: boolean;
  sessionEpoch(): string;
  onEvents(listener: WorkerPortEvents): void;
  stop(): Promise<void>;
  resetCrashes(): void;
}

export interface OpenDocument {
  uri: string;
  languageId: string;
  text: string;
  dirty: boolean;
}

export interface WebFrameworkOptions {
  port: WorkerPort;
  /** Workspace folder URIs (file:). */
  roots: () => readonly string[];
  isTrusted: () => boolean;
  /** Whether the workspace contains a React, Next.js or Angular project (the worker is never started otherwise). */
  hasWebProject: () => Promise<boolean>;
  openDocuments: () => readonly OpenDocument[];
  /** Language routes the module attaches to (TS/JS and, when present, the HTML route for Angular templates). */
  routeIds: readonly string[];
  /** Normalises URIs the worker returns to the editor's form. */
  normalizeUri?: (uri: string) => string;
  /** Current workspace revision (snapshot id of results). */
  revision?: () => number;
}

const SYNCED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'html']);
const SYNCED_EXTENSIONS = /\.(tsx?|jsx?|mts|cts|mjs|cjs|html?)$/i;
const MAX_SYNCED_DOCUMENTS = 50;

const SYMBOL_KIND: Readonly<Record<WorkerSymbol['kind'], SymbolKind>> = { class: 'class', function: 'method', property: 'property', variable: 'local', method: 'method', field: 'field', interface: 'interface', module: 'namespace' };

export class WebFrameworkService {
  private initializedEpoch: string | undefined;
  private projects: WebProjectInfo[] = [];
  private info: InitializeResult | undefined;
  /** Dirty text sent to the current worker process, per URI. */
  private readonly sent = new Map<string, string>();
  private detection: Promise<boolean> | undefined;

  constructor(private readonly o: WebFrameworkOptions) {
    o.port.onEvents({
      onStart: () => {
        this.initializedEpoch = undefined;
        this.sent.clear();
      },
      onExit: () => {
        this.initializedEpoch = undefined;
        this.sent.clear();
      },
    });
  }

  /** What the last initialize reported (Health / tests). */
  status(): { running: boolean; projects: WebProjectInfo[]; typescriptVersion?: string; angularLanguageServiceVersion?: string } {
    return { running: this.o.port.running, projects: [...this.projects], ...(this.info ? { typescriptVersion: this.info.typescriptVersion } : {}), ...(this.info?.angularLanguageServiceVersion ? { angularLanguageServiceVersion: this.info.angularLanguageServiceVersion } : {}) };
  }

  /** Forget the detection (workspace folders or package.json changed). */
  resetDetection(): void {
    this.detection = undefined;
  }

  private async ready(token?: CancellationToken): Promise<boolean> {
    if (!this.o.isTrusted()) throw new RouteUnavailableError('TrustRequired', `Restricted Mode — the web worker (TypeScript compiler, Angular language service) runs only in a trusted workspace.`);
    this.detection ??= this.o.hasWebProject();
    if (!(await raceCancellation(this.detection, token))) return false;
    if (this.initializedEpoch && this.initializedEpoch === this.o.port.sessionEpoch() && this.o.port.running) return true;
    const r = await raceCancellation(this.o.port.request('initialize', { protocolVersion: WEB_WORKER_PROTOCOL_VERSION, roots: [...this.o.roots()] }), token);
    if (r.protocolVersion !== WEB_WORKER_PROTOCOL_VERSION) throw new RouteUnavailableError('ProtocolMismatch', `the web worker speaks protocol ${r.protocolVersion}, expected ${WEB_WORKER_PROTOCOL_VERSION}. Reinstall Refyntra.`);
    this.info = r;
    this.projects = r.projects;
    this.initializedEpoch = this.o.port.sessionEpoch();
    this.sent.clear();
    return true;
  }

  /** Editor text of open documents that changed since the last request (and `null` for closed documents). */
  private documents(): DocumentSync[] {
    const out: DocumentSync[] = [];
    const now = new Map<string, string>();
    for (const d of this.o.openDocuments()) {
      // By language or by extension (without VS Code's language extensions a .tsx document is plain text).
      // Every open document, not only `dirty` ones: VS Code reports isDirty after the change event, so the editor text
      // is sent whenever it differs from what this worker process last received.
      if (!d.uri.startsWith('file:') || !(SYNCED_LANGUAGES.has(d.languageId) || SYNCED_EXTENSIONS.test(d.uri.split(/[?#]/)[0]!))) continue;
      if (now.size >= MAX_SYNCED_DOCUMENTS) break;
      now.set(d.uri, d.text);
    }
    for (const [uri, text] of now) if (this.sent.get(uri) !== text) out.push({ uri, text });
    for (const uri of this.sent.keys()) if (!now.has(uri)) out.push({ uri, text: null });
    this.sent.clear();
    for (const [uri, text] of now) this.sent.set(uri, text);
    return out;
  }

  private loc(l: WorkerLocation): { uri: string; range: WorkerLocation['range'] } {
    return { uri: this.o.normalizeUri ? this.o.normalizeUri(l.uri) : l.uri, range: l.range };
  }

  private provenance(confidence: WorkerRelation['confidence'], basis: string): Provenance {
    const epoch = this.o.port.sessionEpoch();
    const snapshotId = `rev-${this.o.revision?.() ?? 0}`;
    if (confidence === 'heuristic') return { kind: 'heuristic', providerRouteId: WEB_FRAMEWORKS_ID, sessionEpoch: epoch, snapshotId, projectContextId: 'unknown', basis } satisfies HeuristicProvenance;
    return { kind: 'owned-semantic', providerRouteId: WEB_FRAMEWORKS_ID, sessionEpoch: epoch, snapshotId, projectContextId: 'web' } satisfies OwnedProvenance;
  }

  private symbol(s: WorkerSymbol, provenance: Provenance): SymbolRef {
    return { name: s.name, displayName: s.containerName ? `${s.containerName}.${s.name}` : s.name, kind: SYMBOL_KIND[s.kind], ...(s.containerName ? { containerName: s.containerName } : {}), ...(s.location ? { location: this.loc(s.location) } : {}), origin: 'source', provenance };
  }

  private endpoint(e: WorkerEndpoint): EndpointInfo {
    return { httpMethods: e.httpMethods, route: e.route, routeIsDynamic: e.routeIsDynamic, location: this.loc(e.location), kind: e.kind };
  }

  toRelation(r: WorkerRelation): AnyRelation {
    const provenance = this.provenance(r.confidence, r.basis);
    return {
      relationKind: r.kind as AnyRelation['relationKind'],
      group: r.group,
      target: {
        label: r.label,
        ...(r.location ? { location: this.loc(r.location) } : {}),
        ...(r.symbol ? { symbol: this.symbol(r.symbol, provenance) } : {}),
        ...(r.endpoint ? { endpoint: this.endpoint(r.endpoint) } : {}),
      },
      evidence: [{ description: `Basis: ${r.basis}` }, ...r.evidence.map((e) => ({ description: e.description, ...(e.location ? { location: this.loc(e.location) } : {}) }))],
      confidence: r.confidence,
      provenance,
      limitations: r.limitations,
    };
  }

  /** Relations at a document position (empty when the workspace has no web project). */
  async relatedAt(uri: string, position: Position, token?: CancellationToken): Promise<{ relations: AnyRelation[]; notes: string[] }> {
    if (!uri.startsWith('file:') || !(await this.ready(token))) return { relations: [], notes: [] };
    const epoch = this.o.port.sessionEpoch();
    const r = await raceCancellation(this.o.port.request('related', { uri, position, documents: this.documents() }), token);
    throwIfCancelled(token);
    if (epoch !== this.o.port.sessionEpoch()) return { relations: [], notes: [] };
    return { relations: r.relations.map((x) => this.toRelation(x)), notes: r.notes };
  }

  /** Relations; a worker note without relations (e.g. an unsupported Angular major) becomes the module's note in Related. */
  private async relationsOrNote(uri: string, position: Position, token?: CancellationToken): Promise<AnyRelation[]> {
    const r = await this.relatedAt(uri, position, token);
    if (r.relations.length === 0 && r.notes.length > 0) throw new RouteUnavailableError('FrameworkNotSupported', r.notes.join(' '));
    return r.relations;
  }

  /** Find `component:` / `page:`. */
  async find(kind: 'component' | 'page', text: string, limit: number, token?: CancellationToken): Promise<{ items: FindItem[]; truncated: boolean; notes: string[] }> {
    if (!(await this.ready(token))) return { items: [], truncated: false, notes: [`${WEB_FRAMEWORKS_DISPLAY}: no React, Next.js or Angular project (package.json dependency) in the workspace.`] };
    const r = await raceCancellation(this.o.port.request('find', { kind, text, limit, documents: this.documents() }), token);
    return { items: r.items.map((i) => this.toFindItem(i)), truncated: r.truncated, notes: r.notes };
  }

  private toFindItem(i: WorkerFindItem): FindItem {
    const provenance = this.provenance(i.confidence, i.basis);
    const location = this.loc(i.location);
    const symbol = i.symbol ? this.symbol(i.symbol, provenance) : undefined;
    return {
      key: `${i.kind}|${location.uri}|${location.range.start.line}:${location.range.start.character}|${i.label}`,
      kind: i.kind === 'page' ? 'endpoint' : 'symbol',
      label: i.label,
      description: i.description,
      detail: i.detail,
      location,
      ...(symbol ? { symbol, symbolKind: symbol.kind } : {}),
      ...(i.endpoint ? { endpoint: this.endpoint(i.endpoint) } : {}),
      score: 0,
      providerRouteId: WEB_FRAMEWORKS_ID,
      provenances: [provenance],
    };
  }

  /** File changes from the editor's watcher; sent only while the worker runs (a new process scans anyway). */
  filesChanged(changes: readonly FileChange[]): void {
    if (changes.some((c) => /\/package\.json$/i.test(c.uri))) this.detection = undefined;
    if (!this.o.port.running || !this.initializedEpoch) return;
    void this.o.port.request('filesChanged', { changes: [...changes] }).catch(() => undefined);
  }

  async restart(): Promise<void> {
    this.o.port.resetCrashes();
    this.detection = undefined;
    await this.o.port.stop();
  }

  /** The framework module (Related on TS/JS files, and on HTML templates through the HTML route). */
  framework(): FrameworkAdapter {
    return {
      descriptor: { frameworkId: WEB_FRAMEWORKS_ID, displayName: WEB_FRAMEWORKS_DISPLAY, providerRouteIds: this.o.routeIds },
      related: async (input) => (input.target ? this.relationsOrNote(input.target.uri, input.target.position, input.token) : []),
      relatedWithoutLanguage: async (target, token) => this.relationsOrNote(target.uri, target.position, token),
    };
  }
}
