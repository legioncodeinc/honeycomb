# EXECUTION LEDGER — PRD-011 Tenancy & Auth

> /the-smoker run. Branch `prd-011-tenancy-and-auth` off main (PRD-001..010 + CI merged). PR → main.

**Scope:** index + 011a (org/workspace + storage partition isolation) / 011b (device-flow login + `credentials.json` 0600 + drift heal) / 011c (local/team/hybrid modes + 4-role RBAC) / 011d (named API keys, scrypt-hashed + sliding-window rate limit) / 011e (`agent_id` read policies + the SQL scope clause). 30 sub-ACs + 4 index ACs. The fail-closed auth/tenancy layer: when in doubt, DENY. **Makes the daemon's `PermissionCheck` real** (PRD-004 ships `defaultDenyPermissionCheck`; this PRD fills mode+RBAC).

**Builds on (a LOT already exists — much of 011a/011e is consolidation/verification, not net-new):**
- PRD-004 `permission.ts` middleware — the `PermissionCheck` seam (currently `defaultDenyPermissionCheck`); `permissionMiddleware(path, getMode, check)` already mounted per protected route group with `getMode`. 011c fills the real check.
- PRD-007c `recall/scope-clause.ts` — THE canonical `buildScopeClause` (isolated/shared/group, fail-closed→isolated, escaped, IDs-before-content), already integrated in `recall/authorization.ts` incl. group-roster resolution. **011e formalizes the 6 e-ACs against this existing builder** + verifies IDs-authorized-before-content (already live-proven by `recall-authz-live.itest`).
- PRD-003e `catalog/tenancy.ts` — `agents` (read_policy/policy_group, update-or-insert) + `api_keys` (`key_hash` ONLY, no plaintext column; `hashApiKey` helper exists [SHA-256 — 011d reconciles to scrypt-salted per d-AC-1]), both EXIST.
- PRD-002 storage `QueryScope {org, workspace}` partition — cross-workspace isolation is a storage-path property (011a AC-1/AC-2 verify it). PRD-002 escaping helpers for the scope clause.
- No jwt/oauth/scrypt deps → `node:crypto` (scrypt, timingSafeEqual) + a `TokenIssuer`/auth-server SEAM (fake in tests — no real auth server in this env) + a temp credentials dir + a fake clock. Live provider/auth calls out of scope.

## Verification posture
Vitest: credentials-store (0600 file perms, env override, malformed→null) on a temp dir; org/workspace resolution + JWT org-claim-vs-file rejection (011a); device-flow polling + drift heal against a FAKE TokenIssuer + fake clock (011b); the real PermissionCheck via `app.request` — local/team/hybrid × 4 roles × 401/403/project-scope (011c); api-key create (scrypt, plaintext-once) + revoke + sliding-window 429+Retry-After via fake clock + local-mode-no-limit (011d); the 6 e-ACs against `buildScopeClause` (011e). Opt-in LIVE: `api_keys` create→lookup-by-hash→revoke on the real backend (update-or-insert; poll-converged read; assert NO plaintext on disk). Scope clause already live-proven (`recall-authz-live`). Out of scope: a real OAuth server (seam), the secrets store (PRD-012), DeepLake internals beyond the partition boundary.

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | roles | 4 RBAC roles: `admin` (all), `member` (read+write own/scope), `readonly` (read only → write=403), `agent` (connector; no admin/token/connectors-admin routes). Fail-closed default. |
| D-2 | modes | `local` (loopback → full access, no token, no rate limit), `team` (token/API-key required, RBAC enforced), `hybrid` (fail-closed: no trustworthy socket-peer → require token; NEVER trust the `Host` header). |
| D-3 | credentials | `~/.honeycomb/credentials.json` mode `0600`, dir `0700`. `savedAt` always stamped server-side. Env overrides: `HONEYCOMB_TOKEN` (token, file not read for token), `HONEYCOMB_ORG_ID`/`HONEYCOMB_WORKSPACE_ID` (override file). `loadCredentials` → null on missing/malformed. |
| D-4 | org-claim integrity | a credentials file whose `orgId` disagrees with the token's JWT org claim is REJECTED (011a AC-5), not honored. Org drift on session start → re-mint via TokenIssuer, realign org name+workspace, warn + continue on failure (011b AC-2). |
| D-5 | device flow | OAuth 2.0 device flow against a `TokenIssuer` SEAM (fake in tests): request device code → user approves in browser → CLI polls → long-lived org-bound token. `honeycomb login`/`logout` (logout w/o file → "Not logged in." + success). |
| D-6 | api keys | create → plaintext printed ONCE, only a scrypt-salted hash stored in `api_keys` (reconcile the existing SHA-256 helper → scrypt+salt per d-AC-1). Revocable (revoked key rejected, others keep working). Project-bound (`project=alpha` key denies `project=beta`). |
| D-7 | rate limit | sliding-window per caller on expensive routes → `429` + `Retry-After`. In-memory (bounded map + eviction, no new table). `local` mode → no limit. |
| D-8 | scope clause (011e) | the EXISTING `buildScopeClause` is canonical — DO NOT rebuild. 011e adds e-AC-named tests + verifies IDs-authorized-before-content + fallback-to-isolated. |
| D-9 | auth seam | a Wave-1 `Authenticator { authenticateToken(bearer), authenticateApiKey(key) }` seam the PermissionCheck calls; 011b fills token validation, 011d fills api-key validation, 011c owns the mode+role decision. Injected at daemon assembly (deferred). |

