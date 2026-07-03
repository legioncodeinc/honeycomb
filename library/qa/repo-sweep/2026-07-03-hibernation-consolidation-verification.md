# QA Report: Deeplake Hibernation Consolidation (PR 198 + PR 223 integration + PR 185 salvage)

**Plan document:** Consolidation directive supplied by the invoker (no single PRD file authored the merge decision; the shipped design doc is `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md`)
**Audit date:** 2026-07-03
**Base branch:** `origin/main`
**Head:** `feat/deeplake-hibernation-consolidated` (4 commits ahead of `origin/main`), worktree `C:\Users\mario\GitHub\honeycomb-hibernation`
**Auditor:** quality-worker-bee

## Ordering check

`security-worker-bee` is reported by the invoker as having already run on this branch (clean at medium+, three documented Low/Info accepted risks). No separate written security report file for this branch was found under `library/qa/security/`, but the two Chris Lyle commits are themselves titled "address Aikido findings on hibernation controller" and their commit body cites specific Aikido rule IDs (`AIK_AI_logic_bugs`, `AIK_AI_long_function`) that were remediated, which corroborates an automated security pass occurred on this code before this audit. Proceeding on the invoker's explicit statement that ordering is respected.

## Summary

The consolidation is substantially complete and correct: PR 198's `DeepLakeHibernation` controller is cherry-picked byte-identical with author credit preserved, PR 223's pollinating maintenance tick is properly integrated as a hibernation-managed handle with a real-controller test, and the PR 185 salvage claims (no port needed for summary/skillify; the two open CodeRabbit majors are moot) both check out against independent verification of `main` and the `chrisl10/feat/idle-poll-hibernation` branch. `npm run ci` and the hibernation test files pass clean. One correctness gap was found in the wake-on-request wiring (`/health` and `/api/status` bypass the touch middleware due to Hono registration order, so `honeycomb status`/`honeycomb daemon status` do not wake a hibernated daemon, though the core capture/recall/hooks/mcp paths are unaffected), plus three smaller Warnings (a missing license header, an unwired hibernation logger, and no composition-root-level test of the disabled-flag rollback path). No Criticals. Recommend fixing the four Warnings before merge; none are blocking on their own, but per the no-medium+ bar this branch is **not** yet clean.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All four plan items (PR198 cherry-pick, PR223 integration, PR185 salvage claim, PR185 moot-majors claim) are implemented and verified against code, not just asserted |
| Correctness   | ⚠️ | Controller state machine, debounce, and pausable wiring are correct; `/health`+`/api/status` silently bypass the wake middleware (Hono registration-order gap) |
| Alignment     | ⚠️ | No-touch-file list respected, commit authorship/Co-authored-by correct, but the new controller source file is missing the AGPL header AGENTS.md requires and the immediately-preceding PR 223 files carry |
| Gaps          | ⚠️ | No composition-root test of the `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` rollback path through `assembleDaemon`; hibernation controller is wired with no logger, so hibernate/wake events never reach the daemon's structured log |
| Detrimental   | ✅ | No regressions in `npm run ci` (365/365 files, 4006/4006 tests); no dead code, no leftover debugging, no N+1s; PR185's superseded wake-bus/retryWakes code is correctly and completely absent from this branch |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **`/health` and `/api/status` do not wake a hibernated daemon**, `src/daemon/runtime/assemble.ts:2249` (touch middleware) vs `src/daemon/runtime/server.ts:331,356` (`/health`, `/api/status` routes)

  The plan requires "any inbound HTTP request wakes it," and the PRD-062e doc claims "every capture/recall/CLI request resumes the fleet." The wake middleware is registered via `daemon.app.use("*", ...)` in `assembleDaemon()` at line 2249, which runs AFTER `createDaemon(createOptions)` (line 2237) already mounted `/health` (`server.ts:331`) and `/api/status` (`server.ts:356`) directly on the same Hono app. Hono composes matched handlers for a path in registration order; since these two routes are terminal handlers registered before the wildcard middleware, they resolve and return without ever invoking `next()`, so the middleware never runs for them. Verified empirically against the installed Hono (v4.12.25): a minimal repro (route registered first, wildcard `app.use` registered second) shows the middleware never fires for that route. `src/commands/daemon.ts` confirms `honeycomb daemon status` / `honeycomb status` poll `/health` as their primary daemon-liveness check — a real "CLI call" per the doc's own wake-trigger list — so this specific, explicitly-named class of activity does not actually wake the fleet. The work-producing paths (capture, recall, `/api/hooks`, `/mcp`, dashboard) are all mounted by `assembleSeams()` at line 2315 — after the touch middleware — so they are correctly covered; this gap is confined to the two read-only diagnostic routes.

  Suggested: register the touch middleware inside `createDaemon()` (server.ts) before `/health`/`/api/status` are mounted, or move it into `assembleDaemon()` before `const daemon = createDaemon(createOptions)` is called by exposing a pre-mount hook, or simply add an explicit `touch()` call inside the `/health` and `/api/status` handlers.

  ```ts
  const onActivity = (): void => hibernation?.touch();
  daemon.app.use("*", async (_c, next) => {
      onActivity();
      await next();
  });
  ```

