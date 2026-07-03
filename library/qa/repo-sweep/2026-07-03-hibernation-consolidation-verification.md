# QA Report: Deeplake Hibernation Consolidation (PR 198 + PR 223 integration + PR 185 salvage)

**Plan document:** Consolidation directive supplied by the invoker (no single PRD file authored the merge decision; the shipped design doc is `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md`)
**Audit date:** 2026-07-03 (initial), 2026-07-03 (re-audit after remediation commits `bf9c348`, `00647e8`, `661fcbf`)
**Base branch:** `origin/main`
**Head:** `feat/deeplake-hibernation-consolidated`, worktree `C:\Users\mario\GitHub\honeycomb-hibernation` (initial audit at 4 commits ahead; re-audit at 8 commits ahead: 4 implementation + this report + 3 remediation)
**Auditor:** quality-worker-bee

## Ordering check

`security-worker-bee` is reported by the invoker as having already run on this branch (clean at medium+, three documented Low/Info accepted risks). No separate written security report file for this branch was found under `library/qa/security/`, but the two Chris Lyle commits are themselves titled "address Aikido findings on hibernation controller" and their commit body cites specific Aikido rule IDs (`AIK_AI_logic_bugs`, `AIK_AI_long_function`) that were remediated, which corroborates an automated security pass occurred on this code before this audit. Proceeding on the invoker's explicit statement that ordering is respected.

## Summary

**Re-audit verdict (2026-07-03, after remediation): PASS at the no-medium+ bar.** All four Warnings from the initial audit are closed by commits `bf9c348` (AGPL header), `00647e8` (logger wired + emission tests), and `661fcbf` (the `/health`+`/api/status` wake bypass documented as intended design with a registration-order guard comment, plus pinning test AC-62e.7 and the composition-root env-rollback test AC-62e.6). `npm run ci` exits 0 after remediation (367/367 files, 4011 passed / 12 skipped; up 2 files / 5 tests, exactly the two new suites); no regressions introduced. Zero Criticals, zero Warnings outstanding. One pre-existing Suggestion (test-file headers) remains open and does not block.

Initial audit summary (retained for the record): the consolidation was substantially complete and correct. PR 198's `DeepLakeHibernation` controller was cherry-picked byte-identical with author credit preserved, PR 223's pollinating maintenance tick was properly integrated with a real-controller test, and both PR 185 salvage claims verified independently. Four Warnings were found (the `/health`/`/api/status` wake bypass, a missing license header, an unwired hibernation logger, and no composition-root rollback test), making the initial verdict FAIL at the no-medium+ bar. Each is now resolved; see the annotated Warnings below.

## Scorecard

Post-remediation scorecard (initial statuses in parentheses where they changed):

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All four plan items (PR198 cherry-pick, PR223 integration, PR185 salvage claim, PR185 moot-majors claim) are implemented and verified against code, not just asserted |
| Correctness   | ✅ (was ⚠️) | Controller state machine, debounce, and pausable wiring correct; the `/health`+`/api/status` wake bypass is now a documented, test-pinned intended design (`661fcbf`): the doc/plan wording that contradicted the behavior was corrected rather than the behavior, with sound cost rationale (a monitoring poller hitting `/health` on a short interval would otherwise keep the pod warm forever and defeat the fix) |
| Alignment     | ✅ (was ⚠️) | No-touch-file list respected (server.ts still untouched after remediation), commit authorship/Co-authored-by correct; AGPL header added in `bf9c348` as a header-only commit so the cherry-picked history stays clean |
| Gaps          | ✅ (was ⚠️) | Composition-root env-rollback test added (AC-62e.6 in `tests/daemon/runtime/assemble-hibernation.test.ts`, `661fcbf`); logger wired with an adapter + emission contract tests (AC-H.9 / AC-62e.8, `00647e8`) |
| Detrimental   | ✅ | No regressions in `npm run ci` after remediation (367/367 files, 4011/4011 non-skipped tests); the +2 files / +5 tests delta vs the initial run is exactly the two new remediation suites; no dead code, no leftover debugging; PR185's superseded wake-bus/retryWakes code still completely absent |

## Critical Issues (must fix)

None.

## Warnings (should fix)

All four Warnings below are **RESOLVED** as of the 2026-07-03 re-audit. Each retains its original text for the record, followed by the resolution evidence.

