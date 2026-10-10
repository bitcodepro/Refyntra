# Refyntra

> **Alpha. Not published, not yet verified on a release build.** Everything below describes the intended alpha scope; nothing here is a stability promise.

Refyntra is a free (MIT) code companion for VS Code that makes writing, analysing and navigating code easier: find anything, see how code is connected (callers, implementations, tests, request handlers, endpoints, DI registrations), get focused diagnostics, and rename safely with a preview.

C# is analysed by a local .NET host built on Roslyn, so answers such as "which handler serves this request?" or "where is this service registered?" come from the semantic identity of symbols, not from text search. TypeScript and JavaScript use the language features already installed in VS Code.

## What the alpha does

Three entry points share one result model:

- **Find**: look up a symbol, endpoint or known role.
- **Related**: show the relations of the symbol under the cursor.
- **Actions**: list the available actions, and the unavailable ones with the reason.

Alpha scope is navigation for:

- MediatR requests, handlers and `Send` call sites; pipeline behaviors (closed, and open generic as *likely*), stream
  requests (`IStreamRequest`/`CreateStream`) and notification handlers of a base notification (*likely*)
- Minimal API endpoints (simple, statically visible forms)
- ASP.NET Core MVC controllers and actions: `[Route]`, `[HttpGet/Post/Put/Delete/Patch/Head/Options]`, `[AcceptVerbs]`,
  `[controller]`/`[action]`/`[area]` tokens, inherited routes and actions; conventional routes (`MapControllerRoute`)
  are listed but marked *conventional route, not resolved*
- Explicit dependency injection registrations, including keyed (`AddKeyed*`, with the key; `[FromKeyedServices]`
  parameters), factory (*likely*, with the lambda location), instance and open generic registrations (closed usages
  such as `IRepo<Widget>` as *likely*)

Stage D additions:

- **OR1001 (experimental)**: a warning in the Problems view when a singleton provably captures a scoped service through
  constructor parameters inside one composition root, with the whole path as related information. When the path cannot be
  proven (factory, conditional, keyed, `IEnumerable<T>`, `TryAdd`, …) it stays silent; the code action *Refyntra: why
  OR1001 did not check this registration* explains why. See [docs/rules/OR1001.md](docs/rules/OR1001.md) and the overlap
  review [docs/rules/overlap.md](docs/rules/overlap.md) (Microsoft DI's `ValidateOnBuild` finds the same at startup in
  Development; OR1001 finds it while editing).
- **Tests in Related**: xUnit/NUnit/MSTest tests that reference the symbol (*references the symbol — not coverage*), test
  classes that only match by name (*heuristic*), and from a test the production symbols it references. Running a test is
  not offered: Actions shows *Run test: unavailable — no supported public test integration*.

