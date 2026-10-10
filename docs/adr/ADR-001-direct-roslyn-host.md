# ADR-001: Direct extension to Roslyn host

Status: Accepted (alpha baseline)

## Context

Refyntra needs C# semantics (symbols, references, implementations, rename). Roslyn owns C# semantics. The product must work locally, keep its own code MIT-licensed, and reach a useful navigation alpha before investing in coordination infrastructure.

Pinned baseline:

- .NET SDK 10.0.300 (`global.json`, `rollForward: latestFeature`)
- Roslyn (Microsoft.CodeAnalysis) 5.9.0
- Microsoft.Build.Locator 1.11.2
- MediatR 12.5.0 (Apache-2.0), used only in test fixtures, never bundled
- pnpm workspaces, TypeScript 5.9, esbuild, vitest
- First target: Windows x64 Desktop

## Decision

The VS Code extension (TypeScript) talks directly to one separate .NET host process that embeds Roslyn and loads projects with MSBuildWorkspace via Microsoft.Build.Locator. Transport is JSON-RPC 2.0 over stdio (see `docs/architecture/protocol-v1.md`). The coordination layer (`packages/application`) is plain TypeScript and does not import `vscode`.

## Consequences

- One hop between extension and Roslyn: fewer moving parts to package and debug.
- The extension owns the host lifecycle: start, health, restart, replay of open documents, process-tree shutdown.
- The host needs an installed .NET SDK; MSBuild comes from it and is not bundled.
- Protocol changes need contract tests on both the TypeScript and C# sides.
- Only Windows x64 is planned for the alpha; nothing is promised for other platforms.

## Rejected alternatives

- A Rust or Node coordinator process between extension and host: extra process and protocol without demonstrated need.
- Reusing C# Dev Kit or its Roslyn language server through private APIs: not a public, stable contract.
- Writing our own parser or type checker: out of scope; Roslyn already owns the semantics.
- Using LSP as the product protocol: too generic for snapshot barriers and plan/preview semantics.

## Revisit criteria

Introduce an external coordinator only if (a) several hosts or languages need shared coordinated state, (b) in-extension coordination measurably blocks the Extension Host, or (c) a second client (CLI/CI) needs the same application layer. Revisit the SDK and Roslyn pins if the loader or packaging gate becomes unstable.