- [x] **`/health` and `/api/status` do not wake a hibernated daemon**, `src/daemon/runtime/assemble.ts:2249` (touch middleware) vs `src/daemon/runtime/server.ts:331,356` (`/health`, `/api/status` routes)

  The plan requires "any inbound HTTP request wakes it," and the PRD-062e doc claims "every capture/recall/CLI request resumes the fleet." The wake middleware is registered via `daemon.app.use("*", ...)` in `assembleDaemon()` at line 2249, which runs AFTER `createDaemon(createOptions)` (line 2237) already mounted `/health` (`server.ts:331`) and `/api/status` (`server.ts:356`) directly on the same Hono app. Hono composes matched handlers for a path in registration order; since these two routes are terminal handlers registered before the wildcard middleware, they resolve and return without ever invoking `next()`, so the middleware never runs for them. Verified empirically against the installed Hono (v4.12.25): a minimal repro (route registered first, wildcard `app.use` registered second) shows the middleware never fires for that route. `src/commands/daemon.ts` confirms `honeycomb daemon status` / `honeycomb status` poll `/health` as their primary daemon-liveness check — a real "CLI call" per the doc's own wake-trigger list — so this specific, explicitly-named class of activity does not actually wake the fleet. The work-producing paths (capture, recall, `/api/hooks`, `/mcp`, dashboard) are all mounted by `assembleSeams()` at line 2315 — after the touch middleware — so they are correctly covered; this gap is confined to the two read-only diagnostic routes.

  Suggested: register the touch middleware inside `createDaemon()` (server.ts) before `/health`/`/api/status` are mounted, or move it into `assembleDaemon()` before `const daemon = createDaemon(createOptions)` is called by exposing a pre-mount hook, or simply add an explicit `touch()` call inside the `/health` and `/api/status` handlers.

  ```ts
  const onActivity = (): void => hibernation?.touch();
  daemon.app.use("*", async (_c, next) => {
      onActivity();
      await next();
  });
  ```

  **RESOLVED in `661fcbf`**, closed by making the split an explicit, guarded, test-pinned intended design rather than changing the behavior. This is a legitimate closure, not a paper-over: the finding's substance was that the behavior contradicted the documentation ("any inbound HTTP request wakes it") and could silently flip on a future route reorder. Both halves are addressed. (1) The design intent and its cost rationale (a monitoring poller hitting `/health` on a short interval must not keep the Activeloop pod warm, or the idle window never elapses and hibernation never fires, which is the exact bug the controller exists to fix; a hibernated daemon still answers `/health` from its cached bit with no Deeplake round trip) are now stated in three places: the controller module doc (`deeplake-hibernation.ts:45-57`), the wiring-site comment with an explicit do-not-reorder warning naming the mechanism (`assemble.ts:2246-2256`), and the PRD-062e doc, whose "any inbound request" / "CLI call" wake-trigger wording is corrected to "work-carrying inbound request" throughout, with a dedicated non-waking-liveness paragraph and new AC-62e.7. (2) The split is pinned at the composition root by `tests/daemon/runtime/assemble-hibernation.test.ts:154-195`: through the real `assembleDaemon`, `GET /health` against a hibernated daemon answers 200 without resuming any handle and without a `deeplake.woke` event, while a capture request wakes the fleet; a future reorder that flips the split fails this test. `server.ts` remains untouched (verified: `git diff origin/main...HEAD -- src/daemon/runtime/server.ts` is empty). Verified by running the suite: 2/2 tests pass.

- [x] **New source file is missing the required AGPL header**, `src/daemon/runtime/services/deeplake-hibernation.ts:1`

  AGENTS.md states "every new source file gets the header in `docs/license-header.txt`." `deeplake-hibernation.ts` opens with a JSDoc design comment, not the license header. This is a live, currently-followed convention, not a dead rule: the two newest files added by the immediately-preceding PR 223 merge (`src/daemon/runtime/capture/dropped-events.ts`, `src/daemon/runtime/pollinating/maintenance-tick.ts`) both carry it (confirmed: these are the only 2 of 381 `src/*.ts` files that do). This file predates PR 223 (authored 2026-06-30 on `chrisl10/feat/deeplake-connection-hibernation`, three days before PR 223 merged), but it is new to `main` as of this branch, so the current standard applies to it now.

  ```ts
  /**
   * Deep Lake connection hibernation — the idle-cost master switch (cost incident follow-up to PRD-062 / PRD-066).
  ```

  **RESOLVED in `bf9c348`**: the exact comment-wrapped header from `docs/license-header.txt` now opens the file (`deeplake-hibernation.ts:1-9`, verified byte-for-byte against the template). Done as a header-only commit so Chris Lyle's cherry-picked commits stay untouched in history, the right call for authorship hygiene.

