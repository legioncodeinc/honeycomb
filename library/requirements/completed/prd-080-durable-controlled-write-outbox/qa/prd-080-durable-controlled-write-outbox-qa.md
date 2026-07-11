# QA Report — PRD-080: Durable Controlled-Write Outbox (BUG-04b)

> **Auditor:** quality-worker-bee
> **Date:** 2026-07-11
> **Branch / worktree:** `feat/prd-080-controlled-write-outbox` @ `honeycomb-prd080` (uncommitted working tree)
> **Source of truth:** `prd-080-durable-controlled-write-outbox-index.md` (AC tables 080a / 080b / 080c)
> **Order:** runs AFTER `security-worker-bee` (CLEAN at High+, 2 Lows documented) — ordering correct.
> **Verdict:** **SHIP** (with one non-blocking Warning; all 16 verifiable ACs PASS, a-AC-8 VERIFIED-by-mechanism).

---

## 1. Summary

PRD-080 is implemented faithfully to its spec across all three phases. Every acceptance criterion I could verify against code + tests (a-AC-1..7, b-AC-1..5, c-AC-1..4) PASSES, each backed by a non-tautological test that exercises the real production path (stubs sit only at the `StorageQuery`/DeepLake transport boundary; the classification, enqueue, SQLite persistence, drain-replay, dedup, coalescing, dead-letter, and re-drive logic are all real code). The two trickiest guarantees — the **safety invariant** (a genuine non-transient failure still throws at BOTH the dedup-probe and INSERT branches, never an unguarded duplicate) and **dedup-idempotency under replay + coalescing** — hold under direct inspection and test. The full `npm run ci` is green (4893 passed / 13 skipped, jscpd + typecheck + audit:sql OK, no flake this run). a-AC-8 (live dogfood) is graded **VERIFIED-by-mechanism** via a QA-authored fault-injection integration test through the real controlled-write path. One Warning: outbox-drained recoveries bypass the `MemoryFormationTracker`, so `committedSinceBoot` — the signal BUG-04's Verify criteria explicitly names — does not count drain-recovered memories (durability is unaffected; only that health counter understates recovery).

---

## 2. Scorecard (five axes)

| Axis | Status | Notes |
|------|--------|-------|
| **Completeness** | PASS | All 13 code ACs (a1-7, b1-5, c1-4) implemented; a-AC-8 proven by mechanism. Re-drive command + route + CLI all present. |
| **Correctness** | PASS | Safety invariant airtight at both branches; dedup idempotent per-row + coalesced; `isTransientResult` is the gate; deferred path runs no fan-out/conflict/count. |
| **Alignment** | PASS | Matches D-1..D-7 decisions exactly (sibling table, `isTransientResult` gate, store-resolved-write, inherent idempotency, `deferred` acks, home-anchored, secret-free). |
| **Gaps** | PASS (1 Warning) | `committedSinceBoot` not fed by the drainer (Warning W-1). No durability gap. |
| **Detrimental patterns** | PASS | Fail-soft everywhere; unref'd interval; single-flight drain; `.catch` floor on un-awaited drains; SQL through `sqlIdent`/`sLiteral`; secret-free events. |

---

## 3. Critical Issues (must fix)

**None.** No blocker to ship.

---

## 4. Warnings (should fix)

### W-1 — Outbox-drained recoveries bypass `MemoryFormationTracker`; `committedSinceBoot` understates recovery
- **Where:** `src/daemon/runtime/pipeline/memory-outbox.ts:589-603` (`drainOne`) + `:563-580` (`drainAddGroup`) commit via `commitControlledWrite` / `commitControlledWriteMany` directly; the tracker is wired ONLY on the live stage's `onOutcome` seam at `src/daemon/runtime/assemble.ts:2750` (`withMemoryFormationTracking(controlledWriteFanOut(queue), memoryFormation)`).
- **What:** A memory that defers during a degraded window (`action: "deferred"`, not counted — correct) and is later committed by the drainer on recovery increments neither `committedSinceBoot` nor `lastCommittedAt` (`memory-formation.ts:65-73`, `COMMITTED_ACTIONS = {inserted, version_bumped, deduped}` at `:33`). The drainer holds no tracker reference (`openMemoryOutbox` options carry none).
- **Why it matters:** PRD-080 Goals + a-AC-8 + the register's BUG-04 Verify criteria explicitly name "`memoryFormation.committedSinceBoot` climbs through outages" as the proof-of-fix signal. During a **drain-only** recovery (backlog draining with little/no new live traffic), `memoryCount` (the real `memories` table) climbs to complete — the P0 durability goal is met — but `committedSinceBoot` stays flat, so an operator watching that specific counter could wrongly conclude memories are still being lost.
- **Severity rationale:** Warning, not Critical — durability is fully intact (drained rows are real, present, and recallable; verified by mechanism). This is an observability-signal gap against the metric BUG-04 uses to prove itself, not a lost memory.
- **Recommended remediation (for the implementing Bee, not this audit):** thread the `MemoryFormationTracker` (or a lightweight `onCommitted(count)` callback) into `openMemoryOutbox` and call `record`/increment on each drained/deduped commit in `drainOne` + `drainAddGroup`, so drain-recovered memories climb `committedSinceBoot` the same way live commits do. Keep it fail-soft (a tracker fault must not abort a drain pass).

