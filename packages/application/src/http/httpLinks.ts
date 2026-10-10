import type { EndpointInfo, HeuristicProvenance, Location, Position } from '@refyntra/contracts';
import { type AnyRelation, type FindItem, endpointLabel } from '@refyntra/domain';
import type { FrameworkAdapter, FrameworkRelatedInput, LanguageAdapter } from '../adapters';
import { type CancellationToken, raceCancellation, throwIfCancelled } from '../cancellation';
import { type ClientCall, scanClientCalls } from './clientCalls';
import { type CallMatch, endpointKey, matchCall } from './routeMatch';

// Frontend ↔ backend HTTP linking (heuristic). Client call sites in TS/JS files (clientCalls.ts) are matched to the
// ASP.NET endpoints of the C# route (the existing `code/search` endpoint listing, route filter ""). Related shows the
// endpoint and its handler from a call site, and the "Clients" of an endpoint/action. No network, no runtime.

export const HTTP_LINKS_ROUTE_ID = 'http.links';
export const HTTP_HEURISTIC_LIMITATION =
  'Heuristic: matched by the literal URL text of the client call and the route template. Base URLs set at runtime, proxies, rewrites and gateways are not seen.';
const AMBIGUOUS_LIMITATION = (n: number) => `Ambiguous: ${n} routes match this call equally well.`;
const METHOD_UNKNOWN_LIMITATION = 'The HTTP method of the call is not a literal; every method was accepted.';
const BASE_LIMITATION = (b: string) => `Matched after removing the base path ${b} (refyntra.http.basePaths).`;

/** Lists and reads the TS/JS files of the workspace (bounded, excludes applied by the implementation). */
export interface ClientSourcePort {
  /** File URIs to scan (the implementation applies files.exclude/search.exclude and skips dependency/output folders). */
  listFiles(token?: CancellationToken): Promise<readonly string[]>;
  /** File text, or undefined when unreadable or larger than the size limit. */
  readFile(uri: string, token?: CancellationToken): Promise<string | undefined>;
}

export interface HttpLinkSettings {
  basePaths(): readonly string[];
  origins(): readonly string[];
}

export interface HttpLinkOptions {
  /** The route that knows the ASP.NET endpoints (the C# route). */
  server: LanguageAdapter;
  /** Routes of the client files (the TS/JS route). */
  clientRouteIds: readonly string[];
  files: ClientSourcePort;
  settings: HttpLinkSettings;
  /** Current text of an open document (dirty edits included), when tracked. */
  documentText?: (uri: string) => string | undefined;
  /** Upper bound of scanned files. */
  maxFiles?: number;
  /** Upper bound of the text length of one file (larger files are skipped). */
  maxFileChars?: number;
}

export interface ClientCallEntry {
  uri: string;
  call: ClientCall;
}

export interface ClientCallReport extends ClientCallEntry {
  match: CallMatch;
}

const ENDPOINT_LIMIT = 5000;
const MAX_CLIENT_RELATIONS = 200;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_CHARS = 1_000_000;

function sameUri(a: string, b: string): boolean {
  return a === b || decodeSafe(a).toLowerCase() === decodeSafe(b).toLowerCase();
}
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function baseName(uri: string): string {
  return decodeSafe(uri.slice(uri.lastIndexOf('/') + 1));
}

/** Client call index of the workspace: scanned once on demand, kept current by fileChanged/fileDeleted. */
export class HttpClientIndex {
  private readonly byUri = new Map<string, ClientCall[]>();
  private scan: Promise<void> | undefined;
  private generation = 0;
  truncated = false;

  constructor(
    private readonly files: ClientSourcePort,
    private readonly maxFiles = DEFAULT_MAX_FILES,
    private readonly maxFileChars = DEFAULT_MAX_FILE_CHARS,
  ) {}

  /** Scans the workspace once (shared by concurrent callers); the caller's token only stops its own wait. */
  async ensureScanned(token?: CancellationToken): Promise<void> {
    if (!this.scan) {
      const gen = this.generation;
      this.scan = this.run(gen).catch((e) => {
        if (this.generation === gen) this.scan = undefined;
        throw e;
      });
    }
    return raceCancellation(this.scan, token);
  }

  private async run(gen: number): Promise<void> {
    const uris = await this.files.listFiles();
    if (gen !== this.generation) return;
    this.truncated = uris.length > this.maxFiles;
    for (const uri of uris.slice(0, this.maxFiles)) {
      if (gen !== this.generation) return;
      if (this.byUri.has(uri)) continue; // already updated by an editor event
      const text = await this.files.readFile(uri).catch(() => undefined);
      if (gen !== this.generation) return;
      if (text === undefined || text.length > this.maxFileChars) continue;
      this.byUri.set(uri, scanClientCalls(text));
    }
  }

