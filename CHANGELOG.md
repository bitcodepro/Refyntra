# Changelog

All notable changes are listed here. The project is alpha; nothing has been released yet.

## Unreleased

- EF Core: ApplyConfigurationsFromAssembly(Assembly.GetExecutingAssembly()) and GetType().Assembly are resolved to the context's own assembly (configurations are linked, likely) instead of being reported as an unknown assembly.

### Added (navigation)

- Frontend ↔ backend HTTP links (heuristic): a `fetch`/`axios`/Angular `HttpClient`/`$http`/`ky`/`superagent` call
  with a literal URL (string, template literal with `${…}` parameters, `+` concatenation, same-file const or
  `axios.create({ baseURL })`) is matched to the ASP.NET Minimal API/MVC route it calls. Related from the call shows
  the endpoint and its handler; Related on an action, handler or controller shows the new group **Clients**; Find
  `client:` lists unlinked calls with the reason (`client:all` lists every call). Matching normalises slashes and case,
  route parameters and constraints, and the method when known; ambiguity is shown, never guessed. Settings
  `refyntra.http.basePaths` and `refyntra.http.origins` (default: exact match, relative URLs only). Bounded, excluding
  workspace scan of TS/JS files, updated on save. No network, nothing executed; every link is labelled heuristic
  (provenance `http.links`). Uses the existing endpoint listing (`code/search`, route filter ""); no protocol change.
- Stack trace navigation: **Refyntra: Open Stack Trace** reads a pasted trace (clipboard, editor selection, terminal
  selection) and lists the frames by exception in the **Refyntra Stack Trace** view: .NET (CoreCLR, .NET Framework,
  ASP.NET logs, Mono, Unity; async state machines, lambdas, local functions, generics, inner exceptions, await
  boundaries), JavaScript/TypeScript (V8, Firefox/Safari), Python tracebacks and Rust panics/backtraces. Files are
  matched to the workspace by exact path, then path suffix (OS case rules, ambiguity offered as a choice); a line past
  the end of the file is reported as "line may have moved". .NET frames without a usable file are resolved by symbol
  with the new request `code/resolveFrame` (protocol 1.4, additive): exact metadata name + parameter types = proven,
  name only = likely. External frames are collapsed; every frame status is in words; each frame has a Related button.
  Nothing is executed or sent; missing symbols are not recovered.

### Added (languages)

- Python and Rust (delegated): `.py`/`.pyi` and `.rs` files get Find, Related, Actions and Rename through the same
  delegated adapter as TypeScript/JavaScript (one implementation, a language descriptor per family; TS/JS behaviour
  unchanged). Answers come from the language extension the user installed (a Python language server such as Pyright,
  basedpyright or Jedi; rust-analyzer). A missing provider is detected with a document-symbol probe and shown in Health
  with a recovery that opens the Extensions view search (never an install). Rename: per-language identifier rules
  (Unicode Python names, Rust raw identifiers and lifetimes), refusal of renames inside strings, of Python import
  module paths and Rust `mod name;` declarations (possible file operations) and of edits inside Rust `macro_rules!`
  bodies; Python dynamic attribute access is listed as not covered.

### Fixed (real-code corpus)

- NuGet audit advisories (and deprecated-package / end-of-life TFM notices) no longer make a project `partial`; MSBuildWorkspace reports every MSBuild message as a failure. Other MSBuild messages stay conservative.
- Rename no longer reports a false `RenameConflict` when an edited file already had a compiler error (e.g. CS8618 under `TreatWarningsAsErrors`): the compilation delta maps errors through the minimal document changes.
- `pnpm run test:regression`: read-only regression on a pinned OSS solution (`tests/regression/manifest.json`).

### Added (refactoring)

