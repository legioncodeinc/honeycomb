# PRD-077b: Hot-Lane Isolation and Load-Shedding

> **Parent:** [PRD-077: Per-Turn Recall Fast Path](./prd-077-per-turn-recall-fast-path-index.md)
> **Status:** Draft
> **Priority:** P1 (077a delivers the single-round-trip win; 077b makes it robust under real concurrency and kills the 25-minute tail)
> **Effort:** S-M (~0.5-1d)
> **Schema changes:** None.

## Overview

The 077a fast recall runs its arms **in parallel**, so its wall-clock is ~1.5s only if all its arms can acquire slots at once. But today every recall shares the process-wide `Semaphore(6)` (`recall.ts:115-122`) with the dashboard's heavy recalls and its frequent polls; under real load the six slots saturate, an unbounded queue forms, the fast recall's arms queue behind slow dashboard work, and the ~1.5s wall-clock becomes the measured ~40s average / 25-minute tail. This sub-PRD gives the fast path its own lane, **sized to run its full arm set concurrently**, and bounds both lanes so latency is a function of the query, not of whatever else is in flight.

Four mechanisms:

1. **A dedicated concurrency lane** for the per-turn fast recall, so a burst of dashboard/heavy recalls cannot starve it.
2. **A fast-lane server-side deadline** that aborts a fast recall daemon-side and frees its slot, independent of the client's `AbortController` — today the client aborts at 2.5s but the daemon keeps running the query (that is why `request_log` shows 200s at 40s), holding a slot and load.
3. **Queue-depth load-shedding**: past a configured backlog threshold, a per-turn fast recall fast-fails to an empty (degraded) result instead of enqueuing, so the tail is bounded by construction.
4. **A generous heavy-path server-side deadline** (decision D-4): the dashboard/heavy `recallMemories` path ALSO gets a server-side deadline — set generously (a human waits there and wants full quality) but finite, so a runaway heavy recall is capped. The 25-minute tail becomes structurally impossible on **both** lanes. The heavy path's ranking, arms, and happy-path results are unchanged; only its worst case is bounded.

## Goals

- The per-turn fast recall runs in its own lane and is not blocked by a saturated shared/dashboard pool.
- A server-side deadline bounds every fast recall; a query that exceeds it is aborted daemon-side and its slot released; the handler returns a fail-soft empty result.
- Under pool saturation past a queue-depth threshold, a per-turn fast recall is shed (prompt empty/degraded result), never queued for minutes.
- The per-turn renderer timeout is raised to give the ~1.5s fast query headroom (`DEFAULT_RECALL_TIMEOUT_MS` → ~4s), preserving fail-soft.
- The dashboard/heavy recall gains a **generous server-side deadline** (D-4) so its worst-case latency is bounded — ranking and happy-path results unchanged.
- The 25-minute tail is structurally impossible on **both** lanes.

## Non-Goals

- No change to the dashboard/heavy recall's **ranking, arms, or concurrency budget** — it keeps the shared pool and its full pipeline. It DOES gain a generous server-side deadline (D-4), a safety bound only; it is NOT rerouted to the fast path and its queue is NOT shed.
- No new retry semantics (the bounded `RETRY_ATTEMPTS = 4` layer in `client.ts` is unchanged).
- No local ANN index (parent OQ / future).
- No hive-side poll-cadence change (BUG-19; separate concern).

## Implementation notes

