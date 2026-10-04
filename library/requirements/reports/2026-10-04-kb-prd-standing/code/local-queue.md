# Code standing: local queue

- Date: 2026-10-04
- Wave: 2, local queue
- Branch read: `legion/kb-sotu-and-prd-lifecycle`
- Inputs: `knowledge/operations-runtime-cost.md` (queue and hibernation claims only), `knowledge/data.md` (the `memory_jobs` claim), `prds/in-work-066.md`, `knowledge/architecture-adrs.md` (ADR-0006 and ADR-0009 only)
- Source walked: `src/daemon/runtime/services/local-queue-diagnostics.ts`, `src/daemon/runtime/services/local-job-queue.ts`, `src/daemon/runtime/services/hybrid-job-queue.ts`, and the hibernation pause list in `src/daemon/runtime/assemble.ts` (lines 3172-3207 and 4423-4572, plus `resolveLocalQueueBaseDir` at 2116-2129). Cited neighbors were opened only at the lines named below.
- Build outputs and `node_modules` were not used.
- No docs or source were edited except this report. No commit.

Verdicts on a wave-1 recommendation: `CONFIRM`, `OVERTURN`, or `UNVERIFIABLE`.

ASCII hyphens only.

## Counts

| Verdict | Count |
|---|---|
| CONFIRM | 22 |
| OVERTURN | 2 |
| UNVERIFIABLE | 0 |

The two overturns are 066e AC-8 and 066e AC-9 as implementation gaps. The written criteria contradict ADR-0009. Update the PRD text. Do not change the code to restore "unknown stays on the shared queue."

PRD-066 stays in `library/requirements/in-work/prd-066-local-queue-idle-cost-control/`. Do not move it to `completed`. Do not move it back to `backlog`.

ADR-0009 already records the local-queue default. Do not write a second ADR for that decision. Do not reserve 0012 for it.

## What the code does

Unset `HONEYCOMB_LOCAL_QUEUE_ENABLED` enables the local queue when `resolveLocalQueueTopology().eligibleForDefaultOn` is true (`src/daemon/runtime/services/hybrid-job-queue.ts:46-64`). Undeclared topology is eligible (`src/daemon/runtime/services/local-queue-diagnostics.ts:111-122`). `single_machine` is eligible (`:93-99`). `fleet` and `multi_device` are not, unless `HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN` forces eligibility (`:84-90` and `:102-108`). An explicit `false` / `0` / `no` / `off` wins and is the rollback (`hybrid-job-queue.ts:58-59` and `:214-218`).

The ten pipeline kinds in `DEFAULT_LOCAL_JOB_KINDS` (`hybrid-job-queue.ts:15-26`) enqueue on SQLite. Unknown kinds stay on the shared DeepLake queue (`:84-90`). With drain off, a local-only lease does not call the shared queue (`:179-185`), and `start()` does not start the shared reaper (`:141-146`). Drain defaults off (`:62` and `:202-205`).

Production opens `<honeycombStateDir()>/.daemon/local-queue.db` (`src/daemon/runtime/assemble.ts:2128-2129` and `:3175-3181`). `honeycombStateDir()` is `resolveFleetRoot()` plus `PRODUCT_SLUG` (`src/shared/fleet-root.ts:103-104`, `src/shared/constants.ts:35`). Fleet root is absolute `APIARY_HOME`, else absolute `$XDG_STATE_HOME/apiary` on Linux, else `<home>/.apiary` (`src/shared/fleet-root.ts:78-95`). The private helper in `local-job-queue.ts:291-292` falls back to `process.cwd()` only when `baseDir` is omitted. Assembly always passes `baseDir`.

`storageHealthProbeEnabled` is false when the local queue is on and drain is off (`src/daemon/runtime/assemble.ts:3174`). The `health-probe` pausable is pushed only inside that flag (`:4491-4502`).

## Operations: queue and hibernation

Page actions from the wave-1 coverage table: REVISE `library/knowledge/private/operations/local-queue-idle-cost-control.md` and REVISE `library/knowledge/private/operations/deeplake-idle-hibernation.md`. Both page actions stand. No page removal.

### C01. Future default-on sentence

