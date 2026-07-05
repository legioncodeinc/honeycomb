# QA Report: dashboard-perf field-bug wave (honeycomb + hive)

**Plan document:** no formal PRD; the source plan is the user's reported dashboard symptoms plus the three explorer root-cause traces in `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md` (the 2026-07-05 05:45 and 06:16 entries)
**Audit date:** 2026-07-05
**Base branch:** `main` (both repos)
**Head:** uncommitted working tree on `main` (honeycomb + hive)
**Auditor:** quality-worker-bee

Ordering pre-flight: `security-worker-bee` ran first for this wave (`honeycomb/library/qa/security/2026-07-05-security-audit-dashboard-perf-wave.md`). One Medium (reserved-id collision guard bypass) was fixed in that session; one Medium (tenancy-blind keyed UPDATE in `src/daemon/storage/writes.ts:305-321`) was documented and accepted by the orchestrator with the user informed. Ordering is correct; this audit ran against the post-security tree.

## Summary

PASS with one Warning, remediated in place. All nine plan items trace to code and to named tests in the final tree: honeycomb's projects write path + merge/heal sync, Semaphore(5) storage cap, TTL-cached + parallelized `scope/projects` read, credential preserve-merge, per-request harness re-probe with honeycomb-only markers, and best-effort setup-on-install; hive's tenancy-grounded scope reconciliation with honest placeholder options, 20s bounded switch chain with Retry, and health-page freshness labeling. The single Warning (the security session's widened reserved-id guard shipped with no regression tests for the case/name variants it exists to refuse) was closed by adding 2 tests; both gates were independently re-run green afterwards (honeycomb `npm run ci` 4297 passed, hive typecheck 0 + 555/555). Recommend shipping; three Suggestions are documented for a later pass.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 9 plan items implemented; every sub-requirement traced (table below). |
| Correctness   | ✅ | Behavior proven by named tests; both repo gates green on the final tree. |
| Alignment     | ✅ | Fixes match the ledger's root-cause traces (P1/P2/P3, T1/T2/T3, H1, S1, HL1) point for point. |
| Gaps          | ⚠️ | One test gap on the security remediation (W-1, remediated); shared-file harness markers noted (S-2). |
| Detrimental   | ✅ | No permit leaks, no unbounded fetches left on the switch chain, no SQL-guard bypass (`audit:sql` green), no scope-key forgery (NUL-joined keys). |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [x] **REMEDIATED: security remediation shipped without variant regression tests**, `honeycomb/tests/daemon/runtime/projects/registry-write.test.ts:85-90` (pre-fix) and `honeycomb/tests/daemon/runtime/projects/onboarding-api.test.ts:156-167` (pre-fix)

  The security session widened the reserved-inbox guard from exact `__unsorted__` matching to the catalog's `isReservedProjectId` (trim + case-insensitive, over both the id and the display name `Unsorted`) at `registry-write.ts:97` and `onboarding-api.ts:461`, but the only tests exercising the guard used the exact lowercase id. Nothing proved `__UNSORTED__`, ` __Unsorted__ `, or a `name: "Unsorted"` are refused, so a regression back to exact matching would pass the suite while re-opening the Medium the security pass closed. Remediated in place: `reg-AC-3b` added to `registry-write.test.ts` (4 variant refusals, zero SQL issued) and a route-level variant test added to `onboarding-api.test.ts` (4 variants each rejected with a clean 400 on `POST /projects/bind`). Both pass; the full `npm run ci` re-run is green with them included.

  ```ts
  // The only pre-existing guard coverage (exact match), registry-write.test.ts:87
  expect((await upsertProjectRow(storage, SCOPE, { projectId: "__unsorted__", ... })).ok).toBe(false);
  ```

## Suggestions (consider improving)

- [ ] **Cache-hit shaping can serve a different scope's local project list**, `honeycomb/src/daemon/runtime/projects/scope-enumeration-api.ts:288-299`

  The counts memo is correctly keyed per `(org, workspace)` (NUL-joined, `projectsCacheKey` at `:366`), but on a HIT the response body still shapes from the single global `projects.json`, which was last synced by whichever scope ran most recently. Two scopes interleaved inside the 10s TTL can serve one scope's project list under the other's counts envelope. Already documented as a Low in the security report (same coordinates) with a concrete fix (filter `loadProjectsCache(...)` on `cache.org`/`cache.workspace`); recording here so the follow-up is tracked from the quality side too. Local-mode, single local user, so Suggestion severity stands.

- [ ] **Shared-file harness markers are not honeycomb-exclusive**, `honeycomb/src/daemon/runtime/dashboard/harness-detect.ts:66-81`

  The wave's requirement (dead hivemind-v1 paths alone never read installed) is met and test-proven. But three retained markers are shared config surfaces rather than honeycomb-namespaced artifacts: `~/.claude/settings.json` exists for any Claude Code user (the honeycomb claude-code connector wires via the `claude plugin` CLI, not settings.json hooks), and `~/.codex/hooks.json` / `~/.cursor/hooks.json` can be written by non-honeycomb hooks. A harness can therefore read `installed: true` without honeycomb wiring. A content-level check (a honeycomb-identifying key inside the file) or preferring the plugin-root dirs would make `installed` mean "honeycomb wired" rather than "a config file exists". Pre-existing marker choice for claude-code/cursor; noted, not a regression of this wave.

- [ ] **Post-switch reconcile has no dedicated named test**, `hive/src/dashboard/web/scope-context.tsx:339-350`

  The reconcile-after-a-switch-completes effect (keyed on `switchFeedback.kind === "persisted" && !pending`) is exercised indirectly: the switch-freeze test's final assertion (the select stays on `OSPRY` after the retried switch persists, while the mocked tenancy read still answers `LegionCode`) proves the effect ran and correctly did NOT override a valid enumerated org. A small named test asserting the effect corrects a genuinely stale post-switch value would pin the behavior explicitly.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| 1a | `registry-write.ts` upserts on bind, incl. the `isReservedProjectId` guard | ✅ | `honeycomb/src/daemon/runtime/projects/registry-write.ts:87-127` (guard `:97`); wired from bind at `onboarding-api.ts:343` + `:391-406`; `writeBind` guard `onboarding-api.ts:461-463`; production wiring `assemble.ts:2582-2589` (storage + shared cache passed) | Tests: `registry-write.test.ts` reg-AC-1..5 + new reg-AC-3b; route variant test in `onboarding-api.test.ts` |
| 1b | `registry-sync.ts` MERGES local-only projects instead of clobbering and heals them into the registry | ✅ | `honeycomb/src/daemon/runtime/projects/registry-sync.ts:143-165` (same-tenancy filter `:150-154`, heal loop `:155-163`, merged write `:165-173`) | Test reg-AC-6 (merged, not clobbered; heal upsert attempted) |
| 1c | A registry-write flap leaves the project visible locally; heals on next sync | ✅ | `registry-write.ts:122-126` (fail-soft result); `onboarding-api.ts:340-346` (local bind authoritative, `registrySynced` advisory) | Test reg-AC-7 (flap → still visible; next sync heals), reg-AC-4 (never throws) |
| 2 | Semaphore(5) bounds storage concurrency; 6th waits; permits release on error; retries work under the cap | ✅ | `honeycomb/src/daemon/storage/semaphore.ts:38-111` (`run` releases in `finally` `:103-110`); `client.ts:151` (`MAX_CONCURRENT_QUERIES = 5`), `:380/:402` (one per client, daemon-wide), `:502-503` (permit per attempt, backoff outside the permit) | Tests sem-AC-1 (6th waits, 5 at transport), sem-AC-2 (10 erroring queries all settle), sem-AC-3 (retry succeeds under cap). `bounded-pool.ts` re-exports the single-sourced class (jscpd clean) |
| 3 | `GET /api/diagnostics/scope/projects`: TTL cache + bind/unbind invalidation + PARALLEL cold path; measured pathology gone | ✅ | `projects-view-cache.ts:54-86` (10s TTL, keyed, `invalidate()`); `scope-enumeration-api.ts:288-297` (`Promise.all` of sync + counts on a MISS); invalidation at `onboarding-api.ts:345/:364/:380`; ONE shared instance `assemble.ts:2563` | Tests cache-AC-1..4: second read makes ZERO storage round-trips; bind invalidates and the fresh project appears; the 2-sequential-uncached pathology is structurally gone (parallel cold, memoized warm) |
| 4a | Same-org rewrite preserves `tenancyConfirmedAt`/`tenancyPending`/`userName`/`apiUrl` verbatim | ✅ | `honeycomb/src/daemon/runtime/auth/credentials-store.ts:310-328` (`preserveDiskMarkers`), `:504-510` (merge in `saveCredentials`; prior `apiUrl` preserved) | Tests W2-AC-1 (confirm + userName verbatim; pending verbatim with no confirm invented; self-hosted apiUrl preserved) |
| 4b | Org-changing rewrite drops confirm + sets pending | ✅ | `credentials-store.ts:325-328` (org-change branch) | Test W2-AC-2 |
| 4c | `healOrgDrift` can never flip unconfirmed → confirmed | ✅ | Same-org branch carries `tenancyPending` verbatim and `internalToDisk` can mint no marker; org-change branch drops confirm + sets pending | Test W2-AC-3 (real `healOrgDrift` through a fake issuer); pending-preserved case in W2-AC-1 |
| 4d | Switcher `...disk` paths regression-tested | ✅ | `saveDiskCredentials` writes verbatim (explicit-control path) | Test W2-AC-4 (`...disk` spread workspace switch keeps the confirm marker) |
| 5a | Per-request re-probe: a marker created after mount reflects on the next read | ✅ | `harness-api.ts:189-203` (`resolveInstalled()` per request); `assemble.ts:2437-2444` (live resolver, production branch `() => detectInstalledHarnesses()`), `:1327-1330` (seam carries both snapshot + resolver) | Test W2-FIX-2 in `harness-api.test.ts` (marker touched after mount → next read installed:true, no restart) |
| 5b | Legacy hivemind-v1 paths alone never read installed | ✅ | `harness-detect.ts:77-102` (markers repointed off `~/.codex/hivemind`, `~/.hermes/config.yaml`, `~/.pi/agent/*`, `~/.openclaw/extensions/hivemind`) | Tests: dedicated dead-leftover suite (hermes/codex/pi/openclaw all read false) + live-endpoint hermes leftover test |
| 5c | New marker table is honeycomb-only | ✅ | `harness-detect.ts:60-102`: connector `configPath()`/`pluginRoot` for claude-code/codex/cursor; honeycomb-namespaced dirs (`~/.hermes/honeycomb`, `~/.pi/honeycomb`, `~/.openclaw/honeycomb`) for the connector-less three | Met as specified; the shared-config-file nuance is S-2 |
| 6 | Setup-on-install: best-effort in BOTH modes; failure never fails install | ✅ | `honeycomb/src/commands/install.ts:462-478` (`runInstallSetupStep`, fail-soft), `:541` (runs unconditionally after the login step, both modes); `dispatch.ts:153-169` forwards the seam; production binds `buildConnectorRunner()` in `src/cli/runtime.ts:664` | Tests W2-FIX-3 x4: runs `setup` and prints wiring; runs in FLEET mode too; a throwing connector → exit 0 + one actionable line, no stack; absent seam → silent no-op |
| 7a | `reconcileScope`: stale/missing persisted org corrects to the REAL tenancy, never to whatever sorts first | ✅ | `hive/src/dashboard/web/scope-context.tsx:249-253` (corrects only to `active`), `:225-231` (`activeTenancyFromRead` never fabricates), mount reconcile `:310-332` | Pure tests (corrects stale → active; empty → active; stale + no active → left as-is) + mounted test (persisted `local` + credential `LegionCode` renders LegionCode, not OSPRY; correction persisted) |
| 7b | A valid different org is NOT overridden | ✅ | `scope-context.tsx:250-251` (an enumerated org is trusted, returned unchanged) | Pure test + mounted test (persisted OSPRY kept while active says LegionCode) |
| 7c | Selects never render a value absent from options (unresolved placeholder) | ✅ | `scope-context.tsx:557-596` (`orgUnresolved`/`workspaceUnresolved` disabled placeholder options) | Mounted test: stale-id + unreachable tenancy → select shows `stale-id` placeholder, never OSPRY |
| 7d | Reconcile re-runs after a switch completes | ✅ | `scope-context.tsx:339-350` (effect keyed on persisted, non-pending feedback) | Exercised indirectly by the switch tests (see S-3 for a dedicated-test suggestion) |
| 8a | 20s AbortController on all six scope/tenancy calls | ✅ | `hive/src/dashboard/web/wire.ts:1589` (`SCOPE_REQUEST_TIMEOUT_MS = 20_000`), `:1615-1664` (`getScopeJson`/`postScopeJson`); `scopeOrgs`/`scopeWorkspaces`/`scopeProjects`/`switchOrg`/`switchWorkspace` routed through them; `setupTenancy` bounded inline | `scope-bounded-fetch.test.ts`: all six settle to honest fallbacks at the bound; a slow-but-live 5s call is NOT cut short |
| 8b | A hung call clears pending, re-enables all selects, shows honest error + Retry re-issuing the exact action | ✅ | `scope-context.tsx:363-399` (org switch: error feedback + `retrySwitch`, `finally` clears loading), `:406-428` (workspace switch), `:434` (`switching` gate on all three selects), slot Retry `:645-663` | Mounted tests: failed org switch disables all three selects while pending, then re-enables, shows error + Retry, Retry re-issues the exact org; same for workspace; failed switch never mutates the active scope |
| 9 | Health page: "as of X ago via doctor" per tile + reconnecting-may-be-stale labeling; data source unchanged | ✅ | `hive/src/dashboard/web/pages/health.tsx:62-79` (`formatTelemetryFreshness`, pure), `:81-101` (`TelemetryFreshness`, `data-reconnecting`), per-tile mount `:171-176`; still reads `useFleetTelemetry`'s doctor-relayed snapshot, no new probe | Tests: per-tile "via doctor" annotation; a relay blip flips the reconnecting flag without blanking the tile; 4 pure formatter cases |

## Files Changed

honeycomb (17 modified, 9 added; nothing committed):

- `library/qa/security/2026-07-05-security-audit-dashboard-perf-wave.md` (A), the security wave's audit record (prior step's output, not audited here).
- `src/commands/dispatch.ts` (M), forwards the optional `connector` seam into the install verb deps.
- `src/commands/install.ts` (M), `runInstallSetupStep`: best-effort harness-hook wiring at the end of install, both modes, fail-soft.
- `src/daemon/runtime/assemble.ts` (M), live `resolveInstalledHarnesses` resolver (replaces the boot-time snapshot); one shared `ProjectsViewCache`; passes storage + cache into `mountOnboardingApi`; import reorders.
- `src/daemon/runtime/auth/credentials-store.ts` (M), `readPriorDiskRecord` + `preserveDiskMarkers`: same-org preserve verbatim / org-change drop-confirm-set-pending merge in `saveCredentials`.
- `src/daemon/runtime/dashboard/harness-api.ts` (M), `resolveInstalled` per-request seam (static set kept for back-compat).
- `src/daemon/runtime/dashboard/harness-detect.ts` (M), markers repointed off dead hivemind-v1 paths; honeycomb-namespaced dirs for hermes/pi/openclaw.
- `src/daemon/runtime/memories/bounded-pool.ts` (M), `Semaphore` extracted to `storage/semaphore.ts` and re-exported (no consumer change).
- `src/daemon/runtime/projects/index.ts` (M), exports the new write path + view cache.
- `src/daemon/runtime/projects/onboarding-api.ts` (M), bind upserts into the registry (best-effort, `registrySynced` ack) + invalidates the shared view cache; `isReservedProjectId` bind guard (security remediation).
- `src/daemon/runtime/projects/projects-view-cache.ts` (A), keyed TTL memo with explicit invalidation (10s).
- `src/daemon/runtime/projects/registry-sync.ts` (M), merges local-only projects instead of clobbering; best-effort heal via `upsertProjectRow`.
- `src/daemon/runtime/projects/registry-write.ts` (A), the Deeplake `projects` registry write path (update-or-insert by `project_id`, guarded values, fail-soft).
- `src/daemon/runtime/projects/scope-enumeration-api.ts` (M), `scope/projects` memoized behind the shared cache; cold path runs sync + counts in parallel.
- `src/daemon/storage/client.ts` (M), `Semaphore(5)` in-flight cap; permit per attempt, released on settle, backoff outside the permit.
- `src/daemon/storage/semaphore.ts` (A), the single-sourced counting semaphore.
- `tests/commands/install.test.ts` (M), W2-FIX-3 setup-on-install suite (4 tests).
- `tests/daemon/runtime/auth/credentials-preserve-tenancy.test.ts` (A), W2-AC-1..4 preserve-merge suite.
- `tests/daemon/runtime/dashboard/harness-api.test.ts` (M), live re-probe suite (marker-after-mount; hermes leftover on the live endpoint).
- `tests/daemon/runtime/dashboard/harness-detect.test.ts` (M), honeycomb-marker updates + dead-leftover refusal suite.
- `tests/daemon/runtime/dashboard/harness-installed-wiring.test.ts` (M), production-wiring fixtures moved onto the current markers.
- `tests/daemon/runtime/projects/projects-view-cache.test.ts` (A), cache-AC-1/2 + key independence.
- `tests/daemon/runtime/projects/registry-sync.test.ts` (M), reg-AC-6/7 merge + heal-on-next-sync suite.
- `tests/daemon/runtime/projects/registry-write.test.ts` (A), reg-AC-1..5; **QA remediation: reg-AC-3b variant refusals added**.
- `tests/daemon/runtime/projects/scope-projects-cache.test.ts` (A), cache-AC-3/4 end-to-end TTL + invalidation-on-bind.
- `tests/daemon/storage/client-concurrency.test.ts` (A), sem-AC-1..3 concurrency-cap suite.
- `tests/daemon/runtime/projects/onboarding-api.test.ts` (M), **QA remediation: route-level reserved-variant rejection test added**.

