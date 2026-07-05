# Security Audit Report: tenancy re-selection from persisted credential (uncommitted, branch `main`)

**Audit date:** 2026-07-05
**Auditor:** security-worker-bee subagent
**Scope:** the UNCOMMITTED honeycomb changes (`git diff` + untracked). Field-bug fix wave. Auth/credential focus:
- `src/daemon/runtime/dashboard/setup-tenancy.ts` (new `resolveSelectionSource` + `SelectionSource`; `POST /setup/tenancy/select` now resolves its enumerated orgs + minting token from the PERSISTED `~/.deeplake/credentials.json` long-lived org-bound token when the single-use in-memory pending window is absent, so a user can re-select org/workspace after the initial confirmation)
- `src/daemon/runtime/health.ts` + `src/daemon/runtime/assemble.ts` (storage probe timeout raised to 12s; 2-consecutive-failure debounce before `degraded`; a pure state machine, low security surface)
- supporting (read, not changed on this diff): `src/daemon/runtime/auth/deeplake-issuer.ts`, `src/daemon/runtime/auth/credentials-store.ts`
- tests: `tests/daemon/runtime/dashboard/setup-tenancy.test.ts`, `tests/daemon/runtime/health.test.ts`, `tests/daemon/runtime/assemble.test.ts`, `tests/daemon/runtime/fleet-health-recovery.test.ts`

**Node version audited:** >= 22.5.0 (ESM)
**Ordering:** correct. No `*-qa-report.md` exists for this change; security runs before quality.
**`npm audit` result:** not re-run (no dependency-tree change in this diff; supply chain unchanged). Deferred to `dependency-audit-worker-bee`.
**OpenClaw bundle scan:** not applicable (no bundle-surface change in this diff).
**CVE watchlist:** no dependency delta on this branch to re-triage.

---

## Executive Summary