- Claim: line 73 still describes a future default-on rollout. Verdict in wave 1: STALE, action REVISE.
- Quote: "This is the gate that keeps a future default-on rollout from silently breaking cross-device coordination."
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:73`
- Code: default-on is already the unset-flag path (`src/daemon/runtime/services/hybrid-job-queue.ts:46-59`, `src/daemon/runtime/services/local-queue-diagnostics.ts:111-122`). The same page already says so at line 78 and in the flag table at line 83.
- Verdict: CONFIRM
- Action: REVISE line 73 so it matches line 78 and line 83. Keep the fleet / multi-device guard. Do not add an ADR.

### C02. Diagnostics body is five fields, not four

- Claim: "The response reports four things." Wave 1: HOLE, action REVISE.
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:70`
- Code: `LocalQueueUpgradeDiagnostics` has `localQueue`, `topology`, `rollback`, `pendingSharedLocalJobs`, and `queryMeter` (`src/daemon/runtime/services/local-queue-diagnostics.ts:58-69`). `queryMeter` is null when no reader is injected (`:159`).
- The other four sections match. `localWorkWillNotProcess` is `:136` and `:152-156`. Pending shared timeout is `PENDING_SHARED_LOCAL_JOBS_TIMEOUT_MS` at `:17`, `unavailable` at `:173-178`. The pending query uses `sqlIdent` and `MAX(version)` at `:214-225`.
- Verdict: CONFIRM
- Action: REVISE the "four things" list to include `queryMeter`, including the null case.

### C03. Queue path omits the XDG leg

- Claim: line 79 writes the database as only `~/.apiary/honeycomb/.daemon/local-queue.db`. Wave 1: HOLE, action REVISE. Line 46 names `os.homedir()` / `APIARY_HOME` and skips XDG.
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:46` and `:79`
- Code: assembled base is `honeycombStateDir()` (`src/daemon/runtime/assemble.ts:2128-2129`, passed at `:3179`). Resolution order is `src/shared/fleet-root.ts:87-95`. File name is `.daemon/local-queue.db` (`src/daemon/runtime/services/local-job-queue.ts:22-23` and `:256-270`). `trustedLocalQueueRoots` includes `resolveFleetRoot()` (`:313-318`).
- The home default is the path only when `APIARY_HOME` is unset and, on Linux, `XDG_STATE_HOME` is unset or not absolute.
- Verdict: CONFIRM
- Action: REVISE lines 46 and 79 to the fleet-root chain. Do not describe the omitted-`baseDir` cwd fallback as the assembled path.

### C04. Related omits ADR-0009

- Claim: Related cites ADR-0006 and not ADR-0009. Wave 1: HOLE, action ADD.
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:7-13`. Body line 78 already names the reversal.
- Code: ADR file `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md` exists and matches the router (see C10).
- Verdict: CONFIRM
- Action: ADD ADR-0009 to Related. Keep ADR-0006. Do not delete ADR-0006.

### C05. Hibernation handle table is behind assembly

- Claim: the handle table lists `summary`, `skillify`, `lease-coordinator` or `pipeline` plus `pollinating`, `pollinating-maintenance-tick`, `health-probe`, and `graph-build`. Wave 1: HOLE, action REVISE.
- Doc: `library/knowledge/private/operations/deeplake-idle-hibernation.md:47-53`
- Code, `src/daemon/runtime/assemble.ts:4428-4550`, also registers:
  - `lifecycle-reverify-tick` (`:4461-4470`)
  - `lifecycle-compact-access-tick` (`:4471-4480`)
  - `lifecycle-calibrate-tick` (`:4481-4490`)
  - `capture-outbox-drain` when `captureOutbox` is wired (`:4522-4531`)
  - `memory-outbox-drain` when `memoryOutbox` is wired (`:4540-4549`)
- Handles the doc already names are in that same block (`:4433-4455`, `:4491-4514`). `graph-build` stays inside `if (autoBuildGraph)` (`:4503`). `health-probe` is inside `if (storageHealthProbeEnabled)` (`:4491`). That flag is false on the default local-queue path (`:3174` with drain off at `hybrid-job-queue.ts:62`).
- Pollinating maintenance interval remains 60s (`src/daemon/runtime/pollinating/maintenance-tick.ts:21`). Controller idle default `120000`, floor `5000`, and explicit `false` / `0` off-switch match `src/daemon/runtime/services/deeplake-hibernation.ts:67-76`, `:74-75`, and `:351`.
- Verdict: CONFIRM
- Action: REVISE the table. Add the five handles. Say `health-probe` is absent when the local queue is on and shared drain is off.

