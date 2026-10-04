# PRD-066 standing: local queue idle-cost control

- Date: 2026-10-04
- Shard: Wave 1b, in-work 066 only
- Folder: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/` (index, 066a-066f, `qa/`)
- Package version read: `package.json` `0.22.0`
- ADR lock: ADR-0009 Accepted 2026-07-05. The daemon-local SQLite queue is the default job-coordination substrate. DeepLake stays the memory store. `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` is the rollback lever. Undeclared topology is eligible for default-on. Declared `fleet` / `multi_device` stays on the shared queue unless it opts in.
- Grounding files: `src/daemon/runtime/services/local-job-queue.ts`, `src/daemon/runtime/services/hybrid-job-queue.ts`, `src/daemon/runtime/services/local-queue-diagnostics.ts`, `src/cli/runtime.ts`
- Build outputs and `node_modules` were not used as evidence.

## Verdict rules

- MET: current source, or an in-tree test or script, implements the quoted criterion and nothing in current source contradicts it.
- UNMET: current source contradicts the quoted text, or the required proof artifact is still marked pending / absent.
- UNVERIFIABLE: the criterion is a live command result. This pass did not re-run it. The 2026-06-29 ledger is a receipt for candidate `0.1.11` on another machine, not proof for `0.22.0`.

## Counts

- Acceptance criteria: 92
- MET: 58
- UNMET: 12
- UNVERIFIABLE: 22

## Recommended bucket

Keep the folder in `in-work`.

The local queue store, hybrid router, upgrade diagnostics, built-daemon smoke, packaged upgrade smoke, and packaged live-proof script are in the tree. ADR-0009 already records default-on. The index and every letter still say `Status: Backlog` while the folder is `in-work`; that status line is stale and is not a reason to move the folder back.

`completed` waits on the unmet rows below. The publish ledger is still a 2026-06-29 hold, the 10-minute idle soak was deferred and left as an open blocker, sleep/wake and transient-outage dogfood are still pending, and CI/release workflows do not run the idle-read gate. `archive` is the wrong bucket: the work is not withdrawn.

## CLI grounding

`src/cli/runtime.ts` does not name the local queue. It spawns `daemon/index.js` with `--experimental-sqlite` (`src/cli/runtime.ts:148`) and forwards the parent environment plus `HONEYCOMB_WORKSPACE` (`src/cli/runtime.ts:279-283`). It does not set `HONEYCOMB_LOCAL_QUEUE_ENABLED`. An unset flag therefore reaches `resolveHybridJobQueueConfig`, which enables the local queue when topology is eligible (`src/daemon/runtime/services/hybrid-job-queue.ts:46-64`). That matches ADR-0009 decision 1 and decision 4. `node:sqlite` is what `openLocalJobQueue` loads (`src/daemon/runtime/services/local-job-queue.ts:330-332`).

## Assembly facts used across criteria

- Local DB path is `<base>/.daemon/local-queue.db` (`src/daemon/runtime/services/local-job-queue.ts:22-23`, `253-262`).
- Production opens that queue from `assembleDaemon` and wraps it in the hybrid router (`src/daemon/runtime/assemble.ts:3172-3186`). When the flag is off, open is `openExistingOnly` so a missing DB is not created (`src/daemon/runtime/assemble.ts:3180`).
- Shared reaper stays stopped unless drain mode is on (`src/daemon/runtime/services/hybrid-job-queue.ts:141-146`).
- Recurring DeepLake `SELECT 1` health probe is off when the local queue is enabled and drain is off (`src/daemon/runtime/assemble.ts:3174`, `4089-4096`).
- First-wave local kinds: `memory_extraction`, `memory_decision`, `memory_controlled_write`, `memory_graph_persist`, `memory_retention`, `summary`, `skillify`, `pollinating`, `source_index`, `document_ingest` (`src/daemon/runtime/services/hybrid-job-queue.ts:15-26`).
- Query meter labels include `poll-lease` and `poll-reaper` (`src/daemon/storage/query-meter.ts:40-57`). Shared queue lease/reaper reads use those labels (`src/daemon/runtime/services/job-queue.ts:314-315`).

## Unmet list

1. 066b AC-6. Idempotency keys are absent. Duplicate avoidance is transactional lease plus local-before-shared ordering.
2. 066c AC-3. Active writes are counted. Recall is not categorized in the rollout report or the live itest.
3. 066c AC-6. Sleep/wake and transient DeepLake outage dogfood are still pending.
4. 066e AC-3. Packaged upgrade smoke never proves existing DeepLake rows or recall.
5. 066e AC-8. Written rule blocks default-on unless topology is single-machine. Code and ADR-0009 also default-on for undeclared topology.
6. 066e AC-9. Written rule keeps unknown topology on the shared fallback. Code defaults unknown to the local queue.
7. 066e AC-12. Dogfood matrix still pending for sleep/wake and transient outage.
8. 066e AC-14. Idle coordination-read failure is in the manual live-proof script. `.github/workflows/ci.yaml` and `release.yaml` do not run it.
9. 066f.5.1. Required idle window is at least 10 minutes unless the release owner accepts a shorter window. Ledger left that decision open.
10. 066f.5.2. Same 10-minute window for `poll-reaper`.
11. 066f.5.5. Ledger does not state an approximate cost implication.
12. 066f.6.4. No in-tree scenario shows a transient DeepLake outage, a surviving local job, and a later successful retry.

## Index (`prd-066-local-queue-idle-cost-control-index.md`)

### index AC-1 - MET

- Quote: "With no user activity and an empty local queue, the daemon produces zero DeepLake coordination reads over the configured idle measurement window."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:119-120`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:141-146`; `src/daemon/runtime/assemble.ts:3174`; `tests/integration/local-queue-idle-meter-live.itest.ts:107-108` (window is `IDLE_WINDOW_MS = 1500` at line 42)

### index AC-2 - MET

- Quote: "A queued local job survives daemon restart and executes once after restart."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:121`
- Source: `src/daemon/runtime/services/local-job-queue.ts:253-262`; `tests/daemon/runtime/services/local-job-queue.test.ts:48-57`; production reopens the same file at `src/daemon/runtime/assemble.ts:3175-3181`

