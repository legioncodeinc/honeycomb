# PRD-003a: Memories, Embeddings, and History

> **Parent:** [PRD-003](./prd-003-core-data-model-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Define the distilled-memory engine tables: `memories` (the kept facts recall ranks over), the `content_embedding` tensor column and its GPU-mirrored vector storage, `memory_history` (the audit trail of every proposal), and `memory_jobs` cross-reference for distillation provenance. These are DeepLake `USING deeplake` tables written exclusively by the daemon on port 3850, scoped by `agent_id` and `visibility` within a workspace, with org and workspace isolation enforced at the storage partition layer.

## Goals

- Declare `memories` as a `{ name, sql }` column-definition array the create path and lazy heal path share, carrying confidence, importance, provenance, dedup hash, and scope.
- Store `content_embedding` as a nullable 768-dim `FLOAT4[]` tensor column that GPU vector search ranks over in the same query as the structured filters.
- Declare `memory_history` so shadow mode (`pipeline-shadow`), applied pipeline writes, and harness writes are all auditable.
- Keep all writes consistent with DeepLake patterns: append-only history, content-hash dedup, soft-delete over in-place delete.

## Non-Goals

- The pipeline extraction, decision, and write logic that produces these rows (PRD-006).
- The retrieval ranking and authorization that read `memories` (PRD-007).
- The `memory_jobs` queue lifecycle itself (PRD-004b); this module only references it.
- The storage adapter primitives and SQL helpers (PRD-002).

## User stories

- As the pipeline, I want a `memories` table with confidence, importance, provenance, dedup hash, and scope so that recall can rank and the audit trail is complete.
- As recall, I want a nullable 768-dim `content_embedding` so semantic search runs on GPU against the same rows, and degrades to lexical search when embedding is off.
- As an operator running shadow mode, I want `memory_history` to record every proposal with the actor that produced it so I can audit what the pipeline would have done.

## Functional requirements

- FR-1: The catalog defines `memories` with the columns `id`, `type` (default `'fact'`), `content`, `normalized_content`, `content_hash`, `confidence` (`FLOAT4` default `1.0`), `importance` (`FLOAT4` default `0.5`), `tags`, `who`, `project`, `source_id`, `source_type`, `pinned`, `is_deleted`, `extraction_status` (default `'none'`), `agent_id` (default `'default'`), `visibility` (default `'global'`), `content_embedding` (`FLOAT4[]`), `created_at`, `updated_at`.
- FR-2: `content_hash` holds a SHA-256 over `normalized_content` and is the dedup key the decision stage checks before INSERT.
- FR-3: `content_embedding` is a nullable 768-dim `nomic-embed-text-v1.5` `FLOAT4[]` tensor column; recall runs GPU vector search against it and falls back to lexical filters when it is `NULL`.
- FR-4: Soft-delete advances `is_deleted` (BIGINT 0/1) with a purge window; rows are never deleted in place outside the batched retention sweep.
- FR-5: The catalog defines `memory_history` as an append-only audit trail with `changed_by` distinguishing `harness`, `pipeline`, and `pipeline-shadow`, plus the proposed operation, target `memory_id`, before/after payload, and timestamp.
- FR-6: Every `memories` write goes through the daemon's escaping helpers (`sqlStr`, `sqlIdent`) and the lazy heal pass; no other process writes the table.
- FR-7: First write to `memories` or `memory_history` creates the table from its column-definition array; a missing-column write triggers a targeted `ALTER TABLE ADD COLUMN` heal and one retry.
- FR-8: `pinned` rows are exempt from retention decay; `extraction_status` tracks the per-row distillation lifecycle for diagnostics.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a distilled fact, when written, then the `memories` row carries `content_hash`, `confidence`, `importance`, `source_id`, `agent_id`, `visibility`, and a nullable 768-dim `content_embedding`. |
| AC-2 | Given any proposal, when processed, then `memory_history` records it with `changed_by` set to `harness`, `pipeline`, or `pipeline-shadow`. |
| AC-3 | Given two facts with identical `normalized_content`, when the second is proposed, then its `content_hash` matches and the decision stage skips the duplicate INSERT. |
| AC-4 | Given embedding is disabled, when a memory is written, then `content_embedding` is `NULL` and recall still returns the row via lexical filters. |
| AC-5 | Given a soft-deleted memory, when retention has not yet purged it, then `is_deleted = 1` and the row is excluded from recall but retained for the audit window. |
| AC-6 | Given the `memories` table does not yet exist, when the first INSERT runs, then it is created from the column-definition array and the INSERT is retried once. |
| AC-7 | Given shadow mode is active, when the pipeline proposes a write, then `memory_history` records `changed_by = 'pipeline-shadow'` and `memories` is not mutated. |

## Implementation notes

- Daemon modules: the schema definition module owns the `memories`, `memory_history` column-definition arrays; the storage adapter (PRD-002) owns create/heal/escape.
- DeepLake write patterns: `memories` is UPDATE-or-INSERT by `id` for the kept-fact identity but most edits land as new rows with superseding handled in the graph layer (PRD-003b); `memory_history` is strictly append-only INSERT.
- Embeddings live solely on the `content_embedding` column; the "mirror" is the GPU vector index DeepLake maintains over that tensor column, not a second table.
- Edge cases: NUL and control characters are stripped by `sqlStr`; text bodies with escape sequences use the `E'...'` literal form so doubled-backslash escaping round-trips.
- Failure handling: a `NOT NULL` column without a `DEFAULT` is rejected at load time by the heal guard, because adding it to a populated table would fail.

## Dependencies

- PRD-002 storage adapter (create, heal, `sqlStr`/`sqlIdent`/`sqlLike`).
- PRD-004b `memory_jobs` queue (distillation work that writes these tables).
- PRD-006 memory pipeline (producer); PRD-007 retrieval (consumer).

## Open questions

- [ ] Should `memory_history` retain a coarse embedding diff, or only the textual before/after payload?
- [ ] What is the default soft-delete purge window before a row leaves the audit trail?

## Related

- [parent index](./prd-003-core-data-model-index.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
