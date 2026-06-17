# PRD-004b: Durable Job Queue

> **Parent:** [PRD-004](./prd-004-daemon-runtime-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the durable `memory_jobs` queue on DeepLake with a lease/complete/fail/dead lifecycle, exponential backoff, bounded retries, and a stale-lease reaper, so background distillation, summaries, and skillify survive a daemon restart. The queue is a `USING deeplake` table written only by the daemon on port 3850, consistent with the storage write patterns: append-only and version-bumped writes that sidestep the UPDATE-coalescing quirk, hand-escaped SQL, and lazy schema healing.

## Goals

- Declare and operate the `memory_jobs` queue so a crash mid-job does not lose the work.
- Provide lease semantics: exactly one worker holds a job until the lease expires or it completes/fails.
- Bound retries with exponential backoff and transition exhausted jobs to `dead` rather than retrying forever.
- Reap stale leases so a crashed worker does not strand a job.

## Non-Goals

- The pipeline stages that enqueue and process jobs (PRD-006).
- The summary and skillify workers that consume queued jobs (product/AI modules).
- The HTTP route surface (PRD-004a); the queue is an internal daemon service.
- The storage adapter primitives (PRD-002).

## User stories

- As a daemon worker, I want a durable leased queue so a crash mid-job does not lose the work.
- As the pipeline, I want enqueued distillation jobs to survive a daemon restart so a reboot resumes rather than drops work.
- As an operator, I want jobs that fail repeatedly to land in `dead` so a poison job does not loop forever.

## Functional requirements

- FR-1: The catalog defines `memory_jobs` with `id`, `type`, a JSONB `payload`, `status` (`queued`, `leased`, `done`, `failed`, `dead`), `lease_owner`, `lease_expires_at`, `attempts`, `max_attempts`, `next_run_at`, `last_error`, `created_at`, `updated_at`.
- FR-2: Leasing atomically selects the oldest `queued` (or backoff-ready `failed`) job whose `next_run_at` has passed, sets `status = 'leased'`, `lease_owner`, and `lease_expires_at`, and returns it to exactly one worker.
- FR-3: Completing a job advances `status = 'done'`; failing increments `attempts`, records `last_error`, computes `next_run_at` via exponential backoff, and returns it to `failed`/`queued` if attempts remain.
- FR-4: A job whose `attempts` reaches `max_attempts` transitions to `dead` and is no longer leased.
- FR-5: A stale-lease reaper periodically finds `leased` jobs whose `lease_expires_at` has passed and returns them to `queued` within their retry bounds.
- FR-6: All writes use the DeepLake append/version patterns and the daemon escaping helpers; the table is created on first write from its column-definition array and healed on a missing column.
- FR-7: Backoff schedule and lease duration are configurable with sane defaults (for example a base backoff doubling per attempt, capped, and a lease measured in minutes).
- FR-8: The queue survives a daemon restart: on boot the daemon resumes leasing `queued` jobs and reaping leases left dangling by the prior process.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a queued job, when a worker leases it, then no other worker can lease it until the lease expires or it is completed/failed. |
| AC-2 | Given a job that fails repeatedly, when it exceeds its retry bound, then it transitions to `dead` rather than retrying forever. |
| AC-3 | Given a worker leases a job and crashes, when the reaper interval elapses, then the stale lease is reclaimed and the job becomes leasable again within its retry bounds. |
| AC-4 | Given a failed job with attempts remaining, when it is retried, then `next_run_at` reflects exponential backoff before it becomes leasable. |
| AC-5 | Given the daemon restarts, when it boots, then queued jobs resume and leases dangling from the prior process are reaped. |
| AC-6 | Given the `memory_jobs` table does not exist, when the first enqueue runs, then it is created from its column-definition array and the write retries once. |
| AC-7 | Given a completed job, when it ages past the completion window, then retention purges it while dead jobs are retained longer. |

## Implementation notes

- Daemon modules: a queue service owns lease/complete/fail/dead transitions and the reaper loop; the schema definition module owns the `memory_jobs` column-definition array.
- DeepLake write patterns: leasing and status transitions are written as bounded UPDATE-or-INSERT-by-id touches; because the UPDATE-coalescing quirk risks two rapid touches, the lease check re-reads `lease_owner`/`lease_expires_at` after write to confirm ownership before a worker proceeds.
- Default backoff doubles per attempt from a base with a cap; lease duration defaults to a few minutes, both configurable.
- Edge cases: a poison payload that always throws walks to `dead` after `max_attempts`; a reaper and a fresh lease racing the same job are made observable by the post-write ownership re-read.
- Failure handling: missing-table or missing-column writes heal and retry once; storage unavailable pauses leasing rather than marking jobs failed.
- In-process versus separate worker (parent open question): the queue service runs in the daemon process; workers are daemon-owned, not spawned loosely from hooks.

## Dependencies

- PRD-002 storage adapter and SQL helpers.
- PRD-003a `memories` / `memory_history` (distillation jobs write these).
- PRD-006 memory pipeline (primary producer and consumer).

## Open questions

- [ ] What is the default `max_attempts` and backoff cap per job type?
- [ ] Should dead jobs surface in `/api/diagnostics` for operator triage automatically?

## Related

- [parent index](./prd-004-daemon-runtime-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