  /** Incremental update (save/create/change on disk). */
  fileChanged(uri: string, text: string): void {
    if (text.length > this.maxFileChars) this.byUri.delete(uri);
    else this.byUri.set(uri, scanClientCalls(text));
  }

  fileDeleted(uri: string): void {
    this.byUri.delete(uri);
  }

  /** Drops everything; the next request rescans (settings or folders changed). */
  reset(): void {
    this.generation++;
    this.byUri.clear();
    this.scan = undefined;
    this.truncated = false;
  }

  entries(): ClientCallEntry[] {
    const out: ClientCallEntry[] = [];
    for (const [uri, calls] of [...this.byUri].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) for (const call of calls) out.push({ uri, call });
    return out;
  }
}

interface EndpointList {
  endpoints: EndpointInfo[];
  provenance: HeuristicProvenance;
}

function heuristicProvenance(sessionEpoch: string, snapshotId: string): HeuristicProvenance {
  return {
    kind: 'heuristic',
    providerRouteId: HTTP_LINKS_ROUTE_ID,
    sessionEpoch,
    snapshotId,
    projectContextId: 'unknown',
    basis: 'a literal client URL (fetch/axios/HttpClient) matched to an ASP.NET route template',
  };
}

function callLabel(call: ClientCall): string {
  return `${call.method ?? 'ANY'} ${call.url ? `${call.url.origin ?? ''}${call.url.path}` : call.raw || '(no URL)'}`;
}

function callLocation(uri: string, call: ClientCall): Location {
  return { uri, range: call.range };
}

function limitationsFor(call: ClientCall, m: CallMatch): string[] {
  return [
    HTTP_HEURISTIC_LIMITATION,
    ...(m.status === 'ambiguous' ? [AMBIGUOUS_LIMITATION(m.candidates.length)] : []),
    ...(call.method ? [] : [METHOD_UNKNOWN_LIMITATION]),
    ...(m.strippedBase ? [BASE_LIMITATION(m.strippedBase)] : []),
  ];
}

/** Read-only HTTP linking service; `frameworks()` are registered in the composition root. */
export class HttpLinkService {
  readonly index: HttpClientIndex;

  constructor(private readonly o: HttpLinkOptions) {
    this.index = new HttpClientIndex(o.files, o.maxFiles, o.maxFileChars);
  }

  /** Framework modules: on the client routes (call site → endpoint, handler) and on the server route (endpoint → clients). */
  frameworks(): FrameworkAdapter[] {
    const client: FrameworkAdapter & { relatedWithoutLanguage: NonNullable<FrameworkAdapter['relatedWithoutLanguage']> } = {
      descriptor: { frameworkId: 'http.client', displayName: 'HTTP links (heuristic)', providerRouteIds: this.o.clientRouteIds },
      related: (input) => (input.target ? this.callSiteRelations(input.target.uri, input.target.position, input.token) : Promise.resolve([])),
      relatedWithoutLanguage: (target, token) => this.callSiteRelations(target.uri, target.position, token),
    };
    const server: FrameworkAdapter = {
      descriptor: { frameworkId: 'http.server', displayName: 'HTTP links (heuristic)', providerRouteIds: [this.o.server.descriptor.providerRouteId] },
      related: (input) => this.clientRelations(input),
    };
    return [client, server];
  }

  private async endpoints(token?: CancellationToken): Promise<EndpointList> {
    const r = await this.o.server.search({ query: '', filters: { route: '' }, limit: ENDPOINT_LIMIT }, token);
    const endpoints = r.value.items.flatMap((i) => (i.endpoint && typeof i.endpoint.route === 'string' && i.endpoint.location ? [{ ...i.endpoint, httpMethods: i.endpoint.httpMethods ?? [] }] : []));
    return { endpoints, provenance: heuristicProvenance(r.sessionEpoch, r.snapshotId) };
  }

  private matchOptions() {
    return { basePaths: this.o.settings.basePaths(), origins: this.o.settings.origins() };
  }

  /** Calls on the cursor line (or spanning it) of a client document. */
  async callsAt(uri: string, position: Position, token?: CancellationToken): Promise<ClientCall[]> {
    const text = this.o.documentText?.(uri) ?? (await this.o.files.readFile(uri, token));
    throwIfCancelled(token);
    if (text === undefined) return [];
    return scanClientCalls(text).filter((c) => c.range.start.line <= position.line && position.line <= c.range.end.line);
  }

