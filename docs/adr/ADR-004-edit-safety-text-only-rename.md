# ADR-004: Edit safety and text-only Rename limit for the MVP

Status: Accepted (alpha baseline)

## Context

Rename edits many files. Host responses are untrusted input to the extension, and VS Code offers no universal filesystem transaction.

## Decision

- Alpha: Rename was preview-only at first. Since the Stage C safety gate (read set, mandatory revalidation, single apply owner, fault-injection tests) passed, applying is offered by default after the preview; `refyntra.rename.apply` turns it off for preview-only use.
- MVP: semantic, text-only C# Rename with a full preview and mandatory revalidation immediately before apply.
- A plan is a state machine with a single owner of apply.
- The extension validates every edit (URI scheme, path traversal, symlink aliases, size limits, expected content hash) before writing.
- No automatic rollback and no silent saving.
- Unsupported cases (linked, generated, file-local or unknown contexts, file renames) are refused with a reason.

## Consequences

- Users see every change before confirming.
- External modification between preview and apply blocks the stale plan.
- A failure during apply is reported honestly; atomicity across files is not promised.
- File rename, Move Type and similar features wait for later iterations under the same gates.

## Rejected alternatives

- Applying directly from the host: bypasses the extension's validator.
- Optimistic apply with best-effort rollback: can lose or corrupt user code.
- Claiming a universal transaction: not technically available.

## Revisit criteria

When a platform transaction API exists, or when the safety suite and usability sessions justify wider edit kinds.

## Amendment 1: renaming the file together with a type

Status: Accepted

The revisit criterion "the safety suite justifies wider edit kinds" is met for exactly one resource operation: renaming
the files named after a top-level type (`Foo.cs`, partial parts `Foo.*.cs`) together with the type.

- Offered only when proven safe, otherwise the rename stays text-only and the preview gives the reason: every part in a
  file named after the type, nothing else top-level in those files, not file-local or generated, same folder, no
  symbolic link, not read-only, target absent (also ignoring case), not a reserved name, not a case-only rename, and a
  static Compile-membership proof per containing project (SDK default glob on, not linked, not under bin/obj, no
  `Compile` pattern or explicit item for either name and no changed default excludes in the project file, the nearest
  `Directory.Build.props/.targets` or their literal imports; computed imports → not offered).
- Contract: `PlannedChange` kind `rename` (additive, protocol 1.2), always after every text change; validated by the
  domain validator; revalidation re-checks the absence precondition, the guards and the proof.
- Apply order through the single EditApplier: one text-only `WorkspaceEdit` (all-or-nothing for text); only when every
  text target is confirmed, each file rename as its own `WorkspaceEdit.renameFile` (overwrite off). Reconciled per
  operation: new file present with the planned text (editor buffer or disk), old file gone.
- Failure path: text applied, file not renamed → reported exactly as that, Undo of the text offered, no automatic
  rollback. Unknown outcome → the C# route restarts (full reload). Success → `workspace/didRenameFiles` moves the
  documents in the host without a reload.
- Residual risks: no transaction across text and file operations; a last-moment external write to the target (the
  editor refuses to overwrite; reported); MSBuild items from packages/SDK not inspected; Undo of the file rename is the
  editor's file-operation Undo.

## Amendment 2: created files (Move Type to File, Generate handler)

Status: Accepted

The same revisit criterion is met for a second resource operation: creating one new `.cs` file, for Move Type to File
(a top-level type out of a file with several top-level types) and Generate handler (MediatR).

- Offered only when proven safe, otherwise unavailable with the reason in Actions and the prepare result. Shared guards:
  target absent (also ignoring case, also as a document of the solution), valid non-reserved name, folder not reached
  through a symbolic link, and the static Compile-membership proof of Amendment 1 with an existing file of the same
  folder as the anchor, in every project that contains the anchor. Move Type to File adds: not partial, not file-local,
  not generated, no conditional/`#nullable`/`#pragma`/`#line` directives in the file, no directive inside the type, the
  type on its own lines, and every name of the moved code binding to the same symbol in the new file (with the usings
  reduced to those the moved code needs). Generate handler adds: verified MediatR identity and version, not generic, not
  abstract or inaccessible, no source handler, a target project that references MediatR and can see the request.
- Compilation delta: no compiler error in the affected closure after the change that did not exist before; every error
  in the new file is new.
- Contract: `PlannedChange` kind `create` `{uri, resultHash, text}` (additive, protocol 1.3), always **before** every
  text change; `RefactorPlanDto.fileCreate` lists the created files (and the Generate handler folder choices);
  `PrepareParams.documentUri` / `targetFolderUri`; notification `workspace/didCreateFiles`. Validated by the domain
  validator (order, listing, `*.cs`, no separator, hash, size limit, no overlap with edited or renamed files); the
  EditApplier checks `resultHash` = SHA-256(`text`) and the absence again. Revalidation re-checks absence and proof
  first (reason `TargetExists` / `FileCreateUnsafe`), then the read set.