## Scaffold/seam plan
Wave 1: auth/tenancy contracts (`Identity{org,workspace,agentId,role,project?}`, `Role`, `Mode` [exists], `Credentials`, token/JWT-claim shape, `ApiKeyRecord`, `RateLimitState`) + `TokenIssuer` + `Authenticator` seams + the `CredentialsStore` (0600 file, env override, load→null) + 011a org/workspace resolution (+ org-claim-vs-file rejection) + the real `PermissionCheck` HARNESS (mode-aware skeleton; role/project decision + authenticator calls stubbed for 011c) + 011e e-AC verification against `buildScopeClause` + stubs for 011b/c/d + CONVENTIONS.md. Wave 2 fills 011b (device-flow + auth CLI) ‖ 011c (modes+RBAC permission impl) ‖ 011d (api-keys+rate-limit + keys CLI). Per-concern CLI files (`src/cli/org.ts` 011a, `auth.ts` 011b, `keys.ts` 011d) → zero CLI contention.

---

## AC Ledger (30 sub-ACs + 4 index)

### 011a Org/Workspace + Partition — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Resolved org sent + workspace in the storage path → cross-workspace reads impossible. | VERIFIED |
| a-AC-2 | Two workspaces, recall in A with API filter removed → no row/partition/index from B reachable. | VERIFIED |
| a-AC-3 | `honeycomb org switch acme` re-mints+saves a fresh org-bound token; `workspace use backend` updates the file only. | VERIFIED |
| a-AC-4 | `HONEYCOMB_ORG_ID`/`HONEYCOMB_WORKSPACE_ID` set → override the credentials file. | VERIFIED |
| a-AC-5 | Credentials file claiming a different `orgId` than the JWT → daemon REJECTS, not honors. | VERIFIED |
| a-AC-6 | `honeycomb status` logged-in → prints org id/name/workspace/agent, NEVER the bearer token. | VERIFIED |

### 011b Device-Flow Auth — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Device flow approved → CLI polls, gets long-lived org-bound token, writes `credentials.json` 0600 (dir 0700). | VERIFIED |
| b-AC-2 | Token org-claim ≠ active org on session start → re-mint + realign name/workspace, warn + continue on failure. | VERIFIED |
| b-AC-3 | Missing/malformed `credentials.json` → `loadCredentials` returns null, CLI prompts login. | VERIFIED |
| b-AC-4 | Successful login → `savedAt` is current timestamp regardless of any passed value. | VERIFIED |
| b-AC-5 | `HONEYCOMB_TOKEN` set → env token used, file not read for the token. | VERIFIED |
| b-AC-6 | `honeycomb logout` with no file → prints "Not logged in." + success (not error). | VERIFIED |

