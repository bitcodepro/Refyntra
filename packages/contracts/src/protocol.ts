/**
 * Refyntra protocol v1 — wire shapes shared by the extension and the .NET host.
 * See docs/architecture/protocol-v1.md. Everything here is plain JSON data (no classes, no vscode types).
 */

export const PROTOCOL_MAJOR = 1;
/**
 * 1.1: optional `LoadDiagnostic.recoveryActions` (additive). 1.2: file rename with a type. 1.3: created files
 * (`PlannedChange` kind `create`, `fileCreate`, `targetFolderUri`/`documentUri`, `workspace/didCreateFiles`).
 * 1.4: stack frames, Code Cleanup. 1.5: EF Core migrations in a rename (`PrepareParams.generatedEdits`, `efMigrations`).
 * 1.6: Safe Delete, Extract Method, Change Signature (`PrepareParams.range`/`signature`, `PlannedChange` kind `delete`,
 * `fileDelete`, `code/signature`, `workspace/didDeleteFiles`).
 * 1.7: call and type hierarchy (`code/hierarchy`).
 * 1.8: runnable projects for Run and Debug (`workspace/runnableProjects`).
 * 1.9: single-document edit actions computed and compile-checked by Roslyn (`code/editActions`).
 * 1.10: postfix templates (`code/postfix`) and Generate (`code/generate`).
 * 1.11: constructor and DI helpers (`code/constructorActions`), Register in DI (`csharp.registerDi`) and Fix in scope
 *   (`csharp.fixAll`) as previewed plans.
 * 1.12: Find Usages grouped (`code/usages`: classified usages) and the Navigate To directions `bases` / `containing`
 *   of `code/hierarchy`.
 * 1.13: File Structure (`code/fileStructure`: types, members, regions and inherited members of one document).
 * 1.14: Smart Step Into (`code/stepIntoTargets`: the calls of the statement a debugger stopped at).
 * 1.15: Test discovery (`code/tests`: test projects, classes, methods and data cases for the Test Explorer).
 * 1.16: Inspections OR1002–OR1010 (`analysis/run` `documents`) with quick fixes (`RuleDiagnostic.fixes`, edit actions
 *   `csharp.edit.fix.*`).
 * 1.18: EF Core tools (`efcore/migrations`: DbContexts with their migrations, snapshot and configurations, read from
 *   source) and the inspection OR1011 (possible N+1) with the fix `csharp.edit.fix.addInclude`.
 */
export const PROTOCOL_MINOR = 18;

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
/**
 * Heuristic provenance (additive, TS side only; never sent by the host): a relation derived from recognised code
 * patterns across routes, e.g. a literal fetch/axios URL matched to an ASP.NET route (`http.links`). `basis` says why.
 */
export interface HeuristicProvenance {
  kind: 'heuristic';
  providerRouteId: string;
  sessionEpoch: string;
  snapshotId: string;
  projectContextId: 'unknown';
  basis: string;
}
export type Provenance = OwnedProvenance | DelegatedProvenance | HeuristicProvenance;

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
  /** Filter "entity:" — only EF Core entities (additive; older hosts ignore it). */
  entity?: boolean;
  /** Filter "table:NAME" — EF Core entities by mapped table name (additive). */
  table?: string;
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
  | 'efcore.entity' | 'efcore.dbContext' | 'efcore.configuration' | 'efcore.navigation' | 'efcore.table' | 'efcore.query'
  | 'efcore.migration'
  | 'implementation' | 'reference' | 'test';

/** `clients` (additive): heuristic frontend call sites of an endpoint (TS-side HTTP linking; never sent by the host). */
/**
 * `styles`, `usedBy`, `unused` (additive): HTML/CSS links (TS side; never sent by the host): the rules of a class, the
 * uses of a rule, and selectors without a static use (information only).
 */
export type RelationGroup = 'declarations' | 'handlers' | 'callers' | 'clients' | 'endpoints' | 'data' | 'styles' | 'usedBy' | 'registrations' | 'implementations' | 'references' | 'tests' | 'unused';
export const RELATION_GROUP_ORDER: readonly RelationGroup[] = ['declarations', 'handlers', 'callers', 'clients', 'endpoints', 'data', 'styles', 'usedBy', 'registrations', 'implementations', 'references', 'tests', 'unused'];

