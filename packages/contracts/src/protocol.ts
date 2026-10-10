/**
 * Refyntra protocol v1 — wire shapes shared by the extension and the .NET host.
 * See docs/architecture/protocol-v1.md. Everything here is plain JSON data (no classes, no vscode types).
 */

export const PROTOCOL_MAJOR = 1;
/** 1.1: optional `LoadDiagnostic.recoveryActions` (additive). */
export const PROTOCOL_MINOR = 2;

/** Zero-based line, UTF-16 code unit character. */
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}

export interface TraceParams {
  traceId: string;
}
export interface WorkspaceParams extends TraceParams {
  workspaceId: string;
}

// ---------------------------------------------------------------- lifecycle

export interface InitializeParams extends TraceParams {
  protocolMajor: number;
  protocolMinor: number;
  clientName: string;
  clientVersion: string;
}
export interface InitializeResult {
  protocolMajor: number;
  protocolMinor: number;
  engineVersion: string;
  sessionEpoch: string;
  /** Capability ids of the catalogue this backend can answer (see CSHARP_CAPABILITY_IDS for the C# host). */
  capabilities: string[];
  limits: { maxMessageBytes: number };
}

export type AdapterState = 'NotStarted' | 'Loading' | 'Ready' | 'Partial' | 'Unsupported' | 'TrustRequired' | 'Restarting' | 'Failed';

export interface LoadDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** Project file path when the diagnostic belongs to a project. */
  projectPath?: string;
  /** Since 1.1. What the UI can offer, e.g. `refyntra.runRestore` with `args: [solutionOrProjectPath]`. */
  recoveryActions?: RecoveryAction[];
  /** Additive: machine-readable cause — missingAssets, missingPackages, missingProjectReference (absent for raw MSBuild/workspace messages). */
  cause?: string;
}

export interface ProjectContextInfo {
  /** Stable within a session: hash of project path + configuration + TFM. */
  projectContextId: string;
  name: string;
  projectPath: string;
  targetFramework: string | null;
  state: 'loaded' | 'partial' | 'failed';
  documentCount: number;
  diagnostics: LoadDiagnostic[];
}

export interface EngineStatus {
  state: AdapterState;
  sessionEpoch: string;
  sdk: { version: string | null; path: string | null };
  solutionPath: string | null;
  projects: ProjectContextInfo[];
  diagnostics: LoadDiagnostic[];
  /** Short machine reason when state is not Ready. */
  reasonCode?: string;
  message?: string;
}

export interface WorkspaceOpenParams extends WorkspaceParams {
  /** A .sln/.slnx or a single .csproj. */
  path: string;
  trusted: boolean;
}

// ---------------------------------------------------------------- documents

export interface DocumentEventBase {
  workspaceId: string;
  uri: string;
  sequence: number;
  workspaceRevision: number;
}
export interface DidOpenParams extends DocumentEventBase {
  languageId: string;
  version: number;
  text: string;
}
export interface DidChangeParams extends DocumentEventBase {
  version: number;
  /** Full text of the document after the change. */
  text: string;
}
export type DidSaveParams = DocumentEventBase;
export type DidCloseParams = DocumentEventBase;

export interface BarrierParams extends WorkspaceParams {
  sequence: number;
}
export interface BarrierResult {
  acknowledgedSequence: number;
  snapshotId: string;
  workspaceRevision: number;
}

// ---------------------------------------------------------------- availability

export type AvailabilityState = 'available' | 'limited' | 'unavailable' | 'unknown';

/**
 * Capability catalogue of the C# route (protocol-v1.md "Capability ids"). `initialize.capabilities`,
 * `capability/query` and the UI use exactly these ids. Framework details (MediatR, ASP.NET Core endpoints, DI) are
 * limitations of `csharp.related`, not separate capabilities.
 */
export const CSHARP_CAPABILITY_IDS = ['csharp.find', 'csharp.related', 'csharp.rename', 'csharp.references'] as const;
export type CSharpCapabilityId = (typeof CSHARP_CAPABILITY_IDS)[number];
export type Guarantee = 'owned-semantic' | 'delegated' | 'heuristic';

