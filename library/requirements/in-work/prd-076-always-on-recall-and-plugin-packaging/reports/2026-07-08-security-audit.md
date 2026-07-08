# Security Audit Report: PRD-075 + PRD-076 recall arms (`feature/prd-075-076-recall-arms`)

**Audit date:** 2026-07-08
**Auditor:** security-worker-bee subagent
**Scope:** the branch diff vs merge-base with `main` (`git diff main...HEAD`) - the always-on UserPromptSubmit recall (`src/hooks/shared/recall-renderer.ts`, `user-prompt-recall.ts`, `runtime.ts`, `normalize.ts`), the pre-tool recall + render path (`src/hooks/shared/pre-tool-use.ts`, `claude-code/shim.ts`, `binary.ts`), the 075c sentinel, the Claude Code plugin packaging (`harnesses/claude-code/.mcp.json`, `hooks/hooks.json`, `skills/**`, `commands/**`), and the branch's new tests.
**Node version audited:** >=22 (package.json engines)
**`npm audit` result:** clean - 0 vulnerabilities
**OpenClaw bundle scan:** not applicable to this branch (no OpenClaw bundle / `src/skillify` change on the diff); the packaging change is the Claude Code plugin only
**`audit:sql` result:** clean - scanned 307 files, every SQL interpolation routes through an escaping helper (no `src/daemon` schema change on this branch)
**CVE watchlist last refreshed:** 2026-04-24 (~75 days - fresh, under the 120-day threshold)

---

## Executive Summary

One Medium finding, fixed in place: the new per-turn recall dedupe store wrote its state file to `~/.honeycomb/recall-sessions/` at default (umask-derived) permissions while the persisted `injectedRefs` can embed a bounded prefix of recalled memory content, so on a shared POSIX host another local user could read fragments of captured-trace-derived content. No Critical or High findings. The recall/pre-tool attack surface is otherwise sound: tenancy is always derived from the credential store (no scope coercion), recall is read-only and fail-soft with no error/secret leakage to stdout, the session-id sanitizer already blocks path traversal, the pre-tool `mentionsMount` gate imports no `node:fs`/`child_process` (no real-FS escape), the argv mode-selection flag is distinctive and config-controlled, the sentinel regex is fully anchored, `.mcp.json` inlines no secrets, and `/forget` keeps its reason-gate plus `disable-model-invocation`.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | ATTN | 1 (Medium, fixed) |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deep Lake SQL API) | OK | 0 |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (cred modes, capture opt-out, client hardening) | ATTN | 1 (Medium, fixed - same finding) |
| Pre-Tool-Use Gate & Prompt Injection | ATTN | 2 (Low, noted) |

Legend: **OK** = zero findings · **ATTN** = Medium/Low findings documented · **FAIL** = Critical/High findings.

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings

- [x] **Captured-trace-derived state at default file permissions (C1/C5-adjacent)** `src/hooks/shared/user-prompt-recall.ts:196-204` (pre-fix) - `createFileRecallSessionStore` created `~/.honeycomb/recall-sessions/` with `mkdirSync(baseDir, { recursive: true })` and wrote the snapshot with `writeFileSync(..., "utf8")`, both with no explicit mode. The persisted `injectedRefs` can embed up to 120 chars of recalled memory content (the `text:` ref fallback at `recall-renderer.ts:176`), so on a shared POSIX host the file's umask-derived mode (typically group/world-readable) exposes captured-trace fragments. This diverges from the repo-wide convention (`credentials-store.ts`, `onboarding-store.ts`, `secrets/store.ts`, `vault/store.ts`, `fleet-store.ts`, `local-job-queue.ts` all pass explicit `mode`). **Fixed:** the dir is now created `0o700` and the file `0o600` (no-op on win32, matching the codebase pattern). Regression test added: `writes the state dir 0700 and the state file 0600` (POSIX-only). Considered under the never-downgrade rule for captured-trace content; classified Medium because the exposure is local-host-only, bounded to a 120-char fragment, and only present when a hit lacks an id - remediated regardless (<5-line fix).

---

## Low Findings (documentation only)