export interface EndpointInfo {
  /** e.g. ["GET"]; empty = any/unknown. */
  httpMethods: string[];
  /** Full route when static; known prefix otherwise. */
  route: string;
  routeIsDynamic: boolean;
  location: Location;
  /** Handler method/lambda symbol when resolvable. */
  handler?: SymbolRef;
  /** `next-*` / `angular-route` (additive, TS side only; never sent by the host): web framework routes of the web worker. */
  kind: 'minimal-api' | 'mvc' | 'next-page' | 'next-route-handler' | 'next-api' | 'angular-route';
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
/**
 * Created file resource operation (protocol 1.3, Move Type to File and Generate handler): create the file with exactly
 * `text` (`resultHash` = SHA-256 of `text`). Always listed before every text change (see ADR-004 Amendment 2 for the
 * order); the target must not exist (also ignoring case).
 */
export interface PlannedFileCreate {
  kind: 'create';
  uri: string;
  resultHash: string;
  text: string;
}
/**
 * Deleted file resource operation (protocol 1.6, Safe Delete): delete the file after every text change and file rename
 * of the plan, only while its text (editor and disk) still hashes to `expectedHash`. Always listed last; never a text
 * target, rename or create of the same plan.
 */
export interface PlannedFileDelete {
  kind: 'delete';
  uri: string;
  expectedHash: string;
}
export type PlannedChange = PlannedTextChange | PlannedFileRename | PlannedFileCreate | PlannedFileDelete;

/** Action ids of the create-file refactorings of the C# route (protocol 1.3; offered through capability/query). */
export const CSHARP_MOVE_TYPE_ACTION = 'csharp.moveTypeToFile';
export const CSHARP_GENERATE_HANDLER_ACTION = 'csharp.generateHandler';

/** Action ids of the code refactorings of the C# route (protocol 1.6; offered through capability/query). */
export const CSHARP_SAFE_DELETE_ACTION = 'csharp.safeDelete';
export const CSHARP_EXTRACT_METHOD_ACTION = 'csharp.extractMethod';
export const CSHARP_CHANGE_SIGNATURE_ACTION = 'csharp.changeSignature';
/** Introduce Parameter (protocol 1.10, additive action id): refactor/prepare with documentUri + range of the expression. */
export const CSHARP_INTRODUCE_PARAMETER_ACTION = 'csharp.introduceParameter';

/** One parameter of a new signature (Change Signature, protocol 1.6). */
export interface ParameterSpec {
  /** Index of the existing parameter (kept, moved or renamed); absent adds a parameter. */
  from?: number;
  name: string;
  /** Type of an added parameter. */
  type?: string;
  /** Default value in the declaration (the added parameter becomes optional). */
  defaultValue?: string;
  /** Value passed at every existing call site for an added parameter. */
  callSiteValue?: string;
}

export interface SignatureParams {
  parameters: ParameterSpec[];
}

/** code/signature (protocol 1.6): the parameters of the method at the subject, or why Change Signature does not apply. */
export interface SignatureInfo {
  name?: string | null;
  display?: string | null;
  parameters: { name: string; type: string; defaultValue?: string | null; modifiers: string }[];
  reasonCode?: string | null;
  message?: string | null;
  snapshotId: string;
}

/**
 * code/hierarchy (protocol 1.7): which neighbours of the subject. 1.12 adds `bases` (base types nearest first and all
 * interfaces; for a member the overridden chain and the interface members it implements) and `containing` (the type
 * that declares a member, nested type, local or parameter) for Navigate To.
 */
export type HierarchyDirection = 'incoming' | 'outgoing' | 'supertypes' | 'subtypes' | 'bases' | 'containing';

/** code/usages (protocol 1.12): how a usage uses the symbol. */
export type UsageKind = 'read' | 'write' | 'readWrite' | 'invocation' | 'nameof' | 'attribute' | 'inheritance' | 'typeArgument' | 'objectCreation' | 'other';

export interface UsagesParams extends WorkspaceParams {
  snapshotId: string;
  symbolId: string;
  /** At most this many items (default 1000, at most 50000); `total` says how many there are. */
  limit?: number;
}

export interface UsageItem {
  uri: string;
  /** The name at the usage. */
  range: Range;
  kind: UsageKind;
  /** Member that contains the usage (lambdas and local functions belong to theirs); null at type level. */
  containingMember?: string | null;
  containingType?: string | null;
  projectName?: string | null;
  /** In a test project (references xUnit, NUnit or MSTest), a test method or a test class. */
  isTest: boolean;
  /** The whole source line (untrimmed, at most 400 characters). */
  lineText: string;
}

export interface UsagesResult {
  subject?: SymbolRef | null;
  items: UsageItem[];
  total: number;
  truncated: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  snapshotId: string;
}

/** code/fileStructure (protocol 1.13): what a member is. */
export type StructureMemberKind = 'method' | 'constructor' | 'destructor' | 'property' | 'indexer' | 'field' | 'constant' | 'event' | 'operator' | 'enumMember';
export type StructureTypeKind = 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'recordStruct' | 'delegate';
export type StructureAccessibility = 'public' | 'internal' | 'protected' | 'private' | 'protectedInternal' | 'privateProtected';

export interface FileStructureParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  /** Also the members inherited from base classes (an interface: its base interfaces). */
  includeInherited?: boolean;
}

