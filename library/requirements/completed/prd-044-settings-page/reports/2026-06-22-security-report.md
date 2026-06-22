# Security Audit — PRD-044 Settings Page

- **Auditor:** security-worker-bee (Hivemind security-stinger)
- **Date:** 2026-06-22
- **Branch:** `feat/prd-044-settings-page` (uncommitted working tree)
- **Scope:** The Settings page (3 sections: DeepLake auth status, write-only provider keys, recall-mode + migrated inference) and its daemon read/write surface.
- **Verdict:** **PASS** (no remediation required)

---

## Executive summary

PRD-044 is the security-heaviest page of the dashboard run — it touches the DeepLake bearer token, the device-flow credential identity, and provider API keys. I audited every line of the new/modified surface adversarially, with primary focus on token/secret exposure, cross-tenant reads, and SQL injection.

**The implementation is clean. Zero Critical, zero High, zero Medium findings.** No code was changed. Every load-bearing invariant the PRD set out to protect holds by construction, and the design is defense-in-depth (the token-redaction property is enforced at three independent layers: the read-model, the zod wire schema, and the React render).

Ordering is correct: no `quality-worker-bee` report exists for this branch (the only QA report under `library/qa/` is `cursor-extension/2026-06-12-qa-report.md`, unrelated). This audit runs before QA as required — no inversion.

Coverage is full-fidelity: the entire surface is in-stack (TS/ESM daemon + Deep Lake SQL layer + dashboard thin client). No out-of-catalog surface was introduced.

### Verification (all green, post-audit)

| Gate | Result |
|---|---|
| `npm run audit:sql` | OK — 212 files scanned, every SQL interpolation routes through an escaping helper |
| `npm run audit:openclaw` | OK — bundle clean against ClawHub rules |
| `npm run build` (tsc + esbuild) | OK — all bundles built @ 0.1.0 |
| `npm run ci` (typecheck + jscpd + vitest) | OK — 244 files, **2741 passed**, 6 skipped, 0 failed |
| `git diff --diff-filter=D` | Zero deletions |
| `git status -- assets/` | Empty (assets untouched) |

The new suites `tests/daemon/runtime/auth/status-api.test.ts`, `tests/dashboard/web/settings-page.test.tsx` (11), and the updated memories recall suites all pass. The known `sources/api.test.ts` load-flake did not surface.

---

## Audit findings by focus area

### 1. The DeepLake bearer token is SACRED — proven to never escape — PASS

The token never reaches the response, the DOM, page state, or any log line. Verified end-to-end:

- **The read-model has no token field by construction.** `AuthStatusBody` (`src/daemon/runtime/auth/status-api.ts:57-74`) is metadata only: `{ connected, orgId, orgName, workspace, agentId, source, savedAt, expiresAt? }`. `resolveAuthStatus` (`status-api.ts:107-132`) builds the body from `creds.orgId/orgName/workspace/agentId/savedAt` — the token is never spread in.
- **The token is decoded ONLY for `exp`, never echoed.** The sole `creds.token` use in the *entire* 044 surface is `status-api.ts:119` — `verifyTokenClaims(creds.token)`. `verifyTokenClaims` (`auth/contracts.ts:452-476`) decodes to a claims object containing only `org/workspace/agentId/role/project/exp`; the raw token string is never returned. The handler reads `claims.exp` and discards the rest (`status-api.ts:120`).
- **The wire schema drops any stray token.** `AuthStatusSchema` (`src/dashboard/web/wire.ts:578-589`) has no `token` key, so even a buggy daemon that leaked a token in the body would have it stripped by zod before reaching React (defense layer 2).
- **The page never renders a token.** `settings.tsx` `DeeplakeAuthSection` (`pages/settings.tsx:111-172`) renders only `orgName/orgId/workspace/agentId/source/savedAt/expiry` as inert React text (defense layer 3).
- **No logging.** `status-api.ts` contains zero `console.*`/`process.std*`/`logger.*` calls. `loadCredentials` (`auth/credentials-store.ts:297+`) does no logging.

### 2. Provider keys are WRITE-ONLY — PASS

- **No value-returning path exists.** The page reads `GET /api/secrets` (names only, `wire.ts:1116-1121`) and writes `POST /api/secrets/:name` (`wire.ts:1122-1143`). There is **no `getSecret` wire method** and none was added. The daemon `mountSecretsApi` (`secrets/api.ts:6-15, 93`) explicitly mounts **no `GET /:name`** — the absence is the documented security property; a probe 404s.
- **The value never round-trips.** `setSecret` deliberately does not parse the response body and returns only `res.ok` (boolean). The 201 ack carries the NAME only (`secrets/api.ts:188`).
- **The value never lingers in state/DOM/logs.** In `ProviderKeyRow` (`settings.tsx:193-264`) the value lives only in a transient `draft` that is cleared on a successful save (`settings.tsx:221`); the `Input` is `type="password"`. The daemon `audit()` log records the secret NAME only, never the value (`secrets/store.ts:385-398`).
- **Name-injection / traversal is blocked.** The name is `encodeURIComponent`-encoded client-side (`wire.ts:1130`) AND validated server-side via `asSecretName` → `isValidSecretName` (`secrets/contracts.ts:79`); an invalid name yields `invalid_name` → 400 (`secrets/store.ts:244-247`). Cohere (`COHERE_API_KEY`) joins the same write-only map key-only (`panels.tsx:434-442`) — grep-confirmed the name exists nowhere else.