- [x] **No test exercises the real `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` rollback through the composition root**, `src/daemon/runtime/assemble.ts:2859` (`if (hibernationConfig.enabled && startBackgroundWorkers) {`)

  `envHibernationConfigProvider`'s env-parsing logic is unit-tested in isolation (AC-H.7, injected env object) and the controller's `enabled: false` no-op is unit-tested in isolation (AC-H.1, injected config object), but the actual glue — `envHibernationConfigProvider()` reading real `process.env` and gating this block inside `assembleDaemon().start()` — has no dedicated test. `tests/daemon/runtime/assemble.test.ts` incidentally exercises the ENABLED default path (~20 tests call `.start()`/`.shutdown()` with real workers under the default env, all passing in `npm run ci`), which gives partial confidence the wiring doesn't crash, but nothing sets the rollback flag and asserts the pausable set is never built / no worker is ever paused at the composition-root level (only at the pure-controller level).

  ```ts
  if (hibernationConfig.enabled && startBackgroundWorkers) {
  ```

  **RESOLVED in `661fcbf`**: `tests/daemon/runtime/assemble-hibernation.test.ts:197-218` (AC-62e.6) drives the real `assembleDaemon` with `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` stubbed into the real `process.env` (via `vi.stubEnv`, which is what `envHibernationConfigProvider()` actually reads at `assemble.ts:2258`): after 3x the idle window the recording worker is never paused and no `deeplake.hibernated` event is logged; the only `stop()` is the lifecycle stop at shutdown, asserted to be exactly once. The companion test (AC-62e.7, same suite) covers the default-env arming path, so both sides of the gate at `assemble.ts:2870` are now exercised at the composition root. Verified by running the suite: passes. AC-62e.6 in the PRD-062e doc was amended to include the composition-root proof.

- [x] **The hibernation controller is wired with no logger**, `src/daemon/runtime/assemble.ts:2911-2923`

  `createDeepLakeHibernation({ pausables, config: hibernationConfig, now: () => Date.now(), timers: {...} })` omits the optional `logger` field. `HibernationController` can emit `deeplake.hibernated` / `deeplake.woke` events and logs a `hibernate.pause.error` / `wake.resume.error` when a handle throws (`deeplake-hibernation.ts:136,141,228,240`), but none of this reaches the daemon's structured log in production — only silence. For a cost-tracking feature whose own doc lists "confirm the live before/after compute-hours number" as the open proof, having zero log signal for hibernate/wake transitions (and swallowed handle errors) is a real observability gap. Likely omitted because `RequestLogger` (`daemon.logger`) exposes `.event(name, fields)`, not the `.info(event, fields)` shape `HibernationLogger` expects — a 3-line adapter would close the gap:

  ```ts
  logger: { info: (event, fields) => daemon.logger.event(event, fields) },
  ```

  **RESOLVED in `00647e8`**: exactly the suggested adapter now sits in the controller construction (`assemble.ts:2940`): `logger: { info: (event, fields) => daemon.logger.event(event, fields) }`, so hibernate/wake transitions and swallowed handle errors land in the daemon's event ring buffer. The emission contract is pinned two ways: at the unit level by the new `tests/daemon/runtime/services/deeplake-hibernation-logging.test.ts` (AC-H.9: `deeplake.hibernated` with `{ idleMs, handles }`, `deeplake.woke` with `{ handles }`, and `hibernate.pause.error` / `wake.resume.error` carrying the handle label + message while the sweep completes), and at the assembly level by `assemble-hibernation.test.ts` asserting the events appear in `logger.recentEvents()` through the real wired adapter. Verified by running both suites: 5/5 tests pass. PRD-062e gained AC-62e.8 documenting the observability contract.

## Suggestions (consider improving)

- [ ] **Test files also omit the AGPL header**, `tests/daemon/runtime/services/deeplake-hibernation.test.ts:1`, `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts:1`

  Same AGENTS.md rule applies to "every new source file," and these are new files. Not raised as a Warning because compliance in `tests/` is effectively 0% repo-wide (1 of 346 `.test.ts` files), so this is not currently a live, enforced convention for tests the way it is for `src/`. Worth a header pass across `tests/` in a dedicated follow-up rather than singling out these two files. Still open after remediation (the two new remediation test files follow the same repo-wide test-file norm and also omit it); remains a Suggestion, non-blocking.

## Plan Item Traceability