export interface StructureMember {
  name: string;
  kind: StructureMemberKind;
  accessibility: StructureAccessibility;
  isStatic: boolean;
  /** Short signature: "Find(int) : OrderDto?", "Total : decimal". */
  signature: string;
  /** The declaration (own members: in the requested document; inherited: in `uri`). */
  range: Range;
  /** The name. */
  selectionRange: Range;
  /** Innermost `#region` around an own member. */
  region?: string | null;
  /** Inherited members: the declaring type ("Entity<int>"). */
  declaringType?: string | null;
  /** Inherited members declared in the solution: their file; null for metadata members (not navigable). */
  uri?: string | null;
  navigable: boolean;
}

export interface StructureType {
  name: string;
  /** With the containing types: "Order.Line". */
  fullName: string;
  kind: StructureTypeKind;
  accessibility: StructureAccessibility;
  isStatic: boolean;
  signature: string;
  range: Range;
  selectionRange: Range;
  region?: string | null;
  /** Nested types: the full name of the containing type. */
  containingType?: string | null;
  members: StructureMember[];
  inherited: StructureMember[];
}

export interface FileStructureResult {
  types: StructureType[];
  regions: { name: string; range: Range }[];
  /** "DocumentNotFound" when the document is not part of the loaded solution. */
  reasonCode?: string | null;
  completeness: 'complete' | 'partial' | 'unknown';
  snapshotId: string;
}

/** code/stepIntoTargets (protocol 1.14): the calls of the statement a debugger stopped at (Smart Step Into). */
export interface StepIntoTargetsParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  /** The stopped position (0-based): the start of the debugger's sequence point. */
  position: Position;
}

/** Why a call cannot be stepped into: no source in the solution, no body (abstract, interface), a delegate, a compiler-generated constructor. */
export type StepIntoReason = 'metadata' | 'noBody' | 'delegate' | 'implicit';

export interface StepIntoTarget {
  /** "Calc.Add(int, int)". */
  label: string;
  /** The call as written (one line, at most 80 characters). */
  detail: string;
  kind: 'method' | 'constructor' | 'delegate';
  callRange: Range;
  /** Where the callee's body starts; null when it cannot be stepped into (see reason). */
  breakAt?: Location | null;
  reason?: StepIntoReason | null;
  /** A virtual call: an override may run instead. */
  isVirtual: boolean;
}

export interface StepIntoTargetsResult {
  /** In the order the calls run (arguments before the call that receives them). */
  targets: StepIntoTarget[];
  statement?: Range | null;
  /** The next statement of the same block, or the closing brace of the member: where the statement ends. */
  nextStatement?: Position | null;
  /** "DocumentNotFound" | "NoStatement". */
  reasonCode?: string | null;
  snapshotId: string;
}

