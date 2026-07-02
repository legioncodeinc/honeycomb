# PRD-066d: Verification Hardening And Upgrade Smoke

> **Status:** Backlog
> **Parent:** PRD-066
> **Priority:** P0
> **Effort:** S
> **Created:** 2026-06-29

## Overview

PRD-066 proved the local queue can remove idle DeepLake coordination reads for local-only work, but
the current live idle-meter proof has a hidden reliability problem: its shared-queue baseline calls
the real DeepLake-backed `memory_jobs` discovery path in the operator's active workspace. That path
can scan an append-only table with unbounded historical rows, then resolve each observed job id. In a
busy or long-lived workspace, the baseline can exceed the test timeout before the local-queue proof
is even evaluated.

This add-on hardens PRD-066 verification so the test suite measures the intended behavior without
depending on the size or history of a real user's shared queue table. It also promotes the manually
verified daemon boot/upgrade check into a repeatable smoke: a built daemon must create and reopen the
local operational databases under `.daemon/`.

## Problem

The current `tests/integration/local-queue-idle-meter-live.itest.ts` mixes two concerns:

1. Proving the old shared DeepLake queue produces coordination reads.
2. Proving the new local queue produces zero DeepLake coordination reads while idle.

The first concern is currently measured against the canonical live `memory_jobs` table. That is the
same expensive unbounded coordination path PRD-066 is trying to avoid. When the table is large, the
baseline `lease(["summary"])` can hang or time out, making the PRD-066 gate flaky and obscuring the
actual local-queue result.

Separately, the implementation now relies on local SQLite files (`.daemon/logs.db` and
`.daemon/local-queue.db`) being created during daemon startup. This was manually verified with the
built daemon, but there is not yet a committed smoke that proves first boot and reopen behavior.

## Goals

- Make the PRD-066 live idle-meter proof bounded, deterministic, and independent of the operator's
  production-like `memory_jobs` history.
- Preserve a real live DeepLake baseline, but run it against a throwaway job table with bounded rows.
- Keep the local-queue idle assertion strict: empty local queue means zero DeepLake coordination reads
  and writes.
- Add a production-style daemon boot smoke that verifies `.daemon/logs.db` and
  `.daemon/local-queue.db` are created and can be reopened.
- Produce enough step-level timing and receipt output to identify where a future live run stalls.

## Non-Goals

- Rebuild the PRD-066 local queue implementation.
- Change the local job schema.
- Change DeepLake memory, recall, vector, or graph behavior.
- Remove the old shared queue path.
- Claim multi-device or hosted-control-plane readiness.
- Convert this into a QA report; QA evidence remains owned by QA artifacts.

## Scope

- Add a test-only way to configure the DeepLake-backed job queue table name used by daemon assembly.
- Update the PRD-066 live idle-meter test so the shared baseline uses a per-run throwaway DeepLake
  job table, not the canonical `memory_jobs` table.
- Add cleanup for all throwaway DeepLake tables created by the live verification.
- Add per-phase timing/log receipts around shared start, shared lease, local start, local lease, and
  active local memory work.
- Add a committed smoke or integration test that boots the built daemon with a temporary
  `HONEYCOMB_WORKSPACE` and local queue enabled, checks DB creation, stops it, boots again, and checks
  reopen behavior.
- Inspect the created SQLite files enough to prove schema initialization, not merely file creation.

## Functional Requirements

1. Daemon assembly must support a test-only shared job queue table override.
2. Production daemon assembly must continue to use the canonical `memory_jobs` table by default.
3. The live shared-queue baseline must create and use a per-run table named with a clear test prefix.
4. The live shared-queue baseline must not scan or mutate the operator's canonical `memory_jobs`
   table.
5. The live shared-queue baseline must bound its seeded data set so `lease(["summary"])` completes
   within the configured test budget.
6. The local-queue idle proof must still run against the real local queue path and assert zero
   DeepLake `poll-lease` and `poll-reaper` reads/writes.
7. The active local-queue memory pipeline proof must still show real DeepLake reads/writes for actual
   memory/graph work while showing zero DeepLake coordination reads/writes.
8. The daemon boot smoke must run the built daemon entry, not only in-process TypeScript assembly.
9. The daemon boot smoke must use a temporary `HONEYCOMB_WORKSPACE`, disable embeddings/pollinating
   side effects, and enable the local queue.
10. The daemon boot smoke must verify `.daemon/logs.db` and `.daemon/local-queue.db` exist after
    first boot.
11. The daemon boot smoke must verify `logs.db` contains the durable log tables and
    `local-queue.db` contains the `local_job` table.
12. The daemon boot smoke must stop and restart against the same temporary workspace and prove the
    daemon answers `/health` after reopening the existing DBs.
13. All temporary processes, files, and DeepLake tables created by these tests must be cleaned up on
    success and best-effort cleaned up on failure.

## Acceptance Criteria

- AC-1: The live idle-meter test no longer calls shared queue lease/discovery against the canonical
  `memory_jobs` table.
- AC-2: The shared baseline emits a receipt with bounded-table poll reads greater than zero.
- AC-3: The local idle path emits a receipt with `local_poll_reads=0` and `local_poll_writes=0`.
- AC-4: The active local memory pipeline proof emits a receipt with `poll_reads=0`,
  `poll_writes=0`, and non-zero total DeepLake writes.
- AC-5: A timeout in any live idle-meter phase reports the phase name and elapsed time.
- AC-6: A built-daemon boot smoke proves first boot creates `.daemon/logs.db` and
  `.daemon/local-queue.db`.
