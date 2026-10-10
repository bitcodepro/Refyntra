# Security policy

Refyntra is alpha software. This document describes the trust model and how to report problems.

## Trust model

- **Workspace Trust is required to load projects.** Loading a C# solution evaluates MSBuild, which can run project-defined tasks, source generators and analyzers, and spawn subprocesses. Refyntra does this only in trusted workspaces. In Restricted Mode it does not start project evaluation.
- **Trust is not a sandbox.** Once the workspace is trusted, project code that MSBuild evaluates runs with your user permissions.
- **No automatic restore or build.** Package restore can access the network and run project code. Refyntra never runs it for you; it shows the command instead.
- **No automatic SDK download or install.**
- **Local only.** No telemetry, no network requests for navigation, no AI services. Source text is not written to logs, and nothing is sent anywhere without an explicit user action.
- **Backend responses are untrusted.** Edits proposed by the host are validated by the extension (URI scheme, path traversal, symlink aliases, size limits) before they can be applied.
- **No plugin loading from workspaces.** Only built-in modules run; project files cannot cause code to be loaded, trust to change or commands to run.
- **Processes** are started without a shell, with arguments as separate values.
- **Bundled language servers (Python, Rust).** Pyright and rust-analyzer ship inside the extension (pinned versions; rust-analyzer verified against a committed SHA-256 at packaging time; nothing is downloaded at run time) and are started only in trusted workspaces: rust-analyzer runs `cargo`, build scripts and proc-macros of the project, Pyright reads project configuration and may query a Python interpreter for search paths. The servers can never edit files: `workspace/applyEdit` is refused, and their rename edits pass the same preview and EditApplier checks as every other plan. Refyntra uses the bundled binaries only, never a `rust-analyzer` or `node` from `PATH`.

## Supported versions

Alpha: only the latest build from the main branch.

## Reporting a vulnerability

Please report privately and do not open a public issue.

Contact: TODO(maintainer): add a private contact (security email or GitHub private vulnerability reporting link).

Include the version, steps to reproduce, and impact. Do not include proprietary source code.
