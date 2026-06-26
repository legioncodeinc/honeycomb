# PRD-062b: Adaptive Poll Backoff & Single-Lease Consolidation

> **Parent:** [PRD-062: DeepLake Compute Cost Reduction](./prd-062-deeplake-compute-cost-reduction-index.md)
> **Status:** Backlog, draft (2026-06-26). The dominant idle fix. Ships first (Locked-3).
> **Priority:** P0
> **Effort:** M
> **Schema changes:** None (runtime/behavior change over the existing `memory_jobs` schema).

---

## Goals

Kill the constant idle-poll baseline that is Driver 1 of the cost spike. Two changes:

1. **Adaptive exponential backoff.** Replace the hardcoded **1000ms** flat timer in both poll loops ([`stage-worker.ts:158`](../../../../src/daemon/runtime/pipeline/stage-worker.ts) `DEFAULT_POLL_INTERVAL_MS = 1_000`; [`pollinating/worker.ts:151`](../../../../src/daemon/runtime/pollinating/worker.ts)) with a backoff that starts at a fast floor, **doubles toward a ~30s ceiling while the queue keeps returning empty**, and **resets to the floor the instant a job is leased**. An idle daemon polls ~twice a minute instead of ~once a second; an active session is unchanged because the first leased job snaps the interval back to the floor.
2. **Single-lease consolidation.** Stop running **two independent** 1Hz scans of `memory_jobs`. Consolidate the pipeline stage worker and the pollinating worker so a single lease pass per tick covers both kind sets (pipeline + pollinating), each routed to its own handler, instead of two workers each doing the full UNION-scan discovery.

Together these take the idle baseline from `2 workers × 1/s × DISCOVERY_SCAN_POLLS reads` down to `1 pass / 30s × (reduced) reads`, a 1–2 order-of-magnitude cut, measured by the 062a meter.

Optionally, where the eventual-consistency budget allows, **reduce the per-lease UNION-scan poll count** (`DISCOVERY_SCAN_POLLS`, [`job-queue.ts:231`](../../../../src/daemon/runtime/services/job-queue.ts)) so each lease is fewer physical reads, without reintroducing the stale-segment race it defends against.

## Non-Goals

- **No broker migration.** Still polling DeepLake; just polling it rarely when idle and once-not-twice when active. A real message queue is parent-level out of scope.
- **No change to retry/backoff *of failed jobs*.** The job-level exponential backoff (max_attempts 5, base 1s, cap 5min, [`job-queue.ts:54`](../../../../src/daemon/runtime/services/job-queue.ts)) is a different mechanism and stays. This is the **poll-loop** cadence, the empty-queue wait, not the failed-job retry delay.
- **No correctness trade.** AC-10 of the parent: the UNION-scan reduction must not break single-winner lease ownership or reaper reclaim.

---

## User Stories

### US-62b.1 — Idle daemons stop hammering DeepLake

**As a** user running Honeycomb in the background, **I want** the daemon to stop querying DeepLake every second when nothing is happening, **so that** I am not billed for compute while idle.

**Acceptance criteria:**
- AC-62b.1.1 With an empty `memory_jobs` queue and no activity, the poll interval grows geometrically from the floor to the ceiling; a test asserts it reaches the ceiling (~30s) after the expected number of empty leases.
- AC-62b.1.2 The 062a meter shows idle `poll-lease` + `poll-reaper` reads/min dropping by ≥ 1 order of magnitude versus the pre-PRD baseline.

### US-62b.2 — Active sessions keep fast pickup

**As a** user mid-session, **I want** memory jobs picked up as fast as before, **so that** the cost fix does not slow my experience.

**Acceptance criteria:**
- AC-62b.2.1 Any successful `lease()` resets the poll interval to the floor; a test asserts that after a leased job the next tick is at the floor, not the backed-off value.
- AC-62b.2.2 Under sustained load, the effective poll cadence equals the original fast floor, and job pickup latency is unchanged within tolerance.

### US-62b.3 — One poller, not two

