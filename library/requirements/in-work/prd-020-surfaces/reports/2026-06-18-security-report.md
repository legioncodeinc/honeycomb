# Security Audit — PRD-020 Surfaces (THE FINAL PRD)

- **Auditor:** security-worker-bee (Opus 4.8)
- **Date:** 2026-06-18
- **Branch:** `prd-020-surfaces`
- **Scope:** PRD-020a CLI/commands, 020b dashboard, 020c Cursor extension, 020d notifications + D1–D5 health (27 ACs, Wave 2 landed)
- **Ordering:** Ran BEFORE `quality-worker-bee`. No QA report exists for prd-020-surfaces (`reports/` was empty). Ordering invariant satisfied.

---

## Executive Summary

**VERDICT: PASS-WITH-FIXES.** One **High** finding (cross-actor destructive delete in `sessions prune`) was found and **remediated in-session** with a named regression test. Two **Medium** findings are documented (one systemic, pre-existing daemon-wide; one local hygiene). No Critical findings. No credential/token leakage. The two highest-value targets the task flagged were resolved decisively:

- **Webview XSS via daemon-served names (020c): PROVEN SAFE.** Every datum (`ViewBlock.kind`, `.title`, every `row`) is HTML-escaped (`& < > " '`) by `escapeHtml` before injection; no raw-HTML sink exists in the extension.
- **`sessions prune` author-scoping / cross-tenant authz (020a): BROKEN → FIXED.** The daemon prune sub-scoped its destructive tombstone delete beneath the org partition by an `author` taken verbatim from the attacker-controlled `x-honeycomb-actor` header, with no binding to the authenticated identity. In `team`/`hybrid` mode an authenticated org member could tombstone ANOTHER member's traces + paired summaries. Closed with a fail-closed actor-authority gate (local mode unchanged).

**Coverage: FULL.** All four surfaces are in-stack (TS/Node/ESM, daemon HTTP, Deep Lake SQL). No reduced-coverage flag.

**Post-fix gates (all green):**

| Gate | Result |
|---|---|
| `npm run ci` (typecheck + jscpd + vitest) | **0** — 1409 pass / 4 skip / 140 files |
| `npm run build` (`tsc && esbuild`) | **0** — all bundles built @ 0.1.0 |
| `npm run audit:sql` | **OK** — 143 files, every interpolation guarded |
| `npm run audit:openclaw` | **OK** — bundle clean vs ClawHub rules |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `tests/daemon/storage/invariant.test.ts` | **3/3** — no non-daemon root imports `daemon/storage` |
| `tests/daemon/runtime/sessions/prune.test.ts` | **8/8** (4 a-AC-2 + 4 new SEC) |

---

## Findings by severity

| # | Severity | Title | Status |
|---|----------|-------|--------|
| F-1 | **High** | `sessions prune` deletes any author's sessions via spoofable `x-honeycomb-actor` header | **FIXED** |
| F-2 | Medium | Daemon read handlers trust `x-honeycomb-org` header for the partition (no token-claim cross-check) | Documented (systemic, pre-existing) |
| F-3 | Low | `parseSnapshot` / view-model coercion silently swallows malformed data | Documented |

---

## F-1 (HIGH, FIXED) — Cross-actor destructive delete in `sessions prune`

**File:** `src/daemon/runtime/sessions/prune.ts:286` (pre-fix) — the `attachSessionsPrune` DELETE handler.

**Vulnerable pattern (pre-fix):**
```ts
const author = c.req.header("x-honeycomb-actor");   // attacker-controlled
if (author === undefined || author.length === 0) { return c.json(... , 400); }
// ... runPrune(storage, targets, scope, author, filter)  → WHERE author = sLiteral(author)
```

**Exploit.** `sessions prune` is the only NEW destructive endpoint in PRD-020. Its blast radius is sub-scoped *beneath* the org partition by `author`, and `author` is read verbatim from the `x-honeycomb-actor` request header. The daemon's designed tenancy model (PRD-011a, `tenancy-resolution.ts:8-16`) states scope must be resolved "unforgeably — from the token claim... NEVER from a client-supplied header," and `permission.ts` removed the header-asserted-role trust path for exactly this reason. The prune handler bypasses that: in `team`/`hybrid` mode, `permissionMiddleware` authenticates the caller as *a* valid org member but the validated `Identity` is never surfaced to the handler, which then trusts the header actor. An authenticated member of org A can:
```
DELETE /api/diagnostics/sessions/prune?before=2030-01-01
  Authorization: Bearer <my-valid-token>
  x-honeycomb-org: <org A>
  x-honeycomb-actor: <victim's author id>
```
→ the daemon appends `sessions` + paired `memory` TOMBSTONE rows for the victim's sessions, soft-deleting another user's captured traces and summaries. Confirmed: `tests/daemon/runtime/sessions/prune.test.ts` asserted the actor header is *required* but never that it is *bound* to the caller; no actor-vs-identity cross-check exists anywhere in `src/daemon`.

