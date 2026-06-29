# Idle Meter Live Report: PRD-066

**Run date:** 2026-06-29
**Command:** `npx vitest run --config vitest.integration.config.ts tests/integration/local-queue-idle-meter-live.itest.ts`
**Test file:** `tests/integration/local-queue-idle-meter-live.itest.ts`

## Result

The live query-meter proof passed against the shared `~/.deeplake/credentials.json` credentials.
After the account was funded, the active write proof also passed in the same test file.

| Mode | Poll Reads | Poll Writes |
|---|---:|---:|
| Shared DeepLake-backed queue | 39 | 0 |
| Local SQLite queue enabled | 0 | 0 |
| Local queue active memory pipeline | 0 | 0 |

| Active Work | Total Reads | Total Writes |
|---|---:|---:|
| Local queue memory pipeline writing to DeepLake | 67 | 15 |

## What Was Measured

The test boots a real assembled daemon in local mode with a live `StorageClient` and injected `QueryMeter`.
It resets the meter after startup, waits a short idle window, then performs an empty local-only
`lease(["summary"])` probe. The shared-queue run demonstrates the old DeepLake coordination read path;
the local-queue run demonstrates that the same idle/job-discovery path does not hit DeepLake when
`HONEYCOMB_LOCAL_QUEUE_ENABLED=true` and `HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED=false`.

The active-memory test enqueues a real local `memory_extraction` job through the hybrid queue with the
shared queue disabled for local job kinds. It verifies the pipeline reaches controlled write and graph
persist, writes throwaway DeepLake tables, and still records zero DeepLake coordination poll
reads/writes while active work performs real DeepLake storage reads/writes.

## Remaining Scope

This proves the idle queue coordination cost path and active memory write/graph behavior. Recall-read
categorization, long dogfood sleep/wake behavior, and transient DeepLake outage behavior remain separate
rollout checks.