### index AC-3 - MET

- Quote: "An expired local lease is reclaimed and retried without creating duplicate successful work."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:122`
- Source: `src/daemon/runtime/services/local-job-queue.ts:501-511`; stale completion filter `458-469`; `tests/daemon/runtime/services/local-job-queue.test.ts:101` and `:115`

### index AC-4 - MET

- Quote: "Local-only producers no longer call DeepLake queue enqueue APIs when the local queue flag is enabled."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:123-124`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:84-88`; `tests/daemon/runtime/services/hybrid-job-queue.test.ts:74-84`

### index AC-5 - MET

- Quote: "Local-only workers no longer poll DeepLake for job discovery when the local queue flag is enabled."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:125-126`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:93-106` and `:175-185` (local-only kind filter returns null instead of calling shared lease when drain is off); workers pass kind filters (`src/daemon/runtime/pipeline/stage-worker.ts:222`, `src/daemon/runtime/summaries/job.ts:375`, `src/daemon/runtime/skillify/worker.ts:301`, `src/daemon/runtime/pollinating/worker.ts:226`)

### index AC-6 - MET

- Quote: "Feature flag off preserves current behavior."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:127`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:67-68`; explicit `false` wins at `:58-59`; `tests/daemon/runtime/services/hybrid-job-queue.test.ts:168-179` and `:263-266`. Unset is default-on under ADR-0009. The quoted criterion is the off lever, which still returns the shared queue.

### index AC-7 - MET

- Quote: "Active memory write/recall behavior still reaches DeepLake when a local job has real memory work to perform."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:128-129`
- Source: `tests/integration/local-queue-idle-meter-live.itest.ts:174-206` (local `memory_extraction` job, `totalWrites > 0`, memory and entity rows read back from DeepLake, poll reads stay 0). Categorized recall is 066c AC-3, which is unmet.

### index AC-8 - MET

- Quote: "The rollout report includes before/after DeepLake coordination read counts using the PRD-062 meter."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md:130-131`
- Source: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/qa/2026-06-29-idle-meter-live-report.md:13-16` (shared poll reads 39, local poll reads 0). Meter labels: `src/daemon/storage/query-meter.ts:40-41`. Receipt printer: `tests/integration/local-queue-idle-meter-live.itest.ts:101-104`. Receipt date is 2026-06-29.

## 066a local queue store

### 066a AC-1 - MET

- Quote: "Enqueued jobs are still present after daemon process restart."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:49`
- Source: `tests/daemon/runtime/services/local-job-queue.test.ts:48-57`; file reopen `src/daemon/runtime/services/local-job-queue.ts:214-224`

### 066a AC-2 - MET

- Quote: "Two concurrent lease attempts cannot successfully lease the same job."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:50`
- Source: `src/daemon/runtime/services/local-job-queue.ts:429-443` (`BEGIN IMMEDIATE` then one `UPDATE`); `tests/daemon/runtime/services/local-job-queue.test.ts:78-85`

### 066a AC-3 - MET

- Quote: "A leased job is invisible to other lease attempts until it completes or expires."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:51`
- Source: `src/daemon/runtime/services/local-job-queue.ts:585-596` (runnable scan is queued/retrying, or leased only after `leased_until`); `tests/daemon/runtime/services/local-job-queue.test.ts:89-98`

### 066a AC-4 - MET

- Quote: "An expired lease can be reclaimed and retried."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:52`
- Source: `src/daemon/runtime/services/local-job-queue.ts:501-511`; `tests/daemon/runtime/services/local-job-queue.test.ts:101`

### 066a AC-5 - MET

- Quote: "Completed jobs are pruned after the configured retention window."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:53`
- Source: `src/daemon/runtime/services/local-job-queue.ts:514-523` (default retention 24h at `:146`); `tests/daemon/runtime/services/local-job-queue.test.ts:178-188`

### 066a AC-6 - MET

- Quote: "Invalid payloads are rejected before entering the queue."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:54`
- Source: `src/daemon/runtime/services/local-job-queue.ts:396-399` (`LocalJobInputSchema.parse` before `INSERT`); `tests/daemon/runtime/services/local-job-queue.test.ts:191`

### 066a AC-7 - MET

