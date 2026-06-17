# PRD-013b: Document Worker

> **Parent:** [PRD-013](./prd-013-sources-and-documents-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The lighter document path for ad-hoc text, URLs, and files: enqueue via `POST /api/documents`, then run the chunk/embed/index lifecycle in `memory_jobs`, with content-hash dedup and non-fatal embedding failures. This path is separate from full source mounts; the daemon runs the worker and is the only DeepLake client.

## Goals

- Let an agent drop a URL, file, or raw text into memory and have it chunked, embedded, and made recallable without a full source mount.
- Deduplicate identical inputs so re-submitting the same URL does not re-ingest.
- Keep embedding failures non-fatal so content stays keyword-searchable even when the embedder is unavailable.

## Non-Goals

- Full provider mounts with native graph topology (covered by PRD-013a and the providers).
- Retrieval ranking beyond making chunks recallable.
- Editing or modifying the original document content.

## User stories

- As an agent, I want to drop a URL or file into memory so that it is chunked, embedded, and made recallable without a full source mount.
- As a user, I want re-submitting the same URL to return the existing record so that I do not create duplicates.
- As an operator, I want a deleted document to remove its chunks and leave history so that purges are auditable.

## Functional requirements

- FR-1: `POST /api/documents` MUST enqueue a document and return its id and status; an identical URL MUST be deduplicated and return the existing record rather than re-ingesting.
- FR-2: The worker MUST run the lifecycle `queued -> extracting -> chunking -> embedding -> indexing -> done`, tracked as a row in the `memory_jobs` table.
- FR-3: Chunking MUST be character-based with a default of roughly 2000 characters and 200 characters of overlap, configurable under `pipeline.*` in `agent.yaml`.
- FR-4: Each chunk MUST become a `document_chunk` memory linked through the `document_memories` table.
- FR-5: Identical chunks MUST share a single embedding keyed by content hash so duplicate content is embedded once.
- FR-6: An embedding failure MUST be non-fatal: the chunk MUST still be written and remain keyword-searchable, and the job MUST NOT fail because of it.
- FR-7: Deleting a document MUST soft-delete the document and all of its linked chunk memories and MUST write history entries.
- FR-8: All writes MUST go through the daemon to DeepLake; the worker hands canonical content to the daemon and never opens its own store connection.
- FR-9: Document rows and chunk memories MUST be scoped to org and workspace and carry document provenance.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `POST /api/documents` with a URL, when submitted, then it returns an id and status; an identical URL returns the existing record rather than re-ingesting. |
| AC-2 | Given a chunk whose embedding fails, when the worker continues, then the chunk is still written and stays keyword-searchable rather than failing the job. |
| AC-3 | Given a document, when it is processed, then its `memory_jobs` row advances through queued, extracting, chunking, embedding, indexing, done. |
| AC-4 | Given two documents containing an identical chunk, when both are embedded, then the chunk shares one embedding keyed by content hash. |
| AC-5 | Given a document delete, when it runs, then the document and all linked chunk memories are soft-deleted and history entries are written. |
| AC-6 | Given a chunk size override under `pipeline.*`, when chunking runs, then the configured size and overlap are applied. |

## Implementation notes

- Lifecycle: queued -> extracting -> chunking -> embedding -> indexing -> done; chunks are character-based (~2000 chars, 200 overlap) and identical chunks share an embedding by content hash.
- Deleting a document soft-deletes it and all linked chunk memories with history entries. Knobs live under `pipeline.*` in `agent.yaml`.
- Soft-delete uses the append-only status-advance path consistent with the source contract.

## Dependencies

- The `memory_jobs`, `document_memories`, and `document_chunk` tables (see Schema).
- The embedder used for chunk vectors; degraded mode when it is unavailable.
- DeepLake daemon as the sole store client.

## Open questions

- [ ] Confirm the dedup key for non-URL inputs (raw text and files) given URL dedup is explicit.

## Related

- [parent index](./prd-013-sources-and-documents-index.md)
- [Source Lifecycle](../../../knowledge/private/sources/source-lifecycle.md)
- [Schema](../../../knowledge/private/data/schema.md)