- [ ] **New source file is missing the required AGPL header**, `src/daemon/runtime/services/deeplake-hibernation.ts:1`

  AGENTS.md states "every new source file gets the header in `docs/license-header.txt`." `deeplake-hibernation.ts` opens with a JSDoc design comment, not the license header. This is a live, currently-followed convention, not a dead rule: the two newest files added by the immediately-preceding PR 223 merge (`src/daemon/runtime/capture/dropped-events.ts`, `src/daemon/runtime/pollinating/maintenance-tick.ts`) both carry it (confirmed: these are the only 2 of 381 `src/*.ts` files that do). This file predates PR 223 (authored 2026-06-30 on `chrisl10/feat/deeplake-connection-hibernation`, three days before PR 223 merged), but it is new to `main` as of this branch, so the current standard applies to it now.

  ```ts
  /**
   * Deep Lake connection hibernation — the idle-cost master switch (cost incident follow-up to PRD-062 / PRD-066).
  ```

- [ ] **No test exercises the real `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` rollback through the composition root**, `src/daemon/runtime/assemble.ts:2859` (`if (hibernationConfig.enabled && startBackgroundWorkers) {`)

  `envHibernationConfigProvider`'s env-parsing logic is unit-tested in isolation (AC-H.7, injected env object) and the controller's `enabled: false` no-op is unit-tested in isolation (AC-H.1, injected config object), but the actual glue — `envHibernationConfigProvider()` reading real `process.env` and gating this block inside `assembleDaemon().start()` — has no dedicated test. `tests/daemon/runtime/assemble.test.ts` incidentally exercises the ENABLED default path (~20 tests call `.start()`/`.shutdown()` with real workers under the default env, all passing in `npm run ci`), which gives partial confidence the wiring doesn't crash, but nothing sets the rollback flag and asserts the pausable set is never built / no worker is ever paused at the composition-root level (only at the pure-controller level).

  ```ts
  if (hibernationConfig.enabled && startBackgroundWorkers) {
  ```

- [ ] **The hibernation controller is wired with no logger**, `src/daemon/runtime/assemble.ts:2911-2923`

  `createDeepLakeHibernation({ pausables, config: hibernationConfig, now: () => Date.now(), timers: {...} })` omits the optional `logger` field. `HibernationController` can emit `deeplake.hibernated` / `deeplake.woke` events and logs a `hibernate.pause.error` / `wake.resume.error` when a handle throws (`deeplake-hibernation.ts:136,141,228,240`), but none of this reaches the daemon's structured log in production — only silence. For a cost-tracking feature whose own doc lists "confirm the live before/after compute-hours number" as the open proof, having zero log signal for hibernate/wake transitions (and swallowed handle errors) is a real observability gap. Likely omitted because `RequestLogger` (`daemon.logger`) exposes `.event(name, fields)`, not the `.info(event, fields)` shape `HibernationLogger` expects — a 3-line adapter would close the gap:

  ```ts
  logger: { info: (event, fields) => daemon.logger.event(event, fields) },
  ```

## Suggestions (consider improving)

- [ ] **Test files also omit the AGPL header**, `tests/daemon/runtime/services/deeplake-hibernation.ts:1`, `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts:1`

  Same AGENTS.md rule applies to "every new source file," and these are new files. Not raised as a Warning because compliance in `tests/` is effectively 0% repo-wide (1 of 346 `.test.ts` files), so this is not currently a live, enforced convention for tests the way it is for `src/`. Worth a header pass across `tests/` in a dedicated follow-up rather than singling out these two files.

## Plan Item Traceability

