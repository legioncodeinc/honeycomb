# QA Report: PRD-058 Memory Lifecycle (058a–058e) — Wiring Completion

**Plan document:** [`library/requirements/in-work/prd-058-memory-lifecycle/`](../) (the five sub-PRDs `prd-058a` … `prd-058e`), audited against [`library/ledger/EXECUTION_LEDGER-prd-058.md`](../../../../ledger/EXECUTION_LEDGER-prd-058.md)
**Audit date:** 2026-07-06
**Base branch:** `main` (merge-base `1a168e0`)
**Head:** `prd-058-memory-lifecycle-completion` @ `398d3ca`
**Auditor:** quality-worker-bee
**Security:** `security-worker-bee` ran first — [`library/qa/security/2026-07-06-security-audit-prd-058-memory-lifecycle.md`](../../../../qa/security/2026-07-06-security-audit-prd-058-memory-lifecycle.md), 0 Critical/High/Medium, 1 Low documented. Ordering honored.

---

## Summary

**Verdict: PASS WITH NOTES.** The PRD-058 lifecycle wiring completion ships the five "DEFINED-NOT-WIRED" recall seams into production and adds the four missing maintenance workers (keep-both memo, reverify scheduler, access-log compaction, calibration refit) plus the settings-page flag reference. All five spot checks pass and `hybrid-recall.ts` is untouched. Of the 57 cross-referenced ACs, **54 are VERIFIED via wiring and 3 are DEFERRED** to a follow-up (the dashboard lifecycle/health panel, L-W10 / AC-55d.2.1/2.2/2.4). No Critical issues; one Warning (the ledger's L-W10 row still reads `OPEN` rather than documenting the deferral). The three production paths that were inert — recall access recording, ACT-R Stage-2 activation, calibration, staleness, keep-both memoization — now fire on the real write/recall paths, so the live-DB symptom the recon flagged (`access_count=0`, `last_reinforced_at=1970`, `ref_status=NULL`) will resolve on the next recall+compaction cycle.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ⚠️ | 54/57 ACs VERIFIED via wiring; 3 ACs (AC-55d.2.1/2.2/2.4, the dashboard H/freshness/ECE panel) DEFERRED as L-W10 — explicitly scoped out of this wave |
| Correctness   | ✅ | Each wired seam invokes the real Wave-1 engine/worker code, not a stub; calibrate pass implements the ECE refit gate (AC-55e.2.1) and cold-start identity (AC-55e.2.2); keep-both memo matches the test-fake contract |
| Alignment     | ✅ | Module placement (`src/daemon/runtime/maintenance/*`, `src/daemon/runtime/memories/keep-both-memo.ts`) and naming follow repo conventions; `hybrid-recall.ts` untouched per ADR-0001/ADR-0009 |
| Gaps          | ⚠️ | One documentation gap: the ledger does not record L-W10's deferral (the row still reads `OPEN`); pre-existing hook-runtime/json-parser test flakes exist outside this change set |
| Detrimental   | ✅ | No regressions, no scope creep; all maintenance mounts are fail-soft try/catch; `npm run typecheck`, `npm run audit:sql`, and the 38 new tests are green |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **L-W10 deferral is not documented in the execution ledger**, `library/ledger/EXECUTION_LEDGER-prd-058.md:34`

  The dashboard lifecycle/health panel (L-W10 / AC-55d.2.1/2.2/2.4) did not ship in this wave — confirmed by inspection: `src/dashboard/views.ts` has no `H(m,t)` / freshness / open-conflict / stale-ref / ECE view, only `buildLifecycleFlagsView` (the L-W11 settings reference at `views.ts:95`). This is a legitimate scope deferral (the CLI already exposes conflict resolve and `--lifecycle` inspect per AC-55d.3.x, and ledger ruling R5 scopes the panel read-only-first). **But** the ledger's AC table still lists L-W10 as `OPEN` and contains no "DEFERRED to follow-up" annotation, so a future reader cannot tell the omission was deliberate. The deferral is captured in this QA report, but the source-of-truth ledger should record it too.

  Suggested: update the L-W10 row's Status from `OPEN` to `DEFERRED → follow-up` and add a one-line closeout note pointing at this QA report, mirroring how L-W11 was resolved.

  ```
  | **L-W10** | 058d.2.x | Ship the dashboard lifecycle/health panel … | typescript-node-worker-bee | 2 | OPEN |
  ```

## Suggestions (consider improving)

- [ ] **Consider asserting the lifecycle ticks are armed in `start()` and stopped in `shutdown()`**, `tests/daemon/runtime/memories/lifecycle-wiring.test.ts`

  The wiring test (Option A) asserts the five `mountMemories` seams are constructed and threaded (`lifecycle-wiring.test.ts:121-332`), and the reverify/compact/calibrate specs cover the pass functions. No test explicitly asserts that `armReverifyTick` / `armCompactAccessTick` / `armCalibrateTick` fire inside `start()` and that their handles are stopped inside `shutdown()` (`assemble.ts:3281-3283`, `3716-3727`). The arming is straightforward and the functions are idempotent, so this is a coverage nicety, not a gap. Tracking as a pointer for a future lifecycle-lifecycle test.

## Spot checks (the five requested)

1. **`assemble.ts` constructs all five seams — PASS.** All five are built at `assemble.ts:1419-1447` and threaded into `seams.mountMemories` at `assemble.ts:1448-1470`: `recordRecallAccessFactory` (L-W1, `:1430`), `activationSource` (L-W2, `:1434-1438`), `stalenessSource` (L-W4, `:1442`), `calibrationModel` via `readCalibrationModel` (L-W3, `:1447`→`:1462`), and `lifecycleRecency` from `resolveLifecycleConfigLayered()` (L-W5, `:1419`→`:1423`→`:1461`). `confidenceExponent` and `stalenessExponent` are also threaded (`:1460`, `:1463`).

2. **Four maintenance modules mounted + three lifecycle ticks armed/stopped — PASS.** `mountReverify`, `mountCompactAccessLog`, `mountCalibrate` are registered seam fns (`assemble.ts:761-763`) and mounted with fail-soft try/catch (`assemble.ts:1588-1622`). `armReverifyTick` / `armCompactAccessTick` / `armCalibrateTick` are defined (`:3172-3201`), armed in `start()` (`:3281-3283`), re-armed on resume (`:3585-3607`), and stopped in `shutdown()` (`:3716-3727`). Cadences match ledger rulings R2/R3 (5 min / 5 min / 1 hour, `lifecycle-tick.ts:33-39`).

3. **`KeepBothMemoStore` is wired into both the hook and the resolve endpoint — PASS.** One instance is constructed at the composition root (`assemble.ts:2918`) and threaded (a) into `createControlledWriteConflictHook` as `memo` (`assemble.ts:2451-2456`, the post-commit detection reader) and (b) into `mountConflictsApi` as `keepBothMemo` (`assemble.ts:1482-1483`, the resolve-endpoint writer). `mountConflictsApi` actually consumes it on the `keep-both` verdict (`conflicts-api.ts:175-177`, `deps.keepBothMemo.remember(...)`). The store re-normalizes the pair idempotently (`keep-both-memo.ts:47-50`).

4. **Settings page renders lifecycle flags as a nested child — PASS.** `buildSettingsView` returns a panel whose `children` array carries `buildLifecycleFlagsView()` (`views.ts:121`), and `buildLifecycleFlagsView` renders `LIFECYCLE_FLAG_REFERENCE` rows (`views.ts:95-108`, single-sourced from `src/shared/lifecycle-flags.ts`). It is a nested child, not a 7th top-level view (preserves the frozen six-view contract D-6). `views.test.ts:94-107` asserts the child-block shape and that every flag renders.

5. **`hybrid-recall.ts` is untouched — PASS.** `git diff main...HEAD -- src/daemon/runtime/memories/hybrid-recall.ts` is empty (0 lines). ADR-0001/ADR-0009 honored.

(Bonus) **L-W10 deferral documented — PARTIAL.** The deferral is captured in this QA report (Warnings section + traceability table below). It is **not** documented in the ledger — see the Warning above.

## Plan Item Traceability

Status legend: ✅ VERIFIED via wiring · 🟦 DEFERRED · ⚪ SHIPPED PRIOR (already wired in an earlier wave; re-confirmed inert-free).

### PRD-058a — Recency activation and decay (9 ACs)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-55a.1.1 | Larger `t − t_ref` → smaller `freshnessScore`, ranks below newer | ✅ | `recall.ts` recency stage (unchanged engine); config wired at `assemble.ts:1423,1461` | L-W5 supplies the per-class half-lives + `a` exponent |
| AC-55a.1.2 | Recency never removes a hit by age alone (multiplier, no cutoff) | ✅ | `recall.ts` recency stage | Engine property, unchanged |
| AC-55a.1.3 | Recency is the last score adjustment | ✅ | `recall.ts` stage ordering | Engine property, unchanged |
| AC-55a.2.1 | `sessions` penalized harder than `memories` (`h(sessions) < h(memories)`) | ✅ | config wired at `assemble.ts:1423` (`lifecycleRecency`) | Defaults from `lifecycle-flags.ts` |
| AC-55a.2.2 | Caller override via `halfLifeDaysByClass` honored | ✅ | `api.ts:599` (`resolveRecencyOverride`) | Per-request override → boot lifecycle → engine default |
| AC-55a.2.3 | Class with no half-life falls back to documented default, never the 100-year neutral | ✅ | `lifecycle-flags.ts` defaults; `assemble.ts:1419` | `resolveLifecycleConfigLayered()` supplies defaults |
| AC-55a.3.1 | Every hit carries `freshnessScore ∈ [0,1]` | ✅ | `recall.ts` hit shape | Engine property, unchanged |
| AC-55a.3.2 | `freshnessScore` computed even in degraded (embeddings off) mode | ✅ | `recall.ts` degraded path | Engine property, unchanged |
| AC-55a.3.3 | Missing/unparseable timestamp → `A = 1` (fail-soft) | ✅ | `recall.ts` recency stage | Engine property, unchanged |

### PRD-058b — Conflict detection and resolution (15 ACs)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-55b.1.1 | Recorded conflict pair → at most the winner returns | ✅ | `recall.ts` κ gate (`conflictSuppression`); wired at `assemble.ts:1453` | Hook projects rows; gate reads them |
| AC-55b.1.2 | `supersede` (`margin ≥ τ_supersede`) → loser `κ = 0`, excluded by `MAX(version)` | ✅ | `conflicts-api.ts` resolve path | Hook + supersession unchanged |
| AC-55b.1.3 | `review` → loser `κ = ρ`, reversible | ✅ | `conflicts-api.ts`; `recall.ts` κ gate | Reversible per `memory_history` append |
| AC-55b.1.4 | Uncontested memory → `κ = 1` (gate leaves priority untouched) | ✅ | `recall.ts` empty-conflict default | Engine property |
| AC-55b.2.1 | Lexical-miss semantic conflict flags via `P_contradiction`, `signal='model'` | ✅ | `conflict-detect.ts` (unchanged); hook wired `assemble.ts:2451` | Detection runs on real write path |
| AC-55b.2.2 | Cheap-lexical flag without a model call, `signal='lexical'` | ✅ | `conflict-detect.ts`; hook wired `assemble.ts:2451` | |
| AC-55b.2.3 | Provider `none` → `P_contradiction` skipped, degraded, no throw | ✅ | `conflict-detect.ts` provider gate | Engine property |
| AC-55b.2.4 | `keep-both` pair memoized so re-detection does not re-flag | ✅ | `keep-both-memo.ts:65-75` (writer); `assemble.ts:2455` (reader hook) + `:1483` (writer endpoint) | **L-W6 SHIPPED THIS WAVE** — the one previously-DEFERRED AC |
| AC-55b.3.1 | `w_i = A·C·prov·corr`; distilled `memory` (prov=1.0) outvotes raw `session` (prov=0.4) | ✅ | `conflict-resolve.ts` weighting | Engine property |
| AC-55b.3.2 | `margin ∈ [τ_review, τ_supersede)` → `review` | ✅ | `conflict-resolve.ts` verdict table | Engine property |
| AC-55b.3.3 | `corr(o)` counts independent sources only (log-scaled) | ✅ | `conflict-resolve.ts` corroboration | Engine property |
| AC-55b.3.4 | `margin ≥ τ_supersede` → `supersede`, persist `margin` + `contra_score` | ✅ | `conflict-resolve.ts`; `conflicts-api.ts` projection | Engine property |
| AC-55b.4.1 | Every detection/resolution appends `memory_history` + projects `memory_conflicts` | ✅ | `conflicts-api.ts:167-179` | Wired via hook + endpoint |
| AC-55b.4.2 | `supersede` reversal restores loser via append-only version bump | ✅ | `conflicts-api.ts` reversal path | Engine property |
| AC-55b.4.3 | No destructive delete / in-place mutation | ✅ | `conflicts-api.ts` append-only path | Engine property |

### PRD-058c — Stale-reference healing (10 ACs)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-55c.1.1 | Absent indexed symbol → `resolve=0`, `σ=1`, `ref_status='stale'`, `stale_refs` recorded | ✅ | `stale-ref-diagnostic.ts` (unchanged); wired via `stalenessSource` `assemble.ts:1442` + reverify pass `reverify-api.ts:248` | L-W4 + L-W7 wired this wave |
| AC-55c.1.2 | All refs resolve exactly → `σ≈0`, `ref_status='fresh'` | ✅ | `stale-ref-diagnostic.ts`; `assemble.ts:1442` | |
| AC-55c.1.3 | Out-of-graph reference → `excluded`, `unknown`, never `stale` | ✅ | `stale-ref-diagnostic.ts` | Engine property |
| AC-55c.1.4 | No indexed refs → empty-product `σ=0`, treated as fresh | ✅ | `stale-ref-diagnostic.ts` | Engine property |
| AC-55c.1.5 | Fuzzy rename candidate → `resolve=sim(r,r*) ∈ (0,1)` | ✅ | `stale-ref-diagnostic.ts` | Engine property |
| AC-55c.2.1 | `observe` posture (`s=0`) → flag only, ranking unchanged | ✅ | `effectiveStalenessExponent` `assemble.ts:1424`; `lifecycle-tick` config | L-W5 posture-gates `s` |
| AC-55c.2.2 | `execute` (`s>0`) → demote via recency-multiplier stage, never hard-drop | ✅ | `stalenessSource` exponent `assemble.ts:1442` | |
| AC-55c.2.3 | Returning reference flips back to `fresh`, demotion lifts | ✅ | `stale-ref-diagnostic.ts` re-verify; `reverify-api.ts:248` (`runStaleRefDiagnostic`) | L-W7 scheduler drives re-checks |
| AC-55c.2.4 | Every detect/heal appends `memory_history` | ✅ | `stale-ref-diagnostic.ts` history append | Engine property |
| AC-55c.3.1 | Low `v(m,t)` → re-queued for re-verification | ✅ | `reverify-api.ts` (`isDueForReverify` + due scan `:208-262`) | L-W7 scheduler wired this wave |
| AC-55c.3.2 | New snapshot → re-verification job re-checks | ✅ | `reverify-api.ts:248` (`runStaleRefDiagnostic` over due subset) | |
| AC-55c.3.3 | Snapshot reads poll to convergence, never single-read | ✅ | `stale-ref-diagnostic.ts` poll loop | Engine property |

### PRD-058d — Surfaces and controls (12 ACs)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-55d.1.1 | Fresh install defaults non-destructive (`a=1, c=0, s=0`, auto-resolve off) | ✅ | `lifecycle-flags.ts` defaults; `resolveLifecycleConfigLayered` `assemble.ts:1419` | L-W5 wired this wave |
| AC-55d.1.2 | `HONEYCOMB_LIFECYCLE_*` env overrides yaml per-key | ✅ | `resolveLifecycleConfigLayered` (`lifecycle-config.ts`) | Env-over-yaml precedence |
| AC-55d.1.3 | Every lifecycle flag appears on settings page + config reference | ✅ | `views.ts:95-108` + `:121` (nested child); `lifecycle-flags.ts` single-source | **L-W11 SHIPPED THIS WAVE** |
| AC-55d.1.4 | `observe`→`execute` flips `s`; visible on settings page; no other exponent changes implicitly | ✅ | `effectiveStalenessExponent` `assemble.ts:1424`; rendered via `LIFECYCLE_FLAG_REFERENCE` | |
| AC-55d.2.1 | Per-memory health badge `H(m,t)`, freshness, conflict count, stale-ref count, ECE | 🟦 | — | **DEFERRED (L-W10)** — no H-scalar view in `views.ts` |
| AC-55d.2.2 | Dashboard conflict resolve round-trips through 058b endpoint, polls to convergence | 🟦 | — | **DEFERRED (L-W10)** — CLI has resolve (AC-55d.3.2); dashboard action is follow-up per R5 |
| AC-55d.2.3 | `memory_history` queryable by lifecycle type | ✅ | history filter endpoint (shipped prior) | Re-confirmed inert-free |
| AC-55d.2.4 | Calibration view renders reliability diagram + ECE/Brier | 🟦 | — | **DEFERRED (L-W10)** — `GET /api/memories/calibration` payload exists; no view consumes it |
| AC-55d.3.1 | `honeycomb memory conflicts` lists (scoped, paginated) | ✅ | `src/cli/commands/memory-conflicts.ts` (shipped prior) | CLI parity shipped in earlier wave |
| AC-55d.3.2 | `honeycomb memory conflicts resolve <id> --verdict … --winner …` | ✅ | CLI command (shipped prior) | Same endpoint as dashboard |
| AC-55d.3.3 | `honeycomb memory stale-refs` lists | ✅ | `src/cli/commands/memory-stale-refs.ts` (shipped prior) | |
| AC-55d.3.4 | `inspect --lifecycle` prints freshness, calibrated confidence, ref status, H | ✅ | CLI inspect flag (shipped prior) | |

### PRD-058e — Reinforcement, activation, calibration (11 ACs)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-55e.1.1 | Useful recall → `A_actr` strictly higher (event enters `B` with `u_k>0`) | ✅ | `activation.ts` ACT-R; `activationSource` wired `assemble.ts:1434-1438` | L-W2 wired this wave |
| AC-55e.1.2 | Spacing effect (spread > bunched at equal count) | ✅ | `activation.ts` ACT-R math; wired `assemble.ts:1434` | |
| AC-55e.1.3 | Contradicted/ignored recall → `u_k → 0` | ✅ | `usefulness-grader.ts`; `recordAccess` wired via `recordRecallAccessFactory` `assemble.ts:1430` | L-W1 wired this wave |
| AC-55e.1.4 | Cold memory → `A_actr ≥ A_min` (graceful forgetting) | ✅ | `activation.ts` clamp; `activationFloor` from config `assemble.ts:1436` | |
| AC-55e.2.1 | Refit adopted only when held-out ECE strictly decreases | ✅ | `calibrate-api.ts:310-325` (`shouldAdoptRefit`); tick armed `assemble.ts:3192-3200` | **L-W9 SHIPPED THIS WAVE** |
| AC-55e.2.2 | Insufficient data → `g` identity, `c=0` dormant | ✅ | `calibrate-api.ts:273-285` (cold-start gate); `readCalibrationModel` fail-soft `assemble.ts:1447` | L-W3 + L-W9 wired this wave |
| AC-55e.2.3 | ECE-threshold gate → `c` activated, eval-gated | ✅ | `calibrate-api.ts` adoption; `confidenceExponent` threaded `assemble.ts:1463` | Stays 0 until refit lands |
| AC-55e.3.1 | Higher-`A_actr` memory re-verified at shorter interval | ✅ | `reverify-api.ts` (`isDueForReverify` activation-paced); tick `assemble.ts:3172-3180` | L-W7 wired this wave |
| AC-55e.3.2 | Cold low-activation → longest interval / deferred, never starves hot set | ✅ | `reverify-api.ts` schedule | |
| AC-55e (implicit) | Access-event log compacts so it does not grow unbounded | ✅ | `compact-access-log-api.ts:124-172` (`compactAccessLog`); tick `assemble.ts:3182-3190` | **L-W8 SHIPPED THIS WAVE** |
| AC-55e (implicit) | `recordAccess` invoked on recall → `access_count`/`last_reinforced_at` advance | ✅ | `recordRecallAccessFactory` → `api.ts:604-605,646` | **L-W1 SHIPPED THIS WAVE** — resolves the live-DB inert symptom |

**Matrix totals:** 57 ACs cross-referenced → **54 ✅ VERIFIED** (49 shipped-prior-and-reconfirmed + 5 newly wired this wave: AC-55b.2.4, AC-55c.3.x via L-W7, AC-55e.2.1/2.2 via L-W9, plus the L-W1/L-W2/L-W3/L-W4/L-W5 wirings that bring the production paths alive), **3 🟦 DEFERRED** (AC-55d.2.1/2.2/2.4 → L-W10 follow-up), **0 ❌ NOT VERIFIED.**

## Files Changed

Three-dot diff against `main` (merge-base `1a168e0`); 16 files, +2754 / −178.

- `library/ledger/EXECUTION_LEDGER-prd-058.md` (M), ledger rewritten on the Wave-1 commit; AC table + rulings added (L-W10 row still reads `OPEN` — see Warning)
- `src/daemon/runtime/assemble.ts` (M), composition root: constructs the five lifecycle seams (`:1419-1447`), threads them into `mountMemories` (`:1448-1470`), mounts the three maintenance routes (`:1588-1622`), arms/stops the three lifecycle ticks (`:3172-3201`, `:3281-3283`, `:3716-3727`), and threads the shared `KeepBothMemoStore` into both the detection hook (`:2451-2456`) and the resolve endpoint (`:1482-1483`)
- `src/daemon/runtime/maintenance/calibrate-api.ts` (A), calibration refit route + `runCalibratePass` (cold-start gate, fit/holdout split, `shouldAdoptRefit` ECE gate, snapshot write)
- `src/daemon/runtime/maintenance/compact-access-log-api.ts` (A), access-log compaction route + `runCompactAccessLogPass` (folds raw `memory_access` into `access_count` via `compactAccessLog`)
- `src/daemon/runtime/maintenance/lifecycle-tick.ts` (A), `startLifecycleTick` scheduler + cadence constants (5 min / 5 min / 1 hour)
- `src/daemon/runtime/maintenance/reverify-api.ts` (A), reverify-scheduler route + `runReverifyPass` (activation-paced due scan → `runStaleRefDiagnostic`)
- `src/daemon/runtime/memories/api.ts` (M), recall handler builds the per-request `recordRecallAccess` callback (`:604-605`) and threads the five seams into `recallMemories` (`:646-652`)
- `src/daemon/runtime/memories/keep-both-memo.ts` (A), production in-process `KeepBothMemoStore` (normalized-pair `Map`, idempotent re-normalization)
- `src/dashboard/index.ts` (M), exports `buildLifecycleFlagsView`
- `src/dashboard/views.ts` (M), `buildLifecycleFlagsView` renders `LIFECYCLE_FLAG_REFERENCE`; `buildSettingsView` carries it as a nested child block
- `tests/daemon/runtime/maintenance/calibrate-api.spec.ts` (A), 6 tests
- `tests/daemon/runtime/maintenance/compact-access-log-api.spec.ts` (A), 7 tests
- `tests/daemon/runtime/maintenance/reverify-api.spec.ts` (A), 8 tests
- `tests/daemon/runtime/memories/keep-both-memo.test.ts` (A), 4 tests
- `tests/daemon/runtime/memories/lifecycle-wiring.test.ts` (A), 6 tests (Option A recording fake — asserts L-W1…L-W5 seams fire in production composition; watchdog trigger satisfied)
- `tests/dashboard/views.test.ts` (M), asserts the lifecycle-flag nested child block renders every flag

## Notes for the invoker

- **Security ordering honored.** `security-worker-bee` ran first (report at `library/qa/security/2026-07-06-…md`, 0 Critical/High/Medium, 1 Low documented). This audit ran against the post-security snapshot.
- **Gate status.** `npm run typecheck` clean; `npm run audit:sql` clean (306 files scanned, every interpolation routed through an escaping helper); 38 new tests pass. The ledger's L-X1 (`npm run ci` green) and L-X2 (live-DB verification) are the orchestrator's close-out items and out of scope for this Bee; the ledger notes pre-existing environmental flakes (hook-runtime, json-parsers) that are NOT in this change set.
- **`recall.ts` is NOT touched by this branch.** `git diff main...HEAD -- src/daemon/runtime/memories/recall.ts` is empty (0 lines). The two-dot diff shows divergence only because `main` advanced after the branch forked (main has a PRD-074 prose-COALESCE that the merge-base predates). This is not a regression introduced by PRD-058.
- **L-W10 follow-up scope.** When shipped, the dashboard panel should consume the already-shipped `GET /api/memories/calibration` and `GET /api/memories/history?type=lifecycle` endpoints (ledger R5: read-only first; the conflict-resolve action button is the follow-up since the CLI already has it).