### 011c Modes + RBAC — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `hybrid` + no socket-peer info → fail closed, require token (never trust `Host` header). | VERIFIED |
| c-AC-2 | `readonly` role on a write route → 403; `admin` passes all permission+scope checks. | VERIFIED |
| c-AC-3 | `team` mode, no valid Bearer/API key → 401. | VERIFIED |
| c-AC-4 | `local` mode on localhost → full access, no token required. | VERIFIED |
| c-AC-5 | Token scoped `project=alpha` targeting `project=beta` → 403 unless `admin`. | VERIFIED |
| c-AC-6 | `agent`-role connector on a connectors-admin/token route → 403. | VERIFIED |

### 011d API Keys + Rate Limit — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Created key → plaintext printed ONCE, only a scrypt-salted hash stored in `api_keys`. | VERIFIED |
| d-AC-2 | Caller over sliding-window limit on an expensive route → 429 + `Retry-After`. | VERIFIED |
| d-AC-3 | Connector key with default perms on an admin route → 403. | VERIFIED |
| d-AC-4 | Revoked key on next request → rejected; other keys keep working. | VERIFIED |
| d-AC-5 | `local` mode, many requests → no rate limit applied. | VERIFIED |
| d-AC-6 | Key bound `project=alpha`, request targets `project=beta` → denied. | VERIFIED |

### 011e Agent Scoping (scope clause) — Wave 1 verification (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | read_policy+policy_group → clause builder emits the matching WHERE, values escaped via helpers. | VERIFIED |
| e-AC-2 | FTS/vector/traversal IDs → scope clause authorizes BEFORE any content-bearing stage loads. | VERIFIED |
| e-AC-3 | `isolated` agent → only own non-archived returned. | VERIFIED |
| e-AC-4 | `shared` agent → workspace-global + own, archived excluded. | VERIFIED |
| e-AC-5 | `group` agent → same-policy_group globals + own, archived excluded. | VERIFIED |
| e-AC-6 | Malformed/missing read policy → falls back to `isolated`. | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 cross-workspace unreachable even sans API filter | a-AC-2, e-AC-2 | VERIFIED |
| AC-2 device login → org-bound token + 0600 credentials.json | b-AC-1 | VERIFIED |
| AC-3 team mode: no token→401, insufficient perm→403 | c-AC-3, c-AC-2 | VERIFIED |
| AC-4 isolated agent recall → own non-archived only | e-AC-3 | VERIFIED |

**Totals:** 34 ACs (30 sub + 4 index) · **34 VERIFIED** · 0 OPEN — fully VERIFIED (auth/RBAC/keys/rate-limit unit-proven; scope-clause + api_keys lifecycle live-proven incl. the revoke append-only fix), close-out unlocked.