- **Dedicated lane, sized to the arm set.** In the recall concurrency layer (`recall.ts:115-122`, `resolveRecallPool`, `amplificationConfig().recallMaxConcurrency`), give the fast path its own `Semaphore` sized so a single per-turn recall's arms (≈ the heavy arm count, ~6-8) run concurrently — otherwise the "parallel arms" of 077a serialize and the ~1.5s wall-clock is lost. Config-backed via `recallFastMaxConcurrency` (default ≈ the arm count). (A priority-acquire on the shared pool is the alternative; a separate lane is simpler to reason about and preferred.) Note: this lane bounds *one* recall's fan-out; the shed threshold below bounds *concurrent* per-turn recalls.
- **Fast-lane server-side deadline.** Wrap the fast recall's `storage.query` in a daemon-side timeout (an `AbortSignal.timeout` threaded into the transport's existing `req.signal`, `transport.ts:80-113`, which already maps `AbortError` → a timeout `TransportError`). On deadline, release the slot and return `{ hits: [], sources: [], degraded: true }`. Set the deadline comfortably above the ~1.5s fast query and below the ~4s client budget (Open Question: default ~3s).
- **Heavy-path server-side deadline (D-4).** Wrap the heavy `recallMemories` orchestration in a generous daemon-side deadline (Open Question: default ~10-15s) so a runaway heavy recall is aborted and its slots released instead of running to 25 minutes. Prefer a single deadline around the whole `recallMemories` fan-out (all arms + hydrate + dedup + lifecycle) that, on expiry, returns whatever arms completed (partial, `degraded: true`) or an empty degraded result — never a 500, never a hang. Ranking/arms unchanged on the happy path; this is purely a worst-case bound.
- **Load-shedding (fast lane only).** Add a queue-depth check at fast-recall acquire time: if the lane's waiter count exceeds a configured threshold, skip the query and return the fail-soft empty result immediately (optionally emit a structured `recall.shed` event via `daemon.logger`, subsystem-state only — no query text/token, per the D-5 secret-free convention). Config-backed threshold. The heavy/dashboard lane is NOT shed (a human waits) — it relies on its deadline instead.
- **Timeout bump.** Raise `DEFAULT_RECALL_TIMEOUT_MS` (`recall-renderer.ts:55`) from `2_500` to ~`4_000`; keep the fail-soft `""` on abort. The prime path already uses 5s (`prime-renderer.ts:52`), so ~4s is in-family.
- **Config surface.** New knobs (`recallFastMaxConcurrency`, `recallFastDeadlineMs`, `recallFastShedQueueDepth`, `recallHeavyDeadlineMs`) live in the `amplificationConfig` neighborhood, env-overridable, with documented defaults; tuned from `request_log` latency, not hard-guessed.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | A fast recall acquires a slot in its own lane even when the shared/heavy pool is fully saturated. A test saturates the shared pool and asserts a concurrent fast recall still runs and completes within its deadline. |
| b-AC-2 | A fast recall that exceeds the server-side deadline is aborted daemon-side, its slot is released, and the handler returns `{ hits: [], degraded: true }` within the deadline (not a 25-minute hang). A test with a hanging storage stub asserts the handler returns by the deadline and the slot is freed for the next acquire. |
| b-AC-3 | Past the configured queue-depth threshold, a per-turn fast recall is shed: it returns promptly with an empty/degraded result and does NOT enqueue a Deep Lake query. A test drives the lane to the threshold and asserts the next fast recall sheds (query stub not called) and emits the `recall.shed` event. |
| b-AC-4 | `DEFAULT_RECALL_TIMEOUT_MS` is ~4s and the renderer still fails soft to `""` past it. A test asserts the constant and the fail-soft behavior. |
| b-AC-5 | The dashboard/heavy recall path's concurrency behavior is unchanged. A test asserts heavy recalls still use the shared pool with its existing budget. |
| b-AC-6 | The new knobs (`recallFastMaxConcurrency`, `recallFastDeadlineMs`, `recallFastShedQueueDepth`, `recallHeavyDeadlineMs`) are config-backed with documented defaults and env overrides. A test asserts defaults resolve and an env override is honored. |
| b-AC-7 | Fail-soft end to end: deadline, shed, transport error, and malformed body all degrade to "no injection," never a thrown hook or a 500. A test asserts each path yields a clean degraded result. |
| b-AC-8 | (D-4) The dashboard/heavy `recallMemories` path is bounded by a generous server-side deadline: a heavy recall that exceeds it is aborted daemon-side, its slots released, and the handler returns a partial-or-empty `degraded: true` result within the deadline — never a 25-minute hang, never a 500. A test with a hanging arm asserts the heavy handler returns by the deadline and frees its slots, and that a fast (sub-deadline) heavy recall is unaffected (ranking/results unchanged). |

## Resolved decisions (2026-07-09)

- **D-4 — Bound both lanes.** The heavy/dashboard `recallMemories` path gets a generous server-side **deadline** (safety bound), in addition to the fast-lane deadline + shedding. The heavy path is NOT shed and NOT rerouted; its ranking/arms are unchanged — only its worst case is capped, so the 25-minute tail is impossible everywhere.

## Open questions

- Separate fast `Semaphore` vs priority-acquire on the shared pool (recommend a separate small lane for isolation).
- **Deadline values + shed threshold:** fast-lane deadline (~3s), heavy-path deadline (generous, ~10-15s, per D-4), and the fast-lane shed queue-depth — set defaults, tune from `request_log` latency.
- On the heavy-path deadline expiry, return **partial** results (whatever arms completed, `degraded: true`) vs an **empty** degraded result — decide which is the better dashboard UX (partial is likely friendlier; confirm the fusion/render path tolerates a partial arm set, which the per-arm `toScoredIds`-to-`[]` tolerance suggests it does).
