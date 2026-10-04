# PRD-029 Degradation Observability — Security RE-CONFIRMATION (close-out)

- **Date:** 2026-06-22
- **Branch:** `main` (reconciliation / close-out — code already shipped)
- **Auditor:** security-worker-bee (security-stinger)
- **Prior report:** `reports/2026-06-21-security-report.md` (PASS, zero findings). This report RE-CONFIRMS that verdict against current `main` rather than trusting it.
- **Scope:** ONLY the PRD-029 change set — richer `/health` detail, the dashboard health-strip + lexical-fallback badge, and the `recall.degraded` structured log. The two load-bearing concerns: AC-5/D-5 (no-secret) and D-2/AC-3 (mode-gated topology).
- **Ordering:** no `quality-worker-bee` report exists for PRD-029; no ordering inversion. QA may run after this report.

## Verdict

**PASS — RE-CONFIRMED clean on current `main`. Zero findings at any severity. No remediation required.** Both load-bearing properties still hold, verified by re-reading the actual source (not the prior report):

1. **Mode-gated topology (D-2 / AC-3)** — the PUBLIC `/health` returns the coarse bit ONLY in team/hybrid; the full `reasons` topology is exposed only in `local` `/health` (loopback) and on the protected `/api/diagnostics/health`. No internal subsystem map leaks to an unauthenticated remote.
2. **No-secret (AC-5 / D-5)** — every new `/health` field, the degraded badge payload, and the `recall.degraded` log line carry subsystem NAMES + closed-enum STATES only — never a token, endpoint credential, full org GUID, or header value.

`npm run ci` (typecheck + jscpd + 2325 vitest tests + `audit:sql`) is fully green. No code change — the property holds by construction, so there is nothing to fix.

## Mode-gating re-verification (the security crux) — STILL NO LEAK PATH

Re-traced the exact code on current `main`:

1. **Public `GET /health`** (`server.ts:315-337`, route `protect:false` per `server.ts:72`). The `reasons` block is gated by exactly one expression:
   `const detail = healthDetail !== undefined ? publicHealthDetail(healthDetail(), config.mode) : undefined;` (`server.ts:326`)
   and spread only via `...(detail?.reasons !== undefined ? { reasons: detail.reasons } : {})` (`server.ts:333`).
   `publicHealthDetail(detail, mode)` (`health.ts:123-127`) returns the full detail **only** when `mode === "local"`; for every non-local mode it returns `{ status: detail.status }` — `reasons` stripped. So in team/hybrid the public body is `{status, uptimeMs, version, pipeline}` only — coarse liveness, NO topology. The gate keys off mode, not identity, so it holds for authenticated and unauthenticated callers alike.
2. **`config.mode` is unspoofable.** It is the daemon's server-resolved `RuntimeConfig["mode"]`, parsed from `HONEYCOMB_MODE` via zod `.default("local")` (`config.ts:71`, env read at `config.ts:124`). It is NOT read from any request header — no `c.req.header(...)` feeds the gate. A remote cannot flip the daemon to `local` to unlock `reasons`.
3. **Protected detail `GET /api/diagnostics/health`** (`diagnostics-health.ts:63-73`) attaches onto `daemon.group("/api/diagnostics")`, whose group spec is `{ path: "/api/diagnostics", protect: true }` (`server.ts:94`). The composition root mounts permission middleware ahead of the group, so the handler inherits the same auth/RBAC the dashboard JSON views enforce — open in local, gated in team/hybrid. An unauthenticated team/hybrid remote is rejected before the handler runs; the handler reads an injected thunk, not `c.req`, so there is no header/identity surface inside it.

**Conclusion:** the only two surfaces that can emit `reasons` are the mode-gated public `/health` (local only) and the auth-gated protected route. No code path lets an unauthenticated remote in team/hybrid obtain subsystem `reasons`. AC-3 holds.

## No-secret re-verification — SECRET-FREE BY CONSTRUCTION

- **`HealthReasons` / `HealthDetail`** (`health.ts:57-78`) are closed string-literal enums: `storage: "reachable"|"unreachable"`, `embeddings: "on"|"off"`, `schema: "ok"|"missing_table"`, `status: "ok"|"degraded"|"unconfigured"`. A value cannot carry a free-text/credential string. `buildHealthDetail` (`health.ts:104-111`) maps cached bits onto these literals; no input string is echoed. The thunk is wired in `assemble.ts:1026` from `healthBit` + `embeddingsEnabled` only — no header, no org, no token.
- **`recall.degraded` log line** (`memories/api.ts:193-201`, `logDegradedRecall`) forwards exactly two fields: `mode: "lexical_fallback"` (fixed literal) and `sources: result.sources`. `RecallSource` is the closed 3-value enum `"memories" | "memory" | "sessions"` (`recall.ts:111`) — pure arm names, never query text, row content, token, org, or header. A non-degraded recall logs nothing (`api.ts:194` early-returns on `!result.degraded`).
- **Dashboard badge + strip** render subsystem NAMES + closed-enum STATES as auto-escaped React text children (no `dangerouslySetInnerHTML`). No token/org/header in the rendered payload.

## General hardening checks

- **No attacker-controlled SQL** in the `/api/diagnostics/health` handler — it returns a synchronous read of cached state (the `healthDetail` thunk); no query, no table name. `audit:sql` scanned 197 files: every interpolation routes through an escaping helper — OK.
- **No new dependency.** No `package.json`/`package-lock.json` change in this surface.

## Gate results

| Gate | Result |
|------|--------|
| `npm run typecheck` (tsc --noEmit) | PASS — no errors |
| `npm run dup` (jscpd) | PASS — under threshold |
| `npm run test` (vitest) | 2325 passed, 6 skipped (creds-gated live itests) — 213 test files |
| `npm run audit:sql` | OK — 197 files, every SQL interpolation escaped |
| `git status` | No code change from this audit (re-confirmation only) |

## Findings by severity

- **Critical:** None detected.
- **High:** None detected.
- **Medium:** None detected.
- **Low:** None detected.
- **Informational:** None requiring action. (Pre-existing dev-dep `npm audit` advisories are out of PRD-029 scope — no dependency added by this surface; they belong to dependency-audit-worker-bee.)

## Discipline confirmation

The prior 2026-06-21 PASS verdict is RE-CONFIRMED on current `main` by re-reading the source. No AC or test weakened. No `git add` performed. No source file modified (nothing was vulnerable). No new dependency introduced.