  /** Call site → endpoint(s) (group Endpoints) and their handlers (group Handlers). */
  async callSiteRelations(uri: string, position: Position, token?: CancellationToken): Promise<AnyRelation[]> {
    const calls = await this.callsAt(uri, position, token);
    if (calls.length === 0) return [];
    const { endpoints, provenance } = await this.endpoints(token);
    throwIfCancelled(token);
    const out: AnyRelation[] = [];
    for (const call of calls) {
      const m = matchCall(call, endpoints, this.matchOptions());
      if (m.status !== 'linked' && m.status !== 'ambiguous') continue;
      const loc = callLocation(uri, call);
      const limitations = limitationsFor(call, m);
      for (const e of m.candidates) {
        const evidence = [{ description: `${call.form} ${callLabel(call)} ${m.reason}`, location: loc }];
        out.push({
          relationKind: 'http.call',
          group: 'endpoints',
          target: { endpoint: e, label: `${endpointLabel(e)}${m.status === 'ambiguous' ? ' (ambiguous)' : ''}` },
          evidence,
          confidence: 'heuristic',
          provenance,
          limitations,
        });
        if (e.handler) {
          out.push({
            relationKind: 'http.handler',
            group: 'handlers',
            target: { symbol: e.handler, label: `${e.handler.displayName}${m.status === 'ambiguous' ? ' (ambiguous)' : ''}` },
            evidence: [...evidence, { description: `handler of ${endpointLabel(e)}`, location: e.location }],
            confidence: 'heuristic',
            provenance,
            limitations,
          });
        }
      }
    }
    return out;
  }

  /** Endpoint/action → its client call sites (group Clients). Uses the endpoints of the language result. */
  async clientRelations(input: FrameworkRelatedInput): Promise<AnyRelation[]> {
    const subjects = input.languageResult.value.relations.flatMap((r) => (r.relationKind === 'aspnet.endpoint' && r.target.endpoint ? [r.target.endpoint] : []));
    if (subjects.length === 0) return [];
    const reports = await this.reports(input.token);
    const wanted = new Map(subjects.map((e) => [endpointKey({ ...e, httpMethods: e.httpMethods ?? [] }), e]));
    const out: AnyRelation[] = [];
    for (const r of reports.items) {
      if (r.match.status !== 'linked' && r.match.status !== 'ambiguous') continue;
      const hit = r.match.candidates.find((c) => wanted.has(endpointKey(c)));
      if (!hit) continue;
      const loc = callLocation(r.uri, r.call);
      out.push({
        relationKind: 'http.call',
        group: 'clients',
        target: { location: loc, label: `${callLabel(r.call)} — ${baseName(r.uri)}:${r.call.range.start.line + 1}${r.match.status === 'ambiguous' ? ' (ambiguous)' : ''}` },
        evidence: [{ description: `${r.call.form} ${callLabel(r.call)} ${r.match.reason}`, location: loc }],
        confidence: 'heuristic',
        provenance: reports.provenance,
        limitations: limitationsFor(r.call, r.match),
      });
      if (out.length >= MAX_CLIENT_RELATIONS) break;
    }
    return out;
  }

  /** Every indexed client call with its match result (Find `client:`). */
  async reports(token?: CancellationToken): Promise<{ items: ClientCallReport[]; provenance: HeuristicProvenance; truncated: boolean }> {
    const [{ endpoints, provenance }] = await Promise.all([this.endpoints(token), this.index.ensureScanned(token)]);
    throwIfCancelled(token);
    const opts = this.matchOptions();
    const items = this.index.entries().map((e) => ({ ...e, match: matchCall(e.call, endpoints, opts) }));
    return { items, provenance, truncated: this.index.truncated };
  }

  /** Find `client:` (unlinked calls) or `client:all`; `text` filters by URL, form or file name. */
  async find(which: 'unlinked' | 'all', text: string, limit: number, token?: CancellationToken): Promise<{ items: FindItem[]; truncated: boolean }> {
    const r = await this.reports(token);
    const needle = text.trim().toLowerCase();
    const items: FindItem[] = [];
    for (const rep of r.items) {
      if (which === 'unlinked' && rep.match.status === 'linked') continue;
      const label = callLabel(rep.call);
      const file = baseName(rep.uri);
      if (needle && !`${label} ${rep.call.form} ${rep.call.raw} ${file}`.toLowerCase().includes(needle)) continue;
      const loc = callLocation(rep.uri, rep.call);
      items.push({
        key: `client|${rep.uri}|${rep.call.range.start.line}:${rep.call.range.start.character}`,
        kind: 'client',
        label,
        description: `Client call (heuristic) · ${STATUS_PHRASE[rep.match.status]}`,
        detail: `${rep.call.form} · ${rep.match.reason}`,
        location: loc,
        score: 50,
        providerRouteId: HTTP_LINKS_ROUTE_ID,
        provenances: [r.provenance],
      });
    }
    return { items: items.slice(0, limit), truncated: r.truncated || items.length > limit };
  }

  /** Same-document lookup by URI (tests and diagnostics). */
  callsIn(uri: string): ClientCall[] {
    return this.index.entries().filter((e) => sameUri(e.uri, uri)).map((e) => e.call);
  }
}

export const STATUS_PHRASE: Readonly<Record<CallMatch['status'], string>> = {
  linked: 'linked',
  ambiguous: 'ambiguous',
  unmatched: 'no matching route',
  unresolved: 'URL not resolvable',
  otherOrigin: 'another host',
};
