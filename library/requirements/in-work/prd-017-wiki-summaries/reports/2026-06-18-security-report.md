# Security Audit — PRD-017 Wiki Summaries

- **Date:** 2026-06-18
- **Branch:** `prd-017-wiki-summaries`
- **Auditor:** security-worker-bee (Hivemind security stinger)
- **Scope:** PRD-017a summary worker + PRD-017b synthesis — `src/daemon/runtime/summaries/{contracts,worker,synthesis,index}.ts`, the additive `description` column on `src/daemon/storage/catalog/sessions-summaries.ts`, and the summaries test suite.
- **Ordering:** Run BEFORE `quality-worker-bee`. No `*-qa-report.md` exists for this branch (the only QA report on disk, `library/qa/cursor-extension/2026-06-12-qa-report.md`, belongs to a different feature). No ordering violation.

---

## Executive Summary

PRD-017 is a security-conscious implementation. It correctly reuses the live-proven safety primitives from PRD-002 (SQL escaping), PRD-016 (skillify redaction, no-shell gate spawn, O_EXCL lock) and PRD-011 (tenant scope). All seven audited dimensions hold under both affirmative and adversarial review.

- **0 Critical, 0 High, 0 Medium, 1 Low** finding.
- The single Low finding (a defense-in-depth recursion marker that was named but not set) was **fixed in-session** because the change is strictly additive and < 5 lines.
- All gates green after the fix: `npm run ci` = 0 (1125 passed / 4 skipped), `npm run build` = 0, `npm run audit:sql` = 0 (136 files), `npm run audit:openclaw` = 0.

**Coverage: FULL.** No surface outside the covered TypeScript/Node/Deep Lake stack was introduced.

**Verdict: PASS — `quality-worker-bee` is CLEARED to run.**

---

## The seven audited dimensions — conclusions

### 1. Gate-CLI shell-out — NO command injection, NO recursion (the #1 surface) — PASS

**No-shell, args-array, prompt-on-stdin (affirmative):** `systemSummarySpawner.run` (`worker.ts:458`) calls `spawn(spec.command, [...spec.args], { shell: false, env: {…} })`. `shell: false` plus an argument **array** means the OS `execvp`s the binary directly — there is no shell to interpret metacharacters. The session transcript reaches the child only through `child.stdin.write(prompt)` (`worker.ts:~495`), i.e. inert stdin bytes, never an argv element.

**Adversarial:** A hostile transcript containing `; rm -rf ~`, `$(curl evil)`, or backticks is rendered into the gate prompt by `buildSummaryPrompt` and handed to stdin. Because (a) no shell is invoked and (b) the prompt is never concatenated into `spec.args`, the payload is treated as opaque text by the child process. The test `a-AC-2` asserts `seenSpec.args.join(" ")` does NOT contain transcript text while `seenPrompt` does — proving the data/command separation. The `command`/`args` of `SummaryCliSpec` are operator/harness-config values (constructed by the daemon from its harness selection), never derived from transcript content, so there is no path for a transcript to choose the executable either.

**Timeout + lock release:** the spawn is bounded by `gateTimeoutMs` (default 120 s); on expiry it `child.kill("SIGTERM")` and rejects (`worker.ts:468-475`). The worker treats a gate reject as `gate_failed`, removes the placeholder, and — critically — releases the per-session lock in the `finally` of `runSummaryWorker` (`worker.ts:642-645`). A runaway gate cannot strand the lock.

**No-recursion / no fork-bomb (affirmative):** the gate subprocess env layers `HONEYCOMB_WIKI_WORKER=1` + `HONEYCOMB_CAPTURE=false` (and, post-fix, `HONEYCOMB_WORKER=1`) over `process.env`. The spread (`...process.env`) is first, so the explicit keys always win — a parent-inherited `HONEYCOMB_CAPTURE=true` cannot survive. `capture-gate.ts:shouldCapture` evaluates `captureFlag === "false"` as its **priority-1 bypass**, so capture is disabled in the gate subprocess and every grandchild that inherits the env. The gate call therefore cannot trigger its own capture → no summary loop → no fork bomb.

