# Security Audit Report: onboarding auth field-bug fix wave (uncommitted, branch `main`)

**Audit date:** 2026-07-05
**Auditor:** security-worker-bee subagent
**Scope:** the UNCOMMITTED honeycomb changes (`git diff` + untracked). Credential/auth focus:
- `src/daemon/runtime/auth/credentials-store.ts` (additive `tenancyPending?: boolean` on `DiskCredentials`)
- `src/daemon/runtime/auth/deeplake-issuer.ts` (new `persistUnconfirmedTenancy` + extracted `mintOrgBoundIdentity`)
- `src/daemon/runtime/dashboard/setup-tenancy.ts` (pending-link persists base auth-only creds before parking)
- `src/daemon/runtime/auth/tenancy-confirmation.ts` (`tenancyPending` with no marker resolves UNCONFIRMED)
- `src/commands/install.ts` + `src/commands/index.ts` (fleet-mode dashboard gate; dropped `honeycomb.local` host) - light check
- new tests: `tests/daemon/runtime/auth/tenancy-confirmation.test.ts`, `tests/daemon/runtime/dashboard/setup-login-base-persist.test.ts`, `tests/commands/install.test.ts`, `tests/commands/dispatch.test.ts`
**Node version audited:** >= 22.5.0 (ESM)
**`npm audit` result:** not re-run in this audit (no dependency-tree change in this diff; supply chain unchanged). Deferred to `dependency-audit-worker-bee`.
**OpenClaw bundle scan:** not applicable (no bundle-surface change in this diff).
**CVE watchlist last refreshed:** `research/cve-watchlist.md` present in the Stinger; no dependency delta on this branch to re-triage.

---

## Executive Summary

The credential/auth change is secure and correctly closes the data-safety gate. The new on-page login path now MINTS + PERSISTS base credentials for a multi-tenancy account so `/setup/state.authenticated` flips immediately, but it stamps `tenancyPending: true` with NO `tenancyConfirmedAt`, and the single capture chokepoint reads the exact same `isTenancyConfirmed` predicate, which now resolves that provisional credential as NOT confirmed. No user data can be written to the provisionally-bound org before the explicit tenancy pick. All five critical properties hold, grandfathering is intact, and the `/setup/tenancy/select` step fully supersedes the provisional binding. Zero Critical and zero High findings; no remediation code was required. `npm run ci` is green (402 test files, 4253 tests passed, SQL-safety audit clean).

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deeplake SQL API) | OK | 0 |
| Dependency & OpenClaw Bundle | OK | 0 (no delta this branch) |
| Configuration (cred modes, capture opt-out, client hardening) | OK | 0 |
| Pre-Tool-Use Gate & Prompt Injection | OK | 0 (not touched) |