- Quote: "Payloads containing known secret-like fields are rejected or redacted according to the final implementation policy."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:55-56`
- Source: policy is reject, `src/daemon/runtime/services/local-job-queue.ts:665-667` and key list `:157-167`; `tests/daemon/runtime/services/local-job-queue.test.ts:200`

### 066a AC-8 - MET

- Quote: "Unit tests cover enqueue, lease, complete, retry, expired lease, exhausted retry, and prune behavior."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066a-local-queue-idle-cost-control-local-queue-store.md:57-58`
- Source: `tests/daemon/runtime/services/local-job-queue.test.ts:48` (enqueue/reopen), `:78` (lease), `:60` (complete), `:136` (retry and exhaust), `:101` (expired lease), `:178` (prune)

## 066b worker routing and migration

### 066b AC-1 - MET

- Quote: "Tests assert that first-wave local-only producers do not call DeepLake enqueue APIs when the local queue flag is enabled."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:59-60`
- Source: `tests/daemon/runtime/services/hybrid-job-queue.test.ts:74-84`

### 066b AC-2 - MET

- Quote: "Tests assert that first-wave local-only workers do not call DeepLake polling APIs for job discovery when the local queue flag is enabled."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:61-62`
- Source: `tests/daemon/runtime/services/hybrid-job-queue.test.ts:87-107`

### 066b AC-3 - MET

- Quote: "Handler-level DeepLake reads/writes still occur when a local job performs real memory work."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:63`
- Source: `tests/integration/local-queue-idle-meter-live.itest.ts:189-206`; handler dispatch also covered at `tests/daemon/runtime/services/hybrid-job-queue.test.ts:145-165`

### 066b AC-4 - MET

- Quote: "Feature flag off preserves current DeepLake-backed queue behavior."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:64`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:67-68`; `tests/daemon/runtime/services/hybrid-job-queue.test.ts:168-179`

### 066b AC-5 - MET

- Quote: "Migration tests cover old DeepLake jobs that exist at daemon startup."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:65`
- Source: drain leases shared local-kind jobs after the local queue is empty, `src/daemon/runtime/services/hybrid-job-queue.ts:93-106` and `:141-146`; `tests/daemon/runtime/services/hybrid-job-queue.test.ts:182-205`. Drain defaults off (`:62`, `parseBooleanFlag` at `:202-205`).

### 066b AC-6 - UNMET

- Quote: "Duplicate execution is prevented or made harmless through idempotency keys."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:66`
- Source: ABSENT. `local_job` has no idempotency-key column (`src/daemon/runtime/services/local-job-queue.ts:335-352`). The hybrid test avoids a second lease by taking the local job first (`tests/daemon/runtime/services/hybrid-job-queue.test.ts:208-218`). That is ordering, not an idempotency key.

### 066b AC-7 - MET

- Quote: "Unknown job kinds fail closed to the current shared path until classified."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:67`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:84-90` and `:168-170`; `tests/daemon/runtime/services/hybrid-job-queue.test.ts:222-233`

## 066c idle-cost verification and rollout

### 066c AC-1 - MET

- Quote: "Baseline report shows current idle DeepLake coordination reads before the feature flag is enabled."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:43-44`
- Source: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/qa/2026-06-29-idle-meter-live-report.md:14` (shared poll reads 39); assertion `tests/integration/local-queue-idle-meter-live.itest.ts:91`

### 066c AC-2 - MET

- Quote: "Post-change report shows zero DeepLake coordination reads during the idle measurement window with an empty local queue."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:45-46`
- Source: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/qa/2026-06-29-idle-meter-live-report.md:15`; `tests/integration/local-queue-idle-meter-live.itest.ts:107-108`

### 066c AC-3 - UNMET

- Quote: "Active memory writes and recall reads are still visible and correctly categorized."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:47`
- Source: writes are a total, `tests/integration/local-queue-idle-meter-live.itest.ts:196` (`totalWrites > 0`). The rollout report says recall categorization is still open (`qa/2026-06-29-idle-meter-live-report.md:37-38`). The itest does not assert `controlled-write` or `recall-arm`. A later script does assert `recall-arm` (`scripts/local-queue-packaged-live-proof.mjs:114-117`) and that run was not repeated for `0.22.0`.

### 066c AC-4 - MET

- Quote: "Rollback flag restores previous behavior without a data migration."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:48`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:67-68`; rollback fields `requiresDeepLakeMigration: false` and `requiresLocalDbDeletion: false` at `src/daemon/runtime/services/local-queue-diagnostics.ts:147-151`; `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:27-46`

### 066c AC-5 - MET

- Quote: "Local queue diagnostics identify queued, leased, retrying, failed, and completed counts."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:49`
- Source: status set `src/daemon/runtime/services/local-job-queue.ts:43-47`; `counts()` groups by status `:526-547`; exposed on `GET /api/diagnostics/local-queue` via `src/daemon/runtime/services/local-queue-diagnostics.ts:138-145` and `src/daemon/runtime/local-queue-diagnostics-api.ts:12-26`

### 066c AC-6 - UNMET

- Quote: "Dogfood rollout runs long enough to include daemon restart, sleep/wake, and transient DeepLake outage scenarios."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:50-51`
- Source: sleep/wake and transient outage are `Pending dogfood` at `qa/2026-06-29-prd-066e-dogfood-matrix.md:14-15`. Restart has a packaged start/stop/start (`scripts/local-queue-packaged-upgrade-smoke.mjs:50-63`) and is not the missing part.

### 066c AC-7 - MET

