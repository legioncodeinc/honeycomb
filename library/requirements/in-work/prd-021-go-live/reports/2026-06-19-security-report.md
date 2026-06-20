# Security Audit — PRD-021 "Go-Live: Runtime Assembly & Dogfood"

- **Branch:** `prd-021-go-live`
- **Date:** 2026-06-19
- **Auditor:** security-worker-bee (Opus)
- **Scope:** The new go-live running-process attack surface — daemon lifecycle/process control (021a/b), loopback credential path (021b/c), live-log surface (021d), served dashboard host (021d), MCP served endpoint (021e), daemon-only invariant.
- **Ordering:** Ran BEFORE quality-worker-bee. Verified no QA report exists for prd-021 (`library/requirements/in-work/prd-021-go-live/reports/` contains only `README.md`). Ordering is clean.

## Executive Summary

**VERDICT: PASS-WITH-FIXES** — but the only "fix" is documentation: **no code change was required and none was made** (working tree contains only the pre-existing PRD-021 implementation, never an edit from this audit). The three highest-value go-live concerns — the **0.0.0.0-vs-127.0.0.1 bind**, the **/api/logs token-leak**, and the **served-dashboard XSS/authz** — were each proven safe or reduced to a latent, dormant, accepted-risk Medium.

The audit produced **0 Critical, 0 High, 1 Medium (documented, latent/not-yet-wired), 2 Low/Informational (accepted-risk, pre-existing & explicitly deferred by D-3)**. No AC was weakened. Coverage is FULL (no reduced-coverage flag).

### Severity counts

| Severity | Count | Disposition |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | Documented (latent — route not wired into the production composition root) |
| Low / Informational | 2 | Accepted-risk; pre-existing & explicitly deferred (D-3 separate ticket) |

## The three highest-value proofs

### 1. Bind safety (0.0.0.0 vs 127.0.0.1) — PROVEN SAFE

- `src/daemon/runtime/config.ts:31,67` — default host is `DAEMON_HOST` = `127.0.0.1`; the `Port` schema clamps `0`→`1` (config.ts:37-44) so the daemon can never silently land on an OS-picked ephemeral/wildcard port. `0.0.0.0` is reachable ONLY via the explicit `HONEYCOMB_BIND` widening knob, which sets `widened: true` (a-AC-7) for diagnostics.
- `src/daemon/runtime/listen.ts:49-54` — `serve({ hostname: daemon.config.host, ... })` binds the resolved config host verbatim. No hardcoded `0.0.0.0` anywhere in the assemble→listen path.
- `src/daemon/runtime/assemble.ts:331` — `assembleDaemon` resolves config from `resolveRuntimeConfig()` (fail-closed) and passes it straight through; it does not override the host.
- **MCP HTTP transport** `mcp/src/transports.ts:235` — `server.listen(port, DAEMON_HOST, ...)` is hardcoded to `127.0.0.1`, with no widening knob. Non-`/mcp` paths → 404 (transports.ts:217-220).
- **Verdict:** loopback-by-default holds end to end. Widening off loopback is an explicit, recorded operator opt-in. **SAFE.**

### 2. /api/logs token-leak — PROVEN SAFE

- `src/daemon/runtime/logger.ts:20-37` — `RequestLogRecord` is a CLOSED shape: `time, method, path (no query string), status, durationMs, mode, org?, workspace?`. No header, no `Authorization`, no bearer token, no request body field exists on the type.
- `src/daemon/runtime/server.ts:236-249` — the request-logging middleware constructs each record from exactly those fields; `org`/`workspace` come from `x-honeycomb-org`/`x-honeycomb-workspace` headers (tenancy ids, never the token).
- `src/daemon/runtime/logs/api.ts:109-114,178` — `/api/logs` (JSON) and `/api/logs/stream` (SSE) return `RequestLogRecord`s VERBATIM; the handler adds no field and has no access to headers/body. `?limit=` is clamped to `[1,1000]` (api.ts:85-90) — no unbounded page.
- **Authz:** `server.ts:96` — `/api/logs` is `{ protect: true }`, so it sits behind `permissionMiddleware` (team/hybrid enforce; local open per D-3).
- **Verdict:** the payload provably cannot carry a token/secret, and the route is protected in multi-tenant modes. **SAFE.** (Matches the f-AC-4 "no-secret floor" the golden-path itest already asserts.)

### 3. Served-dashboard XSS / authz — XSS PROVEN SAFE; authz = latent Medium (see F-1)

- **XSS — SAFE.** `src/dashboard/html.ts:42-59,88-110` — `renderDashboardPage` → `serializeBlock` routes EVERY attacker-influenceable sink through `escapePageHtml` (escapes `& < > " '`): `block.kind`, `block.title`, and every `row` (session names, rule text, project paths, skill names all arrive as `rows`/`title`). The only un-escaped interpolation is `data-connectivity="${reachable ? "reachable" : "unreachable"}"` — a hardcoded boolean-driven literal, not data. The live-log slot is a static element id. No `innerHTML`-style sink receives raw tenant data. **No XSS.**
- **Authz — see Finding F-1 below.**

