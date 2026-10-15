# Contract notes (.NET host vs protocol v1)

The host follows `docs/architecture/protocol-v1.md` and `packages/contracts/src/protocol.ts`. The contract was not
changed except for the additive 1.1 field `LoadDiagnostic.recoveryActions`. Where it is silent or has a gap, the host does the most conservative thing, listed here.

## Starting the host

`dotnet <repo>/src/dotnet/Refyntra.Host/bin/<Configuration>/net10.0/Refyntra.Host.dll` (no arguments).
stdin and stdout carry Content-Length frames. stderr carries one JSON log object per line. Exit code: 0 after
`shutdown` + `exit` or when stdin closes; 1 for `exit` without a prior `shutdown`; 2 for a fatal host error.
MSBuild BuildHost child processes are started by MSBuildWorkspace and stopped when the workspace is disposed.

## Gaps and the behaviour chosen

1. **Recovery for load diagnostics** (protocol 1.1). A missing `obj/project.assets.json`, packages listed in
   `project.assets.json` that exist in none of its `packageFolders`, and MSBuild diagnostics mentioning NETSDK1004/
   1005/1047/1064, NU1101–NU1103 or `project.assets.json` carry `recoveryActions: [{command: "refyntra.runRestore",
   title: "Run dotnet restore", args: [solutionPath ?? projectPath]}]`; the message still ends with
   `Recovery: Run dotnet restore.` and the project state is `partial`. `capability/query` adds the same action to
   `csharp.navigation` when the load is partial for that reason. The host never runs restore or build.
2. **Snapshots that are accepted.** Every `code/*`, `capability/query`, `refactor/prepare` and `refactor/revalidate`
   request must name the **current** snapshot; anything else is `-33004 StaleSnapshot`. Snapshots pinned by prepared
   plans are kept (at most 32 plans; the oldest is evicted) and used only internally for revalidation.
3. **Symbol id from another snapshot or epoch** → `-33004 StaleSnapshot` (the client should barrier and query again).
   Malformed or unresolvable ids → `-33005 UnknownSymbol`.
4. **`refactor/revalidate`** returns `{status:"invalid", reasonCode:"UnknownPlan"}` for a discarded, evicted or
   unknown plan, and `{status:"stale", reasonCode:"ReadSetChanged" | "WorkspaceReloaded" | "EpochChanged"}` when any
   fingerprint differs. A `snapshotId` that is not current is `-33004`, as for other requests.
5. **Unexpected exceptions** are reported as JSON-RPC `-32603` with `data.reasonCode = "InternalError"` (listed in the
   contract table). A malformed frame (also one whose recovered id is not valid JSON) and a cancel that races with the
   completion of its request never stop the host.
6. **Document sequences** are zero-based (-1 = nothing received). Events whose `sequence` is not above the last
   applied one are ignored, with a log line. `workspace/snapshotBarrier` waits up to 30 s for a missing sequence, then
   returns `-33008` with `reasonCode: "BarrierTimeout"`. The barrier can be cancelled with `$/cancelRequest`, which
   gives `-32800`; a barrier that waits while the workspace is closed gives `-33006 WorkspaceNotLoaded`. Cancelled and
   timed-out waiters are removed. `BarrierResult.workspaceRevision` is the highest `workspaceRevision` received in a
   document event. The host does not keep its own counter.
   `didClose` of a file that is missing or unreadable removes its document from the snapshot (see protocol-v1.md).
7. **`workspace/open` without an SDK** → `-33007 SdkNotFound`. Other load failures return an `EngineStatus` with
   `state: "Failed"` and a `reasonCode`. When some projects load, the state is `Partial` with reasonCode `PartialLoad`.
8. **`engine/status`** describes the first open workspace. The protocol has no workspace id on this request.
9. **Read set inputs.** Most entries are absolute file paths. Two kinds are logical ids: `membership:<projectDir>`
   (the set of `*.cs` files on disk, excluding bin/obj) and `documents:<projectContextId>` (the document set of the
   context). The hash of a missing file is the string `"absent"`. For source files the hash is SHA-256 of the
   snapshot text. Other files are hashed by their bytes.
10. **Endpoints.** `handler` is set only for method-group handlers. Lambdas have no symbol id, so `handler` is
    omitted for them. The endpoint `location` covers `MapX(...)`. For a dynamic route, `route` is the known static
    prefix (for example `/api/`) and `routeIsDynamic` is true. A group prefix from a parameter (the builder came from
    a caller) also counts as dynamic.
11. **Request → endpoint.** A MediatR `Send`/`Publish` call site inside a Minimal API handler lambda yields an
    `aspnet.endpoint` relation on the request, in group `endpoints`.
