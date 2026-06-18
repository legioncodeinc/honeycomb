# Security Audit — PRD-019 Harness Integrations

- **Date:** 2026-06-18
- **Auditor:** security-worker-bee (Opus 4.8)
- **Branch:** `prd-019-harness-integrations`
- **Scope:** Wave 2 of PRD-019 — 36 ACs across 5 client surfaces (019a connectors, 019b hook core, 019c per-harness shims, 019d MCP server, 019e SDK)
- **Ordering:** Ran **before** quality-worker-bee. No `*-qa-report.md` exists for prd-019 (`reports/` dir empty) — ordering is clean.

---

## Executive Summary

**VERDICT: PASS-WITH-FIXES.** The two highest-value adversarial targets named in the brief — **command-injection via the host-CLI session-end spawn** and **secrets value-leak through the MCP surface** — are both **PROVEN SAFE by construction**. No Critical or High finding reaches a live exploit on this branch, because every 019 surface is a thin client that touches the daemon and the host only through injected seams, with the real OS-level bindings (`child_process`, real `node:fs`, live transports) all deferred (matching the 001–018 posture).

Two genuine **defense-in-depth weaknesses on the live network surface (the SDK)** were found and **fixed in-session** with named regression tests: the SDK's `secrets.exec` value-safe floor was bypassable (would surface a raw `stdout`/`output` field if the daemon misbehaved), and the SDK attached the bearer token to an **unvalidated `daemonUrl`** (plaintext-remote credential-exfil / SSRF-adjacent). Both are now fail-closed.

All post-fix gates are green. **quality-worker-bee is CLEARED to run.**

### Counts by severity

| Severity | Count | Fixed in-session | Documented only |
|---|---|---|---|
| Critical | 0 | — | — |
| High | 1 (SEC-H1) | 1 | 0 |
| Medium | 1 (SEC-M1) | 1 (<5-line guard) | 0 |
| Low | 2 (SEC-L1, SEC-L2) | 0 | 2 |

**Reduced coverage:** none. The entire branch is within the covered TS/Node/ESM stack (CLI + MCP + hooks + SDK). No new datastore or non-TS subsystem was introduced.

---

## The two named high-value targets — adversarial proof

### 1. Command-injection via host-CLI spawn (session-end) — **PROVEN SAFE**

The brief flags any session-derived value reaching a shell command as RCE. Findings:

- **No 019 surface imports `child_process`.** A repo grep confirms the only real spawn sites are in the **daemon** (`src/daemon/runtime/summaries/worker.ts`, `skillify/miner.ts`, `secrets/exec.ts`, `services/git-sync.ts`), all of which are pre-019 and already use `spawn`/`execFile` with `shell:false` and arrayed args (out of 019 scope; `audit:openclaw` + `audit:sql` green).
- **`src/hooks/shared/session-end.ts`** never builds a command. `runSessionEnd` calls the injected `SummarySpawn.spawn(sessionId)` seam with **only the session id** — no host-CLI string is assembled here.
- **`HostCli` (`src/hooks/contracts.ts:103`)** is a *structured descriptor* — `{ bin: string; args: readonly string[]; fallbackBin? }`. Every shim declares it as data: `CLAUDE_CODE_HOST_CLI = { bin:"claude", args:["-p"] }`, `CODEX_HOST_CLI`, `CURSOR_HOST_CLI`, `HERMES_HOST_CLI`, `PI_HOST_CLI`. No shell string, no `shell:true`.
- **`pi/shim.ts:44` `piResolveHostCli(provider, model)`** — the one place session-derived values (`provider`/`model`) flow into a host-CLI — places them as **discrete array elements** (`args:["--print","--provider",provider,"--model",model]`), not interpolated into a shell string. Safe even when consumed by an arrayed `spawn`.
- **`openclaw/shim.ts` CLI fallback** routes goal/KPI writes through `CliFallback.run(["honeycomb", verb, ...args])` — an **argv array**, no interpolation; the bundle adds no `child_process` (ClawHub scan green).

**Conclusion:** the RCE path does not exist on this branch. The deferred concrete `SummarySpawn` binding MUST consume `HostCli` via arrayed `spawn(bin, args, {shell:false})` — recorded as a forward-looking assembly requirement in SEC-L2 below.

### 2. Secrets value-leak via the MCP surface — **PROVEN SAFE**

