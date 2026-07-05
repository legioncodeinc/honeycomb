# QA Report: Onboarding Field-Bug Fix Wave 2 (tenancy re-selection, probe tolerance, client/telemetry/service resilience)

**Plan document:** none (field-bug fix wave; "source plan" is the user's reported live symptoms)
**Audit date:** 2026-07-05
**Base branch:** `main` (uncommitted working tree, both repos)
**Head:** uncommitted changes on `main`
**Repos:** `honeycomb` (fixes 1-2), `hive` (fixes 3-6)
**Auditor:** quality-worker-bee
**Ordering:** correct. `security-worker-bee` ran CLEAN first (`honeycomb/library/qa/security/2026-07-05-security-audit-tenancy-reselection.md`); this QA runs after it.

## Summary

PASS. All six field fixes are implemented as described, each with focused tests that assert the specific symptom-to-resolution behavior, and every gate is green: honeycomb `npm run ci` passes clean (402 files, 4263 tests, plus typecheck, jscpd, and the SQL-safety audit), and hive `npm run typecheck` + `npm test` pass with the ONLY failures being the two pre-authorized known-flake assertions in `tests/daemon/installer/funnel-telemetry.test.ts` (both omit the legitimate `login_completed` event; that file is untouched by this wave and the failures are unrelated to any of the six fixes). No Critical, Warning, or fix-invalidating findings were found, so no remediation was required. One low-value Suggestion is recorded.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All six symptoms addressed; each has dedicated tests. |
| Correctness   | ✅ | Behavior verified against each reported symptom; edge cases (reject off-list workspace, recover-on-first-success, benign vs real schtasks failure, empty-but-reachable poll) covered. |
| Alignment     | ✅ | Fail-soft discipline, D-4 token-in-header, `isFleetReady` semantics, and repo conventions all respected. |
| Gaps          | ✅ | Error/timeout/empty/degraded paths all handled; tests present for each. |
| Detrimental   | ✅ | No regressions; `default` workspace not special-cased; `isFleetReady()` unchanged; no perf/security smells. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

- [ ] **Persisted-credential enumeration failure returns HTTP 200 with `selected:false`**, `honeycomb/src/daemon/runtime/dashboard/setup-tenancy.ts:512-515`

  When `resolveSelectionSource` throws (e.g. the persisted-token org-list call errors), the handler fails soft with a `200 { selected:false, error: redactedReason(err) }`. This is intentional and the hive client handles it correctly (renders the error with a working Retry), so it is not a defect. A future refinement could return a 5xx for a genuine upstream enumeration failure to distinguish it from a validation `400`, but the current shape is consistent with the fail-soft contract and does not leak the token (D-4 honored). No action required.

  ```ts
  } catch (err: unknown) {
      return c.json({ selected: false, error: redactedReason(err) }, 200);
  }
  ```

## Plan Item Traceability

| # | Symptom / Required Fix | Status | Implementation Location | Notes |
|---|------------------------|--------|--------------------------|-------|
| 1 | Tenancy RE-SELECTION works after the single-use pending window is consumed (fixes "Selection could not be saved. Retry." + stuck-on-a-workspace) | ✅ | `honeycomb/src/daemon/runtime/dashboard/setup-tenancy.ts:290-346` (`resolveSelectionSource`), `:505-547` (select path) | Enumerates + re-mints from persisted credential when no window. |
| 1a | Second select to a DIFFERENT workspace succeeds and rewrites creds | ✅ | `setup-tenancy.ts:518-547` | Test: `tests/daemon/runtime/dashboard/setup-tenancy.test.ts:321-378`. |
| 1b | Workspace not in enumerated list is rejected (nothing rewritten) | ✅ | `setup-tenancy.ts:522-527` | Test: `setup-tenancy.test.ts:380-407`. |
| 1c | GET orgs/workspaces read from persisted creds with no window | ✅ | `setup-tenancy.ts:481`, `:587` (`reMint` from disk token) | Tests: `setup-tenancy.test.ts:409-457`. |
| 1d | "no pending link" only when neither window nor credential exists | ✅ | `setup-tenancy.ts:515-517` (`source === null`) | Returns 400 only when both absent. |
| 2 | Storage probe tolerance: timeout >=12s, 2 consecutive failures before degraded, recover on first success | ✅ | `honeycomb/src/daemon/runtime/health.ts:50-100` (`createHealthBitTracker`, constants), `assemble.ts:2237-2245`, `:2618-2626` | Tests: `health.test.ts:411-447`, `assemble.test.ts:625-646`. |
| 2a | One slow/failed probe stays ok | ✅ | `health.ts:84-93`; `assemble.ts:2618` | Tests: `health.test.ts:417-421`, `assemble.test.ts:625-645`. |
| 2b | Two consecutive go degraded; success clears | ✅ | `health.ts:84-95` | Tests: `health.test.ts:423-437`. |
| 2c | `default` treated as normal valid workspace, no special-casing added | ✅ | No workspace special-casing in `health.ts`/`assemble.ts`; pre-existing `DEFAULT_WORKSPACE` server-resolve path unchanged | Confirmed: fix 2 touches only the probe tracker, not workspace logic. |
| 3 | Tenancy client resilience: every call bounded (15s) + fail-soft with distinguishable failure marker | ✅ | `hive/src/dashboard/web/onboarding/tenancy-client.ts:47-171` | `AbortController` + `markRequestFailed`/`isTenancyRequestFailure`. Tests: `prd-011-tenancy.test.ts:181-243`. |
| 3a | tenancy-step renders honest retryable states (no infinite spinner); Retry re-issues; Back to organizations | ✅ | `hive/src/dashboard/web/onboarding/tenancy-step.tsx:23-27,99-101,124-165,183-227,287-306,459-478` | Tests: `tenancy-step.test.tsx:249-369`. |
| 4 | Fleet telemetry fail-soft: retains last-known service views + `reconnecting` flag on transient/empty/unreachable poll | ✅ | `hive/src/dashboard/web/use-fleet-telemetry.ts:95-99,124-129,193-216,256-265,332-337` | Tests: `use-fleet-telemetry.test.ts:177-227`, `use-fleet-telemetry-hook.test.tsx`. |
| 5 | `hive install-service` tolerates benign `schtasks /Run` already-running after successful `/Create`; real `/Create` failure still fails | ✅ | `hive/src/service/index.ts:169-186,250-268,358-362` | Tests: `service-module.test.ts:116-175`. |
| 6 | Doctor surfaced as `kind:"supervisor"` WITHOUT becoming a required peer (`isFleetReady()` unchanged) | ✅ | `hive/src/daemon/fleet-status.ts:47-64,92-96`, `src/shared/fleet-readiness.ts:3-11` | `isFleetReady` still gates on `V1_REQUIRED_PEERS = ["honeycomb"]` only (`fleet-readiness.ts:37-43`). Tests: `fleet-status.test.ts:70-119,228-237`. |
| NG | Regression sweep: known flakes not counted as failures | ✅ | `tests/daemon/installer/funnel-telemetry.test.ts` (untouched by wave) | 2 pre-authorized `login_completed` flake assertions; all other suites pass. |

## Gate Output

### honeycomb `npm run ci` (typecheck + dup + vitest + audit:sql) — PASS

```
 Test Files  402 passed (402)
      Tests  4263 passed | 12 skipped (4275)
   Duration  28.67s

> @legioncodeinc/honeycomb@0.5.4 audit:sql
> node scripts/audit-sql-safety.mjs
SQL-safety audit: scanned 296 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
```
(Process exit code 0; typecheck and jscpd stages preceded the vitest output and passed.)

### hive `npm run typecheck` — PASS

```
> @legioncodeinc/hive@0.6.3 typecheck
> tsc --noEmit
```
(Exit code 0, no diagnostics.)

### hive `npm test` — PASS (only pre-authorized known flakes fail)

```
 ❯ tests/daemon/installer/funnel-telemetry.test.ts (21 tests | 2 failed) 2504ms
     × emits UI-originated milestones through the event route
     × ts-AC-13 accepts tenancy_shown, tenancy_selected, and workspace_created (202, not 400) and emits them

 Test Files  1 failed | 65 passed (66)
      Tests  2 failed | 529 passed (531)
   Duration  4.75s
```
Both failures are the pre-authorized, machine-local, CI-green flakes: the expected arrays omit the legitimate `login_completed` event that the runtime emits (`+ "login_completed"` in both diffs). `funnel-telemetry.test.ts` is NOT in this wave's diff, and the failing assertions are unrelated to any of the six fixes. The four dashboard tenancy suites all passed in this run. Per the wave instructions, these are treated as environmental and do NOT fail the wave.

## Files Changed

### honeycomb
- `src/daemon/runtime/assemble.ts` (M), wires the tolerant `createHealthBitTracker` (2-consecutive-failure debounce) and `DEFAULT_HEALTH_PROBE_TIMEOUT_MS` into the storage probe; adds `healthDegradeAfter` option.
- `src/daemon/runtime/dashboard/setup-tenancy.ts` (M), adds `resolveSelectionSource` so select/GET enumerate + re-mint from the persisted credential when no pending window exists (fix 1), fail-soft on enumeration error.
- `src/daemon/runtime/health.ts` (M), adds `createHealthBitTracker`, `HEALTH_DEGRADE_CONSECUTIVE_FAILURES` (2), and `DEFAULT_HEALTH_PROBE_TIMEOUT_MS` (12s) (fix 2).
- `tests/daemon/runtime/assemble.test.ts` (M), single-failed-boot-probe-stays-ok test; pins `healthDegradeAfter:1` for the 503-wiring test.
- `tests/daemon/runtime/dashboard/setup-tenancy.test.ts` (M), FIX 1 re-selection suite (second select, off-list rejection, GET orgs/workspaces from persisted token).
- `tests/daemon/runtime/fleet-health-recovery.test.ts` (M), pins `healthDegradeAfter:1` so the recovery test degrades deterministically.
- `tests/daemon/runtime/health.test.ts` (M), `createHealthBitTracker` unit suite (streak, recover-on-first-success, default constants).
- `library/qa/security/2026-07-05-security-audit-tenancy-reselection.md` (A, prior step), security audit (ran clean before this QA).

### hive
- `src/daemon/fleet-status.ts` (M), `withDoctorSupervisorEntry` surfaces doctor as `kind:"supervisor"` (upsert, no duplicate row) (fix 6).
- `src/dashboard/web/onboarding/tenancy-client.ts` (M), 15s `AbortController` bound on every call + `markRequestFailed`/`isTenancyRequestFailure` (fix 3).
- `src/dashboard/web/onboarding/tenancy-step.tsx` (M), honest retryable error states, Retry re-issues the failed request, "Back to organizations" affordance (fix 3).
- `src/dashboard/web/use-fleet-telemetry.ts` (M), retains last-known views + `reconnecting` flag on transient/empty/unreachable poll; skips non-2xx polls (fix 4).
- `src/service/index.ts` (M), `isBenignInstallFailure` treats a `schtasks /Run` already-running after a successful `/Create` as non-fatal; real `/Create` failure still fails (fix 5).
- `src/shared/fleet-readiness.ts` (M), adds `FleetServiceKind` and optional `kind` field; `isFleetReady` logic unchanged (fix 6).
- `tests/daemon/fleet-status.test.ts` (M), doctor supervisor surfacing (append + upsert, no dup).
- `tests/dashboard/prd-011-tenancy.test.ts` (M), tenancy client robustness (bounded timeout, marked fail-soft).
- `tests/dashboard/tenancy-step.test.tsx` (M), bounded loading + retry (org-load, workspace-load, Back, select/create Retry re-issue).
- `tests/dashboard/use-fleet-telemetry-hook.test.tsx` (M), hook-level resilience (empty-but-reachable poll never blanks grid; non-2xx skipped).
- `tests/dashboard/use-fleet-telemetry.test.ts` (M), reducer-level resilience + doctor supervisor row.
- `tests/service/service-module.test.ts` (M), benign vs real schtasks failure tests.
