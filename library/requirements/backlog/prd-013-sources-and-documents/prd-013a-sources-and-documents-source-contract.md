# PRD-013a: Source Contract

> **Parent:** [PRD-013](./prd-013-sources-and-documents-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The single source-artifact contract: connect (register and queue an index job), index (artifacts, native graph, chunks), update-in-place, health check, and disconnect-and-purge, with provenance preserved on every derived row. The contract is provider-agnostic; provider-specific code is confined to the ingest stage upstream of the contract. The honeycomb daemon (port 3850) runs the document worker that performs ingest; harness clients never touch DeepLake.

## Goals

- Define one source-artifact contract that behaves identically across Obsidian, Discord, GitHub, and any future provider, so a new provider only adds ingest code.
- Guarantee a clean purge: everything a source produced is removable by that `source_id` and nothing else.
- Preserve provenance on every derived row so source hits stay traceable to the original vault, channel, or repo.
- Keep all reads and writes daemon-mediated and scoped to org and workspace.

## Non-Goals

- Provider-specific ingest behavior (covered by PRD-013c/d/e).
- The lighter ad-hoc document path (covered by PRD-013b).
- Retrieval ranking of source hits beyond carrying provenance through.

## User stories

- As an operator, I want a uniform source contract so that a new provider only adds ingest code while purge, health, and provenance behave identically across sources.
- As a security reviewer, I want every source-derived row scoped and provenanced so that a disconnect provably removes exactly what the source owned.
- As an agent, I want source hits to carry provenance so that I can open the original artifact directly.

## Functional requirements

- FR-1: Every source-derived row MUST carry `source_id`, `source_kind`, `source_path`, and `source_root`, and MUST be scoped to an org and workspace. This applies to `memory_artifacts` rows and to source-owned graph rows (entities, attributes, dependencies).
- FR-2: Connect MUST register the source config and queue an index job. The daemon owns the queue and the DeepLake connection; clients call the daemon, never the store.
- FR-3: Index MUST produce three outputs: per-unit `memory_artifacts` rows with provenance, native graph rows mounted from source topology into the ontology, and provenanced chunks with 768-dim `nomic-embed-text-v1.5` embeddings stored as DeepLake tensors.
- FR-4: Because the DeepLake query endpoint has no parameterized queries, every interpolated path, title, and content value MUST be escaped through the `sqlStr`/`sqlLike`/`sqlIdent` helpers.
- FR-5: Tables MUST be created lazily on first write with lazy schema-healing, so a new source kind requires no migration ahead of its first index.
- FR-6: Update-in-place MUST be watch-driven and single-flight so overlapping re-scan requests coalesce; content fingerprints MUST skip files that have not changed.
- FR-7: Removed files MUST be soft-deleted from `memory_artifacts` and their chunks purged; a rename MUST be treated conservatively as a delete plus an add.
- FR-8: Soft-delete MUST be a status advance written through the append-only, version-bumped path, never an in-place UPDATE, to sidestep DeepLake's UPDATE-coalescing quirk.
- FR-9: `GET /api/sources/:sourceId/health` MUST report artifact and chunk counts, latest artifact and checkpoint timestamps, failure counts, stale or partial checkpoints, purge residue, and source-provenance graph row counts; a source MUST degrade on fetch failures, partial or stale checkpoints, deleted residue, or orphaned chunks.
- FR-10: `DELETE /api/sources/:sourceId` MUST purge in order: source config, `memory_artifacts` rows for the `source_id`, source-owned graph rows, chunk embeddings and their vector tensor mirror; source files MUST be left untouched.
- FR-11: When the daemon is unavailable, the CLI MUST fall back to config-only removal and MUST emit a warning that store-side rows remain.
- FR-12: A partial failure MUST be written as a source-owned failure artifact and reported; a failure MUST never delete existing rows.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a connect, when it completes, then the source is registered and an index job is queued; index produces artifacts, native graph rows, and provenanced chunks. |
| AC-2 | Given a disconnect, when purge runs, then config, `memory_artifacts` rows, source-owned graph rows, and chunk embeddings for that `source_id` are removed and source files are untouched. |
| AC-3 | Given any source-derived row, when inspected, then it carries `source_id`, `source_kind`, `source_path`, `source_root` and is scoped to org and workspace. |
| AC-4 | Given a removed file on a connected source, when the watcher fires, then the row is soft-deleted via a status advance (not an in-place UPDATE) and its chunks are purged. |
| AC-5 | Given a new source kind written for the first time, when index runs, then tables are created lazily without a prior migration. |
| AC-6 | Given the daemon is down, when the CLI removes a source, then config is removed and a warning is emitted that store rows remain. |
| AC-7 | Given a partial fetch failure, when index continues, then a failure artifact is written and reported and no existing row is deleted. |

## Implementation notes

- Every derived row carries `source_id`, `source_kind`, `source_path`, `source_root`, scoped to org and workspace.
- Re-scans are single-flight with content-fingerprint skip; soft-delete is a status advance on the append-only path, not an in-place UPDATE.
- All interpolation into DeepLake SQL goes through `sqlStr`/`sqlLike`/`sqlIdent`; the daemon is the only DeepLake client.

## Dependencies

- DeepLake daemon (port 3850) and the lazy schema-healing write path.
- The ontology mount for native graph rows.
- The retrieval flow that consumes source-provenanced chunks.

## Open questions

- [ ] Confirm the exact health degrade thresholds (failure count, checkpoint staleness window).

## Related

- [parent index](./prd-013-sources-and-documents-index.md)
- [Source Lifecycle](../../../knowledge/private/sources/source-lifecycle.md)
