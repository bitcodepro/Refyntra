# ADR-011: EF Core tools (migrations view, dotnet-ef tasks, SQL for LINQ, OR1011)

Status: Accepted (alpha)

## Context

Refyntra already navigates EF Core models from source (DbContext ↔ entities, configurations, tables, queries,
migrations; rename of a DbContext used by migrations). Working with migrations and queries still needed a terminal or
another tool. The goal: Rider-like EF Core tools with no other extension — a migrations tree, the common `dotnet ef`
commands, the SQL of a LINQ query while debugging, and a hint for a common performance mistake (N+1).

Constraints:

- Never touch a database unless the user explicitly asks, and say which command will run first.
- `dotnet ef` builds and runs workspace code: trusted workspaces only (ADR-005).
- No tool is installed by Refyntra (dotnet-ef is the user's choice: global or local manifest).
- No new bundled component; nothing is added to user projects.

## Decision

1. **Model from source in the host (protocol 1.18, `efcore/migrations`).** The host already knows the EF Core symbols
   (identity by full name and assembly). `EfMigrations` lists DbContexts, their migrations (`[Migration("id")]`,
   assigned by `[DbContext(typeof(X))]`, ordered by id like EF Core), the model snapshot, the main and `.Designer.cs`
   parts and the `IEntityTypeConfiguration<T>` classes of the context's entities. Custom migration folders and
   namespaces need nothing special: the attributes decide, not paths. The view "Refyntra EF Core" (Refyntra container)
   shows DbContexts → migrations → snapshot → configurations; it is visible only when the workspace has a DbContext,
   so other workspaces (and their screenshots) are unchanged. It refreshes when the C# host becomes ready and after
   workspace changes (debounced).
2. **Applied / pending only on request.** "Check Status" runs `dotnet ef migrations list --json --project …
   --startup-project … --context …` (it connects to the database: confirmation first, showing the exact command), and
   marks migrations applied or pending until the next refresh of that context's status. Without a reachable database
   dotnet ef lists migrations without flags; the view then says "status unknown".
3. **Commands as visible VS Code tasks.** Add Migration (name prompt, validated as a C# identifier), Remove Last
   Migration, Update Database (latest, a selected migration, or `0`), Generate SQL Script (plain or idempotent, from a
   selected migration's predecessor to it, or all; the result opens in an untitled `.sql` editor, the temp file is
   deleted). Each is `dotnet ef …` run with `ProcessExecution` (an argument array, no shell: paths with spaces, quotes
   or `$` are passed literally); the task's name is the command line. Commands that connect to a database (update,
   remove, list) ask for confirmation in a modal dialog that shows the command. The startup project is chosen once per
   DbContext from the runnable projects (the migrations project when it is the only candidate) and remembered in the
   workspace state. **No Drop Database command**: dropping is destructive and rare; run `dotnet ef database drop`
   yourself if you need it.
4. **dotnet-ef detection.** `dotnet ef --version` in the project folder (dotnet itself honours a local tool manifest);
   a `.config/dotnet-tools.json` listing dotnet-ef marks it as local. When missing, Health and the action explain it
   and show `dotnet tool install --global dotnet-ef` (or `dotnet tool restore` for a manifest) as text; Refyntra never
   runs an install. Detection runs only in a trusted workspace, when an action needs it.
5. **Show SQL for LINQ.** In a stopped `refyntra-dotnet` session (netcoredbg) with an expression selected, the command
   evaluates `(<selection>).DebugView.Query` (EF Core's debug view: the same text as `ToQueryString()`, read as a
   property because netcoredbg could not call `ToQueryString` in the e2e: TargetParameterCountException), then
   `EntityFrameworkQueryableExtensions.ToQueryString(<selection>)` and `(<selection>).ToQueryString()`, with DAP
   `evaluate` in the active frame (`vscode.debug.activeStackItem`). The string result is shown in a read-only `refyntra-sql:` editor (language SQL).
   Outside a debug session it explains and offers to add a breakpoint at the cursor's line (only on click).
   `ToQueryString()` translates; it does not run the query. Lambdas in the selection are usually not evaluable by the
   debugger: select the variable that holds the query.
6. **OR1011 possible N+1 (heuristic, hint).** A navigation read in a `foreach` / in-memory `Select` over the results of
   a query from the same function that neither includes nor projects it, with lazy loading impossible; quick fix
   *Add .Include(x => x.Nav)*. Conservative by design (docs/rules/OR1011.md lists every guard); the wording says the
   navigation is probably not loaded, not that queries already repeat.

## Consequences

- dotnet-ef must be installed by the user for the commands; the tree, navigation and OR1011 work without it.
- Status is a snapshot taken on request, not live; it is dropped after Update Database.
- Remove Last Migration relies on dotnet ef's own check (it refuses to remove an applied migration unless forced;
  Refyntra never passes `--force`).
- SQLite has no idempotent scripts; dotnet ef says so in the task output.
- Show SQL depends on what netcoredbg can evaluate; the e2e covers a query variable on SQLite.

## Tests

.NET `EfToolsTests` (fixture `EfTools`: two contexts, custom folder/namespace, snapshots, ordering; EfCore fixture
contexts and configurations; OR1011 every marked case and nothing else, the fix incl. the added using), unit tests
(tree model, command lines with spaces and quotes, confirmation set, output parsing, debugger strings, host data
sanitising), e2e `efcore` (tree of the EfCore fixture) and `ef-tools` (dotnet-ef installed into the Linux test image
at build time: update database on a temp SQLite file, check status, add migration, SQL script, remove; OR1011 hint +
quick fix + Undo; Show SQL in a netcoredbg session), visual baseline `ef-core-view` in both themes.
