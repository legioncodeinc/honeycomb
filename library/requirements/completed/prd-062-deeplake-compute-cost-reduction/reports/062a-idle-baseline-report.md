# PRD-062a Idle-Baseline Report (SCAFFOLD — fill with live numbers)

> **Status:** Scaffold. The instrumentation (062a, L-A1/L-A2) is built and unit-proven; the
> live reads/min figures below are placeholders for the smoker to fill from a real idle-daemon run.
> This report is the PRD-062 **"before"** figure every later sub-PRD measures its **after** against.

## What this measures

A daemon with an **empty `memory_jobs` queue** and **no user activity** still issues DeepLake
reads forever — the idle-poll baseline (PRD-062 Driver 1). The 062a query meter (in
[`src/daemon/storage/query-meter.ts`](../../../../../src/daemon/storage/query-meter.ts), wired at the
single storage choke point in [`client.ts`](../../../../../src/daemon/storage/client.ts)) attributes
every DeepLake read/write to a `source` label and counts reads vs writes per source. This report
records the idle reads/min/daemon and the polling share.

## How to reproduce

1. Boot a daemon with valid credentials, an **empty** `memory_jobs` queue, and **no** capture/recall
   activity (no hooks firing, no recall calls).
2. Let it idle for a fixed window (suggest **5 min**).
3. Read the periodic query-meter log line (`[query-meter] total_reads=… total_writes=… <source>=r:…/w:…`)
   at window open and close; the per-source delta over the window is the baseline.
   - For an offline/CI demonstration of the meter math (no live creds), see the harness
     `tests/helpers/idle-baseline-harness.ts` driven by `tests/daemon/storage/query-meter.test.ts`.

## Idle baseline (FILL IN)

| Metric | Value |
|---|---|
| Window length | `<e.g. 5 min>` |
| Total DeepLake reads in window | `<N>` |
| **Idle reads / min / daemon** | `<N / minutes>` |
| `poll-lease` reads | `<N>` |
| `poll-reaper` reads | `<N>` |
| `capture-write` (expect ~0 idle) | `<N>` |
| `recall-arm` (expect ~0 idle) | `<N>` |
| **Polling share of reads** | `<(poll-lease + poll-reaper) / total>` |

## Before / after ledger (later sub-PRDs fill the "after")

| Sub-PRD | Lever | Before (062a) | After | Δ |
|---|---|---|---|---|
| 062b | Adaptive poll backoff + single-lease consolidation | `<idle reads/min>` | `<…>` | `<…>` |
| 062c | Capture write batching + envelope trim | `<capture writes/event>` | `<…>` | `<…>` |
| 062d | Fan-out coalescing + recall concurrency cap | `<peak in-flight recall reads>` | `<…>` | `<…>` |

## Notes

- The meter default posture is **in-memory + structured log only**: it adds **zero** DeepLake queries.
  Persistence to `telemetry_counters` is gated behind the **unused** `HONEYCOMB_QUERY_METER_PERSIST`
  flag and is not implemented in 062a.
- `source` labels for the poll/reaper/capture/recall call sites are threaded by **later waves**; until
  then those call sites count under `other`, so an early idle run may show a large `other` share that
  later resolves into the labeled sources.
