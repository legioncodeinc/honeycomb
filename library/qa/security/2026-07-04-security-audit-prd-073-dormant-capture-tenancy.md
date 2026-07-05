# Security Audit: PRD-073 Dormant Capture and Explicit Tenancy

> Category: Security Audit | Version: 1.0 | Date: July 2026 | Status: Active

Audit of the uncommitted working-tree changes on branch `feature/prd-073-dormant-capture-tenancy` in the honeycomb repo, covering the per-session bound-project capture gate, dormancy surfacing, the two-phase device-link with the `/setup/tenancy*` selection API, the `tenancyConfirmedAt` marker plus grandfathering, workspace creation, and the CLI tenancy prompts/flags.

**Related:** `.cursor/skills/security-stinger/SKILL.md`, `library/requirements/backlog/prd-073-dormant-capture-and-explicit-tenancy/`

---

## Executive Summary

No Critical or High findings. The auth + capture wave is implemented with the token-is-a-secret discipline held throughout: the short-lived and long-lived tokens ride only in the `Authorization: Bearer` header, never in a response body, log line, or URL. The two-phase link parks the short-lived token in memory only (single-slot, TTL-bounded, cleared on select), and every new `/setup/tenancy*` route self-gates to local mode (a non-local request 404s), verified by the route tests. SQL-safety stays clean because the new surface talks to the HTTP auth client and constructs no Deep Lake SQL.

Three Low / informational items are documented below (no code change): a defense-in-depth org-membership check missing on the workspace-create route, the pre-existing non-atomic credential write, and the documented fail-open on the tenancy seam. None expand the trust boundary beyond honeycomb's existing local-mode posture (D-3: local mode is single-user loopback with open middleware).

Scope note: full-fidelity audit of the in-scope stack (TypeScript ESM daemon, credential/auth handling, capture gate, CLI). No new datastore or non-TS subsystem was introduced.

Ordering: no `*-qa-report.md` exists for this branch under `library/qa/`; the ordering invariant (security before quality) is intact.

---

## Findings

| # | Severity | File:Line | Class | Status / Remediation |
|---|----------|-----------|-------|----------------------|
| 1 | Low | `src/daemon/runtime/dashboard/setup-tenancy.ts:461-488` | Missing defense-in-depth input validation (confused-deputy hardening) | Documented. The `POST /setup/tenancy/workspaces` create route does not validate `org` against the pending window's enumerated `pending.orgs` the way `POST /setup/tenancy/select` does (line 422-425). Not exploitable: the pending/credential token is the authenticated principal's own, and the Deep Lake backend enforces org-level write RBAC, so `org` cannot reach an org the caller lacks write access to. Recommend, for consistency, adding `if (pending !== null && !pending.orgs.some((o) => o.id === org)) return c.json({ created: false, error: "org is not in the enumerated list" }, 400);`. |
| 2 | Low | `src/daemon/runtime/auth/credentials-store.ts:447-456` | Non-atomic credential write / no O_NOFOLLOW | Documented (pre-existing, not introduced by this branch). `saveDiskCredentials` writes with `writeFileSync(path, ..., { mode: 0600 })`, which is not a temp-write-then-rename and does not refuse a symlink at the path. The `tenancyConfirmedAt` marker rides this same path. The file lives under `~/.deeplake` (dir mode 0700), so exploitation needs an attacker already inside the user's home. The `mode` option only applies on file creation; an existing file keeps its perms (documented in the module header). Recommend a future hardening PRD to move both save paths to atomic write + rename with `O_EXCL`/`O_NOFOLLOW`; out of scope for a minimal-blast-radius fix here. |
| 3 | Low | `src/daemon/runtime/capture/capture-handler.ts:637-645` | Documented fail-open on seam throw | Documented (by design). `evaluateDormancyGate` treats a throw from `tenancyConfirmed()` as confirmed (fail-open) so a set-up user is never hard-blocked. Verified not attacker-inducible: the seam is `isTenancyConfirmed -> resolveTenancyConfirmation -> loadDiskCredentials`, and `loadDiskCredentials` wraps every read/parse in try/catch and returns `null` (never throws). A missing or malformed credential resolves to `confirmed: false` (gated), not a throw, so a crafted credentials file / `projects.json` cannot drive the fail-open branch to bypass the tenancy-unconfirmed gate. No change needed. |