**Severity rationale.** Broken access control on a destructive operation, cross-user within the authenticated org's partition (and, combined with F-2's header-org trust, potentially cross-org). No credential exposure, and the default `local` deployment is single-user (no second author to victimize) — which keeps it High rather than Critical. The PRD explicitly ships `team`/`hybrid` modes, and the handler was fail-OPEN to the header in all modes.

**Remediation (minimal blast radius, AC-preserving).** Added a `PruneActorAuthority` seam consulted ONLY in `team`/`hybrid` mode. Default `denyUnboundActorAuthority` is fail-closed (returns `null` → 403) until the production daemon assembly wires a real actor↔identity binding — so a destructive cross-actor delete cannot ship by default. `local` mode (loopback single-user, no auth) keeps the header actor authoritative, matching the rest of the daemon's local posture, so **a-AC-2 (paired tombstone delete, append-only, fail-closed on missing actor) is unchanged**. Post-fix handler:
```ts
let author = headerActor;
if (daemon.config.mode !== "local") {
  const authorized = actorAuthority.resolveAuthorizedActor(c, headerActor);
  if (authorized === null || authorized.length === 0) {
    return c.json({ error: "forbidden", reason: "actor is not bound to the authenticated caller" }, 403);
  }
  author = authorized;   // the caller's OWN id, never the raw header
}
```

This is the security-stinger "minimal secure wrapper now, document the larger refactor as a follow-up" pattern. The larger refactor — surface the validated `Identity` from `permissionMiddleware` into the Hono context so EVERY handler derives org/actor from the token claim instead of headers — is recommended as a follow-up (see F-2).

**Regression tests (named, `tests/daemon/runtime/sessions/prune.test.ts`):**
- `a-AC-2 SEC team mode DENIES a prune whose x-honeycomb-actor is NOT bound to the caller (fail-closed default)` — asserts 403 AND zero tombstone INSERTs (the destructive write never runs).
- `a-AC-2 SEC team mode prunes ONLY the caller's own bound actor — a spoofed victim author is ignored` — a real authority rebinds the spoofed "victim" header to the caller's own id; the prune runs against the bound caller.
- `a-AC-2 SEC denyUnboundActorAuthority is fail-closed (returns null for any actor)`.
- `a-AC-2 SEC local mode is UNCHANGED — the header actor is authoritative (single-user)` — guards a-AC-2 against regression.

---

## F-2 (MEDIUM, documented — systemic, pre-existing) — Header-trusted org partition

**Files:** `src/daemon/runtime/dashboard/api.ts:76-81`, `src/daemon/runtime/notifications/api.ts:74-82`, and the prune handler — all resolve the org/workspace partition from `x-honeycomb-org` / `x-honeycomb-workspace` request headers, not from the verified token claim.

**Analysis.** Every daemon read handler does this — `capture-handler.ts:194`, `sources/api.ts:69`, `secrets/api.ts:58`, `inference/gateway.ts:534`, and the pre-020 surface — so it is the **established daemon-wide architecture**, NOT a 020 regression. The mitigations in place: (a) the storage `QueryScope` partition is applied beneath the SQL, so an omitted WHERE filter still can't cross a partition; (b) all these groups are `protect: true` (`server.ts:81-90`), so `team`/`hybrid` requires a valid token via `permissionMiddleware`; (c) default mode is `local` (single-user, no second tenant). The gap is that the authenticated token's verified org claim is not cross-checked against the header-supplied org, so a valid org-A member could direct a read at org B's partition by changing the header. PRD-011a designed `resolveRequestTenancy()` precisely to close this, but no runtime handler calls it yet.

**Why Medium not High here:** these are read-only (no destructive effect), gated behind authentication in multi-user mode, and the weakness is inherited from the whole pre-020 read surface — out of 020's minimal blast radius to fix in isolation without a daemon-wide refactor (and without risking the established header-scope convention every handler shares). The dashboard/notifications view-models leak no tokens/secrets (settings returns only org name + mode/port; KPIs/sessions/rules/skills return display fields).