/** code/tests (protocol 1.15): test discovery for the Test Explorer (every test project, or only some documents). */
export interface TestsParams extends WorkspaceParams {
  snapshotId: string;
  /** Only these documents (incremental update); absent: every test project. */
  uris?: string[] | null;
}

export interface TestProjectInfo {
  name: string;
  projectUri: string;
  /** "xUnit" | "NUnit" | "MSTest". */
  frameworks: string[];
}

export interface TestCaseInfo {
  /** The arguments as written: "(1, 2, 3)". */
  label: string;
  /** Normalised arguments (lower case, no quotes, numeric suffixes or blanks) for matching results. */
  arguments: string[];
  range: Range;
}

export interface TestClassInfo {
  name: string;
  range: Range;
  nameRange: Range;
}

export interface TestMethodInfo {
  projectUri: string;
  uri: string;
  framework: string;
  namespace: string;
  /** Containing classes, outermost first. */
  classes: TestClassInfo[];
  method: string;
  /** "Ns.Outer+Inner.Method" (as test adapters report it, without data arguments). */
  fullyQualifiedName: string;
  range: Range;
  nameRange: Range;
  cases: TestCaseInfo[];
  /** Cases computed at run time (MemberData, TestCaseSource, DynamicData). */
  dynamicCases: boolean;
  skipReason?: string | null;
}

export interface TestsResult {
  projects: TestProjectInfo[];
  tests: TestMethodInfo[];
  /** With params.uris: the documents scanned; their earlier tests are replaced. */
  documents?: string[] | null;
  state: string;
  snapshotId: string;
}

/** efcore/migrations (protocol 1.18): the DbContexts of the snapshot with their migrations, from source only. */
export interface EfMigrationsParams extends WorkspaceParams {
  snapshotId: string;
}

export interface EfMigrationInfo {
  /** The [Migration] id, e.g. "20250101000000_Initial". */
  id: string;
  name: string;
  className: string;
  location?: Location | null;
  designerLocation?: Location | null;
}

export interface EfNamedLocation {
  name: string;
  location?: Location | null;
}

export interface EfContextInfo {
  name: string;
  fullName: string;
  projectName: string;
  /** The project of the DbContext. */
  projectUri: string;
  /** The project that holds the migrations (`dotnet ef --project`). */
  migrationsProjectUri: string;
  migrationsNamespace?: string | null;
  location?: Location | null;
  onModelCreating?: Location | null;
  /** Ordered by id (the order EF Core applies them in). */
  migrations: EfMigrationInfo[];
  snapshot?: EfNamedLocation | null;
  configurations: EfNamedLocation[];
}

export interface EfMigrationsResult {
  contexts: EfContextInfo[];
  state: string;
  snapshotId: string;
}

export interface HierarchyParams extends WorkspaceParams {
  snapshotId: string;
  symbolId: string;
  direction: HierarchyDirection;
}

export interface HierarchyItem {
  /** The neighbour (always with a source location). */
  symbol: SymbolRef;
  /** Call sites (in the caller for incoming, in the subject for outgoing); empty for the type hierarchy. */
  fromRanges: Range[];
  /** Document of `fromRanges`. */
  fromUri?: string | null;
}

export interface HierarchyResult {
  items: HierarchyItem[];
  completeness: 'complete' | 'partial' | 'unknown';
  /** True when the host cut the list (500 items). */
  truncated: boolean;
  snapshotId: string;
}

/** workspace/runnableProjects (protocol 1.8): how Run and Debug sees a loaded project. */
export type RunnableKind = 'console' | 'web' | 'worker' | 'winforms' | 'wpf' | 'test' | 'library' | 'maui' | 'blazor-wasm';