- Code Cleanup (`refyntra.cleanup`, action `csharp.cleanup`, protocol 1.4): one preview for a file, folder, project or
  the workspace with per-file per-fix counts, diffs and the skipped files with reasons. Fixes (profile
  `refyntra.cleanup.profile`, toggled per run): remove unnecessary usings (compiler-reported, every project context —
  Organize Imports across many files), sort usings (System first per `.editorconfig`), file-scoped namespace (only when
  `.editorconfig` asks and C# ≥ 10), trailing whitespace / final newline (only per `.editorconfig`). Each change is kept
  only when Roslyn proves the code means the same (bindings, types, declarations, literal values, diagnostics) and every
  fix is idempotent. Same pipeline as Rename (read set, revalidation, single EditApplier, reconcile, never saved); Undo
  restores files that still have the applied text. IDE code-style fixes (IDExxxx) are not offered (internal Roslyn APIs).

- Move Type to File and Generate handler (MediatR): two refactorings that create a C# file, offered in Actions (and as
  `refyntra.moveTypeToFile` / `refyntra.generateHandler`) with a preview (the new file as a diff from empty, the edits of
  the original file) and Apply. Same safety model as the file rename: static Compile-membership proof for the new file
  (anchor: an existing file of the folder), absence precondition (ignoring case), read set + revalidation, compilation
  delta including the new file, single EditApplier. Order: the file is created first (nothing changes if that fails),
  then the original is edited; created-but-not-edited is reported honestly, never rolled back; Undo offered; the host
  adds the new document without a reload. Move Type keeps namespace style, banner, comments and attributes, carries only
  the usings the moved code needs and proves that every name binds to the same symbol; partial, file-local, generated,
  `#if`/`#nullable`/`#pragma` files and nested types are not moved. Generate handler: `IRequestHandler<,>`/`<>` with a
  `NotImplementedException` placeholder, folder where most handlers live (or picked), namespace from `RootNamespace` +
  folders, file-scoped when the project uses it; no DI registration (MediatR scanning). Protocol 1.3 (additive):
  `PlannedChange` kind `create`, `fileCreate`, `PrepareParams.documentUri`/`targetFolderUri`, `workspace/didCreateFiles`.
  ADR-004 Amendment 2.

- File rename: C# Rename of a top-level type can rename its file too (`Foo.cs` → `Bar.cs`, partial parts `Foo.*.cs`). The
  preview shows **Also rename the file Foo.cs → Bar.cs** (on by default when proven safe; otherwise the reason why the
  file keeps its name) and lists the file rename as its own step. Proven safe means: static Compile-membership proof (SDK
  default glob, not linked, not under bin/obj, no Compile pattern/explicit item/changed excludes), target absent ignoring
  case, no other top-level type, not file-local/generated/symlink/read-only/reserved/case-only. Applied after all text
  edits as a separate `renameFile` (never overwriting), reconciled, host resynced without reload; if the file rename
  fails the text edits stay applied, this is reported and Undo is offered (no automatic rollback). Protocol 1.2 (additive):
  `renameFile`, `PlannedChange` kind `rename`, `fileRename` offer, `workspace/didRenameFiles`. ADR-004 amended.

### Added (framework navigation)

- EF Core navigation (new module `Refyntra.Frameworks.EfCore`, identity by metadata name + the
  `Microsoft.EntityFrameworkCore*` assemblies; a same-name `DbContext`/`DbSet` elsewhere never matches). Related, group
  `data`: DbContext → entities (`DbSet<T>` properties, `Entity<T>()`, `ApplyConfiguration`, `ApplyConfigurationsFromAssembly`
  scan as *likely*, navigation-reachable entities by convention as *likely*), configuration classes and
  migrations/model snapshots (`[DbContext(typeof(...))]`, read-only); entity → DbContexts, configuration classes and
  `Entity<T>()` calls, table (`ToTable`, `[Table]`; convention name *likely*), navigations (fluent and conventions, owned
  types), migrations that reference its table (read-only, *likely*); query sites (`DbSet<T>`, `Set<T>()`) in group
  `callers`, linked to the enclosing endpoint. Dynamic model building (loops/reflection) is shown as unknown. Find:
  `entity:` and `table:NAME`. Relation kinds `efcore.entity`, `efcore.dbContext`, `efcore.configuration`,
  `efcore.navigation`, `efcore.table`, `efcore.query`, `efcore.migration`; group `data`; `SearchFilters.entity`/`table`
  (additive). EF Core packages are test-only (fixture `tests/fixtures/EfCore`), never in the VSIX.

- MVC controllers and actions: attribute routes (`[Route]`, `[Http*]`, `[AcceptVerbs]`, token replacement,
  inherited routes and actions, several attributes per action, constraints kept as text) as endpoints of kind `mvc`;
  Related on an action shows its endpoints, on a controller all of its endpoints; a MediatR `Send` inside an action links
  the request to that endpoint; Find `route:`/`method:` covers MVC endpoints. Conventional routes (`MapControllerRoute`,
  actions without attribute routes) are listed as dynamic, "conventional route, not resolved". Controllers by verified
  identity; the `XController` naming convention only as a heuristic when the base type does not resolve.