- Quote: "Release notes describe the local queue boundary and known remaining DeepLake cost paths."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:52`
- Source: `qa/2026-06-29-release-notes-draft.md:3-15`. Defect for a later editor: lines 9-10 say an unset flag preserves the shared queue. ADR-0009 and `hybrid-job-queue.ts:58-59` default the local queue on when the flag is unset. That sentence is stale. The boundary and remaining-cost paragraphs still match the quote.

## 066d verification hardening and upgrade smoke

### 066d AC-1 - MET

- Quote: "The live idle-meter test no longer calls shared queue lease/discovery against the canonical `memory_jobs` table."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:99-100`
- Source: throwaway table `tests/integration/local-queue-idle-meter-live.itest.ts:78` and `jobQueueConfig` at `:246`; production leaves the override unset (`src/daemon/runtime/assemble.ts:469-475`, wired at `:3172`)

### 066d AC-2 - MET

- Quote: "The shared baseline emits a receipt with bounded-table poll reads greater than zero."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:101`
- Source: `tests/integration/local-queue-idle-meter-live.itest.ts:91` and receipt `:101-104`

### 066d AC-3 - MET

- Quote: "The local idle path emits a receipt with `local_poll_reads=0` and `local_poll_writes=0`."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:102`
- Source: `tests/integration/local-queue-idle-meter-live.itest.ts:102-108`

### 066d AC-4 - MET

- Quote: "The active local memory pipeline proof emits a receipt with `poll_reads=0`, `poll_writes=0`, and non-zero total DeepLake writes."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:103-104`
- Source: `tests/integration/local-queue-idle-meter-live.itest.ts:190-196`

### 066d AC-5 - MET

- Quote: "A timeout in any live idle-meter phase reports the phase name and elapsed time."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:105`
- Source: `tests/integration/local-queue-idle-meter-live.itest.ts:325-340`

### 066d AC-6 - MET

- Quote: "A built-daemon boot smoke proves first boot creates `.daemon/logs.db` and `.daemon/local-queue.db`."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:106-107`
- Source: `scripts/local-queue-upgrade-smoke.mjs:39` and `:67-69`; npm script `package.json:88`. Last recorded pass is the 2026-06-29 ledger, not a `0.22.0` run.

### 066d AC-7 - MET

- Quote: "The built-daemon boot smoke proves `logs.db` has `event_log` and `request_log`, and `local-queue.db` has `local_job`."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:108-109`
- Source: `scripts/local-queue-upgrade-smoke.mjs:40-41`

### 066d AC-8 - MET

- Quote: "The built-daemon boot smoke proves a second boot against the same workspace answers `/health` without schema or migration failure."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:110-111`
- Source: `scripts/local-queue-upgrade-smoke.mjs:42` (`bootAndAssert("second boot")` rechecks `/health` and both DB files)

### 066d AC-9 - MET

- Quote: "`npm run smoke:golden-path` and `npm run eval:recall` remain unaffected by the test-only queue table override."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:112-113`
- Source: override is optional and production leaves it unset (`src/daemon/runtime/assemble.ts:469-475`). `scripts/golden-path-smoke.mjs` and `scripts/eval-recall.mjs` do not reference `jobQueueConfig`. This pass did not re-run either script.

### 066d AC-10 - UNVERIFIABLE

- Quote: "`npm run typecheck`, focused local/hybrid queue tests, the PRD-066 live idle-meter test, and the new daemon boot smoke all pass before PRD-066 is considered releasable."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066d-local-queue-idle-cost-control-verification-hardening-and-upgrade-smoke.md:114-115`
- Source: harnesses exist (`package.json` `typecheck`, `tests/daemon/runtime/services/local-job-queue.test.ts`, `tests/daemon/runtime/services/hybrid-job-queue.test.ts`, `tests/integration/local-queue-idle-meter-live.itest.ts`, `package.json:88`). A current pass on `0.22.0` is ABSENT. Ledger row is `qa/2026-06-29-prd-066f-publish-readiness-ledger.md:35-40` for an older candidate.

## 066e upgrade and rollback hardening

### 066e AC-1 - UNVERIFIABLE

- Quote: "A packaged upgrade smoke installs the previous version, upgrades to the candidate version, boots the daemon through the package/CLI entrypoint, and passes."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:100-101`
- Source: script encodes the path at `scripts/local-queue-packaged-upgrade-smoke.mjs:37-57`; npm script `package.json:89`. A green run for `0.22.0` is ABSENT. Ledger pass is `qa/2026-06-29-prd-066f-publish-readiness-ledger.md:41` for `0.1.10` to `0.1.11`.

### 066e AC-2 - MET

- Quote: "First boot after packaged upgrade creates `.daemon/local-queue.db` and preserves/reopens `.daemon/logs.db`."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:102-103`
- Source: smoke asserts both files after candidate CLI start (`scripts/local-queue-packaged-upgrade-smoke.mjs:50-53`). Creation path is `src/daemon/runtime/services/local-job-queue.ts:253-262`.

### 066e AC-3 - UNMET

- Quote: "Existing DeepLake memory rows and recall behavior remain available after upgrade."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:104`
- Source: ABSENT from the packaged upgrade smoke (`scripts/local-queue-packaged-upgrade-smoke.mjs:50-63` checks health, DB files, and table names). Dogfood matrix marks the recall-after-upgrade row pending (`qa/2026-06-29-prd-066e-dogfood-matrix.md:17`). The local queue module does not issue memory deletes (`src/daemon/runtime/services/local-job-queue.ts:1-8`).

