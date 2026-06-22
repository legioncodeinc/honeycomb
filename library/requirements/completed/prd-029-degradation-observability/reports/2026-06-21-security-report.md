# PRD-029 Degradation Observability — Security Close-Out Report

- **Date:** 2026-06-21
- **Branch:** `prd-029-degradation-observability`
- **Auditor:** security-worker-bee (security-stinger)
- **Scope:** ONLY the PRD-029 change set (degradation observability — surface latent signals to `/health` + structured logs + dashboard). No fix to the degradations themselves; the PRD makes them VISIBLE.
- **Lenses:** OWASP A01 (broken access control / internal-topology exposure) + A09 (security logging / leakage). AI-code failure catalog + captured-trace PII/credential catalog applied to the new fields.

## Verdict

**PASS — clean. Zero findings at any severity. No remediation required.** The two load-bearing security properties hold by construction and are test-proven: (1) AC-3 mode-gating leaks NO internal subsystem topology to an unauthenticated remote in team/hybrid — the public `/health` returns the coarse bit only and the full `reasons` ride the already-`protect:true` `/api/diagnostics` group; (2) AC-5 no-secret — every new health field, log field, and rendered badge is a closed string-literal enum or a fixed arm-name set, so a token/org-GUID/header/credential cannot be carried by construction. All deterministic gates green (`audit:sql`, `audit:openclaw`, typecheck), 70/70 PRD-029 unit/DOM tests pass, no new dependency, test diffs purely additive (no AC/test weakened).

## Change set audited

New: `src/daemon/runtime/health.ts`, `src/daemon/runtime/diagnostics-health.ts`, `tests/daemon/runtime/health.test.ts`.
Modified: `src/daemon/runtime/{assemble.ts, server.ts, logger.ts, memories/api.ts, memories/index.ts}`, `src/dashboard/web/{app.tsx, wire.ts}`, `tests/daemon/runtime/assemble.test.ts`, `tests/dashboard/web/{app.test.tsx, wire.test.ts}`. No `package.json`/`package-lock.json` change (no new dep).

## AC-3 mode-gating leak analysis (the security crux) — NO LEAK PATH EXISTS

Traced every path by which an unauthenticated remote could obtain `reasons` (storage/embeddings/schema topology) in `team`/`hybrid`:

1. **Public `GET /health`** (`server.ts:313-335`, route is `protect:false` per FR-3, server.ts:72). The body's `reasons` is gated by exactly one expression:
   `const detail = healthDetail !== undefined ? publicHealthDetail(healthDetail(), config.mode) : undefined;`
   and spread only via `...(detail?.reasons !== undefined ? { reasons: detail.reasons } : {})`.
   `publicHealthDetail(detail, mode)` (`health.ts:123-127`) returns the full detail **only** when `mode === "local"`; for **every** non-local mode (team, hybrid, any other) it returns `{ status: detail.status }` — `reasons` stripped. Therefore in team/hybrid the public body is `{status, uptimeMs, version, pipeline}` only — coarse liveness, **no topology**. Confirmed for authenticated AND unauthenticated callers alike (the gate keys off mode, not identity).

2. **`config.mode` is unspoofable.** It is the daemon's resolved `RuntimeConfig["mode"]`, parsed server-side from `HONEYCOMB_MODE` via zod with `.default("local")` (`config.ts:71`). It is **not** read from any request header. No `c.req.header(...)` feeds the gate. A remote cannot flip the daemon to `local` to unlock `reasons`.

3. **Protected detail surface `GET /api/diagnostics/health`** (`diagnostics-health.ts`). It attaches via `daemon.group("/api/diagnostics")` onto the route group declared `{ path: "/api/diagnostics", protect: true }` (`server.ts:92`). The composition root mounts `mountPermission("/api/diagnostics")` ahead of it (`server.ts:297-304`), so the handler inherits the same auth/RBAC the dashboard JSON views enforce: **open in local** (single-user loopback by design), **gated in team/hybrid**. An unauthenticated team/hybrid remote hitting this route is rejected by the group middleware before the handler runs — it never reaches `c.json(options.healthDetail())`. The handler reads an injected thunk, not `c.req`, so there is no header/identity surface inside it either.