- MediatR: pipeline behaviors as relations of a request (`mediatr.behavior`, group handlers; open generic ones as
  *likely*, "applies to every request (open generic)", order and registration not claimed), stream requests and
  handlers with `CreateStream` call sites, and handlers of a base notification as *likely* (contravariance).
- DI: keyed registrations with their key (and `[FromKeyedServices]` parameters → the matching registration), factory
  registrations as *likely* with the delegate location, instance registrations, and closed usages of open generic
  registrations (`di.openGenericUsage`, *likely*). Additive protocol fields `implementationKind`, `key`,
  `factoryLocation`. OR1001 results are unchanged (keyed registrations are ignored by the rule).

### Changed

- A missing .NET SDK is explained exactly: which global.json asks for which version, what its rollForward policy accepts, which SDKs are installed, and what to do (download link, or change global.json).
- Rename is applied after the preview by default. The setting is now `refyntra.rename.apply` (default on; off = preview-only) and replaces `refyntra.experimental.applyRename`.

### Release preparation (Stage E)

- Installation smoke test (`pnpm test:install`): the packaged VSIX is installed into a clean profile under a path with spaces and non-ASCII characters and runs the Shop and DiRules journeys from the installed copy.
- No orphan processes: on Windows the host puts its BuildHost children in a Job Object, so they end with the host even when it is killed. On Linux and macOS the extension kills the process group (not yet verified on a real Linux desktop).
- Export Debug Bundle (`refyntra.exportDebugBundle`): opt-in, shows the exact content before saving, paths and project names redacted, no source text, no environment values, local file only.
- Logs redact text-bearing fields at any depth (nested fields could leak before).
- Third-party notices and a CycloneDX SBOM generated from what the VSIX actually ships (19 components, all MIT); `pnpm audit:vsix` rejects test libraries, sources, PDBs, secrets and build-machine paths. BuildHost for .NET Framework projects is no longer shipped (SDK-style projects only).
- Deterministic .NET builds with path mapping: no build-machine paths in the shipped binaries.
- Performance baseline (`docs/performance/`) and a headless Linux smoke run in Docker (`docs/support/linux-smoke.md`); Linux is not supported yet.
- Troubleshooting guide (`docs/support/troubleshooting.md`).

### Added (Stage D)

- OR1001 (experimental): a scoped service captured by a singleton, reported only for a proven constructor path in one composition root; abstentions are explained through a code action, never in Problems. See `docs/rules/OR1001.md` and `docs/rules/overlap.md`.
- Tests in Related: test methods that reference the symbol (proven by test-framework attribute identity, labelled "not coverage"), name-based matches as heuristic, and the reverse direction. Running tests is not offered (no public integration).
- TypeScript and JavaScript through the installed language providers (delegated): Find, Related and Rename with a re-prepared, always-limited plan, and the editor's own Rename as an explicitly unvalidated fallback.

### Security and safety (review fixes)

- **Run dotnet restore** no longer types a command line into a terminal: it runs a `refyntra-restore` task with `ProcessExecution('dotnet', ['restore', <path>])`, so `$(...)`, backticks, `%VAR%` or quotes in a repository file name are never executed (trusted-workspace and inside-workspace checks unchanged).
- Rename read set: every project file of the solution/workspace is fingerprinted (not only the affected closure), and a workspace opened from a `.csproj` fingerprints the project files next to it. A project outside the closure that starts referencing the renamed symbol's project now makes the plan stale.
- A plan prepared as `limited` revalidates as `limited` (with its limitations), never `valid`. The preview shows the limitations and **Apply rename** asks for a second, modal confirmation that lists them.
- A prepare that was running when `workspace/reload` started no longer stores its plan (`WorkspaceReloaded`); plans carry the load generation of their snapshot.
- Targets not saved as UTF-8 are refused at prepare (`UnsupportedEncoding`, naming the file) instead of a later "code changed". Read-set source hashes decode disk text with the encoding Roslyn detected, so an unchanged legacy-encoded file no longer makes every plan stale.
- Closed targets with mixed line endings are refused at prepare (`MixedLineEndings`): VS Code normalizes them on load, so the result would differ from the preview.

### Robustness

