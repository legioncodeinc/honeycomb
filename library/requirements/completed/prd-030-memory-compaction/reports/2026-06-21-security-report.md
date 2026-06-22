# PRD-030 Memory Compaction — Security Close-Out Report

- **Date:** 2026-06-21
- **Branch:** `prd-030-memory-compaction`
- **Auditor:** security-stinger (ARMED close-out)
- **Scope:** ONLY the PRD-030 change set — the storage-level version-history reaper, its daemon route, the CLI verb, the assemble seam, and the gated live itest.
- **Verdict:** **PASS at Medium+** after remediation. Two High-severity findings were found and **fixed in place**; one Low is reported. No Critical found. No path exists to reap current state or another tenant's data.

---

## Verdict (one paragraph)

The reaper's **load-bearing destructive-op safety holds**: the highest version per key is never reaped (strictly-below-highest by construction in `computeReapSet`), the survivor is confirmed durable poll-convergently before any DELETE, every statement carries the `QueryScope` (no cross-tenant reach), every identifier routes through `sqlIdent` and every value through `sLiteral`/numeric-inline (SQL-injection-clean, `audit:sql` green), and the DELETE is bounded by the per-key reap set (no reap-storm / unbounded delete). **However**, two High findings were identified and remediated: (H-1) the documented "fail-closed allow-list" guard (`isVersionBumpedTable`/`assertVersionBumpedTable`) admitted **every** catalog `version-bumped` table — including `memory_jobs` (durable queue) and `api_keys` (credential-revocation lineage) — far wider than the 5-table intent; the shipped route was not exploitable (the API selector narrows to the 5-table set), but the exported compactor guard was a latent destructive-op over-reach on the exact invariant the PRD calls load-bearing. (H-2) the per-table key-column map in `compact-api.ts` pinned **wrong key columns** for `skills`, `entity_attributes`, and `epistemic_assertions`, so compaction would mis-model "highest-version-per-key" (silently no-op in production, and a latent footgun). Both are fixed, with regression tests added; `typecheck`, the affected unit suites (34 tests), the assemble suite (28 tests), `audit:sql`, and `audit:openclaw` are green.

---

## Deterministic scan results

| Scan | Result |
|------|--------|
| `npm run audit:sql` | **OK** — 169 files; every SQL interpolation routes through an escaping helper. |
| `npm run audit:openclaw` | **OK** — bundle clean against ClawHub static-analysis rules. |
| `npm audit` | 10 pre-existing baseline vulns (6 low / 3 moderate / 1 high). **No dependency change in this PRD** (`package.json`/`package-lock.json` untouched) — out of scope; belongs to the standing CVE watchlist / dependency-audit-worker-bee. |
| `npm run typecheck` | **OK** (post-fix). |

---

## Findings by severity

### CRITICAL — none detected
Destructive-op safety, SQL injection, cross-tenant reach, and DoS were all examined against the reaper and route; no Critical issue found. See "Destructive-op safety analysis" below for the explicit confirmation.

---

### HIGH-1 — Fail-closed allow-list guard was wider than intent (latent destructive over-reach) — **FIXED**

- **Where:** `src/daemon/storage/compaction.ts:221` (`isVersionBumpedTable`) / `:231` (`assertVersionBumpedTable`).
- **Evidence (pre-fix):** the authoritative guard returned `true` for *any* table whose catalog `pattern === "version-bumped"`. The catalog marks **10** tables version-bumped:
  `entity_attributes`, `epistemic_assertions`, `skills`, `rules`, `dreaming_state`, **`memory_jobs`** (`catalog/runtime-jobs.ts:131`), **`api_keys`** (`catalog/tenancy.ts:234`), **`memory_artifacts`** / **`document_memories`** / **`document_chunk`** (`catalog/sources.ts:245/252/259`).
  The module header claims the allow-list is "the single source of truth … ONLY a `pattern === "version-bumped"` table" and equates that with *compactable*. But `memory_jobs` (in-flight durable job state lives in lower versions), `api_keys` (credential-revocation lineage), and the `sources` document tables (source-of-truth retention owned by PRD-007/retention) are version-bumped yet **catastrophic to reap**.