| #      | Plan Requirement                                                                                                  | Status | Implementation Location | Notes |
|--------|---------------------------------------------------------------------------------------------------------------------|--------|--------------------------|-------|
| REQ-1.1 | PR 198's `DeepLakeHibernation` controller cherry-picked intact, 2 commits | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts` (12a1152, 65696e1) | Diffed byte-for-byte against `chrisl10/feat/deeplake-connection-hibernation`'s `fd5d40b`/`ca72684` — identical new-file content and identical hibernation-specific hunks in `assemble.ts`; only unrelated rebase-context lines differ |
| REQ-1.2 | Chris Lyle authorship preserved | ✅ | commits `12a1152`, `65696e1` | `git log --format='%an %ae'` shows `Chris Lyle <chrisllyle@gmail.com>` as Author; Mario Aldayuz as Committer (the cherry-picker) — correct git semantics |
| REQ-1.3 | Default idle window 120s, 5s floor | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts:51,53` | `DEFAULT_HIBERNATE_IDLE_MS = 120_000`, `MIN_HIBERNATE_IDLE_MS = 5_000`, clamped in `resolveIdleMs` |
| REQ-1.4 | `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` default-on, explicit `false`/`0` rollback | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts:261-265` | `envHibernationConfigProvider`; unit-tested AC-H.7 including the "malformed value stays enabled" Aikido-driven fix |
| REQ-1.5 | Pauses ALL background Deeplake-touching activity (pipeline/pollinating/summary/skillify or lease coordinator, health probe, graph rebuild) | ✅ | `src/daemon/runtime/assemble.ts:2859-2924` | `addWorker("summary"/"skillify")`, lease-coordinator XOR pipeline+pollinating, `pollinating-maintenance-tick`, `health-probe` (conditional), `graph-build` (conditional) all pushed into `pausables` |
| REQ-1.6 | Any inbound HTTP request wakes it | ✅ | `src/daemon/runtime/assemble.ts:2246-2262` (wiring + guard comment); `tests/daemon/runtime/assemble-hibernation.test.ts:154-195` (pin) | Initially ⚠️: `/health`/`/api/status` bypass the wake middleware. Resolved in `661fcbf` as intended design: the plan/doc wording was corrected to "work-carrying inbound request" (AC-62e.7), the rationale and registration-order mechanism are documented at the wiring site and in the controller doc, and the split is test-pinned. Capture/recall/hooks/mcp/dashboard all wake (mounted after the middleware at `assembleSeams()`, line 2326) |
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
| REG-3 | Daemon shutdown clean | ✅ | `src/daemon/runtime/assemble.ts:2954-2957` (post-remediation line numbers) | `hibernation?.stop()` runs first (cancels the debounce timer only, never touches handles) before the workers' own `stop()` calls, so a wake can never race teardown; `npm run ci`'s full suite (which repeatedly calls `.start()`/`.shutdown()` on real daemons) completes without hanging on both audit passes |
| ALIGN-1 | AGENTS.md + CONVENTIONS.md compliance | ✅ | — | No no-touch-file violations (server.ts/index.ts/config.ts/logger.ts/permission.ts/services/types.ts all untouched, re-verified after remediation); SQL-safety audit clean; license header closed by `bf9c348` |
| ALIGN-2 | License headers | ✅ | `src/daemon/runtime/services/deeplake-hibernation.ts:1-9` | Initially ⚠️ (missing). Resolved in `bf9c348`: the exact `docs/license-header.txt` comment block now opens the file |
| ALIGN-3 | No no-touch-file edits | ✅ | `git diff origin/main...HEAD --name-status` | Only `assemble.ts` (M) and new files touched; none of the six no-touch files appear |
| ALIGN-4 | Commit authorship/credit correctness | ✅ | commits `12a1152`,`65696e1`,`cffa4f0`,`1e6efad` | Chris Lyle preserved as Author on the cherry-picks; Co-authored-by trailer on the docs commit; Mario Aldayuz correctly the sole author of the two new integration/docs commits |

## Files Changed

- `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md` (M), added the PRD-062e row, status "Consolidated"
- `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md` (A), the consolidated design doc, carried over from `chrisl10/feat/idle-poll-hibernation` and rewritten; Co-authored-by Chris Lyle
- `src/daemon/runtime/assemble.ts` (M), wires `DeepLakeHibernation` at the composition root: the `touch()` root middleware, arm helpers for health-probe/graph-build/pollinating-maintenance-tick, the pausable set construction, and start/stop across the daemon lifecycle
- `src/daemon/runtime/services/deeplake-hibernation.ts` (A), the `DeepLakeHibernation` controller, cherry-picked from PR 198 (Chris Lyle); was missing the AGPL header at the initial audit (Warning, since resolved by `bf9c348`)
- `tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` (A), new PRD-223 integration test wiring the real controller to the real maintenance tick (AC-H.8)
- `tests/daemon/runtime/services/deeplake-hibernation.test.ts` (A), the controller's manual-clock unit suite, cherry-picked from PR 198 (Chris Lyle)

