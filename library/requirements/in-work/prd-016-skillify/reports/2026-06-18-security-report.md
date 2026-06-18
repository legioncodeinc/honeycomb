# Security Audit — PRD-016 Skillify

- **Auditor:** security-worker-bee (Hivemind Security Stinger)
- **Date:** 2026-06-18
- **Branch:** `prd-016-skillify`
- **Repo:** `honeycomb` (C:\Users\mario\GitHub\honeycomb)
- **Ordering:** Ran BEFORE `quality-worker-bee`. No prior `*-qa-report.md` exists for PRD-016 — ordering invariant satisfied; QA is cleared to run AFTER this report.
- **Coverage:** FULL (in-stack: TypeScript / Node ≥22 / ESM, daemon + thin-client, Deep Lake SQL layer). No reduced-coverage surfaces.

## Executive summary

PRD-016 is a well-defended implementation. The four highest-risk surfaces flagged in the dispatch — the gate-CLI shell-out, the symlink fan-out, the through-daemon SQL builders, and the append-only integrity — are **affirmatively secure** (proven below by code citation and adversarial reasoning). All five named SQL-escaping / tenancy / no-shell theses hold.

One genuine, subtle risk was found and **fixed in-session**: the trace miner mined raw session transcripts with **no redaction at the mine boundary**, so a credential a user pasted into a session could be echoed by the gate model into a `SKILL.md` body + the append-only `skills` row and then **propagated to every teammate** via pull (cross-author MERGE promotes scope `me`→`team`). The gate's omission of secrets is a soft, non-deterministic guarantee; I added a deterministic pattern-based scrub at the mine boundary as defense-in-depth.

### Severity counts

| Severity | Count | Status |
|---|---|---|
| Critical | 0 | — |
| High | 1 | FIXED in-session |
| Medium | 1 | Documented (residual hardening) |
| Low | 1 | Documented |

**Verdict: PASS — `quality-worker-bee` is CLEARED.** The High finding is remediated, all gates green, no AC test weakened.

---

## Findings

### H-1 (High, FIXED) — Transcript secret can leak into a mined SKILL.md body and propagate to the team

- **File:** `src/daemon/runtime/skillify/miner.ts` (`extractPairsFromRows`, formerly used `stripThinking` only)
- **Class:** Captured-trace credential exposure → cross-tenant propagation (Stinger catalog `guides/04`).
- **Data flow:** `sessions` table (raw user/assistant turns, may contain a pasted token) → `extractPairs` → `buildGatePrompt` → gate model → `KEEP <name> <body>` / `MERGE` → `writeSkill` writes `verdict.body` VERBATIM into both the local `SKILL.md` (`skills-write.ts:renderSkillMarkdown`/`writeNewSkill`) and the append-only `skills` row (`appendVersion`, `val.text(skill.body)`). A cross-author MERGE promotes scope `me`→`team` (`skills-write.ts:404`), and `pull-client.ts:buildLatestSkillsSql` propagates the highest-version body to every teammate's `~/.claude/skills/<name>--<author>/SKILL.md`.
- **Why High not Critical:** Exploitation requires a user to actually paste a secret into a captured session AND the gate model to echo it into the body — but credential findings on the captured-trace surface are never downgraded below High (Stinger rule 4), and the blast radius is cross-tenant team propagation.
- **Pre-fix state:** `stripThinking` removed only `<thinking>…</thinking>` blocks. **No secret redaction existed.** The codebase's only redactor (`secrets/exec.ts:RollingRedactor`) is *value-based* (redacts known resolved secret values) and does not apply to mining arbitrary transcripts where the secret value is unknown in advance.

**Remediation applied (minimal blast radius):**
- Added `SECRET_PATTERNS` + exported `redactSecrets()` + `REDACTED` to `miner.ts` — high-confidence, low-false-positive patterns: PEM private-key blocks, JWTs (`eyJ…`), provider-prefixed keys (`sk-`/`sk-ant-`, `ghp_`/`gho_`/`ghs_`/`ghr_`, `github_pat_`, `xox[abprs]-`, `AIza…`, `AKIA…`, Hivemind/Activeloop `apdl_`/`hivemind_`/`hm_`), `Authorization: Bearer/Basic` headers, and `api_key|secret|token|password|client_secret = <value>` assignments.
- Introduced `sanitizeBody = redactSecrets(stripThinking(text))` — the single funnel **both** the prompt and the answer pass through inside `extractPairsFromRows`, so scrubbing happens BEFORE the pair reaches the gate prompt, the SKILL.md, the row, or the team.
- Exported `redactSecrets`/`REDACTED` from the skillify barrel (`index.ts`).
- Added a security test block to `tests/daemon/runtime/skillify/miner.test.ts` (2 tests): `redactSecrets` scrubs each shape + leaves benign text intact (low FP), and `extractPairsFromRows` scrubs a secret pasted into either the prompt or the answer.