### 066e AC-4 - MET

- Quote: "A pending pre-upgrade DeepLake-backed `summary` or local-kind job follows the documented migration policy without duplicate successful execution."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:105-106`
- Source: policy text `qa/2026-06-29-prd-066e-upgrade-support-notes.md:17-25` (drain only when `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED=true`, otherwise preserve and surface). Code: `src/daemon/runtime/services/hybrid-job-queue.ts:31-36` and `:175-185`; local-before-shared test `tests/daemon/runtime/services/hybrid-job-queue.test.ts:182-218`. The upgrade smoke does not seed such a job.

### 066e AC-5 - MET

- Quote: "With local queue enabled after upgrade, new local-only jobs enqueue to the local queue and do not create new DeepLake queue rows."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:107-108`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:84-88`; `tests/daemon/runtime/services/hybrid-job-queue.test.ts:74-84`

### 066e AC-6 - MET

- Quote: "With the rollback flag off after local queue has been used, the daemon returns to the old shared queue path and reports any local queued work that will not be processed under rollback."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:109-110`
- Source: `src/daemon/runtime/services/hybrid-job-queue.ts:67-68`; warning text `src/daemon/runtime/services/local-queue-diagnostics.ts:134-156`; `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:27-46`

### 066e AC-7 - MET

- Quote: "Rollback requires no DeepLake schema migration and no local DB deletion."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:111`
- Source: `src/daemon/runtime/services/local-queue-diagnostics.ts:150-151`. Disabled mode uses `openExistingOnly` (`src/daemon/runtime/assemble.ts:3180`), which does not delete the file.

### 066e AC-8 - UNMET

- Quote: "Default-on is blocked unless the install is classified as single-machine/local topology."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:112`
- Source: contradicts the quote. Undeclared topology sets `eligibleForDefaultOn: true` (`src/daemon/runtime/services/local-queue-diagnostics.ts:111-121`). `resolveHybridJobQueueConfig` uses that eligibility when the flag is unset (`src/daemon/runtime/services/hybrid-job-queue.ts:58-59`). Test names the reversal: `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:68-75`. ADR-0009 decision 3 is the accepted rule. Single-machine eligibility itself is present (`local-queue-diagnostics.ts:93-99`).

### 066e AC-9 - UNMET

- Quote: "Multi-device, fleet, or unknown topology installs stay on fallback or require explicit opt-in."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:113-114`
- Source: `fleet` and `multi_device` stay ineligible (`src/daemon/runtime/services/local-queue-diagnostics.ts:102-108`; test `:61-66`). Unknown does not stay on fallback (`:111-121`). Explicit opt-in still forces eligibility (`:84-90`). The unknown clause fails the quoted sentence. Support notes still state the old rule (`qa/2026-06-29-prd-066e-upgrade-support-notes.md:81-94`).

### 066e AC-10 - MET

- Quote: "Upgrade diagnostics identify local queue status counts, shared drain mode, and pending old shared jobs."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:115-116`
- Source: `src/daemon/runtime/services/local-queue-diagnostics.ts:138-158`; pending count query `:207-237`; mounted only when drain is on or `HONEYCOMB_LOCAL_QUEUE_DIAGNOSTICS_INCLUDE_SHARED` is set (`src/daemon/runtime/assemble.ts:1807-1818`); test `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:110-132`

### 066e AC-11 - MET

- Quote: "The packaged upgrade smoke also verifies second boot against the upgraded workspace."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:117`
- Source: `scripts/local-queue-packaged-upgrade-smoke.mjs:59-63`

### 066e AC-12 - UNMET

- Quote: "Dogfood evidence covers restart, sleep/wake, transient DeepLake outage, and rollback."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:118`
- Source: restart and rollback rows are automated (`qa/2026-06-29-prd-066e-dogfood-matrix.md:9-13`). Sleep/wake and transient outage are `Pending dogfood` (`:14-15`). Ledger lane 6 says the live dogfood was not run (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:54`).

### 066e AC-13 - MET

- Quote: "Release notes and support docs describe upgrade, rollback, old shared jobs, local DB location, and remaining DeepLake cost paths."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:119-120`
- Source: `qa/2026-06-29-prd-066e-upgrade-support-notes.md:7-78` covers those five topics. `qa/2026-06-29-release-notes-draft.md:3-15` covers the boundary and remaining cost paths. Same stale default-on sentences as 066c AC-7 and 066e AC-8/AC-9 (`release-notes-draft.md:9-10`, `upgrade-support-notes.md:81-94`).

### 066e AC-14 - UNMET

- Quote: "The release gate fails if idle local mode produces DeepLake coordination reads after the packaged upgrade."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:121-122`
- Source: the manual script throws when poll reads are non-zero (`scripts/local-queue-packaged-live-proof.mjs:313-315`). That script is ABSENT from `.github/workflows/ci.yaml` and `.github/workflows/release.yaml` (those workflows run `npm run pack:check` and do not name `smoke:local-queue`).

## 066f publish readiness gate

Lane criteria are execution gates. A script or code path is cited when it exists. "Passes" on the current tree is UNVERIFIABLE unless the behavior itself is in source.

### 066f.1.1 - UNVERIFIABLE

- Quote: "`npm run typecheck` passes."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:130`
- Source: command exists. A `0.22.0` pass is ABSENT. Historical pass: `qa/2026-06-29-prd-066f-publish-readiness-ledger.md:35`.

### 066f.1.2 - UNVERIFIABLE

- Quote: "Focused local queue regression tests pass."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:131`
- Source: tests exist under `tests/daemon/runtime/services/local-job-queue.test.ts`, `hybrid-job-queue.test.ts`, and `local-queue-diagnostics.test.ts`. A current pass is ABSENT. Historical pass: ledger `:36`.

### 066f.1.3 - UNVERIFIABLE

- Quote: "SQL-safety audit passes or has only documented false positives accepted by the release owner."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:132-133`
- Source: local queue writes use bound parameters (`src/daemon/runtime/services/local-job-queue.ts:403-421`) and `sqlIdent` (`:41`). Pending shared count uses `sqlIdent` and `sLiteral` (`src/daemon/runtime/services/local-queue-diagnostics.ts:214-225`). `npm run audit:sql` was not re-run. Historical pass is inside ledger `:38` (`npm run ci`).

### 066f.1.4 - UNVERIFIABLE

- Quote: "Broad test/CI status is recorded, including failures. A failing broad gate blocks publish unless the ledger explicitly marks it as unrelated and accepted."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:134-135`
- Source: ledger records a 2026-06-29 pass (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:37-38`). No `0.22.0` broad-CI row is in this folder.