- **Exploitability:** NOT exploitable through the shipped HTTP route — `compact-api.ts` `selectTables()` constrains the per-request table set to the explicit `COMPACTABLE_VERSION_BUMPED_TABLES` (5 tables), so `memory_jobs`/`api_keys`/sources are never sent to the compactor. The hole is in the **exported** `compactVersionHistory`/`createVersionCompactor` guard (`src/daemon/storage/index.ts` re-exports them): any future in-repo caller trusting the "fail-closed allow-list" docstring could reap a durable-queue or credential-revocation chain. This is a defense-in-depth failure on the PRD's stated load-bearing property (fail-closed allow-list).
- **Fix:** `isVersionBumpedTable` now requires **BOTH** allow-list membership AND the catalog `version-bumped` pattern:
  ```ts
  return COMPACTABLE_VERSION_BUMPED_TABLES.has(table) && REGISTRY.patternFor(table) === "version-bumped";
  ```
  `assertVersionBumpedTable`'s error message now distinguishes "version-bumped but not on the allow-list (never reapable)" from "not version-bumped". The inner guard now matches the documented intent and the outer API selector — the over-reach is closed at the authoritative layer.
- **Regression tests added** (`tests/daemon/storage/compaction.test.ts`):
  - `isVersionBumpedTable("memory_jobs"|"api_keys"|"memory_artifacts"|"document_memories"|"document_chunk")` → `false`.
  - `compactVersionHistory(..., { table: "memory_jobs" }, ...)` → rejects with `CompactionRefusedError`, **zero statements issued**.

### HIGH-2 — Wrong per-table key column mis-models "highest-version-per-key" — **FIXED**

- **Where:** `src/daemon/runtime/maintenance/compact-api.ts:81` (`COMPACTABLE_KEY_COLUMNS`).
- **Evidence (pre-fix):** `skills → "key"`, `entity_attributes → "id"`, `epistemic_assertions → "id"`. All three contradict the tables' real version-chain keys:
  - **`skills`** has **no `key` column** (`SKILLS_COLUMNS` = `id, name, project_key, …`). The writer/reader resolve current state per **`id`** (`skills-write.ts:129-136` `WHERE id = … ORDER BY version DESC LIMIT 1`; `product/api.ts:151` `buildHighestVersionSql("skills", "id", …)`).
  - **`entity_attributes`** version-bumps per **`claim_key`** (`ontology/supersede.ts:183` "the version chain is keyed by the slot's `claim_key`"; `id` is **unique per version** via `attributeVersionId(aspectId, slot, version)`, `supersede.ts:250`).
  - **`epistemic_assertions`** highest-active read is per **`claim_key`** (`ontology/control-plane.ts:586` `WHERE claim_key = … ORDER BY version DESC LIMIT 1`).