export interface RecoveryAction {
  /** VS Code command id the UI can run, e.g. "refyntra.showHealth". */
  command: string;
  title: string;
  args?: unknown[];
}

export interface Availability {
  capabilityId: string;
  providerRouteId: string;
  scope: { workspaceId: string; projectContextId?: string; documentUri?: string; symbolId?: string };
  state: AvailabilityState;
  reasonCode?: string;
  message?: string;
  recoveryActions: RecoveryAction[];
  requiredTrust: 'none' | 'workspace';
  guarantee: Guarantee;
  limitations: string[];
}

export interface CapabilityQueryParams extends WorkspaceParams {
  snapshotId: string;
  uri?: string;
  position?: Position;
  symbolId?: string;
}

// ---------------------------------------------------------------- symbols

export type SymbolKind =
  | 'namespace' | 'class' | 'interface' | 'struct' | 'record' | 'enum' | 'delegate'
  | 'method' | 'property' | 'field' | 'event' | 'constructor' | 'parameter' | 'local' | 'other';

export interface OwnedProvenance {
  kind: 'owned-semantic';
  providerRouteId: string;
  sessionEpoch: string;
  snapshotId: string;
  projectContextId: string;
}
export interface DelegatedProvenance {
  kind: 'delegated';
  providerRouteId: string;
  observationId: string;
  sessionEpoch: 'unknown';
  snapshotId: 'unknown';
  projectContextId: 'unknown';
}
export type Provenance = OwnedProvenance | DelegatedProvenance;

export interface SymbolRef {
  /** Opaque, valid only for (sessionEpoch, snapshotId). Absent for delegated results. */
  symbolId?: string;
  name: string;
  /** e.g. "Shop.Orders.GetOrderQuery" or "Shop.Orders.OrderService.Get(int)". */
  displayName: string;
  kind: SymbolKind;
  containerName?: string;
  projectName?: string;
  /** Declaration location; absent for metadata-only symbols. */
  location?: Location;
  origin: 'source' | 'metadata' | 'generated';
  provenance: Provenance;
}

export interface SymbolAtParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  position: Position;
}

export interface SearchFilters {
  /** Filter "type:" — only type symbols. */
  type?: boolean;
  /** Filter "member:" — only members. */
  member?: boolean;
  /** Filter "project:NAME" — case-insensitive project name. */
  project?: string;
  /** Filter "route:" — search endpoints by route text. */
  route?: string;
  /** Filter "method:GET" — HTTP method for endpoints. */
  method?: string;
}
export interface SearchParams extends WorkspaceParams {
  snapshotId: string;
  query: string;
  filters: SearchFilters;
  limit: number;
}
export interface SearchItem {
  symbol?: SymbolRef;
  endpoint?: EndpointInfo;
  /** Ranking score, higher first; ties broken by displayName then uri. */
  score: number;
}
export interface SearchResult {
  items: SearchItem[];
  /** True when `limit` cut the list. */
  truncated: boolean;
  snapshotId: string;
}

// ---------------------------------------------------------------- relations

/**
 * Relation kinds of the C# host. Clients must tolerate unknown namespaced kinds (`<namespace>.<name>`) from newer
 * backends or framework modules and render them generically.
 */
export type RelationKind =
  | 'declaration'
  | 'mediatr.handler' | 'mediatr.request' | 'mediatr.response' | 'mediatr.send' | 'mediatr.notificationHandler'
  | 'mediatr.behavior'
  | 'aspnet.endpoint'
  | 'di.registration' | 'di.implementation' | 'di.service' | 'di.openGenericUsage'
  | 'implementation' | 'reference' | 'test';

export type RelationGroup = 'declarations' | 'handlers' | 'callers' | 'endpoints' | 'registrations' | 'implementations' | 'references' | 'tests';
export const RELATION_GROUP_ORDER: readonly RelationGroup[] = ['declarations', 'handlers', 'callers', 'endpoints', 'registrations', 'implementations', 'references', 'tests'];