**Adversarial:** these env vars are set in code, not from transcript content, so a transcript cannot subvert them. The only way recursion could occur is if a nested shim lost `HONEYCOMB_CAPTURE`; the fix below closes even that hypothetical.

### 2. Transcript secret → summary → team (skillify-class exfil) — PASS

**Affirmative:** `buildSummaryPrompt` (`worker.ts:404-421`) routes every event's text through `redactSecrets` (imported, not forked, from `skillify/miner.ts:315`) BEFORE the text is placed in the gate prompt. `redactSecrets` scrubs the same high-confidence catalog skillify uses: PEM private-key blocks, JWTs (`eyJ…`), provider-prefixed keys (`sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `xox[abprs]-`, `AIza…`, `AKIA…`, `apdl_`/`hivemind_`/`hm_`), `Authorization: Bearer/Basic` headers, and `secret/token/password/api_key = "<value>"` assignments — replacing the credential with `[REDACTED]`.

**Why the summary body is also clean:** the deterministic floor is applied to the **input** to the gate. Because the secret is `[REDACTED]` before the gate model ever sees it, the model cannot echo it into the generated markdown. The persisted `summary` body and the `description` excerpt (`excerptOf(markdown)`) are derived from gate output, which derived from already-scrubbed input — so a transcript secret cannot reach the persisted row.

**Adversarial:** test `redaction:` (`worker.test.ts:375-383`) plants `sk-ant-abc123…` in a transcript and asserts the prompt contains `[REDACTED]` and NOT the secret. The 017b synthesis path re-reads only the already-scrubbed `description`/`path`/`author` of persisted summary rows (`synthesis.ts:readSummaries`) and renders links — it never re-reads raw transcript, so MEMORY.md and thread heads cannot re-introduce a secret. The team-propagation exfil vector (secret → MEMORY.md → team-wide link) is therefore closed at the write boundary.

*Residual (accepted, same trust model as skillify):* `redactSecrets` is high-confidence/precision-over-recall by design — a novel secret format outside the pattern set could pass. This is the documented, pre-existing skillify posture, not a PRD-017 regression. No action.

### 3. Tenancy / scope — NO cross-tenant leak — PASS

**Affirmative:** the summary write (`createSummaryStore`), the event read (`createSessionEventFetcher`), and the synthesis read/write (`createSynthesisStore`) all carry `QueryScope { org, workspace }` on every `storage.query(sql, scope)` call. `QueryScope` is the Deep Lake org/workspace partition boundary, resolved from the daemon's trusted auth state — NOT from any transcript field. Two tenants → two partitions → disjoint reads.

