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

### Not this protocol: the Python and Rust language servers

Protocol v1 is the extension ↔ .NET host protocol only. Python and Rust are served by language servers Refyntra bundles
and runs itself (Pyright, rust-analyzer; ADR-002 amendment). They speak standard LSP over the same stdio framing
(`Content-Length`, JSON-RPC 2.0, `$/cancelRequest`), driven by Refyntra's own client
(`packages/infrastructure/src/lspClient.ts`):

- Client → server: `initialize` (workspace folders, read-only client capabilities: no `applyEdit`, `positionEncodings`
  `utf-16`, `experimental.serverStatusNotification`), `initialized`, `textDocument/didOpen|didChange|didClose` (full
  text; versions are the application's monotonic document sequence), `workspace/didChangeWatchedFiles` (closed files
  changed on disk), `workspace/symbol`, `textDocument/documentSymbol|definition|references|implementation|prepareRename|rename`,
  `shutdown`, `exit`.
- Server → client requests answered: `workspace/configuration` (per section; diagnostics off), `workspace/workspaceFolders`,
  `client/(un)registerCapability`, `window/workDoneProgress/create`, refresh requests (all `null`);
  `workspace/applyEdit` is always refused (`applied: false`): edits reach files only through Refyntra's preview and
  EditApplier. Anything else: `-32601`.
- LSP errors `-32800` RequestCancelled, `-32801` ContentModified and `-32802` ServerCancelled make a result stale (asked
  again); a malformed frame closes the session (the route restarts the server with backoff).
- Server URIs are normalised to VS Code's `Uri.toString()` form before comparison.

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
- 1.5 (additive, EF Core migrations in a rename): `PrepareParams.generatedEdits?: "efMigrations" | "none"` (absent =
  `"efMigrations"`) and `RefactorPlanDto.efMigrations?: {mode, files}` (present when proven EF Core migration/model
  snapshot files reference the symbol). `efMigrations`: the edits in those files are allowed only when each one renames
  an identifier that binds to the symbol (never a string). `none`: the files are not edited, new compiler errors in
  them are expected (`compilationDelta` `"failed"`), the plan is `limited` with the limitation "The project will not
  build until the migrations are updated: …". Files are proven by the verified `DbContextAttribute`
  (Microsoft.EntityFrameworkCore), `MigrationAttribute` + `Migration` base type or `ModelSnapshot` base type, naming a
  DbContext declared in source. Other generated code is still refused (`GeneratedCode`). A host before 1.5 ignores
  `generatedEdits` and refuses such renames as generated code.
- 1.6 (additive, code refactorings): actions `csharp.safeDelete`, `csharp.extractMethod` and `csharp.changeSignature`
  for `refactor/prepare` (offered by `capability/query` outside the catalogue, only where they apply);
  `PrepareParams.range?: Range` (Extract Method: the selection in `documentUri`, the method name in `newName`,
  `symbolId` `""`) and `PrepareParams.signature?: {parameters: [{from?, name, type?, defaultValue?, callSiteValue?}]}`
  (Change Signature); `PlannedChange` kind `"delete"` `{uri, expectedHash}` (always last, after every text change and
  file rename); `RefactorPlanDto.fileDelete?: {files}`; request `code/signature` `SymbolQueryParams` →
  `{name?, display?, parameters: [{name, type, defaultValue?, modifiers}], reasonCode?, message?, snapshotId}`;
  notification `workspace/didDeleteFiles` `{workspaceId, sequence, workspaceRevision, files: [{uri}]}`. A host before
  1.6 answers `unavailable` / `UnsupportedAction` (and `MethodNotFound` for `code/signature`, which a client sends only
  to a host that reported minor ≥ 6); a 1.6 client sends `workspace/didDeleteFiles` only to a host that reported
  minor ≥ 6 and restarts the route otherwise.