export interface EndpointInfo {
  /** e.g. ["GET"]; empty = any/unknown. */
  httpMethods: string[];
  /** Full route when static; known prefix otherwise. */
  route: string;
  routeIsDynamic: boolean;
  location: Location;
  /** Handler method/lambda symbol when resolvable. */
  handler?: SymbolRef;
  kind: 'minimal-api' | 'mvc';
}

export interface DiRegistrationInfo {
  lifetime: 'singleton' | 'scoped' | 'transient' | 'unknown';
  serviceType: SymbolRef;
  implementationType?: SymbolRef;
  /** e.g. "AddScoped<IOrderService, OrderService>()" */
  form: string;
  /** Method containing the registration, e.g. Program.<Main>$ or a ConfigureServices extension. */
  compositionRoot: string;
  location: Location;
  /** Additive: how the implementation is supplied. Absent from older hosts. */
  implementationKind?: 'type' | 'factory' | 'instance';
  /** Additive: key of a keyed registration (constant value, or the expression as written). */
  key?: string;
  /** Additive: location of the factory delegate of a factory registration. */
  factoryLocation?: Location;
}

export interface Evidence {
  description: string;
  location?: Location;
}

export interface Relation {
  relationKind: RelationKind;
  group: RelationGroup;
  /** What the relation points to: a symbol, an endpoint, a registration or a bare location (call site). */
  target: { symbol?: SymbolRef; endpoint?: EndpointInfo; registration?: DiRegistrationInfo; location?: Location; label: string };
  evidence: Evidence[];
  /** Confidence of this one relation. */
  confidence: 'proven' | 'likely' | 'heuristic';
  provenance: Provenance;
  limitations: string[];
}

export interface RelatedParams extends WorkspaceParams {
  snapshotId: string;
  /** Either a symbol id from this snapshot or a document position. */
  symbolId?: string;
  uri?: string;
  position?: Position;
}
export interface RelatedResult {
  subject: SymbolRef | null;
  relations: Relation[];
  /** How complete the search scope was. */
  completeness: 'complete' | 'partial' | 'unknown';
  /** Human-readable scope notes, e.g. "2 of 3 projects loaded". Kept for compatibility; clients prefer scopeDetails. */
  scopeNotes: string[];
  /** Structured scope (additive; absent from older hosts and from delegated routes). */
  scopeDetails?: ScopeDetails;
  snapshotId: string;
}

/** Structured search scope of a Related result: what was loaded, why not, and which frameworks were detected. */
export interface ScopeDetails {
  projectsTotal: number;
  /** Projects loaded without load errors. */
  projectsComplete: number;
  /** Loaded with load errors (e.g. packages not restored): results from them may be missing. */
  projectsPartial: number;
  /** Not loaded at all. */
  projectsFailed: number;
  /** Number of projects affected by each cause (a project may count under several). */
  causes: { missingAssets: number; missingPackages: number; missingProjectReferences: number; loadFailures: number; otherErrors: number };
  /** "dotnet restore" is the recovery for at least one incompletely loaded project. */
  restoreRecommended: boolean;
  /** The loaded solution/project (target of "dotnet restore"); null when unknown. */
  solutionPath: string | null;
  /** Detected frameworks. versionVerified=false: that framework's relations are reported with confidence likely. */
  frameworks: { id: string; name: string; evidence: string; versionVerified: boolean }[];
}

export interface SymbolQueryParams extends WorkspaceParams {
  snapshotId: string;
  symbolId: string;
}
export interface LocationsResult {
  locations: Array<Location & { projectName?: string; preview?: string }>;
  completeness: 'complete' | 'partial' | 'unknown';
  snapshotId: string;
}

// ---------------------------------------------------------------- refactoring plans

export interface TextEditDto {
  range: Range;
  newText: string;
}
export interface PlannedTextChange {
  kind: 'text';
  uri: string;
  /** SHA-256 of the document text the edits were computed on. */
  expectedHash: string;
  /** SHA-256 of the text after applying `edits`. */
  resultHash: string;
  /** Sorted by start, non-overlapping. */
  edits: TextEditDto[];
}
/**
 * File rename resource operation (protocol 1.2): rename a file after every text change of the plan. Always
 * listed after the text changes; `oldUri` is a text target of the same plan and `resultHash` is that change's
 * `resultHash` (the text the renamed file must have). Same folder only.
 */