hive (5 modified, 2 added; nothing committed):

- `src/dashboard/web/pages/health.tsx` (M), per-tile freshness annotation ("as of X ago via doctor") + reconnecting labeling; data source unchanged.
- `src/dashboard/web/scope-context.tsx` (M), `reconcileScope`/`activeTenancyFromRead` + mount/post-switch reconciliation; `switching` gate; `retrySwitch`; unresolved placeholder options.
- `src/dashboard/web/wire.ts` (M), `SCOPE_REQUEST_TIMEOUT_MS` (20s) bounded `getScopeJson`/`postScopeJson` over all six scope/tenancy calls.
- `tests/dashboard/active-tenancy-display.test.tsx` (M), switcher-value fixture extended with the new `switching`/`retrySwitch` fields.
- `tests/dashboard/health-page.test.tsx` (M), freshness + reconnecting suites; pure formatter cases.
- `tests/dashboard/scope-context.test.tsx` (A), reconciliation (pure + mounted) and switch-freeze/Retry suites.
- `tests/wire/scope-bounded-fetch.test.ts` (A), the six bounded calls settle at the bound; slow-but-live calls are not cut short.

Untracked local artifact: `honeycomb/.daemon/secrets-audit.ndjson` is gitignored (verified with `git check-ignore`) and cannot ship in a commit.

