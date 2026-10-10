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