### C06. Moving the job queue off DeepLake is not still a future PRD

- Claim: line 137 calls moving the job queue off DeepLake a separate future PRD. Wave 1: STALE, action REVISE.
- Quote: "The deeper structural fix, moving the job queue off DeepLake so idle equals zero DeepLake reads by construction rather than by pausing, is a separate future PRD."
- Doc: `library/knowledge/private/operations/deeplake-idle-hibernation.md:137`. Line 22 already says PRD-066 removed local coordination reads.
- Code: local kinds do not enqueue on DeepLake when the hybrid router is enabled (`src/daemon/runtime/services/hybrid-job-queue.ts:84-88`). Non-drain local-only lease returns null instead of calling shared (`:179-185`). Shared reaper stays stopped unless drain (`:141-146`).
- What remains on DeepLake: the shared queue for declared `fleet` / `multi_device`, drain mode, unknown job kinds, and the non-queue timers the pause list still registers.
- Same page, lines 130 and 135, still say retry deadlines live in `memory_jobs.next_run_at`. That column is real on the shared table (`src/daemon/storage/catalog/runtime-jobs.ts:98` and `:116`). Default local retries write `local_job.run_after` (`src/daemon/runtime/services/local-job-queue.ts:481-486`). Revise those two sentences in the same edit.
- Verdict: CONFIRM
- Action: REVISE line 137 so it agrees with line 22. Name the remaining DeepLake paths. Revise lines 130 and 135 to name `local_job.run_after` for the default queue and `memory_jobs.next_run_at` for the shared fallback.

### C07. Kind list, columns, and diagnostics route hold

- Claim: `DEFAULT_LOCAL_JOB_KINDS` and the `local_job` column list match. Wave 1: HOLDS, action LEAVE.
- Doc: `library/knowledge/private/operations/local-queue-idle-cost-control.md:46-54`
- Code: kinds `src/daemon/runtime/services/hybrid-job-queue.ts:15-26`. Columns `src/daemon/runtime/services/local-job-queue.ts:25-47`. Statuses `queued`, `retrying`, `leased`, `done`, `failed` at `:43-47`. `GET /api/diagnostics/local-queue` is the group plus path at `src/daemon/runtime/local-queue-diagnostics-api.ts:12-13`. CLI spawn includes `--experimental-sqlite` (`src/cli/runtime.ts:148`) and does not set `HONEYCOMB_LOCAL_QUEUE_ENABLED`.
- Stats mapping `retrying` to `failed` and terminal `failed` to `dead` is the comment and the branch at `src/daemon/runtime/services/local-job-queue.ts:101-103` and `:572-579`. That sentence inside operations defect 21 holds. It is not a reason to edit the queue page.
- Verdict: CONFIRM
- Action: LEAVE the kind list, the column list, and the five local statuses.

## Data: memory_jobs

### C08. memory_jobs is not the default restart-surviving distillation queue

- Claim: "`memory_jobs` is the durable distillation queue (lease, complete, fail, dead, with bounded retries) that lets work survive a daemon restart." Wave 1 D-03: STALE, action REVISE. The retention row still treats `memory_jobs` as the live queue.
- Doc: `library/knowledge/private/data/schema.md:119` and `:327`
- Code: `memory_jobs` still exists. Statuses are `queued`, `leased`, `done`, `failed`, and `dead` (`src/daemon/storage/catalog/runtime-jobs.ts:63-71`). Catalog pattern is `version-bumped` (`:131`). It is excluded from `COMPACTABLE_VERSION_BUMPED_TABLES` (`src/daemon/storage/compaction.ts:214-215` and `:221`). That exclusion holds. Do not add `memory_jobs` to the compaction allow-list while revising the paragraph.
- Default distillation kinds go to SQLite when the flag is unset and topology is eligible (`src/daemon/runtime/services/hybrid-job-queue.ts:15-26` and `:46-64`, `src/daemon/runtime/services/local-queue-diagnostics.ts:111-122`). The restart-surviving file on that path is `<fleetRoot>/honeycomb/.daemon/local-queue.db` (`src/daemon/runtime/assemble.ts:2128-2129`). Local completed rows prune after `completedRetentionMs`, default 24h (`src/daemon/runtime/services/local-job-queue.ts:146` and `:514-523`).
- `memory_jobs` remains the shared fallback for `fleet` / `multi_device`, for explicit rollback, and for unknown kinds.
- Verdict: CONFIRM
- Action: REVISE `schema.md:119` and the retention row at `:327`. Point the default queue at ADR-0009 and the local-queue section of `workspace-layout.md`. Keep `memory_jobs` as the shared DeepLake table and keep it out of the compaction allow-list.