| #      | Plan Requirement                                                                                                  | Status | Implementation Location | Notes |
|--------|---------------------------------------------------------------------------------------------------------------------|--------|--------------------------|-------|
| REQ-1.1 | PR 198's `DeepLakeHibernation` controller cherry-picked intact, 2 commits | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts` (12a1152, 65696e1) | Diffed byte-for-byte against `chrisl10/feat/deeplake-connection-hibernation`'s `fd5d40b`/`ca72684` — identical new-file content and identical hibernation-specific hunks in `assemble.ts`; only unrelated rebase-context lines differ |
| REQ-1.2 | Chris Lyle authorship preserved | ✅ | commits `12a1152`, `65696e1` | `git log --format='%an %ae'` shows `Chris Lyle <chrisllyle@gmail.com>` as Author; Mario Aldayuz as Committer (the cherry-picker) — correct git semantics |
| REQ-1.3 | Default idle window 120s, 5s floor | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts:51,53` | `DEFAULT_HIBERNATE_IDLE_MS = 120_000`, `MIN_HIBERNATE_IDLE_MS = 5_000`, clamped in `resolveIdleMs` |
| REQ-1.4 | `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` default-on, explicit `false`/`0` rollback | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts:261-265` | `envHibernationConfigProvider`; unit-tested AC-H.7 including the "malformed value stays enabled" Aikido-driven fix |
| REQ-1.5 | Pauses ALL background Deeplake-touching activity (pipeline/pollinating/summary/skillify or lease coordinator, health probe, graph rebuild) | ✅ | `src/daemon/runtime/assemble.ts:2859-2924` | `addWorker("summary"/"skillify")`, lease-coordinator XOR pipeline+pollinating, `pollinating-maintenance-tick`, `health-probe` (conditional), `graph-build` (conditional) all pushed into `pausables` |
| REQ-1.6 | Any inbound HTTP request wakes it | ⚠️ | `src/daemon/runtime/assemble.ts:2249` | True for capture/recall/hooks/mcp/dashboard (mounted after the touch middleware at `assembleSeams()`, line 2315); **not** true for `/health`/`/api/status` (mounted before the touch middleware inside `createDaemon()`) — see Warning above |
| REQ-1.7 | Local capture keeps working while hibernated | ✅ | `src/daemon/runtime/assemble.ts:2249-2253` (middleware), capture path untouched by this diff | `captureHandler`/local queue are never added to `pausables`; the touch middleware calls `next()` unconditionally and does not gate the request — architecturally provable by construction, not by a dedicated capture-while-hibernated test |
| REQ-2.1 | PR 223's pollinating maintenance tick registered as a hibernation pausable | ✅ | `src/daemon/runtime/assemble.ts:2527-2530` (arm helper), `:2878-2887` (pausable registration) | `armPollinatingMaintenanceTick()` shared by initial start + resume |
| REQ-2.2 | Pause cancels, wake re-arms, no double-arm | ✅ | `src/daemon/runtime/assemble.ts:2527-2530,2878-2887` | `armPollinatingMaintenanceTick` guards `if (pollinatingMaintenanceTick !== null) return;`; pause stops + nulls the handle |
| REQ-2.3 | Real-controller test | ✅ | `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` | AC-H.8; wires the REAL `createDeepLakeHibernation` to the REAL `startPollinatingMaintenanceTick`; passes (`npx vitest run` — 1/1) |
| REQ-3.1 | "No port needed" claim: summary/skillify already on the adaptive poll loop in `main`, and covered by hibernation pausables | ✅ | `origin/main:src/daemon/runtime/summaries/job.ts:311`, `origin/main:src/daemon/runtime/skillify/worker.ts:296` (both call `buildWorkerPollLoop`); `src/daemon/runtime/assemble.ts:2859-2860` (`addWorker("summary"...)`, `addWorker("skillify"...)`) | Confirmed independently: `main` already has the 062b adaptive-loop migration for both workers (predates this branch); the PR185 branch's diff to these same files is exclusively the superseded wake()/idle-suspend layer (Non-Goal, correctly not ported) |
| REQ-3.2 | PRD-062e doc carried over and updated to describe the consolidated design | ✅ | `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md` (commit `1e6efad`) | Describes the shipped controller, the PR223 tick integration, the summary/skillify inheritance, and explicitly records the poll-suspend/wake-bus proposal as superseded/not-taken |
| REQ-3.3 | Co-authored-by credit to Chris Lyle | ✅ | commit `1e6efad` | `Co-authored-by: Chris Lyle <chrisllyle@gmail.com>` trailer present |
| REQ-4.1 | Open CodeRabbit major (durable retry deadlines) assessed as moot | ✅ | PR 185 review comment on `job-queue.ts:540` ("Rebuild retry-deadline wakes after restart") | Confirmed moot: `retryWakes`/the persisted-retry-deadline-wake mechanism is part of the superseded poll-suspend design and does not exist anywhere on this branch (`grep -n "retryWakes" src/daemon/runtime/services/job-queue.ts` → no matches) |
| REQ-4.2 | Open CodeRabbit major (no wake-bus state) assessed as moot | ✅ | PR 185 review comment on `poll-loop.ts:188` ("Preserve the wake reset when a tick is already running") | Confirmed moot: `wake-bus.ts` does not exist on this branch, and `poll-loop.ts` on this branch has no `wake()` method at all (`grep -n "wake("` → no matches) — the whole per-loop wake state machine this bug lived in was never imported |
| NG-1 | Non-goal: no per-loop suspend state machine / wake bus imported | ✅ | (absence confirmed) | `wake-bus.ts` absent, no `retryWakes`, no `PollLoop.wake()` anywhere on this branch |
| NG-2 | Non-goal: no queue-backing change | ✅ | (no diff to queue storage) | `memory_jobs` schema untouched; append-only write pattern unchanged |
| REG-1 | PR 223's capture/dropped-events behavior intact when hibernation disabled | ✅ | (unaffected by this diff — zero lines touched in `capture/`) | `npm run ci` green (365/365 files); capture path is never added to `pausables` so hibernation state cannot affect it either way |
| REG-2 | PR 223's maintenance-tick behavior intact when hibernation disabled | ✅ | `tests/daemon/runtime/pollinating/maintenance-tick.test.ts` | Ran directly: 2/2 passing, unmodified by this branch |
| REG-3 | Daemon shutdown clean | ✅ | `src/daemon/runtime/assemble.ts:2937-2940` | `hibernation?.stop()` runs first (cancels the debounce timer only, never touches handles) before the workers' own `stop()` calls, so a wake can never race teardown; `npm run ci`'s 4006 tests (which repeatedly call `.start()`/`.shutdown()` on real daemons) all complete without hanging |
| ALIGN-1 | AGENTS.md + CONVENTIONS.md compliance | ⚠️ | — | No no-touch-file violations (server.ts/index.ts/config.ts/logger.ts/permission.ts/services/types.ts all untouched); SQL-safety audit clean; but see the license-header Warning above |
| ALIGN-2 | License headers | ⚠️ | `src/daemon/runtime/services/deeplake-hibernation.ts:1` | See Warning above |
| ALIGN-3 | No no-touch-file edits | ✅ | `git diff origin/main...HEAD --name-status` | Only `assemble.ts` (M) and new files touched; none of the six no-touch files appear |
| ALIGN-4 | Commit authorship/credit correctness | ✅ | commits `12a1152`,`65696e1`,`cffa4f0`,`1e6efad` | Chris Lyle preserved as Author on the cherry-picks; Co-authored-by trailer on the docs commit; Mario Aldayuz correctly the sole author of the two new integration/docs commits |