This is **defense-in-depth**: the gate model is still precision-over-recall, but the deterministic scrub no longer depends on the model to omit a secret.

---

### M-1 (Medium, documented) — Redaction is pattern-based, not exhaustive

- **File:** `src/daemon/runtime/skillify/miner.ts:SECRET_PATTERNS`
- A pattern scrubber catches well-known credential shapes but cannot catch an arbitrary high-entropy secret with no recognizable prefix (e.g. a bespoke internal token, a raw password with no `password=` label). The fix raises the floor substantially without eliminating the long tail.
- **Recommended follow-up (not fixed — would exceed minimal blast radius):** an entropy-based heuristic at the mine boundary (flag long base64/hex runs above an entropy threshold), and/or feeding the user's *own resolved* `secrets/` values into a value-based scrub (reuse `RollingRedactor`) when the miner runs inside a session that resolved secrets. Track as a hardening item.

### L-1 (Low, documented) — Symlink fan-out swallows all errors silently

- **File:** `src/daemon-client/skillify/install.ts:fanOutSymlinks` (`catch {}` per link)
- The blanket per-link `catch` is intentional (win32 without `SeCreateSymbolicLink` privilege must degrade gracefully) and is **not a security hole** — but it also hides a genuine failure (e.g. a permission error masking tampering). Hygiene only; no action required. Consider a debug-level log of swallowed errors if observability is later needed.

---

## Affirmative theses (proven secure)

### 1. Gate-CLI shell-out CANNOT be command-injected — PROVEN

- `miner.ts:systemGateSpawner.run` spawns with **`spawn(spec.command, [...spec.args], { shell: false })`** — an args ARRAY, `shell:false`, no `/bin/sh` re-parse (`miner.ts:485`).
- The mined transcript (the only attacker-influenced data) is the **prompt**, fed as **inert stdin** (`child.stdin?.write(prompt); child.stdin?.end()`, `miner.ts:514`) — never interpolated into `command` or `args`.
- `spec.command` / `spec.args` are supplied by the daemon-assembly wiring (`HostCliSpec`), **not derived from a transcript**, so a hostile prompt containing `; rm -rf /`, `$(…)`, or backticks is passed verbatim to stdin and never executed.
- **Timeout:** the 120s timer calls `child.kill("SIGTERM")` then rejects (`miner.ts:494-501`); `runGate`'s `withTimeout` also rejects independently. In `mine`, the lock is released in the `finally` on success, empty batch, AND timeout/throw (`miner.ts:758-761`).
- Adversarial check: there is no code path where any field of a `MinedPair` flows into `spec.command`/`spec.args`. **No injection vector.** (a-AC-2 / a-AC-6 tests pass, including the explicit "shells out with an args array (shell:false), never a shell string" test.)

### 2. Symlink fan-out path safety — PROVEN

- `canonicalDirName(name, author)` → `sanitizeSegment` on **each half** (`install.ts:178`): `replace(/[^A-Za-z0-9._-]/g, "_")` then `replace(/\.\.+/g, "_")`, and any purely-dot segment → `"untitled"` (`install.ts:261-267`). A hostile `name`/`author` of `../../../etc/cron.d/evil`, an absolute path, or a `..` run collapses to a single inert segment — it **cannot traverse out of the skills root**.
- The symlink **target is always `canonicalDir`** — the just-written, sanitized canonical dir under the canonical root (`install.ts:235`). It is **never attacker-controlled**: `fanOutSymlinks` receives `canonicalDir` from the caller, not from the skill row.
- An existing path is left as-is (`pathExists`/`lstat`, no follow), so a pull cannot overwrite an arbitrary file via a pre-planted link, and creation is best-effort per link. The same `sanitizeSegment` guards `install-target.ts` (project/global SKILL.md) and the lock/watermark path segments (`miner.ts:642`, `watermark.ts:130`).
- **A symlink cannot be used to clobber a file outside the skills root.**

### 3. Through-the-daemon invariant — PROVEN

- The 016c thin client lives under `src/daemon-client/skillify/` and imports **only** the pure `../../daemon/storage/sql.js` helpers (`pull-client.ts:21`) — never the storage client. The daemon-runtime `install.ts` is a pure **re-export** of the thin client, so the barrel surface is unchanged while the storage-touching logic stays in the invariant-scanned non-daemon root.
- `tests/daemon/storage/invariant.test.ts` passes (3/3). `npm run audit:sql` now scans BOTH `src/daemon` and `src/daemon-client` (script default, `audit-sql-safety.mjs:57`) and reports clean over 132 files.
- 016b (`skills-write.ts`) runs daemon-side and reaches storage through the daemon's `StorageQuery` via the `SkillStore` seam — no re-opened DeepLake connection.

### 4. SQL injection (all interpolations) — PROVEN

