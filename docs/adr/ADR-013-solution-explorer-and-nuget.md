# ADR-013: Solution Explorer, project operations and NuGet

Status: Accepted (alpha)

## Context

Rider and Visual Studio show a .NET solution as MSBuild sees it: solution folders, projects by kind, their
dependencies (projects, packages, frameworks, analyzers) and the files the build compiles, including linked files and
not the ones a `Compile Remove` takes out. They add, remove and rename projects, manage project references and NuGet
packages, and help editing project files. VS Code shows the folder on disk; Refyntra already loads the solution with
MSBuild (ADR-001) and has a run model (ADR-008) and a test runner (ADR-009). No other extension may be required.

Constraints:

- Local processing (README, "Privacy and local processing"). Network access only when the user asks for something that
  needs it, and only to the NuGet sources the user configured.
- Workspace Trust (ADR-005): nothing in this ADR runs in Restricted Mode (MSBuild evaluation, the dotnet CLI, NuGet).
- Refyntra handles no credentials.
- One owner of `workspace.applyEdit` (`editApplier.ts`, architecture check).

## Decision

1. **Model from the host: protocol 1.20 `solution/structure`** (no barrier). The host joins
   - the solution file, read as text/XML (`SolutionFileReader`: `.sln` project lines, solution folders, `NestedProjects`,
     `SolutionItems`; `.slnx` `Folder`/`Project`/`File`), and
   - the loaded MSBuild evaluation (Roslyn projects of the snapshot: `Compile` items with their `Link`-based folders,
     `AdditionalFiles`, project references, analyzer references, target frameworks, the run-model kind), and
   - the project file and its surroundings: `PackageReference` (with `VersionOverride`), Central Package Management
     (the nearest `Directory.Packages.props`), resolved versions and framework references from `obj/project.assets.json`
     when restored.
   Other files of SDK-style projects are listed as `None`/`Content`/`EmbeddedResource` (the default globs); C# files in
   the project folder that the evaluation does not compile are reported as `excludedUris` (hidden by default, greyed
   with `refyntra.solutionExplorer.excludedFiles = grey`). Projects in the solution file that did not load are listed
   with state `notLoaded`/`failed`.
2. **The view** "Refyntra Solution" (Refyntra container, `refyntra.solutionExplorer.enabled`) is a tree built by a pure
   model (`solutionExplorerModel.ts`). Linked files carry a link icon and a `↗` badge (FileDecorationProvider on a
   marked URI). Reveal Active File and `refyntra.solutionExplorer.autoReveal` select the editor's file. Context menus:
   Open, Reveal in Explorer / file manager, Copy Path, Run / Debug and Set as Startup Project (the run model's target
   selection), Run Tests (the test runner's project item), Manage NuGet Packages, Add/Remove Project Reference,
   New / Add Existing / Remove / Rename Project, Unload / Reload Project.
3. **What runs.** Every change is a `dotnet` CLI command run as a visible task (ProcessExecution, no shell: paths with
   spaces or quotes are single arguments): `dotnet sln add|remove`, `dotnet new <template> --name --output` (templates
   from `dotnet new list --columns type --columns language --columns tags`), `dotnet add|remove reference`,
   `dotnet add|remove package`, `dotnet restore`. Read-only commands run in the background with a timeout:
   `dotnet nuget list source`, `dotnet list package --outdated|--vulnerable|--deprecated --format json`,
   `dotnet package search --format json`. After a change the host reloads the workspace (`workspace/reload`) and the
   tree refreshes. The files a command changes are snapshotted first; **Undo** restores them when nobody changed them
   since. Central Package Management versions are edited directly in `Directory.Packages.props` (then `dotnet restore`).
   Rename Project is a WorkspaceEdit through `editApplier.ts` with `needsConfirmation` (VS Code's Refactor Preview):
   folder (when named after the project) and project file, the solution entry, `ProjectReference` paths of other
   projects, `RootNamespace`/`AssemblyName` equal to the old name. It refuses when the rename is ambiguous (a shared
   folder, an existing target, a reference written through a property). Namespaces in code are not changed.
   Unload / Reload is Refyntra-side only: the project stays in the solution file and in the host's analysis.
4. **NuGet network policy.**
   - Sources: exactly the enabled sources of the user's NuGet configuration (`dotnet nuget list source`, the same
     NuGet.config chain `dotnet` uses), nuget.org only when that list is empty (NuGet's own default).
   - Requests happen only on a user action: Search (V3 `SearchQueryService`), Load versions (V3 flat container
     `PackageBaseAddress`), Check for updates / vulnerable / deprecated (`dotnet list package`). Opening the panel,
     the Installed and Consolidate tabs, and project file completion (local NuGet cache and installed packages) read
     only local data. Package icons and other remote content are never loaded (strict CSP: nonce'd style and script,
     no `img-src`).
   - No credentials: HTTP requests are anonymous. A source that answers 401/403 (or is not a V3 feed) is searched with
     `dotnet package search --source <url>`, which uses the user's credential providers; when that fails too, the
     panel says the source needs credentials. Install, update and restore always go through `dotnet`, so private feeds
     work as they do on the command line.
   - Local folder sources are read from disk (`.nupkg` names, flat or hierarchical); installing from one passes
     `--source <folder>`.
5. **Project files.** Completion and hover in `.csproj`/`.props`/`.targets` (any language mode): MSBuild property and
   item names, values (TargetFramework, Nullable, LangVersion, ImplicitUsings, OutputType …), package ids in
   `PackageReference`/`PackageVersion Include` from the solution and the global packages folder, versions from the local
   cache plus "Load versions from NuGet sources…" (on demand, rule 4). Saving a project or solution file (outside
   `bin`/`obj`) reloads the workspace in the host; while the view is visible, created or deleted `.cs` and project
   files do too. "Edit Project File" opens the project of the current file.

## Consequences

- Protocol minor 20 (18 and 19 are taken by parallel work); older hosts answer `ProtocolTooOld` and the view says so.
- A reload re-evaluates the whole workspace (not one project); plans prepared before it become stale.
- Items are what Roslyn's evaluation exposes plus default globs; custom item types from targets files and items added
  by targets at build time are not shown. Generated files under `obj/` are not listed.
- Unload does not remove a project from the host's analysis (Find, Rename still see it).
- Tests: .NET (`SolutionStructureTests`: .sln and .slnx, folders, linked files, CPM), unit (tree model, command lines
  with spaces, recorded NuGet responses, template table, `dotnet list package` JSON, rename plans, csproj contexts,
  page rendering), Docker e2e (`solution`: tree, reference round trip with Undo, new/rename/remove project, a package
  from a folder feed made in the test — no internet, csproj completion, reload on save; `shop`: the tree shows Shop),
  visual baselines `solution-explorer` and `nuget-installed` in both themes.