Added by the remediation commits (`bf9c348`, `00647e8`, `661fcbf`):

- `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062e-deeplake-compute-cost-reduction-idle-hibernation.md` (M), non-waking liveness split documented; "any inbound request" corrected to "work-carrying"; AC-62e.6 extended, AC-62e.7 and AC-62e.8 added
- `src/daemon/runtime/assemble.ts` (M), the logger adapter on the controller construction; the registration-order guard comment at the touch-middleware wiring site
- `src/daemon/runtime/services/deeplake-hibernation.ts` (M), the AGPL header; the INTENDED DESIGN module-doc section on the non-waking liveness split
- `tests/daemon/runtime/assemble-hibernation.test.ts` (A), composition-root pins: default-env arming + non-waking `/health` vs waking capture (AC-62e.7), real-env rollback (AC-62e.6), assembly-level event-log assertions (AC-62e.8)
- `tests/daemon/runtime/services/deeplake-hibernation-logging.test.ts` (A), the unit-level logging contract (AC-H.9): transition events and per-handle error events

## Verification commands run

Initial audit (HEAD `1e6efad`):

- `npm run ci` → exit 0 (365/365 test files, 4006 passed / 12 skipped; jscpd clean; SQL-safety audit clean over 288 files)
- `npx vitest run tests/daemon/runtime/services/deeplake-hibernation.test.ts tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts` → 2/2 files, 10/10 tests passed
- `npx vitest run tests/daemon/runtime/pollinating/maintenance-tick.test.ts` → 1/1 file, 2/2 tests passed (PR 223 regression, unmodified by this branch)
- Byte-diff of `fd5d40b`/`ca72684` (chrisl10/feat/deeplake-connection-hibernation) against `12a1152`/`65696e1` (this branch) → identical new-file content, identical hibernation-specific hunks
- `grep`/`git show` against `origin/main` and `chrisl10/feat/idle-poll-hibernation` for `buildWorkerPollLoop`, `wake-bus.ts`, `retryWakes`, `PollLoop.wake(` → confirmed the "no port needed" and "moot majors" claims
- Minimal Hono 4.12.25 repro confirming a wildcard `app.use` registered after a terminal route never fires for that route → basis for the `/health`/`/api/status` Warning

Re-audit verification (after remediation commits `bf9c348`, `00647e8`, `661fcbf`):

- `npx vitest run tests/daemon/runtime/assemble-hibernation.test.ts tests/daemon/runtime/services/deeplake-hibernation-logging.test.ts` → 2/2 files, 5/5 tests passed
- `npm run ci` → exit 0 (367/367 test files, 4011 passed / 12 skipped; jscpd clean; SQL-safety audit clean over 288 files); the +2 files / +5 tests vs the initial run are exactly the two new remediation suites, and zero pre-existing tests changed outcome
- `npx vitest run tests/daemon/runtime/services/deeplake-hibernation.test.ts tests/daemon/runtime/services/deeplake-hibernation-maintenance-tick.test.ts tests/daemon/runtime/assemble.test.ts` → 3/3 files, 49/49 tests passed (original hibernation suites + the composition-root suite unaffected by the remediation)
- Header verified byte-for-byte against `docs/license-header.txt`; logger adapter verified at `assemble.ts:2940`; `git diff origin/main...HEAD -- src/daemon/runtime/server.ts` still empty (no-touch file respected by the remediation)
- Remediation commits scanned for "Deep Lake" two-word spelling in newly authored prose → none found

## Overall verdict

**PASS at the no-medium+ bar** (re-audit 2026-07-03, HEAD `661fcbf`). Zero Criticals, zero Warnings outstanding. All four initial Warnings are resolved: the wake-bypass finding was closed as documented-and-pinned intended design in `661fcbf` (the doc contradiction, not the behavior, was the defect; the non-waking liveness split is the cost-correct choice and is now guarded against accidental reorder by comment and test), the license header landed in `bf9c348`, the logger wire-up plus its emission contract landed in `00647e8`, and the composition-root rollback proof landed in `661fcbf`. The remediation introduced no regressions (`npm run ci` exit 0; all pre-existing suites unchanged). One non-blocking Suggestion (AGPL headers across `tests/`) remains open for a repo-wide follow-up. The branch is shippable at this bar.

Initial verdict (2026-07-03, HEAD `1e6efad`, retained for the record): FAIL at the no-medium+ bar, zero Criticals and four Warnings as detailed above.
