# Security Audit — PRD-006 Memory Pipeline

- **Branch:** `prd-006-memory-pipeline`
- **Date:** 2026-06-17
- **Auditor:** security-worker-bee (runs immediately before quality-worker-bee)
- **Scope:** `src/daemon/runtime/pipeline/**` (config, model-client, contracts, stage-worker, handlers, extraction, decision, controlled-writes, graph-persist, retention, index) + the storage primitives they depend on (`src/daemon/storage/{sql,writes,vector,client}.ts`) + `tests/daemon/runtime/pipeline/**` and the three live integration tests. `hivemind-v1/` and `otherhive-v1/` explicitly out of scope.

---

## Executive Summary

**No Critical and no High findings. Nothing blocks the run.** The XL async distillation pipeline (extraction → decision → controlled-writes → graph-persist → retention) is built on a disciplined SQL-safety floor and a fail-closed config model. Every value that originates from model output (itself derived from attacker-controllable captured prompt text) is routed through the typed `val.*` → `renderValue` → `eLiteral`/`sLiteral`/`sqlStr` path or through `sqlStr`/`sqlIdent` directly, on every statement in all five stages — the dedup SELECT, the version-bump INSERT, the graph entity/dependency/mention upserts, the `memory_history` payload, and every retention DELETE/UPDATE. The `audit:sql` gate covers all 11 pipeline files and was adversarially proven to catch the raw-interpolation, string-concatenation, raw-identifier, and raw-value-into-DELETE bypass shapes.

The write brakes (`mutationsFrozen`, `shadowMode`, `autonomous.allowUpdateDelete`, `autonomous.frozen`) are all read exclusively from the zod-resolved config — never from model output or the job payload — so no crafted model response can flip them, and all default to the safe (no-mutation / no-purge) state. Tenancy is threaded on every read and write via the structurally-required `QueryScope.org` + an inline `agent_id` conjunct; no cross-tenant read, write, or purge path exists. Retention is set-based on age windows with a tombstone-first / best-effort-DELETE mechanism and cannot purge inside its retention window.

Three Medium/Low items are documented below (one PII-truncation-to-logs, one ILIKE wildcard-escaping precision note, one unbounded retention batch knob). One sub-5-line Medium was fixed in place.

**CVE/intel freshness:** `guides/06-cve-tracker.md` last refreshed 2026-04-24 (54 days; within the 120-day window). `npm audit --omit=dev` → 0 vulnerabilities. `npm run audit:openclaw` → clean.

**Ordering:** No `*-qa-report.md` exists for `prd-006-memory-pipeline`. quality-worker-bee has NOT run for this branch — ordering is correct (security before quality).

---

## Findings Table

| ID | Severity | Location | Issue | Status |
|----|----------|----------|-------|--------|
| F-1 | Medium | `src/daemon/runtime/pipeline/decision.ts:340` | `decision.unparseable` event logged `fact: fact.content.slice(0, 80)` — a truncated sample of captured-prompt PII to the structured log. | FIXED (drop content, log only length) |
| F-2 | Low | `src/daemon/storage/vector.ts:229` | `buildLexicalDegradeSql` escapes the model-derived `term` with `sqlStr` (injection-safe) but not `sqlLike`, so `%`/`_` in model content act as ILIKE wildcards. Recall-precision issue, not injection. | RECOMMENDED |
| F-3 | Low | `src/daemon/runtime/pipeline/config.ts:77-83` (`ClampedInt`), consumed at `retention.ts:227` / `vector.ts` | `retention.batchLimit` and the semantic/lexical limits are clamped to a positive integer with a floor (`min=1`) but no ceiling; an operator could set a very large `LIMIT`. Operator-controlled (trusted env), `Math.trunc`'d so not an injection vector. | RECOMMENDED |

No Critical findings. No High findings.

---

## F-1 (Medium) — Captured-prompt PII truncation leaked to structured log — FIXED

**Location:** `src/daemon/runtime/pipeline/decision.ts:340`

**Before:**
```ts
deps.logger?.event("decision.unparseable", { fact: fact.content.slice(0, 80) });
```