The tenancy re-selection change is secure. The new persisted-credential branch reuses the SAME server-side enumeration-and-validation posture as the original pending-window path: the chosen org is validated against the freshly enumerated org list obtained from the persisted token's own `listOrgs`, and a non-default workspace is validated against that org's enumerated workspaces (obtained via a token scoped to the chosen org, re-minted first when the org differs from the credential's bound org). A caller cannot bind to an org or workspace the persisted token does not actually have access to; there is no confused-deputy path and no trust of client-supplied ids without server-side enumeration. The long-lived token rides only in the `Authorization` header, never a response body, log line, or spawned argv; the select ack carries only org/workspace id and name plus the `reminted` flag; every error routes through the redacting helper. The re-mint overwrites the credential file through the shared `saveDiskCredentials` discipline (mode 0600, dir 0700, server-stamped `tenancyConfirmedAt`). All routes remain local-mode-only (404 in team/hybrid), and the new branch does not widen that gate. No new SSRF or injection surface is introduced: `apiUrl` comes from the persisted https credential, and org/workspace ids travel in headers and JSON bodies (not URL paths) after enumerated-list validation.

Zero Critical and zero High findings. No remediation code was required. Two Low/informational observations are documented (both pre-existing, outside this diff's blast radius). Typecheck is green, the four affected test suites pass (87 tests), and the SQL-safety audit is clean.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 (not touched) |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deeplake SQL API / URL paths) | OK | 0 |
| Dependency & OpenClaw Bundle | OK | 0 (no delta this branch) |
| Configuration (cred modes, local-mode gate, client hardening) | ATTN | 2 Low (pre-existing, documented) |
| Pre-Tool-Use Gate & Prompt Injection | OK | 0 (not touched) |

Legend: **OK** = zero findings; **ATTN** = Medium/Low documented; **FAIL** = Critical/High (fixed in this session).

---

## Findings

| ID | Severity | Category | Location | Status |
|---|---|---|---|---|
| INFO-1 | Low | Credential write durability | `src/daemon/runtime/auth/credentials-store.ts:460-469` (`saveDiskCredentials`) | Documented (pre-existing; not remediated) |
| INFO-2 | Low | SSRF-adjacent (apiUrl trust) | `src/daemon/runtime/dashboard/setup-tenancy.ts:330,437,479,586` | Documented (pre-existing; not remediated) |

No Critical or High findings. No Medium findings.

---

## Critical-property verification

### 1. AUTHORIZATION: enumerated-list validation on BOTH paths - PASS

The `POST /setup/tenancy/select` handler resolves a `SelectionSource` and validates against it identically for both backing sources.

- Org validation (both paths): `src/daemon/runtime/dashboard/setup-tenancy.ts:521-524`
  ```
  const org = source.orgs.find((o) => o.id === orgId);
  if (org === undefined) return c.json({ selected: false, error: "org is not in the enumerated list" }, 400);
  ```
- Pending path enumeration source: `resolveSelectionSource` returns `orgs: pending.orgs` (enumerated at login from the short-lived in-memory token) - `setup-tenancy.ts:319-327`.
- Persisted path enumeration source: `orgs = await client.listOrgs(disk.token)` - a fresh enumeration from the persisted token's OWN access - `setup-tenancy.ts:328-333`.
- Workspace validation (both paths): `setup-tenancy.ts:528-533` calls `source.listWorkspaces(orgId)` and requires `workspaces.some((w) => w.id === workspaceId)` for any non-`default` workspace. On the persisted path `listWorkspaces` re-mints a token bound to the chosen org first when it differs from the credential's org (`setup-tenancy.ts:337-342`), so the workspace list is enumerated with a token actually scoped to the chosen org.

Because the authorization decision is made against the live enumerated lists derived from the source token (never from client-supplied ids and never from the credential file's claimed `orgId`), a caller cannot bind to an org or workspace the persisted token cannot reach. The `default` workspace sentinel is intentionally exempt from enumeration and resolves server-side, which is safe (it is not an arbitrary partition). Confused-deputy is prevented on both paths.

### 2. TOKEN HANDLING: no token in logs, bodies, or argv - PASS

- The minting token is `pending.authToken` or `disk.token` (`setup-tenancy.ts:323,332`); it flows only into `DeeplakeAuthClient` methods, which place it exclusively in the `Authorization: Bearer` header (`deeplake-issuer.ts:282-290`). It never reaches a URL path or query.
- The select ack body carries only `{ selected, org:{id,name}, workspace:{id,name}, reminted }` (`setup-tenancy.ts:546-554`). No token field.
- All error paths route through `redactedReason(err)` (`setup-tenancy.ts:273-276`), which returns `err.message.slice(0, 200)`. Underlying `AuthHttpError` messages carry only HTTP status plus a truncated response body and a fixed path literal (`deeplake-issuer.ts:322-326`); none of these carry the token.
- No `spawn`/`execFile` receives the token. The only child-process use in the auth module is the browser opener, which is given a validated https verification URL, not a token (`deeplake-issuer.ts:436-462`).

### 3. WRITE SAFETY: atomic-enough overwrite at 0600 with fresh marker - PASS

- The re-mint persists through `persistSelectedTenancy` -> `saveDiskCredentials` (`deeplake-issuer.ts:752-774`, `credentials-store.ts:460-469`), the shared discipline: dir created at `0700`, file written with `{ mode: FILE_MODE }` (0600), `savedAt` and `tenancyConfirmedAt` stamped server-side from the injected clock (caller-supplied timestamps ignored).
- On re-selection the target file already exists at 0600 from the prior write, so the overwrite replaces content in place with no world-readable window; the previous credential is fully superseded (fresh token + fresh `tenancyConfirmedAt`, `tenancyPending` cleared by omission).
- See INFO-1 for the pre-existing non-atomic-write nuance (a torn write yields malformed JSON that loads as `null`, i.e. a re-login, not a security exposure).

### 4. LOCAL-MODE GATE: unchanged, not widened - PASS

Every setup-tenancy handler self-gates first: `if (notLocal()) return c.json({ error: "not_found" }, 404)` (`setup-tenancy.ts:378,428,447,500,562`). The new persisted-credential logic lives INSIDE `POST /setup/tenancy/select` after that gate (`setup-tenancy.ts:499-500` then `504-510`), so a non-local request 404s before any credential is read. The gate is not widened.

### 5. NO NEW SSRF / injection - PASS

- `apiUrl` is `disk.apiUrl ?? resolveApiUrl(env)` (`setup-tenancy.ts:330`). It originates from the daemon-written local credential (`client.apiUrl`, itself derived from `HONEYCOMB_DEEPLAKE_ENDPOINT` or the canonical `https://api.deeplake.ai`). See INFO-2.
- Org/workspace ids never enter URL paths. The auth client's paths are fixed literals (`/organizations`, `/workspaces`, `/users/me/tokens`); the chosen `orgId` travels in the `X-Activeloop-Org-Id` header and the mint JSON body (`organization_id`), and only after enumerated-list validation. `workspaceId` is used solely for membership comparison in this path. No free-form id is interpolated into a request URL.

---

## Health / assemble change (secondary scope)

`health.ts` adds `createHealthBitTracker` (a pure debounce state machine: `record(false)` flips to `degraded` only after `HEALTH_DEGRADE_CONSECUTIVE_FAILURES = 2`; `record(true)` recovers immediately) and raises `DEFAULT_HEALTH_PROBE_TIMEOUT_MS` to 12000. No secrets, no I/O, no clock in `buildHealthDetail`; every reason field is a fixed closed-enum literal (`health.ts:106-304`). `publicHealthDetail` still strips `reasons` in team/hybrid so no subsystem topology leaks to an unauthenticated remote. No security surface introduced. Confirmed None detected.

---

## Documented Low / informational observations (not remediated)

### INFO-1 (Low) - credential write is not rename-atomic
`saveDiskCredentials` / `saveCredentials` use `writeFileSync` (truncate-then-write), not a temp-file-plus-rename. A process kill mid-write can leave a truncated file. This is not a security exposure: a malformed credential file is treated as "not logged in" by `loadDiskCredentials` / `loadCredentials` (returns `null`), and permissions are preserved on overwrite (existing 0600 file), so there is no partial/world-readable window. Pre-existing in the shared write path and used identically by the original pending-window flow; outside this diff's blast radius. Optional future hardening: write to `credentials.json.tmp` at 0600 then `renameSync` for crash-atomic replacement.

### INFO-2 (Low) - `apiUrl` from the credential file is not re-validated as https at the seam
The setup-tenancy handlers build the auth client from `disk.apiUrl` without an explicit https scheme re-check. The value is a local secret written by the daemon's own login flow; tampering it presupposes local write access to `~/.deeplake/credentials.json`, which already implies possession of the token and full local compromise. The GET orgs/workspaces reads already consumed `disk.apiUrl` before this change, so no new exposure is added. SSRF risk is negligible. Optional future hardening: assert `new URL(apiUrl).protocol === "https:"` (mirroring `validateVerificationUrl`) before constructing the client, defense-in-depth against a corrupted file.

---

## Remediation

None required. No Critical or High findings. No code was modified by this audit; `git diff --stat` for the honeycomb source is unchanged from the pre-audit state (the two Low items are pre-existing and documented only, per minimal-blast-radius policy).

---

## Gate output

- `npm run typecheck` (`tsc --noEmit`): PASS (exit 0).
- `npx vitest run` on the four affected suites (`setup-tenancy.test.ts`, `health.test.ts`, `assemble.test.ts`, `fleet-health-recovery.test.ts`): PASS - 4 files, 87 tests passed.
- `npm run audit:sql` (`scripts/audit-sql-safety.mjs`): PASS - scanned 296 files; every SQL interpolation routes through an escaping helper.

No changes were committed.

---

## Categories confirmed clean (None detected)

- Deeplake SQL injection: not touched by this diff; audit:sql clean.
- Captured-trace PII (`sessions` / `memory`): not touched by this diff.
- Pre-tool-use gate / VFS: not touched by this diff.
- Prompt-injection / skillify gate: not touched by this diff.
- Supply chain (dependencies / OpenClaw bundle): no delta on this branch.
- `.cursor/rules` hidden-Unicode: not in scope of this diff.
