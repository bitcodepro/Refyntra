# ADR-002: Semantic ownership, provider routing and delegated guarantees

Status: Accepted (alpha baseline)

## Context

Answers come from different sources: Roslyn, framework heuristics, and later other VS Code language providers. Users must know how far to trust each answer, and a guess must never authorize an edit.

## Decision

Every capability has one semantic owner and a declared guarantee:

- `owned-semantic`: answered by Roslyn from symbol identity.
- `delegated`: answered by another provider; Refyntra adds no guarantee of its own.
- `heuristic`: pattern based; shown with evidence and limits.

Routing picks the owner by language and capability. Heuristic and delegated results are labelled in the UI and are not a basis for edits. Incomplete knowledge (unknown, dynamic, metadata-only) is reported, not hidden.

## Consequences

- Result models carry origin, evidence and scope limits.
- Same-name types in different namespaces or projects are distinct; negative fixtures are required.
- An unavailable action is shown with a reason instead of silently missing.
- Delegated capabilities depend on the installed provider and are described that way.

## Rejected alternatives

- Merging all sources into one unlabelled list: hides guarantee differences.
- Name-based matching as the primary identity: wrong for same-name types.
- Reimplementing other languages' semantics: out of scope.

## Revisit criteria

When a second language adapter is added, when a heuristic is promoted to semantic, or when usability sessions show the guarantee labels are misunderstood.

## Amendment (2026-10): Refyntra-run language servers for Python and Rust

Status: Accepted

### Context

Python and Rust were delegated to the providers of separately installed extensions (a Python language extension,
the rust-analyzer extension). Refyntra must not depend on any VS Code extension other than what is built into VS Code.

### Decision

- Python and Rust are served by language servers that ship **inside** Refyntra and run as Refyntra's own processes:
  Pyright (npm `pyright`, pinned, run on VS Code's own Node runtime) and rust-analyzer (official release binary per
  platform, pinned and SHA-256 verified at packaging time, shipped in platform-specific VSIX packages). TypeScript and
  JavaScript stay on VS Code's built-in features through public provider commands (unchanged).
- The client is Refyntra's own small LSP client in `infrastructure` (on the existing Content-Length framing and JSON-RPC
  peer, supervised process with process-tree kill). It never registers VS Code providers and does not use
  `vscode-languageclient`. The adapter (`@refyntra/adapter-lsp`) sees only the application's `LspConnection` port.
- **Route ownership stays `delegated`.** The semantic engine is still third-party; Refyntra does not compute or verify
  the meaning of the results. A new ownership value (e.g. `owned-lsp`) was rejected: it would suggest a guarantee
  Refyntra cannot give, and every consumer of `ownership`/`guarantee` would need a third case for no user-visible
  difference. What changes is the **strength of the validation**, recorded per plan:
  - Refyntra owns the process (trust gate: never started in Restricted Mode; lazy start; restart with backoff;
    shutdown/exit; process-tree kill) and the server's view of open documents (it sends didOpen/didChange/didClose
    itself; versions are the application's monotonic document sequence).
  - A result computed while the workspace revision or the server session changed is dropped (stale, retried).
  - A rename plan carries `serverSession` (server, version, `processOwner: 'refyntra'`, the document versions the edit
    was computed on). A `TextDocumentEdit` for another version is refused; edits on closed files must replace the old
    name in the text read from disk. Before apply the same session is asked again and must return identical edits on
    identical fingerprints and identical document versions. Validation stays `limited`, compilation delta `not-run`.
  - File operations in a rename edit (create/rename/delete) are refused in this version.
- Restricted Mode: no server is started for either language (rust-analyzer runs cargo, build scripts and proc-macros;
  Pyright reads project configuration and may run an interpreter for search paths).
- Rust needs the user's Rust toolchain (`cargo`) for the Cargo project model, as C# needs the .NET SDK. Without it the
  route is `Partial` (`CargoNotFound`) and Health explains it; nothing is installed or downloaded at run time.

### Consequences

- The VSIX is platform specific (rust-analyzer is native); a package for an unpinned platform carries no rust-analyzer
  and reports `ServerNotFound` for Rust.
- Package size grows by Pyright (~6.5 MiB unpacked incl. standard-library stubs) and one rust-analyzer binary
  (~37 MiB unpacked); see the support matrix.
- Third-party notices include Pyright (MIT), typeshed (Apache-2.0, parts MIT) and rust-analyzer (MIT OR Apache-2.0)
  with their license texts.