- **Impact:** with the wrong key column, "highest version per key" is mis-resolved. For `skills` (`key` column absent) the discover query errors → empty key set → **silent no-op** (so the headline feature does NOT bound `skills` history — the PRD's primary target). For the claim tables keyed by a per-version-unique `id`, every row is a singleton chain → reap set always empty → **silent no-op**. Fails safe (never destructive in the current schema), but it is a latent footgun: keying by a column that does NOT uniquely identify one logical version chain is the precondition for resolving a *cross-entity* "highest" and reaping a current row. The live itest masked this — it used a bespoke throwaway table with a `compaction_key` column + an injected guard, never the real `skills→id` / `*→claim_key` mappings.
- **Fix:** key columns corrected to the verified version-chain keys — `skills → "id"`, `rules → "key"`, `entity_attributes → "claim_key"`, `epistemic_assertions → "claim_key"`, `dreaming_state → "id"` — with a JSDoc note that a wrong key column is a SAFETY bug, not a no-op.
- **Test updated** (`tests/daemon/runtime/maintenance/compact-api.test.ts`): the key-column assertions now pin the corrected columns (the prior test asserted the defective values — it encoded the bug, not a requirement; this is a root-cause fix, not an AC weakening).

---

### LOW-1 — Compaction structured log carries the per-key value (`key`) — reported, not changed

- **Where:** `src/daemon/storage/compaction.ts` `compaction.key.reaped` / `compaction.key.skipped` events log the `key` field (the `claim_key` / skill `id` / `dreaming_state` `id`).
- **Assessment:** these key values are deterministic identifiers (a sha-derived `claim_key`, a skill `id`, a per-scope counter `id`) — **not raw prompts, not credentials, not free-text PII**. The summary body returned to the CLI and the HTTP response carry only table names + counts + version numbers (no key value, no secret) — confirmed in `compact-api.ts` (`CompactSummaryBody`) and `commands/maintenance.ts` (`renderSummary` prints only table/counts). The reaped-count log lines are emitted to the daemon's own stderr/ring-buffer log channel. The `key` is the minimum needed to make a reaped-count line actionable per-key (D-5), and the log group already excludes token/header/body. **No remediation required**; documented so the category is on record. If logged keys are later considered sensitive, redact `key` to a hash prefix in the two `event(...)` calls.

---

## Destructive-op safety analysis (the load-bearing property — explicit)

> **Does any path exist to reap current state, the highest version, a source-backed claim, or an arbitrary / cross-tenant table?** — **No.**

1. **Highest version never reaped (by construction).** `computeReapSet` (`compaction.ts:286`) only adds `row.version` when `row.version < highest`; the highest is skipped at the top of the loop (`if (row.version >= highest) continue;`). The DELETE's `IN (...)` list is built solely from this reap set. Unit-tested (`compaction.test.ts` AC-5 / highest-never-reaped) and live-proven (itest AC-1/AC-3/AC-5: highest byte-identical pre/post).
2. **Survivor confirmed durable before any DELETE (D-3).** `confirmSurvivorDurable` poll-resolves `ORDER BY <ver> DESC LIMIT 1` and requires `v >= highest`; a key whose survivor cannot be confirmed is **skipped, never reaped** (`compactKey` returns `"skipped"`). Combined with "only delete strictly-lower versions," a concurrent `ORDER BY version DESC LIMIT 1` reader can never go transiently empty or non-current (itest AC-3, every poll-convergent observation === highest).
3. **Idempotent + crash-safe (D-4).** Each pass recomputes the reap set from the current view; a re-run on a compacted key finds nothing (itest AC-4 settled no-op). A partial/flappy DELETE leaves a strictly-smaller-but-correct table; a re-run completes to the bound (itest AC-5).
4. **Fail-closed table guard (D-6) — now correctly narrow (HIGH-1 fix).** An unknown table, an append-only event table (`sessions`), an `update-or-insert` table, OR a version-bumped-but-not-allow-listed table (`memory_jobs`/`api_keys`/sources) is **refused before a single row is touched** (`assertVersionBumpedTable` throws `CompactionRefusedError`; the fake records zero SQL). The `isCompactable?` test-seam (`CompactionOptions`) defaults to this catalog+allow-list guard when omitted; **no production path passes it** (`realCompactSeam` calls `compactVersionHistory(client, target, scope, opts)` with no `isCompactable`; the only injector is the gated live itest, whose predicate NARROWS to one throwaway `ci_compaction_<run>` name). Confirmed by grep: the sole non-test callers are `compact-api.ts` (`realCompactSeam`) and `createVersionCompactor` (unused in production wiring).
5. **Tenant / scope isolation.** All four statements (discover / resolveVersions / confirmSurvivor / deleteVersions) carry `this.scope` (`compaction.ts:544/627/678/714`), the daemon `defaultScope` or the header-resolved scope, applied by the storage client as the tenancy partition. A compaction in one org/workspace cannot reach another's rows.
6. **SQL injection.** `compaction.ts` constructor pre-validates `keyColumn`, `versionColumn`, `timestampColumn`, and `table` via `sqlIdent` (throws on anything outside `[A-Za-z_][A-Za-z0-9_]*`); the key value goes through `sLiteral`; the version `IN (...)` list is numeric-only (`String(Math.trunc(v))`). `IdentColumn`/`ClampedInt` zod preprocessors reject a garbage env knob before it reaches `sqlIdent`. `audit:sql` green.
7. **DoS / reap-storm.** The route is bounded by the fixed 5-table allow-list; each table's pass is bounded by the discovered key set + a fixed `RESOLVE_POLLS=8` poll budget; each key issues exactly ONE bounded DELETE (`<key> AND <version> IN (<reap set>)`) — no unbounded `DELETE FROM <table>`, no unbounded fan-out. `--table` only NARROWS within the allow-list (`selectTables` returns `[]` for an off-allow-list name, so the compactor guard is never even reached).

---

## Route / CLI / assemble surface

- **`compact-api.ts` scope resolution** mirrors the already-audited `mountDreamApi` (`resolveCompactScope` ≡ `resolveTriggerScope`): header org → daemon default → fail-closed `400` when neither resolves. The route rides the `protect:true` `/api/diagnostics` group (`server.ts`), open in `local` (loopback single-user dogfood), gated by auth/RBAC in team/hybrid. The known `x-honeycomb-org` header-trust hardening is the SAME deferred ticket already tracked for the diagnostics group — **not a new hole introduced by PRD-030**. Consistent with established posture.
- **Missing table is skipped, not 500** (`compactOneTable` probes `tableExists` first; `false` → skip, `null` transient → fail-open onto the compactor's own poll-convergent floor). Per-table compaction error folds into an `errored` count (fail-soft); never aborts the pass or 500s.
- **No secret/PII in the response or CLI render** (table names + counts + version numbers only) — `CompactSummaryBody`, `renderSummary`.
- **CLI verb** (`commands/maintenance.ts`) is a thin loopback client: builds a `DaemonRequest`, dispatches through `deps.daemon.send`, renders counts; imports no `daemon/storage`, holds no SQL; `--table` only forwarded as a body selector; no injection via args (the daemon's allow-list is the gate). Acks no secret.
- **assemble seam** (`assemble.ts` step 11) fires `mountCompact` inside a `try/catch` that degrades a mount/config error to a non-fatal stderr line — a compaction mount/run error never crashes the daemon; the seam runs under the daemon's own `defaultScope`.
- **Live itest** (`compaction-live.itest.ts`): gated on `HONEYCOMB_DEEPLAKE_TOKEN` (`describe.skipIf`), `.itest.ts` outside the `*.test.ts` glob and `tests/integration/**` excluded, per-run throwaway `ci_compaction_<run>` table DROPped in `afterAll`, injected NARROWING `isCompactable` guard, token read only from env via the storage layer — never hardcoded/logged/echoed. No secret committed.

---

## Fixes applied (minimal blast radius)

| File | Change |
|------|--------|
| `src/daemon/storage/compaction.ts` | HIGH-1: `isVersionBumpedTable` now requires allow-list membership AND catalog `version-bumped`; `assertVersionBumpedTable` message disambiguates the two fail-closed arms. |
| `src/daemon/runtime/maintenance/compact-api.ts` | HIGH-2: `COMPACTABLE_KEY_COLUMNS` corrected to the real version-chain keys (`skills→id`, `entity_attributes`/`epistemic_assertions`→`claim_key`); JSDoc notes a wrong key column is a safety bug. |
| `tests/daemon/storage/compaction.test.ts` | Regression: `memory_jobs`/`api_keys`/sources rejected by guard + `compactVersionHistory(memory_jobs)` refuses with zero SQL. |
| `tests/daemon/runtime/maintenance/compact-api.test.ts` | Updated key-column assertions to the corrected (verified) columns. |

## Gate results after fixes

| Gate | Result |
|------|--------|
| `npm run typecheck` | PASS |
| `tests/daemon/storage/compaction.test.ts` | PASS (23) |
| `tests/daemon/runtime/maintenance/compact-api.test.ts` | PASS (11) |
| `tests/daemon/runtime/assemble.test.ts` | PASS (28) |
| `npm run audit:sql` | PASS |
| `npm run audit:openclaw` | PASS |

## Discipline confirmations

- No AC/test weakened to pass a finding — HIGH-2's test change is a root-cause correction (the prior test asserted the defective key columns).
- No `git add` performed. No new dependencies. Diff confined to the four files above plus the audited PRD-030 change set.
