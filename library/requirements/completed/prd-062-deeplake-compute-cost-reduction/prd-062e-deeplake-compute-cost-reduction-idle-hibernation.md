# PRD-062e: Idle Poll Hibernation (zero idle DeepLake reads)

> **Parent:** [PRD-062: DeepLake Compute Cost Reduction](./prd-062-deeplake-compute-cost-reduction-index.md)
> **Status:** Draft (2026-06-29). The follow-on to 062b: take the idle baseline from "slow" to "zero".
> **Priority:** P0 (the residual idle compute burn 062b could not reach)
> **Effort:** S/M (extends the 062b poll loop + the queue reaper; converts the two remaining flat-interval workers onto the same shared loop)
> **Schema changes:** None (a runtime/cadence change over the existing `memory_jobs` schema; append-only version-bump is untouched).

---

## Overview

062b collapsed the idle-poll baseline from a flat 1Hz to an adaptive cadence that backs off to a ~30s ceiling (Locked-1: "idle daemons must go quiet"). That was the dominant fix, but it stops one step short of the goal. Activeloop bills DeepLake "compute (uptime)": a provisioned compute instance billed per hour while warm, which scales to zero only after a sustained window with **no** queries. A query every 30s keeps resetting that idle timer, so the compute never gets to scale down: the daemon still pays a per-hour compute floor at zero user activity, just a smaller one.

062e closes the gap. After a configurable idle window the adaptive poll loop stops re-arming its timer entirely (zero DeepLake polls), so Activeloop compute can finally scale to zero, and a `wake()` seam fired by new work resumes it. The cold-start tradeoff is explicit and acceptable: the first capture or recall after hibernation wakes the loop and Activeloop spins compute back up. Capture is fire-and-forget (the handler returns before the job is processed) and recall reads DeepLake directly (it never needed the poll loop), so the only user-visible effect is a one-time spin-up on the first activity after a long idle.

Two structural facts shape the work:

1. **There is more than one poller.** The pipeline stage worker, the pollinating worker, the summary worker, the skillify worker, and the consolidated lease coordinator each run a poll loop, and the job-queue **reaper** runs its own 5-minute sweep. For compute to reach zero, all of them must go quiet, and any new unit of work must resume all of them. 062b only put the stage and pollinating workers on the adaptive loop; the summary and skillify workers were still hand-rolling a flat 1000ms `setInterval`, so they polled `memory_jobs` at ~1Hz forever and would have kept compute warm on their own. 062e moves them onto the same shared loop.

2. **The enqueue chokepoint is the right wake trigger.** Every unit of background work enters through `JobQueueService.enqueue()` (capture cues, the pipeline entry job, pollinate, fan-out). Firing the wake from there, rather than instrumenting each HTTP handler, covers every work-producing path with one seam and cannot drift.

This is the unfinished half of 062's "idle daemons must go quiet": 062b reached ~30s; 062e reaches zero.

## Goals