## Findings

### F-1 (MEDIUM, documented) — `/dashboard` HTML host is unprotected by design, but is NOT wired into the production composition root (latent)

- **Location:** `src/daemon/runtime/dashboard/host.ts:57-58,133-151`; route group `src/daemon/runtime/server.ts:100` (`{ path: "/", protect: false }`).
- **What:** `mountDashboardHost` attaches `GET /dashboard` onto the root group, which carries NO permission middleware. The route renders the six live view-models (KPIs, sessions, rules, skills, settings, graph) for the env-resolved scope. The module's own doc-comment (host.ts:133-135) acknowledges "The route is unprotected … `local` single-user loopback is the dogfood target (D-3)."
- **Exploit (conditional):** IF this route were wired and the daemon ran in `team`/`hybrid` mode OR were bound off-loopback via `HONEYCOMB_BIND=0.0.0.0`, an unauthenticated caller reaching `GET /dashboard` would receive another tenant's KPIs/sessions/rules HTML with no auth check — a tenancy/authz bypass on the HTML surface (the JSON `/api/kpis` etc. ARE `protect:true`; only the HTML host route bypasses).
- **Why MEDIUM, not High:** the exposure is **latent**. `assembleDaemon` (`src/daemon/runtime/assemble.ts:54-57,127-132,297-320`) fires ONLY `attachHooks` / `mountDashboardApi` / `mountNotifications` / `attachPrune`. **`mountDashboardHost` and `mountLogsApi` are NOT imported or called by the production composition root** — they are fired only in integration tests (`tests/integration/dashboard-logs-live.itest.ts`, `golden-path-live.itest.ts`). In the assembled production daemon today, `GET /dashboard` does not exist (it falls through to the root 501/404 scaffold). The defect ships in code but is not reachable in the running process. Default bind is loopback and the dogfood target is `local` single-user (D-3), further narrowing real-world exposure even once wired.
- **Why not fixed in-session:** wiring `/dashboard` correctly is coupled to the daemon-wide `x-honeycomb-org` header-trust hardening that D-3 explicitly defers to a **separate ticket** ("the broader 'surface Identity to handlers' refactor"). A drive-by `protect:false`→`protect:true` flip on the root group would (a) break the legitimately-unprotected root behavior and (b) still leave the header-trust tenancy question open — it is not a clean <5-line minimal-blast-radius fix, and the route is not live, so shipping it does not expose the vulnerability.
- **Required remediation (for the wiring wave / the D-3 follow-up ticket):** when `mountDashboardHost` is finally fired by the production assembly, EITHER (a) mount it on a `protect:true` group (give it its own protected route group rather than the unprotected `/` root) so it inherits the same auth the JSON `/api/kpis` views already enforce, OR (b) gate it behind an explicit `local`-mode-only guard so the HTML host is never reachable in `team`/`hybrid`. Do the same review for `mountLogsApi` at wire-time (its `/api/logs` group is already `protect:true`, so it is fine — just confirm at wiring).
- **`NEEDS HUMAN REVIEW`:** confirm the intended wiring wave (021f / a later go-live wave) carries this constraint before `/dashboard` is exposed.

### F-2 (LOW / Informational, accepted-risk, pre-existing) — local-mode header-trust: a local process can forge `x-honeycomb-org`

- **Location:** `src/daemon/runtime/middleware/permission.ts:152-156` (`local` → open `next()`), tenancy read at `server.ts:246-247,325-326`.
- **What:** in `local` mode the permission middleware is fully open and the daemon reads `x-honeycomb-org`/`x-honeycomb-workspace` as the request scope with no cross-check. Any local process able to reach `127.0.0.1:3850` can stamp arbitrary tenancy headers and read/write another org's partition.
- **Disposition:** this is the **known, documented, explicitly-deferred** D-3 trust model + the "daemon-wide `x-honeycomb-org` header-trust" caveat carried as a separate ticket in the ledger. My directive was to confirm it is **not WIDENED** by 021 — it is not: 021 introduces no new header-trust path; `local`-mode openness is unchanged from PRD-011, and the new loopback clients (CLI `tenancyHeaders`, hook `DaemonHookClient`) only stamp the SAME ids the credential file already holds. **Accepted-risk, unchanged. No action this audit.**

### F-3 (LOW / Informational) — PID/lock acquire is read-then-write, not atomic exclusive-create (TOCTOU window)