---

## Category Scorecard

### 1. Two-phase link window (pending token, `/setup/tenancy*`)

- **Local-mode self-gate:** every route (`GET /setup/tenancy`, `/orgs`, `/workspaces`, `POST /select`, `POST /workspaces`) opens with `if (notLocal()) return c.json({ error: "not_found" }, 404)` (`setup-tenancy.ts:291,341,360,413,462`). The create-workspace POST is gated identically. Tested at `tests/daemon/runtime/dashboard/setup-tenancy.test.ts:325-336` (team mode 404s all routes). The composition root additionally mounts the whole family only inside `if (daemon.config.mode === "local")` (`assemble.ts:1024,1052`). No non-local request reaches the pending routes. **Pass.**
- **Token never leaks:** `PendingLink.authToken` is memory-only; no route returns it. Response bodies carry only `{ id, name }` pairs, the pending flag, and ids. Grep confirms `authToken` / `.token` appear only in header-bound client calls (`listOrgs`/`listWorkspaces`/`reMint`/`createWorkspace`), never a `c.json` body. `redactedReason` truncates upstream error text to 200 chars and never interpolates the token (the auth client's `AuthHttpError` carries status + truncated body only, `deeplake-issuer.ts:322-324`). The device code rides the JSON body of the poll, never a URL (`deeplake-issuer.ts:401-409`). D-4 test asserts no token in the select ack (`setup-tenancy.test.ts:248`). **Pass.**
- **Single-use / invalidation:** the store is a single slot; `set` replaces, `get` returns `null` past TTL (default 10 min) and nulls the ref (`setup-tenancy.ts:169-189`). A successful select calls `store.clear()` (`setup-tenancy.ts:445`); restart drops the in-memory slot (select with no pending 400s, tested at `setup-tenancy.test.ts:270-280`). **Pass.**
- **Concurrent-link race / confused deputy:** single-slot store, local single-user loopback. A second link overwrites the slot with the second account's enumeration; a subsequent select validates `orgId` against the *current* pending's enumerated `orgs` (`setup-tenancy.ts:422-425`) and mints against the chosen org, so a select can never bind an org the current pending token cannot see. Because local mode is single-OS-user by posture (D-3), there is no cross-account deputy. **Pass.**

### 2. Select / create inputs

- **Select validation:** zod `SelectBodySchema` (`orgId`/`workspaceId` non-empty strings, `setup-tenancy.ts:260`); `orgId` checked against the enumerated `pending.orgs` (400 if absent); `workspaceId` checked against the org's enumerated workspaces unless the `default` sentinel (`setup-tenancy.ts:430-435`). Rejection tested (`setup-tenancy.test.ts:251-268`). **Pass.**
- **Workspace-create slug:** `slugifyWorkspaceId` lowercases, replaces non-`[a-z0-9]` runs with `-`, trims, caps at 34, and returns `null` unless it matches `^[a-z0-9]+(?:[-_][a-z0-9]+)*$` (`setup-tenancy.ts:264-275`). The slug goes into the JSON body `{ id, name }` (not a URL path), and the display `name` is JSON-serialized (`deeplake-issuer.ts:352-357`) so no path/body injection. **Pass.**
- **Header injection:** `org` is placed into the `X-Activeloop-Org-Id` header via `authHeaders`; the undici runtime rejects invalid header characters (CRLF), and for the select path `orgId` is already constrained to the enumerated list. **Pass** (see Finding 1 for the create-path defense-in-depth note).
- **zod on every body + redacted errors:** both POST bodies parse through `readBody` (JSON-parse guarded, `safeParse`, returns a generic reason, never throws — `setup-tenancy.ts:494-505`). Upstream failures return `redactedReason(err)` (status + 200-char message, no token/URL). **Pass.**

### 3. Capture gate

- **Fail-open not attacker-inducible:** see Finding 3. The tenancy seam cannot be driven to throw by a crafted credential or `projects.json`; a malformed file resolves to `confirmed: false` (gated). **Pass.**
- **Unconfirmed-tenancy gate holds:** `evaluateDormancyGate` checks tenancy *before* the bound-project gate (`capture-handler.ts:636-648`); an unconfirmed link gates with `tenancy_unconfirmed` regardless of folder bindings. A pending link persists no credential, so the absent-credential state is unconfirmed and capture is gated. **Pass.**
- **Inbox opt-in parse:** `resolveInboxCaptureEnabled` parses `HONEYCOMB_INBOX_CAPTURE` via `BoolFlag.safeParse`, defaulting OFF on any malformed value (`capture-config.ts:105-115`). **Pass.**
- **No cwd/path in shared telemetry:** the gated-captures counter is per-reason integers only (`gated-captures.ts`); the `/health` detail carries the two reason codes plus static guidance strings and integer totals (`health.ts`), no cwd or path. The session-bind notice returns static prose (`session-start.ts:47-56,266`), no path. **Pass.**

### 4. Credentials file

- **Marker write:** `persistSelectedTenancy` stamps `tenancyConfirmedAt` from the injected clock and persists through `saveDiskCredentials` (`deeplake-issuer.ts:747-759`), the same disciplined path as every other write (mode 0600, dir 0700, `savedAt` server-stamped). Atomicity / symlink posture is pre-existing (Finding 2). **Pass** (with Finding 2 documented).
- **Grandfathering cannot be forged:** `resolveTenancyConfirmation` returns `confirmed: false` when `disk === null || disk.orgId.length === 0` (`tenancy-confirmation.ts:67`), and `isDiskCredentials` already rejects an empty-string `orgId` (`credentials-store.ts:176`) so an empty-orgId file loads as `null`. Double-gated. Tested via the grandfather case (`setup-tenancy.test.ts:135-164`). **Pass.**

### 5. CLI

- **No token echo:** the tenancy selector prints numbered org/workspace names + ids only (`cli/auth.ts` `promptPick`); `reportLoggedIn` prints identity without the token; the output sink is documented as never receiving a bearer token. **Pass.**
- **Non-TTY refusal leaks nothing:** `refusalMessage` lists org names/ids and the required flags, no token (`cli/auth.ts` `refusalMessage`). **Pass.**

### 6. SQL safety

- `npm run audit:sql`: "OK - every SQL interpolation routes through an escaping helper" (296 files scanned). The new tenancy surface constructs no Deep Lake SQL; it uses the HTTP auth client. **Pass.**

### Other categories

- **Prompt injection / poisoned traces:** no change to the skillify gate or recall-injection path in this branch. None detected.
- **Supply chain:** no new dependencies added by this branch. None detected.
- **Broken access control (org RBAC / `me|team` scope):** the request-scope integrity gate (`resolveTenancy` token-claim-vs-file check, `credentials-store.ts:513-550`) is unchanged and still fail-closed. None detected.

---

## `npm run ci` output

```
Test Files  394 passed (394)
     Tests  4183 passed | 12 skipped (4195)
  Duration  16.85s

> @legioncodeinc/honeycomb@0.3.0 audit:sql
> node scripts/audit-sql-safety.mjs

SQL-safety audit: scanned 296 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
```

Exit code 0 (typecheck + jscpd duplication + vitest + SQL-safety audit all pass).

---

## Conclusion

**No Critical or High findings remain.** No in-place remediations were required; the working tree is unchanged by this audit (verified: `git diff` after the audit shows only the PRD-073 implementation changes, no security patch was needed). Three Low / informational items are documented above for a future hardening pass; none are exploitable within honeycomb's local-mode trust boundary. `npm run ci` is green. The branch is clear from a security standpoint; hand off to `quality-worker-bee`.