- A malformed frame whose recovered id is not valid JSON, and `$/cancelRequest` racing with the completion of its request, no longer stop the host.
- Cancelled or timed-out snapshot barriers are removed from the waiter list; a barrier pending during `workspace/close` returns `-33006 WorkspaceNotLoaded` (was `InternalError`).
- `didClose` of a file that is missing or unreadable drops the overlay and removes the document from the snapshot (a later `didOpen` brings it back).
- The client never sends a document frame above `limits.maxMessageBytes`: such a document is skipped explicitly and listed as "too large" in health; a failed send no longer consumes a sequence number (no barrier waits for a gap, no restart loop when replaying an oversized buffer). `BarrierTimeout` has its own code `-33008`; the client replays the open documents and retries.
- One host crash during startup counts as one automatic restart (was two).
- DI composition roots include the project: two apps with top-level programs are two roots (`Program.<Main>$ (App1)`, `Program.<Main>$ (App2)`).
- The rename compilation delta compares errors by id, file and mapped span: a new error that replaces a fixed error of the same id is detected.

### Contract and UX

- One capability catalogue: `csharp.find`, `csharp.related`, `csharp.rename`, `csharp.references` in `initialize.capabilities`, `capability/query` and the UI. `csharp.related` is available whenever the C# route is ready; framework details are its limitations. Guarantees are `owned-semantic` with per-relation confidence (docs/capabilities/alpha.md and README updated).
- `-33005 UnknownSymbol` is reported as an error (no longer retried as stale); `-32603 InternalError`, `-33008 BarrierTimeout` and the shared reason codes are in `ErrorCodes`/`ReasonCodes` and the protocol table; `error.data.recovery` is shown. Revalidate `UnknownPlan` reads "The preview expired. Prepare the rename again."
- `PrepareParams.actionId` is a `string`; protocol-v1.md documents oversized frames, `didClose`, `engine/status`, provider route ids, `relations[].group` and tolerance of unknown namespaced relation kinds.
- Related view: shows *Loading…* instead of the previous result, marks itself outdated and refreshes after an edit in the subject's or a target's file, and resolves an item again before opening it from an outdated view.
- Find: Enter while the query is being debounced or searched no longer opens a result of the previous query.
- Rename preview: errors in the preview QuickPick are shown; a preview whose edits do not fit the current text is marked invalid and Apply is disabled.

### Added (Stage C: safe Rename)

- Rename apply path (behind `refyntra.experimental.applyRename`, still off by default): single-use plan state machine (Prepared → Previewing → Revalidating → Applying → Applied/Failed, plus Stale/Cancelled/Discarded); mandatory host revalidation after the user confirms; plans are invalidated by an epoch change, a reload, a solution/trust change and any editor event after the preview.
- EditApplier (the only caller of `workspace.applyEdit`, enforced by the architecture check): reads closed targets from disk after the final revalidation, checks every target hash synchronously, applies one text-only edit, reconciles every file (confirmed / unchanged / unknown); no auto-save, no automatic rollback; Undo through the editor.
- Rename UI: preview summary with limitations, per-file diffs, **Apply rename**, "The code changed since the preview" with **Prepare again**.
- Host read set: literal MSBuild `<Import>`s of projects and `Directory.*` files are fingerprinted; computed imports make the plan `limited`. New guards: read-only target files; a type rename notes that its file keeps its name.
- Fixtures `Renames` (cross-project nameof/alias/partial/overload golden diffs) and `DiExt` (EF Core and other framework registrations).
- Framework DI extension registrations (`AddDbContext`, `AddDbContextPool`, `AddDbContextFactory`, `AddHostedService`, `AddHttpClient<T>`/`<TClient,TImpl>`, `AddOptions<T>`) as `di.registration` with confidence `likely`, matched by method name and containing type/assembly.
- `code/search` with an empty query and the `type` filter lists types; Find with an empty query shows that list.
- Protocol 1.1: optional `LoadDiagnostic.recoveryActions`. Missing `project.assets.json`, packages missing from the package folders and NuGet/assets load errors offer `refyntra.runRestore` (runs `dotnet restore <sln>` in a terminal only after a click, trusted workspace only).

### Fixed

- A DI registration was reported twice for an interface subject (`di.registration` and `di.implementation` both carried it); the implementation relation now carries only the implementation symbol.
- The rename preview no longer opens target documents (which counted as an editor event and made every multi-file plan stale).

### Added (earlier)

- Initial repository skeleton: TypeScript workspace, .NET host solution, protocol v1 specification.
- Architecture decision records ADR-001 to ADR-006.
- README, SECURITY, CONTRIBUTING, third-party notices skeleton, support matrix and alpha capability list.
- CI workflow (build and tests on Windows and Ubuntu, VSIX artifact on Windows).