**As a** maintainer, **I want** a single lease pass over `memory_jobs` per tick covering both pipeline and pollinating kinds, **so that** the idle and active query count halves without losing kind isolation.

**Acceptance criteria:**
- AC-62b.3.1 A test asserts that one combined lease pass handles pipeline kinds and pollinating kinds per tick, routing each to its handler, and still leaves foreign kinds queued for their owner (parity with the current `lease(kinds)` filter, [`job-queue.ts:122`](../../../../src/daemon/runtime/services/job-queue.ts)).

---

## Technical Considerations

- **Backoff state.** A small per-loop state machine: `currentMs`, reset to `floorMs` on any non-null lease, set to `min(currentMs * 2, ceilingMs)` on a null lease. Add optional jitter to avoid a fleet of daemons synchronizing their wake-ups (thundering-herd against DeepLake).
- **Overlap guard preserved.** The existing "skip a tick if the previous run is still in flight" guard ([`stage-worker.ts` `running` flag](../../../../src/daemon/runtime/pipeline/stage-worker.ts)) stays; backoff composes with it.
- **Consolidation shape (open question).** Either merge pollinating into the stage worker's single timer with a union `lease(kinds)`, or keep two workers sharing one scheduler/lease pass. First is fewer moving parts; second preserves separation. Pick in implementation; both satisfy AC-62b.3.1.
- **UNION-scan reduction (careful).** `DISCOVERY_SCAN_POLLS` defends against DeepLake stale-segment flapping ([`job-queue.ts:34`](../../../../src/daemon/runtime/services/job-queue.ts)). Any reduction must be validated against the live consistency net; if it can't drop safely, leave it and bank the backoff + consolidation wins alone.
- **Flags.** `HONEYCOMB_POLL_BACKOFF_FLOOR_MS`, `HONEYCOMB_POLL_BACKOFF_CEILING_MS`, `HONEYCOMB_POLL_CONSOLIDATE` (or equivalent), read through the existing config provider pattern ([`pollinating/config.ts`](../../../../src/daemon/runtime/pollinating/config.ts)). Flags off ⇒ exact pre-PRD behavior (parent AC-9).

## Files Touched

- **Modified:** [`src/daemon/runtime/pipeline/stage-worker.ts`](../../../../src/daemon/runtime/pipeline/stage-worker.ts) (backoff in the poll loop), [`src/daemon/runtime/pollinating/worker.ts`](../../../../src/daemon/runtime/pollinating/worker.ts) (backoff + consolidation), [`src/daemon/runtime/services/job-queue.ts`](../../../../src/daemon/runtime/services/job-queue.ts) (optional `DISCOVERY_SCAN_POLLS` tuning), config provider for the new env knobs, daemon boot wiring if workers consolidate.
- **New:** a small `poll-backoff.ts` helper (the state machine) + its unit test.

## Test Plan

- Unit: backoff state machine grows on null leases, resets on a lease, respects floor/ceiling/jitter bounds.
- Integration: consolidated worker leases both kind sets in one pass; foreign kinds left queued.
- Live (PRD-031/034): UNION-scan reduction (if attempted) keeps single-winner lease ownership and reaper reclaim (parent AC-10); idle baseline drop confirmed via 062a meter.

## Risks and Open Questions

- **Risk:** worst-case pickup latency for a job enqueued into a fully-idle (ceiling) daemon ≈ the ceiling. **Mitigation:** keep the ceiling modest (~30s) and confirm acceptable; locked tolerance in parent.
- **Risk:** reducing `DISCOVERY_SCAN_POLLS` reintroduces the stale-segment lease race. **Mitigation:** gate it on the live consistency net; ship backoff+consolidation independently of the scan reduction.
- **Open question:** floor value (1000ms? faster under load?), ceiling (30s vs 60s), jitter width. (Parent open questions.)
- **Open question:** expedited patch release of 062b ahead of 062c/d, since the exodus is on the shipped version? (Surface to ci-release-worker-bee.)