- 1.7 (additive, call and type hierarchy): request `code/hierarchy` `{traceId, workspaceId, snapshotId, symbolId,
  direction: "incoming" | "outgoing" | "supertypes" | "subtypes"}` → `{items: [{symbol: SymbolRef, fromRanges: Range[],
  fromUri?}], completeness, truncated, snapshotId}`. Incoming: the callers (Roslyn `FindCallers`; calls inside lambdas
  and local functions belong to the containing member; a type's callers are those of its constructors), `fromRanges`
  the call sites in the caller's document. Outgoing: the methods and constructors called from the subject's body, with
  the call sites in the subject's document. Supertypes: the direct base class (not `object`/`ValueType`/`Enum`) and the
  direct interfaces; subtypes: direct derived classes, implementations and derived interfaces. Only neighbours declared
  in source are returned (an item needs a document); at most 500 (`truncated`). An unknown direction is
  `InvalidParams`. A client sends it only to a host that reported minor ≥ 7; the extension resolves the subject with
  `code/symbolAt` on the same snapshot first and keeps only positions in its items (symbol ids are per snapshot).
- 1.8 (additive, Run and Debug): request `workspace/runnableProjects` `{traceId, workspaceId}` → `{projects:
  [{name, projectUri, kind, runnable, reason?, windowsOnly, targetFrameworks, outputs: [{targetFramework?, outputUri}],
  assemblyName?, launchSettingsUri?}], state, snapshotId?}` on the current snapshot (no barrier: the project model does
  not depend on open buffers). `kind` is `console | web | worker | winforms | wpf | test | library | maui |
  blazor-wasm`, classified from the loaded MSBuild evaluation (output kind, output path and target framework of every
  Roslyn project instance; resolved metadata references such as `xunit.core.dll`, `PresentationFramework.dll`) and the
  project file (SDK, `UseWPF`, `UseWindowsForms`, `UseMaui`, `IsTestProject`, test PackageReferences, also from
  `Directory.Build.props` above it). Multi-targeting projects are one entry with several `targetFrameworks`. Test
  projects, libraries, MAUI and Blazor WebAssembly are listed with `runnable: false` and a `reason`; WinForms/WPF are
  runnable with `windowsOnly: true`. The client reads the profiles of `launchSettingsUri` itself. While the workspace
  loads, `projects` is empty and `state` says so. A client sends it only to a host that reported minor ≥ 8.
- 1.9 (additive, edit actions): request `code/editActions` `{traceId, workspaceId, snapshotId, uri, range, actionId?}`
  → `{items: [{actionId, title, kind}], edits?: [{range, newText}], documentHash?, reasonCode?, message?, snapshotId}`.
  Without `actionId` it lists the single-document edit actions that apply at the range (a syntax pass with a few
  semantic queries, no compilation); ids are `csharp.edit.*` (toBlockBody, toExpressionBody, varToExplicit,
  explicitToVar, invertIf, ifToTernary, ternaryToIf, mergeNestedIf, splitIf, toInterpolatedString, inlineVariable,
  introduceVariable, introduceVariableAll) and `kind` is the editor code action kind. With `actionId` the host rewrites
  the syntax tree, formats only the rewritten nodes (document options, .editorconfig) and returns the minimal edits
  of the document with the SHA-256 of the text they apply to, or `reasonCode`/`message` when the action is refused
  (`NotApplicable`, `CompilationErrors` — the document would get a compiler error it did not have —, `SideEffects`,
  `EvaluationOrder`, `VariableWritten`, `ReadOnlyFile`, …). Never writes files; the client applies the edits as one
  undo step only while the document version is the one the request was made for. Sent only to hosts with minor ≥ 9.
- 1.10 (additive, postfix templates and Generate):
  - action id `csharp.introduceParameter` (Introduce Parameter) for `refactor/prepare` with `symbolId` `""`,
    `documentUri` and `range` of exactly one expression in a method body: a text-only plan built like Change Signature
    (new parameter before optional/`params` parameters, every call site of the hierarchy passes the expression).
    `code/editActions` lists it as `csharp.edit.introduceParameter` (computing that id refuses with `UsePlan`), and
    the Introduce Field / Constant choices as `csharp.edit.introduceField.{initializer,initializerAll,constructor,
    constructorAll,member}` / `csharp.edit.introduceConstant.{local,class}` (titles share the prefix before `: `).
  - request `code/postfix` `{traceId, workspaceId, snapshotId, uri, position}` → `{items: [{name, detail, snippet}],
    expressionRange?, typeName?, snapshotId}`. `position` is right after a dot or after the part of a template name
    typed after it (`list.fo`). The host replaces the dot and the typed name with `;` in a copy of the document (so
    `list.` followed by more code parses as the statement `list;`), takes the largest expression that ends at the dot
    (the right side of an assignment) and lists the templates its type allows: `if`/`while` (bool statement), `not`
    (bool), `ifn`/`notnull` (reference, nullable value or unconstrained type parameter), `var`, `foreach` (arrays,
    strings, `IEnumerable`, `GetEnumerator()`), `for`/`forr` (arrays, strings, an `int` indexer with `Count`/`Length`),
    `await` (a `GetAwaiter()`), `return` (a member that returns a value, not an iterator), `throw` (exceptions),
    `new` and `nameof` (type names; `new` only for creatable classes and structs), `par`, `cast`, `arg`, `using`
    (`IDisposable`, `await using` for `IAsyncDisposable` only), `lock` (reference types), `switch`, `nameof` (locals,
    parameters, members), `yield` (methods returning an enumerable or enumerator). Statement templates are offered
    only when the expression is a whole expression statement; they are formatted with the document's options in place
    of that statement and returned with the statement's own indentation removed (the editor re-indents snippet lines).
    `snippet` is VS Code snippet syntax (`$`, `\` escaped; `${1:name}` tab stops with mirrors, `$0` the final cursor)
    that replaces `expressionRange.start` … `position`; local names come from the expression (member or method name
    without `Get`, singular for `foreach`) or its type and are unique in the member. Nothing in comments, strings,
    namespaces, after `?.`/`..`, a space before the dot, number literals or `void` calls. No compilation; never writes
    files.
  - request `code/generate` `{traceId, workspaceId, snapshotId, uri, position, kind?, members?, equatable?,
    operators?}` → `{typeName?, kinds: [{kind, title, members: [{id, name, detail, picked, group?}]}], edits?,
    documentHash?, reasonCode?, message?, snapshotId}`. Without `kind` it lists what applies to the class, struct or
    record at `position` (interfaces and static classes: nothing): `constructor` (instance fields and auto-properties
    of every part; no primary constructor), `equality` (not records), `toString`, `properties` (fields without a
    property of the PascalCase name), `implement` (interface members without an implementation and, for a
    non-abstract type, abstract members of the base types), `overrides` (virtual / abstract / override members of the
    base types not overridden yet, most derived only) and `delegating` (public members of the types of the instance
    fields and properties, `group` = the field). Member ids are member names, documentation comment ids, or
    `field|id` for delegating. With `kind` the host writes the members (types fully qualified, then the needed usings
    are added and the names simplified), inserts them into the part at the cursor (constructor: after the fields,
    constructors and properties; otherwise at the end), formats them with the document options and returns the
    minimal edits with the SHA-256 of the text, or a refusal: `NoType`, `NotApplicable`, `UnknownMember`, `NoMembers`,
    `CompilationErrors` (a compiler error the document did not have, e.g. a constructor with the same signature),
    `ReadOnlyFile`. Equality: `equatable` adds `IEquatable<T>` and `Equals(T)`, `operators` adds `==`/`!=`;
    `GetHashCode` uses `HashCode.Combine` (more than 8 members: `HashCode.Add`). `members` absent = the preselected
    ones. Never writes files; the client applies the edits as one undo step only to the same document version.
    Both are sent only to hosts with minor ≥ 10.
- 1.11 (constructor / DI helpers, Register in DI, Fix in scope):
  - request `code/constructorActions` `{traceId, workspaceId, snapshotId, uri, position, actionId?, member?, members?,
    type?, constructorId?, typeId?}` → `{items: [{actionId, title, kind, preferred, member?, members?, typeId?}],
    files?: [{uri, documentHash, edits}], need?, choices?: [{id, label, detail?, picked}], note?, registerTypeId?,
    registerTypeName?, registration?, reasonCode?, message?, snapshotId}`. Without `actionId` it lists the actions at
    `position` (`kind` `quickfix` | `rewrite`): on a constructor parameter `csharp.ctor.introduceField` /
    `.introduceProperty` / `.initializeExisting` (`member`) / `.initializeAllParameters` / `.registerDi` (`typeId`);
    on an unassigned readonly field or get-only auto-property `.initializeMembers` (`members`); on an undeclared
    field-shaped name (`_x`, `m_x`) `.createInjectedField` (`member`); on the type header `.generate` (computed by
    `code/generate` kind `constructor`) and `.addParameters`. Positional record parameters get nothing. With
    `actionId` the host computes the change over every part of a partial type (types fully qualified, usings added,
    names simplified, field names from the `.editorconfig` naming rules for private instance fields, else the
    existing fields, else `_camelCase`; `this.` kept only where needed or required by
    `dotnet_style_qualification_for_field`), formats the new nodes, and returns `files` (minimal edits per document
    with the SHA-256 of its text; the client applies all of them only while every document has that text), or a
    question `need` = `members` (pick many) | `constructor` (pick one; answered with `constructorId`) | `type` (pick
    one or a typed name; answered with `type`) with `choices` and the prompt in `message`, or a refusal: `NoType`,
    `StaticType`, `NotApplicable`, `UnknownMember`, `NameTaken`, `NoMembers`, `NothingToDo`, `NoConstructor`,
    `CallSites` (the constructor is called with `new`, `: this` / `: base`, or a parameterless one is inherited
    implicitly), `PrimaryConstructorScope`, `UnknownType`, `CompilationErrors` (a compiler error a changed document
    did not have), `ReadOnlyFile`, `GeneratedCode`. `.createInjectedField` infers the type from a well-known name
    (`_logger` → `ILogger<T>` when Microsoft.Extensions.Logging is referenced, `_mediator`, `_configuration`, …), an
    assignment, or the solution types that have every member used on the name (the only interface, else the only
    type); `registerTypeId` names the type when the DI facts show no registration for it. `actionId`
    `csharp.ctor.registerDi` returns `registration` `{service, serviceId, implementations, roots, lifetimes}` or a
    refusal (`NoType`, `FrameworkType`, `AlreadyRegistered`, `NoImplementation`, `NoCompositionRoot`); the roots are
    the composition roots of the DI facts (methods / top-level code with unconditional registrations or service
    collection calls), each with the last such statement as the insertion point. Never writes files. Sent only to
    hosts with minor ≥ 11.
  - `refactor/prepare` action `csharp.registerDi`: `PrepareParams.registration` `{typeId?, lifetime, implementationId?,
    rootId?}` with `documentUri` + `range.start` at the service (a constructor parameter or a type). The plan adds
    `receiver.Add{Lifetime}<Service, Implementation>();` after the root's last registration (before a `return
    services;`), with usings; it is compile-checked and revalidated like the other code plans. Refusals: those of the
    description plus `ChooseImplementation`, `ChooseCompositionRoot`, `InvalidParams`.
  - `refactor/prepare` action `csharp.fixAll`: `PrepareParams.fixAll` `{actionId, scope}` with `documentUri`. `actionId`
    is one of `csharp.edit.varToExplicit`, `.explicitToVar`, `.toExpressionBody`, `.toBlockBody`,
    `.usingToDeclaration`, `.toObjectInitializer`, `.toInterpolatedString`, `.stringFormatToInterpolated`; `scope` is
    `document`, `project` (every project of the document) or `solution`. Every occurrence is computed exactly like
    the single edit action; a document that would get a new compiler error is redone occurrence by occurrence and
    the occurrences that add an error are skipped (a limitation says how many); generated and read-only files are
    skipped. One plan (compile-checked, revalidated, applied by the EditApplier, Undo); the request honours
    `$/cancelRequest`. Refusals: `NotApplicable` (not a scope action), `NoDocument`, `NoChanges`,
    `TooManyOccurrences` (more than 20000), `InvalidParams`. Compiler and third-party analyzer diagnostics are not
    fixed in scope (Refyntra has no code fixes for them); OR1001 deliberately has no code fix.
- 1.12 (additive): Find Usages grouped and Navigate To.
  - `code/usages` `UsagesParams` `{traceId, workspaceId, snapshotId, symbolId, limit?}` → `UsagesResult` `{subject,
    items, total, truncated, completeness, snapshotId}`. Items are the source references of the symbol (Roslyn
    `FindReferences`, implicit references left out), ordered by file and position, at most `limit` (default 1000, at
    most 50000; `total` is the full count and `truncated` says that the list was cut; the client's "Show more" asks
    again with a higher limit). Each `UsageItem` has `uri`, `range` (the name), `kind`, `containingMember` (lambdas and
    local functions belong to their member; accessors to their property; null at type level), `containingType`,
    `projectName`, `isTest` (the project references xUnit, NUnit or MSTest, or the containing method / type is a test)
    and `lineText` (the whole line, untrimmed, at most 400 characters). `kind`: `read`, `write` (simple assignment,
    `out` argument, deconstruction target, event `+=` / `-=`), `readWrite` (compound assignment, `++` / `--`, `ref`
    argument), `invocation` (also `?.Invoke(…)` of an event or delegate and constructor initializers), `nameof`,
    `attribute`, `inheritance` (base list: base class or implemented interface), `typeArgument` (also `T[]` / `T?`
    inside a type argument), `objectCreation` (`new T(…)`, target-typed `new()` of a constructor), `other` (type
    references in declarations, method groups, …). The request honours `$/cancelRequest`. Sent only to hosts with
    minor ≥ 12.
  - `code/hierarchy` directions `bases` (a type: its base classes nearest first, then all interfaces; a method, property
    or event: the overridden chain, then the interface members implemented by it or by a member it overrides; source
    symbols only, in that order) and `containing` (the type that declares a member or nested type; for a local or a
    parameter the type of its member). Sent only to hosts with minor ≥ 12; an older host answers `InvalidParams`.
- 1.13 (additive): File Structure.
  - `code/fileStructure` `FileStructureParams` `{traceId, workspaceId, snapshotId, uri, includeInherited?}` →
    `FileStructureResult` `{types, regions, reasonCode?, completeness, snapshotId}`. `types` lists every type declared
    in the document in source order (nested types too, as types of their own with `containingType`; every partial part
    in this document), each `StructureType` with `name`, `fullName` (containing types, no namespace: `Order.Line`),
    `kind` (`class`, `struct`, `interface`, `enum`, `record`, `recordStruct`, `delegate`), `accessibility`
    (`public`, `internal`, `protected`, `private`, `protectedInternal`, `privateProtected`), `isStatic`,
    `signature` (`OrderService : IOrderService`), `range`, `selectionRange` (the name), `region`, `members` and
    `inherited`. A `StructureMember` has `name`, `kind` (`method`, `constructor`, `destructor`, `property`,
    `indexer`, `field`, `constant`, `event`, `operator`, `enumMember`), `accessibility`, `isStatic`, `signature`
    (`Find(int) : OrderDto?`, `Total : decimal`, `this[int] : string`), `range`, `selectionRange`, `region` (the
    innermost `#region`), and for inherited members `declaringType`, `uri` (null for metadata) and `navigable`.
    Members are those written in this document (positional record parameters count as properties); other partial parts
    are not listed. With `includeInherited`, `inherited` lists the members of the base classes nearest first (an
    interface: of all its base interfaces), without `object`, `ValueType` and `Enum`, constructors, accessors,
    implicitly declared members, members inaccessible from the type, and members the type (any partial part) overrides
    or redeclares. `regions` are the `#region` / `#endregion` pairs (name, range). `reasonCode` `DocumentNotFound`:
    the document is not in the snapshot. Sent only to hosts with minor ≥ 13.
- 1.14 (additive): Smart Step Into.
  - `code/stepIntoTargets` `StepIntoTargetsParams` `{traceId, workspaceId, snapshotId, uri, position}` →
    `StepIntoTargetsResult` `{targets, statement?, nextStatement?, reasonCode?, snapshotId}`. `position` is where a
    debugger stopped (the start of its sequence point, 0-based); leading blanks are skipped. The host takes the
    innermost statement (not a block) or expression body there and lists its invocations and object creations in the
    order they run (an argument or receiver before the call that uses it); calls inside lambdas, local functions and
    nested statements (a loop body when stopped at the loop header) are not calls of this statement. Each
    `StepIntoTarget` has `label` (`Calc.Add(int, int)`), `detail` (the call as written, one line, at most 80
    characters), `kind` (`method`, `constructor`, `delegate`), `callRange`, `breakAt` (a `Location` with an empty
    range: the first statement of the callee's body, its expression body, a constructor initializer, or the closing
    brace of an empty body; extension methods, generic and partial methods resolve to their source definition), and
    `reason` when `breakAt` is null: `metadata` (no source in the solution), `noBody` (abstract, interface, extern,
    partial without implementation: the method that runs is chosen at run time), `delegate`, `implicit`
    (compiler-generated constructor). `isVirtual`: an override may run instead. `statement` is the stopped statement;
    `nextStatement` the next statement of the same block, of the top-level statements, or the closing brace when the
    statement is the last of a member body (null otherwise, e.g. the last statement of a loop body). `reasonCode`:
    `DocumentNotFound`, `NoStatement`. Sent only to hosts with minor ≥ 14.
- 1.18 (additive): EF Core tools (ADR-011). (1.17 is used by another feature branch; the numbers only grow.)
  - `efcore/migrations` `EfMigrationsParams` `{traceId, workspaceId, snapshotId}` → `EfMigrationsResult` `{contexts,
    state, snapshotId}`, read from source only (nothing is built or run, no database is accessed). `contexts`: every
    non-abstract class deriving from EF Core's `DbContext` (by full name and assembly), ordered by name: `{name, fullName,
    projectName, projectUri, migrationsProjectUri (the project with its snapshot or migrations, else the context's: the
    `dotnet ef --project`), migrationsNamespace?, location?, onModelCreating?, migrations, snapshot?, configurations}`.
    `migrations`: classes deriving from `Migration` with `[Migration("id")]`, belonging to the context of their
    `[DbContext(typeof(X))]` (or to the only DbContext when that attribute is missing), ordered by id (EF Core's order):
    `{id, name (the id without its 14-digit timestamp), className, location? (the declaration with `Up`),
    designerLocation? (the `.Designer.cs` part)}`. `snapshot`: the `ModelSnapshot` of the context `{name, location?}`.
    `configurations`: `IEntityTypeConfiguration<T>` classes whose `T` is a `DbSet` entity of the context. Null fields
    are omitted. Applied/pending is not part of the protocol: the client asks `dotnet ef migrations list --json` only on
    the user's request.
  - Inspection `OR1011` (possible N+1, docs/rules/OR1011.md) in `analysis/run` `documents`, with the fix
    `csharp.edit.fix.addInclude` (also accepted by `csharp.fixAll`). Sent only to hosts with minor ≥ 18.
- 1.16 (additive): inspections. `analysis/run` `documents?` runs OR1002–OR1010 on those documents (section
  Analysis); `RuleDiagnostic.fixes?` lists their quick fixes, edit actions `csharp.edit.fix.awaitSyncCall`,
  `asyncVoidToTask`, `addAwait`, `discardTask`, `usingVar`, `materialize`, `stringBuilder`, `predicateOverload`,
  `removeMaterialization`, `removeFormat` (also accepted by `csharp.fixAll`). `addAwait` / `discardTask` also apply at
  an unawaited call the compiler reports as CS4014. Sent only to hosts with minor ≥ 16.
- 1.15 (additive): test discovery for the Test Explorer (ADR-009).
  - `code/tests` `TestsParams` `{traceId, workspaceId, snapshotId, uris?}` → `TestsResult` `{projects, tests,
    documents?, state, snapshotId}`. `projects`: every project that references a test framework assembly (xUnit
    `xunit.core` / `xunit.v3.core`, NUnit `nunit.framework`, MSTest), one per project file: `{name, projectUri,
    frameworks}`. `tests`: `TestMethodInfo` `{projectUri, uri, framework (xUnit | NUnit | MSTest), namespace, classes
    [{name, range, nameRange}] (outermost first), method, fullyQualifiedName ("Ns.Outer+Inner.Method", as test adapters
    report it, without data arguments), range, nameRange, cases [{label, arguments, range}], dynamicCases,
    skipReason?}`. A test is a method with a test attribute identified by attribute identity (as in Related); abstract
    and generic classes are left out. `cases` are the data rows written in source (`[InlineData]`, `[TestCase]`,
    `[DataRow]`, positional arguments): `label` as written ("(1, 2, 3)"), `arguments` normalised for matching results
    (quotes, numeric suffixes and enum type names removed, no blanks, lower case). `dynamicCases`: `[MemberData]`,
    `[ClassData]`, `[TestCaseSource]`, `[DynamicData]` or a parameterised test without rows. `skipReason`: xUnit
    `Skip =`, NUnit / MSTest `[Ignore]`. With `uris` only those documents are scanned (incremental update);
    `documents` echoes them and the client replaces their earlier tests. Sent only to hosts with minor ≥ 15.
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
| `code/signature` | req | `SymbolQueryParams` | `SignatureInfo` (since 1.6; Change Signature) |
| `code/hierarchy` | req | `HierarchyParams` `{…, symbolId, direction}` | `HierarchyResult` (since 1.7; call and type hierarchy; `bases` / `containing` since 1.12) |
| `workspace/runnableProjects` | req | `WorkspaceParams` | `RunnableProjectsResult` (since 1.8; Run and Debug, no barrier) |
| `code/editActions` | req | `EditActionsParams` `{…, uri, range, actionId?}` | `EditActionsResult` (since 1.9; Convert / Inline / Introduce) |
| `code/postfix` | req | `PostfixParams` `{…, uri, position}` | `PostfixResult` (since 1.10; postfix templates) |
| `code/generate` | req | `GenerateParams` `{…, uri, position, kind?, members?, equatable?, operators?}` | `GenerateResult` (since 1.10; Generate) |
| `code/usages` | req | `UsagesParams` `{…, symbolId, limit?}` | `UsagesResult` (since 1.12; Find Usages grouped) |
| `code/fileStructure` | req | `FileStructureParams` `{…, uri, includeInherited?}` | `FileStructureResult` (since 1.13; File Structure) |
| `code/stepIntoTargets` | req | `StepIntoTargetsParams` `{…, uri, position}` | `StepIntoTargetsResult` (since 1.14; Smart Step Into) |
| `code/tests` | req | `TestsParams` `{…, uris?}` | `TestsResult` (since 1.15; Test Explorer discovery) |
| `efcore/migrations` | req | `EfMigrationsParams` `{traceId, workspaceId, snapshotId}` | `EfMigrationsResult` (since 1.18; EF Core view) |
| `code/constructorActions` | req | `ConstructorActionsParams` `{…, uri, position, actionId?, member?, members?, type?, constructorId?, typeId?}` | `ConstructorActionsResult` (since 1.11; constructor / DI helpers) |
| `workspace/didDeleteFiles` | notif | `{workspaceId, sequence, workspaceRevision, files: [{uri}]}` | – (since 1.6; consumes a document sequence) |
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

- Safe Delete (1.6): `refactor/prepare` with `actionId` `csharp.safeDelete` and the `symbolId` of a type, method,
  constructor, property, field, event, local or parameter. Deleted only when every use Roslyn finds is inside the deleted
  code; otherwise `ReferencesRemain` with the first uses (`File.cs:line`). An interface, abstract or virtual member is
  deleted with its source implementations/overrides; every partial declaration of a type is deleted; a file left
  without code (only usings, empty namespaces, comments) is deleted (`writeSet` entry `delete`, `fileDelete.files`) when
  its Compile membership is the plain SDK glob, else kept empty with the reason in `limitations`. A parameter is removed
  from the method, its hierarchy and every call site (the Change Signature engine). Framework relations other than
  declarations, references, implementations and tests (for example `mediatr.request` of a handler) and string or
  `dynamic` uses of the name make the plan `limited`. Refusals: `MetadataSymbol`, `GeneratedCode`,
  `UnsupportedSymbolKind`, `PartialMethod`, `PrimaryConstructor`, `UnsupportedDeclaration`, `ImplementsMember` (the
  member implements or overrides another one), `ReferencesRemain`, `InitializerHasSideEffects`, `UsingDeclaration`,
  `ArgumentHasSideEffects`, `RefOutParameter`, `CompilationErrors`, `IncompleteProjectClosure`, `ReadOnlyFile`,
  `UnsupportedEncoding`, `MixedLineEndings`. Revalidation: the read set, and every file to delete must still exist and
  be writable (`stale` / `FileDeleteUnsafe`). The client deletes the files after the text changes (ADR-004 Amendment 5)
  and sends `workspace/didDeleteFiles`.

- Extract Method (1.6): `refactor/prepare` with `actionId` `csharp.extractMethod`, `symbolId` `""`, `documentUri`,
  `range` (whole statements of one block, or exactly one expression; whitespace around the selection is ignored) and
  `newName`. Text-only plan: the selection is replaced by a call and a private method is inserted after the enclosing
  member. Data flow (Roslyn `AnalyzeDataFlow`): values flowing in become parameters, one variable flowing out is
  returned, several become `out` (`ref` when also read first) parameters, variables only used inside are declared in the
  new method; control flow (`AnalyzeControlFlow`): a selection that always returns is returned from. `static` when the
  instance is not used, `async Task`/`Task<T>` when it awaits, type parameters (with constraints) of enclosing methods
  are carried. Refusals: `InvalidIdentifier`, `NoDocument`, `GeneratedCode`, `EmptySelection`, `InvalidSelection`,
  `NotInMethodBody`, `TopLevelStatements`, `AnalysisFailed`, `UnsafeCode`, `GotoIntoSelection`, `JumpOutOfSelection`
  (break, continue, goto), `MultipleExits`, `Yield`, `LocalFunctionInSelection`, `Label`, `ConstructorInitializer`,
  `QueryExpression`, `ConstantContext`, `ExpressionTree`, `AssignmentTarget`, `ExpressionDeclaresVariables`,
  `ExpressionWritesVariables`, `NotAValue`, `RefLocal`, `RefReturn`, `RefLikeType`, `UnknownType`, `AnonymousType`,
  `AsyncOutParameters`, `TypeParameterConflict`, `NameInUse`, `UnsupportedDeclaration`, `EmbeddedStatement`, `Layout`,
  `CompilationErrors`.

- Change Signature (1.6): `code/signature` lists the parameters; `refactor/prepare` with `actionId`
  `csharp.changeSignature`, the method's or constructor's `symbolId` and `signature.parameters` (the new list: `from`
  = index of a kept parameter, possibly with a new `name`; without `from` a new parameter with `type` and
  `callSiteValue` and/or `defaultValue`). The method, every member it overrides or implements and every
  override/implementation of those change together; every call site Roslyn binds (invocations, `new`, target-typed
  `new`, `base`/`this` initializers, reduced extension calls, named arguments, omitted optional arguments, expanded
  `params`) gets the new argument list; a reorder that would change the evaluation order of arguments with side effects
  keeps the original order as named arguments. Every rewritten call must bind to the changed method afterwards and every
  call of a same-named overload to the same overload as before. `<param>`/`<paramref>` names are renamed, `<param>` of
  removed parameters removed. String or `dynamic` uses of the name make the plan `limited` (unknown callers).
  Refusals: `UnsupportedSymbolKind`, `MetadataSymbol`, `GeneratedCode`, `PartialMethod`, `ExternMethod`,
  `PrimaryConstructor`, `PatternMethod` (names the compiler calls implicitly), `DelegateNotSupported`,
  `InvalidSignature`, `InvalidIdentifier`, `DuplicateParameter`, `TypeChangeNotSupported`, `ParamsArray`,
  `ExtensionThis`, `InvalidType`, `InvalidValue`, `MissingValue`, `RefOutParameter`, `NoChanges`,
  `ImplementsMetadataMember`, `NameInUse`, `ParameterUsed`, `UnsupportedReference`, `ImplicitCall`, `MethodGroupUse`,
  `AttributeUse`, `UnsupportedCall`, `ArgumentHasSideEffects`, `EvaluationOrder`, `OverloadResolutionChange`,
  `CompilationErrors`, `IncompleteProjectClosure`.

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

HTML/CSS links (TS side only, never sent by the host; route `web.styles` for stylesheets and HTML pages, and a module on
the TS/JS route): `css.rule`, `css.idRule`, `css.moduleClass`, `css.import`, `css.variable`, `css.mixin` (group `styles`),
`css.classUse`, `css.idUse`, `css.moduleUse`, `css.importedBy`, `css.variableUse`, `css.mixinInclude` (group `usedBy`) and
`css.unusedSelector` (group `unused`, information only). Every target is a `target.location`. Heuristic links carry
`{ kind: "heuristic", providerRouteId: "web.styles", basis }`; proven links (CSS Modules, resolved imports, SCSS/LESS
definitions) carry an owned provenance of route `web.styles`. `FindItem.kind` gains `style` (Find `css:`).

`RelatedResult` has no groups list: every entry of `relations` carries its `group`. The UI orders groups as
declarations, handlers, callers, clients (TS-side HTTP links), endpoints, data, styles, usedBy (TS-side HTML/CSS links), registrations, implementations, references, tests, unused (HTML/CSS: possibly unused selectors, information only); unknown groups
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

Since 1.16, `AnalysisRunParams.documents?: string[]` (document URIs, typically the client's open C# files) also runs the
per-document inspections `OR1002`–`OR1010` (docs/rules/OR1002.md …) on those documents; unknown URIs are ignored. Their
results are ordinary `RuleDiagnostic`s (`confidence: 'proven'`, `completeness: 'complete'`, no evidence, related
locations where the rule has them, `helpUri` = the rule page) with `fixes?: [{ actionId, title }]`: edit actions
`csharp.edit.fix.*` that `code/editActions` computes at the diagnostic's start (kind `quickfix.refyntra.<rule id>`) and
that `refactor/prepare` `csharp.fixAll` applies in a document, project or solution. Results are cached per document text
version and project dependent semantic version. Suppressions (`#pragma warning disable`, `[SuppressMessage]`) are applied
by the host. Older clients that send no `documents` get OR1001 only, as before. Since 1.18 the same documents also get
`OR1011` (possible N+1, a heuristic; docs/rules/OR1011.md) with the fix `csharp.edit.fix.addInclude`.
