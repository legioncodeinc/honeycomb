# Security Audit Report: PRD-007 Retrieval (the five-phase recall engine) — branch `prd-007-retrieval`

**Audit date:** 2026-06-17
**Auditor:** security-worker-bee subagent
**Scope:** `src/daemon/runtime/recall/**` (`scope-clause.ts`, `authorization.ts`, `collection.ts`, `traversal.ts`, `shaping.ts`, `gate.ts`, `engine.ts`, `config.ts`, `contracts.ts`, `index.ts`); supporting boundary modules read for the authorization chain (`src/daemon/storage/sql.ts`, `client.ts`, `transport.ts`); `tests/daemon/runtime/recall/**`, `tests/integration/recall-*.itest.ts`.
**Node version audited:** >=22 (ESM)
**`npm audit` result:** clean — `npm audit --omit=dev` → found 0 vulnerabilities
**OpenClaw bundle scan:** clean — `npm run audit:openclaw` → no findings
**CVE watchlist last refreshed:** `research/cve-watchlist.md` not present on this branch; dependency surface validated directly via `npm audit --omit=dev` (0 vulns). Recommend a `forge-stinger` refresh of the watchlist file for future audits.

---

## Executive Summary

The authorization boundary — PRD-007's whole security thesis — is sound. The two-ring model holds: the **outer ring** (org/workspace partition) is enforced server-side BENEATH the SQL (`workspace` in the request URL path `/workspaces/${workspace}/tables/query`, `org` in the `X-Activeloop-Org-Id` header in `transport.ts:83-89`), so a buggy inner clause provably cannot cross a workspace; the **inner ring** (the `agent_id` read-policy clause) routes through the single shared `buildScopeClause` chokepoint, fails CLOSED to `isolated` on any malformed/missing agent or unknown policy, and degrades `group` to own-only with no resolved peers. The **IDs-only-until-authorized** invariant is intact end-to-end: `Candidate` carries no content field, collection/traversal/authorization/shaping all emit or operate on IDs (and IDs-only metadata) only, and the gate is the sole content-hydrating phase — hydrating under the SAME compiled scope clause (belt-and-suspenders).

Two **High** findings were found and **fixed in this session**, both in `traversal.ts`: hand-rolled SQL-escape paths that bypassed the canonical `sqlLike` helper. One (`buildProjectEntitySql`) left LIKE wildcards (`%`/`_`) UN-escaped on a caller-controlled `project` filter — a wildcard-injection that could broaden the focal-entity match within the agent's own scope. Both were remediated by routing through `sqlLike`, the audited floor used everywhere else on the recall path. No cross-tenant disclosure was possible from either (the agent_id conjunct + the downstream 007c re-query both apply), but the never-downgrade discipline and the "hand-rolled escape" vibe-coding pattern put these at High. Post-fix: `audit:sql`, `ci` (462 unit tests), `build`, `audit:openclaw`, and the live integration suite (18 tests against the real backend, incl. `recall-authz-live`) are all green.

Ordering: no QA report exists for this branch — security ran BEFORE quality, as required.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | OK | 0 (boundary verified; see Surface Integrity) |
| Injection (Deep Lake SQL API) | FAIL → fixed | 2 High (both remediated) |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (DoS bounds, capture opt-out, client hardening) | OK | 0 |
| Pre-Tool-Use Gate & Prompt Injection | OK | 0 (not exercised by this PRD surface) |