export interface RunnableProjectInfo {
  name: string;
  projectUri: string;
  kind: RunnableKind;
  /** True when Run and Debug can start it (on Windows only when `windowsOnly`). */
  runnable: boolean;
  /** Why it is not runnable, or a limitation. */
  reason?: string | null;
  windowsOnly: boolean;
  targetFrameworks: string[];
  /** Output file per target framework from the design-time evaluation (Debug configuration). */
  outputs: { targetFramework?: string | null; outputUri: string }[];
  assemblyName?: string | null;
  /** Properties/launchSettings.json of the project, when present (the client reads its profiles). */
  launchSettingsUri?: string | null;
}

export interface RunnableProjectsResult {
  projects: RunnableProjectInfo[];
  /** Engine state of the workspace (Loading: the list may still be empty). */
  state: string;
  snapshotId?: string | null;
}

/** code/editActions (protocol 1.9): list the edit actions at a range, or compute one (`actionId`). */
export interface EditActionsParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  range: Range;
  actionId?: string | null;
}

export interface EditActionInfo {
  /** `csharp.edit.*`. */
  actionId: string;
  title: string;
  /** Editor code action kind, e.g. `refactor.rewrite.refyntra.invertIf`. */
  kind: string;
}

export interface EditActionsResult {
  items: EditActionInfo[];
  /** The edits of the requested action (absent when listing or refused). */
  edits?: { range: Range; newText: string }[] | null;
  /** SHA-256 of the document text the edits apply to. */
  documentHash?: string | null;
  reasonCode?: string | null;
  message?: string | null;
  snapshotId: string;
}

/** code/postfix (protocol 1.10): the postfix templates for the expression before the dot that precedes `position`. */
export interface PostfixParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  /** The cursor: right after the dot, or after the part of the template name typed so far. */
  position: Position;
}

export interface PostfixTemplate {
  /** Template name typed after the dot, e.g. `foreach`. */
  name: string;
  /** The inserted code without tab stops (shown in the completion list). */
  detail: string;
  /** VS Code snippet that replaces the expression, the dot and the typed name. */
  snippet: string;
}

export interface PostfixResult {
  items: PostfixTemplate[];
  /** The expression the templates apply to (start to the dot); absent when no template applies. */
  expressionRange?: Range | null;
  typeName?: string | null;
  snapshotId: string;
}

/** Generate kinds of `code/generate` (protocol 1.10). */
export type GenerateKindId = 'constructor' | 'equality' | 'toString' | 'properties' | 'implement' | 'overrides' | 'delegating';

/** code/generate (protocol 1.10): without `kind` the kinds that apply to the type at `position`; with it the edits. */
export interface GenerateParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  position: Position;
  kind?: GenerateKindId | null;
  /** Picked member ids (absent: the preselected ones). */
  members?: string[] | null;
  /** Equality: implement IEquatable<T>. */
  equatable?: boolean;
  /** Equality: generate the == and != operators. */
  operators?: boolean;
}

/** code/constructorActions (protocol 1.11): without `actionId` the actions at `position`; with it the edits, a question or why not. */
export interface ConstructorActionsParams extends WorkspaceParams {
  snapshotId: string;
  uri: string;
  position: Position;
  actionId?: string | null;
  member?: string | null;
  members?: string[] | null;
  /** Create field and inject: the id of a type choice ("T:...") or a typed type name. */
  type?: string | null;
  /** The id of a "constructor" choice (constructorId: `constructor` is reserved in JavaScript objects). */
  constructorId?: string | null;
  /** csharp.ctor.registerDi: the service type (documentation comment id); absent: the type at the position. */
  typeId?: string | null;
}

export interface ConstructorActionInfo {
  /** `csharp.ctor.*`. */
  actionId: string;
  title: string;
  kind: 'quickfix' | 'rewrite';
  preferred: boolean;
  member?: string | null;
  members?: string[] | null;
  typeId?: string | null;
}

export interface Choice {
  id: string;
  label: string;
  detail?: string | null;
  picked: boolean;
}

export interface DocumentEdits {
  uri: string;
  /** SHA-256 of the document text the edits apply to. */
  documentHash: string;
  edits: { range: Range; newText: string }[];
}

export interface RegistrationInfo {
  service?: string | null;
  serviceId?: string | null;
  implementations: Choice[];
  roots: Choice[];
  lifetimes: string[];
}