`fact.content` derives from the captured prompt/trace and is PII by the never-downgrade rule. Even truncated to 80 chars, emitting raw captured content into the daemon's structured log is over-capture: logs are a lower-trust sink than the `sessions`/`memory`/`memory_history` tables and are not subject to the retention sweep. This is the one spot in the pipeline that put raw model-fact content into a log line (every other event logs ids, counts, actions, reasons-about-config, or already-redacted fields). Per the rubric this is a Medium (truncated sample, debug-only event), and the fix is two lines, so it is remediated in-session.

**After (applied):**
```ts
deps.logger?.event("decision.unparseable", { factLength: fact.content.length });
```

The diagnostic signal (an unparseable model decision for a fact of length N) is preserved; the PII is not written to the log. The full fact content still lands in `memory_history.after_payload` (decision.ts:424) — that is the intended, in-scope, retention-governed audit trail (D-5), and it is NOT additionally logged.

**Proof:** `npm run test` → 368 passed (no regression); `npm run audit:sql` → clean; `npm run build` → all 10 bundles emitted.

---

## F-2 (Low) — Lexical-degrade ILIKE does not wildcard-escape model content — RECOMMENDED

**Location:** `src/daemon/storage/vector.ts:215-235` (`buildLexicalDegradeSql`)

```ts
const pattern = `'%${sqlStr(args.term)}%'`;
... WHERE ${textCol}::text ILIKE ${pattern} ...
```

`sqlStr` guarantees the term cannot break out of the literal (quotes/backslashes/NUL/controls handled) — so this is **not** a SQL-injection finding. But because the builder constructs an `ILIKE` pattern and uses `sqlStr` rather than `sqlLike`, a literal `%` or `_` inside model-derived `fact.content` is treated as an ILIKE wildcard. The security impact is nil (still scoped by `agent_id`, still inert as SQL); the impact is recall precision — a fact containing `%` could over-match candidates. **Recommendation (not blocking):** if exact-substring semantics are intended, switch to `sqlLike(args.term)` (which layers `%`/`_` escaping on top of `sqlStr`). Deferred to `retrieval-worker-bee` / `deeplake-dataset-worker-bee` as a recall-tuning decision, not a security fix — changing it without their input could alter intended fuzzy-match behavior.

---

## F-3 (Low) — Retention batch / recall limits have a floor but no ceiling — RECOMMENDED

**Location:** `src/daemon/runtime/pipeline/config.ts:77-83`, `retention.ts:227` (`LIMIT ${remaining}` via `batchLimit`), `vector.ts:192/227`

`ClampedInt(def, min=1)` truncates to an integer and floors at `min`, with no upper bound. `retention.batchLimit` flows to `LIMIT ${limit}` in the sweep selects, and the vector/lexical limits flow to `LIMIT ${fetchLimit}`. The value is `Math.trunc`'d (so it cannot carry SQL — not an injection vector) and is operator-set via trusted daemon-only env (`HONEYCOMB_PIPELINE_RETENTION_BATCH_LIMIT`), not attacker-controllable. The only risk is an operator typo issuing an unexpectedly large bounded scan. **Recommendation (not blocking):** add a sane ceiling to `ClampedInt` (e.g. `Math.min(max, ...)`) for `batchLimit` if defense-in-depth against operator error is desired. Left as a recommendation because it is config hygiene on a trusted surface, not a vulnerability.

---

## Focus-area verification (the brief's prioritized list)

### 1. SQL injection via MODEL-EXTRACTED content — VERIFIED SAFE

Every interpolation in the five stages was traced:

