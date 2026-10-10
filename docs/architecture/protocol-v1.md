# Refyntra protocol v1 (extension ↔ .NET host)

Source of truth for both sides. TypeScript types: `packages/contracts/src/protocol.ts`.
C# DTOs: `src/dotnet/Refyntra.Host/Protocol/*.cs` must serialize to exactly these JSON shapes
(camelCase properties, string enums as the literal strings below, `null`/absent for optional).

## Transport

- JSON-RPC 2.0 over stdio, LSP-style framing: `Content-Length: N\r\n\r\n` + N bytes UTF-8 JSON.
- stdout carries protocol frames only. stderr carries structured log lines (JSON per line:
  `{"ts","level","component","traceId","op","durationMs","status","msg"}`), never source text.
- Max frame: 32 MiB (`limits.maxMessageBytes`, reported by `initialize`).
  - An **oversized** frame sent to the host is dropped without a reply (logged); the host keeps running.
  - A frame with **malformed JSON** gets `-32700` when an `id` can be recovered from the raw text, otherwise it is
    dropped. No malformed frame ever stops the host.
  - The client never sends a frame above `limits.maxMessageBytes`: a document whose `didOpen`/`didChange` would be
    larger is not sent (it is closed on the host if it was open there, so the host uses the saved file), the wire
    sequence is not consumed, and health lists the document as "too large".
  - The client treats a malformed or oversized frame from the host as a fatal transport error and restarts the host.
- Cancellation: notification `$/cancelRequest { id }`. Cancelled request replies error `-32800`. A cancel that
  races with the completion of the request is ignored.
- Every request params object carries `traceId: string`. Requests that need a workspace carry `workspaceId`.

## Positions and text

- Positions zero-based, `character` in UTF-16 code units (same as VS Code and Roslyn).
- `uri` = VS Code `Uri.toString()` of a `file:` URI. The host converts with `new Uri(uri).LocalPath`.
- Content hash = lowercase hex SHA-256 of the UTF-8 encoding of the exact text (line endings kept, no normalization).

## Error codes (JSON-RPC `error.code`, `error.data.reasonCode`)

| code | `reasonCode` | meaning | client reaction |
|---|---|---|---|
| -32700 | `ParseError` | malformed JSON (id recovered) | error |
| -32600 | `InvalidRequest`, `DuplicateId` | not a JSON-RPC request; an id that is still running | error |
| -32601 | `MethodNotFound` | unknown method | error |
| -32602 | `InvalidParams`, `UnsupportedPath`, `InvalidUri` | bad params; `workspace/open` path is not .sln/.slnx/.csproj; not a `file:` URI | error |
| -32603 | `InternalError` | unexpected host exception (message = exception type and text) | error, shown with `recovery` |
| -32800 | `Cancelled` | the request was cancelled | silent |
| -33001 | `ProtocolMismatch` | protocol major differs | route Failed, no restart loop |
| -33002 | `NotInitialized` | request before `initialize` | error |
| -33003 | `TrustRequired` | `workspace/open` with `trusted:false` | route TrustRequired |
| -33004 | `StaleSnapshot` | the request names a snapshot that is not current, or a symbol id minted in another (older) snapshot of this epoch | barrier and retry once |
| -33005 | `UnknownSymbol` | the symbol id is malformed, its project context is not loaded, or it does not resolve in the current snapshot (the symbol was removed or renamed) | **not retried**: shown as an error ("place the cursor on the symbol again") |
| -33006 | `WorkspaceNotLoaded`, `NoProjectsLoaded` | no open workspace (also: closed while a barrier waited); no project loaded | error |
| -33007 | `SdkNotFound` | no .NET SDK for global.json | route Failed |
| -33008 | `BarrierTimeout` | `workspace/snapshotBarrier`: a document sequence was not received within 30 s | client replays every open document (`didOpen`, new sequences) and retries |

`error.data = { reasonCode: string, message: string, recovery?: string }`. The UI shows `message` and, when present,
`recovery`. Several reason codes share one JSON-RPC code (TypeScript: `ErrorCodes`, `ReasonCodes` in protocol.ts).

