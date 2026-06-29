# QA Findings Report: HiveDoctor Auto-Update Fix (PRD-065)

- **Date:** 2026-06-28
- **Auditor:** quality-worker-bee
- **Branch:** main (uncommitted working-tree diff)
- **Scope:** the just-made HiveDoctor auto-update fix (two issues): (1) `update --check` must be a read-only dry-run preview; (2) post-update verify must not destructively roll back when the daemon was not healthy before / there is no supervised service, but must still roll back a healthy->regressed daemon.
- **Source intent:** the invoking brief + `prd-065-autoupdate-fix-security.md` (security-worker-bee, same day). There is no standalone PRD-064e/064f text in this folder; the acceptance criteria referenced (AC-064e.1/.2/.3/.5/.6) are cited from the code/test docstrings and the security report.
- **Ordering:** security-worker-bee ran first and produced `prd-065-autoupdate-fix-security.md` (No Critical/High). No prior `*-qa-report.md` existed for this branch. **Ordering intact.**

## Summary

**Verdict: SHIP-READY.** Both issues are fully and correctly implemented, and every sub-criterion is backed by a real, non-vacuous test that asserts what it claims. `previewUpdate()` is a genuine pure read path (no lock, no npm, no restart, no rollback), and `checkPrimaryUpdate` is routed to it (the old mutating `runUpdateTransaction` block is deleted from `cli/index.ts`). The FIX-2 rule matches the intent exactly: rollback iff (healthy-before AND supervised), else keep + `updated_unverified`; all four cases are individually tested with sequenced health mocks. The existing healthy->regressed rollback safety is preserved, and neither the apply path nor the poll loop was weakened. Gates run by the auditor: `tsc --noEmit` clean; `47 test files / 456 tests passed, 0 failed`.

## Scorecard

| Issue / Axis | Status | Basis |
| --- | --- | --- |
| **ISSUE 1** — `update --check` is a read-only dry-run | **VERIFIED** | `previewUpdate()` is mutation-free; `checkPrimaryUpdate` routed to it; old mutating block deleted |
| ISSUE 1a — `previewUpdate()` performs no mutation | VERIFIED | `update-engine.ts:259-276` + `update-engine.test.ts:288-393` (runner.calls empty, lock/restart/verify never called) |
| ISSUE 1b — `checkPrimaryUpdate` wired to preview, not transaction | VERIFIED | `update-actions.ts:30-38`; `update-actions.test.ts:36-56` (preview x1, transaction never) |
| ISSUE 1c — old mutating `--check` path removed | VERIFIED | `cli/index.ts` diff deletes the inline `runUpdateTransaction`-based `checkPrimaryUpdate` |
| ISSUE 1d — apply + poll loop still mutate | VERIFIED | `update-actions.ts:39-45`; `poll-loop.ts:101` still calls `runUpdateTransaction` |
| **ISSUE 2** — pre-baseline-aware verify/rollback | **VERIFIED** | rule at `update-engine.ts:347-365`; four cases each tested |
| ISSUE 2a — pre-update baseline probe exists | VERIFIED | `update-engine.ts:297` (`wasHealthyBefore = await deps.verifyHealthy()` before npm) |
| ISSUE 2b — pre-healthy + post-unhealthy + supervised -> ROLLBACK | VERIFIED | `update-engine.test.ts:298-314` + AC-064e.3 case at `:139-165` |
| ISSUE 2c — pre-unhealthy -> NO rollback, `updated_unverified` | VERIFIED | `update-engine.test.ts:316-339` |
| ISSUE 2d — no-service (restart=false) -> NO rollback | VERIFIED | `update-engine.test.ts:341-356` |
| ISSUE 2e — pre-healthy + post-healthy -> committed `updated` | VERIFIED | `update-engine.test.ts:358-370` |
| **Regressions** — existing safety preserved, no path weakened | **VERIFIED** | rollback_failed case updated correctly; poll loop + apply untouched |
| **Gates** — typecheck + test | **VERIFIED** | `tsc --noEmit` clean; 47 files / 456 tests, 0 failed |

## Per-Criterion Table

