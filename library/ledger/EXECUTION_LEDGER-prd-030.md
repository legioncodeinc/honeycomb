# EXECUTION LEDGER — PRD-030 Memory Compaction (bound version-bump growth)

> Orchestrator: `/the-smoker` · Branch: `prd-030-memory-compaction` · SSOT for AC tracking.
> Goal: fill the storage-level version-history compactor gap so `appendVersionBumped` tables don't grow
> unboundedly — reap superseded/old `version` rows below the highest live version + a retention window, WITHOUT
> losing current state (byte-identical highest read) or auditable recent lineage. Eventual-consistency-safe,
> idempotent, crash-safe. Primary path: a standalone `honeycomb maintenance` job (NOT gated behind premium
> pollinating); optionally also a pollinating-pass step when PRD-026 is enabled.

## Phase 0 recon facts (for the bees)
- **`appendVersionBumped`** (`src/daemon/storage/writes.ts`): INSERTs version N+1 per edit; read = `ORDER BY <versionColumn> DESC LIMIT 1`. `keyColumn` + `versionColumn` are CONFIGURABLE (versionColumn defaults `version`). `readMaxVersion`/`readLatestVersion` are the resolve-highest helpers (heal-aware). The compactor reaps the HISTORY of this pattern; it must NEVER touch the highest version row per key.
- **DeepLake hard `DELETE` is UNRELIABLE/flappy** (`pipeline/retention.ts:45` — "PRD-004 proved it"), yet retention.ts DOES use guarded `DELETE FROM "<tbl>" WHERE …` for its purge (lines ~398/425/470) — that is the guarded-DELETE pattern to REUSE. The unreliability is exactly why the compactor must (a) resolve the survivor POLL-CONVERGENTLY and confirm it durable BEFORE reaping (D-3), and (b) be IDEMPOTENT — a re-run recomputes the reap set and re-deletes anything a prior flappy DELETE left behind (D-4). It converges.
- **Poll-convergent resolve** posture: `pollinating/trigger.ts` `RESOLVE_POLLS` + `readState` (keep MAX across a bounded poll union; append-only versions are monotone so a single read can only under-report). MANDATORY for resolving highest-version-per-key and every read-back assertion (DeepLake flaps stale segments — project memory note).
- **SQL guards**: every value via `sLiteral`/`val.*`, every identifier via `sqlIdent` (`storage/sql.ts`). `audit:sql` scans `src/daemon`.
- **Throwaway-table isolation**: the live counter smoke + the pollinating-counter itest point the trigger at a per-run namespaced `ci_*_<runId>` table via a `tableName` seam and DROP it in `afterAll`. The compaction live itest reuses this — NEVER a real `pollinating_state`/skills/rules table.
- **Scope (D-6)**: version-bumped tables ONLY (skills, rules, claim history, `pollinating_state`-style counters). NOT `appendOnlyInsert` event tables (sessions/raw events — no version concept; retention is PRD-007's concern).

## Acceptance criteria

| AC | Criterion (abbrev) | Status | Owner |
|----|--------------------|--------|-------|
| AC-1 | Bounds row count, current read UNCHANGED (behavioral): seed N=50 versions of one key → compact → rows/key ≤ K, highest-version read BYTE-IDENTICAL pre/post, total row count strictly dropped. Poll-convergent read-back. | VERIFIED | W1+W2b |
| AC-2 | Retention window honored: keep highest ALWAYS + keep-latest-N + any version inside the time window; only versions outside BOTH are reaped. Seeded recent+old mix. | VERIFIED | W1 (unit) + W2b (live) |
| AC-3 | Eventual-consistency safe: a concurrent highest-version read during/after a pass NEVER returns empty and NEVER a non-current version. Interleaved poll-convergent reader vs live compaction on a throwaway table. | VERIFIED | W2b |
| AC-4 | Idempotent: compact twice → reaps pass 1, no-op pass 2 (zero deleted, current read byte-identical). | VERIFIED | W1 (unit) + W2b (live) |
| AC-5 | Crash-safe: a pass interrupted mid-reap (simulated partial delete) leaves highest readable + retained window intact; a re-run completes to the bound; no lineage hole dropping the survivor. | VERIFIED | W1 (unit) + W2b (live) |
| AC-6 | Lineage + safety + gates: no source-backed current claim reaped (it's the highest version); reaped counts LOGGED per table/key; `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/invariant pass; live itest gated (skip in CI) + throwaway-table isolated. | VERIFIED | W1/W2/close-out |

## Decisions locked (from the PRD)
- D-1 retention = keep highest ∪ keep-latest-N ∪ inside-time-window (conservative default N=5 + 30-day window). Below window AND below N → reap-eligible.
- D-2 PRIMARY = standalone maintenance job via a `honeycomb maintenance` verb (runs regardless of premium pollinating); OPTIONAL = also a step of a pollinating pass when 026 enabled.
- D-3 reap order = resolve highest poll-convergent → confirm durable → DELETE eligible lower versions (never delete the only readable copy; never let a concurrent `ORDER BY version DESC LIMIT 1` go transiently empty).
- D-4 idempotent + crash-safe by construction (recompute reap set from current view each run; survivor set always ⊇ {highest} ∪ {window}).
- D-5 lineage: reap only OUTSIDE the retention window; log reaped counts.
- D-6 version-bumped tables only.

## Wave plan

**Wave 1 — foundational compactor core (`deeplake-dataset-worker-bee`, Opus).** Owns the storage-level version-history reaper. Must land + unit-green before the live proof.
- NEW `src/daemon/storage/compaction.ts` (storage-level — NOT `runtime/pollinating/compaction.ts`, which is graph-prompt assembly): a guarded version-history reaper.
  - `compactVersionHistory(client, target, scope, opts)`: discover keys (`SELECT DISTINCT <keyColumn>`), per key resolve highest version POLL-CONVERGENTLY, compute the reap set per D-1 (strictly below highest AND beyond keep-latest-N AND outside the time window — needs a timestamp column; make it configurable, default `updated_at`/`created_at`), confirm the survivor durable, then guarded `DELETE FROM … WHERE <key>=… AND <version> IN (…)` (reuse the retention.ts guarded-DELETE pattern), idempotent + crash-safe, log reaped counts. Returns a `CompactionSummary`.
  - Retention config (zod, conservative defaults N=5 + 30d) mirroring `pollinating/config.ts` coerce-and-clamp.
  - A version-bumped-table allow-list/guard (D-6).
  - Unit tests (fake storage): reap-set math, AC-2 retention-window-honored, AC-4 idempotent re-run no-op, AC-5 crash-safe partial reap, highest-never-reaped. Export `createVersionCompactor`/`compactVersionHistory` + types. NO assemble edit.

**Wave 2a — standalone maintenance verb + wiring (`typescript-node-worker-bee`).** After W1 compiles. Single owner of `assemble.ts` + `src/commands`.
- `honeycomb maintenance` CLI verb (e.g. `maintenance compact [--table …]`) + a daemon route (`POST /api/diagnostics/compact` onto the existing protected `/api/diagnostics` group, mirroring `mountPollinateApi`) that runs the compactor over the version-bumped tables under the daemon scope. OPTIONAL: also invoke compaction as a step of a pollinating pass when `config.enabled` (D-2 coupling). Started/wired in assembly; fail-soft. Unit tests + assemble.test extension.

**Wave 2b — gated live proof (`deeplake-dataset-worker-bee`, parallel with 2a).** After W1 compiles.
- `tests/integration/compaction-live.itest.ts` (gated on `HONEYCOMB_DEEPLAKE_TOKEN`, skip-safe): throwaway namespaced version-bumped table (DROP in afterAll). Seed 50 versions of one key → compact → AC-1 (rows ≤K, highest read byte-identical, count dropped, poll-convergent); AC-2 (recent+old mix); AC-3 (interleave a poll-convergent reader against a live compaction → never empty/non-current); AC-4 (idempotent re-run); AC-5 (simulated partial-reap → re-run completes). Reuse the pollinating-counter itest's isolation + poll helpers.

**Close-out** — `security-worker-bee` (security-stinger) → `quality-worker-bee` (quality-stinger).

## Constraints (verbatim, in force)
- Live creds in `.env.local` (gitignored): `set -a; . ./.env.local; set +a`. NEVER paste the token into chat.
- Explicit `git add <paths>`, NEVER `-A`. Keep `.agents/.codex/.claude/.cursor`/`AGENTS.md`/`.env.local`/`.secrets` OUT of commits. Verify new files aren't gitignore-swallowed before pushing.
- A daemon is running on 127.0.0.1:3850 with pollinating enabled — leave it running.
- Every live read-back POLLS to convergence — never a single immediate read (esp. after a DELETE).

## Live proof receipt (2026-06-21, real DeepLake, throwaway `ci_compaction_<run>` table)
`tests/integration/compaction-live.itest.ts` — **5/5 PASS**:
- AC-1: 50 versions of one key → compact → rows ≤K, highest-version read BYTE-IDENTICAL, total strictly dropped (poll-convergent, idempotent re-run absorbs flappy DELETE — bounds never weakened).
- AC-2: keepLatestN small + windowDays=30 → recent/windowed + current survive, old-and-beyond-N reaped.
- AC-3: a POLL-CONVERGENT highest read interleaved with a live compaction NEVER returns empty and NEVER below-highest (the PRD's mandated read posture; a single immediate read flaps on this backend independent of compaction — the compactor confirms the survivor durable before reaping + only deletes strictly-lower versions, so the poll-convergent resolve always converges to the true current). [first run failed on a single-read bar that tested backend flakiness, not compaction safety; corrected to the poll-convergent read the PRD specifies — safety bar unweakened.]
- AC-4: compact twice → reaps pass 1, no-op pass 2, highest byte-identical.
- AC-5: partial guarded DELETE of eligible versions → re-run completes to the bound; survivor never at risk.
All ACs PASS. Full gates green: `npm run ci` (193 files, 1996 passed, 5 skipped), build, audit:sql, audit:openclaw, smoke:daemon-bundle all clean. → Phase 2 close-out.

## Close-out (security → quality, correct order)
- **Security (security-stinger): PASS after fixing TWO High bugs** — (HIGH-1) the allow-list admitted ALL catalog version-bumped tables incl. `memory_jobs`/`api_keys` → tightened to the intended 5-table set ∩ catalog pattern, fail-closed; (HIGH-2) wrong per-table key columns → a silent production no-op on skills/claim tables → corrected. Destructive-op safety explicitly cleared: highest-never-reaped (by construction), survivor-confirmed-durable-before-DELETE, fail-closed allow-list, scope isolation, SQL-injection-clean, bounded DELETE. No path to reap current state or another tenant's data.
- **Quality (quality-stinger): reopened AC-6 with 1 Critical (C-1)** that security MISSED — `epistemic_assertions` was mis-keyed `claim_key` (its writer `control-plane.ts:483` keys by `id`) → silent no-op on that table. Everything else VERIFIED (highest-never-reaped enforced pure + at-SQL; AC-3 poll-convergent correction faithful + safety bar hard-asserted; allow-list fail-closed; `isCompactable` seam narrows-never-widens; pollinating coupling honestly skipped).
- **C-1 fixed (root cause)**: `epistemic_assertions → id` in `COMPACTABLE_KEY_COLUMNS`; all 5 tables writer-cross-checked (skills→id, rules→key, entity_attributes→claim_key, pollinating_state→id, epistemic_assertions→id); a table-driven WRITER_KEYED_BY regression guard + map-lock test added so a future key-column drift fails the unit suite instead of silently no-opping. Orchestrator fresh-pass verified (map value `id`, writer `control-plane.ts:483 keyColumn:"id"`, guard present). AC-6 now VERIFIED.

## Status log
- Phase 0 recon complete; branch cut, PRD moved backlog→in-work.
- Wave 1 (compactor core, 21→23 unit tests) + Wave 2a (maintenance verb/route/wiring) + Wave 2b (gated live itest) landed green. Live AC-1..AC-5 proven (AC-3 reader corrected to poll-convergent per PRD wording).
- Security PASS (2 High fixed) → Quality reopened AC-6 (C-1) → C-1 fixed + writer-cross-check guard → ALL ACs VERIFIED. Full suite 2004 passed / 5 skipped; build, smoke:daemon-bundle, audit:sql, audit:openclaw clean. → Phase 3 ship.