export interface PlannedFileRename {
  kind: 'rename';
  oldUri: string;
  newUri: string;
  resultHash: string;
}
export type PlannedChange = PlannedTextChange | PlannedFileRename;

/** What "also rename the file" means for a type rename (protocol 1.2; absent when no file is named after the type). */
export interface FileRenameOffer {
  files: { oldUri: string; newUri: string }[];
  /** Renaming the files is proven safe (guards + Compile membership). */
  available: boolean;
  /** The writeSet contains the rename operations. */
  included: boolean;
  /** Why it is not available. */
  reasonCode?: string;
  message?: string;
}

export interface DidRenameFilesParams {
  workspaceId: string;
  sequence: number;
  workspaceRevision: number;
  files: { oldUri: string; newUri: string }[];
}

export interface InputFingerprint {
  /** File path or a logical input id such as "project-closure". */
  input: string;
  hash: string;
}

export interface RefactorPlanDto {
  planId: string;
  actionId: string;
  providerRouteId: string;
  protocolMajor: number;
  workspaceId: string;
  kind: 'owned-semantic';
  sessionEpoch: string;
  baseWorkspaceRevision: number;
  baseSnapshotId: string;
  projectContextIds: string[];
  writeSet: PlannedChange[];
  readSet: InputFingerprint[];
  evidence: Evidence[];
  limitations: string[];
  validation: {
    status: 'valid' | 'limited' | 'invalid';
    checkedContexts: string[];
    uncheckedContexts: string[];
    compilationDelta: 'passed' | 'failed' | 'not-run';
  };
  /** Human summary for the preview, e.g. "Rename GetOrderQuery to FetchOrderQuery". */
  title: string;
  /** File rename (protocol 1.2): the file-rename offer of a type rename. */
  fileRename?: FileRenameOffer;
}

export interface PrepareParams extends WorkspaceParams {
  snapshotId: string;
  /** Action id of the route, e.g. "csharp.rename" (the .fixture conformance route uses "fixture.rename"). */
  actionId: string;
  symbolId: string;
  newName: string;
  /** File rename (protocol 1.2): include the rename of the files named after the type when it is proven safe. */
  renameFile?: boolean;
}
export type PrepareResult =
  | { kind: 'prepared'; plan: RefactorPlanDto }
  | { kind: 'unavailable'; reasonCode: string; message: string };

export interface RevalidateResult {
  /**
   * `limited`: the read set is unchanged but the plan was prepared as `limited`; revalidation never upgrades it, the
   * client must show `limitations` and get an explicit confirmation before applying.
   */
  status: 'valid' | 'limited' | 'stale' | 'invalid';
  reasonCode?: string;
  message?: string;
  /** With status `limited`: the plan's limitations. */
  limitations?: string[];
}

// ---------------------------------------------------------------- methods

export interface MethodMap {
  initialize: [InitializeParams, InitializeResult];
  shutdown: [TraceParams, null];
  'engine/status': [TraceParams, EngineStatus];
  'workspace/open': [WorkspaceOpenParams, EngineStatus];
  'workspace/reload': [WorkspaceParams, EngineStatus];
  'workspace/close': [WorkspaceParams, null];
  'workspace/snapshotBarrier': [BarrierParams, BarrierResult];
  'capability/query': [CapabilityQueryParams, Availability[]];
  'code/symbolAt': [SymbolAtParams, SymbolRef | null];
  'code/search': [SearchParams, SearchResult];
  'code/related': [RelatedParams, RelatedResult];
  'code/references': [SymbolQueryParams, LocationsResult];
  'code/implementations': [SymbolQueryParams, LocationsResult];
  'refactor/prepare': [PrepareParams, PrepareResult];
  'refactor/revalidate': [WorkspaceParams & { planId: string; snapshotId: string }, RevalidateResult];
}
export type MethodName = keyof MethodMap;