- AC-7: The built-daemon boot smoke proves `logs.db` has `event_log` and `request_log`, and
  `local-queue.db` has `local_job`.
- AC-8: The built-daemon boot smoke proves a second boot against the same workspace answers
  `/health` without schema or migration failure.
- AC-9: `npm run smoke:golden-path` and `npm run eval:recall` remain unaffected by the test-only
  queue table override.
- AC-10: `npm run typecheck`, focused local/hybrid queue tests, the PRD-066 live idle-meter test, and
  the new daemon boot smoke all pass before PRD-066 is considered releasable.

## Implementation Notes

### Shared Queue Table Override

Add the narrowest possible test seam for the DeepLake-backed job queue table name. Preferred shape:

- Extend `AssembleDaemonOptions` with an optional `jobQueueConfig` or `jobQueueTableName`.
- Thread the option into `createJobQueueService({ config: { tableName } })`.
- Do not expose this as a user-facing environment variable unless a separate product reason emerges.
- Keep production behavior byte-identical when the option is absent.

The local queue already accepts a local `baseDir` through `HONEYCOMB_WORKSPACE`; this add-on should
not change local queue storage behavior.

### Bounded Live Idle Meter

The live idle-meter test should:

1. Generate a run id.
2. Create a per-run shared queue table name, for example `ci_066d_<run>_jobs`.
3. Boot the shared-mode baseline daemon with the shared queue table override.
4. Ensure the table exists through the queue's own write/heal path.
5. Reset the query meter.
6. Call `lease(["summary"])` against the bounded table.
7. Assert `poll-lease` reads are greater than zero.
8. Drop the per-run table in `finally`.
9. Boot the local queue mode without draining shared local kinds.
10. Reset the query meter.
11. Call `lease(["summary"])`.
12. Assert `poll-lease` and `poll-reaper` reads/writes are zero.

This keeps the before/after proof honest without letting the "before" path inherit unlimited
workspace history.

### Built Daemon Upgrade Smoke

Add either a script such as `scripts/local-queue-upgrade-smoke.mjs` or a gated integration test that:

1. Builds or uses the built `daemon/index.js`.
2. Creates a temporary workspace.
3. Starts `node --experimental-sqlite daemon/index.js` with:
   - `HONEYCOMB_WORKSPACE=<temp>`
   - `HONEYCOMB_LOCAL_QUEUE_ENABLED=true`
   - `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED=false`
   - `HONEYCOMB_EMBEDDINGS=false`
   - `HONEYCOMB_POLLINATING_ENABLED=false`
   - an ephemeral daemon port
4. Waits for `/health`.
5. Verifies the DB files exist.
6. Opens each SQLite DB and verifies expected tables.
7. Stops the process.
8. Starts the daemon again against the same workspace.
9. Verifies `/health` again.
10. Stops the process and cleans the temp workspace.

The smoke should not require live DeepLake credentials. It proves local operational state creation and
reopen behavior, not memory write behavior.

## Verification Matrix

| Scenario | Expected Result |
| --- | --- |
| Shared baseline with bounded table | `poll-lease` reads are greater than zero and test completes inside budget |
| Shared baseline with canonical table | Not used by PRD-066 live proof |
| Local queue idle with empty local queue | `poll-lease` and `poll-reaper` reads/writes are zero |
| Local queue active memory pipeline | Real DeepLake memory/graph writes occur; coordination reads/writes remain zero |
| Built daemon first boot | `/health` answers and both local DB files are created |
| Built daemon second boot, same workspace | `/health` answers and existing DB schema reopens cleanly |
| Smoke failure | Process is stopped and failure output includes phase, elapsed time, and log path |

## Test Plan

- Unit:
  - focused test proving the job queue table override is threaded into the shared queue.
  - focused test proving absent override preserves canonical `memory_jobs`.
- Integration:
  - updated `tests/integration/local-queue-idle-meter-live.itest.ts` using a bounded per-run shared
    queue table.
  - active local memory pipeline proof retained.
- Smoke:
  - new built-daemon local queue upgrade smoke for DB creation and reopen behavior.
- Regression:
  - `npm run typecheck`
  - `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts tests/daemon/runtime/services/hybrid-job-queue.test.ts`
  - `npx vitest run --config vitest.integration.config.ts tests/integration/local-queue-idle-meter-live.itest.ts`
  - new daemon boot smoke command
  - `npm run smoke:golden-path`
  - `npm run eval:recall` when the embed daemon is available

## Risks And Mitigations

- **Risk:** A test-only table override leaks into production configuration.
  **Mitigation:** Keep the seam as an in-process assembly option, not an environment variable.
- **Risk:** The bounded shared baseline becomes too artificial and stops proving the old path touched
  DeepLake.
  **Mitigation:** Use the real DeepLake queue service and real query meter; only bound the table size.
- **Risk:** The built-daemon smoke flakes because the daemon port is already in use.
  **Mitigation:** allocate an ephemeral high port and include the port in failure output.
- **Risk:** SQLite inspection fails on Node versions without `node:sqlite`.
  **Mitigation:** run the smoke with the same `--experimental-sqlite` flag used by daemon service
  startup and fail with an explicit runtime message.

## Open Questions

- Should the built-daemon local queue upgrade smoke be a standalone `npm run smoke:local-queue` command
  or part of `smoke:daemon-bundle`?
- Should the PRD-066 live idle-meter report be regenerated after this add-on lands, replacing the
  earlier canonical-table baseline receipt?
- Should future hosted-control-plane work reuse the same bounded shared-queue verification pattern for
  migration drain tests?

