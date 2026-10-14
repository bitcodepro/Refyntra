# Refyntra

> **Alpha. Not published, not yet verified on a release build.** Everything below describes the intended alpha scope; nothing here is a stability promise.

Refyntra is a free (MIT) code companion for VS Code that makes writing, analysing and navigating code easier: find anything, see how code is connected (callers, implementations, tests, request handlers, endpoints, DI registrations), get focused diagnostics, and rename safely with a preview.

C# is analysed by a local .NET host built on Roslyn, so answers such as "which handler serves this request?" or "where is this service registered?" come from the semantic identity of symbols, not from text search. TypeScript and JavaScript use the language features built into VS Code. Python and Rust use language servers that ship inside Refyntra (Pyright and rust-analyzer), run as Refyntra's own processes: **no other extension is needed**. Refyntra also **runs and debugs** .NET projects (bundled netcoredbg), Python files (bundled debugpy), package.json scripts (VS Code's built-in JavaScript debugger) and Cargo binaries, again without other extensions (see [Run and debug](#run-and-debug)).

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
- EF Core: DbContext ↔ entities (`DbSet<T>`, `Entity<T>()`, `IEntityTypeConfiguration<T>`, `ApplyConfiguration`;
  `ApplyConfigurationsFromAssembly` as *likely*), mapped tables (`ToTable`, `[Table]`; convention names as *likely*),
  navigations and relationships (fluent `HasOne/HasMany/WithOne/WithMany/HasForeignKey/OwnsOne/OwnsMany`, conventions
  as *likely*), query sites (`DbSet<T>`, `Set<T>()`, with the enclosing endpoint) and migrations / model snapshots
  (read-only). Dynamic model building is reported as unknown; no model is built at runtime and no database is accessed
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
- **Inspections OR1002–OR1010** in open C# files, each with a compile-checked quick fix and *… in document, project or
  solution*: sync over async, `async void`, discarded tasks, undisposed locals, multiple enumeration, string
  concatenation in loops, `Where(…).First()`, redundant `ToList()`, `string.Format` without arguments (see
  [Inspections](#inspections-c)).
- **Tests in Related**: xUnit/NUnit/MSTest tests that reference the symbol (*references the symbol — not coverage*), test
  classes that only match by name (*heuristic*), and from a test the production symbols it references. Running a test is
  not offered: Actions shows *Run test: unavailable — no supported public test integration*.

Code refactorings with the same preview and apply pipeline: **Safe Delete**, **Extract Method** and **Change Signature**
(see [Safe Delete, Extract Method and Change Signature](#safe-delete-extract-method-and-change-signature)).

Rename shows a preview first, then **Apply rename** (see [Rename](#rename)). Set `refyntra.rename.apply` to off for preview-only renames.

Framework relations are found by Roslyn from verified symbol identity (owned-semantic). Each relation states its confidence: *proven*, or *likely* for framework extension registrations such as `AddDbContext` and for MediatR versions outside the verified range. Results also say what was not understood (dynamic or unknown parts). See [docs/capabilities/alpha.md](docs/capabilities/alpha.md).

## Getting started

1. Open a folder with a `.sln`, `.slnx` or `.csproj` and trust the workspace. The status bar shows **Refyntra: C# Ready**
   when the solution is loaded; click it for a menu of every Refyntra command.
2. Put the cursor on a class, interface or method in a C# file and run **Refyntra: Related** (editor context menu
   **Refyntra** › Related, or the Refyntra view in the activity bar). The view lists callers, implementations, tests,
   request handlers, endpoints, DI registrations and EF Core entities, tables and queries.
3. **Refyntra: Find** searches types, members, files and endpoints; narrow with `type:`, `member:`, `project:NAME`,
   `route:/path`, `method:GET`, `entity:` (EF Core entities), `table:NAME` (entities by mapped table).
4. **Refyntra: Actions** shows what is available at the cursor (and why not); **Refyntra: Rename** previews every change
   before **Apply**.
5. Shortcuts: the Visual Studio preset is on by default; set `refyntra.keybindings.preset` to `resharper` or `none` (**Refyntra: Keyboard Shortcuts Preset**).
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
- Not a compiler or general refactoring suite. Debugging uses bundled third-party debuggers (netcoredbg, debugpy) through VS Code's own debugging UI; Refyntra adds no debugger of its own.
- No automatic fixes, file generation or code transformations in the alpha.
- No promise of coverage for every C# project layout.

## Requirements

- Windows x64 (the only planned alpha target for C#; the platform packages for Linux and macOS carry the Python and Rust
  servers too), VS Code 1.90 or newer
- No other VS Code extension: Python (bundled Pyright) and Rust (bundled rust-analyzer) work on their own; Rust needs
  the Rust toolchain (`cargo`) for full results
- A .NET SDK 10.0.x installed on the machine (Refyntra does not download or bundle it); the C# host runs on .NET 10
- SDK-style C# projects targeting **net8.0, net9.0, net10.0, netstandard2.0 or netstandard2.1**, also multi-targeted
  (one project context per target framework). The targeting packs come from NuGet during restore; to **run** or
  **debug** a net8.0 / net9.0 app its runtime must be installed. A global.json that pins an older SDK (8.0 or newer) is
  honoured: the solution is loaded with that SDK's MSBuild, like `dotnet build`; a pinned SDK that is not installed is
  explained in Health (**Open global.json**)
- **Not supported or tested:** net6.0, net7.0 (out of support), .NET Framework and non-SDK-style projects
- Edit actions, postfix templates and Generate follow the project's C# version (C# 7.3 for netstandard2.0, 8 for
  netstandard2.1, 12 for net8.0, 13 for net9.0, 14 for net10.0, or its LangVersion): nothing newer is offered
- A **trusted** workspace (see below)

See the [support matrix](docs/support/matrix.md) for what was verified where (target frameworks: "Target frameworks and SDKs").

## Privacy and local processing

All analysis runs locally in child processes (the C# host, and the bundled Pyright and rust-analyzer). They are packaged with the extension; nothing is downloaded at run time. Refyntra has no telemetry, no account and makes no network requests for navigation. Your source code is not sent anywhere. Logs contain no source text.

## Workspace Trust

Loading a project evaluates MSBuild, which can run project code. Therefore:

- In **Restricted Mode** Refyntra does not load projects. It shows a message and what to do. It only reads the file system to find solutions and projects.
- In a **trusted** workspace Refyntra loads the selected solution. Trust is not a sandbox.
- Refyntra never runs `dotnet restore` or `dotnet build` on its own: building happens only when you start Run or Debug (see [Run and debug](#run-and-debug)). When packages are missing, the Health page offers **Restore packages** (and Related offers **Run dotnet restore**); only when you click it (and only in a trusted workspace) does Refyntra run `dotnet restore <solution>` as a task in the terminal panel. The path is passed to `dotnet` as a single argument without a shell, so nothing in a file name is interpreted.

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

### Renaming a DbContext or entity used by EF Core migrations

EF Core migrations, their `.Designer.cs` files and the model snapshot are generated by EF Core, but they reference your DbContext in code (`[DbContext(typeof(ShopDbContext))]`). When a rename touches them, the preview offers a choice (choosing the other option prepares a new preview):

- **Rename the class and update EF Core migrations** (the default): the migration files are listed in their own section, *EF Core migrations (generated by EF)*. Only the code references to the renamed class change there (for example `typeof(ShopDbContext)`), and only in files Refyntra proved to be EF Core migrations or model snapshots of a DbContext in this solution: EF Core's own `DbContextAttribute`, `MigrationAttribute` and `Migration`/`ModelSnapshot` base types, checked by full name and assembly. Each edit must rename an identifier that refers to the renamed symbol, otherwise the rename is refused. All other guarantees above still apply (read set, revalidation, compilation delta, Undo).
- **Rename only the class**: the migrations are not changed. They then still reference the old name, so **the project will not build until the migrations are updated**. The preview says so, the plan is *limited*, and applying asks for a second confirmation.

Strings in migrations are never changed: table names, and the old class name the model snapshot uses for an entity (`modelBuilder.Entity("Shop.Domain.Order", …)`). Migration and snapshot class names (`ShopDbContextModelSnapshot`) keep their names too; EF Core finds them through `[DbContext]`, not by name. EF Core accepts the old name in the snapshot, but the next migration you add may contain changes caused by it. Review that migration before you apply it to a database. The preview lists this as a limitation whenever the snapshot names the renamed type. Other generated code (`*.g.cs`, `*.designer.cs` that is not an EF migration, files with an `<auto-generated>` header, source generator output) is still refused.

### Renaming the file with the type

The option is offered only when every part of the type is in a file named after it, each such file contains nothing but that type (no other top-level type, no top-level statements), the type is not file-local or generated, and Refyntra can prove that the new name stays in exactly the same `Compile` items in every build of every project that contains the file: the SDK default `*.cs` glob is on (`EnableDefaultCompileItems`/`EnableDefaultItems` not changed), the file is inside the project folder (not linked) and not under `bin/` or `obj/`, the project file, the nearest `Directory.Build.props`/`.targets` and their literal imports have no `Compile` item with a pattern or naming either file (an explicitly listed file is refused in this version, because it would need a project file change) and do not change `DefaultItemExcludes` or the output folders. The new file must not exist (compared ignoring case), the old file must not be a symbolic link or read-only, and the new name must not be a reserved Windows name. A rename that changes only the letter case of the file (`Widget.cs` → `WIDGET.cs`) is refused: on case-insensitive file systems it would need a temporary name. In every refused case the rename is still offered as a text-only rename, with the reason in the preview.

Order and failure semantics:

1. After you confirm, the host revalidates the read set plus the file-rename guards (the target is still absent, the project files are unchanged, the proof still holds).
2. All text edits are applied in one edit (all or nothing for text), exactly as for a text-only rename.
3. Only when every edited file is confirmed, the file is renamed as a separate operation through VS Code (`WorkspaceEdit.renameFile`, never overwriting). VS Code moves open editors with it and keeps unsaved changes; the renamed file stays unsaved like the others.
4. Afterwards Refyntra checks that the new file exists with the previewed text and the old one is gone, and tells the host which documents moved (no reload of the projects).

If the file rename does not happen (for example another program created the target right after the text edits), the text edits stay applied: Refyntra says exactly that ("the text edits were applied … but the file rename did not complete …"), offers **Undo text edits**, and never rolls back on its own. If the result of the file rename cannot be confirmed, it is reported as unknown and the C# backend is restarted so that it reads the files again.

Residual risks: VS Code has no transaction across text edits and file operations, so a failure between the two steps leaves the text edits applied (reported, undoable). Another program can create or change the target in the very last moment before the rename; VS Code then refuses to overwrite and the outcome is reported. MSBuild items that come from NuGet packages, the SDK or computed imports are not inspected (computed imports make the plan *limited*, and then the file is not renamed). Undo of the rename itself is VS Code's file-operation Undo (for example in the Explorer), not Refyntra's.

## Move Type to File and Generate handler

Two refactorings create a new C# file. Both are offered in **Actions** (and as commands) only where they apply, show a
preview first (the new file as a diff from an empty file, plus the edits of existing files) and use the same safety
model as renaming a file: the host proves statically that the new file belongs to the same `Compile` items as an
existing file of the same folder (the same proof as [Renaming the file with the type](#renaming-the-file-with-the-type),
in every project that contains that file), the target must not exist (compared ignoring case), the plan carries a read
set and is revalidated after you confirm, and the result may not add a compiler error anywhere in the affected projects
(the new file included).

**Move Type to File** (`refyntra.moveTypeToFile`) — on the declaration of a top-level type in a file that has other
top-level types. The type moves into `<Type>.cs` in the same folder with the same namespace declarations (file-scoped or
block, nested block namespaces included), the comment banner at the top of the file, the comments and documentation
directly above the type, its attributes, and only the usings the moved code needs (namespace-level usings stay inside
the namespace). The original file loses the type and one surplus blank line; its usings are not changed. Refyntra checks
that every name in the moved code binds to exactly the same symbol in the new file as before, and refuses the move
otherwise. Not offered: nested types, a type alone in its file, a position that is not the declaration. Refused with the
reason: partial types (all parts would have to move consistently; not in this version), file-local types, generated
files, files with `#if`/`#define`/`#nullable`/`#pragma`/`#line` (and similar) directives, a type with directives inside
it, a type that shares a line with other code, a type that needs the rest of its file (for example a file-local helper).

**Generate handler** (`refyntra.generateHandler`, MediatR) — on a request type that implements MediatR's `IRequest<T>` or
`IRequest` (identity verified by assembly; MediatR 10–12) and has no handler in source. It creates `<Request>Handler.cs`
with a class implementing `IRequestHandler<TRequest, TResponse>` (or `IRequestHandler<TRequest>`) whose `Handle` throws
`NotImplementedException` — an honest placeholder. The folder defaults to the one where most handlers of the solution
live; **Change folder** in the preview lists the existing handler folders (most handlers first) and the request's own
folder, limited to projects that reference MediatR and can see the request. The namespace is the project's
`RootNamespace` plus the folders; the file uses file-scoped namespaces when the project does. **No DI registration is
generated**: MediatR finds handlers by scanning assemblies, and the preview says so. Not offered on a type that is not a
MediatR request. Unavailable with the reason: a generic (open) request, an existing handler, an unverified MediatR
version, an abstract or inaccessible request.

Order and failure semantics:

1. After you confirm, the host revalidates the read set, the absence of the target and the membership proof.
2. The new file is **created first**, on disk, with exactly the previewed text (`WorkspaceEdit.createFile`, never
   overwriting). A created file cannot stay unsaved.
3. Only when it exists with exactly that text are the target files checked again and the edit of the original file
   applied (Move Type to File), unsaved, as one text edit.
4. Refyntra reconciles each step, tells the host about the new file (no reload) and reports what happened.

Why the create comes first: it is the step that can fail for reasons outside the editor (the target appears, the folder
is not writable). When it fails, nothing has changed and the code still compiles. The edit that follows is checked
synchronously against the previewed text, so it rarely fails; if it does, the new file stays and the type exists twice
(the compiler reports a duplicate) — but no code is ever only in an Undo history. The other order could leave the type
removed from the original with no new file. Refyntra reports "created, but the edit … was not applied", offers to delete
the new file and never rolls back on its own.

**Undo** (offered after the apply) undoes the edit of the original file with the editor's Undo while it still has the
applied text, deletes the new file while it still has exactly the created text and no unsaved changes, and then reloads
the C# analysis. Anything that changed in between is left alone and reported.

Residual risks: no transaction across the file creation and the text edit (reported, undoable); another program can
write the target in the very last moment (VS Code refuses to overwrite; reported); MSBuild items from packages, the SDK
or computed imports are not inspected (computed imports refuse the action); between the create and a save of the
original file the type exists twice on disk, so a command-line build in that moment reports a duplicate.

## Safe Delete, Extract Method and Change Signature

All three are C# refactorings of the owned Roslyn route. Each one computes a plan on the snapshot without writing
anything, shows a preview (a summary, a diff per file, deleted files as a diff to empty), revalidates the whole read set
after you confirm, and applies through the same single EditApplier as Rename: edited files are not saved, the result is
checked per file, nothing is rolled back automatically, and **Undo** is offered. A change that would introduce a new
compiler error anywhere in the affected projects is refused. Uses the compiler cannot see (strings that may be
reflection names, `dynamic` calls) and framework relations make a plan *limited*: Apply then asks for an explicit
confirmation that lists them.

**Safe Delete** (`refyntra.safeDelete`, or Actions on the symbol) deletes a type, method, constructor, property, field,
event, local or parameter only when nothing else uses it. When uses remain, it refuses and names them (*Show usages*
opens Related). Deleting an interface member, or an abstract or virtual one, deletes its implementations and overrides
too (each must be unused); deleting an implementation or override alone is refused, because another member would run
instead. All partial declarations of a type go together. A file that holds nothing but the deleted type is deleted after
the edits, when it is included only by the SDK's default `*.cs` glob; otherwise the file is kept empty and the preview
says why. Deleting a parameter also removes its argument from every call, but only when those arguments cannot have
side effects. A MediatR handler, a DI registration or an endpoint found by Related is reported (the framework may use
the type at run time without any reference in code).

**Extract Method** (`refyntra.extractMethod`) moves the selected statements, or one selected expression, into a new
private method placed after the current member, and asks for its name. Roslyn's data-flow analysis decides the
parameters, the return value (one variable that is used afterwards, or the expression's value), `out`/`ref` parameters
(several such variables) and the locals the new method needs; a selection that always returns is returned from. The
method is `static` when the selection does not use the instance, `async` when it awaits, and generic when it uses type
parameters of the enclosing method. It refuses what it cannot extract without changing behavior: `break`, `continue` or
`goto` leaving the selection, a selection that returns on some paths only, `yield`, unsafe code, local functions, ref
locals, anonymous types, `out`/`ref` results of async code, assignment targets, constant contexts and expression trees.

**Change Signature** (`refyntra.changeSignature`) opens an editor for the parameter list of the method or constructor at
the cursor: move, rename, remove, or add a parameter with its type, the value existing calls pass, and an optional
default. The method changes together with everything it overrides or implements and every override or implementation;
every call Roslyn finds is rewritten (named arguments, omitted optional arguments, `params`, extension calls,
`base(...)`/`this(...)`, `new(...)`). When the new order would evaluate arguments with side effects in another order,
they keep their order as named arguments. After the change every rewritten call must still reach this method, and every
call of an overload with the same name the same overload as before; otherwise the change is refused. Uses as a method
group or delegate, attributes, partial or extern methods, primary constructors, names the compiler calls implicitly
(`Add`, `Dispose`, `GetEnumerator`, `Deconstruct`, …) and type changes are refused. Calls through reflection, `dynamic`
or from outside the loaded solution are not updated; found string or `dynamic` uses are listed as unknown callers.

## Code Cleanup

**Refyntra: Code Cleanup** (Command Palette, the status bar menu, or right-click a folder, `.cs` or `.csproj` file in the
Explorer) runs a small, explicit set of fixes over the current file, a folder, a project or the whole workspace, and
shows **one preview** for all files before anything changes. The fixes pre-selected come from
`refyntra.cleanup.profile`; each run lets you toggle them.

| Fix | What it does | When it acts |
|---|---|---|
| Remove unnecessary usings | Removes the usings the C# compiler reports as unnecessary (CS8019) in every project context of the file. The same result as VS Code's *Organize Imports*, but across many files with one preview | Always; global usings are never removed; a using needed only by a `<see cref>` stays |
| Sort usings | Only the order: global, then namespaces, `using static`, aliases; System first | `dotnet_sort_system_directives_first` (default true) from `.editorconfig`; groups separated by blank lines are sorted on their own |
| File-scoped namespace | `namespace N { … }` → `namespace N;`, body dedented one level | Only when `.editorconfig` sets `csharp_style_namespace_declarations = file_scoped`, the project compiles with C# 10 or later and the file has exactly one namespace and no code outside it |
| Trailing whitespace and final newline | Text only | Only what `.editorconfig` asks for: `trim_trailing_whitespace = true`, `insert_final_newline = true` (never inside a string or code disabled by `#if`). VS Code's `files.*` settings are not read |

**Guarantees.** Each change is kept only when Roslyn proves that the code means the same: for every loaded project
context of the file, every name, expression and type binds to the same symbol with the same type, every declaration
declares the same symbol, every literal (strings included) has the same value and no diagnostic appears (doc comments
are bound too). Every fix is idempotent: running Code Cleanup on its own result changes nothing. The plan goes through
the same pipeline as Rename: read set, revalidation after you confirm, one EditApplier, per-file reconciliation. Files
are edited in the editor and **never saved**; **Undo** (offered after the apply) restores every file that still has the
applied text.

**Skipped, with the reason in the preview:** generated files and build output, read-only files, files not saved as
UTF-8, files with mixed line endings, files over 512 KB, files of projects that are not completely loaded; usings and
namespaces of files that use `#if` (other build configurations cannot be checked); any change the semantic proof does
not accept. A scope of more than 2000 C# files is refused (choose a folder or a project).

**Not offered:** the IDE code-style fixes that `.editorconfig` can configure (IDExxxx, for example `var` preferences or
expression bodies). Their analyzers and code fixes live in Roslyn's IDE layers as internal types that are reachable only
through MEF; Refyntra uses public Roslyn APIs only. Use VS Code's code actions or `dotnet format` for these. Formatting is
not changed either (use Format Document).

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

## Python and Rust (bundled language servers)

Python (`.py`, `.pyi`) and Rust (`.rs`) work with **nothing but Refyntra installed**: no Python extension, no
rust-analyzer extension, no system Node.js. Refyntra ships the language servers and runs them as its own processes,
like its C# host. It never registers editor providers for them and never uses another extension's providers.

| | Python | Rust |
|---|---|---|
| Server | Pyright 1.1.414 (MIT), bundled in every package | rust-analyzer 2026-09-21 (MIT OR Apache-2.0), the official release binary for your platform, bundled in the platform package |
| Runs on | the Node.js runtime of VS Code itself (`ELECTRON_RUN_AS_NODE`) | the bundled binary from the extension folder (never one from `PATH`) |
| Also needs | nothing; for imports of installed packages: a Python environment (see below) | the Rust toolchain (`cargo`, from [rustup.rs](https://rustup.rs)) to load the Cargo project, like C# needs the .NET SDK |
| Starts | lazily, on the first Python file in a **trusted** workspace | lazily, on the first Rust file in a **trusted** workspace |

- **Restricted Mode**: no language server is started (rust-analyzer runs `cargo`, build scripts and proc-macros of the
  project; Pyright reads project configuration). Find, Related, Actions and Rename say *trust the workspace*.
- **Find** items are labelled `Python (delegated)` / `Rust (delegated)`; never a complete index. **Related** shows
  declarations, implementations (where the server offers them) and references; there are no framework relations for
  Python or Rust.
- **Rename**: the plan records the document versions the server computed it on (Refyntra owns the text the server
  sees for open files: it sends every open, change and close itself). Before the apply the same server session is
  asked again on the same versions and must return the identical edit on unchanged files. Validation is always
  *limited* (the semantics are the server's, no compilation check), so applying asks for an extra confirmation. A
  rename whose edit would create, rename or delete a file is refused in this version. The new name is checked first:
  Python identifiers (Unicode letters allowed, hard keywords refused); Rust identifiers and raw identifiers
  (`r#match`; a keyword needs `r#`), and a lifetime (`'a`) only for a lifetime.
- **Python environment**: Pyright analyses your code without any interpreter. For imports of installed packages it
  uses `python.defaultInterpreterPath` (if that file exists) or a `.venv`/`venv` folder with `pyvenv.cfg` in the
  workspace; without one, Pyright may look for `python` on `PATH` (trusted workspaces only). Third-party typeshed stubs
  are not bundled (standard-library stubs are), so packages without their own type information resolve only through
  the environment.
- **Rust without cargo**: Health says *Rust works partially: cargo (the Rust toolchain) was not found* with an
  **Install Rust** button (opens rustup.rs; Refyntra installs nothing). Without cargo rust-analyzer cannot load the
  Cargo project, so Rust Related, Rename and Find return no results for the files of that project until Rust is
  installed and the backend restarted.
- **Platforms**: rust-analyzer ships in the packages for Windows x64/arm64, Linux x64/arm64, Alpine x64 and macOS
  x64/arm64. On any other platform Health says *Rust is not available* (Python still works).
- **Python limits**: dynamic attribute access (`getattr`/`setattr`/`__getattr__`), names inside strings (such as
  `__all__` entries) and other runtime lookups are not covered; a rename that touches a module path in an `import`
  is refused (the module file may need to move).
- **Rust limits**: edits inside a `macro_rules!` definition are refused (Refyntra cannot check what the macro expands
  to); names used inside macro invocations are renamed only as far as rust-analyzer resolves the expansion; code
  disabled by `cfg` or Cargo features rust-analyzer does not analyse may keep the old name; a rename that touches a
  `mod name;` declaration is refused (the module file would be renamed).
- **Logs**: server log lines go to the Refyntra output channel at `debug` level with file paths replaced by `<path>`.

## Frontend ↔ backend (heuristic)

In a workspace with an ASP.NET Core backend and a TypeScript/JavaScript frontend, Refyntra links a client call to the
endpoint it calls. Every such link is **heuristic**: it comes from the literal URL text and the route template, never
from running anything, and it says so (confidence "heuristic", a "Heuristic" limitation, provenance `http.links`).

- **From a call** (cursor on the `fetch`/`axios` line, also inside the URL string): Related shows the endpoint under
  **Endpoints** ("Client call GET /api/Orders/{id:int}") and its action or Minimal API handler under **Handlers**.
- **From an endpoint** (an MVC action, a Minimal API handler method, or a controller): Related shows the group
  **Clients** with the call sites.
- **Find `client:`** lists the client calls that are not linked, with the reason (no matching route, another host,
  URL not resolvable, ambiguous); `client:all` lists every recognised call; text after `client:` filters by URL or file.

Recognised calls: `fetch(url[, { method }])` (also `window.`/`globalThis.`/`self.fetch`); `axios.get/post/put/delete/
patch/head/options(url)`, `axios(url[, { method }])`, `axios({ url, method })`, `axios.request({ url, method })`, and
instances made in the same file with `axios.create({ baseURL })`; Angular `HttpClient` (`this.http.get<T>(url)`, a
receiver named `http`, `httpClient` or `_http`) and AngularJS `$http.get(url)`/`$http({ url, method })`; `ky.get(url)`/
`ky(url[, { method }])`; `superagent.get(url)` (also a same-file default import of `axios`, `ky` or `superagent` under
another name). The URL may be a string literal, a template literal (each `${…}` is a route parameter), a `+`
concatenation of those with variables (`'/api' + '/orders/' + id`), or a `const` of the same file. Anything else
(a base URL from another file or from configuration, a URL built in a helper, a computed method) is not linked.

Matching: leading and trailing slashes are ignored, literal segments compare case-insensitively, `{id}`, `{id:int}`,
`{id?}`, `{id=1}` and `{*rest}` are route parameters (simple constraints such as `int`, `guid`, `bool` are checked
against literal client segments), a client parameter (`${id}`, `+ id`, `:id`) matches only a route parameter, query
strings are ignored, and the HTTP method must match when the call states it. Where several routes fit, the most
specific wins as in ASP.NET routing (a literal segment beats a parameter); routes that fit equally well are all shown,
marked "ambiguous". Routes marked dynamic are never matched. Absolute URLs (`https://host/...`) are linked only when
their origin is listed in `refyntra.http.origins`. By default only exact routes match; `refyntra.http.basePaths` names
prefixes that the client adds but the backend does not see (for example a dev proxy), tried only when the exact match
finds nothing.

The workspace scan reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` and `.cts` files once, when the Clients
group or `client:` is first needed, and then follows saves and file changes. It applies `files.exclude` and
`search.exclude`, skips `node_modules`, `bower_components`, `dist`, `build`, `out`, `bin`, `obj`, `coverage`, `.git` and
framework output folders, `.d.ts` and minified files, files over 512 KB and anything past 5000 files. Not modelled:
`.gitignore` itself, proxies, rewrites, API gateways, API versioning by header, OpenAPI-generated clients, GraphQL,
SignalR, and calls whose URL comes from another file.

## HTML and CSS (SCSS, LESS)

Refyntra links stylesheets to the HTML and code that use them. It parses `.css`, `.scss`, `.less`, `.html` and `.htm`
files with Microsoft's `vscode-css-languageservice` and `vscode-html-languageservice` (MIT), bundled inside Refyntra and
run in-process: no language server, no download, and no other extension (it works with every other extension
disabled, including VS Code's own CSS/HTML language features). TS/JS files are read with the same pattern scanner
approach as the HTTP links (nothing is evaluated).

- **From a use** (cursor on `styles.foo`, a class in `class="…"`/`className="…"`, an id, a `$variable`, an
  `@include`, an `@import`/`@use`/`<link href>`): Related shows the rule or definition under **Styles**.
- **From a rule** (cursor on `.foo` or `#main` in a stylesheet or a `<style>` block, on a variable or mixin
  definition): Related shows **Used by** with the uses in HTML, code and other stylesheets.
- **From a stylesheet** (cursor outside any selector): **Used by** lists the files that import or link it, and
  **Possibly unused** lists classes without a static use — information only, never a problem, and labelled "may be
  used dynamically".
- **Find `css:`** lists class and id selectors (`css:card` filters by name).

How sure each link is:

| Link | Confidence |
|---|---|
| CSS Modules: `import styles from './x.module.css'` (also `import * as`, `require`) and `styles.foo`, `styles?.foo`, `styles['foo']` ↔ `.foo` in that file | proven (the import path resolves to the file and the member is static) |
| SCSS/LESS variables, SCSS mixins ↔ their definition in the same file or a file reached through resolved `@use`/`@forward`/`@import` (`@use … as ns` namespaces respected) | proven; likely and "ambiguous" when several definitions are visible |
| `@import`/`@use`/`<link rel="stylesheet">`/`import './x.css'` ↔ the stylesheet | proven when the path resolves to a workspace file |
| Global classes: `class="a b"` (HTML, JSX), `className="…"`/`className={'…'}`, `el.className = '…'`, `classList.add/remove/toggle/contains/replace('a')`, `clsx`/`classnames`/`classNames`/`cx`/`cn`/`twMerge` string arguments and object keys, `querySelector('.a')`, Angular `[class.a]` ↔ `.a` rules | heuristic: first in the stylesheets linked from that page or component (`<link>`, `<style>`, `import './x.css'`, Angular `styleUrl(s)`), else in any global stylesheet of the workspace (with a limitation saying so); "ambiguous" when several files define it |
| Ids: `id="x"`, `getElementById('x')`, `querySelector('#x')` ↔ `#x` rules | heuristic |
| Template literals, `styles[name]`, expressions, `{{ }}`/`${ }` in attributes | unknown: never linked |

**Rename of CSS classes is not offered in this version.** Actions on a class shows "Rename CSS class: unavailable —
class names in strings can't be proven": class names are plain text in HTML, templates, string building and other
libraries, so no rename could prove that it found every use. A CSS Module class is reached only through the imported
object, but renaming it would mean editing TypeScript/JavaScript members (and any `styles[name]` access) from a
stylesheet; this version does not edit across languages, and Actions says so.

The workspace scan is bounded like the HTTP client scan: stylesheets and pages first, at most 5000 files of at most
512 KB, `files.exclude`/`search.exclude`, dependency and output folders and `*.min.css` skipped; then it follows edits,
saves and file changes. In Restricted Mode the links are not computed. Not modelled: `.sass` (indented syntax), Vue
and Svelte single-file components, CSS-in-JS, Tailwind `@apply`, `:global(...)` in CSS Modules, SCSS placeholder
selectors and `@extend`, LESS mixins, `node_modules` and `~` imports, bundler aliases, and stylesheets injected at run
time.

## React, Next.js and Angular

Refyntra understands React, Next.js and Angular with its own **web worker**: a separate process on VS Code's Node
runtime that runs the TypeScript compiler (TypeScript 6.0.3, Apache-2.0) and the Angular language service (22.2.1,
MIT), both bundled inside Refyntra. No other extension and no download; the project's own `tsconfig.json`/`jsconfig.json`
is used, project code is never run. It starts only in a trusted workspace with a `react`, `next` or `@angular/core`
dependency, on the first Related or Find that needs it (see [ADR-007](docs/adr/ADR-007-web-worker.md)).

- **React** (proven by the checker): a component's JSX usages and props, the props an attribute sets, the attributes
  that set a prop, custom hooks and their calls; context providers and consumers (likely). Required props a usage does
  not pass and props no usage passes are shown as information on the relation, never as problems.
- **Next.js** (conventions by Next.js version): the route of `page`/`layout`/`route` files in the app and pages
  routers (route groups, `[id]`, `[...slug]`, `[[...slug]]`, `@slot`, `(.)` interception, `pages/api`), route handler
  methods, `'use client'`/`'use server'` boundaries, and literal `<Link href>`/`router.push`/`redirect`/`fetch('/api/…')`
  paths linked to routes (heuristic). Middleware, rewrites, redirects, basePath and i18n are listed as limitations:
  Refyntra never claims a full routing graph.
- **Angular 17–22** (proven by the Angular language service): component ↔ template, template elements and bindings ↔
  components, inputs and outputs, selector usages across templates, DI (`providedIn`, `providers`, constructor and
  `inject()` injection), NgModule declarations/imports/exports, and route definitions (likely). Other majors are
  refused with a reason. Stylesheets of components are linked by the HTML/CSS support above.
- **Find**: `component:Name` (React and Angular components), `page:/path` (Next.js and Angular routes).

## Navigation

**Find (Search Everywhere).** Refyntra: Find (Ctrl+T in the ReSharper preset, Ctrl+, in the Visual Studio preset) is
one list with sections Types, Symbols, Files, Commands (Refyntra and every installed extension's contributed commands,
with their titles) and Settings (Refyntra settings). Matching understands camel humps (`OSvc` and `oSe` find
`OrderService`); results are ranked exact > prefix > camel hump > substring, and items you picked recently in this
workspace come first. Prefixes narrow the search: `#` symbols, `/` files, `>` commands, `@` settings. The filters
`type:`, `member:`, `project:`, `route:`, `method:`, `component:`, `page:`, `css:` keep the classic Find. Each keystroke
cancels the previous search; local ranking of 10,000 names takes well under 100 ms.

**Navigate To… (C#, Alt+`).** Refyntra: Navigate To… (Alt+` in the `visualStudio` and `resharper` presets; Ctrl+Alt+`
on macOS, where Option+` types a grave accent) lists every target of the symbol at the cursor **that exists**, each
with its count: Declaration (all partial parts), Implementations / Derived types / Implementations and overrides, Base
types or Base symbols (overridden members and implemented interface members), Usages (opens the Usages view below),
Related tests, Related files (other partial parts, and files with the same name next to the declaration:
`.Designer.cs`, `.g.cs`, `.razor`, `.razor.cs`, `.cshtml`, `.cshtml.cs`, `.xaml`, `.resx`), Containing type,
Containing file (when the declaration is in another file), MediatR handler, Endpoint, DI registration and Call
hierarchy. A target with one location opens directly; several open VS Code's peek view. The list is computed from
Related, the host's hierarchy (protocol 1.12 `bases` / `containing`) and incoming calls. Limits: a usage count above
50 comes from Related's own count; generated files under `obj/` are not listed as related files.

**Recent Files (Ctrl+E).** Refyntra: Recent Files is a list of the files you opened in this workspace, most recent
first, with the **current file second from the top** (like Rider), so Ctrl+E, Enter switches back to the previous file.
Each row has the file icon, the name, the folder relative to the workspace and **modified** when the editor has unsaved
changes; open editors that were never focused are listed after the recorded ones. Type to filter (name and folder);
the `×` button on a row removes it from the list (an open editor stays listed while it is open). At most 50 files are
kept per workspace (`workspaceState`, local only); renamed and deleted files follow.

**Recent Locations (Ctrl+Shift+E).** Refyntra: Recent Locations lists the places where the cursor **rested** (more than
1.5 s) or where you **edited**, in the sections *Edited* and *Visited* (the filter button in the title bar shows edited
locations only, and again all). Each row shows the file and line, the containing member (`OrderService.Find`, from the
document symbols of an open document; for C# without a C# extension and for closed files a text scan of the
declarations around the line) and the code line (for an edit: the edited line). One entry per line; an edited line
stays *edited* when you visit it again. When a document changes, the stored positions move with the text (lines
inserted or deleted above), and a location whose line was deleted is dropped. Type to filter (file, member, code); `×`
removes a row. At most 50 per workspace, local only. Only edits typed in the active editor count (a rename across
files does not add 50 edited locations); edits of a revert or an undo are recorded like other edits.

Keys: Ctrl+E and Ctrl+Shift+E in the `visualStudio` and `resharper` presets, not while the terminal has focus (the
shell keeps Ctrl+E). They replace VS Code's Ctrl+E (Quick Open, also on Ctrl+P) and Ctrl+Shift+E (Show Explorer; the
Activity Bar and **View: Show Explorer** remain) only while a preset is on; `none` binds neither. On macOS the keys
are **Cmd+Alt+E** and **Cmd+Alt+Shift+E**: Cmd+E is VS Code's "Use Selection for Find" and Cmd+Shift+E the Explorer
there, and both are kept.

**File Structure (Ctrl+F12).** Refyntra: File Structure lists the members of the current file, grouped by type
(nested types as their own groups, `Order.Line`) and, inside a type, by `#region` (a new group starts where the region
changes). Each row shows the codicon of its kind, a short signature (`Find(int) : OrderDto?`, `Total : decimal`) and
its kind and accessibility in words (`method · private static`). The member at the cursor is selected when the list
opens; type to filter by name with camel humps (`gOL` finds `GetOrderLines`), Enter jumps to the name. The title bar
buttons hide or show methods, properties, fields (with constants and enum members), events, nested types and
**inherited members** (C#: the members of the base classes, nearest first, or of the base interfaces of an interface;
without `object`'s, constructors and members the type overrides or redeclares; grouped "inherited from Entity<int>").
Inherited members with source in the solution open on Enter; members of referenced assemblies ("library: opens
decompiled") open their decompiled source (see *Go to metadata* below). The filters are kept per
workspace and the title says which are hidden. **Show in the Outline view** (the last button) opens VS Code's Outline.
`refyntra.fileStructure.preview` (off by default) shows the member in the editor while you move through the list; Esc
then returns to where the cursor was. For C# the list comes from the host (protocol 1.13 `code/fileStructure`; members
of this file only, other partial parts are not listed); other languages use VS Code's document symbols (no
accessibility, no inherited members; top-level functions form a group named after the file). Ctrl+F12 (Cmd+F12 on
macOS) in both presets replaces VS Code's Go to Implementations there (still in the editor context menu and in
Navigate To).

**Find Usages (grouped, C#).** Refyntra: Find Usages (Grouped) fills the **Refyntra Usages** view in the Refyntra side
bar (it appears with the first search). Every usage is classified by the C# host (protocol 1.12 `code/usages`): read,
write, read-write (compound assignment, `++`/`--`, `ref`), invocation, `nameof`, attribute, inheritance /
implementation, type argument, object creation, other; usages in test code (a project that references xUnit, NUnit or
MSTest, or a test method / class) form the group **In tests** when grouping by kind.

- Group by (view title `…` menu, or the Group By button): usage kind, project, folder, file, containing type,
  containing member; the levels always nest in that order. The choice is kept per workspace. Every group shows its
  count.
- Each usage shows its source line with the name highlighted, the file and line, and an icon for its kind.
- Filters: usage kinds (multi-select, with counts) and tests (all / only tests / exclude tests).
- **Next / Previous Usage** (F4 / Shift+F4, like Visual Studio's F8 / Rider's Ctrl+Alt+Down): only while the view has
  results, the focus is in a C# editor, the preset is not `none` and VS Code's reference peek is closed (there F4 keeps
  its own meaning). Both wrap around and select the usage in the view.
- **Export to Markdown** opens the shown tree (groupings and filters applied) as an untitled Markdown document.
- **Pin**: a pinned result stays; the next search opens a new tab-like root next to it (the active one is expanded).
  Close a tab with its `×`, or clear all.
- Large results: a cancellable progress notification; the host returns at most 1000 usages first, then **Show more**
  asks again for four times as many (up to 50000).

**Go to metadata / decompiled sources (C#).** A symbol without source in the solution (`string`, `IMediator`,
`Exception.StackTrace`) opens as a **read-only C# document** `refyntra-metadata:/<assembly>/<Namespace.Type>.cs`, like
Rider's and Visual Studio's metadata-as-source: the whole type with its members and XML documentation comments, the
caret on the symbol, C# highlighting, and a header naming the assembly, version, MVID and where the text comes from
(the status bar says *Decompiled* or *Embedded source*). The text is the **source file embedded in the assembly's
PDB** when the library ships one (the PDB inside the DLL or a matching `.pdb` next to it), otherwise it is
**decompiled** with ICSharpCode.Decompiler (ILSpy's engine, MIT, bundled in the C# host). Reference assemblies are
mapped to their implementation on this machine (`System.String` comes from `System.Private.CoreLib` of the installed
runtime; NuGet `ref/` from `lib/`). **Nothing is downloaded**: Source Link URLs and symbol servers are never used
(`refyntra.metadata.sourceLink`: `embeddedOnly`, the default, or `off` to always decompile; ADR-010).

- Where: **Refyntra: Go to Metadata / Decompiled Source** at the cursor (Command Palette, status bar menu), Navigate
  To (*Decompiled declaration* for a library symbol), Related and Find (library symbols), File Structure (inherited
  library members), the stack trace view (frames in framework or library code without source in the solution open
  the decompiled method) and Smart Step Into (a library call it cannot step into offers **Open Decompiled Source**).
  On a symbol with source in the solution the command opens that file.
- Inside a metadata document: **F12** (in both presets) goes on to the type or member at the cursor (another metadata
  document, or the solution file when it has source), **Shift+F12** runs Find Usages (the Usages view lists the
  usages **in the solution**), hover shows the symbol and its summary. The context menu has both commands. Refyntra
  still registers no Definition provider: VS Code's own F12 is unchanged everywhere else.
- Decompiled code is ILSpy's rendering (names of locals and some constructs differ from the original); internal
  helpers of the runtime that are not in the reference assemblies have no further navigation. The host caches one
  decompiler per assembly (by MVID) and the documents; a rebuilt library is decompiled again.

## Stack traces

**Refyntra: Open Stack Trace** reads a stack trace you paste and lists its frames in the **Refyntra Stack Trace** view,
grouped by exception (with the message; inner exceptions nested). Take the trace from the clipboard, the editor
selection, the terminal selection (also from the terminal's context menu) or a new editor to paste into; from the Debug
Console, copy it first and choose *Clipboard*. Log prefixes (timestamps, levels, ANSI colours) are ignored.

Recognised formats:

- **.NET**: `at Ns.Type.Method(Int32 id) in C:\src\File.cs:line 42` (Windows and Linux paths), frames without file
  information, async state machines (`<Method>d__5.MoveNext()`), lambdas (`<>c__DisplayClass…`, `<Method>b__0`), local
  functions (`<Method>g__Local|0_0`), generic types and methods (`` Repo`1.Get[T] ``), constructors (`..ctor`), inner
  exceptions (`--->`, `--- End of inner exception stack trace ---`), `--- End of stack trace from previous location ---`
  (shown as *after await*), Mono (`[0x0001c] in /path/File.cs:42`, `<filename unknown>`), Unity
  (`Type.Method () (at Assets/File.cs:42)`, `Type:Method (object)`), ASP.NET logs, and German/French-style localised
  `at`/`line` words when the file part is present.
- **JavaScript/TypeScript**: V8 (`at fn (file:line:col)`, `at async fn`, `at new C`, `file://` and `webpack://` paths)
  and Firefox/Safari (`fn@file:line:col`).
- **Python**: `File "x.py", line N, in fn` tracebacks, including chained exceptions.
- **Rust**: panics (`thread 'main' panicked at src/main.rs:10:5:`, and the older `'msg', file:line:col` form) and
  `RUST_BACKTRACE` backtraces (`N: crate::fn` + `at file:line:col`).

Each frame says in words whether it is **your code**, **external** (System.*, Microsoft.*, node_modules, site-packages,
std::…; runs of external frames are collapsed), matches **several files**, will be found **by symbol**, or its **file
is not in the workspace**. Click a frame (or press Enter) to open it; the **Related** button of a frame opens it and
shows Related there.

- **Files**: the printed path is used when it exists; otherwise it is matched to workspace files by the longest path
  suffix (`D:\agent\_work\1\s\src\App\Orders.cs` → `src/App/Orders.cs`). `\` and `/` are equal; Windows and macOS
  compare case-insensitively, Linux case-sensitively. When several files match equally, you choose.
- **Line may have moved**: when the frame's line is past the end of the file, Refyntra says so (it compares with the
  file's current line count only; there is no history lookup) and, for .NET, finds the method by symbol instead.
- **By symbol (.NET)**: a frame without a usable file is looked up in the loaded solution by type, method, generic
  arity and parameter types. **Proven** = exact metadata type name and parameter types of one overload; **likely** =
  matched by name (async, lambda and local-function frames do not show the user method's parameters). Several
  candidates are offered in a list with the reason.

Limits: this is navigation, not debugging. Nothing is executed and nothing is sent anywhere. A symbol that is not in
the loaded code (removed, renamed, generated or from a package) is reported as not found; Refyntra does not recover
it, and does not use PDBs, source link or decompilation. Symbol lookup needs the C# backend (trusted workspace,
solution loaded); JavaScript/TypeScript, Python and Rust frames are opened by file path only. Lambdas open at their
enclosing method, not the lambda itself.

## Task context

The **Refyntra Task Context** view (in the Refyntra side bar) keeps what you need for the task at hand: symbols
(C#, TypeScript/JavaScript, Python, Rust), files, endpoints and **pinned relations** (subject + relation + target).
Keep several named contexts per workspace (New, Rename, Delete, Switch in the view's title bar); one is active and its
name is shown next to the view title.

- **Add**: *Add Symbol at Cursor* (view title, or the Refyntra editor menu), *Add File* (Explorer, editor menu), the
  **+** button of a Find result, or *Add to Task Context* on a Related item (pins the relation) or in the Related title
  bar (adds the subject). Each item can have a note.
- **Use**: open an item, *Show Related* for it, reorder with drag and drop or *Move Up* / *Move Down* (context menu,
  Command Palette), remove it, *Copy as Markdown* (names, relative paths and notes only; no source code), *Export* to
  and *Import* from a JSON file you choose, *Clear*.

**Found again after changes.** Refyntra does not store symbol ids. It stores a description of each item: the language
route, kind, name, container and fully qualified name, the file relative to the workspace folder, the last line and a
short hash of that line (not the line itself), and when it was added. When the view opens, after edits (debounced),
when a backend restarts and before an item is opened, each item is resolved again:

1. the stored line still has the same hash → **resolved**;
2. the language support is still loading or the workspace is in Restricted Mode → **not checked yet** (never marked
   missing meanwhile);
3. Find on the same route finds exactly one symbol with the same name, kind and container → **moved** (the stored
   place is updated); several → **ambiguous**;
4. the symbol at the stored line has the same kind and container and the line differs only by the name, with the file's
   line count unchanged (what a rename does) → **resolved** under the new name; otherwise you confirm it (**ambiguous**);
5. only symbols with the same name but another kind or container → **ambiguous**: you choose (*Choose Symbol*); Refyntra
   never silently points an item at a different symbol;
6. nothing → **missing**: the item is kept, greyed, with the reason.

Files follow renames and moves VS Code reports; endpoints are found again by HTTP method and route.

**Privacy and limits.** Task contexts live in VS Code's workspace storage on this machine: never synced, never sent,
no telemetry. Workspace files are stored relative to their folder. Limits: 50 contexts, 500 items per context, 2,000
characters per note, about 1 MB in total; imports up to 2 MB. A rename outside Refyntra that also changes other lines
of the file is not proven, so the item becomes ambiguous or missing instead of following it.

## In VS Code's own places

Refyntra plugs into the editor's built-in UI wherever VS Code has a place for it; every entry runs the same Refyntra
command and the same pipeline (plan → preview → revalidate → one EditApplier). Nothing depends on another extension.

- **Lightbulb, Ctrl+. and Refactor… / Source Action…** (C#; Rename also for TS/JS, Python and Rust): code actions with
  proper kinds — `refactor.extract.method` (Extract Method), `refactor.rewrite.signature` (Change Signature),
  `refactor.move.typeToFile` (Move Type to File), `refactor.rewrite.safeDelete` (Safe Delete), `refactor.rewrite.rename`
  (Rename with preview), `refactor.rewrite.generateHandler` (MediatR) and `source.refyntra.cleanup` (Code Cleanup of the
  file). The automatic lightbulb never asks the backend: it only offers Extract Method for a selection that passes a
  cheap text check (balanced brackets, complete statements or one expression, no declaration). Ctrl+. and the Refactor
  menu ask the C# route which actions apply at the cursor (cached briefly per document version); actions that do not
  apply are listed greyed out with the reason.
- **Editor context menu → Refyntra**: one submenu grouped *Navigate* (Related, Find, Find Handler / Endpoint / DI
  Registration), *Refactor* (Rename, Extract Method, Change Signature, Move Type to File, Safe Delete, Generate
  Handler, Code Cleanup) and *Context* (add to the task context, Actions). C#-only entries appear only in C# files.
- **Refactor Preview**: text-only plans (Rename, Extract Method, Change Signature, Safe Delete of members, Code Cleanup)
  open in VS Code's Refactor Preview panel, grouped per file and labelled with the plan and its open points; apply or
  discard there. Refyntra revalidates the plan **before** the panel opens and checks every file's text again right
  before handing the edit over; while the panel is open VS Code refuses to apply if one of the files changes; afterwards
  every file is checked against the planned result and reported (a discarded panel changes nothing, unchecked files are
  named). Plans that create, rename or delete files keep the QuickPick preview. `refyntra.preview.style: "quickPick"`
  uses the QuickPick for everything. Details: ADR-004 Amendment 6.
- **CodeLens** above C# types and methods: "N references · N implementations · N tests", MediatR requests
  "→ Handler: X" and handlers "← sent from N places", endpoints "GET /api/orders/{id} · N frontend calls", EF Core
  "→ configuration · N migrations". A click opens VS Code's peek view (or Related). Lenses are resolved lazily (only
  visible ones, one Related request per declaration and document version, cancelled with the request); the text scan
  that places them takes about 1 ms per 1,000 lines (9 ms for 20,000 lines measured), so typing is not slowed.
  `refyntra.codeLens.enabled` and one switch per kind.
- **Call Hierarchy and Type Hierarchy** (Shift+Alt+H, *Peek Call Hierarchy*, *Show Type Hierarchy*) for C#, answered by
  Refyntra's own Roslyn host (protocol 1.7): incoming and outgoing calls with their call sites, supertypes and
  subtypes. Only code declared in the solution is listed (a library method has no file to open).
- **Hover** on a MediatR request: "handled by X" with a link that opens the handler (`refyntra.hover.mediatr`).
- **Change Signature dialog**: a parameter table (drag, the ↑/↓ buttons or Alt+Up/Down to reorder; name, type, value
  at call sites and default for new parameters), a live preview of the new signature, the number of affected call sites
  and validation messages; then the normal preview. `refyntra.changeSignature.editor: "quickPick"` keeps the step-by-step
  QuickPick.
- **Status bar**: one item with the state — a spinner and progress while the solution loads (also as window progress),
  a check when ready, a warning on a problem. A click opens a menu that leads with what helps now (on a problem: Health,
  Restart, Select Solution).
- **Related view**: an icon per relation kind (handler, endpoint, test, DI, EF Core, HTTP client, implementation,
  reference), groups with their counts, the file and line in the description, the code line in the tooltip, and a header
  line naming the symbol shown and whether the view is pinned. **Stack trace**: opening a frame highlights its line
  briefly; frames of your own code have a coloured stack-frame icon, external frames a library icon.

## Run and debug

Refyntra runs and debugs projects without other extensions ([ADR-008](docs/adr/ADR-008-run-and-debug.md)). Building
and running execute code from the workspace, so all of this works only in a **trusted** workspace; in Restricted Mode
the Run view, Run, Debug and Generate launch.json explain why nothing starts.

| Language | Run (no debugger) | Debug |
|---|---|---|
| .NET console, web, worker apps | `dotnet run --project … [-f …] [--launch-profile …]` in a terminal; **Run with Hot Reload** = `dotnet watch run` | Bundled **netcoredbg** 3.2.0 (MIT, Samsung): build with `dotnet build`, then breakpoints, stepping, locals, watch expressions, exception breakpoints (`all`, `user-unhandled`), attach to a process. Not on win32-arm64, macOS Intel and Alpine (no official build): Run still works there |
| Windows Forms, WPF | Windows only | Windows only (netcoredbg) |
| Test projects | In VS Code's Test Explorer (see [Tests](#tests-test-explorer)) | Debug a test from the Test Explorer or its CodeLens |
| .NET MAUI, Blazor WebAssembly | Not supported (listed with the reason) | — |
| Python | `python <file>` with your interpreter (`python.defaultInterpreterPath`, a `.venv`/`venv`, or `python3`/`python` on PATH) | Bundled **debugpy** 1.8.22 (MIT), pure-Python parts; launch, `connect` attach. Attaching to a process id is not supported |
| Rust | `cargo run --bin …` | Only with **lldb-dap** from an installed LLVM (detected, not bundled: CodeLLDB would add 45–56 MB per package) |
| package.json scripts | `npm`/`pnpm`/`yarn run <script>` (package manager from the lock file) | VS Code's built-in JavaScript debugger: `node` launch of the script, and `msedge`/`chrome` on the dev-server URL (Vite, Next.js, CRA, Angular) |

Where you find it:

- **Refyntra Run view** (Refyntra side bar): runnable projects by language with Run, Debug, Stop and Restart; web
  projects list their `launchSettings.json` profiles. Projects that cannot run are listed with the reason.
- **Status bar**: the selected run target (`▷ WebApp · http · net10.0`). Click it to choose the project, then its launch
  profile, target framework (multi-targeting) and Debug/Release.
- **CodeLens** `Run | Debug` above `Main` or the first top-level statement of `Program.cs`, Python's
  `if __name__ == "__main__":` and Rust's `fn main()`; **Run** and **Debug** buttons in the editor title.
- **VS Code's own F5 and Ctrl+F5 are not changed.** With a `launch.json`, they run it as always. Without one, VS Code
  asks Refyntra's debugger for the language of the active editor, and Refyntra starts the selected run target (Ctrl+F5
  runs it in a terminal). Every runnable target also appears as a **dynamic configuration** in VS Code's Run and Debug
  view and debug dropdown (*Refyntra .NET*, *Refyntra Python*, Node). **Refyntra: Generate launch.json** writes them to
  `.vscode/launch.json` (existing entries are kept).
- **Web apps**: the launch profile's `applicationUrl`, `environmentVariables` and `commandLineArgs` are used; with
  `launchBrowser` the browser opens on the URL the app prints in `Now listening on:` (also while debugging).
- **Health** has a *Run and debug* section: the bundled netcoredbg and debugpy versions, the Python interpreter, cargo,
  whether lldb-dap was found, and which .NET debugger features work (and which netcoredbg cannot do).

Debug configuration (`"type": "refyntra-dotnet"`): `project` (built first unless `"build": false`), `framework`,
`configuration`, `program`, `args`, `cwd`, `env`, `stopAtEntry`, `justMyCode` (default on), `console`, `launchBrowser`;
attach: `processId` (`${command:refyntra.pickDotnetProcess}` shows a process picker). Limits: netcoredbg writes program
output to the Debug Console (`console: integratedTerminal` behaves like `internalConsole`), so a program cannot read
from stdin while it is debugged; use Run for that. `"type": "refyntra-python"`: `program` or `module`, `python`, `args`,
`cwd`, `env`, `console` (`integratedTerminal` by default), `justMyCode`, `stopOnEntry`; attach: `connect`.

## Tests (Test Explorer)

Refyntra runs tests in VS Code's own **Testing** view (Test Explorer, gutter icons, Test Results, Rerun Failed,
Continuous Run), with no other extension ([ADR-009](docs/adr/ADR-009-test-runner.md)). Trusted workspaces only.

| Language | Discovery | Run | Debug |
|---|---|---|---|
| C# (xUnit, NUnit, MSTest on VSTest) | The C# host: project → namespace → class → nested class → method → data rows (`[InlineData]`, `[TestCase]`, `[DataRow]`) with exact locations; updated as you type (only the edited file is re-read) | `dotnet test <project> --filter …` (one build per project and run); results from a TRX file: pass/fail/skip per test and data row, duration, message, stack trace, output | Build, then `dotnet test --no-build` with `VSTEST_HOST_DEBUG`; the bundled netcoredbg attaches to the test host. Breakpoints in tests and in the code under test hit |
| Python | `python -m pytest --collect-only` with your interpreter, **only when pytest is installed** (Health says so otherwise) | pytest with a JUnit XML report | pytest under the bundled debugpy |
| Rust | `cargo test -- --list` when cargo is installed | `cargo test` | Not supported (no bundled Rust debugger) |

- **Data rows**: rows written in source appear before the first run; rows computed at run time (`[MemberData]`,
  `[TestCaseSource]`, `[DynamicData]`) appear under their method after a run. Running one row runs its method
  (test adapters cannot select a single row); every row reports its own result.
- **Failures** open at the failing line (the first stack frame in the test file, else the first frame in your code);
  "Expected / Actual" messages show VS Code's diff.
- **CodeLens** `Run | Debug` above C# test classes and methods, with the last result (`refyntra.tests.codeLens`).
- **Run Tests for This Code** (editor context menu → Refyntra, Command Palette): in a test, runs it; on production code,
  runs the tests that reference the symbol (the Tests group of Related; a reference is not coverage).
- **Continuous Run** (the eye button of the Run profile): saving a file runs the test classes in it, or the chosen tests
  after a change elsewhere.
- Python and Rust tests are discovered when the Test Explorer opens (or on Refresh): discovery imports or compiles
  project code.
- **Coverage** (the Coverage profile, VS Code's coverage view and editor highlights): line coverage for .NET test
  projects that already reference **coverlet.collector**; otherwise the tests run without coverage and Refyntra says why
  (it never adds packages to your projects).
- Limits: Microsoft Testing Platform-only projects (no VSTest adapter) and tests in abstract or generic classes are not
  listed; xUnit v2 does not capture `Console` output per test; Rust tests have no source location; coverage is line
  coverage of .NET only.

### While debugging C# (inline values, hover, Immediate Window)

- **Inline values** (like Rider): while a `refyntra-dotnet` session is stopped, the names declared, assigned or used on
  the lines of the stopped method (parameters, locals, `foreach` and `out var` variables, assigned fields, `this.X`)
  show `name = value` after the line, up to the stopped line and only in the visible part of the editor; top-level
  `Program.cs` statements too. A fast syntax pass picks the names (no host request); the values come from netcoredbg's
  `evaluate` in the `watch` context, shortened to 60 characters. Only names and member access are evaluated, never a
  method call; netcoredbg may still run **property getters** for `this.X` (as the Watch view does). Names inside
  string interpolations are not read. Turn it off with `refyntra.debug.inlineValues`; VS Code shows provider values when
  `debug.inlineValues` is `auto` (default) or `on`.
- **Hover** over `order.Customer.Address` evaluates the whole member chain up to the hovered member (not just the word);
  over a call (`Get(x)`, `.Find(`) nothing is evaluated.
- **Refyntra: Show Immediate Window** (Ctrl+Alt+I in the `visualStudio` preset while debugging) opens the
  *Refyntra Immediate* panel bound to the selected stack frame (Call Stack selection) of the active `refyntra-dotnet`
  or `refyntra-python` session. Enter evaluates (DAP `evaluate`, context `repl`), Shift+Enter adds a line (lines are
  joined into one expression), Up/Down recall the history, Ctrl+Space or `.` asks the debugger for completions (DAP
  `completions`, when the debugger supports them; netcoredbg does not, so C# shows none). Here **assignments and method
  calls are allowed** (`count = 5`, `list.Clear()`): you typed them. Results are trees (expand loads the members), each
  with **Copy** and **Watch** (adds it to VS Code's Watch view); **Clear** in the panel title.

### Debugger extras for C# (netcoredbg)

What the bundled netcoredbg 3.2.0 can do was measured (its DAP capabilities and a probe of each request, table in
[ADR-008](docs/adr/ADR-008-run-and-debug.md#decision)); Refyntra offers only what really works:

| Feature | With `refyntra-dotnet` | Keys (preset) |
|---|---|---|
| **Smart Step Into** — choose which call of the stopped line to step into | **Refyntra: Smart Step Into**: the C# host lists the calls of the stopped statement in the order they run; pick one and the program stops at the first statement of that method. Calls without source (framework, NuGet packages), abstract/interface calls and delegates are listed with the reason and refused. If the chosen call is not made (`a && Check()`), it stops at the next statement and says so. Works with temporary breakpoints, so another breakpoint reached first stops there | Alt+Shift+F11 (`visualStudio`), Shift+F7 (`resharper`) |
| **Run to Cursor** | VS Code's own command (editor context menu while stopped) | Ctrl+F10 (`visualStudio`, C# editors) |
| **Conditional breakpoints** | VS Code's *Edit Condition* (`i == 2`), evaluated by netcoredbg | — |
| **Function breakpoints** | VS Code's *+* in the Breakpoints view | — |
| **Break on exception types** | **Refyntra: Break on Exception Types…**: pick `System.InvalidOperationException` and others (or type full names); stored in `refyntra.debug.dotnet.breakOnExceptionTypes`. netcoredbg matches the exact type (no base types, no wildcards). The `all` and `user-unhandled` checkboxes in the Breakpoints view still apply; with `all` ticked every exception breaks | — |
| **Set Next Statement / Jump to Cursor** | **Not available**: netcoredbg does not implement `gotoTargets`/`goto`, so VS Code does not offer Jump to Cursor | — |
| **Hit counts, logpoints** | **Not available**: netcoredbg ignores them and stops like at a plain breakpoint; Refyntra warns when you add one to a C# file. Use a condition instead | — |
| **Restart Frame, data breakpoints** | Not available in netcoredbg | — |

Completion of variable names inside the breakpoint condition editor is not possible: VS Code gives extensions no hook
into that input.

### Constructor and DI helpers (C#)

Ctrl+. (or the lightbulb) offers, depending on the cursor:

| Cursor | Actions |
|---|---|
| Constructor parameter `public A(B b)` | **Create and initialize field '_b'** (`private readonly B _b;` next to the other fields + `_b = b;`), **Create and initialize property 'B'** (get-only), **Initialize field '_x'** when an unassigned field of type `B` exists, **Initialize all unassigned parameters from constructor**, **Register 'B' in DI…** |
| Primary constructor parameter `class A(B b)` | **Create field '_b' from primary constructor parameter** (`private readonly B _b = b;`), property |
| Unassigned `private readonly B _b;` | **Initialize '_b' from constructor** (adds `B b` and `_b = b;`, creates the constructor if there is none), **Initialize all readonly fields from constructor** |
| Undeclared `_repo` in `_repo.Get(id)` | **Create field '_repo' and inject via constructor**: the type is inferred for well-known names (`_logger` → `ILogger<A>`, `_mediator`, `_configuration`, …) or chosen from the solution's types (interfaces first, typed text accepted); then offers the DI registration when the type is not registered |
| Class name | **Generate constructor…** (multi-select picker; readonly, not initialised members preselected), **Add parameters to constructor…** |

The C# host computes every one of them with Roslyn (protocol 1.11): types are semantic (written fully qualified, then
the needed `using` is added and the name simplified, generic types included), every part of a **partial class** counts
(a field declared in one file is initialised in the constructor of another), and the result is **refused when a changed
file would get a compiler error** it did not have. Naming follows the `.editorconfig` naming rules for private instance
fields (`dotnet_naming_rule` → `required_prefix`, `capitalization`; `this.` only where needed or required by
`dotnet_style_qualification_for_field`), else the type's (or file's) existing private fields (`_camel`, `m_camel`, or
`camel` with `this.`), else `_camelCase`. An unused constructor parameter of the same type is reused instead of adding
one. **Create field and inject** infers the type from the name (`_logger` → `ILogger<A>` when
Microsoft.Extensions.Logging is referenced, `_mediator`, `_configuration`, …), an assignment, or the members used on
it (`_audit.Record("x", id)` → the only solution interface with `Record`, else the only type); otherwise it asks
(solution types, interfaces first, a typed name is resolved and imported). Results that touch only documents of the
cursor's type are applied directly as one editor change (one **Undo**) while every document is unchanged. Adding
parameters to an **existing** constructor is refused when it is called (`new`, `: this(...)`/`: base(...)`, or an
implicit base call of a parameterless one): use Change Signature, which updates the calls; classes created by the DI
container need no call-site change. A class with a primary constructor gets the new parameter there and the member an
`= parameter` initializer (only in the part that declares the primary constructor); positional record parameters get
no actions (they already are properties).
**Register in DI** uses Refyntra's DI relations: an already registered service is refused, an interface is paired with
its only source implementation (several: you choose), you pick the lifetime (Scoped/Transient/Singleton), and the
composition roots are those the DI analysis found (top-level `builder.Services`, `this IServiceCollection` extension
methods, `ConfigureServices`, any method with unconditional registrations). Several roots: you choose; none: nothing
is changed and the message says so. The registration (`AddScoped<IB, B>()` after the root's last registration, usings
added) is a plan in another file, so it goes through the preview (Refactor Preview with `refyntra.preview.style`
`native`), is revalidated before it is applied and can be undone.

### Rider-style edit actions (C#)

Ctrl+. (or the Refactor… menu) asks the C# host which of these apply at the cursor; with a selection the lightbulb
offers Introduce Variable too. The host computes every result with Roslyn (syntax rewrite, formatting of the changed
nodes with the document's `.editorconfig` options) and **refuses it when the file would get a compiler error it did
not have**. The result touches only the current document, so it is applied as one editor change (one **Undo**), and
only while the document is still the version the action was computed for.

| Action | Code action kind | Applies to | Refused / not offered when |
|---|---|---|---|
| Convert to block body / expression body | `refactor.rewrite.refyntra.blockBody` / `.expressionBody` | methods, local functions, operators, constructors, accessors, get-only properties and indexers | ref returns; a block with more than one statement or with comments |
| Use explicit type / Use `var` | `refactor.rewrite.refyntra.explicitType` / `.var` | locals with one variable, `foreach` | anonymous types; `var` would change the type (`long x = 1;`), target-typed or `null` initializers |
| Invert `if` | `refactor.rewrite.refyntra.invertIf` | `if` with an `else` | `else if` chains; `<`/`>` flip only for integral operands (NaN and lifted nullables are negated with `!`) |
| Convert `if` ↔ conditional expression | `refactor.rewrite.refyntra.ifToConditional` / `.conditionalToIf` | `return c ? a : b;`, `x = c ? a : b;` | branches of different types (the conditional would convert one) |
| Merge nested `if` / Split `if` at `&&` | `refactor.rewrite.refyntra.mergeIf` / `.splitIf` | `if` without `else` | comments between the two `if`s |
| Convert to interpolated string | `refactor.rewrite.refyntra.interpolatedString` | string `+` chains with a plain string literal | verbatim/raw literals; constant contexts |
| Convert `if` → `switch` statement / expression | `refactor.rewrite.refyntra.ifToSwitch` / `.ifToSwitchExpression` | an `if`/`else if` chain (at least two conditions) testing the same variable, field or property with `==` constants, `is` patterns or `\|\|` of those; the expression form when every branch returns or assigns the same target (a `return` right after the chain becomes the `_` arm) | different subjects, calls in the subject, user-defined `==`, `break` of an outer loop inside a branch, branches that do anything else (expression form) |
| Convert `switch` statement ↔ expression | `refactor.rewrite.refyntra.switchToExpression` / `.switchToStatement` | sections that each `return`, `throw` or assign the same target (then `break`); `case … when`; back from `return x switch {…}`, `t = x switch {…};` and expression-bodied methods | sections with several statements, a `switch` expression without a `_` arm (it would no longer throw on no match) |
| Convert `foreach` ↔ LINQ | `refactor.rewrite.refyntra.foreachToLinq` / `.linqToForeach` | `if (c) list.Add(x)` → `Where`/`Select`/`ToList()` (or `AddRange`), early `return true`/`false` → `Any`/`All`, `return item` → `FirstOrDefault`, `n++` → `Count`, `sum += x` → `Sum` (a `= 0` / `new List<T>()` declaration right before becomes the query); `using System.Linq;` is added when missing. Back for the same shapes (`return` of `Any`/`All`/`FirstOrDefault`, locals of `Count`/`Sum`/`ToList`) | several statements, `break`/`continue`, `await`, ref locals, assignments or increments in the condition, explicit loop types that convert, other LINQ operators. Note: `Sum` is checked arithmetic where the loop wrapped |
| Convert interpolated string ↔ `string.Format` | `refactor.rewrite.refyntra.stringFormat` / `.formatToInterpolated` | regular and verbatim strings; alignment and format specifiers (`{x,5:D3}`) are kept | raw strings, `FormattableString`/handler targets, constants; `string.Format` with an `IFormatProvider`, an array argument, named arguments or arguments with side effects that are not used exactly once in order |
| Convert to primary constructor / back | `refactor.rewrite.refyntra.primaryConstructor` / `.explicitConstructor` | C# 12+: a constructor that only assigns parameters to fields / auto-properties (they get `= p` initializers; `: base(…)` moves to the base list); back: an explicit constructor, captured parameters become `private readonly _p` fields, initializers that use parameters move into it | other constructors not chaining `: this(…)`, other statements, `ref`/`out`/`in` parameters, parameter names equal to member names, comments or attributes on the constructor, partial types |
| Convert class ↔ record | `refactor.rewrite.refyntra.classToRecord` / `.recordToClass` | a class without a base class whose state cannot change after construction; back: a non-positional `record` (class) | custom `Equals`/`GetHashCode`/`==`, mutable fields or setters (value equality would change with them), base classes, derived types; back: `with` expressions, value comparisons (`==`, `Equals`) or deconstruction in the document, base records. Note: a record also prints its members in `ToString()` |
| Convert auto-property ↔ property with backing field | `refactor.rewrite.refyntra.fullProperty` / `.autoProperty` | `_name` field (`readonly` without a setter; constructor assignments of a get-only property go to the field); back: `get`/`set`/`init` that only read and write a private field of the same type, other uses of the field become the property | name clashes, `field:` attributes; back: the field passed by `ref`, written outside a constructor without a setter, attributes or comments on the field, partial types |
| Use object initializer / split it | `refactor.rewrite.refyntra.objectInitializer` / `.splitObjectInitializer` | `var x = new T(); x.A = 1; x.B = 2;` (consecutive member assignments that do not read `x`) and back into assignments | values that read the variable, indexers, nested initializers, collection initializers |
| Convert `using` statement ↔ declaration | `refactor.rewrite.refyntra.usingDeclaration` / `.usingStatement` | a `using (var x = …)` (also nested) that is the last statement of its block; back: the rest of the block goes into the `using` body | statements after the `using` statement (disposal would move), the expression form `using (expr)`, labels in the rest |
| Make method async / Remove `async` and `await` | `refactor.rewrite.refyntra.makeAsync` / `.removeAsync` | `T` → `async Task<T>`, `void` → `async Task`, a non-async `Task`/`ValueTask` method gets `async` and awaits its returns (only the method changes, not its callers; `using System.Threading.Tasks;` is added when missing); remove: a single `await` as the final `return await e;` / `await e;` / `=> await e` of the same task type | overrides and interface implementations, `ref`/`out`/`in` parameters, iterators; remove: other awaits or returns, `try`/`using`/`lock` around the await, a different awaited type |
| Inline Variable | `refactor.inline.refyntra.variable` | a local with one initializer | the variable is written; an initializer with side effects used more than once, not in the next statement, conditionally, or after other side effects; comments on the declaration |
| Inline Method (this call site / all call sites) | `refactor.inline.refyntra.methodCall` / `.method` | a call or the declaration of a non-virtual method with an expression body or a single `return` (void: a single statement); arguments with side effects or used more than once go into temporaries | recursion, `ref`/`out`/`in`/`params` parameters, several statements or returns, virtual/abstract/override/interface members, generic/async/extension methods, method-group or delegate use (*all*), calls on another object, default arguments, names that would mean something else at the call site |
| Inline Field / Constant | `refactor.inline.refyntra.field` | a `const`, or a `readonly` field whose initializer is side-effect free and made of constants; every read is replaced and the declaration removed | assignments outside the initializer, other initializers, reads on another object, `nameof` |
| Inline Parameter | `refactor.inline.refyntra.parameter` | a parameter for which every caller passes the same side-effect-free value (constants, static readonly members); removed from the declaration and all calls | different values, caller locals or instance members in the value, method-group use, virtual/interface members |
| Introduce Variable (this / all occurrences) | `refactor.extract.refyntra.variable` / `.variableAll` | a selected expression in a statement of a block | conditional or repeated evaluation (`&&`, `?:`, lambdas, loop heads), `ref`/`out` arguments, an earlier side effect in the statement; *all occurrences* needs a value that cannot change |
| Introduce Field (one action; the choice in a QuickPick) | `refactor.extract.refyntra.field` | a selected expression in a method, constructor, accessor or operator: initialize in the field initializer (no locals, parameters or instance members), in the constructor(s) (no locals or parameters; chained `: this(…)` constructors are skipped, a constructor is added when there is none) or in the current member; `static` in a static context, `readonly` unless set in the member; *replace all occurrences in the type* when the value cannot change | method type parameters in the type, anonymous types, constant contexts, conditional/repeated evaluation (current member), constructors in another part of a partial type, primary constructors |
| Introduce Constant (local / of the type) | `refactor.extract.refyntra.constant` | a compile-time constant of a `const` type; the constant of the type replaces every occurrence in the type | non-constant expressions, local constants in the value (constant of the type), `null` of a non-string type |
| Introduce Parameter | `refactor.extract.refyntra.parameter` | a selected expression in a method body: a new parameter (before optional/`params` ones), every call site passes the expression (static members qualified with their type); a plan with preview, revalidation and Undo over every changed file, the override/interface hierarchy included | locals, parameters or instance members in the expression, a name that is inaccessible or means something else at a call site, method groups/delegates, methods visible outside the assembly (external callers), recursion inside the expression, side effects evaluated conditionally or repeatedly |

In the `resharper` preset **Ctrl+Alt+V** runs Introduce Variable on the selection and **Ctrl+Alt+N** Inline Variable at
the cursor (C# editors only; VS Code has no default binding for these keys). Protocol 1.9 (`code/editActions`).
Inline Method, Field and Parameter change one document: every call or read must be in the file of the action
(otherwise refused with *CrossFile*). Introduce Field / Constant change one document; Introduce Parameter is a previewed
plan over every changed file (`refactor/prepare` `csharp.introduceParameter`, command `refyntra.introduceParameter`).
Names are suggested from the expression (no prompt); rename them afterwards with Rename (F2).

**Fix in scope** (Rider's "apply to file / project / solution"): next to **Use explicit type**, **Use 'var'**, **Convert
to expression / block body**, **Convert to 'using' declaration**, **Use object initializer**, **Convert to interpolated
string** and **Convert 'string.Format' to interpolated string**, the lightbulb offers *… in document, project or
solution…*; a QuickPick asks for the scope. The host applies the action to every place it applies in that scope
(`refactor/prepare` `csharp.fixAll`, protocol 1.11), each occurrence computed exactly like the single action, as one
plan: preview (Refactor Preview with `refyntra.preview.style` `native`), revalidation, the EditApplier and Undo, with
a cancellable progress notification for large solutions. Occurrences that would give their file a new compiler error
are skipped (the preview says how many); generated and read-only files are skipped. Compiler and third-party analyzer
diagnostics have no fix in scope (Refyntra does not run their code fixes), and Refyntra's own rule OR1001 deliberately
has no code fix (changing a lifetime is an architectural decision). The quick fixes of Refyntra's inspections have a fix
in scope too (next section).

### Inspections (C#)

Refyntra's own C# inspections, implemented in the C# host with Roslyn's public APIs (no third-party analyzers). Each
rule is a precise semantic check that stays silent when it cannot prove the problem from the method itself; each was
checked against what the compiler and the SDK analyzers already report ([overlap review](docs/rules/overlap.md)), and
each page lists its false-positive guards.

| Rule | Reports | Quick fix | Default |
|---|---|---|---|
| [OR1002](docs/rules/OR1002.md) | `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` on a task (sync over async) | *Use 'await'* (a Task-returning method becomes `async`) | warning |
| [OR1003](docs/rules/OR1003.md) | `async void` that is not an event handler | *Change 'async void' to 'async Task'* | warning |
| [OR1004](docs/rules/OR1004.md) | a discarded task where CS4014 does not warn (methods that are not async, `?.` calls) | *Discard the task explicitly*; on CS4014: *Add 'await'* | warning |
| [OR1005](docs/rules/OR1005.md) | a disposable created in a method, never disposed or handed over | *Dispose with a 'using' declaration* | info |
| [OR1006](docs/rules/OR1006.md) | an `IEnumerable<T>` enumerated twice on one path | *Materialize once with 'ToList()'* | info |
| [OR1007](docs/rules/OR1007.md) | `s += x` on a string built in a loop | *Use a StringBuilder* | info |
| [OR1008](docs/rules/OR1008.md) | `Where(p).First()` / `Any()` / `Count()` … | *Pass the predicate to the operator* | hint |
| [OR1009](docs/rules/OR1009.md) | `ToList()` / `ToArray()` enumerated once (`ToList().Any()`, `foreach` over a copy the loop does not change) | *Remove the redundant copy* | hint |
| [OR1010](docs/rules/OR1010.md) | `string.Format` without arguments | *Use the string directly* | info |

- Results appear in the Problems view (source *Refyntra*, the rule id links to its page) for the C# files open in the
  editor; a keystroke re-analyses that document only (results are cached per document version,
  [measurements](docs/performance/inspections-2026-10-13.md)).
- The lightbulb (Ctrl+.) on a result offers its quick fix — computed by the host, applied only when the document gets no
  new compiler error, one undo step — and *… in document, project or solution…*, which applies the fix at every result
  of the scope as one previewed plan (Refactor Preview, revalidation, Undo), skipping results whose fix would not compile.
- Severity per rule: `refyntra.rules.ORxxxx` = `off | hint | info | warning | error`.
- Suppress like a compiler warning: `#pragma warning disable OR1002` … `restore`, or
  `[SuppressMessage("Usage", "OR1002:…")]` on a member, a type or the assembly.
- Not inspected on purpose: `Count() > 0` (the SDK's CA1827/CA1829 already report it), missing `ConfigureAwait(false)`
  (a project policy, not a defect), unused private members (the IDE reports them).

### Postfix templates (C#)

Type a dot after an expression and the completion list ends with Rider's postfix templates that fit the expression's
type (the C# host decides with Roslyn); choosing one replaces the expression with the snippet and puts the cursor on
the first name (Tab moves on). Setting `refyntra.postfix.enabled` (default on).

| Template | Result | Offered for |
|---|---|---|
| `.if` / `.while` | `if (expr) { }` / `while (expr) { }` | `bool`, as a statement |
| `.not` | `!expr` | `bool` |
| `.ifn` / `.notnull` | `if (expr is null) { }` / `if (expr is not null) { }` | reference types, `T?` value types, unconstrained type parameters |
| `.var` | `var name = expr;` | any value, as a statement |
| `.foreach` | `foreach (var item in expr) { }` | arrays, strings, `IEnumerable`, types with `GetEnumerator()` |
| `.for` / `.forr` | `for (var i = 0; i < expr.Count; i++)` / reversed | arrays and strings (`Length`), indexable lists (`Count`) |
| `.await` | `await expr` | awaitable values (`GetAwaiter()`) |
| `.return` / `.yield` | `return expr;` / `yield return expr;` | in a member that returns a value / an enumerable |
| `.throw` | `throw expr;` | exceptions |
| `.new` | `new Type()` | type names that can be created |
| `.using` / `.lock` / `.switch` | `using (var x = expr) { }` / `lock (expr) { }` / `switch (expr) { case … }` | disposables / reference types / any value |
| `.par` / `.cast` / `.arg` / `.nameof` | `(expr)` / `((T)expr)` / `Method(expr)` / `nameof(expr)` | any value (`nameof`: symbols) |

Statement templates appear only when the expression is a whole statement; blocks follow the document's
`.editorconfig` brace and indentation style; names come from the expression (`orders.foreach` → `order`) or its type
and never clash with names in the member. Answers are cached per document version and come from the current
snapshot (protocol 1.10, `code/postfix`). Limits: the expression must be on the cursor's line; an expression typed
in an unfinished statement that does not parse (e.g. an open `(`) gets no templates.

### Generate (Alt+Insert, C#)

**Refyntra: Generate…** (Alt+Insert in the `visualStudio` and `resharper` presets, Cmd+N on macOS; C# editors only)
lists what applies to the class, struct or record at the cursor, then the members to use (multi-select, sensible
preselection) and, for equality, the options. The C# host writes the code with Roslyn: semantic types, missing
`using` directives added, members of every part of a partial type, the document's `.editorconfig` formatting, and a
**refusal when the file would get a new compiler error** (for example a constructor with the same signature). The
result is one editor change (one Undo), applied only to the document version it was computed for.

| Kind | Generates |
|---|---|
| Constructor | `public T(...)` assigning the chosen fields / auto-properties (readonly members without initializer preselected); `protected` in abstract classes |
| Properties from fields | `public T Name => _name;` (readonly fields) or `{ get => _name; set => _name = value; }` |
| Missing members | stubs (`throw new NotImplementedException()`) for unimplemented interface members and abstract base members |
| Overriding members | `override` of virtual / abstract base members (`base.M(...)` calls) |
| Delegating members | members of a field's type that forward to it (pick the field, then its members) |
| Equality members | `Equals(object)`, `GetHashCode()` with `HashCode.Combine`; options `IEquatable<T>` and `==` / `!=` |
| Formatting members | `ToString()` returning `$"{nameof(A)}: {A}, …"` |

**Generate Constructor** (`refyntra.ctor.generate`, the lightbulb on a class) uses the same Roslyn generation when the
host is available and falls back to the text-based helper otherwise. Limits: one document (no new files); records get
no equality members (they have value equality) and positional records / primary constructors no extra constructor;
static abstract interface members and ref returns are not generated; a constructor does not pass arguments to a base
constructor that needs them (the compile check refuses it).

## Solution Explorer, project files and NuGet

The **Refyntra Solution** view (Refyntra activity bar) shows the loaded `.sln`, `.slnx` or `.csproj` as MSBuild sees it
(protocol 1.20, ADR-013): solution folders and solution items, projects with an icon per kind (web, console, worker,
desktop, test, library) and their target frameworks, **Dependencies** (Projects, Packages with versions — from
`Directory.Packages.props` with Central Package Management —, Frameworks, Analyzers) and the project's items: the
`Compile` items of the evaluation (globbed and explicit), linked files in their `Link` folder with a link badge, other
files as `None`/`Content`. C# files that the build does not compile (`Compile Remove`) are hidden, or shown greyed with
`refyntra.solutionExplorer.excludedFiles = grey`. The view selects the active editor's file
(`refyntra.solutionExplorer.autoReveal`, or **Reveal Active File** in its title bar).

Context menus (trusted workspaces only; every change runs as a visible `dotnet` task, then the solution reloads, and
the notification offers **Undo** that restores the changed files):

- Open, Reveal in Explorer View / File Manager, Copy Path; Run, Debug, Set as Startup Project (the run target of
  *Run and debug*), Run Tests of Project (the Test Explorer).
- New Project… (`dotnet new list` → template → `dotnet new` → `dotnet sln add`), Add Existing Project…
  (`dotnet sln add`, into the solution folder you clicked), Remove Project from Solution (`dotnet sln remove`).
- Add / Remove Project Reference (`dotnet add|remove reference`).
- Rename Project…: project file and its folder (when named after the project), the solution entry, `ProjectReference`
  paths in other projects, `RootNamespace`/`AssemblyName` equal to the old name — shown in VS Code's Refactor Preview
  first. Refused when ambiguous (a folder with other projects, an existing target, a reference through a property).
  Namespaces in code are not renamed.
- Unload / Reload Project: Refyntra-side only (greyed, no children; the solution file is not changed).

**Manage NuGet Packages** (a project, the solution, or a `.csproj` in the Explorer): *Installed* (versions from the
project, `Directory.Packages.props` and the restore), *Browse* (searches your configured NuGet sources when you press
Search), *Updates* (**Check for updates** runs `dotnet list package --outdated`), *Consolidate* (one version across the
projects of the solution). **Check vulnerable** / **Check deprecated** run `dotnet list package --vulnerable` /
`--deprecated`. Install, update and uninstall run `dotnet add|remove package`; with Central Package Management an update
changes the version in `Directory.Packages.props` (then `dotnet restore`).

Network: only the sources of your NuGet configuration (`dotnet nuget list source`; nuget.org when there are none), only
when you search, load versions or check for updates; nothing when the panel opens. Refyntra sends no credentials: a
feed that needs them is searched with `dotnet package search`, which uses your credential providers, and installs go
through `dotnet` as on the command line. Package icons are not loaded.

**Project files** (`.csproj`, `.props`, `.targets`): completion for MSBuild properties and items and their values
(`TargetFramework`, `Nullable`, `LangVersion`, `ImplicitUsings`, `OutputType` …), package ids in `PackageReference` /
`PackageVersion` from the solution and the local NuGet cache, versions from the cache (**Load versions from NuGet
sources…** asks your feeds), hover on properties and items. **Edit Project File** opens the project of the current file.
Saving a project or solution file reloads it in the C# host; while the view is open, created or deleted files do too.

Limits: a reload re-reads the whole solution; items added by custom targets at build time are not shown; Unload does not
take a project out of Find, Rename and the other analyses.

## Commands

| Command | Purpose |
|---|---|
| `refyntra.find` | Find symbols, endpoints, known roles |
| `refyntra.related` | Related symbols for the current position |
| `refyntra.navigateTo` | Navigate To… (Alt+`, C#): every target of the symbol at the cursor that exists, with counts |
| `refyntra.findUsages` | Find Usages (Grouped, C#): the Refyntra Usages view, classified and grouped usages |
| `refyntra.recentFiles` | Recent Files (Ctrl+E): recently opened files, the previous one first |
| `refyntra.recentLocations` | Recent Locations (Ctrl+Shift+E): edited and visited places with member and code line |
| `refyntra.fileStructure` | File Structure (Ctrl+F12): members of the current file by type and region, filters, inherited members (C#) |
| `refyntra.goToMetadata` | Go to Metadata / Decompiled Source (C#): the read-only embedded or decompiled source of the library symbol at the cursor (F12 inside such a document) |
| `refyntra.openMetadata` | (not in the palette) Open the decompiled source of a documentation id (File Structure, stack traces, Smart Step Into) |
| `refyntra.usages.next` / `.previous` | Next / previous usage of the Usages view (F4 / Shift+F4 in a C# editor while it has results) |
| `refyntra.usages.groupBy` / `.filterKinds` / `.filterTests` / `.clearFilters` | Groupings and filters of the Usages view |
| `refyntra.usages.export` / `.pin` / `.unpin` / `.refresh` / `.clear` | Export to Markdown, pin, refresh, clear the Usages view |
| `refyntra.actions` | Available actions and reasons for unavailable ones |
| `refyntra.rename` | Rename with preview, then apply |
| `refyntra.moveTypeToFile` | Move the type at the cursor into its own file (preview, then apply) |
| `refyntra.generateHandler` | Create a MediatR handler for the request at the cursor (preview, then apply) |
| `refyntra.cleanup` | Code Cleanup of a file, folder, project or the workspace (one preview, then apply, Undo) |
| `refyntra.safeDelete` | Delete the symbol at the cursor only when nothing uses it (preview, then apply, Undo) |
| `refyntra.extractMethod` | Extract the selected statements or expression into a new method (name prompt, preview, then apply) |
| `refyntra.changeSignature` | Add, remove, reorder or rename parameters and update every call (editor, preview, then apply) |
| `refyntra.generate` | Generate… (Alt+Insert): constructor, equality, ToString, properties, missing / overriding / delegating members (C#) |
| `refyntra.showHealth` | The Health page: is Refyntra working, what it means, the fix, projects by state |
| `refyntra.showHealthText` | The same report as a Markdown document, technical details included |
| `refyntra.restartBackend` | Restart the .NET host |
| `refyntra.exportDebugBundle` | Save a redacted, previewed debug bundle to a local file (opt-in, nothing is sent) |
| `refyntra.selectSolution` | Choose the solution or project to load |
| `refyntra.showMenu` | The menu of all main commands |
| `refyntra.statusMenu` | The status bar menu: the current state, then what helps now (a click on the status bar item) |
| `refyntra.getStarted` | Open the *Get started with Refyntra* walkthrough |
| `refyntra.keyboardShortcuts` | Open the `refyntra.keybindings.preset` setting |
| `refyntra.openStackTrace` | Read a pasted stack trace (.NET, JavaScript/TypeScript, Python, Rust) and open its frames |
| `refyntra.taskContext.new` / `.switch` / `.rename` / `.delete` | Create, switch, rename or delete a named task context |
| `refyntra.taskContext.addSymbol` / `.addFile` | Add the symbol at the cursor or a file to the active task context |
| `refyntra.taskContext.copyMarkdown` / `.export` / `.import` / `.clear` / `.refresh` | Copy as Markdown, export or import JSON, clear, resolve again |
| `refyntra.findHandler` / `refyntra.findEndpoint` / `refyntra.findRegistration` | Find, narrowed to handlers, endpoints or DI registrations (the same search as Find, with a preset filter) |
| `refyntra.run` / `refyntra.debug` | Run without debugging / start debugging the selected run target (or the project of the file, the Run view item, the CodeLens) |
| `refyntra.runWatch` | Run the selected .NET project with `dotnet watch run` (hot reload) |
| `refyntra.stop` / `refyntra.restart` | Stop or restart what Refyntra started (Run view, view title) |
| `refyntra.selectRunTarget` | Choose project, launch profile, target framework and configuration (the status bar item) |
| `refyntra.showImmediate` | The Refyntra Immediate panel for the stopped frame (Ctrl+Alt+I in the `visualStudio` preset while debugging) |
| `refyntra.smartStepInto` | Smart Step Into: choose which call of the stopped C# statement to step into (Alt+Shift+F11 in the `visualStudio` preset, Shift+F7 in the `resharper` preset) |
| `refyntra.breakOnExceptionTypes` | Choose the .NET exception types a `refyntra-dotnet` session breaks on when thrown |
| `refyntra.ctor.generate` / `refyntra.ctor.addParameters` | Generate a constructor from chosen fields and properties / add them to the existing constructor (also Ctrl+. on the class name) |
| `refyntra.introduceParameter` | Introduce Parameter for the selected C# expression: every call site passes it (preview first) |
| `refyntra.introduceVariable` / `refyntra.inlineVariable` | Introduce a local from the selected C# expression / inline the C# local at the cursor (Ctrl+Alt+V / Ctrl+Alt+N in the `resharper` preset) |
| `refyntra.generateLaunchJson` | Write the run and debug configurations to `.vscode/launch.json` |
| `refyntra.tests.runRelated` | Run Tests for This Code: the test at the cursor, or the tests that reference the symbol (C#) |
| `refyntra.tests.run` / `refyntra.tests.debug` | (not in the palette) Run / debug one test item (the test CodeLens) |
| `refyntra.solution.show` | Show the Refyntra Solution view (solution folders, projects, dependencies, files as MSBuild sees them) |
| `refyntra.solution.newProject` / `.addProject` / `.removeProject` / `.renameProject` | New Project from a template, Add Existing Project, Remove from Solution, Rename Project (preview) |
| `refyntra.solution.addReference` / `.removeReference` / `.undo` | Add or remove a project reference; undo the last project operation |
| `refyntra.solution.run` / `.debug` / `.setStartup` / `.runTests` / `.unloadProject` / `.reloadProject` / `.revealActive` / `.refresh` | Solution view item and title commands |
| `refyntra.manageNuGet` | Manage NuGet Packages of a project or the solution: Installed, Browse, Updates, Consolidate |
| `refyntra.editProjectFile` | Open the project file of the current file (completion and hover for MSBuild properties, items and packages) |
| `refyntra.nativeRename` | (not in the palette) The editor's own Rename, offered when a TS/JS rename cannot be confirmed safe; not validated by Refyntra |

## Settings

| Setting | Values | Description |
|---|---|---|
| `refyntra.hostPath` | path, machine scope | Use a host build from this location instead of the packaged one (development use). Only user or machine settings, never workspace settings, so a project cannot choose the executable |
| `refyntra.keybindings.preset` | `visualStudio` (default), `resharper`, `none` | Optional keybinding preset |
| `refyntra.rename.apply` | boolean, default on | Offer **Apply rename** after the preview (revalidated after you confirm, not saved). Off = preview-only |
| `refyntra.cleanup.profile` | list of fix ids, default `removeUnnecessaryUsings`, `sortUsings`, `whitespace` | Fixes pre-selected by Code Cleanup (`fileScopedNamespace` is opt-in) |
| `refyntra.related.followCursor` | boolean, default on | The Related view follows the cursor unless it is pinned |
| `refyntra.fileStructure.preview` | boolean, default off | File Structure shows the selected member in the editor while you move through the list |
| `refyntra.metadata.sourceLink` | `embeddedOnly` (default), `off` | Go to Metadata: show the source embedded in a library's PDB, else decompile (`off`: always decompile). Nothing is downloaded |
| `refyntra.http.basePaths` | list of path prefixes, default empty | Frontend ↔ backend links: prefixes that client URLs add but the routes do not have (tried only when the exact match finds nothing) |
| `refyntra.http.origins` | list of origins, default empty | Frontend ↔ backend links: absolute origins (`https://localhost:5001`) that are this backend; other absolute URLs are never linked |
| `refyntra.rules.OR1001` | `off`, `information`, `warning` (default) | Severity of the experimental OR1001 rule in the Problems view |
| `refyntra.rules.OR1002` … `OR1010` | `off`, `hint`, `info`, `warning`, `error` | Severity of each inspection (defaults: OR1002–OR1004 `warning`, OR1005–OR1007 and OR1010 `info`, OR1008–OR1009 `hint`) |
| `refyntra.preview.style` | `native` (default), `quickPick` | Where previews are shown: VS Code's Refactor Preview for text-only plans, or the QuickPick preview for every plan |
| `refyntra.changeSignature.editor` | `dialog` (default), `quickPick` | Change Signature edits the parameters in a dialog or in QuickPick steps |
| `refyntra.codeLens.enabled` | boolean, default on | CodeLens above C# types and methods |
| `refyntra.codeLens.references` / `.mediatr` / `.endpoints` / `.efCore` | boolean, default on | One switch per CodeLens kind |
| `refyntra.hover.mediatr` | boolean, default on | Hover on a MediatR request shows its handler |
| `refyntra.run.codeLens` | boolean, default on | `Run \| Debug` CodeLens above entry points |
| `refyntra.run.editorButtons` | boolean, default on | Run and Debug buttons in the editor title |
| `refyntra.run.statusBar` | boolean, default on | The run target in the status bar |
| `refyntra.run.view` | boolean, default on | The Refyntra Run view |
| `refyntra.tests.codeLens` | boolean, default on | `Run \| Debug` CodeLens with the last result above C# test classes and methods |
| `refyntra.debug.inlineValues` | boolean, default on | C# inline values after the lines of the stopped method (shown when `debug.inlineValues` is `auto` or `on`) |
| `refyntra.solutionExplorer.enabled` | boolean, default on | The Refyntra Solution view |
| `refyntra.solutionExplorer.excludedFiles` | `hide` (default), `grey` | C# files in a project folder that the build does not compile |
| `refyntra.solutionExplorer.autoReveal` | boolean, default on | The Solution view selects the active editor's file while it is visible |
| `refyntra.trace.level` | `info` (default) and other levels | Detail of the Refyntra output log. Source text is never logged |

## Troubleshooting

- **SDK not found**: the Health page says *C# is not running* and offers **Install .NET SDK** (and **Open global.json** when a global.json pins the version). Install it and click **Restart backend**. Refyntra does not download SDKs itself.
- **Status is Partial** (some projects not loaded): open `Refyntra: Show Health` to see which projects did not load and why, grouped by cause. Results for those projects are incomplete and say so.
- **Missing references or empty results after cloning** (or packages deleted from the NuGet folder): the Health page shows *Needs packages* with **Restore packages**. Click it: after a successful restore the backend reloads the solution by itself. Or run `dotnet restore` yourself, then restart the backend. Refyntra never restores without your click.
- **Trust required**: trust the workspace through VS Code if you accept evaluating its projects (and, for Rust, running cargo, build scripts and proc-macros).
- **Rust works partially**: install the Rust toolchain from rustup.rs (`cargo` on `PATH` or in `~/.cargo/bin`), then **Restart backend**.
- **Rust is not available on this platform**: install the platform package of Refyntra for your OS and CPU.
- **Host crashed / stopped restarting**: see Show Health and the output channel, then `Refyntra: Restart Backend`.
- **Reporting a problem**: `Refyntra: Export Debug Bundle` shows a preview and saves a local file without source text, environment values or your paths.

More in [docs/support/troubleshooting.md](docs/support/troubleshooting.md).

## Testing

- `pnpm test:unit`, `pnpm test:architecture`, `pnpm test:host`: unit, layering and .NET host tests.
- `pnpm test:integration`, `pnpm test:e2e`: the extension inside a real VS Code; on Linux in Docker with `bash scripts/test/linux-e2e.sh` (see [docs/support/linux-smoke.md](docs/support/linux-smoke.md)).
- `pnpm test:visual`: screenshot tests of Refyntra's UI in VS Code 1.90.2, **only headless in Docker** (Xvfb 1600x1000, `scripts/test/linux-visual.sh`; it never opens a window on your desktop). Both Default Dark Modern and Default Light Modern, fixed DejaVu fonts and zoom, no animations, cursor blink, tips or welcome page, on a temp copy of `tests/fixtures/Shop`. Scenarios: CodeLens, the Ctrl+. refactor menu on a selection, the editor context menu's Refyntra submenu, the Refactor Preview of a rename, the Change Signature dialog, the Related, Stack Trace and Task Context views, the status bar menu, the Health page, the MediatR hover and the Find QuickPick; the Test Explorer after a run and the test CodeLens run on a copy of `tests/fixtures/TestRunner` (scenarios `visual-tests-dark` / `visual-tests-light`). Screenshots are compared with `tests/visual/baselines/<theme>/<scenario>.png` (pixelmatch, threshold 0.1, at most 0.05 % differing pixels; masked regions in `tests/visual/masks.json`). Results: `test-results/visual/report.html` (baseline, actual and diff side by side) plus `actual/` and `diff/` PNGs. `pnpm test:visual --update` regenerates the baselines; review the new PNGs before committing them.
- Watch the Docker runs live: `REFYNTRA_VNC=1 pnpm test:visual` (or `pnpm test:visual --vnc`, `bash scripts/test/linux-e2e.sh --vnc`) runs a fixed Xvfb display `:99` with x11vnc and noVNC in the container. Open http://localhost:6080/vnc.html (or a VNC viewer on `localhost:5900`) once the build step is done. The ports listen on 127.0.0.1 only and the session is view-only without a password. `REFYNTRA_VNC_PAUSE_MS=1500` pauses after each test case so you can follow. Without the variable nothing changes (xvfb-run, no ports).

## Status and feedback

Alpha: commands, settings and output may change. Issues and contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
