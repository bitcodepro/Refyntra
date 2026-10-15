# Changelog

All notable changes are listed here. The project is alpha; nothing has been released yet.

## Unreleased

### Added (recent)

- **Persistent project index** (ADR-014): a reopened, unchanged solution is usable at once (Shop: 0.1 s instead of 3.9 s)
  while MSBuild loads it again in the background; refactorings wait for that load (`IndexVerifying`).
- **Blazor / Razor**: Find Usages and Rename of C# symbols cover `.razor` and `.cshtml` markup (also from a `.razor`
  editor, `@code` members included, unsaved markup seen).
- **Tests**: one data row runs alone (vstest.console server mode; Microsoft Testing Platform server mode for xUnit v3 and
  MSTest.Sdk).
- **Inline Method across files** (previewed plan) and **Immediate window completions** from Roslyn.
- **Blazor WebAssembly** runs (development server, browser URL) and debugs in Edge / Chrome through VS Code's JavaScript
  debugger and the app's debugging proxy.
- **C# live templates** in completion; **task context** per git branch and shared in `.refyntra/task-contexts`.

### Added (debugger)

- **Logpoints and hit counts for C#** (`refyntra-dotnet`): netcoredbg has neither, so Refyntra runs it behind its own
  DAP proxy, which sends plain breakpoints, counts hits (`N`, `== N`, `>= N`, `> N`, `< N`, `<= N`, `% N`), evaluates the
  `{expressions}` of a logpoint in the stopped frame, writes the line to the Debug Console and resumes without VS Code
  seeing the stop. Works with conditions; Step Over a call that runs into a logpoint still ends at the next statement.
  Each hit is a real stop and resume (slower in hot loops). The warnings that both were unsupported are gone.
- **Run with Hot Reload status**: a status bar item for `dotnet watch` runs (building, watching, applied, restart
  needed, failed, waiting), **Refyntra: Show Hot Reload Terminal**, Restart keeps the watch mode, and
  `refyntra.run.hotReload.rudeEdit` (`restart` = `dotnet watch --non-interactive`, or `ask`): watch's own y/n prompt
  cannot be answered from Refyntra's terminal (not a console).
- Documented: Set Next Statement and Edit and Continue (code changes while paused) stay unavailable; netcoredbg has no
  request for them (ADR-008).

### Added (EF Core tools)

- **Refyntra EF Core view**: DbContexts → migrations in EF Core's order (by `[Migration]` id, custom folders and
  namespaces included), model snapshot and `IEntityTypeConfiguration<T>` classes, read from source by the host
  (protocol 1.18, `efcore/migrations`); click to open. Shown only in workspaces with a DbContext.
- **dotnet ef commands as visible VS Code tasks** (trusted workspaces only, an argument list without a shell, the task
  named after the exact command line): Add Migration, Remove Last Migration, Update Database (latest / selected / `0`),
  Generate SQL Script (plain or idempotent, opened in an untitled SQL editor) and Check Status (`migrations list
  --json`, applied/pending only on request). Commands that connect to a database ask first and show the command. The
  startup project is chosen once per DbContext and remembered. No Drop Database command on purpose (ADR-011).
- dotnet-ef detection (`dotnet ef --version`, local tool manifest or global); when missing, Health and the action show
  `dotnet tool install --global dotnet-ef` as text. Refyntra never installs it.
- **Show SQL for LINQ**: `ToQueryString()` of the selected IQueryable, evaluated with DAP `evaluate` in the stopped
  frame of a Refyntra .NET debug session, shown in a read-only SQL editor; outside debugging it explains and offers a
  breakpoint at the line.
- **OR1011 possible N+1** (heuristic, hint by default, docs/rules/OR1011.md) with the quick fix *Add .Include(x =>
  x.Nav)* (also in Fix in scope).
- Tests: .NET `EfToolsTests` on a new `EfTools` fixture (two contexts, custom migrations folder/namespace, snapshots,
  OR1011 cases and the fix), unit tests (`efCore.test.ts`: tree model, command lines with spaces/quotes, output
  parsing, debugger strings), e2e `efcore` (tree of the EfCore fixture) and `ef-tools` (dotnet-ef installed into the
  Linux test image at build time; update / status / add / script / remove on a temp SQLite file, OR1011 quick fix,
  Show SQL in netcoredbg), visual baseline `ef-core-view` (both themes). ADR-011.

### Added (Solution Explorer, project files and NuGet)