## ADR-0006 and ADR-0009

### C09. ADR-0006 status line

- Claim: status is still Proposed after the queue shipped and ADR-0009 evolved it. Wave 1: STALE, action REVISE the status line only. README row 25 still says Proposed.
- Doc: `library/knowledge/private/architecture/adr/0006-local-queue-as-interim-idle-cost-control.md:5-6`. Banner at lines 3-4 already says evolved by ADR-0009 on 2026-07-05. README row: `library/knowledge/private/architecture/adr/README.md:25`.
- Code: the queue file, the hybrid router, and the probe gate exist (`src/daemon/runtime/services/local-job-queue.ts:4-6` and `:22-23`, `src/daemon/runtime/services/hybrid-job-queue.ts:15-26`, `src/daemon/runtime/assemble.ts:3174`). Secret-like payload keys are rejected (`local-job-queue.ts:157-167` and `:665-667`).
- The body link at `0006-local-queue-as-interim-idle-cost-control.md:156` points at `library/requirements/backlog/prd-066-local-queue-idle-cost-control/`. That path is absent. The live index is `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`.
- Verdict: CONFIRM
- Action: replace the status line with `Accepted (evolved by ADR-0009)`. Set README row 25 Status to those same words. Leave the body, including the "not superseded" clause. Do not retarget the PRD link in this ADR pass. Do not write a new ADR.

### C10. ADR-0009 holds

- Claim: Accepted 2026-07-05, evolves ADR-0006, decision matches code. Wave 1: HOLDS, action LEAVE. Do not add another local-queue ADR.
- Doc: `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md:3-4` and decisions at `:44-67`. README row 28 matches (`README.md:28`).
- Code match:
  1. Ten kinds: `src/daemon/runtime/services/hybrid-job-queue.ts:15-26`, same list as ADR-0009:46-48.
  2. Local module never calls the DeepLake client: `src/daemon/runtime/services/local-job-queue.ts:4-6`.
  3. Unknown and `single_machine` eligible; `fleet` and `multi_device` stay shared unless opted in: `src/daemon/runtime/services/local-queue-diagnostics.ts:80-122`.
  4. Explicit `HONEYCOMB_LOCAL_QUEUE_ENABLED` wins, including `false`: `src/daemon/runtime/services/hybrid-job-queue.ts:46-59`. `HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN` is an extra force-on (`local-queue-diagnostics.ts:84-90`), not a reversal of decision 4.
  5. Shared-path guard: stderr warning and `queue.shared_pipeline_path_active` at `src/daemon/runtime/assemble.ts:3195-3206`. `memoryQueue` is `"shared"` or `"local"` at `:3473`. `memoryFormation` is surfaced at `:3463`. Health types are `src/daemon/runtime/health.ts:306` and `:315`.
  6. Recurring `SELECT 1` probe stays off in local-queue mode: `src/daemon/runtime/assemble.ts:3174`.
- Lease wording, precision only. ADR-0009:48-49 says lease uses `UPDATE ... WHERE status=? AND attempts=?` inside `BEGIN IMMEDIATE`. `lease()` does `BEGIN IMMEDIATE` then `UPDATE ... WHERE id = ?` (`src/daemon/runtime/services/local-job-queue.ts:430-443` and `:620-621`). The `status` and `attempts` predicate is on `complete` and `fail` (`:461-462` and `:488-489`), and those two methods do not open `BEGIN IMMEDIATE`. Single-winner still comes from the SQLite write lock on lease. Not a reason to change the Accepted status or to add an ADR.
- Same absent backlog path at `0009-local-queue-as-default-deeplake-is-not-a-queue.md:120`. Leave the body.
- Verdict: CONFIRM
- Action: LEAVE ADR-0009. Do not add a duplicate ADR.

## PRD-066