Legend: **OK** = zero findings; **ATTN** = Medium/Low documented; **FAIL** = Critical/High (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings (follow-up required)

None detected.

---

## Low Findings (documentation only)

- [ ] **Non-atomic credential write (pre-existing, out of scope)** `src/daemon/runtime/auth/credentials-store.ts:467` - `saveDiskCredentials` writes via a single `writeFileSync(path, ..., { mode: 0o600 })` rather than a temp-file + `rename` atomic swap. This is the pre-existing write discipline shared with `saveCredentials` and is unchanged by this branch. The `{ mode: 0o600 }` option is applied by `open(O_CREAT)` so a freshly created file is never world-readable at any point (no readable window); on an overwrite the existing 0600 perms are retained. No new exposure is introduced by the new persist path. Recommend a future temp+rename hardening for crash-torn-write robustness, tracked outside this wave.

---

## Verification of the five required critical properties

1. **No token/secret logged, echoed, or placed in argv on the new persist path; pending payload carries no token.** VERIFIED.
   - `mintOrgBoundIdentity` (`deeplake-issuer.ts:735`) and `persistUnconfirmedTenancy` (`deeplake-issuer.ts:791`) obtain the token via `client.reMint` / `client.getMe` and hand it straight to `saveDiskCredentials`; the token is never passed to a logger, `console`, an error, or a spawned process argument.
   - The pending window stores the short-lived `authToken` in the in-memory `PendingLinkStore` only (`setup-tenancy.ts:263`); it is never persisted to disk or returned in a body.
   - The page-facing reads `GET /setup/tenancy` (`setup-tenancy.ts:320`) and `GET /setup/tenancy/orgs` (`setup-tenancy.ts:370`) return org/workspace identity fields only, no token.
   - Error bodies route through `redactedReason` (`setup-tenancy.ts:272`), which returns only a truncated message, never the token. The new persist-failure branch is silently swallowed (`setup-tenancy.ts:259-261`), so no error content is emitted at all.

2. **Credentials file still 0600 (dir 0700), no world-readable window on the new write path.** VERIFIED.
   - `persistUnconfirmedTenancy` persists exclusively through `saveDiskCredentials` (`credentials-store.ts:460`), the same disciplined write `persistSelectedTenancy` uses: dir created `mkdirSync({ recursive: true, mode: 0o700 })` and file written `writeFileSync(..., { mode: 0o600 })`. No hand-rolled write, no separate token copy, no VFS-visible path. (Non-atomic swap noted as pre-existing Low above.)

3. **Capture/data gate STAYS CLOSED while `tenancyPending` is true and no `tenancyConfirmedAt` exists.** VERIFIED - this is the key data-safety property.
   - `resolveTenancyConfirmation` (`tenancy-confirmation.ts:82-84`) returns `{ confirmed: false }` when `disk.tenancyPending === true` and no marker is present.
   - The daemon capture handler consults this predicate FIRST in its dormancy ladder: `evaluateDormancyGate` (`capture/capture-handler.ts:642-649`) calls `tenancyConfirmed()` and returns `"tenancy_unconfirmed"` before the bound-project gate and before any write or pipeline enqueue.
   - The predicate is wired live per capture at the composition root: `tenancyConfirmed: () => isTenancyConfirmed({})` (`assemble.ts:972`), threaded through `attachHooks` (`capture/attach.ts:106,170`). Capture is the single write chokepoint that both writes the `sessions` row and enqueues the memory-extraction pipeline, so a gated capture writes nothing and enqueues nothing to the provisional org.
   - The `/setup/tenancy` GET `selected` field uses the same `resolveTenancyConfirmation` predicate (`setup-tenancy.ts:350`), so the portal gate and capture gate can never disagree.

4. **Grandfathering unchanged.** VERIFIED.
   - `resolveTenancyConfirmation` reaches `return { confirmed: true, grandfathered: true }` (`tenancy-confirmation.ts:85`) only when there is a non-empty `orgId`, no `tenancyConfirmedAt`, AND `tenancyPending` is not `true`. A pre-073 credential (no flag, no marker) still resolves confirmed. The new `tenancyPending` branch is strictly narrower and cannot capture an existing user's credential.

5. **`/setup/tenancy/select` re-mints for the chosen org and overwrites with `tenancyConfirmedAt`.** VERIFIED.
   - `POST /setup/tenancy/select` (`setup-tenancy.ts:466`) calls `persistSelectedTenancy`, which mints a fresh token for the CHOSEN org via `mintOrgBoundIdentity` and builds a `DiskCredentials` with `tenancyConfirmedAt: clock.now()` and NO `tenancyPending` (`deeplake-issuer.ts:761-772`). `saveDiskCredentials` does a full-object `writeFileSync` overwrite, so the earlier `tenancyPending: true` field is gone and the provisional binding is fully superseded, not left dangling. The pending window is then cleared (`setup-tenancy.ts:475`).

Install fleet-mode gate (light check): CLEAN. In FLEET mode `runInstallCommand` opens nothing (`install.ts:415-419` and the dashboard step); a detection failure defers to fleet (opens nothing, `install.ts:405-411`). SOLO opens only the fixed loopback URL through `openLocalDashboardUrl`, which validates protocol is `http:`/`https:` and host is loopback / `localhost` / `::1` via fixed-argv `execFileSync` (never a shell). Dropping `honeycomb.local` narrows the host allowlist (strictly more restrictive). No injection surface and no double-open race.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **Credential file modes** | `0600` file / `0700` dir, explicit | `saveDiskCredentials` writes `{ mode: 0o600 }`, dir `mkdirSync({ mode: 0o700, recursive: true })` | OK |
| **Token never logged / echoed / in argv** | no token to logs, bodies, or process args | new persist path hands token only to `saveDiskCredentials`; page reads return identity-only | OK |
| **Tenancy gate closed for `tenancyPending`** | `confirmed: false`, `tenancy_unconfirmed` before any write | `tenancy-confirmation.ts:82` + `capture-handler.ts:642-649` | OK |
| **Grandfathering preserved** | pre-073 (no flag, no marker) resolves confirmed | `tenancy-confirmation.ts:85` narrower branch | OK |
| **Provisional binding superseded on select** | full overwrite with `tenancyConfirmedAt`, flag cleared | `deeplake-issuer.ts:761-772` + full `writeFileSync` overwrite | OK |
| **Error bodies redacted** | status/message only, never token | `redactedReason` (`setup-tenancy.ts:272`) | OK |
| **Install dashboard open** | fixed loopback URL, validated host, no shell, fleet opens nothing | `install.ts:415`, `openLocalDashboardUrl` guard | OK |
| **No hardcoded secrets in new tests** | none | scanned new test files; none found | OK |

---

## Files Changed (remediation)

None. No Critical or High finding required remediation. The audited diff is the developer's field-bug fix, reviewed and confirmed security-scoped on 2026-07-05.

---

## Gate output

`npm run ci` (typecheck + jscpd duplication + vitest + SQL-safety audit):

```text
Test Files  402 passed (402)
     Tests  4253 passed | 12 skipped (4265)
  Duration  24.74s

> @legioncodeinc/honeycomb@0.5.3 audit:sql
> node scripts/audit-sql-safety.mjs
SQL-safety audit: scanned 296 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
```

Exit code: 0 (green).

---

## Recommended Follow-Up (architectural)

- **Atomic credential write (Low, pre-existing):** migrate `saveDiskCredentials` / `saveCredentials` to a temp-file + `rename` swap so a crash mid-write cannot leave a torn credentials file. Out of scope for this wave; no new exposure introduced here.
- **Ordering reminder:** this security audit ran BEFORE `quality-worker-bee` for this fix wave (correct order). No pre-existing QA report for this specific onboarding-auth-fix wave was found, so no re-run warning applies. Run `quality-worker-bee` next.
