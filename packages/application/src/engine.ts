import type { Availability, PlannedChange, Position, RecoveryAction, RevalidateResult, ScopeDetails, SymbolRef } from '@refyntra/contracts';
import { CSHARP_CLEANUP_ACTION } from '@refyntra/contracts';
import {
  type AnyRefactorPlan,
  type AnyRelation,
  type FindItem,
  type HealthSummary,
  type PlanState,
  type PlanValidationIssue,
  type RelationGroupView,
  PlanLifecycle,
  RECOVERY_SHOW_HEALTH,
  acceptsSemanticRequests,
  groupRelations,
  mergeFindItems,
  mergeRelations,
  sortAvailability,
  toFindItem,
  unavailable,
  validatePlanStructure,
} from '@refyntra/domain';
import type { AdapterRegistry, LanguageAdapter, RouteResult } from './adapters';
import { type CancellationToken, CancelledError, throwIfCancelled } from './cancellation';
import type { DocumentTracker } from './documents';
import { AdapterUnavailableError, RouteUnavailableError, RpcError, StaleResultError, describeError, describeErrorWithRecovery } from './errors';
import { type ParsedFindQuery, hasAnyFilter, parseFindQuery } from './filters';
import type { ApplicationSettings, ApplyFileReport, ApplyResourceReport, EditApplier, Logger } from './ports';
import { BoundedCache, type Disposable, Emitter } from './util';
import type { HttpLinkService } from './http/httpLinks';

export interface DocumentTarget {
  uri: string;
  position: Position;
}

export interface Unavailable {
  kind: 'unavailable';
  reasonCode: string;
  message: string;
  recoveryActions: RecoveryAction[];
}

export interface FindOutcome {
  query: ParsedFindQuery;
  items: FindItem[];
  truncated: boolean;
  /** Per-route notes, e.g. "C#: TrustRequired — ...". Results from other routes are still shown. */
  notes: string[];
  /** Route label per providerRouteId of the items, e.g. "C#" or "TS/JS (delegated)". */
  routeLabels?: Record<string, string>;
}

/** Native editor rename offered when a delegated rename cannot be confirmed safe. Not validated by Refyntra. */
export function nativeRenameRecovery(uri: string, position: Position): RecoveryAction {
  return { command: 'refyntra.nativeRename', title: 'Use the editor Rename (not validated by Refyntra)', args: [uri, position] };
}

/** Find note of a delegated route: never presented as a complete index. */
export function delegatedFindNote(displayName: string): string {
  return `${displayName}: delegated results from the installed language provider; completeness unknown (not a complete index).`;
}

export interface RelatedView {
  kind: 'related';
  subject: SymbolRef | null;
  groups: RelationGroupView[];
  completeness: 'complete' | 'partial' | 'unknown';
  /** Every scope note: the language route's, then notes added by framework adapters. */
  scopeNotes: string[];
  /** Structured scope from the language route (C# host); absent for delegated routes and older hosts. */
  scopeDetails?: ScopeDetails;
  /** Notes added here (framework adapter failures), i.e. not covered by scopeDetails. */
  additionalNotes: string[];
  providerRouteId: string;
  sessionEpoch: string;
  snapshotId: string;
  workspaceRevision: number;
}
export type RelatedOutcome = RelatedView | Unavailable;

export interface ActionsOutcome {
  items: Availability[];
  /** Explanation when nothing is available (an empty list never replaces an explanation). */
  note?: string;
}

export interface RenamePreview {
  kind: 'preview';
  planId: string;
  /** `delegated` plans carry provider-managed semantic coverage and are never `valid`. */
  plan: AnyRefactorPlan;
  state: PlanState;
  issues: PlanValidationIssue[];
  applyEnabled: boolean;
}
export type RenameOutcome = RenamePreview | Unavailable;

export interface ApplyOutcome {
  /**
   * `limited`: nothing was done; the plan is only partly validated and needs an explicit confirmation of
   * `limitations` (call applyRename again with `acceptLimited`). The plan stays Previewing.
   */
  status: 'applied' | 'stale' | 'failed' | 'disabled' | 'cancelled' | 'limited';
  message: string;
  /** With status `limited`: what the user must confirm. */
  limitations?: string[];
  /** Reconciled post-state per target (present once the editor apply was started). */
  files?: ApplyFileReport[];
  /** File rename: reconciled post-state of each planned file rename. */
  resources?: ApplyResourceReport[];
  /** File rename: the text edits were applied and confirmed but a file rename was not (offer Undo of the text; nothing was rolled back). */
  textAppliedOnly?: boolean;
  /** Created files: a file was created but the text edits were not applied (offer to delete the new file; nothing was rolled back). */
  createdOnly?: boolean;
  /** Stale/failed before anything was written: running Rename again gives a fresh preview. */
  canReprepare?: boolean;
}

export interface AnalysisView {
  kind: 'analysis';
  diagnostics: import('@refyntra/contracts').RuleDiagnostic[];
  abstentions: import('@refyntra/contracts').RuleAbstention[];
  completeness: 'complete' | 'partial' | 'unknown';
  providerRouteId: string;
  sessionEpoch: string;
  snapshotId: string;
  workspaceRevision: number;
}
/** Stack trace navigation: candidate source symbols of one .NET frame, or why there are none. */
export type ResolveFrameOutcome =
  | { kind: 'candidates'; candidates: import('@refyntra/contracts').FrameCandidate[] }
  | Unavailable;

export type AnalysisOutcome = AnalysisView | (Unavailable & { providerRouteId: string });

export interface PrepareOptions {
  renameFile?: boolean;
  /** EF Core migrations that reference the symbol: rename the references in them (`efMigrations`) or leave them (`none`). */
  generatedEdits?: import('@refyntra/contracts').GeneratedEditsMode;
}

/** Options of a create-file action (Move Type to File, Generate handler). */
export interface ActionPrepareOptions {
  /** Generate handler: one of the folder choices of an earlier preview (absent: the default folder). */
  targetFolderUri?: string;
  /** Extract Method: the selection (no symbol is needed at the cursor). */
  range?: import('@refyntra/contracts').Range;
  /** Extract Method: the name of the new method. */
  newName?: string;
  /** Change Signature: the new parameter list. */
  signature?: import('@refyntra/contracts').SignatureParams;
  /** Register in DI (protocol 1.11): the lifetime and the choices (target.position is the service). */
  registration?: import('@refyntra/contracts').RegistrationParams;
  /** Fix in scope (protocol 1.11): the edit action and the scope around the target document. */
  fixAll?: import('@refyntra/contracts').FixAllParams;
  /** Structural replace (protocol 1.19): pattern, replacement, scope (no symbol is needed at the cursor). */
  structural?: import('./adapters').StructuralReplaceRequest;
}

/** Structural search (protocol 1.19): the host's matches, or why there are none. */
export type StructuralSearchOutcome =
  | { kind: 'structural'; result: import('@refyntra/contracts').StructuralSearchResult }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

/** Change Signature: the parameters of the method at the cursor, or why there are none. */
export type SignatureOutcome = { kind: 'signature'; info: import('@refyntra/contracts').SignatureInfo } | Unavailable;

/** Go to metadata (protocol 1.17): the host's answer, or why there is none. */
export type MetadataSourceOutcome =
  | { kind: 'metadata'; result: import('@refyntra/contracts').MetadataSourceResult }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

/** The scheme of Refyntra's read-only metadata documents ("refyntra-metadata:/<assembly>/<Namespace.Type>.cs"). */
export const METADATA_SCHEME = 'refyntra-metadata';

/**
 * The type and assembly of a metadata document URI: "refyntra-metadata:/MediatR/MediatR.IMediator.cs" ->
 * { documentationId: "T:MediatR.IMediator", assemblyName: "MediatR" }. Undefined for other URIs.
 */
