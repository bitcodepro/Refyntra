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