**Conclusion:** the only two surfaces that can emit `reasons` are (a) the mode-gated public `/health`, which emits them solely in local, and (b) the protected diagnostics route, which is auth-gated in team/hybrid. There is **no code path** where an unauthenticated remote in team/hybrid obtains subsystem `reasons`. AC-3 holds.

## AC-5 no-secret analysis — secret-free BY CONSTRUCTION

- **`HealthReasons`/`HealthDetail`** (`health.ts:57-78`) are closed string-literal enums: `storage: "reachable"|"unreachable"`, `embeddings: "on"|"off"`, `schema: "ok"|"missing_table"`, `status: "ok"|"degraded"|"unconfigured"`. A value cannot carry a free-text/credential string. `buildHealthDetail` maps cached bits onto these literals; no input string is ever echoed. Grep of `health.ts`/`diagnostics-health.ts` for token/header/credential/`c.req.header` matched only doc-comment text — zero code reads.
- **`recall.degraded` log line** (`memories/api.ts:185-200`, `logDegradedRecall`) forwards exactly two fields: `mode: "lexical_fallback"` (fixed literal) and `sources: result.sources`. `RecallSource` is the closed 3-value enum `"memories" | "memory" | "sessions"` (`recall.ts:111`) — pure arm names, never query text, row content, token, org, or header. A non-degraded recall logs nothing.
- **Logger event ring buffer** (`logger.ts:82-113`). The new `event(name, fields)` sink pushes `{time, event, fields}` into a **separate** buffer (the per-request `recent()` snapshot is untouched). It captures only what the caller passes; it does **not** read the request, headers, or auth context. The PRD-029 caller passes only the two closed fields above. (Other pre-existing `.event()` callers across the codebase likewise pass coarse ids/counts/reasons — none feed a header.)
- **Dashboard badge + strip** (`app.tsx` `LexicalFallbackBadge`, `HealthStrip`) render subsystem NAMES + closed-enum STATES as React text children (auto-escaped; no `dangerouslySetInnerHTML`). No token/org/header in the rendered payload.

## General hardening checks

- **No attacker-controlled SQL/identifier** in the new `/api/diagnostics/health` handler — it returns a synchronous read of cached state (the `healthDetail` thunk); no query, no table name, no `SELECT`. `audit:sql` scanned 172 files: every interpolation routes through an escaping helper — OK.
- **Dashboard `wire.ts` parse is defensive (A03/AI-code IO-boundary discipline).** `health()` wraps `res.json()` in try/catch, `safeParse`s `HealthBodySchema`, and every `reasons` field `.catch()`es to its healthy default. A malformed/partial/non-JSON `/health` body degrades to `null` reasons (coarse pill only) — never a throw into React, never an injection. An unknown future enum value also `.catch()`es safely.
- **No new dependency.** `package.json`/`package-lock.json` are not in the change set; the npm supply chain is unchanged.

## Gate results

| Gate | Result |
|------|--------|
| `npm run audit:sql` | OK — 172 files, every SQL interpolation escaped |
| `npm run audit:openclaw` | OK — bundle clean against ClawHub static rules |
| `npx tsc --noEmit` (typecheck) | PASS — no errors |
| PRD-029 unit/DOM tests (health/assemble/wire/app) | 70/70 PASS |
| `npm audit` | 10 pre-existing dev-dep advisories (esbuild dev-server, tmp symlink) — **out of scope**: no dep added by PRD-029, unchanged by this branch; belongs to dependency-audit-worker-bee |
| Test-diff integrity | Additive only (197 insertions, 2 non-assertion deletions); no AC/test weakened |
| New-file git tracking | `health.ts`, `diagnostics-health.ts`, `health.test.ts` all tracked (not gitignore-swallowed) |

## Findings by severity

- **Critical:** None detected.
- **High:** None detected.
- **Medium:** None detected.
- **Low:** None detected.
- **Informational:** None requiring action. (Pre-existing `npm audit` dev-dep advisories noted above are out of PRD-029 scope.)

## Discipline confirmation

No AC or test weakened. No `git add` performed. No file outside the PRD-029 change set modified. No new dependency introduced.