Legend: **OK** = zero findings · **ATTN** = Medium/Low documented · **FAIL** = Critical/High (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **SQL Injection — unescaped LIKE wildcards on caller filter** `src/daemon/runtime/recall/traversal.ts:167` (`buildProjectEntitySql`) — the project-path ILIKE pattern was built as `` `'%${sLiteral(projectPath).slice(1, -1)}%'` ``, which escapes single quotes/backslashes but leaves `%`/`_` LIKE wildcards LIVE. A caller-supplied `filters.project` of `%` (or `_`-laden) widened the focal-entity match to every project within the agent's scope — a wildcard injection that also bypassed the canonical `sqlLike` helper used everywhere else on the recall path. **Fix:** route through `sqlLike` — `` `'%${sqlLike(projectPath)}%'` `` — so the value AND its wildcards are escaped. Contained to the agent's own `agent_id`-scoped rows (and the 007c re-query re-authorizes downstream), so no cross-tenant reach; classified High under the never-downgrade rule for an unescaped value path + helper bypass.

- [x] **SQL safety — hand-rolled escape bypassing the canonical helper** `src/daemon/runtime/recall/traversal.ts:186` (`buildEntityFtsSql`) — the entity-FTS token was escaped with an inline 4-step `token.replace(/\\/…).replace(/'/…).replace(/%/…).replace(/_/…)` chain instead of `sqlLike`. The escape was functionally complete (no live injection today), but it duplicates the audited escaping floor and is the exact "hand-rolled SQL escape" AI-code failure pattern the Stinger catalogs — a copy/paste hazard that `audit:sql` does NOT catch (the pre-built `const` evades the gate's unguarded-`${...}` fingerprint). **Fix:** replaced with `` `'%${sqlLike(token)}%'` ``, collapsing it onto the one audited helper. (Strict severity Medium for the no-live-defect bypass; fixed in-session under the <5-line rule and reported as High alongside its sibling because they are the same class in the same builder.)

---

## Medium Findings (follow-up required)

None detected.

---

## Low Findings (documentation only)

- [ ] **Verbose transport error echo (pre-existing, out of PRD-007 scope)** `src/daemon/storage/transport.ts:106` — a non-OK DeepLake response interpolates `${resp.status}: ${text.slice(0,200)}` of the response body into the `TransportError` message. This is a 002a-layer concern (not introduced by 007) and is truncated to 200 chars + carries no token/org; noting it only because the recall path surfaces these errors. No action required for PRD-007.

---

## Dependency Audit

```text
npm audit --omit=dev  →  found 0 vulnerabilities
npm run audit:openclaw →  Scanned 1 file under harnesses/openclaw/dist/ — OK, no findings
```

Full output: ephemeral local scan (terminal). No Critical/High advisories in the production dependency tree.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **Scope-clause chokepoint** (`scope-clause.ts`) | every read-policy WHERE built by one `buildScopeClause`; fail-CLOSED to `isolated` | `buildScopeClause` is the only builder; gates 1+2 fail-closed to `isolated` + structured error on blank/malformed agent (`:188`) and unknown policy (`:200`); `group` degrades to own-only with no peers (`:226`) | OK |
| **Outer-ring partition beneath SQL** | org/workspace enforced at storage layer, not by the inner clause | `transport.ts:83-89` puts `workspace` in the URL path and `org` in `X-Activeloop-Org-Id`; every recall query carries `partitionScope(scope)` | OK |
| **Group membership not spoofable** | resolved from the real `agents` roster, not a crafted `policyGroup` | `resolveGroupMembers` (`authorization.ts:167`) runs a scoped `agents` SELECT filtered by `policy_group` AND `read_policy='group'`, under the partition; the crafted `policyGroup` is only an `sLiteral`-escaped WHERE value, never a membership assertion | OK |
| **IDs-only until authorized** | no content row loaded before 007c | `Candidate`/`MergedPool` carry no content field (`contracts.ts:63-84`); collection `SELECT id, score` (`collection.ts:171`); traversal selects `id`/`memory_id` only; authorization `SELECT id` (`authorization.ts:278`); shaping reads `id`/`type`/metadata only | OK |
| **Gate hydrates under the SAME clause** | content load re-applies `pool.context.clause` | `buildHydrateSql` ANDs `(${scopeClauseSql})` into the `IN(...)` content SELECT (`gate.ts:131`), under the partition scope | OK |
| **VFS browse applies the same clause** | browse cannot bypass the read policy | `authorizeBrowse`/`buildBrowseAuthorizationSql` (`authorization.ts:391-433`) compile via the same `buildScopeClause` and apply it before any row returns | OK |
| **SQL guards** (`storage/sql.ts`) | `sqlIdent` regex `^[a-zA-Z_][a-zA-Z0-9_]*$`; `sqlStr`/`sqlLike` escape values + wildcards | confirmed; `sqlStr` doubles `\`/`'`, strips C0 controls; `sqlLike` layers `%`/`_` | OK |
| **Every recall value routed through a helper** | `sLiteral`/`sqlLike`/`sqlIdent`, no hand-quoting | TRUE after remediation (was 2 hand-rolled escapes in `traversal.ts`); `audit:sql` green | OK |
| **Injection-decision integrity** | gate uses the calibrated top score, never synthesized from rank; empty injection is valid | `gate.ts:191` reads `pool.candidates[0].calibratedScore`; empty → `{injected:false,hits:[]}` not a leak (`:195`) | OK |
| **DoS bounds** | over-fetch, traversal caps, hard timeouts all bounded, not caller-driven | `config.ts` clamps every knob (env-only, zod min-floors); traversal enforces `totalIds`/`branching` caps + `visitedEntities` cycle guard + timeout race (`traversal.ts:380-389`); reranker timeout-raced (`shaping.ts:366`); storage client per-statement timeout (`client.ts:113`) | OK |
| **Structured-error info leak** | fail-closed error carries org/workspace/agentId/route to the LOGGER, not the caller payload | `recall.authz_fail_closed` events go to `deps.logger` only (`authorization.ts:351`, `:420`); no tenant data or token in the structured fields; org redacted in SQL trace (`client.ts:106`) | OK |
| **OpenClaw bundle scan** | clean | `npm run audit:openclaw` → OK | OK |
| **No token in logs / traces** | recall logger fields carry ids/counts, never tokens | confirmed across all `logger.event` calls on the recall path | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/daemon/runtime/recall/traversal.ts` | Imported `sqlLike`; replaced the wildcard-unsafe `sLiteral(...).slice(1,-1)` project-path escape (`:167`) and the hand-rolled 4-step token escape (`:186`) with `sqlLike(...)`. Two functions touched, no behavior change beyond closing the escapes. |

Run `git diff` to review; the recall directory is currently untracked on this branch (new in this PRD), so the changes are visible in the working tree. Diff reviewed and confirmed security-scoped on 2026-06-17 — only the two `traversal.ts` builders changed.

---

## Proofs

### Proof 1 — the scope clause cannot widen (fail-closed)

`buildScopeClause` has exactly two entry gates and three policy arms, all returning a parenthesized fragment ANDed with `is_deleted = 0` (archived excluded for every policy):
- **Blank/whitespace agent** → `isolatedClause(agentId, error)` = `(agent_id = '<self>' AND is_deleted = 0)` + structured error (`scope-clause.ts:188`).
- **Unknown read policy** → same `isolated` fragment + error (`:200`). `asReadPolicy` whitelists only `isolated|shared|group`, so a crafted `read_policy` can never select a wider arm.
- **`group` with no resolved peers** → degrades to own-only `(agent_id = '<self>' AND is_deleted = 0)` (`:226`) — never the global arm.
- **`group` membership** comes from `resolveGroupMembers` (a scoped `agents` roster SELECT), NOT from the caller's `policyGroup` string; the `IN (<members>)` list is built from roster ids each `sLiteral`-escaped (`:238-239`). A spoofed `policyGroup` only changes which roster rows match — it cannot inject ids.
- Every interpolated value (`agentId`, member ids, `'global'`) goes through `sLiteral`; every column through `sqlIdent`. `audit:sql` passes. A buggy inner clause still cannot cross a workspace because the partition is applied beneath the SQL (Proof 2).
- Unit proof: `scope-clause.test.ts` (10 tests) + `authorization.test.ts` (15 tests, c-AC-1..7) + live `recall-authz-live.itest.ts` (2 tests) all green post-fix.

### Proof 2 — outer ring beneath the SQL

`storage.query(sql, { org, workspace })` → `transport.query` issues `POST ${endpoint}/workspaces/${req.workspace}/tables/query` with header `X-Activeloop-Org-Id: ${req.org}` (`transport.ts:83-89`). The partition is in the URL + header, enforced by DeepLake server-side, so the inner WHERE clause is evaluated only within the already-partitioned dataset. A bug in `buildScopeClause` can at most over- or under-match within one workspace; it has no syntax that reaches another org/workspace.

### Proof 3 — IDs-only until authorized

The content column (`content`) is selected in exactly ONE place on the recall path: `buildHydrateSql` in `gate.ts:129`, which runs only after authorization, only on the authorized/shaped survivors, AND re-applies `(${scopeClauseSql})`. Collection, traversal, authorization, and shaping select only `id` / `memory_id` / metadata columns (`type`, `status`, scores). The `Candidate` contract (`contracts.ts:63`) has no content field, so content cannot ride the pool past the boundary even by accident.

---

## Recommended Follow-Up (architectural)

1. **`audit:sql` gate hardening (hand-off to `ci-release-worker-bee` / `typescript-node-worker-bee`):** the gate did not catch the two `traversal.ts` bypasses because each escape was assembled into a `const pattern` before interpolation, so the SQL-fingerprinted line carried only a guarded `${pattern}`. Consider extending the gate to flag a `.replace(...)` chain that reproduces the `sqlStr`/`sqlLike` escape shape, or an `sLiteral(...).slice(...)` re-wrap, as a likely helper bypass. Reported, not fixed (scope: the gate script, not this PRD).
2. **CVE watchlist file:** `research/cve-watchlist.md` is absent on this branch. Recommend a `forge-stinger` run to (re)establish it so future audits have the dependency/bundle intelligence matrix rather than relying on a live `npm audit` alone.

---

## Unresolved Critical / High

**None.** Both High findings were remediated in this session and re-verified: `audit:sql` (clean), `ci` (462 unit tests pass), `build` (clean), `audit:openclaw` (clean), and `test:integration` (18 live tests pass against the real DeepLake backend, including `recall-authz-live` and `recall-collection-live`). `quality-worker-bee` may now run.
