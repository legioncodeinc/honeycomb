# Security Audit Report: dashboard-perf field-bug wave (uncommitted, branch `main`)

**Audit date:** 2026-07-05
**Auditor:** security-worker-bee subagent
**Scope:** Uncommitted honeycomb changes (`git diff` + untracked), three change families:
A) new Deeplake `projects` write path (`src/daemon/runtime/projects/registry-write.ts` wired from `onboarding-api.ts` and `registry-sync.ts`);
B) credential preserve-merge (`src/daemon/runtime/auth/credentials-store.ts` `saveCredentials`);
C) Semaphore(5) storage cap (`src/daemon/storage/client.ts`, `storage/semaphore.ts`, `runtime/memories/bounded-pool.ts`), per-request harness re-probe (`dashboard/harness-detect.ts`, `dashboard/harness-api.ts`), setup-on-install (`commands/install.ts`, `commands/dispatch.ts`), projects TTL view cache (`projects/projects-view-cache.ts`, `projects/scope-enumeration-api.ts`), plus `runtime/assemble.ts` wiring and the new test files.
**Node version audited:** >=22.5.0 (package.json engines)
**`npm audit` result:** clean (0 vulnerabilities at `--audit-level=high`)
**OpenClaw bundle scan:** clean (`npm run audit:openclaw`: "no findings")
**CVE watchlist last refreshed:** 2026-04-24 (72 days old; within the 120-day freshness window)

---

## Executive Summary

The wave is in good shape: zero Critical and zero High findings. The most important issue found and FIXED in-session is a Medium: the brand-new `projects` registry write path and the dashboard bind handler enforced the reserved-inbox collision guard by exact string match only, so a case-variant id (`__UNSORTED__`) or the reserved display name (`Unsorted`) from the user-controlled bind body could materialize a user project row shadowing the per-workspace capture inbox; both choke points now route through the catalog's canonical `isReservedProjectId` (trim + case-insensitive, id AND name). One further Medium is documented for human review (the tenancy-blind keyed UPDATE inside `updateOrInsertByKey` on the first tenant-scope table written through it), plus four Lows. No credential, token, or captured-trace PII exposure was found; the credential preserve-merge enforces exactly the stated same-org-preserve / org-change-drop rule. `npm run ci` is green after remediation (typecheck + jscpd + 4295 tests + SQL audit). Nothing was committed.

Ordering pre-flight: no QA report exists for this wave in `library/qa/` (the newest reports there are dated 2026-07-05 for other waves and none cover these files), so the security-before-quality ordering is correct.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | ATTN | 1 Medium (documented), 2 Low |
| Injection (Deeplake SQL API) | ATTN | 1 Medium (fixed in-session) |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (cred modes, capture opt-out, client hardening) | ATTN | 2 Low |
| Pre-Tool-Use Gate & Prompt Injection | OK | 0 (surface untouched by this wave) |

