# ADR-006: Extension contracts and fake adapter acceptance

Status: Accepted (alpha baseline)

## Context

The product should gain frameworks and, later, languages without rewriting the UI or application core. An abstraction is only worth having if a second implementation proves it.

## Decision

- Contracts live in `packages/contracts` (schemas, DTOs, fixtures) and are fixed before independent implementations on two languages.
- Domain and application packages never import `vscode`.
- Only built-in, reviewed modules; nothing is loaded from project manifests. Rule configuration is data, not executable plugins.
- An extension point is accepted only when a fake adapter or fake framework plugs in through a conformance suite (`packages/adapter-testing`) that catches stale results, cancellation, malformed results and route changes.
- Architecture rules are enforced by `pnpm test:architecture`.

## Consequences

- New adapters have a documented acceptance test.
- Contract changes need tests on both the TypeScript and C# sides.
- Fake fixtures do not prove third-party library support; real fixtures are required.
- No empty future packages are created in advance.

## Rejected alternatives

- Loading plugins from workspace files: arbitrary code execution.
- Speculative abstraction layers without a second implementation.
- Shared DTOs containing Roslyn-specific types: couples clients to the host.

## Revisit criteria

When the first real third-party adapter is requested, or when the conformance suite misses a regression found in real use.