- Apply order through the single EditApplier: each create as its own `WorkspaceEdit.createFile` (overwrite off) with the
  planned bytes, reconciled (the file exists with exactly the planned text); only when every create is confirmed, every
  text target is checked again synchronously and the text edit is applied (all-or-nothing for text). **Why create
  first**: the create is the step exposed to the outside (target appearing, permissions); failing first leaves nothing
  changed and the code compilable. The text edit after it is hash-checked synchronously and rarely fails; if it does,
  the type exists twice (a loud CS0101) but no code exists only in an Undo history. Text first would, on a create
  failure, leave the type removed from the editor buffer (and, with auto save, from disk) with no new file.
- Failure path: create failed → nothing changed, reported. Created but text not applied → reported exactly as that
  (`createdOnly`), deleting the new file offered, no automatic rollback. Unknown outcome → the C# route restarts.
  Success → `workspace/didCreateFiles` adds the documents to the proven projects without a reload.
- Undo is Refyntra's: the editor's Undo of the text edit while the text is the applied result, then deletion of the
  created file while it still has exactly the created text and no unsaved changes (through the EditApplier), then a
  reload of the C# route. Changed state is left alone and reported.
- Residual risks: no transaction across file and text operations; a last-moment external write to the target (the
  editor refuses to overwrite; reported); MSBuild items from packages/SDK not inspected; the created file is on disk while
  the original edit is unsaved, so a build from disk in between sees the type twice.

## Amendment 3: Code Cleanup (many files, text only)

Code Cleanup (`csharp.cleanup`, protocol 1.4) uses the plan pipeline of this ADR unchanged: a text-only `writeSet`
(possibly many files), the read set of the edited projects and their dependencies, revalidation after the confirmation,
the single EditApplier with its synchronous hash checks, per-file reconciliation, no save, no automatic rollback. What
is new is only around it:

- The plan has no symbol: `refactor/prepare` takes `cleanup: {scopeUris, fixes}` and the plan carries
  `cleanup: {fixes, files, skipped, filesInScope}` (per file per fix counts, skipped files and fixes with reasons) for the
  preview. The client refuses a cleanup plan with anything but text changes.
- The safety proof is per change, not a compilation delta: each fix returns a text only when the semantic fingerprint of
  the file (symbol of every name/expression/type with its type and converted type, declared symbols, literal values,
  diagnostics; doc comments parsed) equals the original in every project context; otherwise the fix is skipped in that
  file with the reason. This is sufficient because the fixes never change what other files see (no global usings, no
  declarations). Each fix is idempotent.
- Files the EditApplier could not edit exactly (generated, read-only, not UTF-8, mixed line endings, too large) are
  skipped with a reason instead of refusing the whole plan.
- Undo restores the previewed original of every file that still has exactly the applied text, through the EditApplier
  (one workspace edit, not saved); a file changed meanwhile is left alone and reported. The editor's own multi-file undo
  is not used because it asks a modal question per file group.
- IDE code-style fixes (IDExxxx) are not offered: their analyzers and code fix providers are internal Roslyn types reached
  through MEF, and Refyntra uses public APIs only.

## Amendment 4: EF Core migrations in a rename

Status: Accepted

Renaming a DbContext (or a type referenced from migrations) used to be refused as `GeneratedCode`, because EF Core's
migration, `.Designer.cs` and model snapshot files reference it in `[DbContext(typeof(X))]`. The user now chooses
(protocol 1.5, `PrepareParams.generatedEdits`, `RefactorPlanDto.efMigrations {mode, files}`):

- `efMigrations` (default): edits in a generated file are allowed only when the file is proven to be an EF Core
  migration or model snapshot (every top-level type carries the verified `Microsoft.EntityFrameworkCore.Infrastructure.DbContextAttribute`
  naming a DbContext declared in source, and is a `Migration` with the verified `MigrationAttribute` or a
  `ModelSnapshot`; metadata name and declaring assembly checked) **and** every Roslyn edit in it replaces exactly one
  identifier token spelled like the symbol that binds to the symbol, by the new name (the expected text is rebuilt and
  compared). Otherwise the rename is refused. Strings are never edited.
- `none`: the edits in those files are dropped before the compilation delta; new errors in exactly those files are
  expected and reported (`compilationDelta: failed`), errors anywhere else still refuse. The plan is `limited` with
  "The project will not build until the migrations are updated", so it is applied only after the second confirmation.

Unchanged: read set (migration files are source files of the closure), revalidation, the single EditApplier, Undo. Other
generated code is still refused. Residual risk, stated in the preview: the model snapshot keeps the old CLR name as a
string, so the next migration may show a difference for the renamed type.
