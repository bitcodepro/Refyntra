import { createHash } from 'node:crypto';
import type {
  Availability,
  BarrierResult,
  EngineStatus,
  InitializeResult,
  Location,
  PlannedTextChange,
  Position,
  PrepareResult,
  RefactorPlanDto,
  Relation,
  RelatedResult,
  RevalidateResult,
  SearchItem,
  SearchResult,
  SymbolRef,
} from '@refyntra/contracts';
import { ErrorCodes, PROTOCOL_MAJOR, PROTOCOL_MINOR } from '@refyntra/contracts';
import { type CancellationToken, CancelledError, RpcError } from '@refyntra/application';

/**
 * Artificial ".fixture" language. Not a compiler and not an imitation of C#:
 *   symbol Name            declares a symbol
 *   relate A -> B          A has an "implementation" relation to B
 * Any other whole-word occurrence of a declared name is a reference. The only action is a text-only rename.
 */

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Shared "disk" of a fixture workspace; survives engine restarts like a real file system. */
export class FixtureWorld {
  readonly files = new Map<string, string>();
  /** Incremented for every engine process started (epoch source). */
  engineStarts = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [uri, text] of Object.entries(files)) this.files.set(uri, text);
  }
}

interface Declaration {
  name: string;
  uri: string;
  line: number;
  character: number;
}

export interface FixtureEngineOptions {
  routeId: string;
  languageId: string;
  /** Protocol major reported by initialize (to test mismatch handling). */
  protocolMajor?: number;
  projectName?: string;
  /** limits.maxMessageBytes reported by initialize. */
  maxMessageBytes?: number;
}

export type RequestHook = (method: string, params: unknown) => void | Promise<void>;

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

function rangeOf(line: number, character: number, length: number) {
  return { start: { line, character }, end: { line, character: character + length } };
}

/** One "process" of the fixture backend. Implements protocol v1 requests and notifications. */
export class FixtureEngine {
  readonly epoch: string;
  private readonly overlay = new Map<string, string>();
  private ackSequence = -1;
  private workspaceId: string | undefined;
  private workspacePath: string | undefined;
  private initialized = false;
  private readonly plans = new Map<string, { plan: RefactorPlanDto; inputs: Map<string, string> }>();
  private planCounter = 0;
  private stopped = false;
  /** Every method name received, in order (requests and notifications). */
  readonly received: string[] = [];
  /** Text of every didOpen received (used to prove dirty-buffer replay). */
  readonly openedTexts = new Map<string, string>();
  readonly cancelledRequests: string[] = [];
  /** Test hook run before each request is handled (inject edits, delays, failures). */
  beforeRequest: RequestHook | undefined;
  /** Fault injection: the next N document notifications are lost (never applied, sequence not acknowledged). */
  dropDocumentEvents = 0;
  /** Overrides completeness/scopeNotes/scopeDetails of code/related results. */
  relatedScope: Pick<RelatedResult, 'completeness' | 'scopeNotes' | 'scopeDetails'> | undefined;
  /** Prepared plans are "limited" (like a host plan with an MSBuild import it could not fingerprint). */
  limitedPlans = false;

  constructor(
    private readonly world: FixtureWorld,
    private readonly options: FixtureEngineOptions,
  ) {
    world.engineStarts += 1;
    this.epoch = `${options.routeId}-epoch-${world.engineStarts}`;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
  }

  private snapshotId(): string {
    return `${this.epoch}:s${this.ackSequence}`;
  }

  private text(uri: string): string | undefined {
    return this.overlay.get(uri) ?? this.world.files.get(uri);
  }

  private uris(): string[] {
    return [...new Set([...this.world.files.keys(), ...this.overlay.keys()])].sort();
  }

  // ---------------------------------------------------------------- notifications