export interface ConstructorActionsResult {
  items: ConstructorActionInfo[];
  files?: DocumentEdits[] | null;
  /** Ask the user ("members" many, "constructor" / "type" one), then compute again with the answer. */
  need?: 'members' | 'constructor' | 'type' | null;
  choices?: Choice[] | null;
  note?: string | null;
  /** Create field and inject: the injected type is not registered in DI yet. */
  registerTypeId?: string | null;
  registerTypeName?: string | null;
  /** csharp.ctor.registerDi: the choices of the registration (then refactor/prepare csharp.registerDi). */
  registration?: RegistrationInfo | null;
  reasonCode?: string | null;
  message?: string | null;
  snapshotId: string;
}

/** Register in DI (protocol 1.11): PrepareParams.registration of `csharp.registerDi`. */
export interface RegistrationParams {
  typeId?: string;
  lifetime: 'Scoped' | 'Transient' | 'Singleton';
  implementationId?: string;
  rootId?: string;
}

/** Fix in scope (protocol 1.11): PrepareParams.fixAll of `csharp.fixAll`. */
export interface FixAllParams {
  /** A `csharp.edit.*` action that can be applied in a scope. */
  actionId: string;
  scope: 'document' | 'project' | 'solution';
}

export const CSHARP_REGISTER_DI_ACTION = 'csharp.registerDi';
export const CSHARP_FIX_ALL_ACTION = 'csharp.fixAll';

export interface GenerateMember {
  /** Member name (fields, properties), documentation comment id (base / interface members) or `field|id` (delegating). */
  id: string;
  name: string;
  detail: string;
  /** Preselected in the picker. */
  picked: boolean;
  /** Delegating members: the field or property they go through. */
  group?: string | null;
}

export interface GenerateKindInfo {
  kind: GenerateKindId;
  title: string;
  members: GenerateMember[];
}

export interface GenerateResult {
  typeName?: string | null;
  kinds: GenerateKindInfo[];
  edits?: { range: Range; newText: string }[] | null;
  documentHash?: string | null;
  reasonCode?: string | null;
  message?: string | null;
  snapshotId: string;
}

/** The files a plan deletes (protocol 1.6, Safe Delete). */
export interface FileDeleteOffer {
  files: string[];
}

/** workspace/didDeleteFiles (protocol 1.6): files the client deleted; consumes a document sequence. */
export interface DidDeleteFilesParams {
  workspaceId: string;
  sequence: number;
  workspaceRevision: number;
  files: { uri: string }[];
}

/**
 * Code Cleanup (protocol 1.4): a text-only plan over a scope (files, folders, project files). Prepared with
 * `actionId` = CSHARP_CLEANUP_ACTION, `symbolId` '' and `cleanup`; applied like every plan.
 */
export const CSHARP_CLEANUP_ACTION = 'csharp.cleanup';
/** Fix ids, in the order they run on a file. `editorConfigCodeStyle` is known but not offered (the plan says why). */
export const CLEANUP_FIX_IDS = ['removeUnnecessaryUsings', 'sortUsings', 'fileScopedNamespace', 'whitespace', 'editorConfigCodeStyle'] as const;
export type CleanupFixId = (typeof CLEANUP_FIX_IDS)[number];
/** The conservative default profile (setting refyntra.cleanup.profile). */
export const DEFAULT_CLEANUP_PROFILE: readonly CleanupFixId[] = ['removeUnnecessaryUsings', 'sortUsings', 'whitespace'];

export interface CleanupParams {
  /** File, folder or project file URIs; every C# document of the loaded solution under them is in scope. */
  scopeUris: string[];
  /** Fix ids to run (empty: the default profile). Unknown ids are reported in `skipped`. */
  fixes: string[];
}

export interface CleanupReport {
  /** The fixes that ran (id, title). */
  fixes: { id: string; title: string }[];
  /** Changed files with the number of changes per fix. */
  files: { uri: string; fixes: { fixId: string; count: number }[] }[];
  /** Skipped files (uri), fixes in a file (uri + fixId) and fixes (fixId only), with the reason. */
  skipped: { uri?: string; fixId?: string; reasonCode: string; message: string }[];
  /** C# files in the scope. */
  filesInScope: number;
}

