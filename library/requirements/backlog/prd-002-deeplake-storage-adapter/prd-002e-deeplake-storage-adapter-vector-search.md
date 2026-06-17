# PRD-002e: Vector Columns and GPU Search

> **Parent:** [PRD-002](./prd-002-deeplake-storage-adapter-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Provide the 768-dimension tensor column primitive and the GPU-backed vector-search interface, so semantic recall and the structured filters that scope it run in one query against the same tables that hold structured memory. In scope: declaring nullable `FLOAT4[]` tensor columns, the GPU vector-search call returning scored IDs, the over-fetch behavior for scoped recalls, and the lexical degrade path when embeddings are null. Out of scope: producing the embeddings (the embed daemon), the authorization filter and content load (retrieval, PRD-007), and the table catalog (PRD-003).

## Goals

- Embeddings are stored as nullable 768-dimension `FLOAT4[]` tensor columns on the same tables that hold structured memory, so semantic and lexical recall run against one store.
- Vector search runs on the GPU-backed engine against the tensor column and returns scored memory IDs, with the structured scoping filters applied in the same query.
- When a row's embedding column is null, recall degrades to lexical search rather than failing.
- Scoped recalls over-fetch so the downstream authorization filter still has candidates after it removes out-of-scope rows.
- The interface returns IDs and scores only; content loads happen after authorization in retrieval (PRD-007).

## Non-Goals

- Generating embeddings (the embed daemon and `nomic-embed-text-v1.5` model wiring).
- The authorization filter and content hydration in retrieval (PRD-007).
- The table catalog and which tables carry embedding columns (PRD-003).
- Re-ranking or fusion scoring beyond returning normalized scores.

## User stories

- As the retrieval layer, I want GPU vector search over the same tables as structured data so that semantic and lexical recall run against one store.
- As the retrieval layer, I want scoped recalls to over-fetch so that the authorization filter still has candidates after it drops out-of-scope rows.
- As the daemon, I want search to degrade to lexical when an embedding is null so that recall never hard-fails on a missing vector.

## Functional requirements

- FR-1: Embedding columns are declared as nullable DeepLake `FLOAT4[]` tensor columns of dimension 768 (for example `sessions.message_embedding`, `memory.summary_embedding`), nullable by design so recall degrades when embedding is disabled or fails.
- FR-2: Given a 768-dim `nomic-embed-text-v1.5` query vector, vector search executes on the GPU-backed engine against the tensor column and returns scored memory IDs.
- FR-3: The structured scoping filters (org, workspace, `agent_id`, visibility) are applied in the same query as the vector search, so semantic recall and its scope happen in one round trip.
- FR-4: When a row's embedding column is null, search for that row degrades to lexical search rather than failing the query.
- FR-5: For scoped recalls, vector search over-fetches by a configured multiplier so the downstream authorization filter (PRD-007) still has candidates after removing out-of-scope rows.
- FR-6: The interface returns IDs and normalized scores only; it does not load row content, which happens after authorization in retrieval.
- FR-7: Search result limits are read from tuning knobs (`HONEYCOMB_SEMANTIC_LIMIT`, `HONEYCOMB_HYBRID_LEXICAL_LIMIT`) and clamped to non-negative ranges at the boundary.
- FR-8: A dimension mismatch (a query vector not 768-dim) is rejected with a structured error rather than executed.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a 768-dim `nomic-embed-text-v1.5` query vector, when vector search runs, then it executes on the GPU-backed engine against the nullable tensor column and returns scored memory IDs. |
| AC-2 | Given a row whose embedding column is null, when search runs, then recall degrades to lexical search rather than failing. |
| AC-3 | Given a scoped recall, when vector search runs, then it over-fetches by the configured multiplier so the authorization filter still has candidates. |
| AC-4 | Given a search result, when it returns, then it carries IDs and normalized scores only and no row content. |
| AC-5 | Given org/workspace/agent scope, when vector search runs, then the scoping filter is applied in the same query as the vector match. |
| AC-6 | Given a query vector that is not 768-dim, when search runs, then it is rejected with a structured error. |
| AC-7 | Given `HONEYCOMB_SEMANTIC_LIMIT`, when set out of range, then it is clamped to a non-negative value before search runs. |

## Implementation notes

- Storing embeddings as tensor columns on the same tables as structured memory is the whole point of DeepLake: vector search and the structured filters that scope it run in one query, instead of a database plus a bolted-on vector index. Keep the search call colocated with the scoping `WHERE` so this property holds.
- Embeddings are nullable by design so recall degrades to lexical search when embedding is disabled or fails; never treat a null embedding as an error.
- Over-fetch for scoped recalls because the authorization filter runs after the vector match and will drop out-of-scope rows; the multiplier ensures the post-filter result set is not starved. The exact multiplier and the score-normalization range are still to be defined.
- This interface returns IDs only; content hydration happens after authorization in retrieval (PRD-007), which keeps the storage layer free of policy decisions per the module boundary.

## Dependencies

- PRD-002a (client) executes the GPU vector query.
- PRD-002b (escaping) for any interpolated filter values.
- PRD-002c (healing) creates the nullable tensor columns lazily.
- PRD-003 declares which tables carry embedding columns.
- The embed daemon produces the `nomic-embed-text-v1.5` vectors; retrieval (PRD-007) consumes the scored IDs.

## Open questions

- [ ] What is the over-fetch multiplier for scoped vector recalls before the authorization filter is applied?
- [ ] What is the score-normalization range the interface returns (raw distance, cosine similarity, 0..1)?
- [ ] How is the hybrid combination of vector and lexical scores fused, here or in retrieval (PRD-007)?

## Related

- [parent index](./prd-002-deeplake-storage-adapter-index.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