### 3. `/api/auth/status` authz + local-gate — PASS

- The read is on the protected `/api/auth` group (inherits the PRD-011 auth/RBAC middleware via `daemon.group(AUTH_GROUP)`, `status-api.ts:158-162`).
- It is **gated to local mode**: `mountAuthStatusGroup` returns `DISCONNECTED_STATUS` (200) for any `mode !== "local"` (`status-api.ts:148`) — never another tenant's identity, never a 500, never a token. In local mode the loopback `dashboard-web` viewer is the single tenant, so no cross-tenant/role bypass exists.
- The status describes only the *daemon's own* persisted identity via `loadCredentials` (total, returns `null` → DISCONNECTED). No tenant can read another tenant's auth identity.

### 4. `recallMode` read-at-recall-time (cross-tenant safety) — PASS

This was the subtlest invariant and it holds:

- The setting is read under the REQUEST's own resolved scope. `mountMemoriesApi` resolves `scope = resolveScope(c)` (header → local-default, fail-closed 400) then calls `readRecallMode(options.vault, scope)` (`memories/api.ts:296-304`). `secretScopeOf(scope)` (`memories/api.ts:237-241`) uses `scope.org` + `scope.workspace ?? "default"` — **mirroring the settings-API write partition exactly**, so tenant A's request can never pick up tenant B's `recallMode`.
- **Fail-soft + closed-enum validated.** `readRecallMode` (`memories/api.ts:251-265`) returns `undefined` (→ today's PRD-025 behavior) on absent reader / unreadable / unset / out-of-enum / any throw, and re-validates via `isValidRecallMode` (defense in depth on top of the write-time gate in `vault/api.ts:235-241`).
- **No unguarded SQL.** `recallMode` is a closed enum (`keyword|semantic|hybrid`) that only flips a boolean branch (`recall.ts:585,602`; `recall/collection.ts:274`). It never reaches a SQL string.

### 5. SQL / injection / XSS — PASS

- `npm run audit:sql` green. Every new daemon read (`recall.ts` lexical/semantic arms, `collection.ts` FTS/vector) routes identifiers through `sqlIdent`, terms through `sqlLike`, literals through `sLiteral`. Limits are clamped integers interpolated bare (audit-safe).
- The page renders every value as inert React text. **No `dangerouslySetInnerHTML` anywhere** in `settings.tsx`. Auth-status fields and provider labels cannot carry markup to a sink.

### 6. No secret in zod schemas / wire / logs — PASS

- `AuthStatusSchema` has no token field (`wire.ts:578-589`); `setSecret` returns a boolean (`wire.ts:1122-1143`).
- Grep of the whole 044 surface (`auth/status-api.ts`, `wire.ts`, `settings.tsx`, `memories/api.ts`, `vault/api.ts`) for any `console`/`process.std*`/`logger` line carrying a token, a provider key value, or credential-file contents: **none found**. The only token reference is the `exp`-decode at `status-api.ts:119`.

---

## Remediations applied

**None.** No Critical/High/Medium finding required a code change. The implementation already satisfies every invariant.

## Files changed by this audit

**None.** This was a clean PASS; the working tree is unchanged by the audit.

## Residual risk

- **Low / accepted:** `mountAuthStatusApi(daemon)` (`assemble.ts:1296`) is fired outside the `mode === "local"` mount block. This is *not* a defect — the handler self-gates on `mode !== "local"` (`status-api.ts:148`), so a non-local daemon serves only the DISCONNECTED body. The gate lives in the handler rather than the mount, which is the more robust placement (the route exists but reveals nothing). No action needed.
- **Informational:** `expiresAt` is currently absent in practice because the Wave-1 stub token carries no `exp` claim; the page honestly shows "expiry unknown" rather than fabricating a date. When real `exp` claims land, the existing decode path surfaces them with no further change.

## Category checklist (every category checked)

| Catalog category | Result |
|---|---|
| Credential / token exposure (logs, response, DOM, schema) | None detected |
| Captured-trace PII leakage (`sessions`/`memory`) | None detected — recall path unchanged in shape; no new PII surface |
| SQL injection (Deep Lake, missing `sqlIdent`/`sqlLike`) | None detected (`audit:sql` green) |
| Cross-org / cross-scope read (broken access control) | None detected — `recallMode` read is request-scoped |
| Auth bypass / local-gate | None detected — handler self-gates to local mode |
| Name-injection / path traversal (secret name) | None detected — client encode + server `isValidSecretName` |
| XSS (`dangerouslySetInnerHTML`, markup-to-sink) | None detected — all inert React text |
| Prompt-injection / poisoned recall context | N/A — no change to injection surface |
| Supply chain (OpenClaw bundle, deps) | None detected (`audit:openclaw` green) |
| Verbose error / org-id echo | None detected — errors return coarse reasons only |

**Final verdict: PASS — clear for `quality-worker-bee`.**
