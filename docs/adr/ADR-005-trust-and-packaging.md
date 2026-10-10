# ADR-005: Trust, executable project tooling and packaging

Status: Accepted (alpha baseline)

## Context

Loading a C# project through MSBuild can execute project code (tasks, generators, analyzers), and package restore can use the network. Workspace Trust is not an OS sandbox. The VSIX must not rely on a developer checkout for missing payload.

## Decision

- In Restricted Mode the extension may discover files and show UI, but sends `workspace/open` only with `trusted: true`; otherwise the host answers `TrustRequired`.
- No automatic restore or build. Recovery messages name the command and its consequences. The SDK is never downloaded automatically.
- Processes start without shell interpolation, with arguments as an array.
- The VSIX contains extension JS, schemas and the .NET host payload. Framework-dependent vs self-contained is decided by a spike; the MSBuild BuildHost payload is verified separately.
- No telemetry and no network access for normal navigation.
- Third-party notices and an SBOM are generated from lockfiles. MediatR is a test-fixture dependency only and is not in the VSIX.

## Consequences

- Restricted Mode users get an explanation instead of a failure.
- Install smoke runs the packaged host from a path with spaces and non-ASCII characters in a clean profile.
- A release requires license, notices and payload review.
- Users need a compatible .NET SDK installed.

## Rejected alternatives

- Automatic restore/build for diagnostics: runs project code and network access without consent.
- Treating Workspace Trust as a sandbox: it is not one.
- Assuming single-file publish includes MSBuild tooling: not guaranteed.
- Bundling an SDK: size and licensing burden.

## Revisit criteria

If self-contained deployment proves smaller or safer than requiring an SDK, or if an OS-level sandbox for the host becomes feasible.