/** A folder a generated file can be created in (Generate handler; the first is the default). */
export interface FolderChoice {
  folderUri: string;
  projectName: string;
  /** Existing handlers in the folder. */
  handlerCount: number;
  /** Namespace the generated file gets in this folder. */
  namespace: string;
}

/** The files a create-file plan creates (protocol 1.3) and, for Generate handler, the folder choices. */
export interface FileCreateOffer {
  files: string[];
  folderChoices?: FolderChoice[];
  selectedFolderUri?: string;
}

/** workspace/didCreateFiles (protocol 1.3): files the client created; consumes a document sequence. */
export interface DidCreateFilesParams {
  workspaceId: string;
  sequence: number;
  workspaceRevision: number;
  files: { uri: string }[];
}

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
  /** Created files (protocol 1.3): what a create-file plan creates. Required when the writeSet has a `create`. */
  fileCreate?: FileCreateOffer;
  /** Code Cleanup (protocol 1.4): what the cleanup plan does and what it skipped. */
  cleanup?: CleanupReport;
  /** Rename (protocol 1.5): EF Core migrations that reference the symbol, and whether this plan edits them. */
  efMigrations?: EfMigrationsOffer;
  /** Safe Delete (protocol 1.6): the files the plan deletes. Required when the writeSet has a `delete`. */
  fileDelete?: FileDeleteOffer;
}

/**
 * What to do with generated EF Core migrations that reference a renamed symbol (protocol 1.5):
 * `efMigrations` renames the references in proven migration/model snapshot files too (never strings; the default),
 * `none` leaves them unchanged (the plan is `limited`: the project does not build until the migrations are updated).
 */
export type GeneratedEditsMode = 'efMigrations' | 'none';

export interface EfMigrationsOffer {
  /** The mode this plan was prepared with. */
  mode: GeneratedEditsMode;
  /** The proven EF Core migration/model snapshot files that reference the symbol (edited only in mode `efMigrations`). */
  files: string[];
}