**Path safety:** `summaryPath` builds `/summaries/<userName>/<sessionId>.md` with both components passed through `sanitizePathSegment` (`worker.ts:110-113`) which reduces anything outside `[A-Za-z0-9._-]` to `_` (so `/`, `\`, `..` cannot traverse). Even if a hostile transcript spoofed `userName`/`sessionId`, the worst case is a path collision **within the attacker's own org partition** — the `scope` still pins the row to that tenant, so it cannot land in or read from another tenant's partition. Scoping comes from a trusted source (resolved daemon scope), not a spoofable transcript field. `b-AC-6` asserts two tenants synthesize disjoint MEMORY.md indexes with the real store carrying per-tenant scope to the wire.

### 4. SELECT-before-INSERT integrity (the live-fix) — PASS

**Affirmative:** `writeSummary` (`worker.ts:269-306`) is SELECT-before-INSERT keyed on `path`, with the existence probe **excluding** the in-progress placeholder (`description != 'in progress'`). This is the live-fix: a stranded placeholder (the backend's DELETE is not reliably honored) cannot make the probe report `alreadyPresent` and silently drop the real summary. `written` reflects the **actual** INSERT result (`isOk(inserted)`), so a failed INSERT is never masked as success. There is **no in-place UPDATE / no `update` method** on `SummaryStore` or `SynthesisStore` by construction. The placeholder is removed by a guarded `DELETE … WHERE description = 'in progress'` (`worker.ts:254-267`) which can only ever remove a placeholder, never a real summary — no read-modify-write of a live value.

**Adversarial:** `a-AC-6` drives the real `createSummaryStore` over a fake transport and asserts ZERO `UPDATE "memory" SET …` statements are emitted and the placeholder removal is a marker-guarded DELETE. The placeholder marker `'in progress'` is a fixed constant compared via `sLiteral`; a transcript cannot forge it into a real row because the real summary's `description` is `excerptOf(markdown)` (never the literal marker unless the summary body is exactly that string after whitespace-collapse — harmless, it would merely cause an idempotent re-probe). Synthesis mirrors the identical placeholder-aware probe (`synthesis.ts:223-248`).

### 5. SQL injection — every interpolation escaped — PASS

`npm run audit:sql` = clean (136 files). Every identifier in `worker.ts`/`synthesis.ts` routes through `sqlIdent` (rejects anything outside `^[a-zA-Z_][a-zA-Z0-9_]*$`, throws otherwise); every value through `sLiteral`/`val.str`/`val.text` (→ `sqlStr`, which doubles backslashes then single-quotes then strips control chars — an injection payload collapses to one inert literal). The embedding literal is `serializeFloat4Array` output (a pre-validated numeric fragment) or the trusted `NULL` literal, both via `val.raw`. The `/summaries/` prefix LIKE in `readSummaries` is a fixed identifier-safe literal with a trailing `'%'`, carries no user input.

**Adversarial:** a malicious `userName`/`sessionId`/`path`/`body`/`author` is interpolated only via `sLiteral`/`val.*`; a payload like `'; DROP TABLE memory; --` is doubled into an inert string and never closes the literal. Table names are the fixed `"memory"`/`"sessions"` constants (or a live-itest prefix that itself goes through `sqlIdent`), never transcript-derived.

### 6. Through-the-daemon — PASS

The worker and synthesis live under `src/daemon/` and reach `memory`/`sessions` only through the daemon's own `StorageQuery` (`createSummaryStore`/`createSynthesisStore`/`createSessionEventFetcher` all take an injected `StorageQuery`). Neither re-opens a Deep Lake connection. The hook half only signals the daemon. `invariant.test.ts` (the no-direct-connection guard) remains green within the full `npm run ci` run.

### 7. DoS / resilience — PASS

- **Lock cannot deadlock:** acquired once per run; ALWAYS released in `runSummaryWorker`'s `finally` (`worker.ts:642-645`) — on success, no-events give-up, gate failure, embed throw, or any unexpected throw. `release()` is idempotent (`released` guard).
- **Retry backoff is bounded:** `fetchWithRetry` (`worker.ts:655-670`) loops `attempt <= retryLimit` (default 5) with constant linear backoff; it cannot spin forever. `retryLimit` is `Math.max(0, Math.trunc(...))` so a malformed config cannot produce an unbounded/negative loop. On give-up the placeholder is removed (never stranded) — `a-AC-3`.
- **Embed non-fatal:** `embedNonFatal` (`worker.ts:680-691`) catches every throw → NULL embedding, the write still succeeds (`a-AC-5`); a non-768 vector is coerced to NULL.
- **Placeholder cleanup cannot strand:** the no-events and gate-failure paths both call `removePlaceholder`; and even if a DELETE is not honored by the eventually-consistent backend, the placeholder-excluding probe in `writeSummary` guarantees the next real write is not blocked. Bounds on transcript/summary size are not enforced in PRD-017 (the gate CLI and Deep Lake row limits bound them downstream) — see Low note below; no DoS in the audited surface.

---

## Findings

### LOW-1 — Dedicated capture-recursion marker named but not set (FIXED in-session)

- **File:** `src/daemon/runtime/summaries/worker.ts` (gate subprocess env, `systemSummarySpawner`).
- **Observation:** The gate subprocess set `HONEYCOMB_WIKI_WORKER=1` + `HONEYCOMB_CAPTURE=false`, but the canonical recursion-guard marker that `src/shared/capture-gate.ts:66` actually reads (`workerMarker`, sourced from **`HONEYCOMB_WORKER`**) was NOT set. `HONEYCOMB_WIKI_WORKER` is read by nothing. The no-recursion guarantee therefore rested entirely on the single `HONEYCOMB_CAPTURE=false` priority-1 bypass.
- **Severity rationale — LOW (not High):** `HONEYCOMB_CAPTURE=false` on its own fully disables capture in the gate subprocess and all inheritors, so recursion was already prevented; there was no exploitable loop. This is a defense-in-depth gap (a missing second guard), not an open vulnerability.
- **Fix applied (additive, < 5 lines):** added `export const WORKER_MARKER_ENV = "HONEYCOMB_WORKER"` and set `[WORKER_MARKER_ENV]: "1"` in the gate subprocess env, so the capture gate's recursion guard (`c-AC-4`) trips independently of the bypass flag — matching skillify's documented pattern. Extended the `a-AC-2 (live env)` test to assert `HONEYCOMB_WORKER=1` is exported into the child. No behavior change to the existing capture-disable path.

---

## Categories checked with no findings

- **Credential / token exposure:** None detected. No token, JWT, or org-id is logged or persisted by the worker/synthesis. The summary write persists only scrubbed summary text; `redactSecrets` scrubs Bearer/JWT/key shapes pre-gate.
- **Captured-trace PII leakage:** None detected. Transcript text is scrubbed before the gate and before persistence; synthesis re-reads only scrubbed columns.
- **Broken access control / scope coercion:** None detected. `QueryScope` (trusted) pins every read/write to the tenant partition; transcript-derived path segments cannot escape it.
- **Prompt injection via poisoned trace:** Out of new scope — the gate output is persisted as a summary document; PRD-017 does not change recall-injection behavior beyond reusing the scrubbing floor. No new injection sink introduced.
- **Hidden-Unicode rules backdoor:** N/A — no `.cursor/rules` files added.
- **Supply chain:** None detected. `npm run audit:openclaw` clean; no new dependencies; the `gate-runner.ts` bypasses untouched.
- **Crypto / file-mode misconfig:** N/A — the O_EXCL lock files under `~/.claude/hooks/summary-state` carry no secrets; no credential files touched.

---

## Gate exit codes (post-fix)

| Gate | Result |
|---|---|
| `npm run ci` (typecheck + jscpd + vitest) | **0** — 1125 passed / 4 skipped (99 files) |
| `npm run build` (tsc + esbuild) | **0** — all bundles built @ 0.1.0 |
| `npm run audit:sql` | **0** — 136 files, every interpolation through an escaping helper |
| `npm run audit:openclaw` | **0** — bundle clean against ClawHub rules |

Live itests (`summary-write-live`, `synthesis-live`) NOT run by this audit (orchestrator owns them; confirmed 4/4 + 3/3 per ledger).

---

## Verdict

**PASS.** No Critical, High, or Medium findings. One Low defense-in-depth gap fixed in-session with a minimal additive diff. The gate-shell-out is injection-proof (no shell, args array, prompt on stdin) and recursion-proof (CAPTURE=false bypass, now plus the canonical worker marker); transcript secrets are scrubbed before the gate and before persistence; tenancy is enforced by trusted `QueryScope` and traversal-safe path sanitization; the SELECT-before-INSERT path is placeholder-robust with no in-place UPDATE; all SQL is escaped.

**`quality-worker-bee` is CLEARED to run.**

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 (fixed) |