## Capability ids

The catalogue shared by `initialize.capabilities`, `capability/query` and the UI (TypeScript: `CSHARP_CAPABILITY_IDS`):

| id | answered by | guarantee | notes |
|---|---|---|---|
| `csharp.find` | `code/search` | owned-semantic | `limited` while the load is Partial |
| `csharp.related` | `code/related` | owned-semantic | available whenever the C# route is ready (declarations, implementations, references); framework relations are details of it: a framework that no loaded project references, or an unverified MediatR version, is listed in `limitations`. Framework relations are matched by verified symbol identity; each relation carries `confidence` (`proven`, or `likely` for framework-extension DI registrations and unverified MediatR versions) |
| `csharp.rename` | `refactor/prepare` | owned-semantic | `unknown`/`NoSymbol` without a symbol; `unavailable` with the guard's reason |
| `csharp.references` | `code/references` | owned-semantic | `unknown`/`NoSymbol` without a symbol; shown in the Related view |

Unknown capability ids from newer backends are shown by id.

Outside the catalogue, `capability/query` adds `tests.run` (state `unavailable`, reasonCode `NoPublicTestIntegration`,
message starting with "Run test: unavailable — no supported public test integration") when the subject is a test method or
a test class. It is not part of `initialize.capabilities`.

## Versions

- 1.0: initial.
- 1.1 (additive): `LoadDiagnostic.recoveryActions?: RecoveryAction[]`. The host sends `refyntra.runRestore` with
  `args: [solutionPath ?? projectPath]` when the recovery is `dotnet restore`. A 1.0 client ignores the field.
- 1.1 (additive): `LoadDiagnostic.cause?: "missingAssets" | "missingPackages" | "missingProjectReference"` on the
  diagnostics the host derives itself (absent on raw MSBuild messages). The Health page groups projects by it.
- 1.1 (additive, Stage D): method `analysis/run` (rule results, OR1001); relation kinds `test` and `test.subject` in
  group `tests`; `tests.run` availability. A host that does not know `analysis/run` answers `-32601`; the client shows no
  rule results then. The protocol minor stays 1.
- 1.1 review fixes (pre-release, alpha): error code -33008 `BarrierTimeout` (was -32602), `-32603 InternalError`
  listed; `RevalidateResult.status: "limited"` + `limitations`; capability ids are the catalogue below (the earlier
  `csharp.navigation`, `mediatr.related`, `aspnet.endpoints`, `di.registrations` are gone); `compositionRoot` includes
  the project. The extension and the host ship together.
- Additive (MVC and framework forms): `EndpointInfo.kind: 'mvc'` is now produced (MVC actions; conventional routes
  with `routeIsDynamic: true` and the limitation "conventional route, not resolved"); relation kinds `mediatr.behavior`
  (group `handlers`) and `di.openGenericUsage` (group `registrations`); optional `DiRegistrationInfo` fields
  `implementationKind` (`'type' | 'factory' | 'instance'`), `key` (keyed registrations) and `factoryLocation`. Older
  clients ignore them. The protocol minor stays 1.
- 1.2 (additive, file rename with a type): `PrepareParams.renameFile?: boolean`; `PlannedChange` kind
  `"rename"` `{oldUri, newUri, resultHash}` (only when requested and proven safe, always after every text change);
  `RefactorPlanDto.fileRename?: {files, available, included, reasonCode?, message?}`; notification
  `workspace/didRenameFiles`. A 1.1 host ignores `renameFile` (text-only plans, no offer); a 1.2 client sends
  `workspace/didRenameFiles` only to a host that reported minor ≥ 2 (it consumes a document sequence, which an older
  host would never acknowledge) and restarts the route instead.