### 066f.2.1 - UNVERIFIABLE

- Quote: "`npm run pack:check` passes."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:189`
- Source: script `package.json:79`. Current pass ABSENT. Historical pass: ledger `:39` for `0.1.11`. CI runs `pack:check` (`.github/workflows/ci.yaml`) and that run was not read here.

### 066f.2.2 - UNVERIFIABLE

- Quote: "Packaged upgrade smoke passes through the package/CLI path, not only repo-local source."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:190`
- Source: CLI path is `scripts/local-queue-packaged-upgrade-smoke.mjs:50-57` (`honeycomb daemon start` / `stop` from the installed package). Current pass ABSENT. Same historical receipt as 066e AC-1.

### 066f.2.3 - UNVERIFIABLE

- Quote: "Packaged live proof shows `idle_poll_reads=0`."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:191`
- Source: assertion `scripts/local-queue-packaged-live-proof.mjs:89` and `:121-122`. Default idle window is 1500 ms (`:28`). Current pass ABSENT. Historical receipt: ledger `:43` (`idle_poll_reads=0` on `0.1.11`).

### 066f.2.4 - UNVERIFIABLE

- Quote: "Packaged live proof shows active recall still performs legitimate DeepLake reads."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:192`
- Source: `scripts/local-queue-packaged-live-proof.mjs:91-117` requires `recall-arm` delta `> 0`. Current pass ABSENT. Historical `recall_reads_delta=3` at ledger `:43`.

### 066f.2.5 - UNVERIFIABLE

- Quote: "Active local mode does not resume queue polling after recall; active poll reads remain zero."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:193-194`
- Source: `scripts/local-queue-packaged-live-proof.mjs:118`. Current pass ABSENT. Historical `active_poll_reads=0` at ledger `:43`.

### 066f.2.6 - MET

- Quote: "The daemon entrypoint does not auto-run merely because it was dynamically imported by a packaged proof."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:195-196`
- Source: `src/daemon/index.ts:200-212` and `:258-260` (`isMainEntry` guard). The packaged proof imports the module and calls `runAssembledDaemon` itself (`scripts/local-queue-packaged-live-proof.mjs:182-186`).

### 066f.2.7 - UNVERIFIABLE

- Quote: "If a default-port CLI proof is run, daemon start/status/stop work from the installed package without stale locks."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:197-198`
- Source: CLI spawn/stop lives in `src/cli/runtime.ts:274-283`. A current default-port receipt is ABSENT. Historical rows: ledger `:46-47`, including a warning that status copy treats setup `503` as not answering. That warning is outside this shard's queue files.

### 066f.3.1 - UNVERIFIABLE

- Quote: "Fresh no-creds install boots into expected setup behavior without an unhandled exception."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:234-235`
- Source: process safety net keeps an unhandled rejection alive (`src/daemon/index.ts:240-244`). A current no-creds install log is ABSENT. Historical: ledger `:40` and `:47` (`/health` 503 treated as expected setup).

### 066f.3.2 - MET

- Quote: "Local queue diagnostics are available or gracefully unavailable without triggering DeepLake credential resolution."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:236-237`
- Source: pending shared DeepLake count is omitted unless drain mode or `HONEYCOMB_LOCAL_QUEUE_DIAGNOSTICS_INCLUDE_SHARED` is set (`src/daemon/runtime/assemble.ts:1807-1812`). Omitted reads become `not-checked` (`src/daemon/runtime/services/local-queue-diagnostics.ts:189-197`). Local counts are SQLite (`local-job-queue.ts:526-547`).

### 066f.3.3 - MET

- Quote: "No local queue database creation requires DeepLake credentials."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:238`
- Source: `src/daemon/runtime/services/local-job-queue.ts:253-262` (`mkdir` mode `0o700`, `node:sqlite` `DatabaseSync`). Module header states it never calls the DeepLake storage client (`:1-6`).