export function metadataDocumentRef(uri: string): { documentationId: string; assemblyName: string } | undefined {
  const prefix = `${METADATA_SCHEME}:`;
  if (!uri.startsWith(prefix)) return undefined;
  let path = uri.slice(prefix.length).replace(/[?#].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const m = /^\/+([^/]+)\/([^/]+)\.cs$/.exec(path);
  if (!m) return undefined;
  return { documentationId: `T:${m[2]}`, assemblyName: m[1]! };
}

/** File Structure (protocol 1.13) of a document of an owned route. */
/** Smart Step Into (protocol 1.14) at a stopped position of an owned route. */
export type StepIntoTargetsOutcome =
  | { kind: 'targets'; result: import('@refyntra/contracts').StepIntoTargetsResult }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

/** EF Core migrations (protocol 1.18) of the owned C# route. */
export type EfMigrationsOutcome =
  | { kind: 'migrations'; result: import('@refyntra/contracts').EfMigrationsResult }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

/** Test discovery (protocol 1.15) of the owned C# route. */
export type TestsOutcome =
  | { kind: 'tests'; result: import('@refyntra/contracts').TestsResult }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

export type FileStructureOutcome =
  | { kind: 'structure'; result: import('@refyntra/contracts').FileStructureResult }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

/** Find Usages grouped (protocol 1.12) at a position of an owned route. */
export type UsagesOutcome =
  | { kind: 'usages'; subject: import('@refyntra/contracts').SymbolRef; items: import('@refyntra/contracts').UsageItem[]; total: number; truncated: boolean; completeness: 'complete' | 'partial' | 'unknown' }
  | { kind: 'unavailable'; reasonCode: string; message: string; recoveryActions: RecoveryAction[] };

/** Call / type hierarchy (protocol 1.7) at a position of an owned route. */
export type HierarchyOutcome =
  | { kind: 'hierarchy'; subject: import('@refyntra/contracts').SymbolRef; items: import('@refyntra/contracts').HierarchyItem[]; completeness: 'complete' | 'partial' | 'unknown'; truncated: boolean }
  | Unavailable;

/** Run and Debug (protocol 1.8): the runnable-project model of the C# route, or why there is none. */
export type RunnableProjectsOutcome = { kind: 'projects'; result: import('@refyntra/contracts').RunnableProjectsResult } | Unavailable;

/** Edit actions (protocol 1.9): the actions at a range, or the edits of one action, or why not. */
export type EditActionsOutcome =
  | { kind: 'actions'; items: import('@refyntra/contracts').EditActionInfo[] }
  | { kind: 'edits'; edits: { range: import('@refyntra/contracts').Range; newText: string }[]; documentHash: string | null }
  | Unavailable;

/** Postfix templates (protocol 1.10): the templates for the expression before the dot, or why not. */
export type PostfixOutcome =
  | { kind: 'templates'; items: import('@refyntra/contracts').PostfixTemplate[]; expressionRange: import('@refyntra/contracts').Range | null; typeName: string | null }
  | Unavailable;

/** Constructor / DI actions (protocol 1.11): the actions at a position, the edits of one, a question, or the registration choices. */
export type ConstructorActionsOutcome =
  | { kind: 'actions'; items: import('@refyntra/contracts').ConstructorActionInfo[] }
  | { kind: 'edits'; files: import('@refyntra/contracts').DocumentEdits[]; note: string | null; registerTypeId: string | null; registerTypeName: string | null }
  | { kind: 'ask'; need: 'members' | 'constructor' | 'type'; choices: import('@refyntra/contracts').Choice[]; message: string }
  | { kind: 'registration'; info: import('@refyntra/contracts').RegistrationInfo }
  | Unavailable;

/** Generate (protocol 1.10): the kinds for the type at the position, or the edits of one kind, or why not. */
export type GenerateOutcome =
  | { kind: 'kinds'; typeName: string | null; kinds: import('@refyntra/contracts').GenerateKindInfo[] }
  | { kind: 'edits'; edits: { range: import('@refyntra/contracts').Range; newText: string }[]; documentHash: string | null }
  | Unavailable;

export interface ApplyOptions {
  /** The user explicitly confirmed the limitations of a plan whose validation is `limited`. */
  acceptLimited?: boolean;
  /**
   * Show the revalidated text edit in the editor's Refactor Preview and apply what the user confirms there
   * (ADR-004 Amendment 6). Text-only plans; the EditApplier still checks every hash right before handing it over.
   */
  confirmation?: import('./ports').EditConfirmation;
}

/** Boundary between presentation and application. In-process implementation: RefyntraEngine. */
export interface EngineClient {
  readonly workspaceId: string;
  handlesDocument(uri: string, languageId?: string): boolean;
  documentOpened(uri: string, languageId: string, version: number, text: string, dirty: boolean): void;
  documentChanged(uri: string, languageId: string, version: number, text: string, dirty: boolean): void;
  documentSaved(uri: string, languageId: string, version: number, text: string): void;
  documentClosed(uri: string): void;
  start(): Promise<void>;
  restart(providerRouteId?: string): Promise<void>;
  /** Non-document inputs changed (solution choice, trust granted): bump revision and restart routes. */
  inputsChanged(reason: string): Promise<void>;
  find(query: string, token?: CancellationToken, limit?: number): Promise<FindOutcome>;
  related(target: DocumentTarget, token?: CancellationToken): Promise<RelatedOutcome>;
  actions(target: DocumentTarget, token?: CancellationToken): Promise<ActionsOutcome>;
  /** options.renameFile: also rename the files named after a type, when the backend proves it safe. */
  prepareRename(target: DocumentTarget, newName: string, token?: CancellationToken, options?: PrepareOptions): Promise<RenameOutcome>;
  /**
   * Prepares a create-file refactoring of the owned route at the cursor (`csharp.moveTypeToFile`, `csharp.generateHandler`).
   * The result is applied with applyRename (same lifecycle, revalidation and EditApplier).
   */
  prepareAction(target: DocumentTarget, actionId: string, token?: CancellationToken, options?: ActionPrepareOptions): Promise<RenameOutcome>;
  /** Change Signature: the current parameters of the method at the cursor (owned route, protocol 1.6). */
  signatureAt(target: DocumentTarget, token?: CancellationToken): Promise<SignatureOutcome>;
  /**
   * Code Cleanup (`csharp.cleanup`) of a scope on the owned route `adapterId`: a text-only plan, applied with applyRename
   * (same lifecycle, revalidation and EditApplier).
   */
  prepareCleanup(cleanup: import('@refyntra/contracts').CleanupParams, token?: CancellationToken, adapterId?: string): Promise<RenameOutcome>;
  applyRename(planId: string, token?: CancellationToken, options?: ApplyOptions): Promise<ApplyOutcome>;
  /**
   * Call / type hierarchy (owned route, protocol 1.7): the symbol at the position and its neighbours in `direction`
   * ('subject' resolves only the symbol, with no items).
   */
  hierarchy(target: DocumentTarget, direction: import('@refyntra/contracts').HierarchyDirection | 'subject', token?: CancellationToken): Promise<HierarchyOutcome>;
  /** File Structure (owned route, protocol 1.13): the types and members of the document, optionally inherited members. */
  fileStructure?(uri: string, includeInherited: boolean, token?: CancellationToken): Promise<FileStructureOutcome>;
  /** Smart Step Into (owned route, protocol 1.14): the calls of the statement a debugger stopped at. */
  stepIntoTargets?(uri: string, position: Position, token?: CancellationToken): Promise<StepIntoTargetsOutcome>;
  /**
   * Go to metadata (owned route, protocol 1.17): the decompiled / embedded-source document of a metadata symbol, or the
   * symbol at a position inside such a document.
   */
  metadataSource?(params: import('./adapters').MetadataSourceRequest, token?: CancellationToken): Promise<MetadataSourceOutcome>;
  /** Test discovery (owned route, protocol 1.15): every test project, or only the given documents. */
  tests?(uris?: string[], token?: CancellationToken): Promise<TestsOutcome>;
  /** EF Core migrations (owned route, protocol 1.18): DbContexts, migrations, snapshots and configurations from source. */
  efMigrations?(token?: CancellationToken): Promise<EfMigrationsOutcome>;
  /** Find Usages grouped (owned route, protocol 1.12): classified usages of the symbol at the position, at most `limit`. */
  usages(target: DocumentTarget, limit: number, token?: CancellationToken): Promise<UsagesOutcome>;
  /** Run and Debug (protocol 1.8): the C# projects of the loaded workspace classified for running and debugging. */
  runnableProjects?(token?: CancellationToken): Promise<RunnableProjectsOutcome>;
  /**
   * Edit actions (owned route, protocol 1.9): without `actionId` the actions at the range; with it the edits of that
   * action, computed and compile-checked by the backend (or why it is refused).
   */
  editActions?(target: { uri: string; range: import('@refyntra/contracts').Range }, actionId?: string, token?: CancellationToken): Promise<EditActionsOutcome>;
  /** Postfix templates (owned route, protocol 1.10) after the dot before the position. */
  postfix?(target: DocumentTarget, token?: CancellationToken): Promise<PostfixOutcome>;
  /** Generate (owned route, protocol 1.10): without `request` the kinds for the type at the position; with it the edits. */
  generate?(target: DocumentTarget, request?: import('./adapters').GenerateRequest, token?: CancellationToken): Promise<GenerateOutcome>;
  /** Constructor / DI actions (owned route, protocol 1.11): without `request` the actions at the position. */
  constructorActions?(target: DocumentTarget, request?: import('./adapters').ConstructorRequest, token?: CancellationToken): Promise<ConstructorActionsOutcome>;
  discardPlan(planId: string): void;
  planState(planId: string): PlanState | undefined;
  /** Rule analysis (`analysis/run`) of every route that offers it; one outcome per route, never throws except on cancel. */
  analyze(options?: import('./adapters').AnalyzeRequest, token?: CancellationToken): Promise<AnalysisOutcome[]>;
  /** Structural search (owned route, protocol 1.19). */
  structuralSearch?(params: import('./adapters').StructuralSearchRequest, token?: CancellationToken): Promise<StructuralSearchOutcome>;
  health(): HealthSummary;
  readonly onDidChangeHealth: (l: (h: HealthSummary) => void) => Disposable;
  /** Fires when previously shown results may be invalid (epoch change). */
  readonly onDidInvalidate: (l: (providerRouteId: string) => void) => Disposable;
  dispose(): Promise<void>;
}

export interface EngineOptions {
  workspaceId: string;
  registry: AdapterRegistry;
  tracker: DocumentTracker;
  editApplier: EditApplier;
  settings: ApplicationSettings;
  logger: Logger;
  isTrusted: () => boolean;
  /** How many times a request is retried after its result was dropped as stale. */
  staleRetries?: number;
  /** Frontend ↔ backend HTTP linking (heuristic): answers Find `client:`. Its framework modules are registered separately. */
  httpLinks?: Pick<HttpLinkService, 'find'>;
  /** HTML/CSS links: answers Find `css:` (class and id selectors). Its route and framework module are registered separately. */
  webStyles?: { find(text: string, limit: number, token?: CancellationToken): Promise<{ items: FindItem[]; truncated: boolean }> };
  /** React / Next.js / Angular (web worker): answers Find `component:` and `page:`. Its framework module is registered separately. */
  webFrameworks?: { find(kind: 'component' | 'page', text: string, limit: number, token?: CancellationToken): Promise<{ items: FindItem[]; truncated: boolean; notes: string[] }> };
}

interface PlanEntry {
  lifecycle: PlanLifecycle;
  adapter: LanguageAdapter;
  workspaceRevision: number;
}

const DEFAULT_FIND_LIMIT = 200;

/** Last path segment of a URI, decoded (for messages). */
function baseName(uri: string): string {
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export class RefyntraEngine implements EngineClient {
  readonly workspaceId: string;
  private readonly o: EngineOptions;
  private readonly plans = new Map<string, PlanEntry>();
  private readonly relatedCache = new BoundedCache<RelatedView>(64);
  private readonly subs: Disposable[] = [];
  private readonly healthEmitter = new Emitter<HealthSummary>();
  private readonly invalidateEmitter = new Emitter<string>();
  readonly onDidChangeHealth = this.healthEmitter.event;
  readonly onDidInvalidate = this.invalidateEmitter.event;

  constructor(options: EngineOptions) {
    this.o = options;
    this.workspaceId = options.workspaceId;
    this.subs.push(options.tracker.onDidRecord((e) => this.o.registry.routeFor(e.uri, e.languageId)?.documentEvent(e)));
    for (const adapter of options.registry.languageAdapters()) {
      this.subs.push(adapter.onDidChangeHealth(() => this.healthEmitter.fire(this.health())));
      this.subs.push(adapter.onDidChangeEpoch(() => this.onEpochChanged(adapter)));
    }
  }

  // ---------------------------------------------------------------- documents

  handlesDocument(uri: string, languageId?: string): boolean {
    return this.o.registry.routeFor(uri, languageId) !== undefined;
  }

  documentOpened(uri: string, languageId: string, version: number, text: string, dirty: boolean): void {
    if (this.handlesDocument(uri, languageId)) this.o.tracker.open(uri, languageId, version, text, dirty);
  }

  documentChanged(uri: string, languageId: string, version: number, text: string, dirty: boolean): void {
    if (this.handlesDocument(uri, languageId)) this.o.tracker.change(uri, languageId, version, text, dirty);
  }

  documentSaved(uri: string, languageId: string, version: number, text: string): void {
    if (this.handlesDocument(uri, languageId)) this.o.tracker.save(uri, languageId, version, text);
  }

  documentClosed(uri: string): void {
    this.o.tracker.close(uri);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    await Promise.all(this.o.registry.languageAdapters().map((a) => a.start().catch((e) => this.log('error', 'start failed', { route: a.descriptor.providerRouteId, error: describeError(e) }))));
  }

  async restart(providerRouteId?: string): Promise<void> {
    const targets = this.o.registry.languageAdapters().filter((a) => !providerRouteId || a.descriptor.providerRouteId === providerRouteId);
    await Promise.all(targets.map((a) => a.restart('user')));
  }

  async inputsChanged(reason: string): Promise<void> {
    this.o.tracker.bumpRevision();
    this.relatedCache.clear();
    // Provider route / solution / trust change: every prepared plan is invalid.
    this.invalidatePlans(undefined, `inputs changed: ${reason}`);
    this.log('info', 'inputs changed', { reason });
    await this.restart();
  }

  private onEpochChanged(adapter: LanguageAdapter): void {
    const route = adapter.descriptor.providerRouteId;
    // A new (or no) epoch invalidates every id, plan and cached result of this route.
    this.invalidatePlans(adapter, 'backend session changed');
    this.relatedCache.clear();
    this.invalidateEmitter.fire(route);
  }

  /** Marks plans Stale (not ones already applying: the editor decides those). */
  private invalidatePlans(adapter: LanguageAdapter | undefined, reason: string): void {
    for (const [planId, entry] of this.plans) {
      if (adapter && entry.adapter !== adapter) continue;
      entry.lifecycle.tryTransition('Stale', reason);
      if (entry.lifecycle.isTerminal) this.plans.delete(planId);
    }
  }

  health(): HealthSummary {
    return { adapters: this.o.registry.languageAdapters().map((a) => a.health()), workspaceTrusted: this.o.isTrusted() };
  }

  async dispose(): Promise<void> {
    for (const s of this.subs) s.dispose();
    for (const [, entry] of this.plans) entry.lifecycle.tryTransition('Discarded', 'shutdown');
    this.plans.clear();
    await Promise.all(this.o.registry.languageAdapters().map((a) => a.dispose().catch(() => undefined)));
    this.healthEmitter.dispose();
    this.invalidateEmitter.dispose();
  }

  // ---------------------------------------------------------------- Find

  async find(query: string, token?: CancellationToken, limit = DEFAULT_FIND_LIMIT): Promise<FindOutcome> {
    const parsed = parseFindQuery(query);
    const outcome: FindOutcome = { query: parsed, items: [], truncated: false, notes: [], routeLabels: {} };
    if (parsed.errors.length > 0) return outcome;
    if (parsed.client) return this.findClientCalls(parsed, outcome, token, limit);
    if (parsed.css) return this.findStyles(parsed, outcome, token, limit);
    if (parsed.web) return this.findWeb(parsed.web, parsed, outcome, token, limit);
    if (parsed.text.length === 0 && !hasAnyFilter(parsed.filters)) return outcome;
    const lists: FindItem[][] = [];
    await Promise.all(
      this.o.registry.languageAdapters().map(async (adapter) => {
        if (!adapter.descriptor.operations.includes('find')) return;
        const h = adapter.health();
        if (!acceptsSemanticRequests(h.state) && h.state !== 'Loading' && h.state !== 'Restarting') {
          outcome.notes.push(`${h.displayName}: ${h.state}${h.message ? ` — ${h.message}` : ''}`);
          return;
        }
        try {
          const r = await this.withStaleRetry(() => adapter.search({ query: parsed.text, filters: parsed.filters, limit }, token), token);
          const d = adapter.descriptor;
          outcome.routeLabels![d.providerRouteId] = d.ownership === 'delegated' ? `${d.displayName} (delegated)` : d.displayName;
          if (d.ownership === 'delegated') outcome.notes.push(delegatedFindNote(d.displayName));
          lists.push(r.value.items.map((i) => toFindItem(i, adapter.descriptor.providerRouteId)).filter((x): x is FindItem => !!x));
          if (r.value.truncated) outcome.truncated = true;
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          outcome.notes.push(this.noteFor(adapter, e));
        }
      }),
    );
    throwIfCancelled(token);
    const merged = mergeFindItems(lists);
    if (merged.length > limit) outcome.truncated = true;
    outcome.items = merged.slice(0, limit);
    outcome.notes.sort();
    return outcome;
  }

  /** Find `client:`: HTTP client call sites (heuristic), unlinked ones unless `client:all`. */
  private async findClientCalls(parsed: ParsedFindQuery, outcome: FindOutcome, token: CancellationToken | undefined, limit: number): Promise<FindOutcome> {
    if (!this.o.httpLinks) {
      outcome.notes.push('HTTP links: not available in this host.');
      return outcome;
    }
    try {
      const r = await this.o.httpLinks.find(parsed.client ?? 'unlinked', parsed.text, limit, token);
      outcome.items = r.items;
      outcome.truncated = r.truncated;
      outcome.routeLabels!['http.links'] = 'HTTP links (heuristic)';
      outcome.notes.push('HTTP links: heuristic — client calls are found by their literal URL text; calls built at runtime are not linked.');
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      outcome.notes.push(`HTTP links: ${describeErrorWithRecovery(e)}`);
    }
    return outcome;
  }

  /** Find `css:`: class and id selectors of the workspace stylesheets and <style> blocks. */
  private async findStyles(parsed: ParsedFindQuery, outcome: FindOutcome, token: CancellationToken | undefined, limit: number): Promise<FindOutcome> {
    if (!this.o.webStyles) {
      outcome.notes.push('HTML/CSS: not available in this host.');
      return outcome;
    }
    if (!this.o.isTrusted()) {
      outcome.notes.push('HTML/CSS: Restricted Mode — trust the workspace to search stylesheets.');
      return outcome;
    }
    try {
      const r = await this.o.webStyles.find(parsed.text, limit, token);
      outcome.items = r.items;
      outcome.truncated = r.truncated;
      outcome.routeLabels!['web.styles'] = 'HTML/CSS';
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      outcome.notes.push(`HTML/CSS: ${describeErrorWithRecovery(e)}`);
    }
    return outcome;
  }

  /** Find `component:` / `page:`: React and Angular components, Next.js and Angular routes (web worker). */
  private async findWeb(kind: 'component' | 'page', parsed: ParsedFindQuery, outcome: FindOutcome, token: CancellationToken | undefined, limit: number): Promise<FindOutcome> {
    if (!this.o.webFrameworks) {
      outcome.notes.push('React / Next.js / Angular: not available in this host.');
      return outcome;
    }
    try {
      const r = await this.o.webFrameworks.find(kind, parsed.text, limit, token);
      outcome.items = r.items;
      outcome.truncated = r.truncated;
      outcome.notes.push(...r.notes.map((n) => `React / Next.js / Angular: ${n}`));
      if (kind === 'page') outcome.notes.push('Routes: file-system and route-definition conventions only; middleware, rewrites, redirects and guards are not resolved.');
      outcome.routeLabels!['web.frameworks'] = 'React / Next.js / Angular';
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      outcome.notes.push(`React / Next.js / Angular: ${describeErrorWithRecovery(e)}`);
    }
    return outcome;
  }

  // ---------------------------------------------------------------- Stack frames

  /** Resolves a .NET stack frame by symbol on the routes that offer it (the C# route). Read-only. */
  async resolveFrame(req: import('@refyntra/contracts').ResolveFrameRequest, token?: CancellationToken): Promise<ResolveFrameOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => typeof a.resolveFrame === 'function');
    if (!adapter?.resolveFrame) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra language route resolves .NET stack frames.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const r = await this.withStaleRetry(() => adapter.resolveFrame!(req, token), token);
      return { kind: 'candidates', candidates: r.value.candidates };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  // ---------------------------------------------------------------- Related

  async related(target: DocumentTarget, token?: CancellationToken): Promise<RelatedOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || !adapter.descriptor.operations.includes('related')) {
      return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra language route handles this file.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    }
    const cacheKey = `${adapter.descriptor.providerRouteId}|${adapter.currentEpoch() ?? '-'}|${this.o.tracker.revision}|${target.uri}|${target.position.line}:${target.position.character}`;
    const cached = this.relatedCache.get(cacheKey);
    if (cached) return cached;
    try {
      const r = await this.withStaleRetry(() => adapter.related({ uri: target.uri, position: target.position }, token), token);
      const extra: AnyRelation[][] = [];
      const scopeNotes = [...r.value.scopeNotes];
      const additionalNotes: string[] = [];
      for (const fw of this.o.registry.frameworksFor(adapter.descriptor.providerRouteId)) {
        try {
          extra.push(await fw.related({ subject: r.value.subject, languageResult: r, language: adapter, target: { uri: target.uri, position: target.position }, ...(token ? { token } : {}) }));
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          const note = `${fw.descriptor.displayName}: ${describeError(e)}`;
          scopeNotes.push(note);
          additionalNotes.push(note);
        }
      }
      throwIfCancelled(token);
      // Framework results were computed after the language result; drop everything if the epoch moved meanwhile.
      if (adapter.currentEpoch() !== r.sessionEpoch || this.o.tracker.revision !== r.workspaceRevision) throw new StaleResultError('revision');
      const view: RelatedView = {
        kind: 'related',
        subject: r.value.subject,
        groups: groupRelations(mergeRelations([r.value.relations, ...extra])),
        completeness: r.value.completeness,
        scopeNotes,
        ...(r.value.scopeDetails ? { scopeDetails: r.value.scopeDetails } : {}),
        additionalNotes,
        providerRouteId: r.providerRouteId,
        sessionEpoch: r.sessionEpoch,
        snapshotId: r.snapshotId,
        workspaceRevision: r.workspaceRevision,
      };
      this.relatedCache.set(cacheKey, view);
      return view;
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const fallback = await this.relatedWithoutLanguage(adapter, target, e, token);
      return fallback ?? this.toUnavailable(adapter, e);
    }
  }

  /**
   * The language route gave no result at the position (e.g. the cursor is inside a URL string): text-pattern framework
   * modules (HTTP links) may still answer. Their relations are shown with the route's explanation as a note.
   */
  private async relatedWithoutLanguage(adapter: LanguageAdapter, target: DocumentTarget, cause: unknown, token?: CancellationToken): Promise<RelatedView | undefined> {
    if (cause instanceof StaleResultError || cause instanceof AdapterUnavailableError) return undefined;
    const lists: AnyRelation[][] = [];
    for (const fw of this.o.registry.frameworksFor(adapter.descriptor.providerRouteId)) {
      if (!fw.relatedWithoutLanguage) continue;
      try {
        lists.push(await fw.relatedWithoutLanguage({ uri: target.uri, position: target.position }, token));
      } catch (e) {
        if (e instanceof CancelledError) throw e;
      }
    }
    if (!lists.some((l) => l.length > 0)) return undefined;
    const note = this.noteFor(adapter, cause);
    return {
      kind: 'related',
      subject: null,
      groups: groupRelations(mergeRelations(lists)),
      completeness: 'unknown',
      scopeNotes: [note],
      additionalNotes: [note],
      providerRouteId: adapter.descriptor.providerRouteId,
      sessionEpoch: adapter.currentEpoch() ?? 'unknown',
      snapshotId: 'unknown',
      workspaceRevision: this.o.tracker.revision,
    };
  }

  // ---------------------------------------------------------------- Actions

  async actions(target: DocumentTarget, token?: CancellationToken): Promise<ActionsOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter) {
      return {
        items: [
          unavailable({ capabilityId: 'refyntra.actions', providerRouteId: 'none', workspaceId: this.workspaceId, reasonCode: 'NoLanguageRoute', message: 'No Refyntra language route handles this file.', recoveryActions: [RECOVERY_SHOW_HEALTH], documentUri: target.uri }),
        ],
        note: 'This file type is not handled by Refyntra.',
      };
    }
    const h = adapter.health();
    const explainDown = (reasonCode: string, message: string, recovery: RecoveryAction[]): ActionsOutcome => ({
      items: adapter.descriptor.capabilityIds.map((capabilityId) =>
        unavailable({ capabilityId, providerRouteId: adapter.descriptor.providerRouteId, workspaceId: this.workspaceId, reasonCode, message, recoveryActions: recovery.length ? recovery : [RECOVERY_SHOW_HEALTH], documentUri: target.uri }),
      ),
      note: message,
    });
    if (!acceptsSemanticRequests(h.state) && h.state !== 'Loading' && h.state !== 'Restarting' && h.state !== 'NotStarted') {
      return explainDown(h.reasonCode ?? h.state, h.message ?? `${h.displayName} is ${h.state}`, h.recoveryActions);
    }
    try {
      const r = await this.withStaleRetry(() => adapter.capabilities({ uri: target.uri, position: target.position }, token), token);
      const items = sortAvailability(r.value);
      return items.length > 0 ? { items } : { items, note: `${h.displayName}: no actions are known at this position.` };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const u = this.toUnavailable(adapter, e);
      return explainDown(u.reasonCode, u.message, u.recoveryActions);
    }
  }

  // ---------------------------------------------------------------- Rename (prepare/preview/apply)

  async prepareRename(target: DocumentTarget, newName: string, token?: CancellationToken, options: PrepareOptions = {}): Promise<RenameOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || !adapter.descriptor.operations.includes('rename') || !adapter.descriptor.renameActionId) {
      return { kind: 'unavailable', reasonCode: 'RenameNotSupported', message: 'Rename is not provided for this file by Refyntra.', recoveryActions: [] };
    }
    if (adapter.descriptor.ownership === 'delegated') return this.prepareDelegatedRename(adapter, target, newName, token);
    const actionId = adapter.descriptor.renameActionId;
    try {
      const prepared = await this.withStaleRetry(async () => {
        const sym = await adapter.symbolAt(target.uri, target.position, token);
        if (!sym.value || !sym.value.symbolId) return undefined;
        const p = await adapter.prepare({ symbolId: sym.value.symbolId, newName, actionId, ...(options.renameFile ? { renameFile: true } : {}), ...(options.generatedEdits ? { generatedEdits: options.generatedEdits } : {}) }, token);
        if (p.sessionEpoch !== sym.sessionEpoch) throw new StaleResultError('epoch');
        return p;
      }, token);
      if (!prepared) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: 'There is no renameable symbol at the cursor.', recoveryActions: [] };
      const result = prepared.value;
      if (result.kind !== 'prepared') {
        return { kind: 'unavailable', reasonCode: result.reasonCode ?? 'Unavailable', message: result.message ?? 'Rename is unavailable here.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
      }
      const plan = result.plan;
      const issues = validatePlanStructure(plan);
      if (plan.sessionEpoch !== prepared.sessionEpoch) issues.push({ code: 'wrong-kind', message: 'Plan belongs to a different backend session' });
      const lifecycle = new PlanLifecycle(plan);
      this.plans.set(plan.planId, { lifecycle, adapter, workspaceRevision: prepared.workspaceRevision });
      if (issues.length > 0) lifecycle.transition('Failed', issues.map((i) => i.message).join('; '));
      else lifecycle.transition('Previewing');
      return { kind: 'preview', planId: plan.planId, plan, state: lifecycle.state, issues, applyEnabled: this.o.settings.applyRenameEnabled() && issues.length === 0 };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async prepareAction(target: DocumentTarget, actionId: string, token?: CancellationToken, options: ActionPrepareOptions = {}): Promise<RenameOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || !adapter.descriptor.capabilityIds.length) {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'This action is not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const extra = {
        ...(options.targetFolderUri ? { targetFolderUri: options.targetFolderUri } : {}),
        ...(options.range ? { range: options.range } : {}),
        ...(options.signature ? { signature: options.signature } : {}),
        ...(options.registration ? { registration: options.registration } : {}),
        ...(options.fixAll ? { fixAll: options.fixAll } : {}),
        ...(options.structural ? { structural: options.structural } : {}),
      };
      const prepared = await this.withStaleRetry(async () => {
        // Extract Method works on a selection: no symbol is needed at the cursor.
        if (options.range || options.structural) return adapter.prepare({ symbolId: '', newName: options.newName ?? '', actionId, documentUri: target.uri, ...extra }, token);
        const sym = await adapter.symbolAt(target.uri, target.position, token);
        if (!sym.value || !sym.value.symbolId) return undefined;
        const p = await adapter.prepare({ symbolId: sym.value.symbolId, newName: options.newName ?? '', actionId, documentUri: target.uri, ...extra }, token);
        if (p.sessionEpoch !== sym.sessionEpoch) throw new StaleResultError('epoch');
        return p;
      }, token);
      if (!prepared) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: 'There is no symbol at the cursor.', recoveryActions: [] };
      const result = prepared.value;
      if (result.kind !== 'prepared') {
        return { kind: 'unavailable', reasonCode: result.reasonCode ?? 'Unavailable', message: result.message ?? 'The action is unavailable here.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
      }
      const plan = result.plan;
      const issues = validatePlanStructure(plan);
      if (plan.sessionEpoch !== prepared.sessionEpoch) issues.push({ code: 'wrong-kind', message: 'Plan belongs to a different backend session' });
      if (plan.actionId !== actionId) issues.push({ code: 'wrong-kind', message: `The plan is for ${plan.actionId}, not ${actionId}` });
      const lifecycle = new PlanLifecycle(plan);
      this.plans.set(plan.planId, { lifecycle, adapter, workspaceRevision: prepared.workspaceRevision });
      if (issues.length > 0) lifecycle.transition('Failed', issues.map((i) => i.message).join('; '));
      else lifecycle.transition('Previewing');
      return { kind: 'preview', planId: plan.planId, plan, state: lifecycle.state, issues, applyEnabled: this.o.settings.applyRenameEnabled() && issues.length === 0 };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async signatureAt(target: DocumentTarget, token?: CancellationToken): Promise<SignatureOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.signatureAt !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Change Signature is not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.signatureAt!(target.uri, target.position, token), token);
      const info = r.value;
      if (!info) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: 'There is no method or constructor at the cursor.', recoveryActions: [] };
      if (info.reasonCode) return { kind: 'unavailable', reasonCode: info.reasonCode, message: info.message ?? 'Change Signature is unavailable here.', recoveryActions: [] };
      return { kind: 'signature', info };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async hierarchy(target: DocumentTarget, direction: import('@refyntra/contracts').HierarchyDirection | 'subject', token?: CancellationToken): Promise<HierarchyOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.hierarchy !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Call and type hierarchy are not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.hierarchy!(target.uri, target.position, direction, token), token);
      const { subject, result } = r.value;
      if (!subject) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: 'There is no symbol at the cursor.', recoveryActions: [] };
      if (direction !== 'subject' && !result) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for the hierarchy; update the extension.', recoveryActions: [] };
      return { kind: 'hierarchy', subject, items: result?.items ?? [], completeness: result?.completeness ?? 'complete', truncated: result?.truncated ?? false };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async fileStructure(uri: string, includeInherited: boolean, token?: CancellationToken): Promise<FileStructureOutcome> {
    const adapter = this.o.registry.routeFor(uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.fileStructure !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'File Structure from the host is provided for C# files only.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.fileStructure!(uri, includeInherited, token), token);
      const result = r.value;
      if (!result) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for File Structure; update the extension.', recoveryActions: [] };
      if (result.reasonCode) return { kind: 'unavailable', reasonCode: result.reasonCode, message: 'This file is not part of the loaded solution.', recoveryActions: [] };
      return { kind: 'structure', result };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async stepIntoTargets(uri: string, position: Position, token?: CancellationToken): Promise<StepIntoTargetsOutcome> {
    const adapter = this.o.registry.routeFor(uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.stepIntoTargets !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Smart Step Into is provided for C# files only.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.stepIntoTargets!(uri, position, token), token);
      const result = r.value;
      if (!result) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for Smart Step Into; update the extension.', recoveryActions: [] };
      if (result.reasonCode) return { kind: 'unavailable', reasonCode: result.reasonCode, message: result.reasonCode === 'DocumentNotFound' ? 'This file is not part of the loaded solution.' : 'No statement at the stopped position.', recoveryActions: [] };
      return { kind: 'targets', result };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async tests(uris?: string[], token?: CancellationToken): Promise<TestsOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.ownership === 'owned-semantic' && typeof a.tests === 'function');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra route discovers .NET tests.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const r = await this.withStaleRetry(() => adapter.tests!(uris, token), token);
      if (!r.value) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for test discovery; update the extension.', recoveryActions: [] };
      return { kind: 'tests', result: r.value };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async structuralSearch(params: import('./adapters').StructuralSearchRequest, token?: CancellationToken): Promise<StructuralSearchOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.ownership === 'owned-semantic' && typeof a.structuralSearch === 'function');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra route provides structural search.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const r = await this.withStaleRetry(() => adapter.structuralSearch!(params, token), token);
      if (!r.value) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for structural search; update the extension.', recoveryActions: [] };
      return { kind: 'structural', result: r.value };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async metadataSource(params: import('./adapters').MetadataSourceRequest, token?: CancellationToken): Promise<MetadataSourceOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.ownership === 'owned-semantic' && typeof a.metadataSource === 'function');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra route provides decompiled sources.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const r = await this.withStaleRetry(() => adapter.metadataSource!(params, token), token);
      if (!r.value) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for decompiled sources; update the extension.', recoveryActions: [] };
      return { kind: 'metadata', result: r.value };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  /** Find Usages from a metadata document (protocol 1.17): the symbol at the position, then its usages in the solution. */
  private async metadataUsages(target: DocumentTarget, limit: number, token?: CancellationToken): Promise<UsagesOutcome> {
    const document = metadataDocumentRef(target.uri)!;
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.ownership === 'owned-semantic' && typeof a.metadataSource === 'function' && typeof a.usagesOfSymbol === 'function');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra route finds usages of library symbols.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const at = await this.withStaleRetry(() => adapter.metadataSource!({ document, position: target.position, symbolOnly: true }, token), token);
      if (!at.value) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for decompiled sources; update the extension.', recoveryActions: [] };
      const subject = at.value.symbol;
      if (!subject?.symbolId) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: at.value.message ?? 'There is no symbol at the cursor.', recoveryActions: [] };
      const r = await this.withStaleRetry(() => adapter.usagesOfSymbol!(subject.symbolId!, limit, token), token);
      const { result } = r.value;
      if (!result) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for Find Usages; update the extension.', recoveryActions: [] };
      return { kind: 'usages', subject: r.value.subject ?? subject, items: result.items, total: result.total, truncated: result.truncated, completeness: result.completeness };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async efMigrations(token?: CancellationToken): Promise<EfMigrationsOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.ownership === 'owned-semantic' && typeof a.efMigrations === 'function');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra route reads EF Core migrations.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const r = await this.withStaleRetry(() => adapter.efMigrations!(token), token);
      if (!r.value) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for the EF Core view; update the extension.', recoveryActions: [] };
      return { kind: 'migrations', result: r.value };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async usages(target: DocumentTarget, limit: number, token?: CancellationToken): Promise<UsagesOutcome> {
    if (metadataDocumentRef(target.uri)) return this.metadataUsages(target, limit, token);
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.usages !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Find Usages is provided by Refyntra for C# files only.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.usages!(target.uri, target.position, limit, token), token);
      const { subject, result } = r.value;
      if (!subject) return { kind: 'unavailable', reasonCode: 'NoSymbol', message: 'There is no symbol at the cursor.', recoveryActions: [] };
      if (!result) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for Find Usages; update the extension.', recoveryActions: [] };
      return { kind: 'usages', subject, items: result.items, total: result.total, truncated: result.truncated, completeness: result.completeness };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async editActions(target: { uri: string; range: import('@refyntra/contracts').Range }, actionId?: string, token?: CancellationToken): Promise<EditActionsOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.editActions !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Edit actions are not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.editActions!(target.uri, target.range, actionId, token), token);
      const v = r.value;
      if (!v) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for these actions; update the extension.', recoveryActions: [] };
      if (!actionId) return { kind: 'actions', items: v.items };
      if (!v.edits) return { kind: 'unavailable', reasonCode: v.reasonCode ?? 'Unavailable', message: v.message ?? 'The action is unavailable here.', recoveryActions: [] };
      return { kind: 'edits', edits: v.edits, documentHash: v.documentHash ?? null };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async postfix(target: DocumentTarget, token?: CancellationToken): Promise<PostfixOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.postfix !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Postfix templates are not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.postfix!(target.uri, target.position, token), token);
      const v = r.value;
      if (!v) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for postfix templates; update the extension.', recoveryActions: [] };
      return { kind: 'templates', items: v.items, expressionRange: v.expressionRange ?? null, typeName: v.typeName ?? null };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async generate(target: DocumentTarget, request?: import('./adapters').GenerateRequest, token?: CancellationToken): Promise<GenerateOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.generate !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Generate is not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.generate!(target.uri, target.position, request, token), token);
      const v = r.value;
      if (!v) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for Generate; update the extension.', recoveryActions: [] };
      if (!request) return { kind: 'kinds', typeName: v.typeName ?? null, kinds: v.kinds };
      if (!v.edits) return { kind: 'unavailable', reasonCode: v.reasonCode ?? 'Unavailable', message: v.message ?? 'Nothing can be generated here.', recoveryActions: [] };
      return { kind: 'edits', edits: v.edits, documentHash: v.documentHash ?? null };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async constructorActions(target: DocumentTarget, request?: import('./adapters').ConstructorRequest, token?: CancellationToken): Promise<ConstructorActionsOutcome> {
    const adapter = this.o.registry.routeFor(target.uri);
    if (!adapter || adapter.descriptor.ownership !== 'owned-semantic' || typeof adapter.constructorActions !== 'function') {
      return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Constructor actions are not provided for this file by Refyntra.', recoveryActions: [] };
    }
    try {
      const r = await this.withStaleRetry(() => adapter.constructorActions!(target.uri, target.position, request, token), token);
      const v = r.value;
      if (!v) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for the constructor actions; update the extension.', recoveryActions: [] };
      if (!request) return { kind: 'actions', items: v.items };
      if (v.registration) return { kind: 'registration', info: v.registration };
      if (v.need && v.choices) return { kind: 'ask', need: v.need, choices: v.choices, message: v.message ?? '' };
      if (!v.files) return { kind: 'unavailable', reasonCode: v.reasonCode ?? 'Unavailable', message: v.message ?? 'The action is not available here.', recoveryActions: [] };
      return { kind: 'edits', files: v.files, note: v.note ?? null, registerTypeId: v.registerTypeId ?? null, registerTypeName: v.registerTypeName ?? null };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async runnableProjects(token?: CancellationToken): Promise<RunnableProjectsOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.ownership === 'owned-semantic' && typeof a.runnableProjects === 'function');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'NoLanguageRoute', message: 'No Refyntra route provides a .NET project model.', recoveryActions: [RECOVERY_SHOW_HEALTH] };
    try {
      const result = await adapter.runnableProjects!(token);
      if (!result) return { kind: 'unavailable', reasonCode: 'ProtocolTooOld', message: 'The C# host is too old for Run and Debug; update the extension.', recoveryActions: [] };
      return { kind: 'projects', result };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  async prepareCleanup(cleanup: import('@refyntra/contracts').CleanupParams, token?: CancellationToken, adapterId = 'csharp'): Promise<RenameOutcome> {
    const adapter = this.o.registry.languageAdapters().find((a) => a.descriptor.adapterId === adapterId && a.descriptor.ownership === 'owned-semantic');
    if (!adapter) return { kind: 'unavailable', reasonCode: 'ActionNotSupported', message: 'Code Cleanup is not provided by a Refyntra route here.', recoveryActions: [] };
    try {
      const prepared = await this.withStaleRetry(() => adapter.prepare({ symbolId: '', newName: '', actionId: CSHARP_CLEANUP_ACTION, cleanup }, token), token);
      const result = prepared.value;
      if (result.kind !== 'prepared') {
        return { kind: 'unavailable', reasonCode: result.reasonCode ?? 'Unavailable', message: result.message ?? 'Code Cleanup is unavailable.', recoveryActions: result.reasonCode === 'NoChanges' ? [] : [RECOVERY_SHOW_HEALTH] };
      }
      const plan = result.plan;
      const issues = validatePlanStructure(plan);
      if (plan.sessionEpoch !== prepared.sessionEpoch) issues.push({ code: 'wrong-kind', message: 'Plan belongs to a different backend session' });
      if (plan.actionId !== CSHARP_CLEANUP_ACTION) issues.push({ code: 'wrong-kind', message: `The plan is for ${plan.actionId}, not ${CSHARP_CLEANUP_ACTION}` });
      if ((plan.writeSet as readonly PlannedChange[]).some((c) => c.kind !== 'text')) issues.push({ code: 'unsupported-change', message: 'A cleanup plan may only change text' });
      const lifecycle = new PlanLifecycle(plan);
      this.plans.set(plan.planId, { lifecycle, adapter, workspaceRevision: prepared.workspaceRevision });
      if (issues.length > 0) lifecycle.transition('Failed', issues.map((i) => i.message).join('; '));
      else lifecycle.transition('Previewing');
      return { kind: 'preview', planId: plan.planId, plan, state: lifecycle.state, issues, applyEnabled: this.o.settings.applyRenameEnabled() && issues.length === 0 };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  /** Delegated rename preparation; the plan is never `valid`. */
  private async prepareDelegatedRename(adapter: LanguageAdapter, target: DocumentTarget, newName: string, token?: CancellationToken): Promise<RenameOutcome> {
    const port = adapter.delegatedRename;
    if (!port) return { kind: 'unavailable', reasonCode: 'RenameNotSupported', message: `${adapter.descriptor.displayName}: rename is not provided by Refyntra.`, recoveryActions: [nativeRenameRecovery(target.uri, target.position)] };
    try {
      const prepared = await port.prepare({ uri: target.uri, position: target.position, newName }, token);
      throwIfCancelled(token);
      const result = prepared.value;
      if (result.kind !== 'prepared') {
        return { kind: 'unavailable', reasonCode: result.reasonCode, message: result.message, recoveryActions: result.nativeFallback ? [nativeRenameRecovery(target.uri, target.position)] : [] };
      }
      const plan = result.plan;
      // Prepared on a state that is already gone (an edit or a route restart during preparation): refuse at once.
      if (adapter.currentEpoch() !== prepared.sessionEpoch || plan.bridgeEpoch !== prepared.sessionEpoch || this.o.tracker.revision !== prepared.workspaceRevision) {
        return { kind: 'unavailable', reasonCode: 'DocumentChanged', message: 'The code changed while the rename was being prepared. Run Rename again.', recoveryActions: [] };
      }
      const issues = validatePlanStructure(plan);
      if (plan.providerRouteId !== adapter.descriptor.providerRouteId) issues.push({ code: 'wrong-kind', message: 'The plan belongs to a different route' });
      const lifecycle = new PlanLifecycle<AnyRefactorPlan>(plan);
      this.plans.set(plan.planId, { lifecycle, adapter, workspaceRevision: prepared.workspaceRevision });
      if (issues.length > 0) lifecycle.transition('Failed', issues.map((i) => i.message).join('; '));
      else lifecycle.transition('Previewing');
      return { kind: 'preview', planId: plan.planId, plan, state: lifecycle.state, issues, applyEnabled: this.o.settings.applyRenameEnabled() && issues.length === 0 };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return this.toUnavailable(adapter, e);
    }
  }

  planState(planId: string): PlanState | undefined {
    return this.plans.get(planId)?.lifecycle.state;
  }

  // ---------------------------------------------------------------- Analysis (rules)

  async analyze(options: import('./adapters').AnalyzeRequest = {}, token?: CancellationToken): Promise<AnalysisOutcome[]> {
    const adapters = this.o.registry.languageAdapters().filter((a) => typeof a.analyze === 'function' && (!options.uri || a === this.o.registry.routeFor(options.uri)));
    return Promise.all(
      adapters.map(async (adapter): Promise<AnalysisOutcome> => {
        const providerRouteId = adapter.descriptor.providerRouteId;
        try {
          const r = await this.withStaleRetry(() => adapter.analyze!(options, token), token);
          return { kind: 'analysis', ...r.value, providerRouteId, sessionEpoch: r.sessionEpoch, snapshotId: r.snapshotId, workspaceRevision: r.workspaceRevision };
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          return { ...this.toUnavailable(adapter, e), providerRouteId };
        }
      }),
    );
  }

  discardPlan(planId: string): void {
    const entry = this.plans.get(planId);
    if (!entry) return;
    entry.lifecycle.tryTransition('Discarded', 'closed by user');
    this.plans.delete(planId);
    entry.adapter.discard(planId);
  }

  /**
   * Mandatory revalidation after the user confirmed:
   *   1. the plan must still be Previewing, same epoch, same workspace revision (editor events break the lease);
   *   2. backend revalidation (barrier + every read-set fingerprint);
   *   3. the EditApplier reads closed targets from disk (the last await);
   *   4. synchronously: lease check again, every target hash checked, editor apply started — no await in between;
   *   5. post-state reconciliation; the result is reported per file, never assumed. No auto-save, no rollback.
   */
  async applyRename(planId: string, token?: CancellationToken, options: ApplyOptions = {}): Promise<ApplyOutcome> {
    const entry = this.plans.get(planId);
    if (!entry) return { status: 'stale', message: 'This preview is no longer valid. Run Rename again.', canReprepare: true };
    const { lifecycle, adapter } = entry;
    if (!this.o.settings.applyRenameEnabled()) return { status: 'disabled', message: 'Applying renames is turned off (refyntra.rename.apply).' };
    // Single use: a plan that is revalidating/applying/finished cannot be applied again.
    if (lifecycle.state !== 'Previewing') return { status: 'stale', message: `The plan is ${lifecycle.state} and cannot be applied again.`, canReprepare: lifecycle.isTerminal };
    const finish = (to: PlanState, outcome: ApplyOutcome): ApplyOutcome => {
      lifecycle.tryTransition(to, outcome.message);
      if (lifecycle.isTerminal) this.plans.delete(planId);
      return outcome;
    };
    const stale = (message: string): ApplyOutcome => finish('Stale', { status: 'stale', message, canReprepare: true });
    const plan = lifecycle.plan;
    // A plan that could only be partly validated is applied only after the user confirmed its limitations.
    if (plan.validation.status === 'limited' && !options.acceptLimited) {
      return {
        status: 'limited',
        message: `${plan.title}: the plan could only be partly validated. Confirm the limitations to apply it.`,
        limitations: [...plan.limitations],
      };
    }
    lifecycle.transition('Revalidating');
    // Delegated plans: the lease is our bridge epoch plus the route that owns the document.
    const planEpoch = plan.kind === 'delegated' ? plan.bridgeEpoch : plan.sessionEpoch;
    const sameRoute = () => plan.kind !== 'delegated' || this.o.registry.routeFor(plan.origin.uri, this.o.tracker.get(plan.origin.uri)?.languageId) === adapter;
    const lease = () => adapter.currentEpoch() === planEpoch && this.o.tracker.revision === entry.workspaceRevision && sameRoute();
    if (!lease()) return stale('The code changed since the preview.');
    try {
      let verdict: RevalidateResult;
      if (plan.kind === 'delegated') {
        verdict = adapter.delegatedRename ? await adapter.delegatedRename.revalidate(plan, token) : { status: 'invalid', reasonCode: 'RenameNotSupported', message: 'The route no longer offers rename.' };
      } else {
        verdict = await adapter.revalidate(plan, token);
      }
      if (token?.isCancellationRequested) return finish('Cancelled', { status: 'cancelled', message: 'Rename cancelled. No file was changed.' });
      if (verdict.status === 'stale') return stale(`The code changed since the preview (${verdict.message ?? verdict.reasonCode ?? 'read set changed'}).`);
      if (verdict.status === 'invalid' && verdict.reasonCode === 'UnknownPlan') {
        return stale('The preview expired (the backend no longer has this plan, e.g. after a reload). Prepare the rename again.');
      }
      if (verdict.status === 'limited') {
        // Never upgraded: "limited" is accepted only for a plan that was previewed as limited and confirmed as such.
        if (!(options.acceptLimited && plan.validation.status === 'limited')) {
          return stale(`The backend reports the plan as only partly validated (${verdict.message ?? verdict.reasonCode ?? 'limited'}). Prepare the rename again to review its limitations.`);
        }
      } else if (verdict.status !== 'valid') {
        return finish('Failed', { status: 'failed', message: verdict.message ?? `Revalidation: ${verdict.status}`, canReprepare: true });
      }
      const captured = await this.o.editApplier.capture(plan.writeSet, options.confirmation ? { confirmation: options.confirmation } : undefined);
      // ---------------- no awaits from here until the editor apply has started ----------------
      if (token?.isCancellationRequested) return finish('Cancelled', { status: 'cancelled', message: 'Rename cancelled. No file was changed.' });
      if (!captured.ok) return stale(`The code changed since the preview (${captured.reason}).`);
      if (!lease()) return stale('The code changed since the preview.');
      const commit = captured.commit();
      if (!commit.started) return stale(`The code changed since the preview (${commit.reason}).`);
      lifecycle.transition('Applying');
      // ---------------- the editor owns the outcome now ----------------
      const report = await commit.result;
      this.relatedCache.clear();
      this.invalidateEmitter.fire(adapter.descriptor.providerRouteId);
      const confirmed = report.files.filter((f) => f.status === 'confirmed');
      const unchanged = report.files.filter((f) => f.status === 'unchanged');
      const unknown = report.files.filter((f) => f.status === 'unknown');
      const resources = report.resources ?? [];
      this.resyncRenamedFiles(adapter, resources);
      const textConfirmed = report.editorAccepted && confirmed.length === report.files.length;
      const creates = resources.filter((r): r is Extract<ApplyResourceReport, { kind: 'create' }> => r.kind === 'create');
      if (textConfirmed && resources.every((r) => r.status === 'confirmed')) {
        const created = creates.map((r) => `${baseName(r.uri)} created`);
        const renamed = resources.flatMap((r) => (r.kind === 'rename' ? [`${baseName(r.oldUri)} renamed to ${baseName(r.newUri)}`] : []));
        const deleted = resources.flatMap((r) => (r.kind === 'delete' ? [`${baseName(r.uri)} deleted`] : []));
        const parts = [...created, ...(report.files.length || (!created.length && !deleted.length) ? [`${confirmed.length} file(s) changed`] : []), ...renamed, ...deleted];
        return finish('Applied', { status: 'applied', message: `${plan.title}: ${parts.join(' and ')}`, files: report.files, ...(resources.length ? { resources } : {}) });
      }
      if (creates.length > 0) return finish('Failed', createFailure(plan.title, report.files, creates, resources));
      if (textConfirmed) {
        // File rename failure path: the text edits are applied (one all-or-nothing edit), a file rename is not.
        // Report exactly that; never roll back automatically.
        const what = resources.filter((r) => r.status !== 'confirmed').map((r) => `${r.kind === 'rename' ? `${baseName(r.oldUri)} → ${baseName(r.newUri)}` : baseName(r.uri)}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
        const deleting = resources.some((r) => r.kind === 'delete' && r.status !== 'confirmed');
        return finish('Failed', {
          status: 'failed',
          message: deleting
            ? `The text edits were applied to ${confirmed.length} file(s) (not saved), but the file deletion did not complete (${what}). Nothing was rolled back: use Undo in the editor to revert the text edits, or delete the file yourself.`
            : `The text edits were applied to ${confirmed.length} file(s) (not saved), but the file rename did not complete (${what}). Nothing was rolled back: use Undo in the editor to revert the text edits, or rename the file yourself.`,
          files: report.files,
          resources,
          textAppliedOnly: true,
        });
      }
      const message = !report.editorAccepted && unchanged.length === report.files.length
        ? 'VS Code did not apply the edit; no file was changed.'
        : `The result is not confirmed: ${confirmed.length} file(s) confirmed, ${unchanged.length} unchanged, ${unknown.length} unknown. Check the files; use Undo in the editor if needed.`;
      return finish('Failed', { status: 'failed', message, files: report.files, ...(resources.length ? { resources } : {}) });
    } catch (e) {
      if (e instanceof CancelledError) {
        if ((lifecycle.state as PlanState) === 'Applying') return finish('Failed', { status: 'failed', message: 'Cancelled while applying; the result is unknown. Check the files.' });
        return finish('Cancelled', { status: 'cancelled', message: 'Rename cancelled. No file was changed.' });
      }
      const applying = (lifecycle.state as PlanState) === 'Applying';
      return finish(applying ? 'Failed' : 'Stale', { status: applying ? 'failed' : 'stale', message: applying ? `The result is unknown: ${describeError(e)}` : describeError(e), canReprepare: !applying });
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * File rename host resync after file renames: confirmed renames move the documents in the backend (no reload). A rename
   * whose result is unknown, or a backend that cannot take the notification, gets a route restart (full reload) so
   * that no snapshot keeps a file that is gone. Refused/failed/not-attempted renames changed nothing on disk.
   */
  private resyncRenamedFiles(adapter: LanguageAdapter, resources: readonly ApplyResourceReport[]): void {
    if (resources.length === 0) return;
    const moved = resources.flatMap((r) => (r.kind === 'rename' && r.status === 'confirmed' ? [{ oldUri: r.oldUri, newUri: r.newUri }] : []));
    // Created files: a file that exists (confirmed, or unknown) must reach the host; an unknown outcome restarts the route.
    const created = resources.flatMap((r) => (r.kind === 'create' && r.status === 'confirmed' ? [r.uri] : []));
    // Deleted files: a confirmed delete leaves the host's snapshot; an unknown outcome restarts the route.
    const deleted = resources.flatMap((r) => (r.kind === 'delete' && r.status === 'confirmed' ? [r.uri] : []));
    const unknown = resources.some((r) => r.status === 'unknown');
    const revision = this.o.tracker.bumpRevision();
    const sent =
      (moved.length === 0 || adapter.filesRenamed?.(moved, revision) === true) &&
      (created.length === 0 || adapter.filesCreated?.(created, revision) === true) &&
      (deleted.length === 0 || adapter.filesDeleted?.(deleted, revision) === true);
    if (!sent || unknown) {
      this.log('warn', 'file operation resync by restart', { moved: moved.length, created: created.length, deleted: deleted.length, unknown });
      void adapter.restart('files renamed').catch(() => undefined);
    }
  }

  private async withStaleRetry<T>(fn: () => Promise<T>, token?: CancellationToken): Promise<T> {
    const retries = this.o.staleRetries ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof StaleResultError) || attempt >= retries) throw e;
        throwIfCancelled(token);
        this.log('debug', 'retrying stale request', { cause: e.reason });
      }
    }
  }

  private noteFor(adapter: LanguageAdapter, e: unknown): string {
    if (e instanceof AdapterUnavailableError) return `${e.health.displayName}: ${e.health.state}${e.health.message ? ` — ${e.health.message}` : ''}`;
    if (e instanceof RouteUnavailableError) return `${adapter.descriptor.displayName}: ${e.message}`;
    if (e instanceof StaleResultError) return `${adapter.descriptor.displayName}: results were outdated by newer edits; try again.`;
    return `${adapter.descriptor.displayName}: ${describeErrorWithRecovery(e)}`;
  }

  private toUnavailable(adapter: LanguageAdapter, e: unknown): Unavailable {
    if (e instanceof CancelledError) throw e;
    if (e instanceof AdapterUnavailableError) {
      return { kind: 'unavailable', reasonCode: e.health.reasonCode ?? e.health.state, message: this.noteFor(adapter, e), recoveryActions: e.health.recoveryActions.length ? e.health.recoveryActions : [RECOVERY_SHOW_HEALTH] };
    }
    if (e instanceof StaleResultError) return { kind: 'unavailable', reasonCode: 'Stale', message: this.noteFor(adapter, e), recoveryActions: [] };
    if (e instanceof RouteUnavailableError) return { kind: 'unavailable', reasonCode: e.reasonCode, message: this.noteFor(adapter, e), recoveryActions: e.recoveryActions };
    this.log('warn', 'request failed', { route: adapter.descriptor.providerRouteId, error: describeError(e) });
    const reasonCode = e instanceof RpcError ? (e.reasonCode ?? `Error${e.code}`) : 'RequestFailed';
    return { kind: 'unavailable', reasonCode, message: this.noteFor(adapter, e), recoveryActions: [RECOVERY_SHOW_HEALTH] };
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
    this.o.logger.log(level, 'engine', message, fields);
  }
}

/**
 * Created files that did not complete together with the text edits. Created first (see ADR-004 Amendment 2): a create
 * that failed means nothing was changed; a confirmed create whose text edits did not follow leaves the new file (and the
 * code in both places) — reported exactly, never rolled back automatically.
 */
function createFailure(title: string, files: readonly ApplyFileReport[], creates: readonly Extract<ApplyResourceReport, { kind: 'create' }>[], resources: ApplyResourceReport[]): ApplyOutcome {
  const created = creates.filter((c) => c.status === 'confirmed');
  const unknownCreate = creates.filter((c) => c.status === 'unknown');
  const describe = (r: Extract<ApplyResourceReport, { kind: 'create' }>) => `${baseName(r.uri)}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`;
  const textChanged = files.filter((f) => f.status !== 'unchanged');
  if (created.length === 0 && unknownCreate.length === 0 && textChanged.length === 0) {
    return { status: 'failed', message: `${title}: the file was not created (${creates.map(describe).join('; ')}); no file was changed.`, files: [...files], resources, canReprepare: true };
  }
  if (created.length === creates.length && textChanged.length === 0) {
    return {
      status: 'failed',
      message: `${title}: ${created.map((c) => baseName(c.uri)).join(', ')} was created, but the edit of ${files.map((f) => baseName(f.uri)).join(', ')} was not applied (${files.map((f) => f.detail ?? f.status).join('; ')}). Nothing was rolled back: the code now exists in both files until you delete the new file (Undo) or remove it from the original yourself.`,
      files: [...files],
      resources,
      createdOnly: true,
    };
  }
  return {
    status: 'failed',
    message: `${title}: the result is not confirmed (${[...creates.map(describe), ...files.map((f) => `${baseName(f.uri)}: ${f.status}`)].join('; ')}). Check the files; nothing was rolled back.`,
    files: [...files],
    resources,
  };
}

export type { RouteResult };