export interface NotificationMap {
  exit: Record<string, never>;
  'textDocument/didOpen': DidOpenParams;
  'textDocument/didChange': DidChangeParams;
  'textDocument/didSave': DidSaveParams;
  'textDocument/didClose': DidCloseParams;
  'refactor/discard': { workspaceId: string; planId: string };
  /** File rename (protocol 1.2): files the client renamed; consumes a document sequence (sent only to hosts with minor ≥ 2). */
  'workspace/didRenameFiles': DidRenameFilesParams;
  '$/cancelRequest': { id: number | string };
}
export type NotificationName = keyof NotificationMap;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  /** Unexpected host exception (`reasonCode: "InternalError"`). */
  InternalError: -32603,
  Cancelled: -32800,
  ProtocolMismatch: -33001,
  NotInitialized: -33002,
  TrustRequired: -33003,
  StaleSnapshot: -33004,
  UnknownSymbol: -33005,
  WorkspaceNotLoaded: -33006,
  SdkNotFound: -33007,
  /** workspace/snapshotBarrier: a document sequence was never received. The client replays its open documents. */
  BarrierTimeout: -33008,
} as const;

/** `error.data.reasonCode` values (protocol-v1.md "Error codes"). Several reason codes share a JSON-RPC code. */
export const ReasonCodes = {
  ParseError: 'ParseError',
  InvalidRequest: 'InvalidRequest',
  DuplicateId: 'DuplicateId',
  MethodNotFound: 'MethodNotFound',
  InvalidParams: 'InvalidParams',
  UnsupportedPath: 'UnsupportedPath',
  InvalidUri: 'InvalidUri',
  InternalError: 'InternalError',
  Cancelled: 'Cancelled',
  ProtocolMismatch: 'ProtocolMismatch',
  NotInitialized: 'NotInitialized',
  TrustRequired: 'TrustRequired',
  StaleSnapshot: 'StaleSnapshot',
  UnknownSymbol: 'UnknownSymbol',
  WorkspaceNotLoaded: 'WorkspaceNotLoaded',
  NoProjectsLoaded: 'NoProjectsLoaded',
  SdkNotFound: 'SdkNotFound',
  BarrierTimeout: 'BarrierTimeout',
} as const;

export interface RpcErrorData {
  reasonCode: string;
  message: string;
  recovery?: string;
}

// ---------------------------------------------------------------- analysis (additive in 1.1; protocol-v1.md "Analysis")

/** Rule ids `analysis/run` can report. */
export const ANALYSIS_RULE_IDS = ['OR1001'] as const;
export type AnalysisRuleId = (typeof ANALYSIS_RULE_IDS)[number];
export const OR1001_HELP_URI = 'https://github.com/refyntra/refyntra/blob/main/docs/rules/OR1001.md';

export interface AnalysisRunParams extends WorkspaceParams {
  snapshotId: string;
  /** Only results whose primary location is in this document. Omitted = the whole workspace. */
  uri?: string;
}

export interface RuleRelatedLocation {
  location: Location;
  message: string;
}

/** A proven rule result. Published in the Problems view; never produced for an unproven path. */
export interface RuleDiagnostic {
  id: AnalysisRuleId | string;
  severity: 'warning';
  message: string;
  /** Primary location (for OR1001: the singleton registration). */
  location: Location;
  /** The proof path, in order (registrations and constructor parameters). */
  relatedLocations: RuleRelatedLocation[];
  evidence: Evidence[];
  confidence: 'proven';
  completeness: 'complete' | 'partial' | 'unknown';
  compositionRoot?: string;
  helpUri?: string;
}

/** Why a rule did not decide (explanation only; never a Problems entry). */
export interface RuleAbstention {
  ruleId: string;
  /** e.g. ConditionalRegistration, FactoryRegistration, OpenGeneric, KeyedService, EnumerableService, TryAdd, MultipleConstructors, PartialLoad. */
  reason: string;
  message?: string;
  location?: Location;
  compositionRoot?: string;
}

export interface AnalysisRunResult {
  diagnostics: RuleDiagnostic[];
  abstentions: RuleAbstention[];
  completeness: 'complete' | 'partial' | 'unknown';
  snapshotId: string;
}

// Declaration merging: appends `analysis/run` to the method map without editing the existing interface.
export interface MethodMap {
  'analysis/run': [AnalysisRunParams, AnalysisRunResult];
}