Rename shows a preview first, then **Apply rename** (see [Rename](#rename)). Set `refyntra.rename.apply` to off for preview-only renames.

Framework relations are found by Roslyn from verified symbol identity (owned-semantic). Each relation states its confidence: *proven*, or *likely* for framework extension registrations such as `AddDbContext` and for MediatR versions outside the verified range. Results also say what was not understood (dynamic or unknown parts). See [docs/capabilities/alpha.md](docs/capabilities/alpha.md).

## Getting started

1. Open a folder with a `.sln`, `.slnx` or `.csproj` and trust the workspace. The status bar shows **Refyntra: C# Ready**
   when the solution is loaded; click it for a menu of every Refyntra command.
2. Put the cursor on a class, interface or method in a C# file and run **Refyntra: Related** (editor context menu
   **Refyntra** › Related, or the Refyntra view in the activity bar). The view lists callers, implementations, tests,
   request handlers, endpoints and DI registrations.
3. **Refyntra: Find** searches types, members, files and endpoints; narrow with `type:`, `member:`, `project:NAME`,
   `route:/path`, `method:GET`.
4. **Refyntra: Actions** shows what is available at the cursor (and why not); **Refyntra: Rename** previews every change
   before **Apply**.
5. Optional: set `refyntra.keybindings.preset` to `visualStudio` or `resharper` (**Refyntra: Keyboard Shortcuts Preset**).
   A preset may conflict with another keymap extension.

**Refyntra: Get Started** opens the same steps as a walkthrough. If a result says *Results may be incomplete*, some
projects did not load completely (most often NuGet packages are not restored): click **Run dotnet restore** under the
results, or open **Show Health** for the details.

## The Health page

**Refyntra: Show Health** (also in the status bar menu and under incomplete Related results) answers, from the top:

1. **Is it working?** One line per language, for example *✅ C# is ready — 9 projects loaded*, *⚠ C# works
   partially*, *⛔ C# is not running*, *🔒 Restricted Mode* or *✅ TypeScript / JavaScript: ready*.
2. **What does that mean for me?** For example: *8 of 9 projects are missing their NuGet packages, so Refyntra can't
   fully understand them. Find, Related and Rename may miss results in these projects.*
3. **How do I fix it?** One button for the most likely fix: **Restore packages** (runs `dotnet restore` for the
   solution in a terminal; when it succeeds, Refyntra reloads the solution by itself and the page turns green; if it
   fails, **Show restore output** shows why), **Install .NET SDK** (opens the download page; **Open global.json**
   when that file asks for a version you do not have), **Trust workspace**, **Select solution** or **Restart backend**.
4. **Which projects?** Grouped in plain words: *Works*, *Needs packages*, *Missing project reference*, *Failed to
   load*. Open a project to see its one-line reason; the original MSBuild text is under *Show MSBuild message*.
5. **Technical details (for troubleshooting)**, collapsed at the bottom: route, host, session, SDK, restarts, the
   loaded solution and every load message. **Copy as text** or **Refyntra: Show Health (text)** gives the same as
   Markdown for an issue report.

The page updates by itself after a restore, a restart or a solution switch.

## What it is not

- Not a ReSharper clone and not a feature-parity effort. ReSharper already exists for VS Code.
- Not a compiler, debugger or general refactoring suite.
- No automatic fixes, file generation or code transformations in the alpha.
- No promise of coverage for every C# project layout.

## Requirements

- Windows x64 (the only planned alpha target), VS Code 1.90 or newer
- A .NET SDK 10.0.x installed (Refyntra does not download or bundle it)
- A **trusted** workspace (see below)
- SDK-style C# projects

See the [support matrix](docs/support/matrix.md); nothing is listed as verified yet.

## Privacy and local processing

All analysis runs locally in a child process. Refyntra has no telemetry, no account and makes no network requests for navigation. Your source code is not sent anywhere. Logs contain no source text.

## Workspace Trust

Loading a project evaluates MSBuild, which can run project code. Therefore:

- In **Restricted Mode** Refyntra does not load projects. It shows a message and what to do. It only reads the file system to find solutions and projects.
- In a **trusted** workspace Refyntra loads the selected solution. Trust is not a sandbox.
- Refyntra never runs `dotnet restore` or `dotnet build` on its own. When packages are missing, the Health page offers **Restore packages** (and Related offers **Run dotnet restore**); only when you click it (and only in a trusted workspace) does Refyntra run `dotnet restore <solution>` as a task in the terminal panel. The path is passed to `dotnet` as a single argument without a shell, so nothing in a file name is interpreted.

See [SECURITY.md](SECURITY.md).

## Rename

C# Rename changes code in existing files and never saves files. It never creates, deletes or moves files. The one file operation it can do: when you rename a top-level type whose file is named after it (`Foo.cs` for `class Foo`, partial parts `Foo.*.cs`), the preview offers **Also rename the file Foo.cs → Bar.cs**, on by default when it is proven safe (see [Renaming the file with the type](#renaming-the-file-with-the-type)). Otherwise the file keeps its name and the preview says why.

How it works:

1. Refyntra computes the rename with Roslyn on an immutable snapshot of the solution (including unsaved editor buffers) and records a **read set**: every source file of the affected projects (the project of the symbol, its dependencies and every project that depends on it), the project and solution files, `Directory.Build.*`, `Directory.Packages.props`, `global.json`, `.editorconfig`, `obj/project.assets.json`, literal `<Import>`s and the set of `.cs` files on disk under each project (so a new file appearing also counts as a change), plus every project file of the solution (a project that starts referencing the renamed symbol's project counts as a change too).
2. You see a preview: a summary with limitations and evidence, and a diff per file.
3. Choose **Apply rename** (offered unless `refyntra.rename.apply` is off). After you confirm, Refyntra revalidates the whole read set with the host, reads closed target files from disk, checks synchronously that every target still has exactly the previewed text, and only then applies one text-only edit to the editor.
4. The result is checked per file afterwards (confirmed / unchanged / unknown) and reported as it is. The changed files stay unsaved; Undo works in the editor.

What is guaranteed:

- Nothing is applied when the plan changed since the preview: an edit in any affected file (saved or not), a change of a build input, a new or deleted source file in an affected project, a host restart, a reload or a solution change all make the plan stale. You get "The code changed since the preview" and can prepare again for a fresh preview.
- A plan is used once. Refyntra never applies a plan automatically again, never saves, and never rolls back on its own.
- Renames that would add new compiler errors in the affected projects (compared with the errors that were already there, by error id and location), touch generated code, read-only files, files not saved as UTF-8, closed files with mixed line endings (VS Code would normalize them, so the result would differ from the preview), symbols from referenced assemblies or projects that did not load completely are refused.
- A reload of the workspace while a rename is being prepared discards that plan.

What is not guaranteed (residual risk):

- Another program can write a target file in the very last moment between the final check and the editor applying the edit. The VS Code API offers no lock for that. Refyntra checks the result afterwards and reports an unexpected state as "unknown", not as success.
- MSBuild imports with computed paths (`$(Something)`) are not fingerprinted; such plans are marked *limited*, stay limited after revalidation, and are applied only after a second confirmation that lists what was not checked.
- String literals, comments, reflection names, JSON, routes and serialization contracts are not renamed. Public API may have consumers outside the solution, which are not updated. Overloads are not renamed together. An alias name is not renamed (the cursor on an alias renames the aliased type).

### Renaming the file with the type

The option is offered only when every part of the type is in a file named after it, each such file contains nothing but that type (no other top-level type, no top-level statements), the type is not file-local or generated, and Refyntra can prove that the new name stays in exactly the same `Compile` items in every build of every project that contains the file: the SDK default `*.cs` glob is on (`EnableDefaultCompileItems`/`EnableDefaultItems` not changed), the file is inside the project folder (not linked) and not under `bin/` or `obj/`, the project file, the nearest `Directory.Build.props`/`.targets` and their literal imports have no `Compile` item with a pattern or naming either file (an explicitly listed file is refused in this version, because it would need a project file change) and do not change `DefaultItemExcludes` or the output folders. The new file must not exist (compared ignoring case), the old file must not be a symbolic link or read-only, and the new name must not be a reserved Windows name. A rename that changes only the letter case of the file (`Widget.cs` → `WIDGET.cs`) is refused: on case-insensitive file systems it would need a temporary name. In every refused case the rename is still offered as a text-only rename, with the reason in the preview.

Order and failure semantics:

1. After you confirm, the host revalidates the read set plus the file-rename guards (the target is still absent, the project files are unchanged, the proof still holds).
2. All text edits are applied in one edit (all or nothing for text), exactly as for a text-only rename.
3. Only when every edited file is confirmed, the file is renamed as a separate operation through VS Code (`WorkspaceEdit.renameFile`, never overwriting). VS Code moves open editors with it and keeps unsaved changes; the renamed file stays unsaved like the others.
4. Afterwards Refyntra checks that the new file exists with the previewed text and the old one is gone, and tells the host which documents moved (no reload of the projects).

If the file rename does not happen (for example another program created the target right after the text edits), the text edits stay applied: Refyntra says exactly that ("the text edits were applied … but the file rename did not complete …"), offers **Undo text edits**, and never rolls back on its own. If the result of the file rename cannot be confirmed, it is reported as unknown and the C# backend is restarted so that it reads the files again.

Residual risks: VS Code has no transaction across text edits and file operations, so a failure between the two steps leaves the text edits applied (reported, undoable). Another program can create or change the target in the very last moment before the rename; VS Code then refuses to overwrite and the outcome is reported. MSBuild items that come from NuGet packages, the SDK or computed imports are not inspected (computed imports make the plan *limited*, and then the file is not renamed). Undo of the rename itself is VS Code's file-operation Undo (for example in the Explorer), not Refyntra's.

## TypeScript and JavaScript (delegated)

For `.ts`, `.tsx`, `.js`, `.jsx` (and `.mts`, `.cts`, `.mjs`, `.cjs`) files, Find, Related, Actions and Rename are
**delegated** to the TypeScript/JavaScript language features installed in VS Code (normally the built-in extension).
Refyntra only calls VS Code's public provider commands; it runs no TypeScript worker and registers no definition or
rename provider of its own.

- **Find** merges TS/JS workspace symbols with C# results; each item shows its route (`TS/JS (delegated)`). The
  provider decides what it finds: Refyntra never presents this as a complete index.
- **Related** shows declarations and references. There are no framework relations for TS/JS; Actions lists them as
  unavailable with the reason.
- **Rename** uses the same preview and apply as C#, labelled *provider-managed semantic coverage*: Refyntra records the
  text of every affected file, asks the provider for its edit, refuses edits that are not plain text edits on local
  files, and before applying asks the provider again on the current state. It applies only when the provider returns
  exactly the previewed edit and no file changed. Validation is always *limited* (never *valid*, no compilation
  check), so applying asks for an extra confirmation. When Refyntra cannot confirm safety it offers the editor's own
  Rename (F2), which is then **not validated by Refyntra**.
- When no TypeScript/JavaScript provider answers (the built-in extension is disabled, still starting, or the file is
  not in a TS/JS language mode) features say so instead of showing an empty result.

## Commands

| Command | Purpose |
|---|---|
| `refyntra.find` | Find symbols, endpoints, known roles |
| `refyntra.related` | Related symbols for the current position |
| `refyntra.actions` | Available actions and reasons for unavailable ones |
| `refyntra.rename` | Rename with preview, then apply |
| `refyntra.showHealth` | The Health page: is Refyntra working, what it means, the fix, projects by state |
| `refyntra.showHealthText` | The same report as a Markdown document, technical details included |
| `refyntra.restartBackend` | Restart the .NET host |
| `refyntra.exportDebugBundle` | Save a redacted, previewed debug bundle to a local file (opt-in, nothing is sent) |
| `refyntra.selectSolution` | Choose the solution or project to load |
| `refyntra.showMenu` | The menu of main commands (also a click on the status bar item) |
| `refyntra.getStarted` | Open the *Get started with Refyntra* walkthrough |
| `refyntra.keyboardShortcuts` | Open the `refyntra.keybindings.preset` setting |
| `refyntra.findHandler` / `refyntra.findEndpoint` / `refyntra.findRegistration` | Find, narrowed to handlers, endpoints or DI registrations (the same search as Find, with a preset filter) |
| `refyntra.nativeRename` | (not in the palette) The editor's own Rename, offered when a TS/JS rename cannot be confirmed safe; not validated by Refyntra |

## Settings

| Setting | Values | Description |
|---|---|---|
| `refyntra.hostPath` | path, machine scope | Use a host build from this location instead of the packaged one (development use). Only user or machine settings, never workspace settings, so a project cannot choose the executable |
| `refyntra.keybindings.preset` | `none` (default), `visualStudio`, `resharper` | Optional keybinding preset |
| `refyntra.rename.apply` | boolean, default on | Offer **Apply rename** after the preview (revalidated after you confirm, not saved). Off = preview-only |
| `refyntra.related.followCursor` | boolean, default on | The Related view follows the cursor unless it is pinned |
| `refyntra.rules.OR1001` | `off`, `information`, `warning` (default) | Severity of the experimental OR1001 rule in the Problems view |
| `refyntra.trace.level` | `info` (default) and other levels | Detail of the Refyntra output log. Source text is never logged |

## Troubleshooting

- **SDK not found**: the Health page says *C# is not running* and offers **Install .NET SDK** (and **Open global.json** when a global.json pins the version). Install it and click **Restart backend**. Refyntra does not download SDKs itself.
- **Status is Partial** (some projects not loaded): open `Refyntra: Show Health` to see which projects did not load and why, grouped by cause. Results for those projects are incomplete and say so.
- **Missing references or empty results after cloning** (or packages deleted from the NuGet folder): the Health page shows *Needs packages* with **Restore packages**. Click it: after a successful restore the backend reloads the solution by itself. Or run `dotnet restore` yourself, then restart the backend. Refyntra never restores without your click.
- **Trust required**: trust the workspace through VS Code if you accept evaluating its projects.
- **Host crashed / stopped restarting**: see Show Health and the output channel, then `Refyntra: Restart Backend`.
- **Reporting a problem**: `Refyntra: Export Debug Bundle` shows a preview and saves a local file without source text, environment values or your paths.

More in [docs/support/troubleshooting.md](docs/support/troubleshooting.md).

## Status and feedback

Alpha: commands, settings and output may change. Issues and contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
