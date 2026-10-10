import type {
  AdapterState,
  Availability,
  InputFingerprint,
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
import { type AdapterHealth, type DelegatedRefactorPlan, RECOVERY_SHOW_HEALTH, delegatedProvenance, locationKey } from '@refyntra/domain';
import {
  type AdapterDescriptor,
  type CancellationToken,
  type CapabilityTarget,
  type DelegatedPrepareResult,
  type DelegatedRenamePort,
  type DelegatedRenameRequest,
  type DocumentEvent,
  type DocumentTracker,
  type LanguageAdapter,
  type Logger,
  type RelatedTarget,
  type RouteResult,
  type SearchRequest,
  CancelledError,
  Emitter,
  RouteUnavailableError,
  StaleResultError,
  describeError,
  descriptorHandles,
  raceCancellation,
  throwIfCancelled,
} from '@refyntra/application';
import { type ProviderSymbol, isMemberSymbol, isTypeSymbol, readDocumentSymbols, readLocations, readWorkspaceEdit, readWorkspaceSymbols } from './convert';
import { type CommandExecutor, type DocumentReader, type Hasher, PROVIDER_COMMANDS, type ProviderValues } from './ports';
import { applyEdits, basename, comparePos, hasMixedLineEndings, hasOverlap, identifierAt, sortEdits, textInRange } from './text';

export const TS_JS_ROUTE_ID = 'typescript.vscode-providers';
export const TS_JS_CAPABILITY_IDS = ['typescript.find', 'typescript.related', 'typescript.references', 'typescript.rename', 'typescript.frameworkRelations'] as const;

/** The delegated TypeScript/JavaScript route. No Refyntra process; public VS Code provider commands only. */
export const TS_JS_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'typescript',
  providerRouteId: TS_JS_ROUTE_ID,
  displayName: 'TS/JS',
  languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
  fileExtensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  uriSchemes: ['file'],
  ownership: 'delegated',
  operations: ['find', 'related', 'actions', 'rename'],
  renameActionId: 'typescript.rename',
  capabilityIds: [...TS_JS_CAPABILITY_IDS],
};

export const DELEGATED_LIMITATION = 'Results come from the installed TypeScript/JavaScript provider; completeness unknown.';
export const FRAMEWORK_RELATIONS_UNAVAILABLE =
  'Framework relations (handlers, endpoints, registrations) are not available for TypeScript/JavaScript: Refyntra has no TypeScript/JavaScript framework module.';
const NO_PROVIDER_HINT = 'The built-in "TypeScript and JavaScript Language Features" extension may be disabled or still starting.';

export const DELEGATED_RENAME_LIMITATIONS: readonly string[] = [
  'Provider-managed semantic coverage: the edits come from the installed TypeScript/JavaScript rename provider; Refyntra did not compute or validate them semantically.',
  "The provider's project context, compiler version, snapshot and read set are unknown. Asking it again before the apply checks that it returns the same edit; it does not lock or reveal the provider's internal state.",
  'No compilation check is run (compilation delta: not-run).',
  'Only the text edits the public API lists are applied; Refyntra builds its own edit from them.',
];

export interface DelegatedProviderAdapterOptions {
  descriptor?: AdapterDescriptor;
  workspaceId: string;
  commands: CommandExecutor;
  values: ProviderValues;
  documents: DocumentReader;
  hash: Hasher;
  /** The application's document tracker: its revision is the observation clock of this route. */
  tracker: DocumentTracker;
  logger: Logger;
}

interface Observation {
  epoch: string;
  revision: number;
  observationId: string;
}

type CommandOutcome = { ok: true; value: unknown } | { ok: false; error: string };

type RenameObservation =
  | { kind: 'ok'; oldName: string; changes: PlannedTextChange[]; inputs: InputFingerprint[] }
  | { kind: 'unavailable'; reasonCode: string; message: string; nativeFallback: boolean };

