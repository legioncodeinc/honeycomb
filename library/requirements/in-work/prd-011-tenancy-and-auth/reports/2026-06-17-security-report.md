# Security Audit — PRD-011 Tenancy & Auth

- **Branch:** `prd-011-tenancy-and-auth`
- **Auditor:** security-worker-bee (Hivemind security-stinger)
- **Date:** 2026-06-17
- **Scope:** THE fail-closed auth/tenancy boundary — `src/daemon/runtime/auth/*`, the evolved `src/daemon/runtime/middleware/permission.ts`, `src/daemon/storage/catalog/tenancy.ts` (scrypt + SQL), `src/cli/{org,auth,keys}.ts`, and the daemon wiring in `src/daemon/runtime/server.ts`.
- **Ordering:** Correct. No `*-qa-report.md` exists for prd-011 — `security-worker-bee` ran BEFORE `quality-worker-bee`. quality-worker-bee is cleared to run after this report.

---

## Executive Summary

This is the product's central fail-closed security boundary, and it was audited harder than any prior PRD. **The fail-closed thesis is affirmatively proven, not merely asserted** (evidence below). Credential/token handling, scrypt+constant-time key verification, the append-only revoke fix, tenant partition isolation, RBAC, rate-limit DoS bounds, and SQL safety all hold. **Zero Critical, zero High, zero Medium findings required remediation.** Two Low items are documented as accepted-by-design environment constraints with follow-ups, not shippable vulnerabilities.

**No code changes were made** — the implementation is clean against every catalog. The diff for this PRD remains exactly what Waves 1–2 produced plus this report.

**Verdict: PASS — cleared for `quality-worker-bee`.**

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low (documented, no fix) | 2 |

---

## The fail-closed thesis — proven affirmatively

### 1. The `legacyPermissionCheckAdapter` is unreachable on every production path

`src/daemon/runtime/server.ts:219-228` is the ONLY wiring site:

```ts
const legacyCheck = options.permissionCheck;       // undefined unless a caller injects it
const useLegacy = legacyCheck !== undefined;
const mountPermission = (groupPath) =>
  useLegacy
    ? legacyPermissionCheckAdapter(groupPath, getMode, legacyCheck ?? defaultDenyPermissionCheck)
    : permissionMiddleware(groupPath, getMode, permissionOptions);
```

The spoofable header-role path (`legacyPermissionCheckAdapter`, which reads `x-honeycomb-role` at `permission.ts:267-279`) is reached **only** when `options.permissionCheck` is explicitly supplied. Grep over `src/` confirms the only injectors of `permissionCheck` are the **004a compatibility tests** (`tests/daemon/runtime/server.test.ts:112,141,161,181`). No production assembly path passes it. The PRD-011 default — and every real path — is `permissionMiddleware` with the fail-closed trio `{ authenticator: alwaysUnauthenticated, policy: defaultDenyPolicy, socketPeer: noSocketPeer }` (`permission.ts:145-147`; defaults in `contracts.ts:359-363,417-421`). A spoof-header test (`tests/daemon/runtime/middleware/permission.test.ts:121-134`) proves an `x-honeycomb-role: admin` header CANNOT grant access on the real gate. **Conclusion: the header-role trust is dead code on every production path. No finding.**

### 2. Fail-closed at every fork
- No credential in `team`/`hybrid` → **401** before the authenticator is even called (`permission.ts:171-173`).
- `hybrid` trusts ONLY the `SocketPeerProbe` (default `noSocketPeer` → always require a token); it NEVER reads the `Host` header (`permission.ts:160-167`, c-AC-1).
- Authenticated but unauthorized → **403** (`permission.ts:201`).
- Unknown route group → `DEFAULT_CAPABILITY = "admin"` → only admin clears it (`rbac.ts:170,193-204`) — an unclassified route is locked, never waved through.
- Malformed token → `verifyTokenClaims` returns `null` → 401 (`contracts.ts:452-476`). Malformed key → `splitApiKey`/`scryptVerifySecret` return null/false → 401 (`api-keys.ts:107-119`, `tenancy.ts:412-437`).
- Absent/unknown role on a token claim → least-privileged `agent`, never wider (`device-flow.ts:253-258`).

No allow-by-default path exists in the audited surface.

---

## Category scorecard