Folder: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/`.

Wave 1 recommended staying in `in-work` because of 12 unmet rows. This pass confirms that bucket for the 10 still-required rows below. It overturns 066e AC-8 and 066e AC-9 as code gaps. Those two are stale PRD text against ADR-0009.

The 22 UNVERIFIABLE execution gates in the wave-1 report (typecheck, packaged smokes, live proofs, current `0.22.0` ledger rows, tag inspection) were not re-run. They stay unverifiable. They are not evidence for `completed`.

### C11. Stay in in-work

- Claim: keep the folder in `in-work`. Do not move it to `completed` or `archive`.
- Still-required gaps are C12 through C21. The local store, hybrid router, upgrade diagnostics, and ADR-0009 default-on are in the tree. Those shipped pieces do not close the rows below.
- Verdict: CONFIRM
- Action: leave the folder in `in-work`. Do not `git mv` it to `completed`.

### C12. 066b AC-6 idempotency keys

- Quote: "Duplicate execution is prevented or made harmless through idempotency keys."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066b-local-queue-idle-cost-control-worker-routing-and-migration.md:66`
- Code: `local_job` has no idempotency-key column (`src/daemon/runtime/services/local-job-queue.ts:335-352`). Duplicate avoidance is `BEGIN IMMEDIATE` plus one `UPDATE` (`:430-443`) and local-before-shared lease order (`src/daemon/runtime/services/hybrid-job-queue.ts:93-106`).
- Verdict: CONFIRM still unmet
- Action: keep the folder in `in-work` until this row is met or the criterion is explicitly withdrawn.

### C13. 066c AC-3 recall categorization

- Quote: "Active memory writes and recall reads are still visible and correctly categorized."
- PRD: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:47`
- Code: the live itest asserts `totalWrites > 0` (`tests/integration/local-queue-idle-meter-live.itest.ts:196`). It does not assert `recall-arm`. The rollout report still leaves recall categorization open (`qa/2026-06-29-idle-meter-live-report.md:37-38`).
- Verdict: CONFIRM still unmet
- Action: keep in `in-work` until a receipt categorizes recall reads separately from coordination polls.

### C14. 066c AC-6 sleep/wake and outage dogfood

- Quote: "Dogfood rollout runs long enough to include daemon restart, sleep/wake, and transient DeepLake outage scenarios."
- PRD: `prd-066c-local-queue-idle-cost-control-idle-cost-verification-and-rollout.md:50-51`
- Evidence: sleep/wake and transient outage are `Pending dogfood` (`qa/2026-06-29-prd-066e-dogfood-matrix.md:14-15`). No local-queue test names an outage scenario.
- Verdict: CONFIRM still unmet
- Action: keep in `in-work`. Restart automation does not close the sleep/wake or outage cells.

### C15. 066e AC-3 upgrade smoke does not prove memory rows or recall

- Quote: "Existing DeepLake memory rows and recall behavior remain available after upgrade."
- PRD: `prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:104`
- Code: packaged upgrade smoke checks health, `logs.db`, `local-queue.db`, and table names (`scripts/local-queue-packaged-upgrade-smoke.mjs:50-63`). It does not read memory rows or run recall. Dogfood matrix row for recall-after-upgrade is still pending (`qa/2026-06-29-prd-066e-dogfood-matrix.md:17`).
- Verdict: CONFIRM still unmet
- Action: keep in `in-work`.

### C16. 066e AC-12 dogfood matrix

- Quote: "Dogfood evidence covers restart, sleep/wake, transient DeepLake outage, and rollback."
- PRD: `prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:118`
- Evidence: sleep/wake and transient outage remain `Pending dogfood` (`qa/2026-06-29-prd-066e-dogfood-matrix.md:14-15`). Ledger lane 6 says the live dogfood was not run (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:54`).
- Verdict: CONFIRM still unmet
- Action: keep in `in-work`.

### C17. 066e AC-14 release gate does not run the idle-read proof

- Quote: "The release gate fails if idle local mode produces DeepLake coordination reads after the packaged upgrade."
- PRD: `prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:121-122`
- Code: `scripts/local-queue-packaged-live-proof.mjs:89` and `:315` throw when poll reads are not zero. `.github/workflows/ci.yaml:140` and `.github/workflows/release.yaml:158` run `npm run pack:check`. Neither workflow names `smoke:local-queue` or the live-proof script.
- Verdict: CONFIRM still unmet
- Action: keep in `in-work` until the idle-read failure is on the release gate, or the criterion is explicitly withdrawn.