### 066f.3.4 - UNVERIFIABLE

- Quote: "No logs contain raw DeepLake tokens, API keys, or credential blobs."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:239`
- Source: queue payloads reject secret-like keys (`src/daemon/runtime/services/local-job-queue.ts:665-667`). Proof-script body redaction is `scripts/local-queue-packaged-live-proof.mjs:328-333`. A current install log scan is ABSENT. Historical "secret log hits empty": ledger `:48`.

### 066f.4.1 - UNVERIFIABLE

- Quote: "Packaged upgrade smoke passes."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:281`
- Source: same as 066e AC-1. Current pass ABSENT.

### 066f.4.2 - MET

- Quote: "First upgraded boot creates or reopens `.daemon/local-queue.db`."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:282`
- Source: `scripts/local-queue-packaged-upgrade-smoke.mjs:52-53`; `src/daemon/runtime/services/local-job-queue.ts:253-262`

### 066f.4.3 - MET

- Quote: "Existing `.daemon/logs.db` behavior is preserved."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:283`
- Source: smoke requires `logs.db` before upgrade and again after (`scripts/local-queue-packaged-upgrade-smoke.mjs:44` and `:52`)

### 066f.4.4 - MET

- Quote: "Second upgraded boot proves DB reopen, not one-time creation only."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:284`
- Source: `scripts/local-queue-packaged-upgrade-smoke.mjs:59-62`

### 066f.4.5 - MET

- Quote: "Rollback flag does not require deleting local DBs or migrating DeepLake schemas."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:285`
- Source: `src/daemon/runtime/services/local-queue-diagnostics.ts:150-151`

### 066f.4.6 - MET

- Quote: "Rollback diagnostics expose non-empty local queue state before work can be stranded."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:286`
- Source: `src/daemon/runtime/services/local-queue-diagnostics.ts:134-156` (`localWorkWillNotProcess`, `localQueuedWork`, warning naming `.daemon/local-queue.db`)

### 066f.4.7 - MET

- Quote: "Old shared jobs are handled by the documented PRD-066e migration policy."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:287`
- Source: same policy and code as 066e AC-4 (`qa/2026-06-29-prd-066e-upgrade-support-notes.md:17-25`; `src/daemon/runtime/services/hybrid-job-queue.ts:175-185`)

### 066f.5.1 - UNMET

- Quote: "During the idle window, `poll-lease` reads are zero after startup settle."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:341`
- Source: the lane defines the window as at least 10 minutes unless the release owner accepts shorter (`prd-066f` `:306`). Ledger open blocker 1 leaves that decision open and records a deferred 10-minute soak (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:50` and `:104-105`). Short-window zero reads exist in code (`src/daemon/runtime/services/hybrid-job-queue.ts:141-146`) and in the 120-second historical receipt (ledger `:51`). That receipt is not an acceptance of the 10-minute bar.

### 066f.5.2 - UNMET

- Quote: "During the idle window, `poll-reaper` reads are zero after startup settle."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:342`
- Source: same gap as 066f.5.1. Reaper label is `src/daemon/runtime/services/job-queue.ts:315`. Shared reaper start is gated at `src/daemon/runtime/services/hybrid-job-queue.ts:145`. The 10-minute window was not accepted.

### 066f.5.3 - UNVERIFIABLE

- Quote: "Active recall or memory work still succeeds after idle."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:343`
- Source: script requires recall HTTP 2xx (`scripts/local-queue-packaged-live-proof.mjs:106-108`). Ledger says the long-idle active phase is still deferred (`:52`) while a 120-second proof returned recall 200 (`:51`). No `0.22.0` run.

### 066f.5.4 - MET

- Quote: "Active recall or memory work is categorized separately from coordination polling."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:344`
- Source: closed label set separates `poll-lease` / `poll-reaper` from `recall-arm` and `controlled-write` (`src/daemon/storage/query-meter.ts:40-57`). The packaged proof subtracts `recall-arm` and then asserts poll reads separately (`scripts/local-queue-packaged-live-proof.mjs:114-118`). Diagnostics expose the meter snapshot (`src/daemon/runtime/assemble.ts:1818`).

### 066f.5.5 - UNMET

- Quote: "The ledger states the approximate cost implication and any remaining DeepLake cost paths."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:345-346`
- Source: ABSENT in `qa/2026-06-29-prd-066f-publish-readiness-ledger.md` (no cost figure, no remaining-path row). Remaining paths are in the release-notes draft (`qa/2026-06-29-release-notes-draft.md:13-15`) and support notes (`qa/2026-06-29-prd-066e-upgrade-support-notes.md:68-78`), which are not the ledger.

### 066f.6.1 - MET

