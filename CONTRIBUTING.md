# Contributing

Refyntra is alpha. Thanks for helping; please keep changes small and verifiable.

## Principles

- **Small PRs**: one verifiable capability or one safety invariant per PR.
- **Tests before and after**: show the failing or missing test first, then the change that makes it pass.
- **Negative cases are required**: same-name types, unsupported forms, cancellation, stale results, and "no result" must be covered, not only the happy path.
- **No overclaiming**: documentation and UI must describe what is tested. If unsure, say "not verified".
- Don't mix refactors with behavior changes.

## Architecture rules

- `packages/domain` and `packages/application` never import `vscode`. Only `packages/extension` (presentation and composition root) does.
- `packages/contracts` holds schemas, DTOs and fixtures; it must not contain Roslyn-specific types.
- Protocol changes: update `docs/architecture/protocol-v1.md`, the TypeScript contracts and the C# DTOs together, with **contract tests on both sides**.
- No loading of code from workspace manifests; backend responses are untrusted input.
- Do not create empty packages for future features.
- Significant decisions need an ADR in `docs/adr/`.

These rules are enforced by `pnpm test:architecture`.

## Setup and checks

Requirements: .NET SDK from `global.json`, Node.js 22, pnpm (via corepack).

```
pnpm install --frozen-lockfile
pnpm -r run build
pnpm test:unit
pnpm test:architecture
dotnet test src/dotnet/Refyntra.sln -c Release
```

Pin dependencies and commit lockfiles. Do not add dependencies with postinstall binary downloads.