| Criterion | Status | Proving test / evidence (verified, not just named) |
| --- | --- | --- |
| `previewUpdate()` reads installed+latest+blessed via `gatherDecision()` and runs the same `decideUpdate()` gate | VERIFIED | `update-engine.ts:259-267` calls `gatherDecision()` (`:242-256`), which only reads + calls pure `decideUpdate`. No lock/npm/restart in body. |
| `previewUpdate()` never acquires the install lock | VERIFIED | `update-engine.test.ts:289-292` wraps the real lock in a spy; `:309` asserts `acquire` not called. Repeated across not-blessed (`:336`) and opted-out (`:368`) cases. |
| `previewUpdate()` never runs npm | VERIFIED | `:307` `expect(runner.calls).toHaveLength(0)` — asserted in all six preview cases. |
| `previewUpdate()` never restarts / verifies | VERIFIED | `:310-311` `restartDaemon` and `verifyHealthy` `not.toHaveBeenCalled()`. |
| `previewUpdate()` is crash-safe (throwing seam -> not-eligible, never throws) | VERIFIED | `update-engine.test.ts:378-389` throws in `readLatestVersion`, asserts `eligible:false`, `reason:"latest_unknown"`. Matches `update-engine.ts:268-275` catch. |
| `checkPrimaryUpdate` calls `previewUpdate` exactly once, `runUpdateTransaction` never | VERIFIED | `update-actions.test.ts:43-44` `toHaveBeenCalledTimes(1)` + `not.toHaveBeenCalled()` over a fake engine with spy methods. Not vacuous: distinct spies. |
| Old mutating `--check` removed from CLI | VERIFIED | `cli/index.ts` diff removes the inline `update:{checkPrimaryUpdate:...runUpdateTransaction()...}` block and replaces with `createUpdateActions(updateEngine, selfUpdate)`. |
| Pre-update baseline captured BEFORE npm | VERIFIED | `update-engine.ts:297` is positioned before lock acquire (`:300`) and install (`:314`). Happy-path test now asserts `verifyHealthy` called **twice** (`:97-98`), proving the extra baseline probe fires. |
| Rule: rollback iff `wasHealthyBefore && restartSupervised` | VERIFIED | `update-engine.ts:347` exact conjunction; else branch (`:352-365`) keeps install + `updated_unverified`. |
| pre-healthy + post-unhealthy + supervised -> rollback | VERIFIED | `update-engine.test.ts:298-314` healthSeq `[true,false,true]`, `restartDaemon`=`undefined` (void->supervised); asserts `rolled_back` + 2 npm installs (forward + prior). |
| pre-unhealthy -> no rollback, `updated_unverified`, install KEPT | VERIFIED | `:316-339` healthSeq `[false,false]`; asserts status `updated_unverified`, **only one** npm install (no rollback reinstall), and a single `updated_unverified` update event. |
| no supervised service (restart=false) -> no rollback | VERIFIED | `:341-356` healthSeq `[true,false]`, `restartDaemon`=`false`; asserts `updated_unverified` + only the forward install. |
| pre-healthy + post-healthy -> committed `updated` | VERIFIED | `:358-370` healthSeq `[true,true]`; asserts `updated` + single install. |
| `restartDaemon` boolean plumbed correctly | VERIFIED | `RestartDaemonFn` widened to `Promise<void \| boolean>` (`update-engine.ts:58`); `restartSupervised = restartReport !== false` (`:330`). `void`/`true` => supervised; only explicit `false` skips rollback. Conservative default (existing void callers keep old behavior). |
| compose forwards real restart success/failure | VERIFIED | `compose/index.ts:355` `restartDaemon: async ():Promise<boolean> => restart()`; `RestartFn = ()=>Promise<boolean>` (`remediation.ts:93`); default no-op returns `false` (`compose/index.ts:231-234`). Type-correct. |
| CLI restart seam reports false (no OS service) | VERIFIED | `cli/index.ts` diff: `restartDaemon: async ():Promise<boolean> => { logger.warn(...); return false; }`. Correct — the CLI cannot restart the OS service, so a still-unhealthy post-update health will NOT roll back. |
| Install path still SemVer-validates the target (no arbitrary npm spec) | VERIFIED | `installVersion()` rejects non-strict-SemVer via `parseVersion(version)===null` (`update-engine.ts:174-185`) before composing `name@version`; gate `toVersion` is `blessedVersion` (`update-policy.ts:109`), never raw `@latest`. |
| Existing rollback-failed safety preserved | VERIFIED | `update-engine.test.ts:168-176` updated to seq `[true,false,false]` (healthy baseline so rollback path is taken, then rollback reinstall fails) -> asserts `rollback_failed`. Correct adaptation, not a weakening. |
| Poll loop not weakened (still applies) | VERIFIED | `poll-loop.ts:101` calls `runUpdateTransaction()`; `previewUpdate` added to fakes only to satisfy the interface (`poll-loop.test.ts:23-26,142-144`). |
| Apply path not weakened | VERIFIED | `update-actions.ts:39-45` `applyPrimaryUpdate` -> `runUpdateTransaction`; `update-actions.test.ts:58-69` asserts transaction x1, preview never. |
| New `updated_unverified` telemetry outcome honestly mapped | VERIFIED | `update-telemetry.ts` adds the outcome; `outcomeOf` maps it (`update-engine.ts:153-154`); emitted at `:359`. `update-actions.test.ts:71-78` asserts the honest CLI line. |

## Findings by Severity

### Critical (must fix — blocks ship)
None.

### Warning (should fix)
None.

### Suggestion (consider improving)