- **`mcp/src/handlers.ts` `secret_list`** rebuilds `{ names }` from strings alone via `toSecretListResult` — *no path by which a `value` field survives* (every other field is discarded).
- **`secret_exec`** routes through `toSecretExecResult`, which coerces to `{ status, output }` and **defaults `output` to the `[REDACTED]` token** — it only accepts an already-redacted `output` string from the daemon and never reaches for a raw `stdout`. `tests/mcp/secrets.test.ts` plants a secret and asserts it never appears in the serialized result.
- **Actor / runtime-path spoofing — SAFE.** `mcp/src/registry.ts` passes `deps.actor` (a server-side construction value) to every handler; the actor and `x-honeycomb-runtime-path: plugin` headers are stamped by `daemon-seam.ts` from `req.actor`, **never from tool args**. Arg schemas are `z.object(...).strict()` (`mcp/src/tools.ts:35`), and `registry.ts:128` strict-parses **before** dispatch — an extra/unknown arg (e.g. an attempt to inject a header or override the actor) is rejected with zero daemon round-trip.
- **Reason-required mutation gate — NOT bypassable.** `memory_modify`/`memory_forget` call `reasonOf(args)` and `errorResult(...)` **before** `route(...)` (`handlers.ts:155-168`); the schema also makes `reason: z.string()` required. Double-gated.

**Note (SEC-H1):** the *SDK's* equivalent `secrets.exec` floor was weaker than the MCP's and was hardened (below).

---

## Findings

### SEC-H1 — High — SDK `secrets.exec` value-safe floor was bypassable — **FIXED**

- **File:** `src/sdk/client.ts` (pre-fix line 304)
- **Category:** Captured-trace / credential exposure (value-safe secrets, e-AC-6).
- **Pre-fix code:** `return { redactedOutput: body?.redactedOutput ?? body?.stdout ?? body?.output ?? "" };`
- **Exploit:** e-AC-6 mandates "redacted output only." The SDK trusted the daemon to redact, but if the daemon (mis)attached the raw command output under `stdout` or `output` instead of `redactedOutput`, the SDK would surface the **raw, unredacted secret value** to the caller — exactly the value-leak the AC forbids. The MCP surface (`toSecretExecResult`) is fail-closed; the SDK was not, despite exposing the same `secrets.exec` contract. Credential exposure → always High (Stinger rule 4).
- **Fix:** surface **only** the explicit `redactedOutput` projection; never promote `stdout`/`output`. When the daemon omits `redactedOutput`, return the `SECRET_REDACTED` (`[REDACTED]`) sentinel — fail-closed, not data-leak. Added exported `SECRET_REDACTED` constant.
- **Regression tests (`tests/sdk/client.test.ts`):**
  - `SEC-H1 a daemon body carrying raw stdout/output is NOT surfaced — redaction sentinel instead`
  - `SEC-H1 an explicit redactedOutput projection is still surfaced verbatim`
- **AC impact:** e-AC-6 **strengthened**, not weakened (the existing e-AC-6 test still passes verbatim).

### SEC-M1 — Medium — SDK attaches bearer token to an unvalidated `daemonUrl` (SSRF-adjacent credential exfil) — **FIXED (<5-line guard)**

- **File:** `src/sdk/client.ts` (`buildHeaders`, pre-fix line 89)
- **Category:** Token/credential exposure over the network.
- **Exploit:** `baseUrl` was taken verbatim from `opts.daemonUrl` with no transport validation, and `Authorization: Bearer <token>` was stamped on **every** request to that base URL. If `daemonUrl` is set to a plaintext non-loopback host (e.g. via a team-distributed/hybrid config or an env var the developer does not control), the device-flow JWT is exfiltrated in cleartext to whoever controls that host. The MCP `daemon-seam.ts` hardcodes loopback (`DAEMON_HOST`/`DAEMON_PORT`); the SDK had no equivalent guard. Severity Medium (not High): `daemonUrl` is a constructor option of a developer-facing fetch client — the standard HTTP-client trust model — so there is no fully untrusted-input path, but defense-in-depth for a credential warrants a fail-closed guard.
- **Fix:** added `isTokenTransportSafe(baseUrl)` — the bearer token is attached **only** when the URL is HTTPS (team/hybrid mode) **or** points at a loopback host (`localhost`/`127.0.0.1`/`::1`, the default local-daemon mode). A plaintext `http://` URL to any non-loopback host (or an unparseable URL) gets **no** `Authorization` header (fail-closed). Both legitimate modes are preserved.
- **Regression tests (`tests/sdk/client.test.ts`):**
  - `SEC-M1 a plaintext NON-loopback daemonUrl gets NO Authorization header (no token exfil)`
  - `SEC-M1 a loopback http daemonUrl DOES carry the token (local mode preserved)`
  - `SEC-M1 an HTTPS remote daemonUrl DOES carry the token (team/hybrid mode preserved)`
  - `SEC-M1 isTokenTransportSafe classifies loopback/https as safe and plaintext-remote/unparseable as unsafe`
