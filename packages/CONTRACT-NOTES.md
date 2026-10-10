# Contract notes (TypeScript side)

Gaps and interpretations found while implementing the client of `docs/architecture/protocol-v1.md` /
`packages/contracts/src/protocol.ts`. The contract changed only additively (1.1: `LoadDiagnostic.recoveryActions`; `RelatedResult.scopeDetails`); the client codes defensively as described.

1. *(resolved: protocol-v1.md now states "0-based, contiguous; -1 = nothing sent")*. A document event that cannot be
   sent (oversized, failed send) does not consume a sequence number, so no barrier waits for a gap; on
   `-33008 BarrierTimeout` the client replays every open document and retries once.
2. **`sequence` vs `documentSequence`/`workspaceRevision`.** The application owns a global `documentSequence` and
   `workspaceRevision`. The wire `sequence` is per session (restarts at 0 after a restart/replay);
   `workspaceRevision` on the wire is the global application revision. `BarrierResult.workspaceRevision` from the host
   is ignored (the client owns that counter).
3. *(resolved)* `PrepareParams.actionId` is a `string`.
4. *(resolved: documented)* `RelationKind` is a closed union for the C# host; the domain uses
   `AnyRelationKind = RelationKind | \`${string}.${string}\`` and unknown namespaced kinds are tolerated.
5. **Capability catalogue** (protocol-v1.md "Capability ids", `CSHARP_CAPABILITY_IDS`): `csharp.find`,
   `csharp.related`, `csharp.rename`, `csharp.references`. The UI has a title and a command for each (unknown ids are
   shown by id). When the C# route is down the client synthesises `unavailable` entries for the whole catalogue.
   `Availability` still has no human title (UI-side titles).
6. **`RecoveryAction.command` comes from the backend.** Backend output is untrusted: the extension only
   runs `refyntra.*` commands and `workbench.trust.manage` from recovery actions; others are ignored with a warning.
7. **`code/symbolAt`, `capability/query`, `refactor/prepare` results carry no `snapshotId`.** The client relies on the
   barrier snapshot + unchanged epoch + unchanged workspace revision for stale rejection; results that do carry a
   `snapshotId` (`search`, `related`, `references`) must equal the barrier snapshot or they are dropped. Only
   `-33004 StaleSnapshot` is retried; `-33005 UnknownSymbol` is reported as an error.
8. *(resolved: doc fixed)* `RelatedResult` has `relations` (each with `group`); the client groups by
   `RELATION_GROUP_ORDER`, unknown groups are appended.
9. **Host launch** (not specified): `dotnet <path>/Refyntra.Host.dll` (or an executable path) with no arguments,
   `cwd` = host directory, env `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`. stdin close = exit request after
   `shutdown`/`exit`; after 1.5 s the process tree is killed (`taskkill /T /F` on Windows, process group on POSIX).
10. **stderr log lines**: fields other than `ts`, `level`, `component`, `msg` are forwarded to the output channel;
    keys named `text`, `newText`, `content`, `source`, `edits`, `env`, `params`, `preview` are always redacted.
11. **Untrusted workspace:** the client never spawns the host while untrusted, so `workspace/open { trusted: false }`
    is never sent by this client; a `TrustRequired` (-33003) error is still mapped to the `TrustRequired` state.
12. **Rename apply (Stage C).** `refactor/revalidate` is a check, not a lock. The client: (1) requires the plan to be
    `Previewing`, the backend epoch unchanged and the application `workspaceRevision` unchanged since prepare (any
    editor event, including opening a C# document, ends the lease); (2) calls revalidate (barrier first); (3) reads
    closed targets from disk with `workspace.fs` (UTF-8, BOM stripped as VS Code shows the text); (4) synchronously
    re-checks the lease and every target's SHA-256 (open buffer `getText()` or the disk text just read) and that the
    edits produce `resultHash`, then calls `workspace.applyEdit` with no await in between; (5) reconciles every target
    (confirmed / unchanged / unknown). A non-UTF-8 target is refused (the host already refuses it at prepare). The
   rename preview reads files without opening them for the same reason, and is marked invalid (Apply disabled) when the
   edits do not reproduce `resultHash` on the current text. A `limited` plan is applied only after a modal
   confirmation that lists its limitations (`applyRename(planId, token, { acceptLimited: true })`); revalidate
   `invalid`/`UnknownPlan` is reported as "the preview expired, prepare again".
13. **`LoadDiagnostic.recoveryActions`** (1.1) are shown on the health page and offered with the other recovery
    actions; `refyntra.runRestore` accepts only an absolute `.sln/.slnx/.csproj` path inside a workspace folder and
    runs only in a trusted workspace, after a click. It runs as a `refyntra-restore` task with
   `ProcessExecution('dotnet', ['restore', path])` (no shell, so nothing in the file name is interpreted).
14. **`analysis/run`** (1.1, additive; the `MethodMap` entry is appended by declaration merging). `EngineClient.analyze()`
    returns one outcome per route that implements the optional `LanguageAdapter.analyze`; malformed diagnostics (no id,
    message or location) and related locations without a location are dropped. The extension publishes OR1001 only in
    its own DiagnosticCollection `refyntra` (700 ms after the last edit; cleared on an epoch change; never touches other
    collections); abstentions are shown only by the "explain" code action. A `Stale` outcome keeps what is shown and
    retries after the next pause; any other failure clears the collection (results unknown).

**Delegated TS/JS route (`packages/adapter-vscode-providers`).** Not a protocol backend: the
`DelegatedProviderAdapter` implements `LanguageAdapter` over VS Code's public provider commands (injected
`CommandExecutor`/`ProviderValues`/`DocumentReader` ports; the `vscode` API object is passed in by the composition root).
`sessionEpoch` of its `RouteResult`s is the bridge epoch (new on restart), `snapshotId` is `'unknown'`, results carry
`DelegatedProvenance` (`observationId`, everything else `'unknown'`). Rename uses the optional
`LanguageAdapter.delegatedRename` port and the domain `DelegatedRefactorPlan`; the engine
keeps the shared lifecycle, applies through the same `EditApplier`, and its lease for a delegated plan is the bridge
epoch + workspace revision + the route that owns the origin document. Public-API limits: `WorkspaceEdit.entries()`
lists text edits only; a resource the edit's `size` counts but `entries()` does not list is refused as
`ResourceOperation` — but VS Code 1.90 computes `size` as `entries().length`, so file and snippet operations stay
invisible. Therefore a rename inside a string literal (a module path, where the TypeScript provider adds a file
rename) is refused as `PossibleFileOperation`, and anything not listed is never applied (Refyntra builds its own text
edit). VS Code answers `[]`/an empty edit both without a provider and without a symbol; the adapter
probes document symbols to report `ProviderUnavailable` vs `ProviderEmpty`.

- **`RelatedResult.scopeDetails`** (optional, additive; protocol-v1.md). The protocol adapter keeps it only when it is
  well formed (`isScopeDetails`), otherwise it is dropped and the Related view falls back to `scopeNotes`. With
  details, the view shows plain-language lines (`packages/extension/src/scopePresentation.ts`): nothing when every
  project loaded completely; one *Results may be incomplete* warning with the cause, **Run dotnet restore** (trusted
  workspace, `refyntra.runRestore` with `solutionPath`) and **Show Health** otherwise; one line per framework whose
  version is not verified (assembly identities only in its tooltip); raw `scopeNotes` are not shown. Notes added by framework
  adapters on the client (`RelatedView.additionalNotes`) are always shown.
