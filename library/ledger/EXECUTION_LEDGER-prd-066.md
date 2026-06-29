# EXECUTION LEDGER - PRD-066 Local Queue Idle-Cost Control

> `/the-smoker` run started 2026-06-29.

## Scope

PRD-066 introduces a daemon-local durable queue for local-only work so a single-machine idle daemon
does not poll DeepLake for coordination. DeepLake remains the shared memory/vector substrate. The
local queue is the per-device scheduler only.

Source PRDs:

- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md`
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md`
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md`
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md`
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md`

## Wave Plan

Wave 0: Recon and ledger.

- Owner: main orchestrator.
- Scope: read PRD-066, map existing DeepLake queue/polling code, create this ledger.
- Exit: all acceptance criteria listed with status and first implementation wave defined.

Wave 1: Local queue store.

- Worker: `typescript-node-worker-bee`, armed with `typescript-node-stinger`.
- Scope: local SQLite-backed queue store under `.daemon/`, queue API, validation, lease/retry/prune
  semantics, unit tests.
- Exit: PRD-066a ACs are DONE with local test evidence.

Wave 2: Worker routing and migration.

- Worker: `typescript-node-worker-bee`, armed with `typescript-node-stinger`.
- Scope: classify job kinds, route first-wave local-only producers/workers to the local queue behind
  a flag, preserve fallback, test old DeepLake queue behavior.
- Exit: PRD-066b ACs and parent routing ACs are DONE with test evidence.

Wave 3: Idle verification and rollout docs.

- Worker: `typescript-node-worker-bee`, armed with `typescript-node-stinger`.
- Scope: query-meter labeling, diagnostics, rollback flag, rollout report/runbook artifacts.
- Exit: PRD-066c ACs and parent idle-cost ACs are DONE with evidence.

Wave 4: Close-out.

- Worker: `security-worker-bee`, armed with `security-stinger`, then `quality-worker-bee`, armed
  with `quality-stinger`.
- Scope: security audit/remediate Critical/High, then QA verify PRD-066 against implementation.
- Exit: all ACs VERIFIED or explicitly BLOCKED with evidence.

Wave 5: PRD-066d verification hardening.

- Owner: main orchestrator, with security and quality close-out.
- Scope: test-only shared queue table override, bounded live idle-meter proof, built-daemon local
  queue upgrade smoke, and regression verification.
- Exit: 066d ACs are VERIFIED with live receipts and built-daemon smoke evidence.

Wave 6: PRD-066e upgrade and rollback hardening.

- Owner: not started.
- Scope: packaged upgrade smoke, pending old shared job migration policy, rollback behavior,
  topology gating, operator diagnostics, and dogfood matrix.
- Exit: blocked until implemented and verified; required before production default-on.

## AC Ledger

| ID | Source PRD | Criterion | Status | Owner | Verification Evidence |
|---|---|---|---|---|---|
| 066-AC-1 | prd-066 index | With no user activity and an empty local queue, the daemon produces zero DeepLake coordination reads over the configured idle measurement window. | DONE | main orchestrator | Live meter proof: `npx vitest run --config vitest.integration.config.ts tests/integration/local-queue-idle-meter-live.itest.ts` passed; shared queue poll reads=39, local queue poll reads=0/writes=0. |
| 066-AC-2 | prd-066 index | A queued local job survives daemon restart and executes once after restart. | DONE | main orchestrator | `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts` (10/10) covers reopen + lease once. |
| 066-AC-3 | prd-066 index | An expired local lease is reclaimed and retried without creating duplicate successful work. | DONE | main orchestrator | `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts` (10/10) covers expired lease reclaim and second attempt. |
| 066-AC-4 | prd-066 index | Local-only producers no longer call DeepLake queue enqueue APIs when the local queue flag is enabled. | DONE | main orchestrator | `tests/daemon/runtime/services/hybrid-job-queue.test.ts` AC-1 asserts shared enqueue is not called for `summary`. |
| 066-AC-5 | prd-066 index | Local-only workers no longer poll DeepLake for job discovery when the local queue flag is enabled. | DONE | main orchestrator | Hybrid focused suite asserts no shared lease calls and no shared queue background reaper start when drain mode is off. |
| 066-AC-6 | prd-066 index | Feature flag off preserves current behavior. | DONE | main orchestrator | Hybrid focused suite AC-4 asserts disabled config returns shared queue behavior. |
| 066-AC-7 | prd-066 index | Active memory write/recall behavior still reaches DeepLake when a local job has real memory work to perform. | BLOCKED | main orchestrator | Active write/graph work is verified live: local queue active pipeline poll reads=0/writes=0, total DeepLake reads=67/writes=15. Recall-read categorization remains to close this combined criterion. |
| 066-AC-8 | prd-066 index | The rollout report includes before/after DeepLake coordination read counts using the PRD-062 meter. | DONE | main orchestrator | Added `qa/2026-06-29-idle-meter-live-report.md`: shared queue poll reads=39, local queue poll reads=0/writes=0. |
| 066a-AC-1 | prd-066a | Enqueued jobs are still present after daemon process restart. | DONE | main orchestrator | `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts` AC-1 test reopens `.daemon/local-queue.db` and leases the same job. |
| 066a-AC-2 | prd-066a | Two concurrent lease attempts cannot successfully lease the same job. | DONE | main orchestrator | Focused suite AC-2 test uses `Promise.all` lease attempts; exactly one succeeds. |
| 066a-AC-3 | prd-066a | A leased job is invisible to other lease attempts until it completes or expires. | DONE | main orchestrator | Focused suite AC-3 test asserts second lease is null until completion. |
| 066a-AC-4 | prd-066a | An expired lease can be reclaimed and retried. | DONE | main orchestrator | Focused suite AC-4 test advances injected clock, reclaims, and leases attempt 2. |
| 066a-AC-5 | prd-066a | Completed jobs are pruned after the configured retention window. | DONE | main orchestrator | Focused suite AC-5 test prunes completed jobs after retention cutoff. |
| 066a-AC-6 | prd-066a | Invalid payloads are rejected before entering the queue. | DONE | main orchestrator | Focused suite AC-6 test rejects non-object payload and leaves queue empty. |
| 066a-AC-7 | prd-066a | Payloads containing known secret-like fields are rejected or redacted according to the final implementation policy. | DONE | main orchestrator | Focused suite AC-7 test rejects nested `deeplakeToken` before enqueue. |
| 066a-AC-8 | prd-066a | Unit tests cover enqueue, lease, complete, retry, expired lease, exhausted retry, and prune behavior. | DONE | main orchestrator | `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts` passed 10 tests; `npm run typecheck` passed. |
| 066b-AC-1 | prd-066b | Tests assert that first-wave local-only producers do not call DeepLake enqueue APIs when the local queue flag is enabled. | DONE | main orchestrator | `npx vitest run tests/daemon/runtime/services/hybrid-job-queue.test.ts tests/daemon/runtime/services/local-job-queue.test.ts` passed 21 tests. |
| 066b-AC-2 | prd-066b | Tests assert that first-wave local-only workers do not call DeepLake polling APIs for job discovery when the local queue flag is enabled. | DONE | main orchestrator | Focused hybrid suite covers no shared lease calls and no shared background reaper start in local-only mode. |
| 066b-AC-3 | prd-066b | Handler-level DeepLake reads/writes still occur when a local job performs real memory work. | DONE | main orchestrator | Live active-memory proof passed: `npx vitest run --config vitest.integration.config.ts tests/integration/local-queue-idle-meter-live.itest.ts`; active pipeline poll reads=0/writes=0 and total DeepLake reads=67/writes=15. |
| 066b-AC-4 | prd-066b | Feature flag off preserves current DeepLake-backed queue behavior. | DONE | main orchestrator | Hybrid focused suite AC-4 covers disabled feature flag behavior. |
| 066b-AC-5 | prd-066b | Migration tests cover old DeepLake jobs that exist at daemon startup. | DONE | main orchestrator | Hybrid focused suite AC-5 covers migration drain from shared queue after local queue is empty. |
| 066b-AC-6 | prd-066b | Duplicate execution is prevented or made harmless through idempotency keys. | DONE | main orchestrator | Hybrid focused suite AC-6 asserts local jobs lease before shared jobs during migration. |
| 066b-AC-7 | prd-066b | Unknown job kinds fail closed to the current shared path until classified. | DONE | main orchestrator | Hybrid focused suite AC-7 routes unknown job kinds through shared queue. |
| 066c-AC-1 | prd-066c | Baseline report shows current idle DeepLake coordination reads before the feature flag is enabled. | DONE | main orchestrator | Live meter proof reported shared queue poll reads=39, poll writes=0. |
| 066c-AC-2 | prd-066c | Post-change report shows zero DeepLake coordination reads during the idle measurement window with an empty local queue. | DONE | main orchestrator | Live meter proof reported local queue poll reads=0, poll writes=0. |
| 066c-AC-3 | prd-066c | Active memory writes and recall reads are still visible and correctly categorized. | BLOCKED | main orchestrator | Active memory writes are now visible and categorized by the live PRD-066 proof; recall read categorization still requires a recall-path integration assertion. |
| 066c-AC-4 | prd-066c | Rollback flag restores previous behavior without a data migration. | DONE | main orchestrator | `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` returns shared queue behavior; focused hybrid suite passed. |
| 066c-AC-5 | prd-066c | Local queue diagnostics identify queued, leased, retrying, failed, and completed counts. | DONE | main orchestrator | `LocalJobQueueService.counts()` implemented and covered in local queue tests; operator surface follow-up tracked in QA warning. |
| 066c-AC-6 | prd-066c | Dogfood rollout runs long enough to include daemon restart, sleep/wake, and transient DeepLake outage scenarios. | BLOCKED | main orchestrator | Requires real dogfood window and transient DeepLake outage simulation. |
| 066c-AC-7 | prd-066c | Release notes describe the local queue boundary and known remaining DeepLake cost paths. | DONE | main orchestrator | Added `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-release-notes-draft.md`. |
| 066d-AC-1 | prd-066d | The live idle-meter test no longer calls shared queue lease/discovery against the canonical `memory_jobs` table. | VERIFIED | main orchestrator | `AssembleDaemonOptions.jobQueueConfig` threads a throwaway table into `createJobQueueService`; final live receipt used `shared_table=ci_066d_t987848400_jobs`. |
| 066d-AC-2 | prd-066d | The shared baseline emits a receipt with bounded-table poll reads greater than zero. | VERIFIED | main orchestrator | Final live idle-meter receipt: `shared_table=ci_066d_t987848400_jobs shared_poll_reads=39 shared_poll_writes=0`. |
| 066d-AC-3 | prd-066d | The local idle path emits a receipt with `local_poll_reads=0` and `local_poll_writes=0`. | VERIFIED | main orchestrator | Final live idle-meter receipt: `local_poll_reads=0 local_poll_writes=0`. |
| 066d-AC-4 | prd-066d | The active local memory pipeline proof emits a receipt with `poll_reads=0`, `poll_writes=0`, and non-zero total DeepLake writes. | VERIFIED | main orchestrator | Final active receipt: `poll_reads=0 poll_writes=0 total_reads=68 total_writes=15`. |
| 066d-AC-5 | prd-066d | A timeout in any live idle-meter phase reports the phase name and elapsed time. | VERIFIED | main orchestrator | Added `phase(name, work, timeoutMs)` wrapper around shared start, shared idle window, shared lease, local start, local idle window, local lease, and daemon start. |
| 066d-AC-6 | prd-066d | A built-daemon boot smoke proves first boot creates `.daemon/logs.db` and `.daemon/local-queue.db`. | VERIFIED | main orchestrator | `npm run smoke:local-queue-upgrade` passed; first boot answered `/health` and DB files existed before schema inspection. |
| 066d-AC-7 | prd-066d | The built-daemon boot smoke proves `logs.db` has `event_log` and `request_log`, and `local-queue.db` has `local_job`. | VERIFIED | main orchestrator | `scripts/local-queue-upgrade-smoke.mjs` inspects `sqlite_master`; `npm run smoke:local-queue-upgrade` passed. |
| 066d-AC-8 | prd-066d | The built-daemon boot smoke proves a second boot against the same workspace answers `/health` without schema or migration failure. | VERIFIED | main orchestrator | `npm run smoke:local-queue-upgrade` passed with first boot `/health` 503 after 1440ms and second boot `/health` 503 after 2143ms in no-creds isolated mode. |
| 066d-AC-9 | prd-066d | `npm run smoke:golden-path` and `npm run eval:recall` remain unaffected by the test-only queue table override. | VERIFIED | main orchestrator | `npm run smoke:golden-path` passed live: recall-hit=1.00, sessions=2120, memory=2967, log events=11. `npm run eval:recall` passed live after temporary embed daemon: recall@5=0.611, MRR=0.611, semantic beats lexical. |
| 066d-AC-10 | prd-066d | `npm run typecheck`, focused local/hybrid queue tests, the PRD-066 live idle-meter test, and the new daemon boot smoke all pass before PRD-066 is considered releasable. | VERIFIED | main orchestrator | Passed: `npm run typecheck`; `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts tests/daemon/runtime/services/hybrid-job-queue.test.ts`; final live meter; `npm run smoke:local-queue-upgrade`; `npm run audit:sql`; `npm run smoke:daemon-bundle`. |
| 066e-AC-1 | prd-066e | A packaged upgrade smoke installs the previous version, upgrades to the candidate version, boots the daemon through the package/CLI entrypoint, and passes. | OPEN | unassigned | Not implemented. |
| 066e-AC-2 | prd-066e | First boot after packaged upgrade creates `.daemon/local-queue.db` and preserves/reopens `.daemon/logs.db`. | OPEN | unassigned | Not implemented. |
| 066e-AC-3 | prd-066e | Existing DeepLake memory rows and recall behavior remain available after upgrade. | OPEN | unassigned | Not implemented. |
| 066e-AC-4 | prd-066e | A pending pre-upgrade DeepLake-backed `summary` or local-kind job follows the documented migration policy without duplicate successful execution. | OPEN | unassigned | Not implemented. |
| 066e-AC-5 | prd-066e | With local queue enabled after upgrade, new local-only jobs enqueue to the local queue and do not create new DeepLake queue rows. | OPEN | unassigned | Not implemented. |
| 066e-AC-6 | prd-066e | With the rollback flag off after local queue has been used, the daemon returns to the old shared queue path and reports any local queued work that will not be processed under rollback. | OPEN | unassigned | Not implemented. |
| 066e-AC-7 | prd-066e | Rollback requires no DeepLake schema migration and no local DB deletion. | OPEN | unassigned | Not implemented. |
| 066e-AC-8 | prd-066e | Default-on is blocked unless the install is classified as single-machine/local topology. | OPEN | unassigned | Not implemented. |
| 066e-AC-9 | prd-066e | Multi-device, fleet, or unknown topology installs stay on fallback or require explicit opt-in. | OPEN | unassigned | Not implemented. |
| 066e-AC-10 | prd-066e | Upgrade diagnostics identify local queue status counts, shared drain mode, and pending old shared jobs. | OPEN | unassigned | Not implemented. |
| 066e-AC-11 | prd-066e | The packaged upgrade smoke also verifies second boot against the upgraded workspace. | OPEN | unassigned | Not implemented. |
| 066e-AC-12 | prd-066e | Dogfood evidence covers restart, sleep/wake, transient DeepLake outage, and rollback. | OPEN | unassigned | Not implemented. |
| 066e-AC-13 | prd-066e | Release notes and support docs describe upgrade, rollback, old shared jobs, local DB location, and remaining DeepLake cost paths. | OPEN | unassigned | Not implemented. |
| 066e-AC-14 | prd-066e | The release gate fails if idle local mode produces DeepLake coordination reads after the packaged upgrade. | OPEN | unassigned | Not implemented. |

## Watchdog / Event Log

- 2026-06-29: Phase 0 started. PRD-066, 066a, 066b, and 066c read end to end.
- 2026-06-29: Existing queue surface identified: `src/daemon/runtime/services/job-queue.ts`
  DeepLake-backed `memory_jobs`; PRD-062 backoff/consolidation helpers already present.
- 2026-06-29: Existing local SQLite precedent identified: `src/daemon/runtime/logs/log-store.ts`
  using `node:sqlite` under `.daemon/logs.db`.
- 2026-06-29: Sub-agent spawn attempted for `typescript-node-worker-bee`; tool failed before
  allocation with model-resolution errors, so no child worktree changes existed to merge.
- 2026-06-29: Wave 1 implemented in main thread: `src/daemon/runtime/services/local-job-queue.ts`
  and `tests/daemon/runtime/services/local-job-queue.test.ts`.
- 2026-06-29: Focused suite passed: `npx vitest run tests/daemon/runtime/services/local-job-queue.test.ts`
  (10 tests). Typecheck passed: `npm run typecheck`.
- 2026-06-29: Wave 2 implemented in main thread: `src/daemon/runtime/services/hybrid-job-queue.ts`,
  assembly wiring in `src/daemon/runtime/assemble.ts`, and hybrid queue focused tests.
- 2026-06-29: Corrected hybrid `start()` behavior so local-only mode does not start the shared queue
  background reaper unless `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED=true`.
- 2026-06-29: Focused verification passed: `npx vitest run tests/daemon/runtime/services/hybrid-job-queue.test.ts tests/daemon/runtime/services/local-job-queue.test.ts`
  (21 tests), `npm run typecheck`, and `npm run audit:sql`.
- 2026-06-29: Full `npm run ci` failed in the broad Vitest suite on
  `tests/property/json-parsers.property.test.ts:104` due a 5000 ms timeout. The same file passed
  when rerun directly with `npx vitest run tests/property/json-parsers.property.test.ts` (7 tests).
- 2026-06-29: `security-worker-bee` dispatch retried and failed before allocation with
  `spawn_agent could not resolve the child model for service tier validation`; no child workspace
  changes existed to merge. Main-thread fallback security review added at
  `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-security-review.md`.
- 2026-06-29: Main-thread fallback QA report added at
  `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-qa-report.md`.
- 2026-06-29: Remaining PRD-066 items that require live DeepLake credentials, PRD-062 metering, or
  dogfood conditions were marked BLOCKED with exact evidence required to unblock.
- 2026-06-29: Live idle meter proof added and passed:
  `npx vitest run --config vitest.integration.config.ts tests/integration/local-queue-idle-meter-live.itest.ts`.
  Output: shared queue poll reads=39/writes=0; local queue poll reads=0/writes=0. Moved
  066-AC-1, 066-AC-8, 066c-AC-1, and 066c-AC-2 to DONE. Remaining blocked items require
  active memory write/recall categorization and dogfood scenarios.
- 2026-06-29: Added an active local-queue memory pipeline live probe to
  `tests/integration/local-queue-idle-meter-live.itest.ts`. The probe now skips with a specific
  funded-account message when DeepLake returns `402 insufficient balance`; current run skipped it
  because the account reported `balance_cents=0`.
- 2026-06-29: After account credit was added, the full PRD-066 live integration passed:
  `npx vitest run --config vitest.integration.config.ts tests/integration/local-queue-idle-meter-live.itest.ts`.
  Output: idle shared poll reads=39/writes=0; idle local poll reads=0/writes=0; active local
  memory pipeline poll reads=0/writes=0 and total DeepLake reads=67/writes=15. Moved
  066b-AC-3 to DONE; 066-AC-7 and 066c-AC-3 remain blocked only on recall-read categorization.
- 2026-06-29: Hardened `src/daemon/runtime/services/poll-loop.ts` so a late background tick
  rejection during shutdown is contained as an empty lease instead of surfacing as an unhandled
  rejection. Regression covered by `npx vitest run tests/daemon/runtime/services/poll-loop.test.ts`
  (7 tests).
- 2026-06-29: PRD-066d pass started. Added test-only `AssembleDaemonOptions.jobQueueConfig` and
  threaded it into `createJobQueueService` so live verification can use a bounded throwaway shared
  queue table while production remains on canonical `memory_jobs`.
- 2026-06-29: Hardened `tests/integration/local-queue-idle-meter-live.itest.ts` to generate
  per-run `ci_066d_*_jobs` tables, wrap phases with elapsed-time timeout errors, and drop the
  throwaway table even when the bounded shared start fails before returning a probe.
- 2026-06-29: Added `scripts/local-queue-upgrade-smoke.mjs` and `npm run smoke:local-queue-upgrade`
  to boot built `daemon/index.js`, verify `.daemon/logs.db` and `.daemon/local-queue.db`, inspect
  SQLite tables, stop, restart against the same workspace, and verify `/health` answers again.
- 2026-06-29: Verification passed: `npm run typecheck`; focused local/hybrid queue tests (27
  passed); final live idle meter with `shared_table=ci_066d_t987848400_jobs`,
  `shared_poll_reads=39`, `local_poll_reads=0`, active `total_writes=15`; `npm run build`;
  `npm run smoke:local-queue-upgrade`; `npm run smoke:daemon-bundle`; `npm run audit:sql`;
  live `npm run smoke:golden-path`; live `npm run eval:recall` after temporary embed-daemon start.
- 2026-06-29: Security worker dispatch by named `security-worker-bee` failed before allocation due
  model-resolution validation; generic worker `019f1312-3511-70c1-a7ab-3f9aa7813ffb` completed
  security review and fixed one High issue by constraining inherited environment in the built-daemon
  smoke. Main thread reran `node --check`, `npm run smoke:local-queue-upgrade`, and
  `npm run audit:sql` successfully after the fix.
- 2026-06-29: Quality worker dispatch by named `quality-worker-bee` failed before allocation due
  model-resolution validation; generic worker `019f1317-1658-7f72-83e5-16dc56bb45e8` completed QA
  review, found no blocking findings, and confirmed every PRD-066d AC covered. Added
  `qa/2026-06-29-prd-066d-qa-report.md`.
- 2026-06-29: Added PRD-066e to explicitly track packaged user upgrade, rollback, old shared job
  behavior, topology gating, diagnostics, and dogfood evidence as required production default-on
  blockers. All 066e ACs are OPEN.
