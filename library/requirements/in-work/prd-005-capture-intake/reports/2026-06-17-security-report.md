# Security Audit — PRD-005 Capture Intake

- **Date:** 2026-06-17
- **Auditor:** security-worker-bee (security-stinger)
- **Branch:** `prd-005-capture-intake`
- **Scope:** the captured-trace / PII surface introduced by PRD-005 (capture writes user prompt content + tool I/O to the `sessions` table on the critical path of every turn).
- **Position in run:** penultimate step of /the-smoker; runs **before** `quality-worker-bee`.

## Executive Summary

PRD-005's capture intake surface is **well-built for its highest-stakes risks**. SQL injection via attacker-controllable prompt/tool content is **closed by construction**: every interpolation in the `sessions` INSERT and the `message_embedding` attach UPDATE routes through the typed `val.*` → `renderValue` → `eLiteral`/`sLiteral`/`sqlIdent` path, the `audit:sql` CI gate covers `src/daemon` (verified to catch both raw-interpolation and concat bypasses on this path), and an adversarial round-trip of nine payloads (`'); DROP TABLE sessions; --`, quote/backslash/NUL/control/Unicode, the full serialized JSONB envelope) collapses every one to an inert literal. Tenant isolation on the read-back rejects unscoped reads (400) and scopes by the requester's org/workspace. Capture logging does **not** emit message bodies, tokens, or the embed text. The zod boundary rejects malformed events before any SQL is built. The embed dim-guard rejects non-768 vectors twice (client + attacher), and a malformed embed response cannot inject into the UPDATE (finite-number-only parse + `String(n)` serialization).

**One High finding was remediated in place:** the per-turn counter map (`turn-counters.ts`) was an **unbounded in-memory `Map` keyed by attacker-controllable `sessionId`** — a memory-exhaustion DoS on the always-on capture hot path. Fixed with a hard cap (`DEFAULT_MAX_SESSIONS = 50_000`) and FIFO eviction, plus four regression tests. No Critical findings. No unresolved Critical/High. All gates green; live capture test passes.

**Ordering:** No QA report exists for `prd-005-capture-intake` (its `reports/` dir was created by this audit). Ordering is intact — `quality-worker-bee` has not run for this PRD. (PRD-004's QA report at `prd-004-daemon-runtime/reports/` is a different PRD and does not gate this one.)

**Wiring note (not a vulnerability):** `createCaptureHandler` / `createEmbedAttachment` are not yet referenced by the daemon bootstrap (`server.ts`) — PRD-005 ships the modules + tests; runtime wiring lands later. The findings below are in the shipped code regardless of current wiring; the DoS was fixed now, before wiring, which is the correct time.

## Findings Table

| ID | Severity | File:Line | Issue | Status |
|----|----------|-----------|-------|--------|
| S-1 | **High** | `src/daemon/runtime/capture/turn-counters.ts:71` (pre-fix) | Unbounded per-session `Map` keyed by attacker-controllable `sessionId` → memory-exhaustion DoS on the always-on capture path; no cap/TTL/eviction (cf. the TTL-bounded claim map in `runtime-path.ts`). | **FIXED** |
| S-2 | Medium | `src/daemon/runtime/services/embed-client.ts:166,246` | Embed daemon URL (`HONEYCOMB_EMBED_URL`) is interpolated into `fetch(\`${url}/embed\`)` and the **full captured text** is POSTed to it. SSRF/exfiltration only if an attacker can set the env var (operator config, default loopback) — not request-controllable. | RECOMMENDED |
| S-3 | Medium | `src/daemon/storage/transport.ts:83` | `workspace` is interpolated raw into the DeepLake URL path (`/workspaces/${req.workspace}/tables/query`) with no `sqlIdent`-style validation. Sourced from `x-honeycomb-workspace`. PRD-002a/004a surface, not PRD-005, but reachable via the capture scope. | RECOMMENDED |
| S-4 | Medium (PRD-004 surface) | `src/daemon/runtime/middleware/permission.ts:54-75` | Tenancy (`x-honeycomb-org`/`workspace`) is **caller-asserted** and the only enforcement is `defaultDenyPermissionCheck` (a stub) — bypassed entirely in `local` mode; no real policy in team/hybrid. Capture trusts these headers for tenancy. Explicitly out of scope for 004a ("auth policy out of scope"). | ACCEPTED-RISK (PRD-004 follow-up) |
| S-5 | Info / None | capture + embed logging (`capture-handler.ts:168,203,293`; `embed-client.ts:254-324`) | Checked: logging emits only `{ id, kind, path, reason, status, dim }` — **no message body, no token, no embed text, no vector**. Errors do not echo captured content. | None detected |
| S-6 | Info / None | `npm audit --omit=dev --audit-level=high` | 0 production vulnerabilities. | None detected |

## Critical / High Detail

### S-1 (High → FIXED): Unbounded counter-map memory-exhaustion DoS

**Vulnerability.** `TurnCounters.counts: Map<string, SessionCounts>` (turn-counters.ts) created a permanent entry per distinct `sessionId` with **no cap, TTL, or eviction**. `sessionId` is validated only as a `nonEmpty` string (`event-contract.ts`) and is attacker-controllable request metadata. The capture handler calls `bumpCounters(metadata)` for **every accepted event** (`capture-handler.ts:173`). An attacker reaching `/api/hooks/capture` can stream unbounded distinct `sessionId` values, growing the map without bound until the daemon OOMs. The module's own doc acknowledged the in-memory map but addressed only daemon-restart reset — not unbounded growth. The sibling claim map in `runtime-path.ts` is explicitly TTL-bounded + swept; this map had no equivalent guard.

**Fix.** Added `DEFAULT_MAX_SESSIONS = 50_000` and a `maxSessions` config knob (clamped `>= 1` so a misconfig can never disable tracking). `entry()` now evicts the oldest-inserted session (FIFO via `Map` insertion order) before recording a new one when at capacity. Safe because counters are an optimization, not a correctness invariant (cues also fire on the workers' own cadence) — at worst eviction delays one cue for a long-idle session. Added a `size()` accessor for visibility/tests.

**Proof.** New regression tests in `tests/daemon/runtime/capture/turn-counters.test.ts`:
- caps distinct sessions at `maxSessions` after streaming 1000 ids → `size() === 3`;
- evicts oldest-first (FIFO) on overflow;
- re-touching existing sessions never evicts (no churn);
- a non-positive cap falls back to the safe default (tracking still works).

```
npx vitest run turn-counters.test.ts → 8 passed (4 original + 4 new)
npm run ci                           → 24 files, 286 passed; audit:sql OK; exit 0
```

## SSRF / Embed-URL Assessment (S-2)

`DaemonEmbedClient.embed()` POSTs `{ text }` — the captured prompt/tool content — to `${HONEYCOMB_EMBED_URL}/embed`. The URL comes **only** from `resolveEmbedClientOptions(process.env)`; it is never derived from request input or captured content, and defaults to `http://127.0.0.1:3851`. Pointing it at an attacker endpoint to exfiltrate captured content requires environment-write access, i.e. an already-compromised host — the standard posture for a daemon-side outbound URL. **Not Critical/High** (not request-controllable). **Recommendation:** defense-in-depth — validate the resolved URL's scheme (`http`/`https` only) and consider pinning to loopback unless an explicit `HONEYCOMB_EMBED_ALLOW_REMOTE`-style opt-in is set, so a stray/misconfigured env var cannot silently ship every captured turn off-box.

## Unbounded-Map DoS (S-1) — covered above. The only memory-growth vector on the capture path; now bounded.

## SQL-Injection-via-Prompt Verification (primary focus)

Adversarial round-trip against the real `src/daemon/storage/sql.ts` helpers (transient script, removed after run): every payload — `'); DROP TABLE sessions; --`, `a' OR '1'='1`, backslash/quote combinations, embedded NUL + BEL + ESC controls, `E'` nested-escape attempt, `%_` wildcards, and the **full serialized JSONB envelope** `{"event":{"kind":"user_message","text":"'); DROP TABLE sessions; --"}}` — produced a structurally inert literal: every `'` doubled, every `\` doubled (E'...' safe), NUL/control bytes stripped. `ALL_SAFE: true`.

The capture INSERT builds `message` via `val.text(JSON.stringify({event, metadata}))` → `renderValue` → `eLiteral` (`capture-handler.ts:227,234`). The embed attach UPDATE builds the vector via `serializeFloat4Array` (finite-number-only `String(n)`, no metacharacters) and the id via `sLiteral` (`embed-client.ts:314-319`). `audit:sql` was adversarially tested: a synthetic raw-interpolation INSERT and a concat `WHERE path = '` + path + `'` in `src/daemon` were **both flagged** (exit 1). The gate genuinely covers this path.

```
node scripts/audit-sql-safety.mjs → scanned 35 files under src/daemon/; OK; exit 0
```

## Gate Results

| Gate | Result |
|------|--------|
| `npm run ci` (typecheck + dup + vitest + audit:sql) | **exit 0** — 24 files, **286 tests passed** |
| `npm run build` (tsc + esbuild) | **exit 0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon bundle |
| `npm run audit:openclaw` | **exit 0** — clean against ClawHub rules |
| `npm run audit:sql` | **exit 0** — every interpolation routed through a helper |
| `npm audit --omit=dev --audit-level=high` | **exit 0** — 0 vulnerabilities |
| Live capture itest (`capture-sessions-live.itest.ts`, real DeepLake) | **exit 0** — POST capture → one real `sessions` row written + read back by path; 7/7 integration tests passed |

## Recommended Follow-Ups (non-blocking)

1. **S-2:** validate `HONEYCOMB_EMBED_URL` scheme + consider loopback-pin-unless-opt-in (captured content leaves the box via this POST).
2. **S-3:** route `workspace` through an identifier validator before it enters the DeepLake URL path (PRD-002a/004a owner).
3. **S-4:** the real auth policy (replacing `defaultDenyPermissionCheck`) must authenticate that the caller owns the asserted `x-honeycomb-org`/`workspace` before capture is wired live — tenancy is currently caller-asserted (PRD-004 follow-up; flag to `quality-worker-bee` and the auth-module owner).

## Unresolved Critical / High

**None.** The single High (S-1) is fixed and proven. Nothing blocks the run.