- `miner.ts:createSessionFetcher`: identifiers via `sqlIdent`, the watermark/trigger-prefix/team-author values via `sLiteral` (→ `sqlStr`, doubles quotes + backslashes, strips control chars). The team filter builds `author IN ('a','b')` from per-value `sLiteral` — a hostile author can never break out of the literal (a-AC-4 test asserts the escaped SQL).
- `skills-write.ts`: writes via the guarded `appendOnlyInsert`/`val.*`; reads build SELECTs through `sqlIdent`/`sLiteral` (`resolveCurrentRow`).
- `pull-client.ts:buildLatestSkillsSql`: identifiers via `sqlIdent`; **no caller values** (scope is applied daemon-side as a partition filter) — statically injection-free.
- `audit:sql` = 0 findings (planted-bypass gate). The `"${tbl}"` double-quoting is benign — `sqlIdent`'s `^[A-Za-z_][A-Za-z0-9_]*$` regex rejects any quote/metachar.

### 5. Tenancy / scope — PROVEN

- Team filter `author IN (<team>)` escaped per-value via `sLiteral`/`sqlStr` (a-AC-4). Reads run under the org/workspace `QueryScope` / daemon partition filter, so a mine stays inside its tenant; no cross-org skill leakage path exists in the read builders.
- Scope promotion `me`→`team` happens **only** on a genuine cross-author MERGE of a locally-present target (`skills-write.ts:402-404`); it cannot be abused to leak a private skill because the promotion is recorded on the *target's* chain, and a hallucinated/absent target falls back to a private `me` new-skill (`mergeSkill` → `writeNewSkill(..., "me")`, b-AC-3).

### 6. Append-only integrity — PROVEN

- `SkillStore` has **no `update`/`delete` method by construction** (`contracts.ts:279-296`). Every write is `appendVersion` → `appendOnlyInsert` at version `MAX(version)+1` keyed by `<name>--<author>` (`skills-write.ts:166-189`, `352`, `408`). The active skill is the highest-version row, resolved poll-convergently. A malicious actor cannot overwrite or erase another author's history — each version is retained.

### 7. Auto-pull DoS / startup safety — PROVEN

- `autoPull` (`install.ts:129`): `HONEYCOMB_AUTOPULL_DISABLED=1` → `null` (c-AC-3); unauthenticated → `null` **silently** (c-AC-4, `createAuthCheck` reads only token PRESENCE, never echoes it); otherwise bounded by a 5s `withTimeout` whose timer is `unref`'d and **every error swallowed** → `null` (c-AC-2). A slow/hostile store loses to the timeout; a rejecting store loses to the catch — session start is never blocked and no token is leaked.

---

## Transcript-secret-into-skill verdict (item 3 — the subtle one)

**REAL RISK (pre-fix), now MITIGATED at the mine boundary.** The exfiltration chain (transcript secret → gate body → SKILL.md + `skills` row → team pull) was genuine and the gate model was the only thing standing between a pasted credential and team-wide propagation — a soft guarantee. I added a deterministic pattern-based `redactSecrets` scrub applied to both prompt and answer inside `extractPairsFromRows`, BEFORE the gate sees the data. Residual long-tail (arbitrary high-entropy secrets with no recognizable shape) is documented as M-1 with a recommended entropy-based follow-up. Recommendation in the dispatch ("recommend redaction at the mine boundary even if the gate is supposed to skip it") is **implemented**, not just recommended.

---

## Gate results (post-fix)

| Gate | Result |
|---|---|
| `npm run ci` (typecheck + jscpd dup + vitest + audit:sql) | **0** — 1105 passed, 4 skipped (97 files); +2 new redaction tests |
| `npm run build` (tsc + esbuild multi-harness) | **0** — 1 daemon + 5 hook + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed |
| `npm run audit:sql` | **0** — 132 files clean (`src/daemon` + `src/daemon-client`) |
| `npm run audit:openclaw` | **0** — bundle clean vs ClawHub rules |
| `tests/daemon/storage/invariant.test.ts` | **0** — 3/3 (thin-client invariant holds) |
| skillify suites (miner + skills-write + watermark + install + cli) | all green; **9 a-AC tests unchanged/passing — no AC weakened** |

> Note: the PRD-016 skillify source/test files are still **untracked** (`??`) on this branch — the feature is implemented but not yet committed; my edits live in those files and are exercised by the passing gates above. They will be committed at close-out alongside the rest of PRD-016. No unrelated tracked files were modified.

## Files changed (this audit)

- `src/daemon/runtime/skillify/miner.ts` — added `REDACTED`, `SECRET_PATTERNS`, `redactSecrets()`, `sanitizeBody()`; routed both prompt + answer extraction through `sanitizeBody`.
- `src/daemon/runtime/skillify/index.ts` — exported `redactSecrets` / `REDACTED`.
- `tests/daemon/runtime/skillify/miner.test.ts` — added the "skillify secret redaction (mine boundary)" describe block (2 tests) + `redactSecrets` import.
