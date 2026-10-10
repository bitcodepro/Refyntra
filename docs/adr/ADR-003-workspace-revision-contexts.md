# ADR-003: Workspace revision, contexts, barriers, read set and restart epoch

Status: Accepted (alpha baseline)

## Context

Editor buffers change continuously while the host answers asynchronously. Results or previews computed from an old state are wrong, and a restarted host loses its overlay of open buffers.

## Decision

- The host keeps an overlay of open buffers, updated by `textDocument/*` notifications with a client-side sequence number.
- Before each semantic request the client calls `workspace/snapshotBarrier`, which returns `snapshotId` and `workspaceRevision` after all earlier events are applied; the request names that snapshot.
- The host has a `sessionEpoch` that changes on every start. A request naming a non-current snapshot or epoch fails with `StaleSnapshot`.
- Project and target contexts (project, TFM) are explicit in results.
- A future edit plan records a read set (including inputs that are not edited, and absences) and is invalidated when any input, context, epoch or provider changes.
- After a restart the client replays open documents.

## Consequences

- Stale answers are rejected instead of shown as current.
- The client tracks a monotonically increasing document event sequence.
- Restart is recoverable without user action but visible in health status.
- Cost: one extra round trip per semantic request; latency is measured and kept low.

## Rejected alternatives

- Best-effort answers from the latest state without versioning: silent staleness.
- Locking the editor during requests: unacceptable UX.
- Filesystem-only view without overlay: wrong for unsaved buffers.

## Revisit criteria

If barrier latency dominates request time, or when multi-root or multi-host workspaces need a different revision model.