- [ ] **Recalled content injected as model context (A6/C8, insecure-design)** `src/hooks/shared/user-prompt-recall.ts:130-137` (`renderRecallBlock`) and the pre-tool `replace` path (`runtime.ts:623-682` -> `claude-code/shim.ts:194-205`) - recalled memory `text` is injected verbatim as `additionalContext` under a labeled, delimited block ("Relevant Honeycomb memory for this prompt:"), never concatenated into system instructions. This is the same injection shape the already-shipped session-start prime renderer uses, and it is org-scoped (tenancy from the credential only, so no cross-tenant poisoning). It is inherent to a memory-recall product; noted as an accepted design tradeoff, not a new escalation. No cross-org path exists on this branch.
- [ ] **Fail-soft stderr message on hook binary failure** `src/hooks/binary.ts:239-242` (`maybeRunHookBinaryMain`) - a top-level failure writes a generic `err.message` to stderr (not stdout). No token/PII/SQL flows into these fail-soft messages on the recall path; noted for completeness. stdout only ever carries the rendered envelope or the benign `{}` ack.

Additional checked-and-OK notes (no finding):
- Path traversal in the session-id sanitizer (`user-prompt-recall.ts:207-211`): `/` and `\` are replaced with `_` and the id is capped at 200 chars, so no separator survives; `..` alone yields the in-dir filename `...json`. Verified by the existing `sanitizes the session id...` test.
- TOCTOU on `existsSync` -> `readFileSync` in `load` (`user-prompt-recall.ts:187-195`): fail-soft (catch -> zero-state); not exploitable.
- Unbounded file accumulation: one small state file per session id, never GC'd - hygiene only, Low.
- argv mode-selection (`claude-code/shim.ts:86-88`): `--honeycomb-recall` is a distinctive, config-supplied flag; argv is not attacker-influenceable over the wire; cannot accidentally trip recall or capture mode.
- Sentinel regex (`pre-tool-use.ts:265`): fully anchored `^honeycomb\s+(?:recall|search)\s+(?:"..."|'...')\s*$`; cannot intercept/suppress an unrelated command; the extracted query is `encodeURIComponent`-encoded before the loopback GET.
- Tenancy stamping (`recall-renderer.ts:147-155`, `runtime.ts:576-595`): org/workspace/actor derived from the credential store only; a signed-out credential sends no tenancy headers and the daemon fail-closes (no scope coercion, C3 clean).

---

## Dependency Audit

```text
npm audit --audit-level=high
found 0 vulnerabilities
```

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **SQL guards / config table names via helpers** | every interpolation escaped | `audit:sql` clean, 307 files, no `src/daemon` change on branch | OK |
| **Pre-tool-use gate** (`pre-tool-use.ts`) | literal paths only; VFS-confined; no `node:fs`/`child_process` | no fs/child_process import; only the injected daemon VFS seam | OK |
| **Credential file modes** | `0600` file / `0700` dir, explicit | credential store unchanged; new recall store now `0700`/`0600` | OK (fixed) |
| **Capture opt-out** (`HONEYCOMB_CAPTURE=false`) | zero INSERTs | recall path is read-only (POST /recall + local state); no INSERT introduced | OK |
| **MCP registration** (`.mcp.json`) | no secrets in `env`; non-injectable command/args | `command: node`, args `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`, `env: {}` | OK |
| **Destructive command gating** (`commands/forget.md`) | reason required; not model-auto-invokable | reason-gated + `disable-model-invocation: true` | OK |
| **No token in logs / traces** | no credential/PII to logs or stdout | no token/header logging in new code; fail-soft to `{}`/stderr only | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/hooks/shared/user-prompt-recall.ts` | Create the recall-sessions dir `0o700` and the state file `0o600` (explicit modes matching the repo credential/state-store convention); add `RECALL_STORE_DIR_MODE`/`RECALL_STORE_FILE_MODE` constants with rationale. |
| `tests/hooks/shared/user-prompt-recall.test.ts` | Add POSIX-only regression test asserting the state dir is `0700` and the file `0600`. |

`git diff` reviewed and confirmed security-scoped on 2026-07-08.

---

## Verification

`npm run ci` green after the fix: **432 test files passed, 4645 tests passed, 13 skipped** (the new mode test skips on this win32 checkout), `audit:sql` clean. Formatting applied only to the two changed files via `npx biome format --write`.

## Reopened-AC risk

None. The fix only tightens filesystem permissions on the recall-sessions state file; the store's content, read path, sanitizer, dedupe/throttle behavior, and public API are unchanged, so no PRD-075/076 AC in `library/ledger/EXECUTION_LEDGER-prd-075-076.md` is affected.

## Recommended Follow-Up (architectural)

- Consider a retention/GC policy for `~/.honeycomb/recall-sessions/*.json` (one file per session id accumulates over time). Low priority, hygiene only.
- If a future harness surfaces a cross-org recall path, re-audit the injection boundary (currently org-scoped and safe).