/** True when an odd number of unescaped quotes precedes the position on its line (a string literal or template). */
function insideStringLiteral(text: string, p: Position): boolean {
  const line = text.split(/\r\n|\n|\r/)[p.line];
  if (line === undefined) return false;
  let quote: string | undefined;
  for (let i = 0; i < Math.min(p.character, line.length); i++) {
    const c = line[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return false;
  }
  return quote !== undefined;
}

const unavailableObs = (reasonCode: string, message: string, nativeFallback: boolean): RenameObservation => ({ kind: 'unavailable', reasonCode, message, nativeFallback });

function matchScore(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 50;
  return n.includes(q) ? 20 : 10;
}

/**
 * LanguageAdapter for TS/JS through VS Code's public provider dispatch. Owns no semantic
 * backend: every result is `delegated` (observationId, unknown snapshot/context), Find is never a complete index,
 * and rename follows the delegated flow (fingerprints, refusal of non-text edits, re-ask before apply, never `valid`).
 */
export class DelegatedProviderAdapter implements LanguageAdapter {
  readonly descriptor: AdapterDescriptor;
  private readonly o: DelegatedProviderAdapterOptions;
  private epoch: string | undefined;
  private epochCounter = 0;
  private observationCounter = 0;
  private planCounter = 0;
  private restartCount = 0;
  private state: AdapterState = 'NotStarted';
  private readonly healthEmitter = new Emitter<AdapterHealth>();
  private readonly epochEmitter = new Emitter<string | undefined>();
  readonly onDidChangeHealth = this.healthEmitter.event;
  readonly onDidChangeEpoch = this.epochEmitter.event;
  readonly delegatedRename: DelegatedRenamePort = {
    prepare: (req, token) => this.prepareDelegated(req, token),
    revalidate: (plan, token) => this.revalidateDelegated(plan, token),
  };

  constructor(options: DelegatedProviderAdapterOptions) {
    this.o = options;
    this.descriptor = options.descriptor ?? TS_JS_DESCRIPTOR;
  }

  handles(uri: string, languageId?: string): boolean {
    return descriptorHandles(this.descriptor, uri, languageId);
  }

  health(): AdapterHealth {
    return {
      adapterId: this.descriptor.adapterId,
      providerRouteId: this.descriptor.providerRouteId,
      displayName: this.descriptor.displayName,
      state: this.state,
      ...(this.state === 'Ready'
        ? { message: 'Delegated to the installed TypeScript/JavaScript language features through public VS Code provider commands. Results are not owned by Refyntra; completeness unknown.' }
        : {}),
      recoveryActions: [],
      ...(this.epoch ? { sessionEpoch: this.epoch } : {}),
      projects: [],
      diagnostics: [],
      restartCount: this.restartCount,
      hostDescription: 'public VS Code provider commands (no Refyntra process)',
    };
  }

  currentEpoch(): string | undefined {
    return this.epoch;
  }

  async start(): Promise<void> {
    if (!this.epoch) this.newEpoch();
  }

  async restart(_reason: string): Promise<void> {
    this.restartCount += 1;
    this.newEpoch();
  }

  private newEpoch(): void {
    this.epochCounter += 1;
    this.epoch = `${this.o.workspaceId}-bridge-${this.epochCounter}`;
    this.state = 'Ready';
    this.epochEmitter.fire(this.epoch);
    this.healthEmitter.fire(this.health());
  }

  /** VS Code's providers read the editor state themselves; the tracker revision is our observation clock. */
  documentEvent(_e: DocumentEvent): void {}

  discard(_planId: string): void {}

  async dispose(): Promise<void> {
    this.epoch = undefined;
    this.state = 'NotStarted';
    this.healthEmitter.dispose();
    this.epochEmitter.dispose();
  }

  // ---------------------------------------------------------------- helpers

  private begin(token?: CancellationToken): Observation {
    throwIfCancelled(token);
    const epoch = this.epoch;
    if (!epoch) throw new RouteUnavailableError('NotStarted', 'the TypeScript/JavaScript route is not started.', [RECOVERY_SHOW_HEALTH]);
    this.observationCounter += 1;
    return { epoch, revision: this.o.tracker.revision, observationId: `${epoch}-obs-${this.observationCounter}` };
  }

  /** A result observed while the code or the route changed is dropped (the engine retries once). */
  private finish(b: Observation, token?: CancellationToken): void {
    throwIfCancelled(token);
    if (this.epoch !== b.epoch) throw new StaleResultError('epoch');
    if (this.o.tracker.revision !== b.revision) throw new StaleResultError('revision');
  }

  private result<T>(b: Observation, value: T): RouteResult<T> {
    return { value, providerRouteId: this.descriptor.providerRouteId, sessionEpoch: b.epoch, snapshotId: 'unknown', workspaceRevision: b.revision };
  }

  private async exec(command: string, args: unknown[], token?: CancellationToken): Promise<CommandOutcome> {
    throwIfCancelled(token);
    try {
      const value = await raceCancellation(Promise.resolve(this.o.commands.executeCommand<unknown>(command, ...args)), token);
      return { ok: true, value };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      this.o.logger.log('warn', 'vscode-providers', 'provider command failed', { command, error: describeError(e) });
      return { ok: false, error: describeError(e) };
    }
  }

  private symbolRef(s: ProviderSymbol, observationId: string): SymbolRef {
    return {
      name: s.name,
      displayName: s.containerName ? `${s.containerName}.${s.name}` : s.name,
      kind: s.kind,
      ...(s.containerName ? { containerName: s.containerName } : {}),
      location: s.location,
      origin: 'source',
      provenance: delegatedProvenance(this.descriptor.providerRouteId, observationId),
    };
  }

  private async documentSymbols(uri: string, token?: CancellationToken): Promise<ProviderSymbol[] | undefined> {
    const r = await this.exec(PROVIDER_COMMANDS.documentSymbols, [this.o.values.uri(uri)], token);
    return r.ok ? readDocumentSymbols(r.value, uri) : undefined;
  }

  /** Innermost symbol whose name range contains the position. */
  private static symbolAtPosition(symbols: readonly ProviderSymbol[], position: Position): ProviderSymbol | undefined {
    const hits = symbols.filter((s) => comparePos(s.location.range.start, position) <= 0 && comparePos(position, s.location.range.end) <= 0);
    return hits.sort((a, b) => comparePos(b.location.range.start, a.location.range.start))[0];
  }

  // ---------------------------------------------------------------- Find

  async search(req: SearchRequest, token?: CancellationToken): Promise<RouteResult<SearchResult>> {
    const b = this.begin(token);
    const f = req.filters;
    let items: SearchItem[] = [];
    // Endpoint and project filters belong to the C# route; TS/JS has neither.
    if (!f.route && !f.method && !f.project && req.query.trim().length > 0) {
      const r = await this.exec(PROVIDER_COMMANDS.workspaceSymbols, [req.query], token);
      if (!r.ok) throw new RouteUnavailableError('ProviderError', `the workspace symbol provider failed: ${r.error}`, [RECOVERY_SHOW_HEALTH]);
      // The dispatch covers every language: keep only documents this route owns.
      const seen = new Set<string>();
      for (const s of readWorkspaceSymbols(r.value) ?? []) {
        if (!this.handles(s.location.uri)) continue;
        if (f.type && !isTypeSymbol(s)) continue;
        if (f.member && !isMemberSymbol(s)) continue;
        const key = `${locationKey(s.location)}|${s.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ symbol: this.symbolRef(s, b.observationId), score: matchScore(s.name, req.query.trim()) });
      }
    }
    items.sort((x, y) => y.score - x.score || (x.symbol!.name < y.symbol!.name ? -1 : x.symbol!.name > y.symbol!.name ? 1 : 0));
    const truncated = items.length > req.limit;
    items = items.slice(0, req.limit);
    this.finish(b, token);
    return this.result(b, { items, truncated, snapshotId: 'unknown' });
  }

  async symbolAt(uri: string, position: Position, token?: CancellationToken): Promise<RouteResult<SymbolRef | null>> {
    const b = this.begin(token);
    const symbols = await this.documentSymbols(uri, token);
    if (symbols === undefined) throw new RouteUnavailableError('ProviderUnavailable', `no TypeScript/JavaScript document symbol provider answered. ${NO_PROVIDER_HINT}`, [RECOVERY_SHOW_HEALTH]);
    const s = DelegatedProviderAdapter.symbolAtPosition(symbols, position);
    this.finish(b, token);
    return this.result(b, s ? this.symbolRef(s, b.observationId) : null);
  }

  // ---------------------------------------------------------------- Related

  async related(target: RelatedTarget, token?: CancellationToken): Promise<RouteResult<RelatedResult>> {
    if (!('uri' in target)) throw new RouteUnavailableError('NotSupported', 'the delegated route has no symbol ids.');
    const b = this.begin(token);
    const args = [this.o.values.uri(target.uri), this.o.values.position(target.position)];
    const [defs, refs] = await Promise.all([this.exec(PROVIDER_COMMANDS.definitions, args, token), this.exec(PROVIDER_COMMANDS.references, args, token)]);
    if (!defs.ok && !refs.ok) throw new RouteUnavailableError('ProviderError', `the TypeScript/JavaScript providers failed: ${defs.error}`, [RECOVERY_SHOW_HEALTH]);
    const defList = defs.ok ? (readLocations(defs.value) ?? []) : [];
    const refList = refs.ok ? (readLocations(refs.value) ?? []) : [];
    if (defList.length === 0 && refList.length === 0) {
      // Definition/reference dispatch answers [] both without a provider and without a symbol; document symbols
      // (undefined without any provider) tell the two apart for this document.
      const symbols = await this.documentSymbols(target.uri, token);
      if (symbols === undefined || symbols.length === 0) {
        throw new RouteUnavailableError('ProviderUnavailable', `no TypeScript/JavaScript provider answered for this document. ${NO_PROVIDER_HINT}`, [RECOVERY_SHOW_HEALTH]);
      }
      throw new RouteUnavailableError('ProviderEmpty', 'the installed TypeScript/JavaScript provider returned no definition or references at this position.');
    }
    const subject = await this.subjectFor(target.uri, target.position, defList, b.observationId, token);
    const provenance = delegatedProvenance(this.descriptor.providerRouteId, b.observationId);
    const relation = (loc: Location, kind: 'declaration' | 'reference', command: string): Relation => ({
      relationKind: kind,
      group: kind === 'declaration' ? 'declarations' : 'references',
      target: { location: loc, label: `${basename(loc.uri)}:${loc.range.start.line + 1}` },
      evidence: [{ description: `reported by ${command}`, location: loc }],
      confidence: 'likely',
      provenance,
      limitations: [DELEGATED_LIMITATION],
    });
    const declKeys = new Set(defList.map(locationKey));
    const relations: Relation[] = [
      ...defList.map((l) => relation(l, 'declaration', PROVIDER_COMMANDS.definitions)),
      ...refList.filter((l) => !declKeys.has(locationKey(l))).map((l) => relation(l, 'reference', PROVIDER_COMMANDS.references)),
    ];
    const scopeNotes = [DELEGATED_LIMITATION, FRAMEWORK_RELATIONS_UNAVAILABLE];
    if (!defs.ok) scopeNotes.push(`The definition provider failed: ${defs.error}`);
    if (!refs.ok) scopeNotes.push(`The reference provider failed: ${refs.error}`);
    this.finish(b, token);
    return this.result(b, { subject, relations, completeness: 'unknown', scopeNotes, snapshotId: 'unknown' });
  }

  private async subjectFor(uri: string, position: Position, defs: Location[], observationId: string, token?: CancellationToken): Promise<SymbolRef | null> {
    const def = defs[0];
    if (def) {
      const symbols = await this.documentSymbols(def.uri, token);
      const s = symbols && DelegatedProviderAdapter.symbolAtPosition(symbols, def.range.start);
      if (s) return this.symbolRef(s, observationId);
    }
    const doc = await this.o.documents.read(uri);
    const name = doc.ok ? identifierAt(doc.text, position) : undefined;
    if (!name) return null;
    return { name, displayName: name, kind: 'other', ...(def ? { location: def } : {}), origin: 'source', provenance: delegatedProvenance(this.descriptor.providerRouteId, observationId) };
  }

  // ---------------------------------------------------------------- Actions

  async capabilities(target: CapabilityTarget, token?: CancellationToken): Promise<RouteResult<Availability[]>> {
    const b = this.begin(token);
    const route = this.descriptor.providerRouteId;
    const scope = { workspaceId: this.o.workspaceId, ...(target.uri ? { documentUri: target.uri } : {}) };
    const item = (capabilityId: string, state: Availability['state'], limitations: string[], extra: Partial<Availability> = {}): Availability => ({
      capabilityId,
      providerRouteId: route,
      scope,
      state,
      recoveryActions: [],
      requiredTrust: 'none',
      guarantee: 'delegated',
      limitations,
      ...extra,
    });
    const items = [
      item('typescript.find', 'available', [DELEGATED_LIMITATION, 'Not a complete index of all languages and projects.']),
      item('typescript.related', 'available', [DELEGATED_LIMITATION, 'Declarations and references only.']),
      item('typescript.references', 'available', [DELEGATED_LIMITATION]),
      item('typescript.rename', 'limited', [...DELEGATED_RENAME_LIMITATIONS]),
      item('typescript.frameworkRelations', 'unavailable', [], { reasonCode: 'NoFrameworkModule', message: FRAMEWORK_RELATIONS_UNAVAILABLE }),
    ];
    return this.result(b, items);
  }

  // ---------------------------------------------------------------- owned plan methods (not used by a delegated route)

  async prepare(): Promise<RouteResult<PrepareResult>> {
    const b = this.begin();
    return this.result(b, { kind: 'unavailable', reasonCode: 'DelegatedRoute', message: 'The TypeScript/JavaScript route prepares delegated plans only.' });
  }

  async revalidate(_plan: RefactorPlanDto): Promise<RevalidateResult> {
    return { status: 'invalid', reasonCode: 'DelegatedRoute', message: 'The TypeScript/JavaScript route has no owned-semantic plans.' };
  }

  // ---------------------------------------------------------------- delegated rename

  /** Steps 1–3 on the current state: fingerprints, provider edit, refusal of everything that is not a plain text edit. */
  private async observeRename(req: DelegatedRenameRequest, b: Observation, token?: CancellationToken): Promise<RenameObservation> {
    const hash = this.o.hash;
    const source = await this.o.documents.read(req.uri);
    if (!source.ok) return unavailableObs('DocumentUnavailable', `${basename(req.uri)} cannot be read.`, false);
    const sourceHash = hash(source.text);
    const args = [this.o.values.uri(req.uri), this.o.values.position(req.position)];
    const prep = await this.exec(PROVIDER_COMMANDS.prepareRename, args, token);
    if (!prep.ok) return unavailableObs('NotRenameable', `The TypeScript/JavaScript provider cannot rename here: ${prep.error}`, false);
    if (prep.value === undefined || prep.value === null) return unavailableObs('ProviderUnavailable', `No TypeScript/JavaScript rename provider answered. ${NO_PROVIDER_HINT}`, false);
    const p = prep.value as { placeholder?: unknown; range?: { start?: Position; end?: Position }; start?: Position; end?: Position };
    const r = p.range ?? (p.start && p.end ? { start: p.start, end: p.end } : undefined);
    const oldName =
      (typeof p.placeholder === 'string' && p.placeholder) ||
      (r?.start && r.end ? textInRange(source.text, r.start, r.end) : undefined) ||
      identifierAt(source.text, req.position) ||
      'symbol';
    // Inside a string literal (a module path): the provider may rename the file, which the public WorkspaceEdit API
    // does not list (entries() has text edits only), so the preview could not show it.
    if (r?.start && insideStringLiteral(source.text, r.start)) {
      return unavailableObs('PossibleFileOperation', 'Renaming inside a string (such as a module path) may rename a file; the public VS Code API does not show file operations, so Refyntra cannot preview this rename.', true);
    }
    const edit = await this.exec(PROVIDER_COMMANDS.rename, [...args, req.newName], token);
    if (!edit.ok) return unavailableObs('ProviderError', `The TypeScript/JavaScript rename provider failed: ${edit.error}`, false);
    if (edit.value === undefined || edit.value === null) return unavailableObs('ProviderUnavailable', `No TypeScript/JavaScript rename provider answered. ${NO_PROVIDER_HINT}`, false);
    const read = readWorkspaceEdit(edit.value);
    // Safety cannot be confirmed for these: the editor's own rename may still be used, explicitly not validated by us.
    if (!read.ok) return unavailableObs(read.reasonCode, read.message, true);
    if (read.changes.length === 0) {
      // VS Code answers an empty edit also when no rename provider exists for the document; tell the two apart.
      const symbols = await this.documentSymbols(req.uri, token);
      if (symbols === undefined || symbols.length === 0) return unavailableObs('ProviderUnavailable', `No TypeScript/JavaScript provider answered for this document. ${NO_PROVIDER_HINT}`, false);
      return unavailableObs('ProviderEmpty', 'The TypeScript/JavaScript rename provider returned no changes.', false);
    }
    const changes: PlannedTextChange[] = [];
    const inputs = new Map<string, string>([[req.uri, sourceHash]]);
    for (const change of [...read.changes].sort((x, y) => (x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : 0))) {
      const name = basename(change.uri);
      const doc = change.uri === req.uri ? source : await this.o.documents.read(change.uri);
      if (!doc.ok) {
        if (doc.reason === 'not-utf8') return unavailableObs('UnsupportedEncoding', `${name} is not UTF-8; Refyntra applies text edits to UTF-8 files only.`, true);
        if (doc.reason === 'not-file') return unavailableObs('NonFileTarget', `${name} is not a local file.`, true);
        return unavailableObs('DocumentUnavailable', `${name} cannot be read.`, true);
      }
      if (!doc.open && hasMixedLineEndings(doc.text)) return unavailableObs('MixedLineEndings', `${name} has mixed line endings; VS Code would normalize it when opening, so the preview could not match the result.`, true);
      const edits = sortEdits(change.edits);
      if (hasOverlap(edits)) return unavailableObs('OverlappingEdits', `The provider edit for ${name} has overlapping changes.`, true);
      let result: string;
      try {
        result = applyEdits(doc.text, edits);
      } catch {
        return unavailableObs('EditOutsideDocument', `The provider edit does not fit the current text of ${name}.`, true);
      }
      const expectedHash = hash(doc.text);
      inputs.set(change.uri, expectedHash);
      changes.push({ kind: 'text', uri: change.uri, expectedHash, resultHash: hash(result), edits });
    }
    // Step 1: nothing the preview is built on may have changed while the provider worked.
    const again = await this.o.documents.read(req.uri);
    throwIfCancelled(token);
    if (!again.ok || hash(again.text) !== sourceHash || this.o.tracker.revision !== b.revision || this.epoch !== b.epoch) {
      return unavailableObs('DocumentChanged', 'A document was edited while the rename was being prepared. Run Rename again.', false);
    }
    return { kind: 'ok', oldName, changes, inputs: [...inputs.entries()].map(([input, h]) => ({ input, hash: h })).sort((x, y) => (x.input < y.input ? -1 : 1)) };
  }

  private async prepareDelegated(req: DelegatedRenameRequest, token?: CancellationToken): Promise<RouteResult<DelegatedPrepareResult>> {
    const b = this.begin(token);
    const obs = await this.observeRename(req, b, token);
    if (obs.kind === 'unavailable') return this.result(b, obs);
    this.planCounter += 1;
    const plan: DelegatedRefactorPlan = {
      planId: `${b.epoch}-plan-${this.planCounter}`,
      actionId: this.descriptor.renameActionId ?? 'typescript.rename',
      providerRouteId: this.descriptor.providerRouteId,
      workspaceId: this.o.workspaceId,
      kind: 'delegated',
      bridgeEpoch: b.epoch,
      observationId: b.observationId,
      observedWorkspaceRevision: b.revision,
      observedInputs: obs.inputs,
      backendContext: 'unknown',
      backendSnapshot: 'unknown',
      semanticReadSet: 'unknown',
      coverage: 'provider-managed',
      origin: { uri: req.uri, position: { line: req.position.line, character: req.position.character }, newName: req.newName },
      writeSet: obs.changes,
      evidence: [{ description: `Edits returned by ${PROVIDER_COMMANDS.rename} (after ${PROVIDER_COMMANDS.prepareRename}) for ${basename(req.uri)}:${req.position.line + 1}` }],
      limitations: [...DELEGATED_RENAME_LIMITATIONS],
      validation: { status: 'limited', compilationDelta: 'not-run', providerReprepared: false, returnedEditsMatchedPreview: false },
      title: `Rename ${obs.oldName} to ${req.newName}`,
    };
    return this.result(b, { kind: 'prepared', plan });
  }

  /** Step 5: the provider is asked again on the current state; only an identical edit on identical inputs passes. */
  private async revalidateDelegated(plan: DelegatedRefactorPlan, token?: CancellationToken): Promise<RevalidateResult> {
    if (!this.epoch || plan.bridgeEpoch !== this.epoch || plan.providerRouteId !== this.descriptor.providerRouteId) {
      return { status: 'stale', reasonCode: 'RouteChanged', message: 'the TypeScript/JavaScript route changed since the preview' };
    }
    const b = this.begin(token);
    const obs = await this.observeRename(plan.origin, b, token);
    plan.validation.providerReprepared = true;
    if (obs.kind === 'unavailable') return { status: 'stale', reasonCode: obs.reasonCode, message: obs.message };
    const norm = (changes: readonly PlannedTextChange[]) => JSON.stringify(changes.map((c) => [c.uri, c.expectedHash, c.resultHash, c.edits.map((e) => [e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character, e.newText])]));
    if (norm(obs.changes) !== norm(plan.writeSet)) {
      return { status: 'stale', reasonCode: 'ProviderEditChanged', message: 'the provider now returns a different edit than the preview; a new preview is required' };
    }
    const fingerprints = (list: readonly InputFingerprint[]) => JSON.stringify([...list].sort((x, y) => (x.input < y.input ? -1 : 1)).map((i) => [i.input, i.hash]));
    if (fingerprints(obs.inputs) !== fingerprints(plan.observedInputs)) {
      return { status: 'stale', reasonCode: 'DocumentChanged', message: 'a document changed since the preview' };
    }
    plan.validation.returnedEditsMatchedPreview = true;
    return { status: 'limited', limitations: [...plan.limitations] };
  }
}