### C18. 066f.5.1 ten-minute poll-lease window

- Quote: "During the idle window, `poll-lease` reads are zero after startup settle."
- PRD: `prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:341`. The lane requires at least 10 minutes unless the release owner accepts a shorter window (`:306`).
- Evidence: ledger open blocker 1 leaves that decision open and records a deferred 10-minute soak (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:50` and `:104-105`). A 120-second receipt exists (`:51`). The short-window mechanism is real (`src/daemon/runtime/services/hybrid-job-queue.ts:141-146`). That receipt is not an acceptance of the 10-minute bar.
- Verdict: CONFIRM still unmet
- Action: keep in `in-work` until the owner accepts the shorter window in the ledger or a 10-minute soak is recorded.

### C19. 066f.5.2 ten-minute poll-reaper window

- Quote: "During the idle window, `poll-reaper` reads are zero after startup settle."
- PRD: `prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:342`
- Code: reaper start is gated at `src/daemon/runtime/services/hybrid-job-queue.ts:145`. Same open 10-minute decision as C18.
- Verdict: CONFIRM still unmet
- Action: same as C18.

### C20. 066f.5.5 ledger has no cost implication

- Quote: "The ledger states the approximate cost implication and any remaining DeepLake cost paths."
- PRD: `prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:345-346`
- Evidence: `qa/2026-06-29-prd-066f-publish-readiness-ledger.md` has no cost figure and no remaining-path row. Remaining paths are in the release-notes draft and the upgrade support notes, which are not the ledger.
- Verdict: CONFIRM still unmet
- Action: keep in `in-work` until the ledger states the cost implication.

### C21. 066f.6.4 transient DeepLake outage

- Quote: "Transient DeepLake outage does not corrupt the local queue or lose retryable work."
- PRD: `prd-066f-local-queue-idle-cost-control-publish-readiness-gate.md:396`
- Code: `fail()` can schedule a local retry (`src/daemon/runtime/services/local-job-queue.ts:472-498`). No test drives a DeepLake failure, keeps the SQLite row, and shows a later success. Dogfood cell is pending (`qa/2026-06-29-prd-066e-dogfood-matrix.md:15`).
- Verdict: CONFIRM still unmet
- Action: keep in `in-work`.

### C22. Status lines still say Backlog

- Claim: every PRD status line in this folder says Backlog while the folder is `in-work`. Wave 1 said that is stale and is not a reason to move the folder back.
- Doc: index and 066a through 066f, each at line 3, `Status: Backlog`. Index Related cites ADR-0006 and does not cite ADR-0009 (`prd-066-local-queue-idle-cost-control-index.md:7`).
- Verdict: CONFIRM
- Action: when the PRD text is edited, set those status lines to in-work and cite ADR-0009. Do not `git mv` the folder to `backlog`.

### O01. 066e AC-8 is stale PRD text, not missing code

- Quote: "Default-on is blocked unless the install is classified as single-machine/local topology."
- PRD: `prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:112`
- Code contradicts the quote on purpose. Undeclared topology sets `eligibleForDefaultOn: true` (`src/daemon/runtime/services/local-queue-diagnostics.ts:111-121`). Unset flag uses that eligibility (`src/daemon/runtime/services/hybrid-job-queue.ts:58-59`). Test name: "undeclared (unknown) topology now DEFAULTS to the local queue (reverses PRD-066e)" (`tests/daemon/runtime/services/local-queue-diagnostics.test.ts:68-75`). ADR-0009 decision 3 is the accepted rule (`0009-local-queue-as-default-deeplake-is-not-a-queue.md:56-59`).
- Wave 1 marked this UNMET and counted it among the reasons `completed` waits. That disposition is overturned. The code matches ADR-0009. The PRD sentence does not.
- Verdict: OVERTURN
- Action: update the PRD sentence to match ADR-0009 (undeclared and `single_machine` default on; declared `fleet` / `multi_device` stay shared unless they opt in). Do not implement the old block. This row alone does not keep the folder in `in-work`. The folder stays in `in-work` until C12 through C21 are done.

### O02. 066e AC-9 unknown clause is stale PRD text

- Quote: "Multi-device, fleet, or unknown topology installs stay on fallback or require explicit opt-in."
- PRD: `prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md:113-114`. The same old rule is repeated at `:89` and `:164`.
- Code: `fleet` and `multi_device` stay ineligible (`src/daemon/runtime/services/local-queue-diagnostics.ts:102-108`, test `:61-66`). Unknown does not stay on fallback (`:111-121`). Explicit opt-in still forces eligibility (`:84-90`).
- Support notes still state the old rule (`qa/2026-06-29-prd-066e-upgrade-support-notes.md:81-94`). The 2026-06-29 QA report marked AC-8 and AC-9 Pass against the old rule (`qa/2026-06-29-prd-066e-qa-report.md:80-81`). That pass is not the current contract.
- Ledger open blocker 2 ("Decide whether PRD-066 must ship true default-on") is the pre-ADR-0009 question (`qa/2026-06-29-prd-066f-publish-readiness-ledger.md:106`). ADR-0009 closed it. Do not treat that blocker as remaining code work.
- Verdict: OVERTURN
- Action: update AC-9, the sibling sentences in 066e, the upgrade support notes, and the release-notes draft so unknown topology defaults to the local queue. Keep the `fleet` / `multi_device` fallback. Do not move the folder to `completed` on this text fix. C12 through C21 remain.

## Rejected actions

- Do not add an ADR for the local-queue default. ADR-0009 is the record.
- Do not change `resolveHybridJobQueueConfig` or `resolveLocalQueueTopology` to block unknown topology. That would contradict ADR-0009.
- Do not move PRD-066 to `completed`.
- Do not move PRD-066 to `backlog` because the status lines still say Backlog.
- Do not retarget ADR-0006 or ADR-0009 bodies in the status-line pass.
- Do not treat the lease `WHERE id = ?` precision note as a status change.

## Files read

Wave 1:

- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/operations-runtime-cost.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/data.md` (D-03 and the `memory_jobs` hold)
- `library/requirements/reports/2026-10-04-kb-prd-standing/prds/in-work-066.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/architecture-adrs.md` (ADR-0006 and ADR-0009 sections)
- `/home/marioaldayuz/.cursor/plans/kb_prd_standing_fleet_9354246d.plan.md` (Wave 2)

Knowledge and ADRs cited:

- `library/knowledge/private/operations/local-queue-idle-cost-control.md`
- `library/knowledge/private/operations/deeplake-idle-hibernation.md`
- `library/knowledge/private/data/schema.md` (lines 119 and 327)
- `library/knowledge/private/architecture/adr/0006-local-queue-as-interim-idle-cost-control.md`
- `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md`
- `library/knowledge/private/architecture/adr/README.md` (rows 25 and 28)

Source:

- `src/daemon/runtime/services/local-queue-diagnostics.ts`
- `src/daemon/runtime/services/local-job-queue.ts`
- `src/daemon/runtime/services/hybrid-job-queue.ts`
- `src/daemon/runtime/assemble.ts` (queue base, probe flag, shared-path guard, `memoryQueue`, pause list)
- `src/daemon/runtime/services/deeplake-hibernation.ts` (idle default, floor, off-switch)
- `src/daemon/runtime/local-queue-diagnostics-api.ts` (lines 12-13)
- `src/daemon/runtime/health.ts` (lines 306 and 315)
- `src/daemon/runtime/pollinating/maintenance-tick.ts` (line 21)
- `src/daemon/storage/catalog/runtime-jobs.ts`
- `src/daemon/storage/compaction.ts` (allow-list at 214-221)
- `src/shared/fleet-root.ts`
- `src/shared/constants.ts` (line 35)
- `src/cli/runtime.ts` (line 148)
- `tests/daemon/runtime/services/local-queue-diagnostics.test.ts` (lines 52-76)
- `tests/integration/local-queue-idle-meter-live.itest.ts` (line 196)
- `scripts/local-queue-packaged-upgrade-smoke.mjs` (lines 50-63)
- `scripts/local-queue-packaged-live-proof.mjs` (lines 89 and 315)
- `.github/workflows/ci.yaml` (line 140)
- `.github/workflows/release.yaml` (line 158)

PRD-066 text and QA cited in the rows above. The backlog PRD-066 path was checked and is absent.