---

## 5. Suggestions (consider improving)

### S-1 — a-AC-8 lacked a native single-flow integration test through the live stage
- The suite proved the mechanism in pieces (a-AC-1 defers via the real path; a-AC-3 drains-to-empty + dedups; b-AC-4 does the full defer→drain→present→no-dup loop for the *re-drive* path). To make a-AC-8 airtight through the *live controlled-write* path in one flow, this audit added `tests/daemon/runtime/pipeline/memory-outbox-mechanism.test.ts` (1 test, green): a shared mode-flippable hash-modeling `StorageQuery` drives `applyControlledWrite` → `deferred` + `pending=1` (fault ON) → `drainDue` → committed + `pending→0` + exactly one INSERT → replay → `deduped`, INSERT count stays 1. Consider keeping this as the standing a-AC-8 regression anchor.

### S-2 — Re-drive limitation is documented and acceptable (no action required)
- `redriveControlledWritePayload` rebuilds the resolved write by re-running the proposal path (the PRD's escape hatch) and omits `onOutcome` (graph fan-out) + `onConflict`; those reconcile via the idempotent pollinating pass. This is the PRD-sanctioned trade-off and is correct — noted only so a future reader does not mistake it for a gap.

---

## 6. Per-AC verification (AC → code → test → verdict)

### 080a — MVP

| AC | Code (verified) | Test (non-tautological) | Verdict |
|----|-----------------|-------------------------|---------|
| a-AC-1 | `controlled-writes.ts` `deferOrThrow` (:880) + `commitControlledWrite` (:690) transient arms at BOTH `probeDedupForCommit` (:724) and the INSERT (:712); `memory-outbox.ts` `enqueue` (:416) | `memory-outbox.test.ts` BRANCH A (dedup 503) + BRANCH B (INSERT 503) + transient UPDATE → `deferred`, `pending=1`, `inserts=0` | **PASS** |
| a-AC-2 | `commitControlledWrite` `genuine` arm → `throw` (:520/:642); probe genuine at `:745-747`; gate is `isTransientResult` (`client.ts:371`: 400/403/42P01 = non-transient) | permission-denied 403 probe + 400-syntax INSERT throw, `pending=0`, `inserts=0`; corroborated by 006c suite (31 tests still green) | **PASS** |
| a-AC-3 | `drainDue`→`drainOne`/`drainAddGroup`→`commitControlledWrite` (shared live+drainer commit); dedup via `content_hash` | fail-then-recover drains to empty across 2 ticks; already-landed replay → `deduped`, `inserts=0` (no duplicate) | **PASS** |
| a-AC-4 | `pushBackoff` + `backoffDelay` `min(base·2^(n-1),cap)` (:794); `leaseDue` `next_attempt_at <= now` (:744) | next_attempt_at grows per attempt; future row skipped (no hot-loop) | **PASS** |
| a-AC-5 | `openOutboxDatabase`→`localQueueDaemonDir`/`localQueueDatabasePath` (:347); `assemble.ts` `resolveLocalQueueBaseDir()` = `honeycombStateDir()` | enqueue→close→reopen SAME home-anchored db→drain persisted row; asserts file at `.daemon/local-queue.db` | **PASS** |
| a-AC-6 | `deferOrThrow` try/catch→fallback throw; `NULL_MEMORY_OUTBOX` (:330); `enqueue`/`drainDue` try/catch; `.catch(onDrainRejection)` floor | throwing outbox → pre-080 throw, no unhandled rejection; no-outbox → throws; untrusted baseDir → inert; throwing WRITE client → backoff | **PASS** |
| a-AC-7 | `counts()` (:491); events `enqueued`/`retry`/`drained` count/durationMs/attempt only; `health.ts` `memoryOutbox` (:477) `nonNegativeInt` | events carry no content/hash/org/workspace (allow-list assertion); /health shape + omitted-when-unwired | **PASS** |
| a-AC-8 | live dogfood — natural degraded window not inducible in CI | **QA mechanism test** (`memory-outbox-mechanism.test.ts`): real live path defers→drains→present→no-dup; corroborated by a-AC-1/a-AC-3/b-AC-4 | **VERIFIED-by-mechanism** (see §7; W-1 caveat on `committedSinceBoot`) |

### 080b — dead-letter + recovery drain + re-drive

| AC | Code (verified) | Test | Verdict |
|----|-----------------|------|---------|
| b-AC-1 | `deadLetter` (:689) attempt≥maxAttempts OR ageMs≥maxAgeMs → `markDead`; `leaseDue` `status=pending` never re-leases `dead`; `resolveMemoryOutboxLimits` env knobs | dead-letters after maxAttempts (never re-leased) + after maxAgeMs (before maxAttempts) | **PASS** |
| b-AC-2 | `deadLetter`→`memory.outbox.dead_lettered {attempt,ageMs,count}`; `counts()` 3-way partition (:491); `health.ts` `deadLettered` | secret-free event (keys = ageMs/attempt/count only); counts partition; /health normalization + legacy-omit default 0 | **PASS** |
| b-AC-3 | `kickMemoryOutboxDrain` (:914) on committed/deduped/version_bumped arms; `SqliteMemoryOutbox.kick` (:664) single-flighted; assemble `deeplake.woke` resume `start()+kick()` | landing write clears queued row via kick (interval never armed); a landed commit calls sink.kick once | **PASS** |
| b-AC-4 | `readTerminalControlledWriteJobs` (`memory-redrive.ts:81`, fail-soft, `existsSync` guard); `redriveControlledWritePayload` (:1251, re-runs live path, batch+single); `mountMemoryRedriveApi` (`POST /api/diagnostics/memory-redrive`, protect:true group); `commands/memory.ts` `redrive` verb | reader excludes non-terminal + other-kind (real local-queue.db); re-drive→defer→drain→present→**repeat re-drive no duplicate**; clean no-op; route+CLI thin-client | **PASS** |
| b-AC-5 | `kickMemoryOutboxDrain` try/catch; `redriveOneFact` per-fact try/catch (:1287); happy-path + genuine-throw arms unchanged | throwing kick never breaks the write; no-kick stub == 080a; unparseable payload skipped, valid one recovered | **PASS** |

### 080c — caps + coalescing at scale

| AC | Code (verified) | Test | Verdict |
|----|-----------------|------|---------|
| c-AC-1 | `shedToCap` (:463) oldest-first `created_at,id`, `status=pending` only, `memory.outbox.shed {count}`; `maxRows` (:125/env) | sheds oldest pending, bounds backlog, logs count; `dead` rows excluded from cap | **PASS** |
| c-AC-2 | `groupDue` (:630) scope+action+column-sig `groupKey`; `isCoalescibleAddGroup` (:859, add+≥2+distinct-hash); `commitControlledWriteMany` (:777) ONE batched `content_hash IN(…)` probe (`buildDedupCheckManySql` `memories.ts:232`) + ONE multi-row append of not-present; per-member `settleFailure` | coalesces + dedups already-present member (no dup insert); whole-group present → no insert; heterogeneous shapes split; failed group backs off each member; **in-group duplicate hash falls back to per-row** | **PASS** |
| c-AC-3 | unified `maxDrainPerInterval` (:112/env); single `leaseDue LIMIT` (:752); old `maxDrainPerPass` a `@deprecated` alias | backlog over cap attempts ≤N/pass, remainder left due | **PASS** |
| c-AC-4 | `shedToCap`/`drainAddGroup`/`commitControlledWriteMany`/`probeDedupMany` never-throw; `counts()` partition under load | rejecting batched probe → per-member backoff, no unhandled rejection; over-cap enqueue keeps accounting honest, /health bounded | **PASS** |

---

## 7. a-AC-8 form achieved

**VERIFIED-by-mechanism** (natural degraded window not inducible on demand; no live workspace in CI). Proven end-to-end through the **real** controlled-write path via controlled fault injection at the `StorageQuery` seam (QA-authored `tests/daemon/runtime/pipeline/memory-outbox-mechanism.test.ts`, green):

1. **Degraded window (fault ON):** `applyControlledWrite` returns `action: "deferred"` (the job ACKs — no throw, no attempt-burn), the resolved write lands in `memory_outbox` (`pending = 1`), nothing committed to `memories`.
2. **Recovery (fault OFF) + `drainDue`:** the deferred write re-commits — `pending → 0`, the memory is present in the backend, exactly ONE INSERT.
3. **Idempotency:** replaying the same write is `deduped` (content_hash) — the INSERT count never climbs past 1 (no duplicate `memories` row).

The natural-window live observation (real Activeloop degraded window with `pending>0` then `→0` and `committedSinceBoot` climbing) is a **non-blocking post-merge dogfood** — and note W-1: `committedSinceBoot` will climb from new live writes on recovery but NOT from the drained backlog until W-1 is addressed.

---

## 8. Security close-out (folded in)

`security-worker-bee` ran BEFORE this QA (correct order) and returned **CLEAN at High+**, zero remediation, 2 Lows documented. Independently corroborated during this audit: the drainer surfaces **no DeepLake error text** at rest or in events (`ControlledWriteCommit.detail` carries only stage + result `kind`, never a message body — `controlled-writes.ts:672`); `memory.outbox.*` events are allow-list-tested to carry no content/`content_hash`/org/workspace (a-AC-7 test); the re-drive route mounts on the `protect:true` `/api/diagnostics` group; all SQL routes through `sqlIdent`/`sLiteral` (`audit:sql` scanned 315 files, clean); the a-AC-2 safety throw is preserved. No new High/Critical surface introduced by the 080 changes.

---

## 9. `npm run ci` status

**GREEN.** `typecheck` OK + `jscpd` OK (< 7 threshold) + **4893 vitest passed / 13 skipped / 0 failed** + `audit:sql` OK (315 files clean). No flake this run — `secrets/exec.test.ts` and `assemble.test.ts` both passed in the full suite. (The QA-added `memory-outbox-mechanism.test.ts` passes independently, +1 test beyond the CI snapshot.)

---

## 10. Files Changed (one-line each)

| File | Summary |
|------|---------|
| `src/daemon/runtime/pipeline/memory-outbox.ts` (NEW, 895 L) | Durable `memory_outbox` SQLite table: enqueue/drain/counts/kick/dead-letter/shed/coalesce, injected clock, unref'd interval, fail-soft throughout. |
| `src/daemon/runtime/pipeline/controlled-writes.ts` (+496 L) | `commitControlledWrite`/`commitControlledWriteMany` single-sourced commit; `deferOrThrow` + `deferred` action; `isTransientResult` gate at both branches; `kickMemoryOutboxDrain`; `redriveControlledWritePayload`. |
| `src/daemon/runtime/pipeline/memory-redrive.ts` (NEW) | Terminal-job reader + `runMemoryRedrive` orchestrator (read-through fail-soft, `existsSync` guard). |
| `src/daemon/runtime/pipeline/memory-redrive-api.ts` (NEW) | `POST /api/diagnostics/memory-redrive` trigger on the protected diagnostics group; fail-soft to zero-count 200. |
| `src/commands/memory.ts` (+53 L) | `honeycomb memory redrive` thin-client verb → daemon seam; renders counts. |
| `src/daemon/storage/catalog/memories.ts` (+17 L) | `buildDedupCheckManySql` batched `content_hash IN(…)` probe (SQL-safe). |
| `src/daemon/runtime/assemble.ts` (+103 L) | Wires outbox construction (real-path + kill-switch), pipeline dep, `/health memoryOutbox`, start/stop/close, hibernation pausable + `deeplake.woke` kick, redrive route mount. |
| `src/daemon/runtime/health.ts` (+40 L) | `memoryOutbox {pending,retrying,deadLettered}` reason + detail input, non-negative-int normalized. |
| `src/daemon/runtime/capture/capture-outbox.ts` (±20 L) | Exported `clampIntKnob` + `OutboxRowValuesSchema`/`OutboxColumnValueSchema` for the sibling outbox (jscpd-safe single-source). |
| `src/commands/index.ts`, `src/daemon/storage/catalog/index.ts` | Barrel exports (`MEMORY_REDRIVE_ENDPOINT`, `buildDedupCheckManySql`). |
| `tests/…/memory-outbox.test.ts` (35), `memory-redrive.test.ts` (5), `memory-redrive-api.test.ts` (3), `tests/commands/memory-redrive.test.ts` (4) | PRD-080 a/b/c coverage. |
| `tests/…/memory-outbox-mechanism.test.ts` (NEW, QA) | a-AC-8 VERIFIED-by-mechanism anchor (this audit). |

---

## 11. Overall verdict

**SHIP.** The P0 durability goal (BUG-04b: no distilled memory lost to a transient degraded window) is met and proven — the safety invariant is intact, replay is idempotent per-row and coalesced, observability is secret-free, and CI is green. The single Warning (W-1, `committedSinceBoot` not fed by the drainer) is a health-signal gap, not a durability defect, and does not block merge — but should be fixed so BUG-04's own proof-of-fix metric reflects drain-recovered memories. Recommend addressing W-1 before flipping BUG-04 🟢, or explicitly deferring it with a note in the register.