- **Location:** `src/daemon/runtime/assemble.ts:200-217` (`acquireSingleInstanceLock`).
- **What:** the single-instance guard reads the existing lock, checks PID liveness, then `writeFileSync` (truncating) — not an atomic `wx` exclusive create. Two daemon starts racing on the same user/dir within the read→write window could both proceed past the guard; the OS socket bind (`EADDRINUSE`) is the real backstop that prevents an actual double-bind (listen.ts:62-72 surfaces it loudly and rolls back).
- **Why LOW:** the lock path is fixed (`~/.honeycomb/daemon.lock`, not attacker-influenced), under `DIR_MODE` perms; content is a bare PID integer (no traversal/symlink-write primitive); the attacker would need local same-user code execution AND a precise race, and the bind backstop fails closed. No arbitrary file read/write, no DoS beyond a losing start erroring out. Stale-lock reclaim correctly uses `process.kill(pid,0)` liveness (assemble.ts:177-190). Noted as a hardening opportunity (use `{ flag: "wx" }` / open-exclusive), not a release blocker.

## Surfaces proven safe (no finding)

| Surface | File:line | Result |
|---|---|---|
| Detached daemon spawn — no shell injection | `src/cli/runtime.ts:154-160` | `spawn(process.execPath, [entry], { detached, stdio:"ignore", env })` — shell:false, args arrayed, no shell-string interpolation; binary is the node execPath (not PATH-resolved name); `entry` is a resolved internal path / operator env override. SAFE. |
| Loopback CLI client — token never on the wire | `src/cli/runtime.ts:82-90`, `src/commands/contracts.ts:260-296` | Stamps only `x-honeycomb-org/workspace/actor`; NO `Authorization`/bearer header ever set. Token stays in `~/.honeycomb/credentials.json`, read by the daemon directly. SAFE. |
| CredentialReader parse — no proto-pollution / traversal | `src/hooks/shared/credential-reader.ts:100-128` | `JSON.parse` + per-field `typeof` guards onto a fresh object literal; never spreads `...rec`, never assigns a computed key, fixed path. Fail-soft → `undefined` on absent/malformed. SAFE. |
| DaemonHookClient — fail-soft, tenancy into body not header-bearer | `src/hooks/shared/daemon-client.ts:94-175` | Stamps tenancy headers + merges org/workspace into `body.metadata`; transport failure → status 0, never a throw out of a hook; token never logged. SAFE. |
| MCP served endpoint — loopback-only, stdio-default | `mcp/src/index.ts:112-183`, `mcp/src/transports.ts:204-253` | Harness-spawned bundle runs `serveHttp:false` (stdio ONLY — no network listener). `serveHttp:true` binds `127.0.0.1` only, 404s non-`/mcp`. Thin client (no DeepLake). Actor stamped server-side. SAFE. |
| Token-in-log sweep across all new 021 files | (swept) | Only sinks: `console.log(line)` output sink (documented "NEVER receives a bearer token"), `stderr.write` of signal names + `err.message` (bind/start errors, never credential values). No token logging. SAFE. |
| Daemon-only invariant | `tests/daemon/storage/invariant.test.ts` | 3/3 green — `src/cli`, `src/hooks`, `src/dashboard`, `mcp` import nothing from `daemon/storage`; the composition root (`src/daemon/runtime/assemble.ts`) is the only new `daemon/storage` importer (exempt). |

## Gate results (post-audit; no code changed, so these are the standing baseline)

| Gate | Command | Exit | Notes |
|---|---|---|---|
| SQL-safety audit | `npm run audit:sql` | 0 | 147 files; every interpolation routes through an escaping helper |
| OpenClaw bundle scan | `npm run audit:openclaw` | 0 | 1 file scanned; no findings, clean against ClawHub rules |
| npm audit (prod deps) | `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| Daemon-only invariant | `npx vitest run tests/daemon/storage/invariant.test.ts` | 0 | 3/3 passed |

> **`npm run ci`, `npm run build`, and the gated `golden-path-live.itest.ts` were NOT re-run by this audit** because **no code was modified** — there is nothing to regress. The ledger records the most recent green run (021f): `npm run ci` exit 0 (164 files, 1577 passed/4 skipped), `npm run build` exit 0, golden-path-live 3/3 clean live runs (recall-hit 1.00). Since the audit introduced zero edits, those results stand unchanged. No regression test was added because no remediation code was written (F-1 is a wiring-time constraint for a future wave, not an in-session code change; existing tests `host.test.ts`/`api.test.ts`/`golden-path-live.itest.ts` already cover the dashboard/logs no-secret behavior).

## Quality-worker-bee gate

**quality-worker-bee is CLEARED to run.** No code was modified by this audit, so there is no risk that QA reads code that will mutate under remediation. The one open item (F-1) is a documented future-wiring constraint, not an in-session change. The single MEDIUM is latent (route not wired into the production composition root) and the two LOW items are pre-existing accepted-risk explicitly deferred by D-3.