12. **DI relations.**
    - `di.registration` (group `registrations`) is used when the subject is the service type.
    - `di.service` (group `registrations`, `target.symbol` is the service) is used when the subject is the implementation.
    - `di.implementation` (group `implementations`) gives one implementation per composition root. Its target carries
     only the implementation **symbol**, not the registration: each registration appears once (in `di.registration`).
   - Framework extension methods (`AddDbContext`, `AddDbContextPool`, `AddDbContextFactory` from
     `Microsoft.EntityFrameworkCore`; `AddHostedService` from `Microsoft.Extensions.Hosting.Abstractions`; generic
     `AddHttpClient` from `Microsoft.Extensions.Http`; `AddOptions<T>` from `Microsoft.Extensions.Options`) are
     recognised by method name **and** containing type **and** assembly. Confidence `likely`, limitation
     "Framework extension method …". Lifetime: a constant `contextLifetime` (AddDbContext) / `lifetime`
     (AddDbContextFactory) argument, otherwise scoped / scoped / singleton / singleton / transient / singleton;
     a non-constant lifetime argument gives `unknown`. `form` is e.g. `AddDbContext<AppDbContext>(contextLifetime: transient)`.
    - `compositionRoot` is `Program.<Main>$ (<project>)` for top-level statements. Otherwise it is the fully qualified
      containing method plus the project, for example
      `Shop.Api.Infrastructure.InfrastructureServiceCollectionExtensions.AddShopInfrastructure (Shop.Api)`. The project
      is part of the identity, so two apps with top-level programs are two composition roots.
13. **Relation sorting** inside a group: composition root, then file path, then position, then label.
14. **Capability ids** (`initialize.capabilities` and `capability/query`) are the catalogue `csharp.find`,
    `csharp.related`, `csharp.rename`, `csharp.references`, all with guarantee `owned-semantic`. Framework details are
    limitations of `csharp.related` (a framework not referenced, an unverified MediatR version) and its `message`
    lists the detected frameworks.
15. **MediatR versions.** MediatR assembly major 10–12 and MediatR.Contracts 1–2 give `proven`. Other versions give
    `likely`, with a limitation on the relations and on `csharp.related`.
16. **Search with an empty query.** With `filters.type` (and not `member`) the host lists the source types of the
    (filtered) projects, generated code excluded, score 50, sorted by display name, cut at `limit` (`truncated`).
    Without a filter an empty query returns no items.
17. **Rename read set and guards** (Stage C). See protocol-v1.md "Rename plans". Additional reason codes of
    `refactor/prepare`: `ReadOnlyFile` (a target has the read-only attribute). Reload/close removes the plans of the
    workspace, so a later revalidate is `invalid`/`UnknownPlan` (not `stale`/`WorkspaceReloaded`). Imports with
    `$(MSBuildThisFileDirectory)`/`$(MSBuildProjectDirectory)` are resolved; other properties, wildcards and item
    transforms are not (plan `limited`, listed in `limitations`; revalidate then answers `limited`, never `valid`).
    SDK imports are covered by `global.json` only; the SDK files themselves are not hashed. Every reload starts a new
    load generation: plans of an older generation are not stored (prepare racing a reload → `WorkspaceReloaded`) and
    revalidate as `stale`/`WorkspaceReloaded`. Targets not saved as UTF-8 (`UnsupportedEncoding`) and closed targets
    with mixed line endings (`MixedLineEndings`) are refused at prepare. Disk text of read-set sources is decoded with
    the encoding Roslyn detected at load, so an unchanged legacy-encoded file does not make plans stale. The read set
    includes every project file of the solution (and `projects:<dir>` for a `.csproj` workspace). The compilation
    delta compares errors by id, file and mapped span.
18. **`analysis/run`** (Stage D, additive). Only rule OR1001. Requires the current snapshot (`-33004` otherwise). The
    `uri` filter keeps results whose primary location is in that file (path comparison, case-insensitive). Every
    diagnostic carries `helpUri` = the GitHub page of `docs/rules/OR1001.md` and `relatedLocations` = the evidence items
    that have a location. Abstentions carry `ruleId`, `reason`, `message`, `location` (the singleton registration) and
    `compositionRoot`. Results are cached per immutable solution; per connected component of composition roots the
    result is reused across snapshots while the dependency fingerprint is unchanged (docs/rules/OR1001.md), and its
    locations are re-created on the current syntax trees.
19. **Tests in Related** (Stage D). Group `tests`: kinds `test` (forward; proven references inside a test method, or a
    heuristic `<Name>Tests`/`<Name>Test` test class) and `test.subject` (reverse; production symbols referenced by a test
    method or by every test of a test class). A test method is recognised only by attribute identity (full metadata name
    + assembly, base attribute types included). References in a test project outside a test method are not listed.
    `capability/query` adds `tests.run` = `available` for test subjects (run by the client's test runner); it is not in
    `initialize.capabilities`.
20. **DI facts** (Stage D). Registrations now carry structured traits (factory, instance, open generic, TryAdd,
    conditional, framework extension). "Conditional" is broader than before: also loops, `try`/`catch`, lambdas, local
    functions, `?.`/`&&`/`||`/`??` and an earlier `return`/`throw`/`goto` in the method; the Related limitation text is
    unchanged. Calls that pass the service collection to another method are recorded to link composition roots.
