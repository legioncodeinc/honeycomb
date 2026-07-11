# PRD-080: Durable Controlled-Write Outbox

> **Status:** Backlog
> **Priority:** P0 (BUG-04b — distilled memories formed during a Deeplake degraded window are permanently DROPPED; `memoryCount` stays flat despite successful extraction. The last uncovered availability gap in the memory-formation chain, and the sole reason BUG-04 is 🟡 not 🟢 after PR #293.)
> **Effort:** M (~few focused days across phases). Mirrors PRD-079's shape and reuses its substrate.
> **Schema changes:** None on Deeplake. Adds ONE new local SQLite table (`memory_outbox`) inside the existing home-anchored `local-queue.db` — no DDL against the hosted backend, no `memories` schema change, no decision/extraction change.
> **Base:** `main` (post PR #293 / BUG-04a). Reuses the PRD-079 outbox substrate (`capture-outbox.ts` patterns, `resolveLocalQueueBaseDir()` home-anchoring, the write `StorageClient`, the `OutboxClock` seam) and the `isTransientResult` classifier (`client.ts:371`). Hooks the two controlled-write throw points in `controlled-writes.ts`.

## Overview

PRD-077/078 decoupled **recall** from Deeplake latency; PRD-079 decoupled **capture** from Deeplake availability. The **memory-formation pipeline** — the stage that turns a captured turn into a distilled `memories` row — was never insulated, and it is where memories are now being lost.

**BUG-04, root-caused live this session (PR #293 = BUG-04a):** the `memory_controlled_write` stage commits a distilled fact in two Deeplake steps — a dedup probe (`buildDedupCheckSql` → `SELECT id FROM "memories" WHERE content_hash = '…' LIMIT 1`, `controlled-writes.ts:456`) then a version-bumped INSERT (`appendVersionBumped`, `controlled-writes.ts:503`). During a Deeplake **degraded/flapping window** (5xx / 429 / 402-balance / eventual-consistency — the same hosted-backend health property measured in the findings doc), either step returns a `query_error`. `classifyFailure` **correctly** routes a non-healable error to `other`, so the stage **correctly throws** (`controlled-writes.ts:495-503` / `:508-509`) — the safety invariant: never an unguarded duplicate insert. But the throw fails the `memory_controlled_write` job, which retries **5×** and is then **dropped**. The distilled memory is gone.

**Measured live:** the local job queue held **101 failed** `memory_controlled_write` jobs (× 5 attempts = the 505 `stage.failed` in the register) *alongside* **236 done**, all with the identical correct `apiary`/`the-apiary` scope. Same scope → both outcomes ⇒ the failure is **intermittent (degraded windows)**, not a query/classification/scope bug (all three proven correct). PR #293 made the failure **diagnosable + secret-safe** but added **no durability** — a memory distilled during a degraded window that outlasts 5 attempts is still lost.

**PRD-080 is the write-side twin of PRD-079, for the pipeline instead of capture.** On a **transient** controlled-write failure, persist the resolved write to a durable local **`memory_outbox`** and return a `deferred` result (the job acks, does not burn its 5 attempts); a background drainer re-executes the commit when the backend recovers. A **genuine non-transient** failure still throws (safety preserved). Deeplake stays the durable store; the outbox is a retry buffer in front of it.

## Goals

- **No distilled memory lost to a transient backend window.** A controlled-write whose Deeplake commit fails transiently is persisted and re-attempted when the backend recovers, instead of being dropped after 5 job attempts. Over a degraded window + recovery, `memoryCount` ends up **complete** and `memoryFormation.committedSinceBoot` climbs through outages (the register's BUG-04 Verify criteria).
- **Safety invariant preserved.** ONLY transient/degraded failures route to the outbox (via `isTransientResult`); a genuine non-transient failure (permission / syntax / balance-hard-fail if classified non-transient) still fails the job. No unguarded duplicate insert — replay is idempotent by construction (below).
- **Idempotent replay for free.** ADD replays re-run the dedup probe → a memory a prior attempt already landed is `deduped` (the `content_hash` guarantees no duplicate); UPDATE/DELETE replay via the version-bumped write. Re-attempting is always safe.
- **Pipeline never blocked.** Enqueue + drain are off the stage's critical section on the dedicated write client (`Semaphore(3)`, PRD-077 B2); a degraded window slows nothing user-facing.
- **Durable + cwd-independent.** The outbox rides the home-anchored fleet state root (`honeycombStateDir()`, PR #285) so a queued write survives a daemon restart and drains on the next boot.
- **Visible, never silent.** `/health` reports `memoryOutbox { pending, retrying, deadLettered }` and a secret-free event stream — NO memory content, `content_hash`, org, or workspace in any field (the exact posture PR #293's `redactProbedHash` enforced).
- **Recover the already-lost.** A one-time re-drive of the ~101 already-terminal `memory_controlled_write` jobs so the memories dropped before this shipped are recovered (080b).

## Non-Goals

- **No migration off Deeplake.** Deeplake stays the durable `memories` store; the outbox is a retry buffer in front of it (findings §7 owner call, out of scope).
- **No change to extraction, the decision stage, dedup semantics, conflict detection, or the `memories` schema.** The outbox intercepts only the **transient-commit-failure** branch; the happy path and the genuine-failure throw are byte-unchanged.
- **No re-running the decision pipeline on drain.** The outbox stores the ALREADY-RESOLVED write (action + built row + scope); the drainer re-executes just the durable commit, not extraction/decision (which already ran).
- **No reuse of the pipeline `local_jobs` queue semantics.** `memory_outbox` is a purpose-built table beside `capture_outbox` in the SAME `local-queue.db` file — it shares the SQLite substrate + home-anchoring, not the job kinds.
- **No `capture_outbox` overload.** The two outboxes are siblings; a capture row (a `sessions` append) and a controlled-write (a version-bumped `memories` commit with dedup) are different writes with different replay logic.

## Code-grounded current state

| # | Fact | Evidence |
|---|---|---|
| 1 | The controlled-write commits in two Deeplake steps: a dedup probe, then a version-bumped INSERT. A non-healable failure of EITHER throws. | dedup probe `controlled-writes.ts:456`, throw `:495-503`; INSERT `appendVersionBumped` `:503`, throw `:508-509` |
| 2 | The throw fails the `memory_controlled_write` job → retried 5× → dropped → the distilled memory is lost. | Live: 101 failed jobs × 5 = 505 `stage.failed`; register BUG-04 |
| 3 | The failure is INTERMITTENT (degraded windows), not a query/classification/scope bug — all three proven correct live (probe returns 200, `content_hash` exists on the live table, `classifyFailure` classifies the real Deeplake strings correctly). | PR #293 live investigation; register BUG-04 (🟡) |
| 4 | A transient-vs-genuine classifier already exists and is the correct gate for "route to outbox vs still-fail". | `isTransientResult(result)` `client.ts:371` (5xx/429/timeout/connection = transient) |
| 5 | The resolved write to persist: the built `memories` `RowValues` (`buildMemoryRow`, carries `content_hash` + content + vector) + the `QueryScope` + the action (`inserted`/version-bumped). Idempotency is inherent via `content_hash` / version-bump. | `buildMemoryRow` `:492`, `MEMORIES_VERSIONED_TARGET` `:167`, `ControlledWriteResult.action` `:183` |
| 6 | The durable substrate + home-anchoring + backoff/dead-letter/coalescing/OutboxClock + `/health` shape already exist and are proven. | PRD-079 `capture-outbox.ts`, `resolveLocalQueueBaseDir()`=`honeycombStateDir()` (PR #285), `/health captureOutbox` |
| 7 | PR #293 already surfaces the failure secret-safely (redacted `content_hash`), so 080's enqueue decision has the classification in hand. | `controlled_write.dedup_probe_failed` event, `describeProbeFailure`/`redactProbedHash` |

## Sub-features (phases)

| Phase | Scope | Status |
|---|---|---|
| **080a — memory outbox + drainer + observability (MVP)** | A durable `memory_outbox` table in the home-anchored `local-queue.db` (`id`, `org`, `workspace`, `action`, `row_json`, `attempts`, `next_attempt_at`, `created_at`, `status`). At the two controlled-write throw points, gate on `isTransientResult`: **transient →** enqueue the resolved write + return a new `deferred` action (the job acks, does NOT burn its 5 attempts); **genuine →** throw as today. A background drainer re-executes the commit (dedup-probe-then-append for ADD; version-bumped write for UPDATE/DELETE) on the write client with bounded exponential backoff; OK/deduped → delete, transient-fail → backoff, genuine-fail → (080b dead-letter, else backoff). Home-anchored, fail-soft. `/health` `memoryOutbox { pending, retrying }` + secret-free `memory.outbox.*` events. **This alone stops the silent loss.** | Draft |
| **080b — dead-letter + recovery-triggered drain + re-drive** | Dead-letter a row after `maxAttempts` / `maxAgeMs` (terminal, retained, `memory.outbox.dead_lettered` + `/health deadLettered`). Recovery kick: drain immediately on the next SUCCESSFUL pipeline write and/or a `deeplake.woke` transition (mirrors 079b). **Re-drive:** a one-time path/command (`honeycomb memory redrive`) that reads the terminal `memory_controlled_write` jobs from `local-queue.db` and re-enqueues their resolved writes into `memory_outbox` — recovering the ~101 memories already dropped. | Draft |
| **080c — caps + coalescing (scale)** | `maxRows` oldest-first shed (logged, never silent; `dead` excluded); coalesce due rows by scope + column signature into multi-row version-bumped appends on drain (reuses 079c's grouping); back-pressure `maxDrainPerInterval`. | Draft |

## Acceptance criteria (Phase 080a — MVP)

| ID | Criterion |
|----|-----------|
| a-AC-1 | On a controlled-write commit failure classified **transient** (`isTransientResult`) — at EITHER the dedup-probe branch or the version-bumped INSERT branch — the resolved write (`{ action, row, scope }`) is ENQUEUED into the durable `memory_outbox` and the stage returns a `deferred` action instead of throwing. A test asserts a transient-failing storage stub routes the write to the outbox (pending grows) and the job does NOT throw / does NOT exhaust attempts. |
| a-AC-2 | A **genuine non-transient** failure (permission / syntax / a non-transient `query_error`) STILL throws exactly as today — never enqueued, never a `deferred` ack, never an unguarded duplicate insert. A test asserts a non-transient stub still throws with no outbox row. |
| a-AC-3 | A background drainer re-executes each queued write on the WRITE client: ADD re-runs the dedup-probe-then-append (a memory a prior attempt landed → `deduped`, no duplicate — idempotent via `content_hash`); UPDATE/DELETE re-runs the version-bumped write. OK/deduped → delete the row; transient-fail → `attempts+1` + pushed `next_attempt_at`. A test with a fail-then-recover stub drains to empty across two ticks and asserts NO duplicate `memories` INSERT on replay of an already-landed row. |
| a-AC-4 | Bounded exponential backoff (documented base + cap); the drainer skips rows whose `next_attempt_at` is future — no hot-loop on a persistent window. A test asserts backoff growth + due-skip. |
| a-AC-5 | The outbox is anchored on `honeycombStateDir()` (`~/.apiary/honeycomb/.daemon/local-queue.db`, PR #285), a `memory_outbox` table beside `capture_outbox`, so queued writes survive a daemon stop/start and drain on the next boot. A test enqueues, closes, reopens, and drains the persisted row. |
| a-AC-6 | Fail-soft: an outbox enqueue OR drain fault NEVER breaks the pipeline stage and NEVER surfaces as an unhandled rejection — it is logged (`memory.outbox.enqueue_failed` / `drain_failed`) + counted. On an enqueue fault the stage falls back to the pre-080 throw (the write is not silently lost-and-forgotten). A test asserts a throwing outbox stub degrades cleanly. |
| a-AC-7 | Observability: `/health` reports `memoryOutbox { pending, retrying }` and the drainer emits secret-free `memory.outbox.{enqueued,drained,retry}` events carrying COUNTS / durations / attempt / action-class ONLY — NO memory content, `content_hash`, query text, org, or workspace (the PR #293 redaction posture). A test asserts the health shape + that events carry no content/hash/scope. |
| a-AC-8 | Live acceptance (dogfood, QA report): during an observed Deeplake degraded window, a distilled controlled-write lands in `memory_outbox` (pending > 0), and when the backend recovers the drainer commits it (pending → 0) with the `memories` row subsequently present + recallable — and `memoryFormation.committedSinceBoot` climbs through the window (the register's Verify criteria). |

## Acceptance criteria (Phase 080b — dead-letter + recovery drain + re-drive)

| ID | Criterion |
|----|-----------|
| b-AC-1 | A queued write reaching `maxAttempts` (default 10) OR `maxAgeMs` (default 24h) moves to terminal `dead` (retained, not re-leased), env-overridable (`HONEYCOMB_MEMORY_OUTBOX_*`). Test: a permanently-failing write → `dead`, no longer leased. |
| b-AC-2 | Dead-lettering emits secret-free `memory.outbox.dead_lettered { attempt, ageMs, count }` and `/health memoryOutbox.deadLettered`; `counts()` → `{ pending, retrying, deadLettered }` (dead excluded from active). Test: event shape + counts partition. |
| b-AC-3 | Recovery-triggered drain kicked on the next SUCCESSFUL pipeline `memories` write and/or a `deeplake.woke` transition, single-flighted + fail-soft (mirrors 079b). Test: a landing controlled-write kicks an immediate drain (a queued row clears without the full interval). |
| b-AC-4 | **Re-drive:** `honeycomb memory redrive` (operator command + a daemon route) reads the terminal `memory_controlled_write` jobs from `local-queue.db`, re-enqueues their resolved writes into `memory_outbox`, and reports counts — recovering the ~101 already-dropped memories. Idempotent (content_hash dedup on replay). Read-through fail-soft. Test: seeded terminal jobs → re-enqueued → drained → memories present, no duplicates. |
| b-AC-5 | Fail-soft + non-regression: dead-letter, the kick, and the re-drive never break the pipeline, never leak secrets, and leave the 080a happy path + the genuine-failure throw unchanged. Test. |

## Acceptance criteria (Phase 080c — caps + coalescing at scale)

| ID | Criterion |
|----|-----------|
| c-AC-1 | `maxRows` cap (default 10k): oldest-first shed of pending rows over the cap, each shed COUNTED via `memory.outbox.shed { count }` — never silent; `dead` excluded from the cap. Test. |
| c-AC-2 | Coalesced drain: due rows sharing scope + column signature → one multi-row version-bumped append (reuses 079c's `groupDue`/`groupKey`); heterogeneous shapes split; a failed group backs off / dead-letters EACH member independently — no write lost or double-committed. Test. |
| c-AC-3 | Back-pressure `maxDrainPerInterval` (default 200): one pass attempts at most N; remainder left due. Test. |
| c-AC-4 | Fail-soft + observability preserved across cap/coalesce/back-pressure; `/health` honest under load. Test. |

## Resolved decisions

| # | Decision |
|---|---|
| D-1 | **Dedicated `memory_outbox` table inside the existing `local-queue.db`, sibling to `capture_outbox` — NOT a reuse of `capture_outbox`.** A capture row is a `sessions` append; a controlled-write is a version-bumped `memories` commit with a dedup gate — different replay logic. It reuses the PRD-079 SQLite open/migrate + home-anchoring (PR #285) + backoff/dead-letter/coalescing/OutboxClock patterns, not the row semantics. |
| D-2 | **`isTransientResult` is the enqueue gate.** Transient (5xx/429/timeout/connection) → outbox + `deferred`; genuine non-transient → throw as today. This preserves the safety invariant exactly and reuses the classifier the storage layer already exports (`client.ts:371`) — no new failure taxonomy. |
| D-3 | **Store the resolved write, replay the commit — not the decision.** The outbox persists `{ action, row (RowValues), scope }`; the drainer re-executes only the durable commit (dedup-probe-then-append for ADD; version-bumped write for UPDATE/DELETE). Extraction/decision already ran; re-running them would be wasteful and could diverge. |
| D-4 | **Idempotency is inherent, not bolted on.** ADD replay re-runs the dedup probe → an already-landed memory is `deduped` (the `content_hash` PK-equivalent guarantees no duplicate); UPDATE/DELETE replay via the version-bump. So a client-timeout-that-actually-landed is absorbed with no duplicate `memories` row. |
| D-5 | **`deferred` acks the job; the outbox owns the retry.** On a transient failure the stage returns `{ action: "deferred" }` and the `memory_controlled_write` job COMPLETES (does not burn its 5 attempts / does not drop). The outbox's bounded backoff (not the job queue's 5-attempt cap) owns the retry cadence — exactly how PRD-079's capture acks 201 and the `capture_outbox` owns the retry. |
| D-6 | **Home-anchored, cwd-independent (PR #285).** `memory_outbox` rides `honeycombStateDir()` (`~/.apiary/honeycomb/.daemon/`), so a restart from any launch dir reopens the SAME outbox. |
| D-7 | **Secret-free observability (PR #293 posture).** Events + `/health` carry counts/durations/attempt/action-class only — never memory content, `content_hash`, org, or workspace. The BUG-04a `redactProbedHash` lesson (a Deeplake error body can echo the hash) applies to any error text surfaced by the drainer. |

## Prior art

- **PRD-079** (durable capture retry queue, a/b/c — PRs #287/#289) — the CAPTURE-side twin. PRD-080 mirrors its outbox architecture (`capture-outbox.ts`, `openCaptureOutbox`, `enqueue`/`drainDue`/`kick`/dead-letter/`shedToCap`/coalescing, `OutboxClock`), its home-anchoring, and its `/health` shape — applied to the memory-formation commit instead of the `sessions` append.
- **PR #293 / BUG-04a** — the LIVE root-cause (degraded-window transience, not a query bug) + the secret-safe diagnostics (`controlled_write.dedup_probe_failed`, `redactProbedHash`) this PRD builds on; it left durability (BUG-04b) explicitly open.
- **PR #285** (`fix/daemon-cwd-project-scope`, merged) — home-anchored the local queue on `honeycombStateDir()`; `memory_outbox` inherits that durability guarantee (D-6).
- **PRD-077 B2** (read/write `StorageClient` split) — the dedicated write `Semaphore(3)` the drainer re-commits on so it never starves recall.
- **Findings** `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md` §1.3–1.5 / §4.5 — the measured Deeplake degraded-window write behavior that makes this necessary.
- **Register** `library/qa/investigation/2026-07-09-confirmed-bugs-and-fixes.md` — BUG-04 (🟡): this PRD closes BUG-04b and flips it 🟢.