- **controlled-writes** — `buildMemoryRow` maps `content`/`normalized_content` via `val.text` (→ `eLiteral` → `sqlStr`), ids/enums/dates via `val.str` (→ `sLiteral`), confidence/`is_deleted` via `val.num` (inlined finite number), embedding via `val.raw(serializeFloat4Array(...))` (numbers-only literal). The dedup probe is `buildDedupCheckSql(hash)` (hash is a SHA-256 hex string). The INSERT is `buildInsert`/`appendVersionBumped` (every col via `sqlIdent`, every value via `renderValue`). `content_hash` dedup SELECT, version-bump INSERT, and history payload all covered.
- **decision** — candidate search uses `buildLexicalDegradeSql` (term via `sqlStr`) and `buildVectorSearchSql` (vector via `serializeFloat4Array`, validated 768-dim finite). `recordProposal` writes `after_payload` (full fact content) via `val.text` → `eLiteral`. `targetId`/`action`/`changed_by` via `val.str`. All `agent_id`/scope conjuncts via `sqlIdent`+`sLiteral`.
- **graph-persist** — entity `name`/`type`/`source_type`, dependency/mention ids and types, all via `val.str`/`val.text`; identifiers via `sqlIdent`; deterministic ids are SHA-256 hex. `isPresentById` probe uses `sqlIdent("id")` + `sLiteral(id)`.
- **retention** — every select/update/delete builds identifiers via `sqlIdent`, values (ids, cutoffs, agentId) via `sLiteral`, enum literals (`is_deleted`) via `String(NOT_SOFT_DELETED|SOFT_DELETED)` numeric constants.

A malicious fact content / entity name / reason (`'); DROP TABLE memories; --`, embedded quotes/backslash/NUL/unicode) collapses to one inert literal everywhere it lands. **Adversarial gate test:** injected a probe file with four raw-model-content-into-SQL shapes (`INSERT ... VALUES ('${content}')`, `SELECT ... = '` + content + `'`, raw `${tbl}` identifier, raw `${content}` into DELETE) into the pipeline dir; `audit:sql` flagged all 4 and would fail `ci`. Probe removed; tree confirmed clean.

```
$ node scripts/audit-sql-safety.mjs src/daemon/runtime/pipeline
SQL-safety audit: scanned 11 file(s) under src/daemon/runtime/pipeline/
OK - every SQL interpolation routes through an escaping helper.
# (adversarial probe run earlier flagged 4/4 bypasses, then was removed)
```

### 2. Prompt injection / model-output trust — VERIFIED SAFE

- A `delete`/`update` proposal is applied ONLY when `deps.config.autonomous.allowUpdateDelete` is set (controlled-writes.ts:432). That flag is config-only (`AutonomousConfigSchema`, env-resolved), never read from the model response or payload — a model cannot flip it.
- Confidence cannot be spoofed past the gate: `ConfidenceSchema = z.number().min(0).max(1)` with NO `.catch`, so an out-of-range/non-numeric confidence makes the whole `Fact`/`Proposal` invalid → dropped by `parseFact`/`parseProposal` → never reaches the write gate.
- Giant/deeply-nested model JSON cannot DoS the parser: extraction caps input to `inputCharCap` (~12k) BEFORE the model call, and `parseExtractionJson`/`balanceBraces` are linear single-pass scans; output is bounded to `maxFacts`/`maxEntities` with per-fact `maxFactChars`.
- `target_id` cannot point cross-tenant: it is a string the model supplies, but the version-bumped write is issued under the job's `QueryScope` (org/workspace) + `agent_id` conjunct, so an UPDATE/DELETE can only ever touch a row inside the job's own tenancy partition. A `target_id` referencing another org's row simply does not match under the scoped statement.

### 3. Write brakes can't be bypassed — VERIFIED SAFE (fail-closed)

`applyControlledWrite` checks `mutationsFrozen` FIRST (returns `skipped/mutations_frozen`), then `shadowMode` (returns `skipped/shadow_mode`) — frozen supersedes shadow, both BEFORE any action routing, so no proposal can reach a `memories` write under shadow or frozen. Both flags (and `autonomous.frozen` halting retention) come from zod config that defaults every boolean to `false` via `BoolFlag.default(false)` — a missing/garbled flag resolves to the SAFE state (no mutation, no purge). Retention gates `autonomous.enabled` then `autonomous.frozen` FIRST, before any storage call.

### 4. Tenancy isolation on every write + read — VERIFIED SAFE