- **S1 — `updated_unverified` is not asserted at the CLI-context / dispatch layer end-to-end.** `info`. The `updated_unverified` path is proven at the engine layer and at the `createUpdateActions` mapping layer (`update-actions.test.ts:71-78`), and security confirmed the telemetry chokepoint. There is no single test that drives a real `buildCliContext`/`createHiveDoctor` composition through a forced pre-unhealthy update to assert the wired daemon emits `updated_unverified` end-to-end. The unit coverage is strong enough that this is genuinely optional, but a composition-level test would close the last seam between "the engine does the right thing" and "the wired product does the right thing." No coordinates to fix; this is a coverage suggestion, not a defect.

- **S2 — Brief references AC-064e.* but no PRD-064e text is co-located.** `info`. The acceptance criteria (`AC-064e.1/.3/.5/.6`) are cited only from code docstrings and the security report; there is no `library/requirements/.../prd-064e*.md` in this folder to trace against as ground truth. Verification here was done against the stated two-issue intent (which the code matches exactly). If 064e is a real prior PRD, linking it under PRD-065's folder would make future audits trace cleanly. Defer to `library-worker-bee`.

## Gate Results (run by this auditor)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `cd hivedoctor && npm run typecheck` (`tsc --noEmit`) | **PASS** — clean, no output |
| Tests | `cd hivedoctor && npm run test` (`vitest run`) | **PASS** — **47 test files passed, 456 tests passed, 0 failed**, duration ~1.7s |

Relevant suites within the run:
- `tests/update/update-engine.test.ts` — 26 tests pass (includes the 6 `previewUpdate` dry-run cases + the 4 FIX-2 baseline cases + the updated AC-064e.3 rollback cases).
- `tests/cli/update-actions.test.ts` — 5 tests pass (the `--check`-routes-to-preview spy proof).
- `tests/update/poll-loop.test.ts` — 8 tests pass (poll loop still ticks `runUpdateTransaction`).
- `tests/compose/create-hivedoctor.test.ts` — 14 tests pass.

No failures, no flakiness, no skips observed. Counts match the security report's `47 files / 456 tests` exactly, confirming the audited tree is the same green tree.

## Files Changed (one-line summary per file)

| File | Change |
| --- | --- |
| `hivedoctor/src/cli/update-actions.ts` (NEW) | `createUpdateActions`: `checkPrimaryUpdate`->`previewUpdate` (read-only), `applyPrimaryUpdate`->`runUpdateTransaction`, `selfUpdate` passthrough. |
| `hivedoctor/src/update/update-engine.ts` | Adds `previewUpdate()` + shared `gatherDecision()` (read+decide, no mutation); pre-update `wasHealthyBefore` baseline; FIX-2 rollback-vs-keep rule; `updated_unverified` status; `RestartDaemonFn` widened to `Promise<void\|boolean>`. |
| `hivedoctor/src/update/update-telemetry.ts` | Adds `updated_unverified` to the `UpdateOutcome` union. |
| `hivedoctor/src/update/index.ts` | Re-exports `UpdatePreview` type. |
| `hivedoctor/src/cli/index.ts` | Deletes the old mutating inline `--check`; wires `createUpdateActions`; CLI `restartDaemon` now returns `false` (no OS service). |
| `hivedoctor/src/compose/index.ts` | `restartDaemon` forwards `restart()`'s boolean instead of swallowing it. |
| `hivedoctor/tests/cli/update-actions.test.ts` (NEW) | Proves `--check`->preview-only, `update`->transaction-only, `updated_unverified` reported honestly. |
| `hivedoctor/tests/update/update-engine.test.ts` | Adds the 6 pure-dry-run preview tests + 4 FIX-2 baseline tests; updates happy-path/rollback health-probe counts (+1 baseline probe). |
| `hivedoctor/tests/update/poll-loop.test.ts` | Adds `previewUpdate` to fake engines (interface only); loop still asserts `runUpdateTransaction`. |
| `hivedoctor/tests/compose/create-hivedoctor.test.ts` | Adds `previewUpdate` to the fake engine to satisfy the interface. |
| `library/requirements/backlog/prd-065-hivedoctor-go-live/qa/prd-065-autoupdate-fix-security.md` (NEW) | The preceding security audit (No Critical/High). |

## Verdict

**SHIP-READY.** Both issues are implemented exactly to the stated intent and every sub-criterion is covered by a real, assertion-bearing test (verified by reading the test bodies, not just their names). The skeptic checks held: the "touching NOTHING" preview test genuinely asserts `runner.calls` empty and lock/restart/verify never called via real spies; the four FIX-2 cases use distinct sequenced health mocks and assert distinct install counts; the rollback safety and poll/apply paths are demonstrably unweakened; the SemVer guard on the install target is intact. Typecheck and the full 456-test suite are green. The two Suggestions (S1 end-to-end composition test, S2 missing co-located PRD-064e text) are optional and do not block merge.
