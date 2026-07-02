# PRD-066a: Local Queue Store

> **Status:** Backlog
> **Parent:** PRD-066
> **Priority:** P0
> **Effort:** M

## Overview

Create the daemon-local durable queue used for local-only Honeycomb work. This gives the daemon a
cheap, restart-safe place to store jobs without asking DeepLake whether local work exists.

The store should live under the daemon runtime directory, for example `.daemon/local-queue.db`, and
should be treated as local operational state rather than shared memory state.

## Scope

- Define the local queue interface.
- Create the local queue persistence schema.
- Implement enqueue, lease, complete, fail, retry, expired-lease recovery, and retention pruning.
- Validate job payloads per job kind.
- Ensure the queue does not store secrets.
- Provide test helpers for deterministic clock and lease behavior.

## Non-Goals

- Migrate daemon workers to the queue.
- Replace DeepLake memory rows, embeddings, vector search, or recall data.
- Implement cross-device shared queue semantics.
- Add cloud control-plane behavior.

## Functional Requirements

1. The queue must support durable enqueue with `kind`, `payload`, `priority`, `run_after`, and
   retry policy fields.
2. The queue must lease the next runnable job with single-winner semantics.
3. The queue must mark jobs complete without leaving runnable duplicates.
4. The queue must record failed attempts and schedule retry using `run_after`.
5. The queue must mark exhausted jobs as failed with an error class.
6. The queue must reclaim expired leases.
7. The queue must prune completed jobs according to a configurable retention window.
8. The queue must expose lightweight counts by status and kind for diagnostics.
9. Queue payloads must be validated before enqueue and before handler execution.
10. Queue files must be created in the daemon runtime directory with restrictive permissions where
    supported.

## Acceptance Criteria

- AC-1: Enqueued jobs are still present after daemon process restart.
- AC-2: Two concurrent lease attempts cannot successfully lease the same job.
- AC-3: A leased job is invisible to other lease attempts until it completes or expires.
- AC-4: An expired lease can be reclaimed and retried.
- AC-5: Completed jobs are pruned after the configured retention window.
- AC-6: Invalid payloads are rejected before entering the queue.
- AC-7: Payloads containing known secret-like fields are rejected or redacted according to the final
  implementation policy.
- AC-8: Unit tests cover enqueue, lease, complete, retry, expired lease, exhausted retry, and prune
  behavior.

## Technical Notes

- Prefer SQLite if the repo already has a suitable local database pattern or dependency.
- Use an injectable clock in tests.
- Keep the public queue API small enough that worker migration can remain mechanical.
- Keep SQL operations transactional for lease and completion paths.
- Treat file corruption as a recoverable local fault: quarantine the broken queue file, emit a
  diagnostic event, and fall back only if an explicit compatibility flag permits it.

## Open Questions

- Should the queue use one table for all job kinds or separate payload tables for high-volume kinds?
- What is the default completed-job retention period?
- Should failed jobs remain indefinitely for support inspection, or be pruned separately?