  notify(method: string, params: unknown): void {
    if (this.stopped) return;
    this.received.push(method);
    const p = params as { uri: string; text?: string; sequence?: number };
    if (method.startsWith('textDocument/') && this.dropDocumentEvents > 0) {
      this.dropDocumentEvents -= 1;
      return;
    }
    switch (method) {
      case 'textDocument/didOpen':
        this.overlay.set(p.uri, p.text ?? '');
        this.openedTexts.set(p.uri, p.text ?? '');
        break;
      case 'textDocument/didChange':
        this.overlay.set(p.uri, p.text ?? '');
        break;
      case 'textDocument/didClose':
        this.overlay.delete(p.uri);
        break;
      case 'refactor/discard':
        this.plans.delete((params as { planId: string }).planId);
        return;
      case 'exit':
        this.stop();
        return;
      default:
        break;
    }
    if (typeof p?.sequence === 'number' && p.sequence > this.ackSequence) this.ackSequence = p.sequence;
  }

  // ---------------------------------------------------------------- requests

  async handle(method: string, params: unknown, token?: CancellationToken): Promise<unknown> {
    if (this.stopped) throw new RpcError(-32603, 'engine stopped');
    this.received.push(method);
    await this.beforeRequest?.(method, params);
    if (token?.isCancellationRequested) {
      this.cancelledRequests.push(method);
      throw new CancelledError();
    }
    if (method !== 'initialize' && !this.initialized) throw new RpcError(ErrorCodes.NotInitialized, 'not initialized', { reasonCode: 'NotInitialized', message: 'not initialized' });
    const p = params as Record<string, unknown>;
    switch (method) {
      case 'initialize':
        return this.initialize(p);
      case 'shutdown':
        return null;
      case 'engine/status':
        return this.status();
      case 'workspace/open':
        if (p.trusted !== true) throw new RpcError(ErrorCodes.TrustRequired, 'trust required', { reasonCode: 'TrustRequired', message: 'Workspace is not trusted' });
        this.workspaceId = String(p.workspaceId);
        this.workspacePath = String(p.path);
        return this.status();
      case 'workspace/reload':
        return this.status();
      case 'workspace/close':
        return null;
      case 'workspace/snapshotBarrier': {
        // Same strictness as the .NET host: a barrier for a sequence that was never received fails.
        const requested = Number(p.sequence);
        if (!(requested <= this.ackSequence)) {
          throw new RpcError(ErrorCodes.BarrierTimeout, 'barrier timeout', { reasonCode: 'BarrierTimeout', message: `Document sequence ${requested} was not received (applied ${this.ackSequence})` });
        }
        const r: BarrierResult = { acknowledgedSequence: this.ackSequence, snapshotId: this.snapshotId(), workspaceRevision: 0 };
        return r;
      }
    }
    // Semantic requests: snapshot must be current.
    if (p.snapshotId !== this.snapshotId()) {
      throw new RpcError(ErrorCodes.StaleSnapshot, 'stale snapshot', { reasonCode: 'StaleSnapshot', message: 'The snapshot is no longer current' });
    }
    switch (method) {
      case 'code/search':
        return this.search(p as never);
      case 'code/symbolAt':
        return this.symbolAt(String(p.uri), p.position as Position);
      case 'code/related':
        return this.related(p as never);
      case 'capability/query':
        return this.capabilities(p as never);
      case 'refactor/prepare':
        return this.prepare(p as never);
      case 'refactor/revalidate':
        return this.revalidate(String(p.planId));
      case 'code/hierarchy':
        return this.hierarchy(p as never);
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `Method ${method} not supported by the fixture engine`);
    }
  }

  private initialize(p: Record<string, unknown>): InitializeResult {
    if (p.protocolMajor !== PROTOCOL_MAJOR) throw new RpcError(ErrorCodes.ProtocolMismatch, 'protocol mismatch', { reasonCode: 'ProtocolMismatch', message: 'major differs' });
    this.initialized = true;
    return {
      protocolMajor: this.options.protocolMajor ?? PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      engineVersion: 'fixture-0',
      sessionEpoch: this.epoch,
      capabilities: ['code/search', 'code/related', 'capability/query', 'refactor/prepare'],
      limits: { maxMessageBytes: this.options.maxMessageBytes ?? 32 * 1024 * 1024 },
    };
  }

  private status(): EngineStatus {
    return {
      state: 'Ready',
      sessionEpoch: this.epoch,
      sdk: { version: null, path: null },
      solutionPath: this.workspacePath ?? null,
      projects: [
        {
          projectContextId: `${this.options.routeId}-p1`,
          name: this.options.projectName ?? 'FixtureProject',
          projectPath: this.workspacePath ?? '',
          targetFramework: null,
          state: 'loaded',
          documentCount: this.uris().length,
          diagnostics: [],
        },
      ],
      diagnostics: [],
    };
  }

  private declarations(): Declaration[] {
    const out: Declaration[] = [];
    for (const uri of this.uris()) {
      const lines = (this.text(uri) ?? '').split(/\r?\n/);
      lines.forEach((line, i) => {
        const m = /^(\s*)symbol\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (m) out.push({ name: m[2]!, uri, line: i, character: line.indexOf(m[2]!, m[1]!.length + 6) });
      });
    }
    return out;
  }

  private symbolRef(d: Declaration): SymbolRef {
    return {
      symbolId: `${this.epoch}|${d.name}`,
      name: d.name,
      displayName: `fixture.${d.name}`,
      kind: 'class',
      projectName: this.options.projectName ?? 'FixtureProject',
      location: { uri: d.uri, range: rangeOf(d.line, d.character, d.name.length) },
      origin: 'source',
      provenance: { kind: 'owned-semantic', providerRouteId: this.options.routeId, sessionEpoch: this.epoch, snapshotId: this.snapshotId(), projectContextId: `${this.options.routeId}-p1` },
    };
  }

  private search(p: { query: string; filters: { member?: boolean; project?: string; route?: string; method?: string; entity?: boolean; table?: string }; limit: number }): SearchResult {
    const q = p.query.toLowerCase();
    if (p.filters.member || p.filters.route !== undefined || p.filters.method || p.filters.entity || p.filters.table !== undefined) return { items: [], truncated: false, snapshotId: this.snapshotId() };
    if (p.filters.project && p.filters.project.toLowerCase() !== (this.options.projectName ?? 'FixtureProject').toLowerCase()) return { items: [], truncated: false, snapshotId: this.snapshotId() };
    const items: SearchItem[] = [];
    for (const d of this.declarations()) {
      const n = d.name.toLowerCase();
      if (q && !n.includes(q)) continue;
      items.push({ symbol: this.symbolRef(d), score: n === q ? 100 : n.startsWith(q) ? 50 : 10 });
    }
    return { items: items.slice(0, p.limit), truncated: items.length > p.limit, snapshotId: this.snapshotId() };
  }

  private wordAt(uri: string, pos: Position): string | undefined {
    const line = (this.text(uri) ?? '').split(/\r?\n/)[pos.line];
    if (line === undefined) return undefined;
    for (const m of line.matchAll(WORD)) {
      if (pos.character >= m.index && pos.character <= m.index + m[0].length) return m[0];
    }
    return undefined;
  }

  /** code/hierarchy (protocol 1.7): incoming = every other occurrence of the name (a "caller" per occurrence); others empty. */
  private hierarchy(p: { symbolId: string; direction: string; snapshotId: string }): import('@refyntra/contracts').HierarchyResult {
    const d = this.resolve({ symbolId: p.symbolId });
    if (!d) throw new RpcError(ErrorCodes.UnknownSymbol, 'unknown symbol', { reasonCode: 'UnknownSymbol', message: 'Unknown symbol' });
    const ref = this.symbolRef(d);
    const items = p.direction !== 'incoming' ? [] : this.occurrences(d.name)
      .filter((l) => !(l.uri === ref.location?.uri && l.range.start.line === ref.location?.range.start.line))
      .map((l) => ({ symbol: { ...ref, symbolId: undefined, name: `caller@${l.range.start.line + 1}`, location: l }, fromRanges: [l.range], fromUri: l.uri }));
    return { items, completeness: 'complete', truncated: false, snapshotId: p.snapshotId };
  }

  private symbolAt(uri: string, pos: Position): SymbolRef | null {
    const word = this.wordAt(uri, pos);
    const d = this.declarations().find((x) => x.name === word);
    return d ? this.symbolRef(d) : null;
  }

  private resolve(p: { symbolId?: string; uri?: string; position?: Position }): Declaration | undefined {
    if (p.symbolId) {
      const [epoch, name] = p.symbolId.split('|');
      if (epoch !== this.epoch) throw new RpcError(ErrorCodes.UnknownSymbol, 'unknown symbol', { reasonCode: 'UnknownSymbol', message: 'Symbol id from another session' });
      return this.declarations().find((d) => d.name === name);
    }
    if (p.uri && p.position) {
      const word = this.wordAt(p.uri, p.position);
      return this.declarations().find((d) => d.name === word);
    }
    return undefined;
  }

  private occurrences(name: string): Location[] {
    const out: Location[] = [];
    for (const uri of this.uris()) {
      (this.text(uri) ?? '').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(WORD)) if (m[0] === name) out.push({ uri, range: rangeOf(i, m.index, name.length) });
      });
    }
    return out;
  }

  private related(p: { symbolId?: string; uri?: string; position?: Position }): RelatedResult {
    const d = this.resolve(p);
    if (!d) return { subject: null, relations: [], completeness: 'complete', scopeNotes: [], snapshotId: this.snapshotId() };
    const subject = this.symbolRef(d);
    const relations: Relation[] = [
      { relationKind: 'declaration', group: 'declarations', target: { symbol: subject, label: subject.displayName }, evidence: [{ description: 'symbol declaration' }], confidence: 'proven', provenance: subject.provenance, limitations: [] },
    ];
    const decls = this.declarations();
    for (const uri of this.uris()) {
      (this.text(uri) ?? '').split(/\r?\n/).forEach((line, i) => {
        const m = /^\s*relate\s+([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (!m || m[1] !== d.name) return;
        const target = decls.find((x) => x.name === m[2]);
        if (!target) return;
        const t = this.symbolRef(target);
        relations.push({
          relationKind: 'implementation',
          group: 'implementations',
          target: { symbol: t, label: t.displayName },
          evidence: [{ description: `relate ${m[1]} -> ${m[2]}`, location: { uri, range: rangeOf(i, 0, line.length) } }],
          confidence: 'proven',
          provenance: subject.provenance,
          limitations: [],
        });
      });
    }
    for (const loc of this.occurrences(d.name)) {
      if (loc.uri === d.uri && loc.range.start.line === d.line) continue;
      relations.push({ relationKind: 'reference', group: 'references', target: { location: loc, label: `${loc.uri.split('/').pop()}:${loc.range.start.line + 1}` }, evidence: [], confidence: 'proven', provenance: subject.provenance, limitations: [] });
    }
    return { subject, relations, completeness: 'complete', scopeNotes: [], ...this.relatedScope, snapshotId: this.snapshotId() };
  }

  private capabilities(p: { uri?: string; position?: Position; symbolId?: string }): Availability[] {
    const d = this.resolve(p);
    const scope = { workspaceId: this.workspaceId ?? '', ...(p.uri ? { documentUri: p.uri } : {}) };
    return [
      {
        capabilityId: 'fixture.rename',
        providerRouteId: this.options.routeId,
        scope,
        state: d ? 'available' : 'unavailable',
        ...(d ? {} : { reasonCode: 'NoSymbol', message: 'Place the cursor on a declared fixture symbol' }),
        recoveryActions: [],
        requiredTrust: 'workspace',
        guarantee: 'owned-semantic',
        limitations: [],
      },
      {
        capabilityId: 'fixture.extract',
        providerRouteId: this.options.routeId,
        scope,
        state: 'unavailable',
        reasonCode: 'NotImplemented',
        message: 'Extract is not implemented for .fixture',
        recoveryActions: [{ command: 'refyntra.showHealth', title: 'Show Refyntra health' }],
        requiredTrust: 'workspace',
        guarantee: 'owned-semantic',
        limitations: [],
      },
    ];
  }

  private prepare(p: { symbolId: string; newName: string; actionId: string }): PrepareResult {
    if (p.actionId !== 'fixture.rename') return { kind: 'unavailable', reasonCode: 'UnknownAction', message: `Unknown action ${p.actionId}` };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.newName)) return { kind: 'unavailable', reasonCode: 'InvalidName', message: 'Not a valid fixture identifier' };
    const d = this.resolve({ symbolId: p.symbolId });
    if (!d) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: 'Symbol not found' };
    const byUri = new Map<string, Location[]>();
    for (const loc of this.occurrences(d.name)) byUri.set(loc.uri, [...(byUri.get(loc.uri) ?? []), loc]);
    const writeSet: PlannedTextChange[] = [];
    const inputs = new Map<string, string>();
    for (const uri of this.uris()) inputs.set(uri, sha256(this.text(uri) ?? ''));
    for (const [uri, locs] of byUri) {
      const text = this.text(uri) ?? '';
      const edits = locs.map((l) => ({ range: l.range, newText: p.newName }));
      writeSet.push({ kind: 'text', uri, expectedHash: sha256(text), resultHash: sha256(applyTextEdits(text, edits)), edits });
    }
    const plan: RefactorPlanDto = {
      planId: `${this.epoch}-plan-${++this.planCounter}`,
      actionId: 'fixture.rename',
      providerRouteId: this.options.routeId,
      protocolMajor: PROTOCOL_MAJOR,
      workspaceId: this.workspaceId ?? '',
      kind: 'owned-semantic',
      sessionEpoch: this.epoch,
      baseWorkspaceRevision: 0,
      baseSnapshotId: this.snapshotId(),
      projectContextIds: [`${this.options.routeId}-p1`],
      writeSet,
      readSet: [...inputs].map(([input, hash]) => ({ input, hash })),
      evidence: [{ description: `${byUri.size} file(s) mention ${d.name}` }],
      limitations: ['Fixture language: whole-word textual rename', ...(this.limitedPlans ? [FIXTURE_LIMITATION] : [])],
      validation: { status: this.limitedPlans ? 'limited' : 'valid', checkedContexts: [`${this.options.routeId}-p1`], uncheckedContexts: [], compilationDelta: 'not-run' },
      title: `Rename ${d.name} to ${p.newName}`,
    };
    this.plans.set(plan.planId, { plan, inputs });
    return { kind: 'prepared', plan };
  }

  private revalidate(planId: string): RevalidateResult {
    const entry = this.plans.get(planId);
    if (!entry) return { status: 'invalid', reasonCode: 'UnknownPlan', message: 'Plan not found (discarded or from another session)' };
    for (const uri of this.uris()) {
      if (entry.inputs.get(uri) !== sha256(this.text(uri) ?? '')) return { status: 'stale', reasonCode: 'InputChanged', message: `${uri} changed` };
    }
    if (entry.plan.validation.status === 'limited') return { status: 'limited', reasonCode: 'LimitedValidation', message: FIXTURE_LIMITATION, limitations: entry.plan.limitations };
    return { status: 'valid' };
  }
}

export const FIXTURE_LIMITATION = 'Fixture: an import with a computed path was not fingerprinted';

/** Applies sorted, non-overlapping edits (UTF-16 positions) to a text. */
export function applyTextEdits(text: string, edits: readonly { range: { start: Position; end: Position }; newText: string }[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const offset = (p: Position) => Math.min((lineStarts[p.line] ?? text.length) + p.character, text.length);
  let out = '';
  let last = 0;
  for (const e of edits) {
    const s = offset(e.range.start);
    out += text.slice(last, s) + e.newText;
    last = offset(e.range.end);
  }
  return out + text.slice(last);
}