## Wave plan
```
Wave 1 (contracts + seams + CredentialsStore + 011a + PermissionCheck harness + 011e verify + stubs) ──► Wave 2 (011b ‖ 011c ‖ 011d) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `typescript-node-worker-bee` opus — contracts + TokenIssuer/Authenticator seams + CredentialsStore (0600) + 011a org/workspace resolution (+org-claim rejection) + `honeycomb org/workspace/status` CLI + the PermissionCheck harness (mode skeleton, role/auth stubbed) + 011e e-AC verification against `buildScopeClause` + 011b/c/d stubs + CONVENTIONS.md. + opt-in live api_keys smoke scaffold.
- Wave 2 · 3 parallel `typescript-node-worker-bee` — 011b device-flow+auth CLI (opus), 011c modes+RBAC permission impl (opus, the enforcement core), 011d api-keys+rate-limit+keys CLI (opus).
- Wave 3 · `security-worker-bee` (opus — THIS is the auth layer; audit hardest: fail-closed everywhere, no token in logs/status, 0600 perms, scrypt+timingSafeEqual, partition can't be escaped, RBAC can't be bypassed, rate-limit can't be evaded, project-scope can't be crossed) → `quality-worker-bee` (sonnet).

## Watchdog / event log
- Main-CI regression (recall-authz live under-read) fixed via PR #12; PRD-010 shipped via PR #13; main GREEN incl. gated live job (10 PRDs done, 001–010). PRD-011 moved→in-work, branched off main (fd4c0a6).
- Infra scan: `PermissionCheck` seam (default-deny) + `permissionMiddleware` mounted; `scope-clause.ts` canonical + integrated (011e ≈ verification); `agents`+`api_keys` tables exist (`api_keys` key_hash-only, SHA-256 helper → reconcile to scrypt); `QueryScope` partition enforces tenancy; no jwt/oauth/scrypt deps → node:crypto + seams. Wave 1 dispatched.
- Wave 1 DONE (opus): contracts + `TokenIssuer`/`Authenticator`/`AuthorizationPolicy`/`SocketPeerProbe` seams + `CredentialsStore` (0600/0700, env override, malformed→null, savedAt stamped) + 011a resolution + `honeycomb org/workspace/status` CLI (token never printed) + **evolved `permission.ts`**: 401-vs-403, role from VALIDATED Identity (the spoofable `x-honeycomb-role` path REMOVED — fenced into a `@deprecated legacyPermissionCheckAdapter` used only by 004a's opt-in path; a spoof-header test proves it can't grant access), hybrid fail-closed (never trusts `Host`), default `{alwaysUnauthenticated, defaultDenyPolicy, noSocketPeer}` → daemon fail-closed by default. 011e verified against the EXISTING `buildScopeClause` (not rebuilt). a-AC-1..6 + e-AC-1..6 VERIFIED. ci=0 (721, +1 win32-skip), invariant green, 004a server tests kept green. Pinned: `Role=admin|member|readonly|agent`, `Identity{org,workspace,agentId,role,project?}`, `AuthDecision=allow|unauthenticated|forbidden`, the seam signatures. NOTE: 011c PRD prose still says role `operator` — reconciled to `member` at the binding contract (ledger D-1 authoritative).
- Wave 2 DONE (3 parallel opus): 011b device-flow+`auth.ts` CLI (deviceFlowLogin against fake TokenIssuer + 0600 save, `healOrgDrift` re-mint+warn-continue, `createTokenAuthenticator` via `verifyTokenClaims`+timingSafeEqual, token NEVER logged/printed; 6 b-AC tests). 011c `rbac.ts` (data-driven `ROUTE_CAPABILITY_TABLE`→capability→role-set, longest-prefix, fail-closed-to-admin default; write=method-based, admin/connectors-admin=method-independent; project alpha→beta=403 unless admin; 401=middleware/authenticator, 403=policy; 6 c-AC tests via app.request). 011d `api-keys.ts`+`rate-limit.ts`+`keys.ts` CLI (key `hc_sk_<keyid>.<secret>`, scrypt-salted hash `scrypt$N$r$p$salt$hash` in key_hash [no schema change at first], lookup-by-keyid + scrypt-verify+timingSafeEqual, default role `agent`, project binding; bounded sliding-window limiter [LRU evict, anon bucket, local=no-limit] → 429+Retry-After; plaintext printed once; 18 d-AC tests). 011d additively reconciled `tenancy.ts` (scrypt helpers). Orchestrator root-verify: ci=0 (785/+3 skip), build/audit:openclaw/audit:sql=0, invariant green, 126 auth/CLI tests.
- **LIVE SECURITY FIX (d-AC-4):** `api-keys-live.itest` revoke test FAILED on the real backend — a REVOKED key still authenticated. Root cause = the proven-unreliable in-place UPDATE: `api_keys` was `update-or-insert`, `revokeKey` did `UPDATE SET revoked=1`, the by-id lookup served a stale pre-revoke segment. **NOT caught by unit tests (in-memory storage).** Fix (deeplake-dataset-worker-bee, opus — the 008/004 proven pattern): added a `version` column, flipped `api_keys` to `version-bumped`; `createApiKey`→`appendVersionBumped` (v1); `revokeKey`→reads highest version, APPENDS v+1 with `revoked=1` (all fields copied, like `appendPriorSuperseded`); lookup + list resolve highest-version-per-id (`ORDER BY version DESC`); unit tests now FORBID any UPDATE (an emitted UPDATE throws). ci=0 (786). **3/3 clean consecutive live runs — a revoked key no longer authenticates.** Lesson (4th time): any state-transition on this backend must be append-only version-bump + highest-version read; in-place UPDATE is unsafe.
- All 34 ACs VERIFIED. Wave 3 (security → quality) dispatched — this is the auth layer; security audit is paramount (flag the `legacyPermissionCheckAdapter` reachability + confirm no token/secret leaks + fail-closed everywhere).
