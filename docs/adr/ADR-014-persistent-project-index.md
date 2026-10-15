# ADR-014: Persistent project index

Status: Accepted (alpha)

## Context

Opening a solution runs MSBuild's design-time evaluation of every project (ADR-001). On the fixtures that takes 4–6 s
(docs/performance/baseline-2026-10-09.md); on large solutions it takes minutes, and every feature waits for it. Rider
and Visual Studio keep caches between sessions so the solution is usable at once. What the load produces for a project
— its documents, references, analyzers and source generators, compilation and parse options — changes only when its
inputs change.

## Decision

1. **What is stored.** After a load that ends `Ready` (every project loaded completely), the host writes one JSON file
   per solution: for each C# project its name, assembly name, project and output paths, default namespace, documents and
   additional documents (with folders), `.editorconfig` documents, metadata references (path, aliases, embed interop
   types), project references (by index), analyzer and generator paths, and the C# compilation and parse options that
   matter for binding; plus the project contexts shown in Health. Nothing is stored when a project has something that
   cannot be restored from a path (an in-memory reference, a document without a file).
2. **The key.** A SHA-256 over: the cache format version, the SDK version MSBuild registered, the solution file, every
   project file, `obj/project.assets.json` and `nuget.g.props/targets` of every project, the names of the `.cs`, `.razor`,
   `.cshtml`, `.resx`, `.editorconfig`, `.props`, `.targets` and `.csproj` files under each project folder (bin, obj and
   dot folders excluded: the SDK globs), and `Directory.Build.props/targets`, `Directory.Packages.props`, `global.json` and
   `NuGet.Config` in every folder above the projects. Any difference is a miss; nothing is reused partially. The index
   is written only when the key computed after the load equals the one computed before it.
3. **Use.** On the first load of a session whose key matches, the host builds the solution from the index (an
   `AdhocWorkspace` with MSBuild's host services, analyzers loaded by Roslyn's analyzer service) and answers
   `workspace/open` at once with `fromProjectIndex: true`. MSBuild's load continues in the background and replaces that
   solution (overlays re-applied), then refreshes the index. The client follows the status until `fromProjectIndex` is
   gone and then applies the final state (projects, load diagnostics, `Partial` / `Failed`).
4. **Refactorings wait.** Snapshots built from the index carry a negative load generation: `refactor/prepare` answers
   `IndexVerifying` on them, so no plan is computed on projects MSBuild has not confirmed. Reads (search, references,
   usages, navigation, inspections) work.
5. **Where.** `%LOCALAPPDATA%\Refyntra\projects` on Windows, `$XDG_CACHE_HOME/refyntra/projects` (default
   `~/.cache/refyntra/projects`) elsewhere; `REFYNTRA_CACHE_DIR` moves it, `REFYNTRA_PROJECT_CACHE=0` turns it off. At
   most 64 solutions are kept (least recently written removed). The files hold paths and options only, no source code.

## Consequences

- A reopened unchanged solution is usable without waiting for MSBuild; CPU use is unchanged (MSBuild still runs).
- Inputs outside the key (environment variables MSBuild reads, MSBuild SDK resolvers, imports with computed paths
  outside the folders above the projects) can make the index differ from MSBuild's result for the seconds until the
  background load replaces it; refactorings never run on it.
- Plans prepared on the index solution are impossible; after the swap, plans and snapshots follow the usual
  generation rules.