- **AC impact:** none weakened — the e-AC-1 token-stamping tests use the loopback `DAEMON` constant and still pass.

### SEC-L1 — Low — `isHoneycombEntry` back-compat fallback is over-broad — **DOCUMENTED**

- **File:** `src/connectors/contracts.ts:302-304`
- **Category:** AI-codegen pattern (over-broad predicate) / foreign-config destruction.
- **Detail:** beyond the exact `_honeycomb:true` sentinel, the predicate also reclaims any hook entry whose `command` contains the substring `/honeycomb/bundle/`. A foreign third-party hook whose command legitimately contains that path component (e.g. a user script under `~/tools/honeycomb/bundle/x.js`) would be misclassified as Honeycomb's and **deleted on uninstall**.
- **Why Low, not High:** (1) the sentinel path is exact and primary; the substring is an explicitly-documented legacy upgrade fallback; (2) **no real `node:fs`-backed `ConnectorFs` exists in the codebase** — only the in-memory `FakeFs`. The connector currently never touches a real filesystem (bin dispatch + real-fs binding are deferred per the ledger's honest-deferral note), so the destruction is **unreachable** on this branch. It is a latent logic bug, not a live vulnerability.
- **Recommendation (forward-looking):** when the real `node:fs` `ConnectorFs` is wired, tighten the fallback to require the marker be a *path segment under the connector's own plugin root* (not an anywhere-substring), or drop the fallback entirely if no pre-sentinel installs exist in the field. Add a foreign-hook-with-honeycomb-in-path preservation test against the real fs.

### SEC-L2 — Low — deferred `SummarySpawn` / `ConnectorFs` bindings must stay injection- and traversal-safe — **DOCUMENTED (forward-looking)**

- **Files:** `src/hooks/shared/session-end.ts` (`SummarySpawn` seam), `src/connectors/contracts.ts` (`ConnectorFs.symlink`, `linkSkills`).
- **Detail:** the concrete `SummarySpawn` and real-fs `ConnectorFs` are deferred assembly steps. Two invariants must hold when they land:
  1. `SummarySpawn` MUST consume `HostCli` via `child_process.spawn(bin, args, { shell:false })` — arrayed args, no shell, no interpolation of session data into a command string (preserves the SEC-§1 proof).
  2. The real-fs `symlink(target, linkPath)` MUST resolve `linkPath` and refuse to escape the connector's target dir. Today `baseName(target.source)` already neutralizes a hostile skill *filename* (traversal in the name strips to a basename), and `target.source`/`target.dir` come from HC-controlled subclass seams — but a team-distributed `skillSources` entry is the one semi-external input, so the real-fs impl should canonicalize and bound the link path/target.
- **Why Low:** entirely unreachable on this branch (seams not bound to real OS resources). Recorded so the deferred wiring step does not silently reintroduce the risk.

---

## Category checklist (every category checked)

| Category | Result |
|---|---|
| **Command injection / RCE via host-CLI spawn (session-end)** | None — proven safe by construction (arrayed `HostCli`, no `child_process` in 019, spawn seam takes only sessionId). |
| **Secrets value-leak (MCP `secret_list`/`secret_exec`)** | None — `toSecretListResult`/`toSecretExecResult` are fail-closed; `tests/mcp/secrets.test.ts` proves it. |
| **Secrets value-leak (SDK `secrets.exec`)** | **SEC-H1 — fixed** (raw `stdout`/`output` promotion removed). |
| **Token / credential in logs** | None — only `console.log` in 019 is the connector CLI output sink ("Wired …"); no token/cred ever logged. `CredentialReader.token` doc-marked "never logged"; capture/context never put the token in a body. |
| **Token exfil / SSRF (SDK `daemonUrl`)** | **SEC-M1 — fixed** (loopback/HTTPS guard on bearer attachment). |
| **Credential leak into model context (context-renderer)** | None — `context-renderer.ts` sends `hasCredential: boolean`, never the token; the block comes from the daemon. |
| **Actor / runtime-path header spoofing (MCP)** | None — actor is server-supplied (`deps.actor`); headers stamped from `req.actor`, never from tool args. |
| **Arg-schema strictness / unknown-arg passthrough (MCP)** | None — `z.object().strict()` + strict-parse-before-dispatch in `registry.ts`. |
| **Reason-required mutation gate (MCP)** | None — gated before dispatch AND schema-required; double-gated. |
| **Pre-tool-use VFS intercept escape / echo-rewrite injection** | None — `HARMLESS_ECHO` is a constant (no data interpolation); `replace` substitutes daemon VFS output, never executes the original command; no `node:fs` import → nothing hits the real FS (b-AC-4). |
| **SQL injection into Deep Lake** | None — 019 surfaces build NO SQL (thin-client invariant); `audit:sql` scanned 140 files, all interpolation routes through escaping helpers. |
| **Foreign-config destruction (connector uninstall)** | **SEC-L1 — documented** (over-broad legacy fallback; unreachable, no real fs). |
| **Symlink / path traversal (skill-link)** | **SEC-L2 — documented forward-looking** (deferred real-fs binding; `baseName` neutralizes filename traversal today). |
| **Prompt-injection via captured/normalized trace** | None new — shims normalize to canonical `{kind,...}` data forwarded verbatim to the daemon's zod boundary; the daemon owns validation. |
| **Prototype pollution (`parseConfig` JSON.parse + spread)** | None exploitable — `JSON.parse` lands `__proto__` as an own property; object-spread copies own enumerable props without walking the prototype chain. |
| **Typed-error body leakage (SDK `ApiError.body`)** | Acceptable — `ApiError.body` carries the daemon's own response body (already visible to the caller); no request headers/token included. |
| **Supply chain** | `npm audit --omit=dev` → 0 vulnerabilities; `audit:openclaw` → clean; no new prod deps beyond `@modelcontextprotocol/sdk@^1.29.0` (Wave-2, bundled). |
| **Thin-client invariant (no DeepLake/SQL in new roots)** | Holds — `tests/daemon/storage/invariant.test.ts` scans `src/connectors`, `src/hooks`, `mcp/`, `src/sdk`; 3/3 green. |

---

## Remediation summary

| Finding | File(s) changed | Regression test(s) |
|---|---|---|
| SEC-H1 | `src/sdk/client.ts`, `src/sdk/index.ts` | `SEC-H1 a daemon body carrying raw stdout/output is NOT surfaced — redaction sentinel instead`; `SEC-H1 an explicit redactedOutput projection is still surfaced verbatim` |
| SEC-M1 | `src/sdk/client.ts`, `src/sdk/index.ts` | `SEC-M1 a plaintext NON-loopback daemonUrl gets NO Authorization header (no token exfil)`; `SEC-M1 a loopback http daemonUrl DOES carry the token (local mode preserved)`; `SEC-M1 an HTTPS remote daemonUrl DOES carry the token (team/hybrid mode preserved)`; `SEC-M1 isTokenTransportSafe classifies loopback/https as safe and plaintext-remote/unparseable as unsafe` |

Diff isolated to **three files** (`src/sdk/client.ts`, `src/sdk/index.ts`, `tests/sdk/client.test.ts`) — confirmed no leakage into other 019 surfaces. No AC weakened. No commit/push/`git add` performed.

---

## Post-fix gate results (all from repo root)

| Gate | Exit | Detail |
|---|---|---|
| `npm run ci` | **0** | typecheck clean · jscpd clean · **1320 tests pass** (4 skipped) · audit:sql OK |
| `npm run build` | **0** | 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + **4 SDK** + 1 CLI + 1 embed bundle @ 0.1.0 |
| `npm run audit:sql` | **0** | 140 files scanned — every interpolation routes through an escaping helper |
| `npm run audit:openclaw` | **0** | bundle clean against ClawHub static rules |
| `tests/daemon/storage/invariant.test.ts` | **0** | 3/3 — thin-client invariant holds across all new roots |
| `npm audit --omit=dev` | **0** | 0 vulnerabilities |

---

## VERDICT: PASS-WITH-FIXES

- Critical: 0 · High: 1 (fixed) · Medium: 1 (fixed) · Low: 2 (documented).
- Both named high-value targets (host-CLI spawn RCE, MCP secrets value-leak) proven safe by construction.
- Two SDK defense-in-depth weaknesses fixed in-session with 6 named regression tests; all gates green; minimal-blast-radius diff confined to 3 SDK files.

**quality-worker-bee is CLEARED to run.**