- Protocol 1.20 `solution/structure`: solution folders and items (.sln and .slnx), projects with kind, target
  frameworks and load state, project / package / framework / analyzer dependencies, Central Package Management, and the
  items as MSBuild sees them (Compile items with Link folders, other files of SDK projects, excluded C# files).
- The **Refyntra Solution** view: tree with icons per project kind, linked files with a badge, excluded files hidden or
  greyed (`refyntra.solutionExplorer.excludedFiles`), Reveal Active File and editor sync
  (`refyntra.solutionExplorer.autoReveal`); context menus for Open, Reveal, Copy Path, Run / Debug / Set as Startup
  Project, Run Tests, New / Add Existing / Remove / Rename Project, Add / Remove Project Reference, Unload / Reload
  (Refyntra-side). Changes run as visible `dotnet` tasks (no shell), reload the solution and offer Undo.
- **Manage NuGet Packages** panel (strict CSP, theme colours): Installed, Browse (NuGet V3 search of the configured
  sources, local folder feeds, `dotnet package search` for feeds that need credentials), Updates, Consolidate,
  vulnerable / deprecated checks on demand; install / update / uninstall with `dotnet add|remove package`, versions in
  `Directory.Packages.props` with Central Package Management. Network only on a user action (ADR-013).
- Project file editing: completion and hover for MSBuild properties, items and values in .csproj / .props / .targets,
  package ids from the solution and the local NuGet cache, versions on demand; **Edit Project File**; saving a project
  or solution file reloads it in the host (`workspace/reload`).
- Tests: .NET `SolutionStructureTests` (fixture `Explorer`: .sln + .slnx, nested solution folders, a linked file,
  Compile Remove, CPM), unit tests with recorded NuGet and dotnet CLI output, e2e scenario `solution` (a local folder
  feed made in the test, no internet) and a Shop tree check, visual baselines `solution-explorer` and `nuget-installed`
  (both themes). The Docker scripts take `REFYNTRA_E2E_IMAGE`, `REFYNTRA_SMOKE_IMAGE` and
  `REFYNTRA_DOCKER_VOLUME_PREFIX` (defaults unchanged).

### Added (target framework compatibility)

- Verified target frameworks (docs/support/matrix.md, "Target frameworks and SDKs"): net8.0, net9.0, net10.0,
  netstandard2.0/2.1 and multi-targeting load with one project context per framework; Find, Related (MediatR, DI),
  Rename and inspections work across them; Run, Debug and the test runner on net8.0/net9.0 apps where their runtime is
  installed. net6.0, net7.0 and .NET Framework are not supported. README requirements updated.
- A global.json that pins an installed SDK (8.0 or newer) is honoured: the solution is loaded with that SDK's MSBuild,
  like `dotnet build` (before, the newest installed SDK was always used).
- Fixtures `Compat` and `CompatPinned`; .NET `CompatTests`, `GlobalJsonTests`, `SdkPickTests`; e2e scenarios `compat`
  and `compat-sdk-missing`. The Docker e2e image `refyntra-linux-e2e-sdks` adds SDK 8.0.426 and the .NET 9.0.21 runtime.

### Fixed (C# language versions)

- Edit actions offered syntax the project's C# version does not have (then refused it as a compile error): 'using'
  declarations and switch expressions (C# 8), class → record (C# 9), 'if' → switch with type or 'or' patterns (C# 9)
  are no longer offered below those versions; Invert 'if' writes `!(x is null)` instead of `x is not null` before C# 9.
- Postfix `.notnull` writes `if (!(x is null))` before C# 9; `.using` on an IAsyncDisposable only from C# 8.
- Generate Equals/GetHashCode without System.HashCode (netstandard2.0, .NET Framework) uses a multiply-and-add hash
  over EqualityComparer<T>.Default instead of failing to compile.
- Make method async is refused with a reason when a parameter is a ref struct (Span, ReadOnlySpan).
- Visual test: the dark/light Usages capture waits until the view has its header and first row drawn.

### Added (structural search and replace)

- **Refyntra: Structural Search…** (C#, ADR-012): a panel with a pattern editor (C# with `$placeholders$`), a
  placeholder table filled from the pattern (kind, type with derived types or exact, argument / statement counts,
  regex), scope (file / project / solution), results in the panel and in the new *Structural Search Results* view
  (files with counts, line previews, placeholder values, *Show more*). Matching on Roslyn ignores trivia and redundant
  parentheses, binds names to symbols (qualified names, aliases and `using static` match; other symbols with the same
  name do not; interface members match their implementations) and requires a repeated placeholder to match equivalent
  code.
- **Structural replace**: a template per pattern; *Replace…* per match or *Replace all…* as one plan through the
  existing preview → revalidation → EditApplier pipeline with Undo; inserted code is parenthesised where needed, the
  replaced nodes are formatted, needed usings are added, and matches whose replacement would add a compiler error are
  refused and listed.
- **Saved patterns** in `.refyntra/patterns.json` (workspace) and the user's profile, four built-in examples, and
  **patterns as inspections**: rule ids `ORS-<name>` with a chosen severity in the Problems view, the replacement as
  quick fix and Fix in scope; `refyntra.rules.ORS-<name>` overrides the severity.
- Host protocol 1.19: `code/structuralSearch`, `code/structuralReplace` (a plan of action `csharp.structuralReplace`),
  `analysis/run` `structuralPatterns` and the edit actions `csharp.edit.fix.structural.*`; cancellable, result cap with
  `truncated`.
- Test scripts: `REFYNTRA_E2E_IMAGE`, `REFYNTRA_SMOKE_IMAGE` and `REFYNTRA_DOCKER_VOLUME_PREFIX` select other Docker
  image tags and cache volumes (parallel work trees).
- Tests: .NET `StructuralSearchTests` on the new `tests/fixtures/StructuralSearch` (type constraints, counts, regex,
  repeated placeholders, using static / aliases, no false matches across symbols, replacement formatting, usings,
  compile-check refusal, inspections and quick fixes); unit tests of the panel model, page and pattern storage; e2e
  scenario `structural-search`; visual baselines `structural-search` and `structural-results` (both themes).

### Added (go to metadata / decompiled sources)

- **Read-only decompiled sources for .NET libraries** (ADR-010), Rider-style: a symbol without source in the solution
  opens as `refyntra-metadata:/<assembly>/<Namespace.Type>.cs` with the whole type, XML documentation comments and the
  caret on the symbol. The source file embedded in the assembly's portable PDB is preferred (setting
  `refyntra.metadata.sourceLink`: `embeddedOnly` by default, `off`); otherwise ICSharpCode.Decompiler 11.1.0.9782 (MIT,
  bundled in the host) decompiles it. Reference assemblies map to the local implementation (`System.String` from
  `System.Private.CoreLib`). Nothing is downloaded.
- Host protocol 1.17 `code/metadataSource`: symbol id, documentation id, a solution position or a position inside a
  metadata document → document text, declarations with ranges, assembly facts and origin; decompilers cached per
  assembly MVID, cancellable. `code/fileStructure` inherited members and `code/stepIntoTargets` metadata callees carry
  `documentationId` / `assemblyName` (additive).
- **Refyntra: Go to Metadata / Decompiled Source** at the cursor; in metadata documents F12 goes on, Shift+F12 finds
  usages in the solution, hover shows the symbol and summary. Navigate To (*Decompiled declaration*), Related, Find,
  File Structure (inherited library members), external stack frames and Smart Step Into's refusal open decompiled
  sources. Health shows the decompiler, the source policy and the documents.
- Tests: .NET `MetadataSourceServiceTests` (a library compiled in the test with embedded / side-by-side / no PDB
  sources, caching per MVID, cancellation, symbol mapping, runtime types and targeting-pack mapping) and
  `MetadataSourceProtocolTests` on Shop (System.String, MediatR, navigation inside, usages back); unit tests of the
  URI scheme, store, answers, hover, Navigate To and File Structure rows; e2e cases in the `navigation` scenario;
  visual baseline `metadata-document` (both themes).

### Added (inspections)

- **Refyntra's own C# inspections with quick fixes**, computed by the C# host with Roslyn's public APIs, each checked
  against the compiler and the SDK analyzers first (docs/rules/overlap.md) and documented with its false-positive
  guards (docs/rules/OR1002.md … OR1010.md):
  OR1002 sync over async (`.Result`, `.Wait()`, `.GetAwaiter().GetResult()`; *Use 'await'*, a Task-returning method
  becomes async), OR1003 `async void` outside event handlers (*Change to 'async Task'*, refused when used as a
  delegate), OR1004 discarded tasks where CS4014 does not warn (*Discard explicitly*; CS4014 itself gets *Add 'await'*
  and *Discard*), OR1005 disposable locals never disposed or handed over (*using var*), OR1006 possible multiple
  enumeration on one path (*ToList()* once), OR1007 string concatenation in loops that never read the string
  (*StringBuilder*), OR1008 `Where(p).First()` and friends (predicate overload), OR1009 redundant `ToList()`/`ToArray()`
  (remove the copy), OR1010 `string.Format` without arguments (use the string; a format that would throw is reported
  without a fix). Not added on purpose: `Count() > 0` (CA1827/CA1829 already on by default), missing
  `ConfigureAwait(false)`, unused private members.
- Results in the Problems view for the open C# files (protocol 1.16: `analysis/run` `documents`, `RuleDiagnostic.fixes`),
  cached per document version: typing re-analyses one document. Severity per rule `refyntra.rules.ORxxxx`
  (`off | hint | info | warning | error`); `#pragma warning disable ORxxxx` and `[SuppressMessage]` are honoured.
- Quick fixes are edit actions (`csharp.edit.fix.*`, kind `quickfix`): compile-checked, one undo step; *… in document,
  project or solution* applies a fix at every result of the scope as one previewed plan (Fix in scope).
- Tests: .NET `InspectionsTests` on a new `Inspections` fixture (every reported case marked in the source, everything
  else is a false-positive guard; each quick fix and its refusals; Fix in scope; cache reuse; Shop timing), unit tests of
  settings and quick-fix offers, e2e scenario `inspections` (result in Problems, quick fix + Undo, Fix in scope in the
  solution through the Refactor Preview, CS4014 *Add 'await'*, suppression), visual baseline `inspection-quickfix`
  (both themes). Measurements: docs/performance/inspections-2026-10-13.md.

### Fixed

- *Make method async* wrote `awaitTask.FromResult(…)` (no space) for `return` statements of a method returning
  `Task<T>` in a block body.

### Added (test runner)

- **Tests in VS Code's Test Explorer** without other extensions (ADR-009): C# tests (xUnit, NUnit, MSTest) discovered
  by the C# host (protocol 1.15 `code/tests`: project → namespace → class → nested class → method → data rows, exact
  locations, incremental per edited document), run with `dotnet test` and a precise `--filter` per selection, results
  from TRX (pass/fail/skip per test and data row, duration, message, stack trace with the failing line, output).
- **Debug a test**: build, `dotnet test --no-build` with `VSTEST_HOST_DEBUG`, the bundled netcoredbg attaches to the
  test host; breakpoints in tests and in the code under test hit.
- Rerun Failed, Continuous Run (the classes of a saved file), gutter icons and Test Results are VS Code's own.
- CodeLens `Run | Debug` over C# test classes and methods with the last result (`refyntra.tests.codeLens`).
- **Run Tests for This Code** (editor context menu, Command Palette): the tests Related lists for the symbol.
- Python tests with pytest (when installed; Health explains otherwise), debugging with the bundled debugpy; Rust tests
  with `cargo test` (run only).
- **Coverage** profile: line coverage from coverlet.collector for .NET test projects that already reference it (VS
  Code's coverage view); skipped with the reason otherwise.
- Tests: .NET `TestDiscoveryTests` on a new `TestRunner` fixture (xUnit, NUnit, MSTest projects), unit tests of filters,
  TRX / JUnit / cargo parsing and result matching, e2e scenario `tests` (discovery, run all with expected counts, one
  theory row, debug with a breakpoint in the code under test, Rerun Failed, incremental discovery, CodeLens, Run Tests
  for This Code, Continuous Run, coverage, pytest or its Health note), visual baselines `test-explorer` and `test-codelens` (both themes).

### Added (debugger extras for C#)

- What the bundled netcoredbg 3.2.0 supports was measured in Docker (DAP `initialize` capabilities and a probe of
  each request) and recorded in ADR-008; the Run and Debug e2e compares the live capabilities with that table.
- **Refyntra: Smart Step Into** (Alt+Shift+F11 in the `visualStudio` preset, Shift+F7 in the `resharper` preset, while
  a `refyntra-dotnet` session is stopped): netcoredbg has no `stepInTargets`, so the C# host lists the calls of the
  stopped statement in execution order (protocol 1.14 `code/stepIntoTargets`) and Refyntra steps into the chosen one
  with temporary breakpoints (removed at the next stop); a call that is not made stops at the next statement; calls
  without source, abstract/interface calls and delegates are refused with the reason.
- **Run to Cursor** on Ctrl+F10 in the `visualStudio` preset (VS Code's own command, C# editors while stopped).
- **Refyntra: Break on Exception Types…** and `refyntra.debug.dotnet.breakOnExceptionTypes`: break when exceptions of
  these exact types are thrown (netcoredbg's `all` filter with a type condition), in addition to the ticked filters.
- A warning when a C# breakpoint gets a hit count or a log message: netcoredbg ignores both and stops.
- Health lists the .NET debugger features and what netcoredbg cannot do (Set Next Statement / Jump to Cursor, hit
  counts, logpoints, Restart Frame, data breakpoints): those are not offered.
- Tests: .NET `StepIntoTargetsTests` (execution order, body starts, metadata/abstract/delegate reasons, loops,
  constructors, next statement), unit tests of the model and keybindings, e2e cases in `run-debug` (capabilities,
  conditional breakpoint, Run to Cursor, Smart Step Into into a call / not called / refused, exception types, notes),
  visual baseline `smart-step-into` (both themes).

### Added (File Structure)

- **Refyntra: File Structure** (Ctrl+F12 in the `visualStudio` and `resharper` presets; Cmd+F12 on macOS): the members
  of the current file in a QuickPick grouped by type (nested types as groups) and `#region`, codicons by kind, kind and
  accessibility in words, short signatures, the member at the cursor selected first, camel-hump type-to-filter, filter
  buttons (methods, properties, fields, events, nested types, inherited members; kept per workspace), **Show in the
  Outline view**, optional preview while moving (`refyntra.fileStructure.preview`, off by default).
- C#: protocol 1.13 `code/fileStructure` (types, members with kind, accessibility, static, signature, ranges and
  region; inherited members of base classes / base interfaces with their declaring type, navigable when declared in the
  solution). Other languages: VS Code's document symbols.
- Tests: .NET (`FileStructureTests`: partial classes, nested types, regions, records, generics, operators, inherited
  members from base classes, base interfaces and metadata; `FileStructureProtocolTests` on Shop), unit tests of the
  structure model (grouping, filters, camel humps, the row at the cursor, the document-symbol fallback), e2e cases in
  the `navigation` scenario, visual baseline `file-structure` (both themes).

### Added (Recent Files and Recent Locations)

- **Refyntra: Recent Files** (Ctrl+E in the `visualStudio` and `resharper` presets; Cmd+Alt+E on macOS): recently
  opened files of the workspace, most recent first with the current file second (Enter switches back), open editors
  not yet recorded after them, file icon, relative folder, "modified" for unsaved editors, a remove button, type to
  filter; at most 50, kept in `workspaceState`; renames and deletes followed.
- **Refyntra: Recent Locations** (Ctrl+Shift+E; Cmd+Alt+Shift+E on macOS): places where the cursor rested (1.5 s) or
  you edited, in the sections Edited / Visited with an edited-only toggle, file and line, containing member (document
  symbols, else a text scan) and code line; positions re-anchored when the document changes, a deleted line drops its
  location; remove button; at most 50, kept per workspace.
- The keys override VS Code's Ctrl+E (Quick Open) and Ctrl+Shift+E (Show Explorer) only inside the presets and never
  in the terminal; macOS keeps Cmd+E (Use Selection for Find) and Cmd+Shift+E.
- Tests: unit tests of the recent lists (ordering, dedupe, persistence, re-anchoring, containing member), e2e cases in
  the `navigation` scenario, visual baselines `recent-files` and `recent-locations` (both themes).

### Added (Navigate To and Find Usages grouped)

- **Refyntra: Navigate To…** (Alt+` in the `visualStudio` and `resharper` presets, C# editors; Ctrl+Alt+` on macOS):
  a QuickPick of the targets of the symbol at the cursor that exist, with counts — Declaration (partial parts),
  Implementations / Derived types / Implementations and overrides, Base types / Base symbols, Usages, Related tests,
  Related files (partial parts, `.Designer.cs`, `.g.cs`, `.razor`, `.cshtml` … with the same name), Containing type,
  Containing file, MediatR handler, Endpoint, DI registration, Call hierarchy. One location opens directly, several
  open the peek view. Built on Related, the call hierarchy and two new `code/hierarchy` directions.
- **Refyntra: Find Usages (Grouped)** and the **Refyntra Usages** view: usages classified by the C# host (read, write,
  read-write, invocation, `nameof`, attribute, inheritance / implementation, type argument, object creation, other;
  usages in tests); grouping by usage kind, project, folder, file, containing type and member (view menu toggles,
  counts on every group); source line with the name highlighted; kind and tests filters; Next / Previous Usage (F4 /
  Shift+F4 while the view has results in a C# editor); Export to Markdown; pinned results as tab-like roots; cancellable
  progress, 1000 usages first, then Show more.
- Protocol 1.12: `code/usages` and the `code/hierarchy` directions `bases` / `containing` (protocol-v1.md).
- Tests: .NET (`UsageClassifierTests` on an in-memory solution: every kind, partial classes, generics, properties
  get/set, compound assignment, `nameof`, attributes, inheritance, tests, the limit; `NavigationTargetsTests`;
  `UsagesProtocolTests` on Shop), unit tests of the Navigate To and Usages models, e2e scenario `navigation`, visual
  baselines `navigate-to` and `usages` (both themes).

### Added (Search Everywhere)

- Refyntra: Find is extended to Search Everywhere: sections Types / Symbols / Files / Commands / Settings, camel-hump
  matching, ranking exact > prefix > camel hump > substring with recently picked items (per workspace) first, and the
  prefixes `#` symbols, `/` files, `>` commands, `@` settings.

### Changed (constructor and DI helpers on Roslyn)

- The constructor / DI helpers (create and initialize field or property from a constructor parameter, initialize an
  existing unassigned member, initialize all parameters, field from a primary constructor parameter, initialize
  readonly fields from the constructor (creating it), Create field and inject via constructor, Add parameters to
  constructor, Register in DI) are computed by the C# host with Roslyn (protocol 1.11, `code/constructorActions`)
  instead of a text pass: semantic types with the needed usings (generic types included), every part of a partial
  class (the edit lands in the part with the constructor), `.editorconfig` naming rules (prefix and capitalization),
  then the existing fields, a compile check of every changed file, and call-site checks with Roslyn references.
  Same command ids, titles and pickers; the text-based model was removed (an older host shows a message).
- Improvements: a primary-constructor class gets the new parameter in its primary constructor and the member an
  `= parameter` initializer; the type of an undeclared `_name` is inferred from the members used on it (the solution
  types that have them, interfaces first) or from an assignment; `_logger` becomes `ILogger<T>` only when
  Microsoft.Extensions.Logging is referenced; a typed type name is resolved and imported.
- **Register in DI** is a previewed plan (`refactor/prepare` `csharp.registerDi`): already-registered services are
  recognised from Refyntra's DI relations, an interface is paired with its single implementation, the composition
  roots come from the DI analysis (several: you choose; none: refused), usings are added; revalidated and undoable.

### Added (Fix in scope)

- *… in document, project or solution…* for the style-like edit actions (var ↔ explicit type, expression ↔ block
  body, `using` declaration, object initializer, interpolated string, `string.Format` → interpolation):
  `refactor/prepare` `csharp.fixAll` (protocol 1.11) computes every occurrence in the scope as one plan, applied
  through the preview with revalidation, the EditApplier and Undo; cancellable progress; occurrences that would add a
  compiler error, generated and read-only files are skipped and reported. Compiler and third-party analyzer
  diagnostics are out of scope; OR1001 has no code fix by design.
- Tests: .NET (`ConstructorTests`, `FixAllTests`, `RegisterWithoutRootTests` on the new `Ctor` fixture: partial
  classes across files, generic types, records, primary constructors, naming styles, call sites, two composition
  roots, no root, fix-all across two projects), unit tests of the TypeScript glue, e2e scenario `ctor-di` (field with
  a using, injected field, Register in DI and var → explicit type in the solution through the Refactor Preview, Undo).

### Added (Convert actions)

- Edit actions (`code/editActions`, no protocol change), computed by Roslyn and compile-checked like the others:
  **`if` chain → `switch` statement / expression**, **`switch` statement ↔ expression**, **`foreach` ↔ LINQ**
  (`Where`/`Select`/`ToList`, `Any`, `All`, `FirstOrDefault`, `Count`, `Sum`; `using System.Linq;` added when
  needed), **interpolated string ↔ `string.Format`** (alignment and format specifiers kept), **constructor ↔ primary
  constructor** (C# 12+), **class ↔ record** (only without custom equality and mutable state; back only without
  `with`, value comparisons or deconstruction in the document), **auto-property ↔ backing field**, **object
  initializer** from consecutive member assignments (and split back), **`using` statement ↔ declaration** and **make
  method async / remove `async`/`await`**. Each is offered only for shapes it can rewrite without changing behaviour
  and refuses with a reason otherwise (README table).
- Tests: .NET (positive and refusal per action), e2e (`if` → `switch` expression, `foreach` → LINQ, constructor →
  primary constructor, each with Undo).

### Added (Introduce Field, Constant and Parameter)

- Edit actions (`code/editActions`): **Introduce Field** from a selected expression — initialize in the field
  initializer, the constructor(s) or the current member (one code action, the valid choices in a QuickPick), `static`
  in a static context, `readonly` when only set in the initializer/constructors, *replace all occurrences in the type*
  when the value cannot change — and **Introduce Constant** (local `const` or a constant of the type replacing every
  occurrence) for compile-time constants. Names are suggested from the expression (rename afterwards with F2).
- **Introduce Parameter** (`refactor/prepare` action `csharp.introduceParameter`, additive in protocol 1.10; command
  `refyntra.introduceParameter`, also in the lightbulb): the containing method gets a parameter and every call site
  passes the expression, in any file, the override/interface hierarchy included, through the Change Signature machinery
  with preview, revalidation and Undo. Refused: locals/parameters/instance members in the expression, names that are
  inaccessible or mean something else at a call site, method groups/delegates, methods visible outside the assembly.
- Fix: the Generate kind picker says "1 member to …" / "1 field" instead of "1 members" (picker baselines updated).
- Tests: .NET (positive and refusals), unit glue (grouping, QuickPick items, plural), e2e (Introduce Field in the
  constructor; Introduce Parameter across files with Undo).

### Added (Inline Method, Field and Parameter)

- Edit actions (`code/editActions`, no protocol change): **Inline Method** at a call site or at all call sites with the
  declaration removed (expression bodies and single-`return` bodies; arguments with side effects or used more than once
  are evaluated once into temporaries before the statement), **Inline Field / Constant** (`const`, or `readonly` with a
  side-effect-free constant initializer) and **Inline Parameter** (every caller passes the same side-effect-free value).
  Refused: recursion, `ref`/`out` parameters, several returns, virtual/interface members, method groups and delegates,
  references in other files. Tests: .NET (positive and refusals), unit glue, e2e (Inline Method all call sites).

### Added (postfix templates and Generate for C#, protocol 1.10)

- **`code/postfix`** (protocol minor 10): after `expr.` the C# host lists Rider's postfix templates that fit the
  expression's type — `.if .ifn .notnull .not .var .foreach .for .forr .await .return .throw .new .par .cast .arg
  .using .lock .switch .while .nameof .yield` — as snippets formatted with the document's options, with tab stops and
  names suggested from the expression or its type. Statement templates only for a whole expression statement.
- Editor: a completion provider for C# (trigger `.`), sorted after the regular members, cached per document version and
  dot, cancelled with the completion request; setting `refyntra.postfix.enabled` (default on).
- **`code/generate`** (protocol minor 10) and **Refyntra: Generate…** (`refyntra.generate`, Alt+Insert in the
  `visualStudio` and `resharper` presets, C# editors): constructor, Equals/GetHashCode (`IEquatable<T>`, `==`/`!=`,
  `HashCode.Combine`), ToString, properties from fields, missing interface / abstract members, overrides and delegating
  members. Roslyn writes the code (usings added, names simplified, partial types, `.editorconfig` formatting) and
  refuses a result with a new compiler error; applied as one Undo step to the same document version only.
- **Generate Constructor** (`refyntra.ctor.generate`) now goes through the same Roslyn generation; the text-based
  helper stays as the fallback for an older host.
- Tests: .NET tests per template category and per Generate kind (generics, records, partial types, nullable, structs,
  refusals); unit tests for the editor glue; e2e (`.foreach`, `.ifn`, Equals/GetHashCode, Implement interface) and
  visual baselines for the postfix list and the Generate picker.

### Added (Rider-style C# edit actions, protocol 1.9)

- **`code/editActions`** (protocol minor 9): the C# host lists single-document edit actions at a range and computes
  one with Roslyn: syntax rewrite, formatting of the changed nodes (document options, `.editorconfig`), refusal when the
  document would get a new compiler error. Actions: convert expression body ↔ block body, `var` ↔ explicit type, invert
  `if`, `if` ↔ conditional expression, merge / split nested `if`, string concatenation → interpolated string, Inline
  Variable, Introduce Variable (this occurrence or all). Honest refusals for written variables, moved side effects,
  conditional evaluation, mixed branch types, NaN-sensitive comparisons.
- Editor: the actions appear in Ctrl+. and the Refactor… menu under `refactor.rewrite.refyntra.*`,
  `refactor.inline.refyntra.*` and `refactor.extract.refyntra.*`; applied as one Undo step, only to the document version
  they were computed for. Commands **Introduce Variable** / **Inline Variable**; `resharper` preset: Ctrl+Alt+V /
  Ctrl+Alt+N (C# editors only).
- Tests: .NET tests for every action (results and refusals) on the Refactorings fixture; unit tests for the editor glue.

### Added (debugging like Rider and Visual Studio; constructor and DI helpers)

- **Inline debug values for C#** (`refyntra.debug.inlineValues`, default on): an InlineValuesProvider shows
  `name = value` for parameters, locals, `foreach`/`out var` variables, assigned fields and `this.X` on the lines of the
  stopped method up to the stopped line (visible range only; top-level statements too). A fast syntax pass, values via
  DAP `evaluate` (watch context), shortened; no method calls are evaluated. An EvaluatableExpressionProvider makes
  hover evaluate the whole member chain (`a.B.C`). No protocol change (the host is not asked).
- **Refyntra Immediate** panel (webview view in the panel, strict CSP, theme variables): evaluates in the selected
  frame of the active `refyntra-dotnet`/`refyntra-python` session (`repl` context: assignments and calls allowed),
  multi-line input, history, expandable result trees, Copy, Add to Watch, Clear, DAP completions where supported;
  keyboard and screen reader accessible. **Refyntra: Show Immediate Window** (Ctrl+Alt+I in the `visualStudio` preset
  while debugging).
- **Constructor and DI code actions** (C#): Create and initialize field/property from a constructor parameter,
  Initialize an existing field, Initialize all unassigned parameters, fields from primary-constructor parameters,
  Initialize readonly field(s) from constructor, Generate constructor… (multi-select), Add parameters to constructor…
  (refused when `new` call sites exist), Create field '_x' and inject via constructor (type inferred or picked from the
  solution), Register in DI (lifetime, interface → single implementation, composition root in `Program.cs` or an
  `IServiceCollection` extension; asks when several, explains when none). Naming from `.editorconfig`, then existing
  fields. Current-file edits apply directly as one Undo step; the DI registration goes through the Refactor Preview.
- Tests: unit tests for the inline-value syntax pass, hover chains, the Immediate Window model and the constructor/DI
  planner (naming styles, existing fields, records, primary constructors, expression bodies, Program.cs and
  extension-method roots); the e2e `run-debug` checks inline values, the hover chain, Immediate evaluate/assign/expand
  and the field code action with Undo; visual baselines `inline-values`, `immediate`, `ctor-actions`,
  `generate-constructor`.

### Added (Run and debug, protocol 1.8, ADR-008)

- Refyntra runs and debugs projects without other extensions. **.NET**: the bundled Samsung **netcoredbg 3.2.0-1092**
  (MIT; official release archives, SHA-256 pinned in `scripts/package/debuggers.json`, staged per platform package;
  none exists for win32-arm64, darwin-x64 and alpine-x64, where Health says debugging is unavailable and Run still
  works), debug type `refyntra-dotnet` (launch with a `dotnet build` step, attach with a process picker, exception
  breakpoints, `env`/`args`/`cwd`/`stopAtEntry`/`justMyCode`, C# breakpoints). **Python**: the bundled **debugpy
  1.8.22** (MIT, pure-Python parts of the official wheel, SHA-256 pinned), debug type `refyntra-python` run by your
  interpreter. **Rust**: `cargo run`; debugging with an installed `lldb-dap` (detected, not bundled: CodeLLDB would add
  45–56 MB per package). **package.json scripts**: run with npm/pnpm/yarn, debug configurations for VS Code's built-in
  JavaScript debugger (`node`, `msedge`/`chrome` on the dev-server URL).
- Host: `workspace/runnableProjects` (protocol 1.8) classifies the loaded projects (console, web, worker, Windows
  Forms/WPF, test, library, MAUI, Blazor WebAssembly) with target frameworks, outputs and `launchSettings.json`; the
  client reads the profiles (URL, environment, arguments, launchBrowser).
- Run without debugging in a terminal (`dotnet run` with the launch profile, `dotnet watch run` for hot reload), Stop
  and Restart; web profiles with `launchBrowser` open the browser on the `Now listening on:` URL, also when debugging.
- UI: the **Refyntra Run** view, the run target in the status bar (project · profile · framework · configuration),
  CodeLens `Run | Debug` over entry points, Run/Debug editor title buttons, dynamic configurations in VS Code's Run and
  Debug view, **Refyntra: Generate launch.json**, a *Run and debug* section on the Health page. F5 and Ctrl+F5 keep VS
  Code's behaviour (no keybinding is contributed). Settings `refyntra.run.codeLens`, `.editorButtons`, `.statusBar`,
  `.view`. Trusted workspaces only.
- Tests: .NET tests for the project detection (fixture `tests/fixtures/Runnable`: console, web with launchSettings,
  worker, multi-target, library, test project; WinForms, WPF, MAUI and Blazor WebAssembly project files), unit tests for
  the run model and configuration resolution, the Docker e2e scenario `run-debug` (netcoredbg stops at a breakpoint,
  locals, an evaluated expression, exit code 7; the web fixture answers on its profile URL; debugpy stops in a Python
  file), Restricted Mode checks, and the visual scenarios `run-view` and `debug-stopped`.
- Packaging: `servers.mjs` stages netcoredbg and debugpy (verified downloads, packaging time only), `audit:vsix`
  allows exactly their files and checks the binary platform and the pinned SHA-256, `pnpm notices` lists both with
  their license texts in `legal/` and the SBOM (`pkg:github/Samsung/netcoredbg`, `pkg:pypi/debugpy`).

### Added (visual tests)

- `pnpm test:visual` (`scripts/test/linux-visual.sh`): screenshot tests of Refyntra's UI in VS Code 1.90.2, headless in
  Docker only (Xvfb 1600x1000x24), in Default Dark Modern and Default Light Modern: CodeLens, Ctrl+. refactorings,
  the editor context submenu, Refactor Preview, Change Signature, Related, Stack Trace, Task Context, the status bar
  menu, Health, the MediatR hover and Find. Compared with `tests/visual/baselines` (pixelmatch + pngjs, root
  devDependencies, not in the VSIX), masks in `tests/visual/masks.json`, an HTML report in
  `test-results/visual/report.html`; `--update` regenerates the baselines. The e2e image adds imagemagick, xdotool and
  fonts-dejavu-core.
- VNC watch mode for the Docker VS Code runs: `REFYNTRA_VNC=1` or `--vnc` on `linux-visual.sh` and `linux-e2e.sh`
  (fixed Xvfb `:99`, view-only x11vnc on 127.0.0.1:5900, noVNC on http://localhost:6080/vnc.html,
  `REFYNTRA_VNC_PAUSE_MS` to slow down); x11vnc, novnc, websockify and x11-utils in the test image only.

### Fixed (found by the visual tests)

- Rename plans carry minimal edits (one per occurrence) instead of one whole-document replacement per file, so the
  Refactor Preview lists each renamed occurrence instead of striking through the whole file.
- The Health page draws its status icons as inline SVG in the theme colors; the emoji glyphs rendered as empty boxes on
  Linux desktops without an emoji font.

### Added (native VS Code integration, protocol 1.7)

- **Code actions** for C# (lightbulb, Ctrl+., Refactor…, Source Action…): `refactor.extract.method`,
  `refactor.rewrite.signature`, `refactor.move.typeToFile`, `refactor.rewrite.safeDelete`, `refactor.rewrite.rename`
  (also TS/JS, Python, Rust), `refactor.rewrite.generateHandler`, `source.refyntra.cleanup`. The automatic lightbulb
  uses only a text check (Extract Method for an extractable-looking selection); explicit requests ask the route and list
  inapplicable actions disabled with the reason. Each action runs the existing command with the target position.
- **Refactor Preview**: text-only plans open in VS Code's Refactor Preview (`WorkspaceEditEntryMetadata`
  `needsConfirmation`, label = plan, description = open points). Revalidation and the synchronous hash checks happen
  before the hand-over; the post-state is reconciled per file; discarded / partly applied outcomes are reported; edits
  elsewhere while the panel is open are noted. `refyntra.preview.style` (`native` default, `quickPick`). ADR-004
  Amendment 6. `ApplyOptions.confirmation`, `EditApplier.capture(writeSet, {confirmation})`.
- **CodeLens** above C# types and methods (references · implementations · tests; MediatR handler / sent from; endpoint
  route · frontend calls; EF Core configuration · migrations), lazily resolved from Related, cached per document
  version, peek on click; `refyntra.codeLens.enabled` plus per-kind switches. Text scan: ~9 ms for 20,000 lines.
- **Call Hierarchy and Type Hierarchy** providers for C# backed by the host: request `code/hierarchy` (protocol 1.7:
  incoming / outgoing calls with call sites, supertypes, subtypes; source declarations only, at most 500).
- **Change Signature dialog** (webview, strict CSP with nonce, theme variables, no external files): parameter table with
  drag, ↑/↓ buttons and Alt+Up/Down, name/type/value-at-call-sites/default fields, live signature preview, affected
  call-site count, validation; then the normal preview. `refyntra.changeSignature.editor` (`dialog` default, `quickPick`).
- **Hover** on MediatR requests naming the handler with a link (`refyntra.hover.mediatr`).
- **Status bar**: state icon (spinner / check / warning), solution loading as window progress, a state-aware menu on
  click (`refyntra.statusMenu`).
- **Related view**: icons per relation kind and group, header message with the shown symbol and the pinned state, the
  code line of the target in the tooltip (read lazily; no document is opened), empty groups never shown.
- **Stack trace**: the line of an opened frame is highlighted briefly; own frames get a coloured stack-frame icon.
- Editor context submenu **Refyntra** grouped Navigate / Refactor / Context with every action (C#-only entries only in
  C# files).
- Tests: host tests `HierarchyTests` (incoming/outgoing calls, supertypes/subtypes, invalid direction), engine tests for
  the confirmation pass-through, the stale refusal before the panel and `hierarchy`; vitest `nativeUi.test.ts`; e2e
  scenario `native-ui` (code action kinds, CodeLens resolve, hierarchy providers, hover, Refactor Preview apply / discard
  / stale refused, Change Signature dialog) and the stack-trace highlight.

### Added (code refactorings, protocol 1.6)

- **Safe Delete** (`csharp.safeDelete`, command `refyntra.safeDelete`): deletes a type, method, constructor, property,
  field, event, local or parameter only when Roslyn finds no use outside the deleted code; otherwise refuses and names
  the uses (*Show usages*). Interface/abstract/virtual members cascade to their implementations/overrides; an
  implementation or override alone is refused. All partial declarations are deleted; a file left without code is
  deleted after the text edits when its Compile membership is the plain SDK glob (else kept empty, with the reason).
  Parameters are removed with their call-site arguments (side-effect-free arguments only). Framework relations
  (MediatR, DI, endpoints) and string/`dynamic` uses make the plan limited.
- **Extract Method** (`csharp.extractMethod`, command `refyntra.extractMethod`): statements or one expression into a
  new private method, from Roslyn data-flow and control-flow analysis (parameters, returned variable, `out`/`ref`,
  locals, always-returning selections), `static` when possible, `async` when it awaits, enclosing type parameters with
  constraints; name prompt. Honest refusals for jumps, mixed exits, `yield`, unsafe code, local functions, ref locals,
  anonymous types, async out values, assignment targets, constant contexts and more (reason codes in protocol-v1.md).
- **Change Signature** (`csharp.changeSignature`, command `refyntra.changeSignature`): add, remove, reorder and rename
  parameters (new parameters with a call-site value and/or a default) across the override/implementation hierarchy and
  every call site (named arguments, optional arguments, `params`, extension calls, constructor initializers); evaluation
  order of side-effecting arguments kept with named arguments; `<param>` docs updated; re-binding check of every
  rewritten call and of same-named overloads. Method groups, attributes, pattern-based names and type changes are
  refused; string/`dynamic` uses are reported as unknown callers (limited plan).
- Protocol 1.6: `PrepareParams.range`/`signature`, `PlannedChange` kind `delete` (last; checked against
  `expectedHash` right before the delete), `RefactorPlanDto.fileDelete`, request `code/signature`, notification
  `workspace/didDeleteFiles` (host resync; an older host or an unknown outcome restarts the route). ADR-004
  Amendment 5 describes the delete order and checks. Plan validation (domain) rejects unlisted, misplaced or
  overlapping deletes.
- Tests: .NET fixtures `tests/fixtures/Refactorings` with positive and negative cases for each refactoring (results
  applied to the copy and built with `dotnet build`); vitest for plan validation, apply outcomes, resync, the preview
  summary and the Change Signature editor model; e2e scenario `code-refactor` (apply, file deletion + resync + Undo,
  a delete refused when the file changes in the last moment, Extract Method, Change Signature).

### Added (Task context)

- **Refyntra Task Context** view: named contexts per workspace (create, rename, delete, switch; the active one is shown
  in the view description) holding symbols of any route (C#, TS/JS, Python, Rust), files, endpoints, places and pinned
  relations (subject + relation + target), each with an optional note. Added from the editor (*Add Symbol at Cursor*,
  *Add File*), the Explorer, Find results (item button) and Related (relation items and the subject).
- Items are stored as descriptors, not symbol ids: route, kind, name, container/qualified name, workspace-relative file,
  last position, an FNV-1a hash of the declaration line (not the text) and the file's line count. Schema version 1 in
  `workspaceState` (local, never synced, no telemetry), with a migration table; a store from a newer version is left
  untouched. Limits: 50 contexts, 500 items, 2,000-character notes, ~1 MB total, 2 MB imports.
- Resolution on view open, after edits (debounced), on backend restarts and before opening an item: **resolved**,
  **moved** (place updated), **ambiguous** (you choose; same name with another kind or container is never taken
  silently), **missing** (kept, with the reason), **not checked yet** (route not ready). A rename made through Refyntra
  is followed by name (only the name changed on the stored line and the line count is unchanged).
- Open, Show Related, reorder (drag and drop, Move Up/Down), remove, Copy as Markdown (names, relative paths, notes;
  no source text), Export/Import JSON to a file you choose, Clear. States are words in the description and the
  screen-reader label (glossary in `docs/accessibility.md`). Walkthrough step "Keep a task context".
- Tests: vitest for the model, schema, decision table and Markdown; e2e scenario `task-context` on a temp copy of Shop
  (add symbol + relation, move by an edit → moved and opens the new place, reload, rename through Refyntra → resolved
  by name, delete → missing, export/import).

### Fixed (tests)

- Host test helper `Fixtures.RunAsync` waited without a bound for the output pipes of `dotnet sln add`/`dotnet restore`; an MSBuild worker node that inherited them kept a whole `dotnet test` run hanging at 0 % CPU (seen in `ReviewFindingsTests.S2_AProjectOutsideTheClosureThatStartsReferencingTheOwnerMakesThePlanStale`). It now waits for process exit (not end of output), kills the process tree on timeout, and disables MSBuild node reuse/server for these tool runs; covered by `FixturesRunTests`.

### Changed (Python and Rust: no other extension needed)

- Python and Rust no longer use the providers of separately installed extensions. Refyntra ships the language servers
  and runs them as its own processes: **Pyright 1.1.414** (npm `pyright`, MIT; run on VS Code's own Node runtime, no
  system Node) and **rust-analyzer 2026-09-21** (official release binary, MIT OR Apache-2.0). TypeScript/JavaScript is
  unchanged (VS Code's built-in features through public provider commands).
- Own LSP client in `infrastructure` (Content-Length framing + JSON-RPC peer, supervised process, process-tree kill);
  no `vscode-languageclient`, no registered providers. New package `@refyntra/adapter-lsp` (vscode-free) implements
  the routes `python.pyright` and `rust.rust-analyzer` over the application's new `LspConnection` port.
- Lifecycle: lazy start on the first Python/Rust document in a trusted workspace; never in Restricted Mode;
  `initialize` with the workspace folders; Refyntra sends didOpen/didChange/didClose itself (versions = document
  sequence); restart with backoff after a crash, `Failed`/`ServerCrashed` after repeated crashes; shutdown/exit on
  deactivate. Server logs at debug level with paths redacted.
- Find (`workspace/symbol`), Related (definition, implementation, references) and Rename (`prepareRename` + `rename`)
  over LSP. Rename plans record the server and the document versions the edit was computed on (`serverSession`); the
  same session is asked again before apply and must return identical edits on identical versions and fingerprints.
  File operations in a rename are refused. Routes stay `delegated` (ADR-002 amendment).
- Rust needs the Rust toolchain (`cargo`) for the Cargo project model; without it the route is Partial
  (`CargoNotFound`) and Health offers **Install Rust** (opens rustup.rs). Python imports of installed packages use
  `python.defaultInterpreterPath` or a `.venv`/`venv` in the workspace.
- Removed: the "install a Python language extension / rust-analyzer" recovery, the provider probe and the
  `ProviderMissing` reason.
- Packaging: platform-specific VSIX packages (`vsce --target`: win32-x64/arm64, linux-x64/arm64, alpine-x64,
  darwin-x64/arm64) each with only its own rust-analyzer, plus an optional universal package without it.
  rust-analyzer is downloaded at packaging time only and verified against `scripts/package/rust-analyzer.json`.
  `audit:vsix` allows exactly the bundled server files; notices/SBOM include Pyright, typeshed and rust-analyzer with
  their license texts. VSIX size 9.10 MiB → 24.0–25.2 MiB per platform (universal 10.6 MiB).

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