export interface PrepareParams extends WorkspaceParams {
  snapshotId: string;
  /** Action id of the route, e.g. "csharp.rename" (the .fixture conformance route uses "fixture.rename"). */
  actionId: string;
  symbolId: string;
  newName: string;
  /** File rename (protocol 1.2): include the rename of the files named after the type when it is proven safe. */
  renameFile?: boolean;
  /** Generate handler (protocol 1.3): one of the offered folder choices (absent: the default). */
  targetFolderUri?: string;
  /** Move Type to File (protocol 1.3): the document of the cursor (the declaration to move). */
  documentUri?: string;
  /** Code Cleanup (protocol 1.4, action csharp.cleanup): the scope and the fixes. */
  cleanup?: CleanupParams;
  /** Rename (protocol 1.5): what to do with EF Core migrations that reference the symbol (absent: `efMigrations`). */
  generatedEdits?: GeneratedEditsMode;
  /** Extract Method (protocol 1.6): the selection in `documentUri`; the method name comes in `newName`. */
  range?: Range;
  /** Change Signature (protocol 1.6): the new parameter list. */
  signature?: SignatureParams;
  /** Register in DI (protocol 1.11): the service at `documentUri` + `range.start` and the choices. */
  registration?: RegistrationParams;
  /** Fix in scope (protocol 1.11): the edit action and the scope around `documentUri`. */
  fixAll?: FixAllParams;
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

// ---------------------------------------------------------------- stack frames (protocol 1.4)

/**
 * code/resolveFrame: the source symbol of one .NET stack frame. The client decodes compiler names first (async state
 * machines, lambdas, local functions) and sends the user method. Read-only; nothing is executed.
 */
export interface ResolveFrameParams extends WorkspaceParams {
  snapshotId: string;
  /** Dotted type name as the trace prints it ("Ns.Outer.Inner", "Ns.Repo`1"); nested types may use '.' or '+'. */
  typeName: string;
  /** The user method: "Get", ".ctor", ".cctor", "get_Name". */
  methodName: string;
  /** Set when the frame is a local function inside `methodName`. */
  localFunctionName?: string;
  /** Generic arity of the method when the trace shows it ("Get[T]" = 1). */
  methodArity?: number;
  /** Printed parameter type names ("Int32", "String[]", "List`1"); omitted when unknown (async, lambdas). */
  parameterTypes?: string[];
}

/** The frame part of ResolveFrameParams (what the client fills in; the route adds trace/workspace/snapshot). */
export type ResolveFrameRequest = Omit<ResolveFrameParams, 'traceId' | 'workspaceId' | 'snapshotId'>;

export interface FrameCandidate {
  symbol: SymbolRef;
  /** Where to open: the method, or the local function inside it. */
  location: Location;
  /** proven = exact metadata type name and parameter types (one overload); likely = matched by name. */
  confidence: 'proven' | 'likely';
  reason: string;
}

export interface ResolveFrameResult {
  candidates: FrameCandidate[];
  snapshotId: string;
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
  /** Protocol 1.4. */
  'code/resolveFrame': [ResolveFrameParams, ResolveFrameResult];
  /** Protocol 1.6. */
  'code/signature': [SymbolQueryParams, SignatureInfo];
  /** Protocol 1.7. */
  'code/hierarchy': [HierarchyParams, HierarchyResult];
  /** Protocol 1.8. */
  'workspace/runnableProjects': [WorkspaceParams, RunnableProjectsResult];
  /** Protocol 1.9. */
  'code/editActions': [EditActionsParams, EditActionsResult];
  /** Protocol 1.10. */
  'code/postfix': [PostfixParams, PostfixResult];
  'code/generate': [GenerateParams, GenerateResult];
  /** Protocol 1.11. */
  'code/constructorActions': [ConstructorActionsParams, ConstructorActionsResult];
  /** Protocol 1.12. */
  'code/usages': [UsagesParams, UsagesResult];
  /** Protocol 1.13. */
  'code/fileStructure': [FileStructureParams, FileStructureResult];
  /** Protocol 1.14. */
  'code/stepIntoTargets': [StepIntoTargetsParams, StepIntoTargetsResult];
  /** Protocol 1.15. */
  'code/tests': [TestsParams, TestsResult];
  /** Protocol 1.18. */
  'efcore/migrations': [EfMigrationsParams, EfMigrationsResult];
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
  /** Created files (protocol 1.3): files the client created; consumes a document sequence (sent only to hosts with minor ≥ 3). */
  'workspace/didCreateFiles': DidCreateFilesParams;
  /** Deleted files (protocol 1.6): files the client deleted; consumes a document sequence (sent only to hosts with minor ≥ 6). */
  'workspace/didDeleteFiles': DidDeleteFilesParams;
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
export const ANALYSIS_RULE_IDS = ['OR1001', 'OR1002', 'OR1003', 'OR1004', 'OR1005', 'OR1006', 'OR1007', 'OR1008', 'OR1009', 'OR1010', 'OR1011'] as const;
export type AnalysisRuleId = (typeof ANALYSIS_RULE_IDS)[number];
export const OR1001_HELP_URI = 'https://github.com/refyntra/refyntra/blob/main/docs/rules/OR1001.md';
/** The documentation page of a rule (docs/rules/ORxxxx.md). */
export const ruleHelpUri = (id: string): string => `https://github.com/refyntra/refyntra/blob/main/docs/rules/${id}.md`;

export interface AnalysisRunParams extends WorkspaceParams {
  snapshotId: string;
  /** Only results whose primary location is in this document. Omitted = the whole workspace. */
  uri?: string;
  /** Protocol 1.16: documents to run the per-document inspections (OR1002–OR1010) on, e.g. the open C# files. */
  documents?: string[];
}

/** Protocol 1.16: a quick fix of an inspection result, an edit action (`csharp.edit.fix.*`) computed at its start. */
export interface RuleFix {
  actionId: string;
  title: string;
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
  /** Protocol 1.16: quick fixes of an inspection result (none for OR1001). */
  fixes?: RuleFix[];
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