- 1.3 (additive, created files): actions `csharp.moveTypeToFile` and `csharp.generateHandler` for `refactor/prepare`
  (offered by `capability/query` outside the catalogue, only where they apply); `PrepareParams.documentUri?` (Move Type
  to File: the cursor's document) and `targetFolderUri?` (Generate handler: one of the offered folders); `PlannedChange`
  kind `"create"` `{uri, resultHash, text}` (always before every text change); `RefactorPlanDto.fileCreate?: {files,
  folderChoices?, selectedFolderUri?}`; notification `workspace/didCreateFiles` `{workspaceId, sequence,
  workspaceRevision, files: [{uri}]}`. A 1.2 host answers `unavailable` / `UnsupportedAction`; a 1.3 client sends
  `workspace/didCreateFiles` only to a host that reported minor ≥ 3 and restarts the route otherwise.
- 1.4 (additive, Code Cleanup): action `csharp.cleanup` for `refactor/prepare` with `symbolId` `""` and
  `PrepareParams.cleanup?: {scopeUris, fixes}`; the plan is text-only and carries `RefactorPlanDto.cleanup?: {fixes,
  files: [{uri, fixes: [{fixId, count}]}], skipped: [{uri?, fixId?, reasonCode, message}], filesInScope}`. A host before
  1.4 answers `unavailable` / `UnsupportedAction`.
- 1.4 (additive, stack trace navigation): request `code/resolveFrame` `ResolveFrameParams` `{traceId, workspaceId,
  snapshotId, typeName, methodName, localFunctionName?, methodArity?, parameterTypes?}` → `ResolveFrameResult`
  `{candidates: [{symbol, location, confidence: "proven" | "likely", reason}], snapshotId}`. The client decodes
  compiler-generated names (async state machines, lambdas, local functions) to the user method before asking and omits
  `parameterTypes` when the frame does not show the user method's parameters. `typeName` is dotted as a trace prints it
  (nested types with `.` or `+`, generic arity with `` `N ``). `proven` = the type was found by its exact metadata name
  and exactly one overload has the printed parameter types (namespace, generic arguments, `&` and C# keyword spellings
  are normalised); everything else is `likely`. Only source symbols are returned (metadata-only symbols have nothing
  to open); a method that no longer exists on a found type yields the type, `likely`. Read-only, no document sequence.
  A client sends it only to a host that reported minor ≥ 4 (an older host would answer `MethodNotFound`).
- Additive (EF Core): relation kinds `efcore.*` and group `data` (above); `SearchFilters.entity?: boolean` ("entity:")
  and `SearchFilters.table?: string` ("table:NAME") return EF Core entities as symbol items. Older hosts ignore the
  filters (they return a normal symbol search); older clients render the kinds and the group generically. The
  protocol minor stays 2.

## Lifecycle

1. `initialize` (request) → `InitializeResult`. Client sends `protocolMajor: 1`. Host replies with its
   own versions and a fresh `sessionEpoch` (opaque). Major mismatch → error -33001.
2. `workspace/open` → `EngineStatus`. Loads with MSBuildWorkspace. Requires `trusted: true`.
   `engine/status` has no `workspaceId`: it describes the first open workspace (or `NotStarted`).
3. `textDocument/*` notifications keep the overlay of open editor buffers.
   `sequence` is zero-based and contiguous per session: the first document event of a session has sequence 0, and
   the initial state (nothing sent yet) is -1. A barrier for -1 returns at once.
   `didClose` always drops the overlay. The document then has the text of the file on disk, decoded with the encoding
   detected when the workspace was loaded. When the file is missing (deleted while open) or unreadable, the document
   is removed from the snapshot, as MSBuild's `*.cs` globbing would drop it on a reload; a later `didOpen` of the
   same path brings it back with that text, and a reload re-reads the project.
4. `workspace/snapshotBarrier { sequence }` → `{ acknowledgedSequence, snapshotId, workspaceRevision }`
   after all document events with `sequence <= requested` are applied. The client calls it before every
   semantic request and passes the returned `snapshotId` in the request.
5. `shutdown` (request) then `exit` (notification). Host exits within 5 s; also exits when stdin closes.

After a host restart the client gets a new `sessionEpoch`, discards all old symbol ids, plans and caches,
re-opens the workspace and replays every open document (`didOpen` with current text and version) before
issuing semantic requests.

## Methods

| method | kind | params | result |
|---|---|---|---|
| `initialize` | req | `InitializeParams` | `InitializeResult` |
| `shutdown` | req | `{traceId}` | `null` |
| `exit` | notif | `{}` | – |
| `engine/status` | req | `{traceId}` | `EngineStatus` |
| `workspace/open` | req | `WorkspaceOpenParams` | `EngineStatus` |
| `workspace/reload` | req | `{traceId, workspaceId}` | `EngineStatus` |
| `workspace/close` | req | `{traceId, workspaceId}` | `null` |
| `textDocument/didOpen` | notif | `{workspaceId, uri, languageId, version, text, sequence, workspaceRevision}` | – |
| `textDocument/didChange` | notif | `{workspaceId, uri, version, text, sequence, workspaceRevision}` (full text) | – |
| `textDocument/didSave` | notif | `{workspaceId, uri, sequence, workspaceRevision}` | – |
| `textDocument/didClose` | notif | `{workspaceId, uri, sequence, workspaceRevision}` (overlay dropped, disk text used; missing file: removed) | – |
| `workspace/didRenameFiles` | notif | `{workspaceId, sequence, workspaceRevision, files: [{oldUri, newUri}]}` (since 1.2; documents move to the new path, overlay kept, no reload; part of the document sequence) | – |
| `workspace/didCreateFiles` | notif | `{workspaceId, sequence, workspaceRevision, files: [{uri}]}` (since 1.3; each file becomes a document of the projects whose membership the plan proved, text from the overlay or disk, no reload; part of the document sequence) | – |
| `workspace/snapshotBarrier` | req | `{traceId, workspaceId, sequence}` | `BarrierResult` |
| `capability/query` | req | `CapabilityQueryParams` | `Availability[]` |
| `code/symbolAt` | req | `SymbolAtParams` | `SymbolRef \| null` |
| `code/search` | req | `SearchParams` | `SearchResult` |
| `code/related` | req | `RelatedParams` | `RelatedResult` |
| `code/resolveFrame` | req | `ResolveFrameParams` (since 1.4) | `ResolveFrameResult` |
| `code/references` | req | `SymbolQueryParams` | `LocationsResult` |
| `code/implementations` | req | `SymbolQueryParams` | `LocationsResult` |
| `refactor/prepare` | req | `PrepareParams` | `PrepareResult` |
| `refactor/revalidate` | req | `{traceId, workspaceId, planId, snapshotId}` | `RevalidateResult` |
| `refactor/discard` | notif | `{workspaceId, planId}` | – |
| `analysis/run` | req | `AnalysisRunParams` `{traceId, workspaceId, snapshotId, uri?}` | `AnalysisRunResult` (since 1.1, additive; see "Analysis") |
| `$/cancelRequest` | notif | `{id}` | – |

All shapes are defined in `packages/contracts/src/protocol.ts`. `PrepareParams.actionId` is a string (the action id
of the route, `csharp.rename` for the C# host).

Provider route ids: `csharp.roslyn` (language route; symbols, references, implementations, rename) and the framework
modules inside it, `csharp.roslyn/mediatr`, `csharp.roslyn/aspnetcore`, `csharp.roslyn/di` (in relation and symbol
provenance). The TypeScript conformance route uses `fixture.engine`.

## Rename plans (refactor/*)

- `refactor/prepare` never writes files. A plan is single use and lives until `refactor/discard`, a reload/close of
  the workspace, eviction (32 plans) or the end of the host process. A prepare that was still running when a reload
  started does not store its plan: it returns `unavailable` / `WorkspaceReloaded`. `readSet` is a conservative
  fingerprint of the whole affected project closure (dependencies **and** reverse dependents): source texts (overlay or
  disk, decoded with the encoding detected at load), project and solution files, `Directory.Build.*`,
  `Directory.Packages.props`, `global.json`, `.editorconfig` in every ancestor directory (present or `"absent"`),
  `obj/project.assets.json`, literal `<Import>`s, `membership:<dir>` (the `*.cs` files on disk) and
  `documents:<contextId>` (the document set of the context). It also covers every project file of the
  solution/workspace, not only the closure (a project outside the closure that adds a `ProjectReference`), and, for a
  workspace opened from a `.csproj`, `projects:<dir>` (the `*.csproj` files next to the opened project).
- Targets are refused at prepare when the file on disk is not UTF-8 (`UnsupportedEncoding`, the message names the
  file) or when a closed target mixes line endings (`MixedLineEndings`: VS Code normalizes them when it loads the file,
  so the result would differ from the preview). Other reason codes: `ReadOnlyFile`, `GeneratedCode`, `MetadataSymbol`,
  `UnsupportedSymbolKind`, `ImplementsMetadataMember`, `InvalidIdentifier`, `SameName`, `IncompleteProjectClosure`,
  `RenameConflict`, `ResourceOperation`, `LinkedContextMismatch`, `NoChanges`, `UnreadableFile`, `WorkspaceReloaded`.
- `validation.status` is `limited` when an MSBuild import with a computed path could not be fingerprinted.
  `compilationDelta: "passed"` means no compiler error (keyed by id, file and span, spans after the rename mapped back
  through the rename's own edits) exists after the rename that did not exist before (a baseline delta, not "zero
  errors"); a rename that adds errors is `unavailable` / `RenameConflict`.
- `refactor/revalidate` must be called after the user confirmed, on the current snapshot (after a barrier):
  `valid`, `limited` (read set unchanged, plan prepared as `limited`: never upgraded to `valid`; `limitations` carries
  the plan's limitations), `stale` (`ReadSetChanged`, `WorkspaceReloaded`, `EpochChanged`) or `invalid`
  (`UnknownPlan` — after a reload, discard, eviction or in another host process; the client reports "the preview
  expired, prepare again"). The client applies a `limited` plan only after a second, explicit confirmation that lists
  the limitations. Revalidation is not a lock: the client checks every target's text hash again synchronously right
  before applying.
- File rename (1.2): for a top-level type whose declaring files are all named after it (`Foo.cs`, partial parts `Foo.*.cs`),
  `fileRename` lists the files and whether renaming them is proven safe. With `renameFile: true` and `available`, the
  `writeSet` ends with one `rename` per file and the read set gets `absent:<newPath>` (absence precondition, also
  ignoring case). Not available (`fileRename.reasonCode`): `FileLocalType`, `FileNameDoesNotMatch`, `OtherTypesInFile`,
  `GeneratedCode`, `UnprovenMembership`, `LinkedFile`, `BuildOutputFolder`, `DefaultCompileItemsDisabled`,
  `CustomItemExcludes`, `CompilePattern`, `ExplicitCompileItem`, `CaseOnlyFileRename`, `ReservedFileName`,
  `SymbolicLink`, `ReadOnlyFile`, `TargetExists`, `SourceFileMissing`, `UnreadableFile`, `NotInWorkspace`,
  `NoTextChange`. Revalidation re-runs the file guards and the membership proof: `stale` / `TargetExists` or
  `FileRenameUnsafe`.

- Created files (1.3): `refactor/prepare` with `actionId` `csharp.moveTypeToFile` (with `documentUri`) or
  `csharp.generateHandler` (with optional `targetFolderUri`). The `writeSet` starts with one `create` per new file
  (`text` is the full content, `resultHash` its SHA-256), followed by the text change of the original file (Move Type to
  File only); the read set gets `absent:<newPath>` and the anchor file. Guards and reason codes: `TargetExists`,
  `InvalidFileName`, `ReservedFileName`, `SymbolicLink`, `SourceFileMissing`, `UnreadableFile`, the membership codes of
  the file rename (`UnprovenMembership`, `LinkedFile`, `BuildOutputFolder`, `DefaultCompileItemsDisabled`,
  `CustomItemExcludes`, `CompilePattern`, `ExplicitCompileItem`), `CompilationErrors`, `FileTooLarge`; Move Type to File:
  `PartialType`, `FileLocalType`, `GeneratedCode`, `PreprocessorDirectives`, `UnsupportedLayout`, `MeaningChanges`,
  `ReadOnlyFile`, `UnsupportedEncoding`, `MixedLineEndings`, `NotApplicable`; Generate handler: `NotARequest`,
  `GenericRequest`, `AbstractRequest`, `InaccessibleRequest`, `HandlerExists`, `MediatRVersionUnverified`,
  `AmbiguousRequest`, `NoHandlerProject`, `UnknownFolder`. Revalidation checks absence and membership first: `stale` /
  `TargetExists` or `FileCreateUnsafe`. The client creates each file before applying the text change (ADR-004
  Amendment 2) and then sends `workspace/didCreateFiles`.

- Code Cleanup (1.4): `refactor/prepare` with `actionId` `csharp.cleanup`, `symbolId` `""` and `cleanup: {scopeUris,
  fixes}` (file, folder or `.csproj` URIs; fix ids `removeUnnecessaryUsings`, `sortUsings`, `fileScopedNamespace`,
  `whitespace`; empty = the default profile; `editorConfigCodeStyle` and unknown ids are reported in `skipped` as
  `NotOffered` / `UnknownFix`). The `writeSet` has only `text` changes; files and fixes that are not provably safe are
  listed in `plan.cleanup.skipped` (ADR-004 Amendment 3 lists the codes). Refusals: `NoFixes`, `NoScope`,
  `NoFilesInScope`, `ScopeTooLarge` (more than 2000 C# files), `NoChanges` (nothing to change; the message counts the
  skipped files by reason), `IncompleteProjectClosure`. Revalidation is the ordinary read-set check.

## Relation kinds (alpha)

`declaration`, `mediatr.handler`, `mediatr.request`, `mediatr.response`, `mediatr.send`,
`mediatr.notificationHandler`, `mediatr.behavior`, `aspnet.endpoint`, `di.registration`, `di.implementation`, `di.service`,
`di.openGenericUsage`, `efcore.entity`, `efcore.dbContext`, `efcore.configuration`, `efcore.navigation`, `efcore.table`,
`efcore.query`, `efcore.migration`,
`implementation`, `reference`, `test`, `test.subject`. Clients must tolerate unknown namespaced kinds (`<namespace>.<name>`)
and unknown groups from newer backends or framework modules and render them generically.

HTTP links (TS side only, never sent by the host): `http.call` (group `endpoints` from a client call site, with
`target.endpoint`; group `clients` from an endpoint, with `target.location` = the call site) and `http.handler` (group
`handlers`, `target.symbol` = the endpoint's handler). Their confidence is always `heuristic` and their provenance is
`{ kind: "heuristic", providerRouteId: "http.links", basis }` (additive `HeuristicProvenance`; `sessionEpoch`/`snapshotId`
of the C# result that listed the endpoints). The endpoint list comes from the existing `code/search` with
`filters.route = ""` (every endpoint, with methods, route, location and handler); no new method was needed.

`RelatedResult` has no groups list: every entry of `relations` carries its `group`. The UI orders groups as
declarations, handlers, callers, clients (TS-side HTTP links), endpoints, data, registrations, implementations, references, tests; unknown groups
follow in name order.

EF Core kinds (provider route `csharp.roslyn/efcore`, group `data` unless noted): `efcore.entity` (DbContext or
configuration → entity; `target.symbol` = the entity, or only a location with confidence `heuristic` and label
"Unknown entity types: …" for dynamic model building), `efcore.dbContext` (entity/configuration → DbContext),
`efcore.configuration` (configuration class, or the location of an `Entity<T>()` call), `efcore.table` (label = the
table, `schema.name` when a schema is set; "Name (convention)" with confidence `likely` when no `ToTable`/`[Table]`
exists), `efcore.navigation` (the other entity; label names the property, the fluent shape such as
`HasMany/WithOne`, inverse and FK), `efcore.query` (group `callers`: uses of `DbSet<T>`/`Set<T>()` per method, or per
lambda in top-level statements; an enclosing endpoint adds an `aspnet.endpoint` relation), `efcore.migration`
(migrations and model snapshots, label ends with "read-only"; by `[DbContext]` attribute `proven`, by table/entity name
`likely`).

`RelatedResult.scopeNotes` (human-readable strings, e.g. "17 of 18 projects loaded completely" and one line per
detected framework with its assembly identities) stays for compatibility. `RelatedResult.scopeDetails` (optional,
additive) carries the same information structured, so the client can explain it in plain language:

```ts
ScopeDetails = {
  projectsTotal: number; projectsComplete: number;  // loaded without load errors
  projectsPartial: number;                          // loaded with load errors (e.g. packages not restored)
  projectsFailed: number;                           // not loaded
  causes: { missingAssets: number; missingPackages: number; missingProjectReferences: number;
            loadFailures: number; otherErrors: number };   // projects per cause (a project may count twice)
  restoreRecommended: boolean;                      // "dotnet restore" is the recovery for an incomplete project
  solutionPath: string | null;                      // the loaded solution/project (restore target)
  frameworks: { id: 'mediatr' | 'aspnetcore' | 'di' | string; name: string;
                evidence: string;                   // assembly identities (tooltip text, not a label)
                versionVerified: boolean }[];       // false: that framework's relations are reported as likely
}
```

Detection of ASP.NET Core and Microsoft.Extensions.DependencyInjection is evidence only and never lowers confidence
(`versionVerified` is always true for them); only MediatR checks its version range. Older hosts omit `scopeDetails`;
clients then fall back to `scopeNotes`.

Tests (group `tests`): `test` — a test method (xUnit `Xunit.FactAttribute` from `xunit.core`/`xunit.v3.core`,
NUnit `Test`/`TestCase`/`TestCaseSource`/`Theory` from `nunit.framework`, MSTest `TestMethod` from
`Microsoft.VisualStudio.TestPlatform.TestFramework`/`MSTest.TestFramework`, base attribute types included; identity is
full metadata name + assembly) whose body references the subject, `confidence: "proven"`, label
`<Class>.<Method> — references the symbol — not coverage`; or a test class named `<Subject>Tests`/`<Subject>Test` that does
not reference it, `confidence: "heuristic"`, label `<Class> — name match only (heuristic)`. `test.subject` — from a test
method or class: a production symbol (declared in a non-test project of the solution) that it references. At most 50 per
direction. Only xUnit is exercised by a fixture (DiRules.Tests); NUnit/MSTest identities are taken from their packages.

`DiRegistrationInfo.compositionRoot` names the containing method and the project, e.g. `Program.<Main>$ (Shop.Api)`
or `Shop.Api.Infrastructure.InfrastructureServiceCollectionExtensions.AddShopInfrastructure (Shop.Api)`: two apps with
top-level statements are two composition roots.

## Analysis (`analysis/run`, since 1.1)

Runs the rules on the given (current) snapshot; `-33004 StaleSnapshot` otherwise, like every `code/*` request. With
`uri`, only results whose primary location is in that document are returned. Results are cached per immutable snapshot
and, per connected group of composition roots, reused across snapshots while their dependencies are unchanged
(docs/rules/OR1001.md "Incremental invalidation").

```ts
AnalysisRunResult = {
  diagnostics: RuleDiagnostic[];   // proven results only; the client publishes them in its own DiagnosticCollection
  abstentions: RuleAbstention[];   // why a rule did not decide; explanation only, never a Problems entry
  completeness: 'complete' | 'partial' | 'unknown';
  snapshotId: string;
}
RuleDiagnostic = { id: 'OR1001', severity: 'warning', message, location,          // location = singleton registration
                   relatedLocations: [{ location, message }],                    // the proof path, in order
                   evidence: Evidence[], confidence: 'proven', completeness, compositionRoot?, helpUri? }
RuleAbstention = { ruleId, reason, message?, location?, compositionRoot? }
```

Rule ids: `OR1001` (docs/rules/OR1001.md). Abstention reasons are listed there.
