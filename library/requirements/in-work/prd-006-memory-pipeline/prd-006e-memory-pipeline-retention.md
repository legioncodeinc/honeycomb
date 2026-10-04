# PRD-006e: Retention

> **Parent:** [PRD-006](./prd-006-memory-pipeline-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the retention worker: a batch-limited, idempotent purge sweep over graph links, embeddings, tombstones, history, completed jobs, then dead jobs, plus decay where applicable. DeepLake exposes no transactions at this layer, so retention cannot be a cascading delete; it is a daemon worker running bounded, idempotent sweeps that resume safely after interruption. Each pass purges a capped batch and stops, so cleanup never turns into a long-running, lock-prone delete. Embeddings and vectors are purged with their owning row. The worker is gated by `autonomous.enabled` and halted by `autonomous.frozen`, and only the daemon touches the DeepLake store.

## Goals

- Run retention as a daemon worker performing bounded, idempotent sweeps rather than cascading deletes.
- Purge in a fixed order: graph links, embeddings, tombstones, history, completed jobs, then dead jobs.
- Cap each run by a per-run batch limit so a sweep never runs long or holds locks.
- Resume safely after interruption without double-purging.
- Gate retention by `autonomous.enabled` and halt it with `autonomous.frozen`.

## Non-Goals

- The write-path stages (extraction, decision, controlled writes, graph persistence).
- Backup, export, or archival of purged data.
- Defining the canonical schema; retention purges within the existing tables.

## User stories

- As an operator, I want retention to run as bounded idempotent sweeps so that cleanup never cascades into a long-running, lock-prone delete.
- As a maintainer, I want a hard stop on retention so that I can freeze maintenance during an incident.
- As the system, I want purges ordered so that dependent rows (embeddings, graph links) go before or with their owning rows and nothing is orphaned.

## Functional requirements

- **FR-1** Retention SHALL run as a daemon worker performing batched, idempotent sweeps, not cascading deletes.
- **FR-2** Each sweep SHALL purge in order: graph links, embeddings, tombstones, history, completed jobs, then dead jobs.
- **FR-3** Each run SHALL be bounded by a per-run batch limit, after which the worker SHALL stop and yield until the next scheduled run.
- **FR-4** The sweep SHALL be idempotent: an interrupted run, re-run, resumes safely and does not double-purge.
- **FR-5** Embeddings and vectors SHALL be purged together with their owning row so no orphaned vectors remain.
- **FR-6** Retention SHALL run only when `autonomous.enabled` is set and SHALL halt immediately when `autonomous.frozen` is set.
- **FR-7** Decay SHALL be applied where applicable so aged or low-value memory is down-weighted or eligible for purge per the retention window.
- **FR-8** Every purge SHALL respect `org`, `workspace`, and `agent_id` scope so retention never crosses tenancy.
- **FR-9** All value interpolation SHALL route through the SQL escaping helpers, since the store has no parameterized queries.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given retention runs, when the sweep executes, then it purges in order (graph links, embeddings, tombstones, history, completed jobs, dead jobs) within a per-run batch limit. |
| AC-2 | Given retention is interrupted, when it runs again, then the sweep is idempotent and resumes safely without double-purging. |
| AC-3 | Given a purged row owns embeddings or vectors, when retention runs, then those vectors are purged with the row and not orphaned. |
| AC-4 | Given `autonomous.enabled` is off, when the scheduler fires, then retention does not run. |
| AC-5 | Given `autonomous.frozen` is set, when retention is running or scheduled, then it halts and performs no further purges. |
| AC-6 | Given a per-run batch limit, when a sweep reaches it, then the worker stops and yields rather than continuing. |

## Implementation notes

- DeepLake exposes no transactions at this layer, so retention is batched idempotent sweeps in a daemon worker rather than cascading deletes. Idempotency is what makes the per-run batch cap safe: stopping mid-order and resuming is a normal operating mode, not an error path.
- Embeddings and vectors are purged with their owning row, so the ordered sweep removes dependent structure (graph links, embeddings) ahead of or alongside the owning rows. Soft-delete windows per table need definition (see open questions).
- Gated by `autonomous.enabled` and halted by `autonomous.frozen`, consistent with the other autonomous maintenance workers, so retention shares the same operator brakes as the rest of the pipeline.

## Dependencies

- PRD-003/PRD-004 (the tables retention sweeps: `memories`, embeddings, `memory_history`, `memory_jobs`, graph tables).
- The autonomous flags (`autonomous.enabled`, `autonomous.frozen`) in `agent.yaml`.
- The daemon worker scheduler.

## Open questions

- [ ] What are the soft-delete and retention windows per table (history, completed jobs, dead jobs, tombstones)?
- [ ] What is the per-run batch limit and sweep cadence in production?

## Related

- [parent index](./prd-006-memory-pipeline-index.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [Schema](../../../knowledge/private/data/schema.md)