`StorageClient.query` has no unscoped overload — `QueryScope.org` is structurally required and sent as the transport org header. Every stage threads `{org, workspace}` off the job envelope (`toStageJob`) and applies `agent_id` as an inline conjunct (decision `memoriesScopeFilter`, controlled-writes `buildMemoryRow.agent_id` + scoped write, graph `agent_id` on every row, retention `AND agent_id = sLiteral(agentId)` on every select/update/delete). The decision-stage hybrid candidate search is scoped via `buildScopeConjuncts` in the SAME statement as the match — no cross-tenant candidate leak. Retention never purges across tenancy (every purge select/delete is agent-scoped under the org QueryScope).

### 5. Retention over-purge / data-loss — VERIFIED SAFE

Every step is set-based on an age window (`<= cutoff`) + tombstone state, never a cursor — so a row inside the retention window (newer than `cutoff`) is never selected. Decay runs BEFORE the tombstone purge so a freshly-tombstoned row is not purged the same run (it keeps its full tombstone window). Tombstone (`is_deleted=1`) is honored by recall's `NOT_SOFT_DELETED` filter immediately, so a tombstoned row is genuinely excluded from recall regardless of whether the best-effort physical DELETE lands (D-8). The batch budget is a single shared positive-integer cap; the sweep stops mid-order and yields when exhausted (idempotent resume).

### 6. PII in the pipeline — ONE Medium FIXED, otherwise SAFE

Structured logs emit ids, counts, actions, reasons-about-config, and lengths — not full fact content / model output / memory bodies — with the single exception F-1 (truncated 80-char fact sample), now fixed to log only `factLength`. The `memory_history.after_payload` carrying full fact content is the intended audit trail (D-5), written to the table and NOT additionally logged. No token / credential is logged anywhere in the pipeline (the storage client redacts org and never interpolates the token).

### 7. Model client / DoS — VERIFIED SAFE

Extraction caps (12k input before the call, 20 facts, 50 entities, 500 chars/fact) are enforced in `extractFromText`/`boundFacts`/`boundEntities` and cannot be bypassed by model output (they bound the parsed result, not the model's promise). The stage-worker routes a handler throw to `queue.fail` (backoff → dead at max attempts); a non-pipeline `kind` is failed, not looped; a crash leaves a stale lease the reaper reclaims — a poison job walks to dead and does not infinite-loop.

### 8. Supply chain — VERIFIED CLEAN

`npm audit --omit=dev` → `found 0 vulnerabilities`. `npm run audit:openclaw` → clean. No hallucinated/unexpected deps introduced by the pipeline (pipeline imports are all intra-repo + `zod` + `node:crypto`).

---

## Gate / verification command output

| Command | Result |
|---|---|
| `npm run audit:sql` | OK — 46 files scanned, every interpolation routed through a helper (11/11 pipeline files covered) |
| `npm run audit:openclaw` | OK — bundle clean against ClawHub rules |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `npm run build` | OK — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon bundle @ 0.1.0 |
| `npm run test` | 31 files / 368 tests passed |
| adversarial `audit:sql` probe | 4/4 model-content-into-SQL bypass shapes flagged (then removed) |

`npm run ci` = typecheck + dup + test + audit:sql; the build (tsc) and the test + audit:sql legs were each run green above. No write stage was modified except the F-1 log-field change (no SQL change), so the live write tests do not require a re-run for correctness; the unit suites covering controlled-writes / graph-persist / retention pass.

---

## Files changed

| File | Change |
|---|---|
| `src/daemon/runtime/pipeline/decision.ts` | F-1: `decision.unparseable` log now emits `factLength` (number) instead of `fact: content.slice(0,80)` — removes captured-prompt PII from the log line. One-line change; no SQL, no behavior change beyond the log field. |

`git diff` confirms the diff contains only the F-1 log-field change — no unrelated edits, no opportunistic refactoring.

---

## Unresolved Critical / High

**None.** No Critical or High findings were identified. Nothing blocks the run. quality-worker-bee may proceed.
