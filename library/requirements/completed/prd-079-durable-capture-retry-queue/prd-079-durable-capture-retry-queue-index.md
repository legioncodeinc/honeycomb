# PRD-079: Durable Capture Retry Queue

> **Status:** Completed — all phases shipped & VERIFIED: **079a** (PR #287), **079b** + **079c** (this PR).
> **Priority:** P0 (the last uncovered failure mode on the memory write path — captures are silently *lost* during Deeplake degraded windows, capping how good recall can ever be regardless of the read-side index shipped in PRD-078)
> **Effort:** M (~few focused days across phases)
> **Schema changes:** None on Deeplake. Adds ONE new local SQLite table (`capture_outbox`) inside the existing home-anchored `local-queue.db` — no DDL against the hosted backend, no capture-request contract change, no embedding change.
> **Base:** `main` (post PR #281 / #283 / #285). Reuses the dedicated **write** `StorageClient` (`Semaphore(3)`, PRD-077 B2), the home-anchored local-queue infrastructure (PRD-066 + PR #285), and hooks the `flushBatch` drop point (`capture-handler.ts:520`).

## Overview

PRD-077/078 made the **read** side of the memory loop bounded, isolated, and cloud-independent. The **write** side still has one uncovered failure mode: **captures are silently dropped during Deeplake degraded/hibernation windows.**

The 2026-07-09/10 investigation (`library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md`, measured live on the `apiary` workspace) established this is a **hosted-backend health property, not a client bug**:

- Warm steady-state appends are **~1.3–2.1s and payload-independent** — the write path is fine in steady state.
- But the hosted backend **flaps and hibernates** (`deeplake.woke`): per-op latency swings widely and `CREATE`/append can exceed the **10s per-statement bound** (`DEFAULT_QUERY_TIMEOUT_MS`, `storage/config.ts:24`). When a degraded window pushes an append past 10s it returns a `timeout` result. Measured `capture.batch_insert.failed {timeout}` clusters **103–251s post-boot (warm, not cold)**.
- **On failure the batch is dropped — no retry.** `flushBatch` (`capture-handler.ts:510-534`) calls `recordDropped(rows.length)`, logs `capture.batch_insert.failed`, and throws. The captured turns are gone. Since captures are (correctly) **single-attempt** on the hot path (`maxAttempts:1`, PRD-077 B; the `unsafe-write` short-circuit), there is nothing to catch the row when the window is bad.

Because the failures are **windows, not a constant** (findings §4.5), the right mitigation is **resilience across windows, not a rewrite of the write path**: persist the failed capture to a durable local outbox and re-flush it when the backend recovers. The findings doc §5 prescribes exactly this ("a durable retry-later queue — re-queue the timed-out capture (the `local-queue.db` exists) and flush when the backend recovers").

This is the **write-side twin of PRD-078**: 078 moved reads off Deeplake's latency with an in-daemon index; 079 decouples writes from Deeplake's *availability* with a durable outbox. Deeplake remains the durable/fleet store; the outbox is a write buffer in front of it.

## Goals

- **No capture lost to a transient backend window.** A capture whose Deeplake append fails is persisted to a durable local outbox and re-appended when the backend recovers, instead of being dropped. Over a degraded window + recovery, the memory corpus ends up **complete**.
- **Hot path unchanged and never blocked.** The capture ack still returns fast and single-attempt; the outbox enqueue + drain are **off the hot path** (background drainer on the dedicated write client), so a bad window never slows the per-turn capture or the response.
- **Bounded and self-limiting.** Exponential backoff between drain attempts so a persistent degraded window doesn't hot-loop the write client; a dead-letter bound (079b) so the outbox can't grow without limit.
- **Durable + cwd-independent.** The outbox lives on the home-anchored fleet state root (`honeycombStateDir()`, PR #285) so queued captures survive a daemon restart and drain on the next boot, regardless of launch cwd.
- **Visible, never silent.** `/health` reports the outbox backlog (pending / retrying / dead-lettered) and a secret-free event stream marks enqueue / drain / retry / drop, so a degraded-window backlog and its recovery are an at-a-glance signal rather than a forensic hunt.
- **Fail-soft everywhere.** An outbox enqueue/drain error (disk full, SQLite fault) never breaks capture and never surfaces to the hook — the outbox is an accelerator of durability, never a new hard dependency.

## Non-Goals

- **No migration off Deeplake.** Deeplake stays the durable/fleet store and the append target; the outbox is a retry buffer in front of it, not a replacement (that architecture decision is the findings §7 owner call, out of scope here).
- **No change to the capture request contract, the batching window (PRD-062c), the dormancy/tenancy gates (PRD-073), or the `sessions` row shape.** The outbox intercepts only the **flush-failure** branch; the happy path is byte-unchanged.
- **No synchronous inline retry on the hot path.** Captures stay single-attempt (PRD-077 B); resilience is a background drainer, never an in-request loop (which would block the response and risk duplicate appends).
- **No exactly-once server guarantee.** Deeplake is append-only with no upsert; idempotency is via deterministic row id + read-time dedup (D-3), not a server-side unique constraint.
- **No reuse of the pipeline `local_jobs` queue semantics.** The outbox is a purpose-built table; it shares the `local-queue.db` *file* and its open/migrate + home-anchoring, not the pipeline job kinds or payload guard (D-1).

## Code-grounded current state

| # | Fact | Evidence |
|---|---|---|
| 1 | On a capture batch append failure the rows are **dropped** (counted + logged, then thrown) — no retry, no persistence. | `flushBatch` `capture-handler.ts:510-534` (`recordDropped` `:521`, `capture.batch_insert.failed` `:522`); immediate path `:364-374` (502 on non-ok) |
| 2 | Captures are single-attempt by design, so a failed window has nothing to catch the row. | `CAPTURE_WRITE_OPTS` `maxAttempts:1`; `unsafe-write` short-circuit `client.ts:477` (PRD-077 B) |
| 3 | Failures are **degraded windows**, not constant: warm appends ~1.3–2.1s payload-independent; timeouts cluster 103–251s post-boot; backend hibernates (`deeplake.woke`). | Findings §1.3 / §1.4 / §5 (live scratch-table probes) |
| 4 | Every statement is bounded at 10s; a degraded append past that returns `timeout`. | `DEFAULT_QUERY_TIMEOUT_MS = 10_000` `storage/config.ts:24`; `client.runAttempt` AbortController |
| 5 | The durable substrate already exists and is now home-anchored (survives restart, cwd-independent). | `local-job-queue.ts` (SQLite open/migrate, trusted roots); `resolveLocalQueueBaseDir()`=`honeycombStateDir()` (PR #285, `~/.apiary/honeycomb/.daemon/`) |
| 6 | Writes run on a dedicated write client (`Semaphore(3)`) split from reads, so a drainer can re-append without starving recall. | Read/write `StorageClient` split (PRD-077 B2); `writeMaxConcurrency` knob |
| 7 | A buffered flush carries `{ row, scope }` (the built `sessions` `RowValues` + `{org,workspace}`); scopes are grouped per append. | `BufferedRow` `capture-handler.ts:276-282`; `groupRowsByScope` in `flushBatch` |

## Sub-features (phases)

| Phase | Scope | Status |
|---|---|---|
| **079a — outbox + drainer + observability (MVP)** | A durable `capture_outbox` table in the home-anchored `local-queue.db` (`id`, `org`, `workspace`, `row_json`, `attempts`, `next_attempt_at`, `created_at`, `status`). On a `flushBatch`/immediate append failure the rows are ENQUEUED instead of dropped. A background drainer re-runs `appendOnlyInsertMany` on the write client with bounded exponential backoff; OK → delete, non-ok → increment attempt + push `next_attempt_at`. Home-anchored so it persists across restart. Fail-soft: enqueue/drain never breaks capture. `/health` `captureOutbox { pending, retrying }` + secret-free `capture.outbox.*` events. **This alone stops the silent loss.** | **Shipped — VERIFIED (PR #287)** |
| **079b — dead-letter + recovery-triggered drain** | After `maxAttempts` / `maxAgeMs`, move a row to `dead` with a durable `capture.outbox.dead_lettered` event + a `/health` `deadLettered` count (bounded growth, never silently vanishes). Drain is triggered on backend-recovery signals (the next *successful* capture append, and/or a `deeplake.woke` transition) in addition to the timer, so backlog clears promptly when the window ends. `honeycomb capture drain` operator command. | **Shipped — VERIFIED (this PR)** |
| **079c — caps + coalescing (scale)** | Disk/row-count cap on the outbox with an oldest-first shed (logged, never silent); coalesce queued rows into multi-row appends per scope on drain (mirrors the flush batcher) to minimize write ops on recovery; back-pressure knob so a huge backlog drains at a bounded rate. | **Shipped — VERIFIED (this PR)** |

## Acceptance criteria (Phase 079a — MVP)

| ID | Criterion |
|---|---|
| a-AC-1 | On a capture append failure (batched `flushBatch` OR the immediate `appendOnlyInsertMany` path returning non-ok), the affected `{ row, scope }` rows are ENQUEUED into the durable `capture_outbox` instead of being dropped. A test asserts a storage stub that returns non-ok routes the rows to the outbox (outbox count grows) rather than only `recordDropped`. |
| a-AC-2 | A background drainer re-attempts queued captures via `appendOnlyInsertMany` on the WRITE client; on OK the row is deleted from the outbox, on non-ok it stays with `attempts+1` and a pushed-out `next_attempt_at`. A test with a stub that fails then succeeds drains the outbox to empty across two drain ticks. |
| a-AC-3 | Bounded exponential backoff (documented base + cap) between attempts; the drainer SKIPS rows whose `next_attempt_at` is in the future, so a persistent degraded window cannot hot-loop the write client. A test asserts `next_attempt_at` grows per attempt and a not-yet-due row is not attempted. |
| a-AC-4 | The outbox is anchored on `honeycombStateDir()` (`~/.apiary/honeycomb/.daemon/`, PR #285), so queued captures survive a daemon stop/start and drain on the next boot regardless of launch cwd. A test enqueues, closes, reopens, and drains the persisted rows. |
| a-AC-5 | Fail-soft: an outbox enqueue OR drain error (SQLite fault, disk full) NEVER breaks the capture path and NEVER surfaces to the hook — it is logged (`capture.outbox.enqueue_failed` / `capture.outbox.drain_failed`) and counted, not thrown into the request. A test asserts a throwing outbox stub leaves the capture ack intact. |
| a-AC-6 | Idempotent replay: the outbox stores the ALREADY-BUILT row with its deterministic `id` (`makeRowId`) and never mints a new id on replay; rows are enqueued ONLY on a confirmed non-ok append (the row was not written), and any rare client-timeout-that-actually-landed duplicate is deduped downstream by `source+id` at fusion. A test asserts a replayed row keeps its original id. |
| a-AC-7 | Observability: `/health` reports `captureOutbox { pending, retrying }` and the drainer emits secret-free `capture.outbox.{enqueued,drained,retry}` events carrying COUNTS / durations / attempt only — NO message content, token, query text, org, or scope string. A test asserts the health shape + that events carry no content/scope fields. |
| a-AC-8 | Live acceptance (dogfood, recorded in the QA report): during an observed Deeplake degraded window, the timed-out captures land in the outbox (pending > 0), and when the backend recovers the drainer flushes them to Deeplake (pending → 0) with the memories subsequently present on recall. |

## Acceptance criteria (Phase 079b — dead-letter + recovery-triggered drain)

| ID | Criterion |
|----|-----------|
| b-AC-1 | A queued row that reaches `maxAttempts` failed re-appends **or** exceeds `maxAgeMs` in the outbox is moved to a terminal `dead` status (row retained, NOT deleted, NOT re-leased) so it stops consuming write slots and stops growing the active backlog — bounded growth, never a silent vanish. Config: `maxAttempts` (default 10) + `maxAgeMs` (default 24h), documented + env-overridable (`HONEYCOMB_CAPTURE_OUTBOX_*`), `amplificationConfig`-style. A test asserts a row failing `maxAttempts` times, and a row older than `maxAgeMs`, each transition `pending → dead` and are no longer leased by `drainDue`. |
| b-AC-2 | Dead-lettering emits a durable secret-free `capture.outbox.dead_lettered` event (attempt / ageMs / count only — NO content, token, org, or workspace) and surfaces a `/health` `captureOutbox.deadLettered` count. `counts()` returns `{ pending, retrying, deadLettered }` where `dead` rows are excluded from `pending`/`retrying` (terminal, not active). A test asserts the event shape carries no content/scope, the health count, and the partition. |
| b-AC-3 | Recovery-triggered drain: the drainer is kicked IMMEDIATELY (not only on the timer) when the backend recovers, signaled by (a) the next SUCCESSFUL capture append on the write path, and/or (b) a `deeplake.woke` transition. The kick is debounced/single-flighted against the existing `draining` guard and is fail-soft (a kick failure never breaks capture). A test asserts a successful capture append triggers an immediate drain pass (a queued row drains without waiting for the full interval). |
| b-AC-4 | Operator command `honeycomb capture drain` forces one drain pass and prints the result (`drained` / `retried` / `deadLettered` counts), reusing the same daemon `drainDue` seam over the daemon HTTP surface. A test asserts the command invokes the drain and reports the counts; it is read-through fail-soft (a daemon-down / error path reports cleanly, never throws). |
| b-AC-5 | Fail-soft + non-regression preserved: dead-lettering, the recovery kick, and the CLI never break capture, never throw into the hot path, never leak secrets, and do not change the 079a happy path or the `pending → dead` accounting for a row that would otherwise still be retrying. A test asserts a `dead`-transition fault degrades to a no-op and the capture ack is unaffected. |

## Acceptance criteria (Phase 079c — caps + coalescing at scale)

| ID | Criterion |
|----|-----------|
| c-AC-1 | Disk/row-count cap: when the ACTIVE backlog (`pending` rows) would exceed `maxRows` (config, default 10,000; env-overridable), the OLDEST pending rows are shed (deleted) oldest-first to stay under the cap, and each shed is COUNTED + logged via a secret-free `capture.outbox.shed { count }` event — never a silent truncation. `dead` rows do not count toward the active cap. A test asserts enqueuing past the cap sheds oldest-first, bounds the backlog at `maxRows`, and logs the shed count. |
| c-AC-2 | Coalesced drain: on a drain pass, due rows sharing BOTH a scope AND an identical column signature are coalesced into ONE multi-row `appendOnlyInsertMany` (mirrors the flush batcher), minimizing write ops on recovery. Rows with heterogeneous column shapes (e.g. assistant turns carrying `usage` columns vs user turns) are grouped SEPARATELY so `buildInsertMany`'s same-columns assertion never rejects a batch. On a coalesced append failure, EACH row in the group is failed independently (attempts+1 + backoff per row), never lost. A test asserts N same-scope/same-shape rows drain in one append, heterogeneous shapes split into separate appends, and a failed group backs off every member. |
| c-AC-3 | Back-pressure: a `maxDrainPerInterval` knob (config, default e.g. 200) bounds how many rows one drain pass will attempt, so a huge backlog drains at a bounded rate rather than bursting the write client (`Semaphore(3)`). The remainder is left due for the next pass. A test asserts a backlog larger than the cap attempts at most `maxDrainPerInterval` rows in one pass and the rest remain pending. |
| c-AC-4 | Fail-soft + observability preserved: the cap/shed, coalescing, and back-pressure paths are all secret-free, never break capture, and never throw into the hot path; `/health` continues to report an honest `{ pending, retrying, deadLettered }` under load. A test asserts a fault in any of the three paths degrades to the pre-079c behavior without surfacing. |

## Resolved decisions

| # | Decision |
|---|---|
| D-1 | **Dedicated `capture_outbox` table inside the existing `local-queue.db`, NOT the pipeline `local_jobs` queue.** Reuses the SQLite open/migrate helpers + the PR #285 home-anchoring, but keeps capture rows out of the pipeline job kinds and the job-payload secret guard (capture rows legitimately carry conversation content). This is the canonical **transactional outbox** pattern for a durable buffer in front of an unreliable downstream. |
| D-2 | **Retry-later (background drainer), not synchronous retry.** Captures stay single-attempt on the hot path (PRD-077 B); resilience spans degraded WINDOWS (findings §1.4/§4.5 — failures are windows, warm writes ~2s), so the response never blocks and no duplicate is appended inline. |
| D-3 | **Idempotency via deterministic id + read-time dedup.** Enqueue only on a CONFIRMED non-ok append (row not written); the stored row keeps its `makeRowId` id; the rare client-timeout-that-landed duplicate is absorbed by `fuseHits` `source+id` dedup at read time. A stronger server-side dedup guard is deferred (Deeplake is append-only, no upsert). |
| D-4 | **Fail-soft + bounded, on the write lane.** The outbox is never a hard dependency (enqueue/drain failure is logged, never thrown); backoff (a-AC-3) caps write-client pressure; the drainer runs on the dedicated write `Semaphore(3)` (PRD-077 B2) so it never starves recall; dead-letter + caps (079b/c) bound growth. |
| D-5 | **Home-anchored, cwd-independent durability.** The outbox rides the same fleet state root as the local queue after PR #285 (`~/.apiary/honeycomb/.daemon/`), so a restart from any launch dir reopens the SAME outbox — the exact class PR #285 closed for the queue. |

## Prior art

- **PRD-078** (local ANN recall index) — the READ-side twin; decoupled per-turn semantic recall from Deeplake latency. 079 is the WRITE-side twin, decoupling capture from Deeplake availability. Same "keep Deeplake as durable store, add an in-daemon resilience layer" shape.
- **PRD-077** (per-turn recall fast path) — B (single-attempt capture) and B2 (read/write client split) are the hot-path invariants 079 preserves and the write lane it drains on.
- **PRD-066** (local queue idle cost control) — the `local-queue.db` SQLite substrate (open/migrate, trusted roots, lease/backoff idioms) the outbox reuses.
- **PR #285** (`fix/daemon-cwd-project-scope`, merged) — home-anchored the local queue on `honeycombStateDir()`; the outbox inherits that durability guarantee (D-5).
- **Findings** `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md` §1.3–1.5 / §4.5 / §5 — the live measurements of the degraded-window write failures and the explicit "durable retry-later queue" recommendation this PRD operationalizes.