**Recommendation (follow-up, daemon-wide).** Have `permissionMiddleware` set the validated `Identity` into the Hono context (`c.set("identity", …)`) and have all handlers (including 020's three) derive `{ org, workspace, actor }` from it via `resolveRequestTenancy()`, treating headers as a HINT cross-checked against the claim. This single change retires both F-1's interim seam and F-2's header-trust gap for the entire daemon.

---

## F-3 (LOW, documented) — Silent coercion of malformed view data

**File:** `src/daemon/runtime/dashboard/api.ts:253-275` (`parseSnapshot`) and the `toNum`/`toStr` coercions.

Malformed `snapshot_jsonb` (or any non-conforming row field) is silently coerced to empty arrays / empty strings / 0 rather than surfaced. This is intentional fail-soft (a malformed snapshot renders an empty canvas, never a 500) and is not a security defect — noted only because silent swallowing can mask data-integrity drift. No action required; acceptable for a render path.

---

## Category checklist (every catalog item checked)

| Category | Result |
|---|---|
| SQL injection (Deep Lake, missing `sqlIdent`/`sLiteral`) | **None detected.** `audit:sql` OK (143 files). Prune `buildMatchSql`, dashboard, notifications all route every value through `sqlIdent`/`sLiteral`/`sqlStr`; the `clauses.join(" AND ")` prune fragment carries only pre-escaped sub-clauses (genuinely safe, not an audit blind spot — each conjunct is independently escaped before the join). |
| Tombstone marker spoofing / resurrection | **None detected.** Tombstone is append-only with a fixed `TOMBSTONE_MARKER`; the match SELECT excludes `filename = TOMBSTONE_MARKER` (idempotent re-prune); no hard DELETE is ever issued. |
| Paired-delete desync (a-AC-2) | **Safe.** Both `sessions` + `memory` tombstones append per match in one pass; counts asserted equal + non-zero. Fix did not weaken this. |
| Broken access control / cross-tenant | **F-1 (fixed), F-2 (documented).** |
| Webview XSS (020c daemon-served names) | **None detected.** `render.ts escapeHtml` covers all five HTML-significant chars on `kind`/`title`/`rows`; `data-connectivity` is a fixed literal; no `innerHTML` of raw data. Status-bar paint is plain text. |
| Claim lock race / state-file traversal (020d) | **None detected.** `openSync(..,"wx")` is the genuine atomic exclusive-create; `safeClaimSegment` rejects `/`, `\`, `..`, empty; `release` only unlinks the validated in-`claims/` path (never arbitrary); state write is temp-file + atomic `renameSync`. |
| Symlink traversal via hostile skill name (020c) | **None detected (delegated).** Skill sync + hook merge delegate to the 019a `HarnessConnector` (foreign-preserve, `writeJsonIfChanged`, reversible, no-clobber); the extension adds no path computation. 019a path/unlink safety was audited in PRD-019. |
| Bundle self-heal arbitrary-path link (020c) | **None detected.** `selfHeal()` delegates to the 019a connector; no attacker-path sink in the extension shell. |
| `healDriftedOrgToken` JWT trust / org escalation | **None detected.** `status.ts` delegates to 011b `healOrgDrift` via a seam; it decodes via `verifyTokenClaims` and never re-mints to an attacker-chosen org; the result is printed to stdout only (not SQL/HTML). |
| Credential file modes (0600) | **Verified by contract.** Login writes `~/.honeycomb/credentials.json`; `CREDENTIALS_FILE_MODE` = 0o600 (c-AC-5); covered by existing 011b/020c tests. |
| Token/PII in logs | **None detected.** No `console`/logger call in any 020 surface receives a token/secret/PII; SDK attaches the bearer only on loopback/HTTPS (`isTokenTransportSafe`), redaction in `client.ts`. |
| Thin-client invariant (no DeepLake outside daemon) | **Verified.** `invariant.test.ts` 3/3; `src/commands`, `src/dashboard`, `src/notifications`, `harnesses/cursor/extension` import nothing from `daemon/storage` except pure `sql.js`. |
| Supply chain / dependencies | **Clean.** `npm audit --omit=dev` 0; `audit:openclaw` OK; no new deps in 020 surfaces. |

---

## Files changed (this audit)

- `src/daemon/runtime/sessions/prune.ts` — added `PruneActorAuthority` seam + `denyUnboundActorAuthority` fail-closed default + the mode-gated actor-binding block in `attachSessionsPrune`. No change to the paired-delete / tombstone / `buildMatchSql` logic.
- `tests/daemon/runtime/sessions/prune.test.ts` — added the 4 named `a-AC-2 SEC …` regression tests + their imports.

No `git add` / commit / push performed (per instruction). The full PRD-020 implementation remains untracked in the working tree (Wave-2 landed but uncommitted); `git diff` shows only the pre-existing Wave-2 tracked-file rewires, not unintended changes from this audit.

---

## VERDICT

**PASS-WITH-FIXES.**

- **Counts:** Critical 0 · High 1 (fixed) · Medium 2 (documented) · Low 1 (documented).
- **Fixed in-session:** F-1 cross-actor destructive prune — `src/daemon/runtime/sessions/prune.ts`, regression tests `a-AC-2 SEC team mode DENIES…`, `a-AC-2 SEC team mode prunes ONLY the caller's own bound actor…`, `a-AC-2 SEC denyUnboundActorAuthority is fail-closed…`, `a-AC-2 SEC local mode is UNCHANGED…`.
- **Post-fix gate exit codes:** `npm run ci` 0 (1409 pass/4 skip) · `npm run build` 0 · `npm run audit:sql` OK · `npm run audit:openclaw` OK · `npm audit --omit=dev` 0 · `invariant.test.ts` 3/3 · prune suite 8/8.
- **No AC weakened.** a-AC-2 guarded by an explicit local-mode-unchanged regression test.

**`quality-worker-bee` is CLEARED to run.**