- Quote: "Restart with queued local work resumes without duplicate successful execution."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:393`
- Source: close/reopen leases the same job once (`tests/daemon/runtime/services/local-job-queue.test.ts:48-57`). Stale lease cannot complete a reclaimed job (`:115`). Durable path is the SQLite file the daemon reopens (`src/daemon/runtime/assemble.ts:3175-3181`).

### 066f.6.2 - UNVERIFIABLE

- Quote: "Restart while idle returns to zero DeepLake coordination reads after startup settle."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:394`
- Source: the idle mechanism is `src/daemon/runtime/services/hybrid-job-queue.ts:141-146` plus the disabled storage probe (`src/daemon/runtime/assemble.ts:3174`). No test restarts a process and asserts the meter afterward. Ledger lane 6 live dogfood was not run (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:54`).

### 066f.6.3 - MET

- Quote: "Sleep/wake or lease-expiry behavior recovers work without duplicate success."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:395`
- Source: lease expiry and retry `src/daemon/runtime/services/local-job-queue.ts:501-511`; `tests/daemon/runtime/services/local-job-queue.test.ts:101` and stale-complete rejection `:115`. Physical sleep/wake remains pending (`qa/2026-06-29-prd-066e-dogfood-matrix.md:14`). The quote accepts lease-expiry as the alternate.

### 066f.6.4 - UNMET

- Quote: "Transient DeepLake outage does not corrupt the local queue or lose retryable work."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:396`
- Source: ABSENT as a scenario. Dogfood matrix `:15` is `Pending dogfood`. `fail()` can schedule a local retry (`src/daemon/runtime/services/local-job-queue.ts:472-498`). No test in this shard drives a DeepLake failure, keeps the SQLite row, and shows a later success.

### 066f.6.5 - UNVERIFIABLE

- Quote: "Diagnostics remain understandable after each scenario."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:397`
- Source: the payload shape is concrete (`src/daemon/runtime/services/local-queue-diagnostics.ts:58-70`). "After each scenario" includes the unrun idle-restart and outage rows (066f.6.2, 066f.6.4). No post-scenario diagnostic transcript is in `qa/` for those rows.

### 066f.7.1 - MET

- Quote: "No unresolved critical SQL injection or path/file-inclusion findings remain in the local queue release surface."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:436-437`
- Source: bound parameters and `sqlIdent` as in 066f.1.3. Path stays inside the daemon directory (`src/daemon/runtime/services/local-job-queue.ts:269-309`). 066d security review records the smoke env finding as fixed (`qa/2026-06-29-prd-066d-security-review.md:17-31`). A fresh Aikido scan was not run in this pass. Ledger still records one waived medium code-quality note in `assemble.ts`, not a critical SQL or path finding (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:57`).

### 066f.7.2 - UNVERIFIABLE

- Quote: "CodeRabbit blocking issues are resolved or accepted with release-owner signoff."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:438`
- Source: historical "green" is ledger `:56` for PR 188. No current review artifact is in this folder.

### 066f.7.3 - UNVERIFIABLE

- Quote: "`pack:check` passes."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:439`
- Source: same as 066f.2.1. Current pass ABSENT.

### 066f.7.4 - UNVERIFIABLE

- Quote: "PRD-048d's npm rehearsal gates are complete or explicitly listed as blockers."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:440`
- Source: ledger `:58` records `npm publish --dry-run` for `0.1.11` and says no real publish occurred. `package.json:3` is `0.22.0`. No rehearsal row for `0.22.0` is in this folder, and the ledger does not list that version gap as a blocker.

### 066f.7.5 - UNVERIFIABLE

- Quote: "No `vX.Y.Z` tag is pushed before the final go-live decision."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:441`
- Source: ledger `:29` says no release tag was pushed during the 2026-06-29 pass. This standing pass did not inspect git tags.

### 066f.7.6 - MET

- Quote: "The final ledger distinguishes \"ready to publish\" from \"published.\""
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:442`
- Source: `qa/2026-06-29-prd-066f-publish-readiness-ledger.md:18-29` ("Publish hold" and "No real npm publish or release tag").

## QA notes read

These files add evidence. They do not add acceptance criteria.

- `qa/2026-06-29-qa-report.md` blocks index-era recall categorization and dogfood. Paths inside it still say `library/requirements/backlog/prd-066-...`.
- `qa/2026-06-29-idle-meter-live-report.md` is the before/after meter receipt. It leaves recall categorization open.
- `qa/2026-06-29-prd-066d-qa-report.md` and `qa/2026-06-29-prd-066d-security-review.md` record the built-daemon smoke and a fixed high finding about inherited smoke environment.
- `qa/2026-06-29-prd-066e-qa-report.md`, `qa/2026-06-29-prd-066e-security-review.md`, `qa/2026-06-29-prd-066e-dogfood-matrix.md`, and `qa/2026-06-29-prd-066e-upgrade-support-notes.md` record packaged upgrade automation and the still-pending sleep/wake, outage, and recall-after-upgrade rows.
- `qa/2026-06-29-prd-066f-publish-readiness-ledger.md` is a publish hold against `0.1.11`, with the 10-minute soak deferred.
- `qa/2026-06-29-release-notes-draft.md` describes the boundary and is stale on the unset-flag default.
- `qa/2026-06-29-security-review.md` records no critical or high finding in the then-current local queue and hybrid router scope.

## Doc defects for a later writer

Do not move the folder in this wave.

- Every PRD status line in this folder still says Backlog.
- Index `Related` cites ADR-0006 and does not cite ADR-0009. ADR-0009's own link still points at `library/requirements/backlog/prd-066-...`.
- Release notes draft and upgrade support notes still describe default-off / unknown-stays-shared. Code and ADR-0009 reversed that on 2026-07-05.
- Publish evidence is pinned to package `0.1.11`. Current `package.json` version is `0.22.0`.