## Files Changed

- `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md` (M), added the PRD-062e row, status "Consolidated"
- `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md` (A), the consolidated design doc, carried over from `chrisl10/feat/idle-poll-hibernation` and rewritten; Co-authored-by Chris Lyle
- `src/daemon/runtime/assemble.ts` (M), wires `DeepLakeHibernation` at the composition root: the `touch()` root middleware, arm helpers for health-probe/graph-build/pollinating-maintenance-tick, the pausable set construction, and start/stop across the daemon lifecycle
- `src/daemon/runtime/services/deeplake-hibernation.ts` (A), the `DeepLakeHibernation` controller, cherry-picked from PR 198 (Chris Lyle) — missing the AGPL header (Warning)
- `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` (A), new PRD-223 integration test wiring the real controller to the real maintenance tick (AC-H.8)
- `tests/daemon/runtime/services/deeplake-hibernation.test.ts` (A), the controller's manual-clock unit suite, cherry-picked from PR 198 (Chris Lyle)

## Verification commands run

- `npm run ci` → exit 0 (365/365 test files, 4006 passed / 12 skipped; jscpd clean; SQL-safety audit clean over 288 files)
- `npx vitest run tests/daemon/runtime/services/deeplake-hibernation.test.ts tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` → 2/2 files, 10/10 tests passed
- `npx vitest run tests/daemon/runtime/pollinating/maintenance-tick.test.ts` → 1/1 file, 2/2 tests passed (PR 223 regression, unmodified by this branch)
- Byte-diff of `fd5d40b`/`ca72684` (chrisl10/feat/deeplake-connection-hibernation) against `12a1152`/`65696e1` (this branch) → identical new-file content, identical hibernation-specific hunks
- `grep`/`git show` against `origin/main` and `chrisl10/feat/idle-poll-hibernation` for `buildWorkerPollLoop`, `wake-bus.ts`, `retryWakes`, `PollLoop.wake(` → confirmed the "no port needed" and "moot majors" claims
- Minimal Hono 4.12.25 repro confirming a wildcard `app.use` registered after a terminal route never fires for that route → basis for the `/health`/`/api/status` Warning

## Overall verdict

**FAIL at the no-medium+ bar.** Zero Criticals; four Warnings (one Correctness gap in the wake-on-request path, one missing license header, one missing composition-root test of the rollback flag, one missing logger wire-up). All four are small, well-scoped fixes; none touch the core state machine, the PR223 integration, or the PR185 moot-majors assessment, which are all verified correct. Recommend landing the fixes above, then a fast re-audit rather than a full re-run of this report.