- **Zero DeepLake reads at sustained idle.** After `HONEYCOMB_POLL_SUSPEND_AFTER_MS` of accumulated idle, every adaptive poll loop stops polling and the reaper stops sweeping, so a fully idle daemon issues no DeepLake queries and Activeloop compute can scale to zero.
- **Instant, correct wake.** Any new job (any `enqueue`) resumes every hibernated loop and the reaper through a single wake bus; a woken loop snaps back to the fast floor so active-session pickup latency is unchanged.
- **Unify the pollers.** Move the summary and skillify workers off their hand-rolled flat timers onto the shared `buildWorkerPollLoop`, so all four kind-workers share one cadence (backoff + hibernation) and one overlap guard, removing the duplicated timer code.
- **Default-on, fully reversible.** Hibernation ships default-on (matching 062b's cost-fix posture) and is gated by `HONEYCOMB_POLL_SUSPEND_ENABLED` and `HONEYCOMB_POLL_SUSPEND_AFTER_MS`, so a regression is a config rollback to 062b's steady ~30s cadence, not a redeploy.

## Non-Goals

- **Moving the queue off DeepLake.** A local or pluggable single-user queue backing (so idle equals zero DeepLake reads structurally, not just by suspension) is the deeper fix and is sketched as a separate future PRD (see Risks and Open Questions). It touches the team-sharing contract and is out of scope here.
- **Changing the append-only write pattern.** `memory_jobs` stays append-only version-bumped; 062e changes cadence only, never the write semantics (an in-place UPDATE on this backend is provably non-deterministic, per the `job-queue.ts` header).
- **Team-mode semantics.** The shared queue stays correct in TEAM mode: hibernation is a per-daemon local cadence decision, and the wake fires on every enqueue, so no daemon ever sleeps through work it owns.

## User Stories

### US-62e.1 - A fully idle daemon stops touching DeepLake
As a cost-sensitive operator, when my queue is empty and I am not working, I want the daemon to stop polling DeepLake entirely after a few minutes, so Activeloop compute scales to zero and I stop paying a per-hour idle floor.

### US-62e.2 - The first capture after idle just works
As a user, when I start a new session after the daemon has hibernated, I want my capture to be processed normally (after a one-time compute spin-up), with no lost data and no manual restart.

### US-62e.3 - I can roll back to 062b's behavior
As an operator, if hibernation ever causes a problem, I want to set one env flag to restore 062b's steady ~30s ceiling cadence without a redeploy.

## Technical Considerations

- **Suspend decision in the pure state machine.** `PollBackoff` (PRD-062b) gains a clock-free idle accumulator: each empty lease adds the post-step delay to an `idleMs` sum, a lease or a wake resets it, and `shouldSuspend()` reports `true` once it passes `suspendAfterMs`. It stays pure (the accumulator sums the machine's own un-jittered steps, never a wall-clock read), so a pinned-jitter test asserts the exact empty-lease count at which suspension trips.
- **The loop stops re-arming, plus a `wake()` seam.** `AdaptivePollLoop` consults `shouldSuspend()` in its re-arm step and, when true, does not schedule the next tick (it goes quiet). `wake()` resets the backoff to the floor and, only if the loop had actually suspended, re-arms; a suspended loop holds no pending timer, so `wake()` can never double-arm. `start()` is now idempotent (a second start never leaks a second timer), which the summary/skillify conversion relies on.
- **One wake bus, fired at the enqueue chokepoint.** A tiny `WakeBus` fans a single `wake()` to every registered loop and the reaper. The queue calls it via an injected `onEnqueue` after a successful append, so every capture/pollinate/fan-out job resumes the fleet without touching the HTTP handlers. Recall is intentionally not a separate wake trigger: it reads DeepLake directly and creates no queue work, so a hibernated fleet has nothing for it to resume; any work recall might enqueue already flows through the chokepoint.
- **The reaper hibernates too.** The queue reaper has nothing to reclaim when the queue is idle (no leases exist). After a small number of consecutive sweeps that observe no queued or leased work, it stops re-arming its 5-minute timer; `wakeReaper()` (registered on the bus) resumes it. A queued job counts as active so the reaper never suspends between an enqueue and the worker leasing it, and a >1 consecutive-idle threshold absorbs a single DeepLake stale-segment under-read.
- **Flags.** `HONEYCOMB_POLL_SUSPEND_ENABLED` (default-on when absent; explicit `false`/`0` rolls back) and `HONEYCOMB_POLL_SUSPEND_AFTER_MS` (default 300000; `0` disables), read through the same `envPollBackoffConfigProvider` as the 062b knobs. Suspension only ever engages when backoff itself is on, so with `HONEYCOMB_POLL_BACKOFF_ENABLED=false` the daemon is byte-for-byte the pre-062 flat path (parent AC-9).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-62e.1 | With suspension on, a poll loop idle for `suspendAfterMs` stops arming timers entirely (zero further DeepLake polls), verified on the manual-clock fake (no live DeepLake). |
| AC-62e.2 | `wake()` resumes a suspended loop at the fast floor and it ticks again; `wake()` never double-arms a live loop and is a no-op after `stop()`. |
| AC-62e.3 | A new job (`enqueue`) fires `onEnqueue`, which through the wake bus resumes every hibernated loop and the reaper. |
| AC-62e.4 | The reaper hibernates after consecutive idle sweeps (no queued or leased work) and resumes on the next enqueue's wake; it never suspends while active work is visible. |
| AC-62e.5 | The summary and skillify workers run on the shared adaptive loop and hibernate like the others (no remaining flat-interval poller). |
| AC-62e.6 (parity) | With `HONEYCOMB_POLL_SUSPEND_ENABLED=false` (or `HONEYCOMB_POLL_SUSPEND_AFTER_MS=0`) the loops back off but never suspend (062b's steady ceiling cadence); with backoff itself off, the daemon is the exact pre-062 flat path (parent AC-9). |

## Files Touched

- `src/daemon/runtime/services/poll-backoff.ts` - suspend config knobs + env reads + idle accumulator + `shouldSuspend()`/`onWake()`.
- `src/daemon/runtime/services/poll-loop.ts` - `wake()`, `suspended` state, skip-re-arm on suspend, idempotent `start()`.
- `src/daemon/runtime/services/wake-bus.ts` - new tiny registry that fans `wake()` to every poller.
- `src/daemon/runtime/services/job-queue.ts` - `onEnqueue` callback + reaper idle-suspend + `wakeReaper()`.
- `src/daemon/runtime/services/lease-coordinator.ts`, `pipeline/stage-worker.ts`, `pollinating/worker.ts` - expose `wake()` (delegates to the loop).
- `src/daemon/runtime/summaries/job.ts`, `skillify/worker.ts` - convert from a hand-rolled flat `setInterval` onto `buildWorkerPollLoop` (gains backoff + hibernation; removes duplicated timer code).
- `src/daemon/runtime/assemble.ts` - build the wake bus, register every loop + the reaper, inject `onEnqueue`, thread the resolved backoff config into the summary/skillify builders.

## Test Plan

- Pure state-machine suspend assertions in `poll-backoff.test.ts` (idle accumulator trips at the expected empty-lease count; lease/wake reset it; the two off-switches disable it; default-on env resolution and explicit rollback).
- Loop suspend/wake behavior in `poll-loop.test.ts` on the existing manual-clock fake (stops arming after the idle window; `wake()` re-arms at the floor and resumes; no double-arm; no-op after stop; suspend-disabled never hibernates; idempotent start).
- Reaper hibernation + the enqueue wake chokepoint in `job-queue.test.ts` on the in-memory append-only store (enqueue fires `onEnqueue`; the reaper goes quiet after idle and an enqueue's wake resumes it; suspend-disabled keeps sweeping).
- The 062b AC-9 parity test (`poll-parity.test.ts`) and the summary/skillify worker suites stay green, proving the conversion and the default-safe gating.

## Risks and Open Questions

- **Does Activeloop compute actually scale to zero on true idle?** 062e rests on the premise that hosted compute auto-suspends after a sustained no-query window. The strongest evidence is the ~100x cost drop the fleet saw after 062b (consistent with poll frequency driving warm-compute cost, with the residual 30s poll the last thing keeping it warm). 062a's query meter should confirm reads go to zero at idle and resume on the next capture; the live before/after compute-hours number is the final proof. If hosted compute does not auto-suspend at all, 062e is still a correct poll-reduction but the savings would require the queue-off-DeepLake path below.
- **Future PRD: local / pluggable single-user job-queue backing (#1).** Hibernation removes idle reads by stopping the timer; a local queue backing (the daemon already ships a `node:sqlite` store) would remove them structurally for single-user mode, so DeepLake only ever sees batched capture-writes and on-demand recall-reads. This changes the team-sharing contract (the queue is shared across daemons in TEAM mode), so it must be gated behind single-user mode and needs maintainer buy-in. Recommended as a separate PRD rather than folded in here.
