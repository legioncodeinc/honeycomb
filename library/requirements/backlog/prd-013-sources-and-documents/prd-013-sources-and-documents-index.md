# PRD-013: Sources and Documents

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Schema changes:** Additive

---

## Overview

A source is a read-only external knowledge base that Honeycomb mounts as evidence: source artifacts are evidence, recall rows derived from them preserve provenance, and everything a source produced stays purgeable by that source. Source files themselves are never modified. This module establishes a single source-artifact contract that works across vaults, repos, and chat, confining provider-specific code to the ingest stage upstream of the contract, plus the lighter document path for ad-hoc text, URLs, and files. The daemon runs the document worker that does the connect, index, update-in-place, health, and purge lifecycle; harness clients never touch the store. Every source-derived row carries `source_id`, `source_kind`, `source_path`, and `source_root`, scoped to org and workspace, which is what makes a clean purge possible. On top of the contract sit three providers: Obsidian vaults, Discord (REST, gateway-tail, desktop-cache), and GitHub (issues, PRs, discussions, Markdown docs).

## Goals

- Define one source-artifact contract (connect, index, update-in-place, health, purge) with provenance on every derived row.
- Run the document ingest lifecycle (chunk, embed, index) in the daemon's worker, separate from full source mounts.
- Mount Obsidian vaults with artifacts per file, native graph from vault topology, and heading-split chunks.
- Index Discord across REST, gateway-tail, and desktop-cache sync modes without ever deleting previously indexed rows on failure.
- Index GitHub issues, PRs, discussions over GraphQL and selected Markdown docs over REST, bounded by limits and path globs.

## Non-Goals

- Ingesting arbitrary source code from GitHub; doc ingestion is limited to Markdown.
- Recall and retrieval ranking internals (consumed here; owned by the retrieval module).
- Modifying or writing back to source files; sources are read-only evidence.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-013a-sources-and-documents-source-contract`](./prd-013a-sources-and-documents-source-contract.md) | Connect/index/health/purge contract and provenance. | Draft |
| [`prd-013b-sources-and-documents-document-worker`](./prd-013b-sources-and-documents-document-worker.md) | Document ingest (chunk/embed/index) lifecycle. | Draft |
| [`prd-013c-sources-and-documents-obsidian`](./prd-013c-sources-and-documents-obsidian.md) | Obsidian vault provider. | Draft |
| [`prd-013d-sources-and-documents-discord`](./prd-013d-sources-and-documents-discord.md) | Discord provider (REST, gateway-tail, desktop-cache). | Draft |
| [`prd-013e-sources-and-documents-github`](./prd-013e-sources-and-documents-github.md) | GitHub provider (issues/PRs/discussions/docs). | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a connected source, when a row is derived from it, then that row carries `source_id`, `source_kind`, `source_path`, and `source_root` and is scoped to org and workspace. |
| AC-2 | Given a source disconnect, when purge runs, then all artifacts, graph rows, and chunk embeddings for that `source_id` are removed and the source files are left untouched. |
| AC-3 | Given a document submitted to `POST /api/documents`, when the worker runs, then it advances queued -> extracting -> chunking -> embedding -> indexing -> done, and an identical URL is deduplicated to the existing record. |

## Data model changes

Additive: source-provenance columns (`source_id`, `source_kind`, `source_path`, `source_root`) on `memory_artifacts` and graph rows; `document_chunk` memories linked via `document_memories`; entries in `memory_jobs`. Tables created lazily on first write.

## API changes

Additive: `honeycomb sources add/health/remove`, `GET /api/sources/:sourceId/health`, `DELETE /api/sources/:sourceId`, and `POST /api/documents`.

## Open questions

- [ ] Should rename detection move beyond conservative delete-plus-add to true rename tracking?
- [ ] What is the default `maxItemsPerRepo` and the Markdown path-glob set for GitHub doc ingestion?
- [ ] How should desktop-cache Discord handle a cache that is evicted while a backfill is in flight?

## Related

- [Source Lifecycle](../../../knowledge/private/sources/source-lifecycle.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
