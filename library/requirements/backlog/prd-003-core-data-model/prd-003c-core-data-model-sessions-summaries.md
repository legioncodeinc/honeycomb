# PRD-003c: Sessions, Transcripts, and Summaries

> **Parent:** [PRD-003](./prd-003-core-data-model-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Define the capture and summary tables on DeepLake: `sessions` (the raw event stream, one row per prompt, tool call, or response), the session transcript lineage the summary worker persists at session end, and `memory` (the wiki-summary and virtual-filesystem file rows). All are `USING deeplake` tables written only by the daemon on port 3850. The naming is fixed and unambiguous: `sessions` is raw capture, `memory` is VFS and summaries, and `memories` (PRD-003a) is distilled facts.

## Goals

- Declare `sessions` as an append-only INSERT table, one row per event, with a JSONB `message` and an optional 768-dim `message_embedding`.
- Declare `memory` as an UPDATE-or-INSERT-by-`path` table whose `summary` body and `summary_embedding` power the virtual filesystem and semantic recall over summaries.
- Settle the session transcript artifact as a `memory` path convention rather than a distinct table.
- Keep the three "memory" tables strictly separated in role with no column overlap that blurs them.

## Non-Goals

- The capture shim logic that maps harness events to `sessions` INSERTs (PRD-005).
- The summary worker and skillify miner that write `memory` and `skills` (PRD-006, product modules).
- The VFS dispatch and shell-command browse layer (separate VFS module); this declares only the backing table.
- The storage adapter primitives (PRD-002).

## User stories

- As capture, I want an append-only `sessions` table with a JSONB `message` and optional embedding so one INSERT per event never races a concatenating writer.
- As the summary worker, I want a `memory` table keyed by `path` so a wiki summary upserts in place and recall can search summaries semantically.
- As an agent browsing the VFS, I want `memory` rows addressable by `path` so I can list and read them with ordinary shell-style commands.

## Functional requirements

- FR-1: The catalog defines `sessions` with `id`, `path`, `filename`, `message` (`JSONB`), `message_embedding` (`FLOAT4[]`), `author`, `agent`, `project`, `plugin_version`, `creation_date`, `last_update_date`.
- FR-2: `sessions` is append-only INSERT, one row per event; readers reconstruct a turn stream by selecting on `path` ordered by `creation_date` and concatenating, never by mutating a single row.
- FR-3: `message_embedding` is a nullable 768-dim `FLOAT4[]` tensor column; capture attaches it optionally and recall over raw events falls back to lexical search when it is `NULL`.
- FR-4: The catalog defines `memory` with `id`, `path`, `filename`, `summary`, `summary_embedding` (`FLOAT4[]`), `author`, `mime_type` (default `'text/plain'`), `project`, `agent`, `creation_date`, `last_update_date`.
- FR-5: `memory` is UPDATE-or-INSERT keyed by `path`; the summary worker upserts wiki summaries and the VFS upserts file rows at their path.
- FR-6: The session transcript lineage is persisted as a `memory` path convention (for example a `transcripts/<session>` path) rather than a distinct table.
- FR-7: All writes go through the daemon escaping helpers and lazy heal; both tables are created on first write from their column-definition arrays.
- FR-8: `sessions` rows are subject to the `sessions prune` retention operation while their derived summaries are retained in `memory`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a turn event, when captured, then a `sessions` row is INSERTed with a JSONB `message`, an optional 768-dim `message_embedding`, and a `path` readers concatenate by `creation_date`. |
| AC-2 | Given a wiki summary or VFS file, when written, then a `memory` row is UPDATE-or-INSERT keyed by `path` with a `summary` body and `summary_embedding`. |
| AC-3 | Given the three memory tables, when inspected, then `sessions` holds raw events, `memory` holds VFS and summaries, and `memories` holds distilled facts, with no overlapping role. |
| AC-4 | Given a session ends, when the transcript is persisted, then it lands as a `memory` path convention, not a new table. |
| AC-5 | Given embedding is disabled, when an event is captured, then `message_embedding` is `NULL` and the row is still recoverable by `path` and lexical filters. |
| AC-6 | Given `sessions` raw events are pruned by retention, when the prune runs, then the derived `memory` summaries are retained. |
| AC-7 | Given the `sessions` or `memory` table does not exist, when the first write runs, then it is created from its column-definition array and the write retries once. |

## Implementation notes

- Daemon modules: schema definition module owns the `sessions` and `memory` column-definition arrays; capture intake (PRD-005) is the `sessions` writer; the summary worker is the `memory` writer.
- DeepLake write patterns: `sessions` uses append-only INSERT; `memory` uses UPDATE-or-INSERT by `path`, accepting the documented UPDATE-coalescing trade-off for the rare two-writes-within-microseconds case.
- Session transcripts are a `memory` path convention, not a distinct table.
- Edge cases: concurrent capture INSERTs never collide because each is its own row; a `memory` path collision resolves to last-writer-wins under the UPDATE quirk, acceptable for the small-team v1.
- Failure handling: missing table or column heals and retries once; a JSONB `message` with control characters is escaped via `sqlStr` before interpolation.

## Dependencies

- PRD-002 storage adapter and SQL helpers.
- PRD-005 capture intake (producer of `sessions`).
- Summary and VFS modules (producers/readers of `memory`).

## Open questions

- [ ] What is the exact transcript path convention under `memory` (`transcripts/<session>` versus per-agent namespacing)?
- [ ] Should `sessions` carry a coarse `event_type` column to speed prune and turn-stream reconstruction?

## Related

- [parent index](./prd-003-core-data-model-index.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