## Remediations applied by this audit (in place, not committed)

1. `honeycomb/tests/daemon/runtime/projects/registry-write.test.ts`: added `reg-AC-3b` proving `__UNSORTED__`, ` __Unsorted__ `, and `name: "Unsorted"`/`"unsorted"` are refused with zero SQL issued (pins the security remediation's widened guard).
2. `honeycomb/tests/daemon/runtime/projects/onboarding-api.test.ts`: added a route-level test proving `POST /projects/bind` rejects the four reserved-id/name variants with a clean 400.

No production code was changed by this audit.

## Gate Output

honeycomb, `npm run ci` (independent re-run on the final tree, after the QA remediation):

```text
typecheck: clean (tsc --noEmit, exit 0)
jscpd duplication: pass
vitest: 407 files passed (407) | 4297 tests passed | 12 skipped
audit:sql: 299 files scanned under src/daemon, src/daemon-client/ - OK
exit code: 0
```

One environmental note: the FIRST full-CI run of this audit failed a single test (`tests/daemon/runtime/sources/url-fetcher.test.ts`, redirect re-validation) with `connect ENOBUFS 127.0.0.1:65533`, a Windows ephemeral socket-buffer exhaustion under the fully parallel run. That suite is untouched by this wave, passed 58/58 in isolation immediately afterwards, and passed in the full re-run above. It is NOT one of the pre-authorized flaky suites, so it is reported here explicitly: classified environmental (resource exhaustion, not a product regression), arbitrated by the green full re-run.

hive, `npm run typecheck && npm test`:

```text
typecheck: clean (tsc --noEmit, exit 0)
vitest: 68 files passed (68) | 555 tests passed (555)
exit code: 0
```

The four pre-authorized machine-local flaky dashboard tenancy suites and `tests/daemon/installer/funnel-telemetry.test.ts` all PASSED on this run; no flake exclusion was needed.

## Carried-forward security posture (not re-litigated)

- The documented-accepted Medium (tenancy-blind keyed UPDATE in `updateOrInsertByKey`, `src/daemon/storage/writes.ts:305-321`, first tenant-scope table written through it) remains accepted by the orchestrator with the user informed; the transport's per-scope partitioning is the current isolation guarantee. The security report's recommended follow-up (an optional tenancy-conjunct arg for tenant-scope tables) stands.
- The security report's four Lows remain documented-only; the first (stale-tenancy shape on a cache hit) is cross-referenced as Suggestion S-1 above.