Legend: **OK** = zero findings. **ATTN** = Medium/Low findings documented. **FAIL** = Critical/High findings (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings (follow-up required)

- [x] **RESERVED-ID COLLISION GUARD BYPASS (049a-AC-6)** `src/daemon/runtime/projects/registry-write.ts:94` and `src/daemon/runtime/projects/onboarding-api.ts:459` (pre-fix line numbers). The new write path checked `projectId === UNSORTED_PROJECT_ID` (exact, case-sensitive) while the catalog's documented guard (`assertNotReservedProjectId` / `isReservedProjectId` in `src/daemon/storage/catalog/projects.ts:251-268`) is trim + case-insensitive and also reserves the display name `Unsorted`. The dashboard bind body (`name` field, user-controlled) could therefore create and durably upsert a project id `__UNSORTED__` or `Unsorted` that shadows the per-workspace capture inbox in every consumer that compares case-insensitively or renders by display name. Local-mode loopback surface only, no cross-tenant reach, hence Medium. FIXED in-session under the <5-line exception: `upsertProjectRow` now refuses `isReservedProjectId(projectId) || isReservedProjectId(project.name)`, and `writeBind` rejects `isReservedProjectId(projectId)` with a clean 400. Existing tests (`__unsorted__` exact) still pass.

- [ ] **TENANCY-BLIND KEYED UPDATE ON A TENANT-SCOPE TABLE** `src/daemon/storage/writes.ts:305-321` as used by `src/daemon/runtime/projects/registry-write.ts:114-118`. `NEEDS HUMAN REVIEW`. `updateOrInsertByKey` probes and UPDATEs by `WHERE project_id = <key>` with no `org_id`/`workspace_id` conjuncts, while every READ builder for the same table filters tenancy explicitly (`buildListProjectsSql`, `buildProjectByIdSql`, `buildEnsureUnsortedSelectSql` in `src/daemon/storage/catalog/projects.ts:279-323`) and the catalog documents that the same `project_id` string exists per `(org_id, workspace_id)`. `projects` is the FIRST `scope: "tenant"` table written through this primitive (goals/kpis/memories are `scope: "agent"`). Today the write cannot cross tenancy because the transport partitions every statement per scope (`src/daemon/storage/transport.ts:83-88`: workspace in the URL path + `X-Activeloop-Org-Id` header), and the row's `org_id`/`workspace_id` are stamped from the same scope the statement runs under. But the write's isolation rests wholly on the transport contract; if the backend ever serves a shared table across workspaces (which the explicit tenancy columns and the read-side WHERE conjuncts anticipate), the keyed UPDATE would clobber a same-id row belonging to another `(org, workspace)`. Recommended fix: teach `updateOrInsertByKey` an optional tenancy-conjunct arg (or add a scoped variant) and use it for tenant-scope tables; not applied in-session because it touches the shared write primitive used by five other tables (exceeds minimal blast radius for a defense-in-depth hardening).

---

## Low Findings (documentation only)

- [ ] **STALE-TENANCY SHAPE ON A CACHE HIT** `src/daemon/runtime/projects/scope-enumeration-api.ts:288-299`. The counts view cache is correctly keyed by NUL-joined `(org, workspace)` (`projectsCacheKey`, forge-proof), but the `projects.json` file the response shapes from is a single global file last written by whichever scope synced most recently. Interleaved requests for two scopes within the 10s TTL can serve one scope's project list under the other scope's response envelope. Local-mode loopback only (non-local requests 404), single local user switching orgs, so data confusion rather than a trust-boundary crossing. Recommended: filter `loadProjectsCache(...)` output on `cache.org === scope.org && cache.workspace === (scope.workspace ?? "")` before shaping.

- [ ] **EMPTY-TENANCY GRANDFATHERING IN THE SYNC MERGE** `src/daemon/runtime/projects/registry-sync.ts:144-145`. The same-tenancy predicate treats a prior cache with empty `org`/`workspace` as matching ANY tenancy, so a pre-tenancy cache's local-only projects are healed into the CURRENT org's registry. Deliberate (mirrors the resolver's `cacheForTenancy` read guard in `src/hooks/shared/project-resolver.ts:339-346`), single-user local cache, documented for awareness.

- [ ] **MALFORMED-PRIOR-FILE MERGE SKIP CAN DROP A PENDING MARKER** `src/daemon/runtime/auth/credentials-store.ts:279-289`. `readPriorDiskRecord` returns `null` on a malformed prior credentials file, so `saveCredentials` writes a fresh record with neither `tenancyConfirmedAt` nor `tenancyPending`; `resolveTenancyConfirmation` then reads it as grandfathered-confirmed even if the (unreadable) prior state was pending. Requires local corruption of a 0600 file the user already owns; consistent with the pre-existing b-AC-3 "malformed = nothing usable" posture and the grandfathering rule (AC-5).

- [ ] **FILE MODE APPLIES ONLY ON CREATE** `src/daemon/runtime/auth/credentials-store.ts:512-515`. Pre-existing and documented in-code: `writeFileSync`'s `mode: 0600` sets permissions only when the file is created; a pre-existing file keeps its modes (and win32 is a documented ACL-based no-op). Unchanged by this wave; listed to confirm the merge did not alter the mode discipline.

---

## Family-by-family verification detail

### A) New SQL write path (highest scrutiny)

- **Every interpolated value is guarded.** `upsertProjectRow` builds its row exclusively from `val.str` (→ `sLiteral`) and `val.text` (→ `eLiteral`) constructors (`registry-write.ts:101-112`); `updateOrInsertByKey` routes identifiers through `sqlIdent`, the key through `sLiteral`, and SET/INSERT values through `renderValue` (`writes.ts:305-321`). No hand-quoted value anywhere in the new files.
- **`audit:sql` stays green and demonstrably covers the new file.** Full gate: 299 files scanned under `src/daemon` + `src/daemon-client`, OK. Focused re-scan `node scripts/audit-sql-safety.mjs src/daemon/runtime/projects`: 9 files scanned (includes `registry-write.ts`, `onboarding-api.ts`, `registry-sync.ts`, `projects-view-cache.ts`), OK. The walker excludes only `node_modules`/`dist`/`bundle`, `.d.ts`, `.test.ts`, and `sql.ts` itself, so the new production files are in scope by construction.
- **User-controlled ids/names/paths cannot inject.** The bind body is zod-validated (`BindBodySchema`, path + optional name only); the project id/name reach SQL only through `sLiteral`/`eLiteral`; `bound_paths` is JSON-serialized then written through `val.text` (`E'...'`), which correctly escapes Windows backslashes and embedded quotes. Confirmed the `E'...'` path is the one that handles escape-bearing bodies (`sql.ts` `eLiteral`).
- **Org/workspace scoping.** The row's `org_id`/`workspace_id` are stamped from the daemon's resolved tenancy (`assemble.ts:2582-2589` passes `scope.org`/`scope.workspace` into `mountOnboardingApi`; the bind body cannot supply them), and the statement runs under the same `QueryScope`, which the transport enforces via the workspace URL path + `X-Activeloop-Org-Id` header. The read path's header-based scope override (`resolveProjectsScope`) refuses a header org that disagrees with a validated token identity and takes the workspace from the identity, never the header. Residual defense-in-depth gap documented as the Medium above.
- **Upsert discipline.** The `projects` catalog declares `pattern: "update-or-insert"` keyed by `project_id` (`catalog/projects.ts:210-218`) and the writer uses the registry's own `updateOrInsertByKey` primitive with `healTargetFor(PROJECTS_TABLE)` (heal-aware, no hand-rolled DDL), matching the goals/kpis precedent. Verified by the new suite (`registry-write.test.ts`: INSERT-when-absent, UPDATE-when-present, missing-table heal).
- **Fail-soft error paths leak no secrets.** A non-ok storage result becomes `{ ok: false, reason }` where `reason` is the result `kind` plus the backend `query_error` message (`registry-write.ts:119-122`, `registry-sync.ts:128-131`); the storage client never puts the token into a message (`client.ts` FR-8, transport error text is status + a 200-char body slice), and the bind ack carries paths/ids/booleans only. No token, org header, or credential field crosses any response body or log line in the new code.
- **`bind-existing` does not upsert** (registry row stays authoritative; an empty remote cannot clobber it), and `unbind` touches only the local cache. Both verified in source and tests.

### B) Credential preserve-merge

- **The stated rule is enforced exactly** (`preserveDiskMarkers`, `credentials-store.ts:310-328`): same-org rewrite carries `tenancyConfirmedAt`/`tenancyPending` verbatim; an org-CHANGING rewrite drops the confirm marker and sets `tenancyPending: true`. The `next` record built from in-memory `Credentials` can never carry markers of its own (`internalToDisk` sets none), so a stale confirm cannot ride in through the base either.
- **No resurrection across an org change.** Traced `healOrgDrift` (`device-flow.ts:208-240`): aligned → no save; drift → `saveCredentials` with the NEW org → org-changing branch → confirm dropped, pending set. A same-org heal preserves a `tenancyPending: true` verbatim, so `healOrgDrift` cannot flip an unconfirmed (pending) credential to confirmed: `resolveTenancyConfirmation` keeps returning `confirmed: false` while the pending flag survives and no marker exists. Explicit tenancy decisions bypass the merge entirely via `saveDiskCredentials` (full control), as documented.
- **File modes intact:** dir created `0700`, file written `0600`, unchanged by the diff (the create-only caveat is the pre-existing Low above). **No token exposure:** `readPriorDiskRecord` parses and returns the record without logging; the merge never stringifies the token anywhere except into the 0600 file itself. The new test suite (`credentials-preserve-tenancy.test.ts`) covers preserve-verbatim, pending-preserve, and org-change-drop.

### C) Lower-scrutiny surfaces

- **Semaphore(5):** `Semaphore.run` acquires, runs, and releases in `finally` (`semaphore.ts:103-110`), so a rejecting query attempt never leaks a permit; `attemptOnce` wraps every transport round-trip in `run` (`client.ts:502-504`), the backoff sleep happens OUTSIDE the permit, `release()` is defensive against double-release, and the FIFO hand-off conserves the held count. `mapBounded` also routes through `run`. No permit-leak DoS path found; the cap counts only real in-flight wire requests. Verified by `client-concurrency.test.ts` and `bounded-pool` suites.
- **Per-request harness re-probe:** `detectInstalledHarnesses` checks `existsSync` only, over a FIXED marker list joined under `homedir()` (no user-controlled path components, no spawn, no network, throws swallowed to `false`), and only canonical ids can enter the set. The endpoint consumes `installed.has(name)` and exposes installed booleans plus activity counts only; the marker repointing off dead hivemind-v1 paths REDUCES false "installed" reporting. Per-request cost is a handful of stats, no amplification.
- **Setup-on-install:** `runInstallSetupStep` runs the EXISTING `ConnectorRunner` engine (the same seam `honeycomb setup` uses, bound in the CLI runtime); no new spawn surface is introduced by the diff, failures print one redacted line and never change the exit code.
- **Projects TTL view cache:** entries are keyed `org + "\u0000" + workspace` so no org/workspace value can forge a key boundary; bind/unbind invalidate wholesale; the map is bounded (`maxKeys` 64, wholesale clear). The residual same-user staleness through the unkeyed `projects.json` file is the first Low above.
- **Untracked local artifact check:** `.daemon/secrets-audit.ndjson` is gitignored (verified with `git check-ignore`) and contains operation metadata, secret NAMES, and org ids only, never secret values; it cannot ship in a commit.

---

## Dependency Audit

```text
npm audit --audit-level=high: found 0 vulnerabilities
npm run audit:openclaw: Scanned 1 file(s) under harnesses/openclaw/dist/ - OK, no findings
```

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| SQL guards (`src/daemon/storage/sql.ts`) | every interpolation wrapped (`sqlIdent`/`sLiteral`/`eLiteral`/`sqlStr`/`sqlLike`) | `audit:sql` full gate OK over 299 files; focused re-scan of `src/daemon/runtime/projects` OK over 9 files | OK |
| New write path values guarded | `val.*` constructors only, no hand-quoting | `registry-write.ts` row built solely from `val.str`/`val.text`/`val.num`; key via `sLiteral` inside `updateOrInsertByKey` | OK |
| Catalog write-pattern discipline | `update-or-insert` via `updateOrInsertByKey` + `withHeal`, no hand-rolled DDL | conforms (`healTargetFor(PROJECTS_TABLE)`), heal test present | OK |
| Credential file modes | `0600` file / `0700` dir, explicit | unchanged; merge writes through the same `writeFileSync(..., { mode: FILE_MODE })` path | OK |
| Tenancy confirm cannot resurrect across org change | org-change drops confirm + sets pending | enforced in `preserveDiskMarkers`; `healOrgDrift` traced through both branches | OK |
| No token in logs / traces / bodies | redaction on all new paths | fail-soft reasons carry result kind + backend message only; bind/browse/harness bodies carry ids/paths/booleans only | OK |
| Semaphore permit safety | release in `finally` on every path | `Semaphore.run` + `attemptOnce` verified; backoff outside permit | OK |
| Capture opt-out / pre-tool-use gate | untouched by this wave | no diff touches `HIVEMIND_CAPTURE` handling or the gate | OK (out of diff) |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/daemon/runtime/projects/registry-write.ts` | Reserved-id guard widened from exact `__unsorted__` match to `isReservedProjectId` over BOTH the project id and the name (trim + case-insensitive, id and display-name reservations). |
| `src/daemon/runtime/projects/onboarding-api.ts` | `writeBind` rejects any `isReservedProjectId(projectId)` collision with a clean 400 (imports the catalog guard); unused `UNSORTED_PROJECT_ID` import dropped. |

`git diff` reviewed after remediation and confirmed security-scoped on 2026-07-05 (the two files above; no unrelated changes). Nothing committed, per instruction.

---

## Gate Output

```text
npm run typecheck: clean (tsc --noEmit, exit 0)
npm run ci: PASS
  - typecheck: clean
  - jscpd duplication: pass
  - vitest: 407 files, 4295 passed | 12 skipped
  - audit:sql: 299 files scanned, OK
npm audit --audit-level=high: 0 vulnerabilities
npm run audit:openclaw: clean
Targeted suites (projects / auth preserve-tenancy / client-concurrency / dashboard): 35 files, 358 passed | 2 skipped
```

---

## Recommended Follow-Up (architectural)

1. **Tenancy conjuncts for tenant-scope keyed writes** (the documented Medium): add an optional tenancy-conjunct capability to `updateOrInsertByKey` (or a scoped wrapper) so writes to `scope: "tenant"` tables match the read builders' explicit `org_id`/`workspace_id` filtering instead of relying solely on transport partitioning. Apply to `projects` first; consider `agents`/`synced_assets` if they ever adopt the keyed pattern.
2. **Tenancy-filter the `scope/projects` shaping read** so a cache HIT can never shape from a `projects.json` synced for a different scope (the first Low).
3. **Consider keying `projects.json` per tenancy** (or embedding per-tenancy sections) so org switching in the dashboard cannot interleave syncs of a single global file.
