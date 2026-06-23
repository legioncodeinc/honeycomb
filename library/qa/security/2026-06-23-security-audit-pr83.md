# Security Audit — PR #83 (Codex hooks connector)

> Auditor: `security-worker-bee` (security-stinger) · Date: 2026-06-23
> Target: [honeycomb#83](https://github.com/legioncodeinc/honeycomb/pull/83) "feat: wire Codex hooks connector" by @chrisl10
> Base: `legion/condescending-wilson-95d03a` (PR #82's head) · 12 files, +391/-55
> Method: full-diff review against the Hivemind catalogs (vibe-coding patterns, OWASP 2025, PII/credential, CVE) + deterministic scans.

## Executive summary

**Verdict: PASS — no Critical, High, or Medium findings. Safe to merge from a security standpoint.**

PR #83 adds a `CodexConnector` (installs Honeycomb lifecycle hooks into `~/.codex/hooks.json`), a test-only Codex `hooks.json` zod schema oracle, per-event esbuild bundle aliases, and threads a `runtimePath` value through the session-start context/prime renderers (replacing a hardcoded `"plugin"`). Every change is either parity with already-reviewed connectors or a correctness improvement. The one behavioral change worth scrutiny — the `runtimePath` threading — is **safe by construction** and actually fixes a latent session-consistency bug. Two Low/informational notes are recorded for hardening; neither blocks merge.

**Ordering note:** This is a standalone review of an external contributor's PR, not the plan-loop close-out. No `quality-worker-bee` report exists for PR #83, so there is no ordering inversion. (The QA report under PR #82's tree covers the PRD-045 work, not this connector.)

**Scope note:** Codex is one of the six supported harnesses already in the Stinger's catalog (harness integration), so this was a full-fidelity review — no degraded coverage.

## Scorecard (every category checked)

| Catalog / category | Result |
|---|---|
| SQL injection into Deep Lake (`sqlIdent`/`sqlStr`/`sqlLike`) | None detected — PR adds no Deep Lake queries (hooks are thin clients; no `deeplake-api` calls). |
| Pre-tool-use gate / VFS path bypass | None detected — PR wires the existing `pre-tool-use.js` gate into Codex's `PreToolUse` event (a defensive *addition*, not a bypass). |
| Credentials / token handling / logging | None detected — no token read/write/log added; credential flows untouched. |
| Captured-trace PII | None detected — PR changes no capture payload shape; `runtimePath` is a 2-value enum, not content. |
| Broken access control (org RBAC, `me\|team` scope) | None detected — `runtimePath` drives session-consistency, NOT authz/scoping (separate `x-honeycomb-org` permission middleware owns that). |
| Prompt-injection (recalled memory / skill injection) | None detected — PR does not change *what* is injected, only threads the harness's runtime-path claim. |
| Command injection (hook command construction) | None new — `node "${handlerPath}"` is parity with `cursor.ts`/`claude-code.ts`; path is fixed + from trusted `homedir()`. See L-1. |
| Header injection (`x-honeycomb-runtime-path`) | None detected — value is the `"plugin"\|"legacy"` enum, zod-validated (`contracts.ts:709`) AND server-revalidated (`runtime-path.ts:264`, 400 otherwise). |
| Supply chain (esbuild bundle, hidden Unicode, hallucinated deps) | None detected — alias files are byte-identical copies of the audited `index.js`; no bidi/zero-width chars; only `zod` imported (already a dep). See I-1. |
| Secrets committed / `pack-check` | None detected — no secrets in the diff. |
| Dynamic exec / eval / `createRequire` | None detected — no `child_process`/`eval`/`new Function`/dynamic `require` added. |

## Detailed analysis of the one behavioral change — `runtimePath` threading

**Files:** `src/hooks/shared/{context-renderer,prime-renderer,session-start,contracts}.ts`

Before: the context and prime renderers hardcoded `runtimePath: "plugin"` / `"x-honeycomb-runtime-path": "plugin"`. After: `req.runtimePath ?? "plugin"`, sourced from `input.runtimePath`.

Why it is safe:
1. **Constrained type:** `RuntimePath = "plugin" | "legacy"` (`runtime-path.ts:46`), zod-enforced at the hook boundary (`contracts.ts:709` `z.enum(["plugin","legacy"])`).
2. **Not attacker-controlled:** `input.runtimePath` is set from a per-harness compile-time constant (`CODEX_RUNTIME_PATH = "legacy"`, `claude-code/shim.ts`, etc.), never from per-request untrusted content.
3. **Server-side defense-in-depth:** even if a malformed value reached the wire, `runtimePathMiddleware` (`runtime-path.ts:262-273`) rejects anything other than `plugin`/`legacy` with a 400 before any handler runs — so no header injection and no smuggled value.
4. **Consistency, not authorization:** the header feeds an in-process, TTL-bounded session→path claim map (`createRuntimePathService`). It can only cause a 409 on a genuine cross-path conflict; it does **not** influence org/tenancy/scope. Authorization is the separate permission middleware (`x-honeycomb-org` + RBAC).

Security-positive side effect: the change fixes a latent bug where a *legacy* harness (Codex/Claude) session-start claimed `"plugin"`, then its later capture posts claimed `"legacy"` → a self-inflicted 409 that would fail-close the harness's own writes. Aligning the claim removes that availability footgun without weakening any check.

## Findings

### L-1 (Low / defense-in-depth) — hook command embeds `homedir()` unescaped
`src/connectors/codex.ts` `hookHandlers()` builds `command: \`node "${handlerPath}"\`` where `handlerPath` contains `opts.home` (from `os.homedir()`). If a host's home path contained a `"` or shell metacharacters AND Codex executes the hook `command` through a shell, the quoting could be broken.
- **Why Low:** `homedir()` is an OS-trusted value (not user input); the path is double-quote-wrapped; and this is **exact parity** with the already-shipped `cursor.ts:115` and `claude-code.ts:99` connectors (same pattern, same accepted baseline). No regression introduced by this PR.
- **Recommendation (non-blocking, applies to all three connectors):** confirm Codex executes hook `command` via direct `execFile`/argv rather than a shell; if shell, switch the registered command to an argv form or escape the path. Track as a connector-wide hardening item, not a PR-83 blocker.

### I-1 (Informational) — esbuild emits per-event bundle alias copies
`esbuild.config.mjs` now `copyFileSync`s `index.js` to `session-start.js`/`capture.js`/`pre-tool-use.js`/`session-end.js` per harness. Files are byte-identical to the stamped, audited `index.js` (no new code path). Confirm the npm `files` allowlist + `scripts/pack-check.mjs` still account for the added files so nothing unintended ships or is omitted — this is **dependency-audit-worker-bee's** domain, flagged here for handoff.

### Positive observations
- Uninstall is marker-scoped and preserves foreign hooks (proven by `tests/connectors/codex.test.ts` "preserves foreign hooks and uninstall removes only Honeycomb entries").
- Wiring `pre-tool-use.js` into Codex's `PreToolUse` extends the VFS memory-write gate to Codex — a defensive improvement. (Functional confirmation that Codex's `PreToolUse` can actually block belongs to `quality-worker-bee`.)
- The zod schema oracle (`references/codex/hooks-schema.ts`) is imported only by tests; `.passthrough()` is appropriate for a permissive conformance check and is not a runtime trust boundary.

## Files reviewed
`esbuild.config.mjs` · `references/codex/hooks-schema.ts` · `src/cli/connector-runner.ts` · `src/connectors/codex.ts` · `src/connectors/index.ts` · `src/hooks/shared/{context-renderer,contracts,prime-renderer,session-start}.ts` · tests (`tests/connectors/codex.test.ts`, `tests/hooks/shared/{prime-renderer,session-start}.test.ts`).

## Remediation performed
None required — no Critical/High/Medium findings. (The two notes are Low/informational and one is owned by dependency-audit-worker-bee.)
