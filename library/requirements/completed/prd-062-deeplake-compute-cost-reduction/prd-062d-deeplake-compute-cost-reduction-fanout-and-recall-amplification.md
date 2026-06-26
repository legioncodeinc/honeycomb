# PRD-062d: Pipeline Fan-Out Coalescing & Recall Concurrency Caps

> **Parent:** [PRD-062: DeepLake Compute Cost Reduction](./prd-062-deeplake-compute-cost-reduction-index.md)
> **Status:** Backlog, draft (2026-06-26). The amplification fix (Driver 3).
> **Priority:** P1
> **Effort:** M
> **Schema changes:** None.

---

## Goals

Bound the multiplicative amplification that turns one user action into many DeepLake queries. Two independent sources:

1. **Pipeline fan-out.** One captured event → one extraction job → one decision job → **N `memory_controlled_write` jobs, one per extracted fact** ([`pipeline/fan-out.ts:137`](../../../../src/daemon/runtime/pipeline/fan-out.ts)). Each is another `memory_jobs` row write **and** more work the pollers must discover. Coalesce the per-fact enqueue (and, where safe, the downstream writes) into batched operations so a multi-fact decision is not a multi-write storm.
2. **Recall concurrency.** Every recall fires **4+ arms concurrently** (semantic + 3 lexical) with **no semaphore** ([`recall.ts:1905`](../../../../src/daemon/runtime/memories/recall.ts)), and semantic arms fan out further ([`recall.ts:932`](../../../../src/daemon/runtime/memories/recall.ts)); the usefulness-grader batches contradiction checks with an unbounded `Promise.all` ([`usefulness-grader.ts:208`](../../../../src/daemon/runtime/memories/usefulness-grader.ts)). A burst of recalls/grades issues unbounded concurrent DeepLake queries. Put a **bounded-concurrency semaphore** in front so in-flight query count has a ceiling.

## Non-Goals

- **No recall-quality change.** The arms still run and still merge the same way; they just queue behind a concurrency limit. Result sets are identical (parent AC-8).
- **No change to which facts are written.** Coalescing changes *how* per-fact writes are dispatched, not *whether* a fact is written or its version-bump correctness.
- **No broker / no schema change.** Pure runtime batching + concurrency control over the existing queue and recall paths.

---

## User Stories

### US-62d.1 — Coalesced fan-out

**As an** operator, **I want** a multi-fact decision to enqueue/write in batched operations rather than one job per fact, **so that** a single rich turn does not fan into a write storm the pollers then re-discover.

**Acceptance criteria:**
- AC-62d.1.1 A decision producing M fact proposals enqueues them in a batched operation (or a single multi-payload job) rather than M independent `enqueue` calls; a test asserts the enqueue/write count for an M-fact decision is sub-linear in M (batched), not M separate `memory_jobs` writes.
- AC-62d.1.2 Coalescing preserves per-memory append/version-bump correctness; a test asserts no controlled write is dropped or coalesced into an in-place UPDATE (the failure mode [`controlled-writes.ts`](../../../../src/daemon/runtime/pipeline/controlled-writes.ts) warns against: "DeepLake coalesces UPDATEs and can drop one").

### US-62d.2 — Bounded recall concurrency

**As a** user, **I want** recall to cap how many DeepLake queries it fires at once, **so that** a burst of recalls cannot spike compute, while my results stay the same.

**Acceptance criteria:**
- AC-62d.2.1 The recall arms and the usefulness-grader run under a bounded-concurrency semaphore; a test asserts that across a recall over many terms (and a batch grade), no more than `N` DeepLake queries are in flight simultaneously.
- AC-62d.2.2 A parity test asserts the merged recall result with the semaphore is identical to the result without it (the cap changes timing, not output).

---

## Technical Considerations

- **Fan-out batching.** In [`pipeline/fan-out.ts`](../../../../src/daemon/runtime/pipeline/fan-out.ts), replace the per-proposal loop of `queue.enqueue(...)` with a single batched enqueue (one job carrying all proposals, or a batch-enqueue API). The controlled-write stage ([`controlled-writes.ts`](../../../../src/daemon/runtime/pipeline/controlled-writes.ts)) then processes the batch, still writing each memory append/version-bumped — batching the **dispatch**, not collapsing distinct memories into one row.
- **Version-bump safety (gating).** Controlled writes are append/version-bump, never in-place UPDATE, precisely because DeepLake can coalesce and drop UPDATEs. Any write-side batching must keep each memory's append/version-bump intact; if that can't be guaranteed under batching, batch only the **enqueue** side and leave the write side per-fact.
- **Semaphore.** Wrap the `Promise.all` arms in [`recall.ts`](../../../../src/daemon/runtime/memories/recall.ts) and [`usefulness-grader.ts`](../../../../src/daemon/runtime/memories/usefulness-grader.ts) with a bounded pool. Decide whether it reuses the existing storage-layer `Semaphore(5)` or is a separate recall-scoped limit (open question) — a shared limit is simpler and also caps total DeepLake concurrency across subsystems.
- **Flags.** `HONEYCOMB_FANOUT_BATCH`, `HONEYCOMB_RECALL_MAX_CONCURRENCY`. Off ⇒ exact pre-PRD behavior (parent AC-9).

## Files Touched

- **Modified:** [`src/daemon/runtime/pipeline/fan-out.ts`](../../../../src/daemon/runtime/pipeline/fan-out.ts) (batched enqueue), [`src/daemon/runtime/pipeline/controlled-writes.ts`](../../../../src/daemon/runtime/pipeline/controlled-writes.ts) (batch processing, version-bump preserved), [`src/daemon/runtime/memories/recall.ts`](../../../../src/daemon/runtime/memories/recall.ts) + [`src/daemon/runtime/memories/usefulness-grader.ts`](../../../../src/daemon/runtime/memories/usefulness-grader.ts) (semaphore), config provider for the knobs.
- **New:** a small bounded-pool helper if one is not already available, with a unit test.

## Test Plan

- Unit: M-fact decision produces a batched enqueue (sub-linear write count); semaphore caps in-flight queries at `N`.
- Parity: recall result identical with and without the semaphore; controlled-write output identical with and without enqueue batching (every fact still written, version-bump intact).
- Live (PRD-031/034): a multi-fact session writes all memories correctly; a recall burst stays under the concurrency cap (062a meter), recall-quality eval (PRD-027) unchanged.

## Risks and Open Questions

- **Risk:** write-side batching breaks version-bump ordering and drops a memory. **Mitigation:** the gating safety check; fall back to enqueue-only batching if write batching can't preserve correctness. (Parent open question.)
- **Open question:** semaphore width, and shared storage-layer `Semaphore(5)` vs a separate recall-scoped limit. (Parent open question.)
- **Risk:** lower recall concurrency raises recall latency under heavy bursts. **Mitigation:** size `N` against the 062a load data; the cap is a ceiling, not a throttle on the common case.