| Catalog area | Result | Evidence |
|---|---|---|
| Token/secret/key in logs/output/disk | None detected | No `console`/logger emits a token. `JSON.stringify` appears only at `credentials-store.ts:163` (the 0600 file write) and `contracts.ts:485` (stub-token encode) — neither a log. `status`/`login`/`switch` print every identity field EXCEPT the token (`org.ts:184-190`, `auth.ts:139`). Storage trace redacts via `redactToken` (`client.ts:106`). `key list` projection drops `key_hash` by construction (`api-keys.ts:348-409`). |
| scrypt + constant-time | None detected | New keys: `scryptHashSecret` (N=16384,r=8,p=1, per-key 16-byte salt embedded) + `scryptVerifySecret` with `timingSafeEqual` (`tenancy.ts:393-437`). Token compare uses `safeEqual`/`timingSafeEqual` (`device-flow.ts:261-266`). No `==`/`===` on a secret; no SHA-256 minting a new key (`hashApiKey` retained only for legacy/live-smoke, documented). |
| Revoke fix (d-AC-4) | None detected | `api_keys` is `version-bumped` (`tenancy.ts:234`). `revokeKey` reads highest version, APPENDs v+1 with `revoked=1`, all fields copied (`api-keys.ts:305-344`). Authenticator reads `ORDER BY version DESC LIMIT 1` and rejects `revoked` (`tenancy.ts:321-326`, `api-keys.ts:258-261`). In-place UPDATE retired with no live caller (`tenancy.ts:344-363`). Live-proven 3/3. |
| Tenant isolation | None detected | Org/workspace are a transport-level PARTITION selector taken from the resolved `scope`, threaded beneath the SQL (`client.ts:101-128`) — not a WHERE clause and not caller-nameable. `resolveTenancy` rejects a file `orgId` ≠ verified token org, and an `HONEYCOMB_ORG_ID` override ≠ token org (`credentials-store.ts:222-258`, a-AC-5). API-key Identity's org/workspace come from the partition-scoped row, falling back to `scope.org` (`api-keys.ts:263-277`); the create-row payload never carries `org_id`, so it cannot forge a cross-tenant binding. |
| SQL injection | None detected | `npm run audit:sql` = 0 (83 files). Every `api_keys`/`tenancy` interpolation routes table/col through `sqlIdent` and values through `sLiteral` (`tenancy.ts:290-363`, `api-keys.ts:416-420`). `splitApiKey` additionally constrains `keyid` to `[A-Za-z0-9_-]+` before it reaches SQL (`api-keys.ts:117`). |
| RBAC bypass | None detected | Data-driven `ROUTE_CAPABILITY_TABLE` + frozen `CAPABILITY_ROLES` matrix (`rbac.ts:92-162`). `readonly` write → 403 (`effectiveCapability`, c-AC-2); `agent` on connectors-admin/admin/token routes → 403 method-independent (c-AC-6); project alpha→beta → 403 unless admin (`clearsProjectScope`, c-AC-5); unknown group → admin-only. |
| DoS / rate-limit | None detected | Sliding window in a Map HARD-CAPPED at `maxKeys` with oldest-touch eviction + lazy stale-drop (`rate-limit.ts:77-129`). Keys off the validated identity, anon shares one bucket (no credential-omission dodge). `local` → no limit. Device-flow poll is bounded by `DEFAULT_MAX_POLLS=900` (`device-flow.ts:92,139-149`). |
| Credential file modes 0600/0700 | None detected | `writeFileSync(..., { mode: 0o600 })`, dir `mkdirSync({ mode: 0o700 })` (`credentials-store.ts:152-164`); win32 best-effort gap documented. |
| Verbose errors | None detected | 401/403 bodies carry no token/path/SQL (`permission.ts:220-227`); `TenancyIntegrityError` carries org ids only, never the token (`credentials-store.ts:186-197`). |
| Prompt injection / supply chain | None detected (in PRD-011 scope) | No recalled-memory/skill-injection surface touched by this PRD. `npm run audit:openclaw` = 0. |

---

## Low (documented — accepted by design, no fix)

- **L-1 — Stub token integrity-by-shape only.** `verifyTokenClaims` (`contracts.ts:452-476`) validates a `hcmt.v1.` + base64url(JSON) shape with NO cryptographic signature. This is explicit and bounded: there is no real auth server in this environment, the Wave-1 decoder is swapped for real signature+expiry verification BEHIND the same seam by 011b's HTTP issuer adapter (deferred), and forging a token still requires already controlling the local 0600 credentials file (no privilege gain). **Follow-up:** the deferred real `TokenIssuer` adapter must land signature + `exp` verification before any production auth-server wiring. Not shippable as a vuln on its own.
- **L-2 — Request logger records caller-asserted org/workspace headers.** `server.ts:236-248` logs `x-honeycomb-org`/`x-honeycomb-workspace` for diagnostics. These are NOT used for enforcement (enforcement reads the validated Identity), and no token is logged. Cosmetic only: a logged org hint may not equal the enforced org. **Follow-up (optional):** log the resolved scope instead of the raw header once the authenticator is wired at assembly, so logs reflect what was enforced.

---

## Gate exit codes (this session)

| Gate | Exit | Notes |
|---|---|---|
| `npm run audit:sql` | **0** | 83 files; every interpolation routes through an escaping helper. |
| `npm run audit:openclaw` | **0** | Bundle clean against ClawHub static rules. |
| `npm run typecheck` (`tsc --noEmit`) | **0** | Clean. |
| `npm run ci` (full) / `npm run build` | not re-run this session | No code changed; orchestrator root-verify already green (ci=786 incl. +3 skip, build=0). Live `api-keys-live.itest` is the orchestrator's to run, per directive. |

No `git diff` delta from this audit — zero remediations were necessary.

---

## Legacy-adapter reachability conclusion

`legacyPermissionCheckAdapter` (the only surviving `x-honeycomb-role` header-role path) is reachable **only** behind an explicit, deprecated `options.permissionCheck` injection that no production path supplies — its sole injectors are the 004a compatibility tests. `createDaemon` defaults to the fail-closed `permissionMiddleware` with `{ alwaysUnauthenticated, defaultDenyPolicy, noSocketPeer }`. The privilege-escalation header surface is therefore inert in production. **No finding; no fix required.**

## Verdict

**PASS.** 0 Critical / 0 High / 0 Medium / 2 Low (documented, accepted-by-design). The fail-closed auth/tenancy boundary holds on every audited path. **`quality-worker-bee` is cleared to run.**
