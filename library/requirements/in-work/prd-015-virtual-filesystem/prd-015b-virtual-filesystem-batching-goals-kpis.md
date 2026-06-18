# PRD-015b: Batching and Goals/KPIs

> **Parent:** [PRD-015](./prd-015-virtual-filesystem-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

The batched-and-debounced write path (flush at 10 pending or 200 ms, serialized through a flush chain) and the goal/kpi lifecycle expressed through filesystem verbs, where `rm` is a soft-close and `mv` is a status transition.

## Goals

- Coalesce the bursty write pattern of an agent editing several files in quick succession into a handful of daemon round-trips.
- Serialize flushes so two never interleave, and re-queue any row a flush rejected.
- Route every write to the correct backing table by path kind, working around DeepLake's UPDATE-coalescing quirk.
- Express the goals and kpis lifecycle entirely through filesystem verbs so agents manage objectives with `Write` and `mv` while the CLI reads typed columns.

## Non-Goals

- Path classification, read precedence, and the bridges (PRD-015a).
- The goal/kpi CLI surface (`honeycomb goal list`) that reads the structured tables (owned by the surfaces module).
- DeepLake escaping internals and embedding computation (consumed here; owned elsewhere).

## User stories

- As an agent, I want to manage objectives by writing and moving markdown files so that the CLI reads the same goal state from typed columns.
- As an agent, I want quick successive writes to feel instant so that buffering and flushing stay invisible.
- As an agent, I want `rm` on a goal to close it, not erase it, so that the audit trail of objectives is preserved.

## Functional requirements

- **FR-1 Buffer then flush.** `writeFile` updates the in-memory cache and tree, enqueues a `PendingRow`, and either flushes immediately when `pending.size` reaches the batch size of 10 or schedules a debounced flush 200 ms out.
- **FR-2 Serialized flush chain.** Flushes are serialized through a promise chain (`flushChain`) so two never interleave. `_doFlush` drains the pending map, computes 768-dim `nomic-embed-text-v1.5` embeddings for the batch (skipping the embed hop and writing NULL when embeddings are globally disabled), and writes every row in parallel via `Promise.allSettled` dispatched to the daemon.
- **FR-3 Re-queue rejected rows.** Any row a flush fails is re-queued for the next flush unless a newer version was written in the meantime, and the flush throws so callers know some writes were deferred.
- **FR-4 Dispatch by path kind.** `upsertRow` dispatches by kind: goal and kpi writes route to `upsertGoalRow`/`upsertKpiRow`, which do SELECT-before-INSERT keyed by `goal_id` (or `goal_id, kpi_id`) to work around DeepLake's UPDATE coalescing.
- **FR-5 Generic memory upsert.** A generic path already in the `flushed` set rewrites `summary`, `summary_embedding`, `mime_type`, `size_bytes`, and `last_update_date` (plus optional `project`, `description`); a fresh path gets a full INSERT with a new UUID. The `flushed` set lets a later flush of the same path coalesce rather than double-insert.
- **FR-6 Append fast path.** `appendFile` on an existing file issues a SQL-level concatenation (`summary = summary || E'...'`) and invalidates the content cache, making append O(1) per call rather than read-modify-write.
- **FR-7 SQL escaping.** Text bodies are escaped with `sqlStr` and written with the `E'...'` literal form because DeepLake offers no parameterized queries.
- **FR-8 `rm` is soft-close.** `rm` on a goal path writes the goal's content to canonical `closed/<goal_id>.md` (status flipped to `closed`) via `upsertGoalRow`, moves the cache entry to the closed folder, and removes the old tree entry; `rm` on an already-closed goal is a no-op, so history cannot be wiped.
- **FR-9 `mv` is a status transition.** `mv` between goal paths enforces that only the status component may change (the `goal_id` and `owner` must match, or it fails `EPERM`), avoiding a cp-then-rm double-write.
- **FR-10 Stable ordering.** Both `rm` and `mv` preserve `created_at` and record the edit in `updated_at`, keeping goals in stable creation order in listings.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given several quick writes, when they enqueue, then they coalesce and flush at 10 pending or after a 200 ms debounce, serialized so two flushes never interleave, with rejected rows re-queued. |
| AC-2 | Given `rm` on a goal path, when it runs, then the goal is soft-closed (status flipped to `closed`, row preserved) rather than deleted, and `rm` on an already-closed goal is a no-op. |
| AC-3 | Given `mv` between goal paths, when only the status differs, then the transition succeeds, and when `goal_id` or `owner` differs, then it fails with `EPERM`. |
| AC-4 | Given a flush with embeddings disabled, when rows are written, then the embed hop is skipped and NULL is written for the vector columns. |
| AC-5 | Given `appendFile` on an existing file, when it runs, then it issues a SQL-level concat and invalidates the cache rather than reading the body back first. |
| AC-6 | Given a goal or kpi write, when it flushes, then it routes through SELECT-before-INSERT keyed by `goal_id` (or `goal_id, kpi_id`). |

## Implementation notes

- `upsertRow` dispatches by path kind; goal/kpi writes do SELECT-before-INSERT to work around DeepLake UPDATE coalescing. The flush is dispatched to the daemon, the only DeepLake client.
- `decomposeGoalPath` extracts `owner`, `status`, `goal_id` from the path; the row's `content` column stores only the markdown body; `composeGoalPath`/`composeKpiPath` rebuild the canonical mount-relative path.
- KPI paths validate as `memory/kpi/<goal_id>/<kpi_id>.md` (three segments, `.md` leaf); anything else falls back to the generic `memory` path.

## Dependencies

- PRD-015a for path classification and the cache/tree model.
- The honeycomb daemon (port 3850) and the embed worker.
- The `goals`, `kpis`, and `memory` tables.

## Open questions

- [ ] Should the batch size (10) and debounce (200 ms) be configurable, or are the defaults fixed?
- [ ] How should the VFS surface conflicts when two agents flush the same generic path concurrently?

## Related

- [parent index](./prd-015-virtual-filesystem-index.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
