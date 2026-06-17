# PRD-007a: Candidate Collection

> **Parent:** [PRD-007](./prd-007-retrieval-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Build the candidate channels that produce memory IDs only: BM25-style full-text search, the GPU-backed vector channel over 768-dim columns, and the prospective-hints channel, merged by ID. This is phase 1 (prepare) and the lexical, vector, and hint parts of phase 2 (collect) of the recall flow. No content is loaded in this phase; every channel emits memory IDs with a calibrated score and nothing else. The daemon on port 3850 is the only DeepLake client, so all channels run inside the daemon over the org/workspace partition and never reach the store directly.

## Goals

- Normalize the raw query into a safe full-text expression and preserve the original natural-language string for the vector path.
- Run BM25-style FTS scored to a 0-to-1 range against the indexed content.
- Run a GPU-backed vector channel over the 768-dim `nomic-embed-text-v1.5` columns, over-fetching for scoped recalls.
- Match the prospective-hints channel against write-time hints with a cap so a memory cannot ride in on hints alone.
- Merge all channels by memory ID, strongest calibrated score winning unless blended.

## Non-Goals

- The authorization boundary (PRD-007c); this phase emits unauthorized IDs by design.
- Structured routes and graph traversal (PRD-007b).
- Hosting the embedding model; the nomic embed daemon is consumed, not built.
- Writing the hints, vectors, or FTS index that this phase reads (PRD-006).

## User stories

- As recall, I want multiple ID-only channels so that lexical, semantic, and prospective signals all feed one candidate pool cheaply.
- As an operator, I want recall to keep working when the embedder is down so that an embedding outage degrades to lexical search rather than failing recall.
- As a security reviewer, I want the collection phase to move IDs only so that a wide-net channel cannot leak content before authorization.

## Functional requirements

- **FR-1** Query preparation MUST normalize the raw query into a safe full-text expression, escaped through the DeepLake SQL helpers (`sqlStr`/`sqlLike`/`sqlIdent`) because the query endpoint takes no bound parameters.
- **FR-2** Query preparation MUST preserve the original natural-language string unmodified for the vector and model paths, and MAY apply optional keyword expansion to widen class-to-instance gaps for the lexical path only.
- **FR-3** The FTS channel MUST score matches BM25-style normalized to a 0-to-1 range and MUST return memory IDs with scores, no content.
- **FR-4** The vector channel MUST embed the query via the nomic embed daemon and run a GPU-backed similarity search over the 768-dim `nomic-embed-text-v1.5` tensor columns, returning IDs with scores.
- **FR-5** The vector channel MUST over-fetch candidates for scoped recalls so that the authorization phase has enough survivors after the scope clause prunes the set.
- **FR-6** When the embed daemon is off or fails, the vector channel MUST be skipped and recall MUST degrade to lexical (FTS plus hints) without erroring; embedding is optional and non-blocking.
- **FR-7** The hints channel MUST match the query against prospective hints generated at write time, capped so that a memory matched only by hints cannot dominate the pool.
- **FR-8** All channels MUST merge by memory ID, with the strongest calibrated score winning unless an explicit blend is requested, and the merged set MUST carry per-channel signal provenance for downstream shaping (PRD-007d).
- **FR-9** Every channel MUST run within the org/workspace partition; collection MUST NOT cross a workspace boundary even though the agent read-policy clause is applied later in PRD-007c.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a query, when collection runs, then FTS returns BM25-style scores normalized to 0-1 with IDs only and no content. |
| AC-2 | Given a query, when the vector channel runs, then it returns GPU similarity over the 768-dim columns and over-fetches for scoped recalls. |
| AC-3 | Given the embed daemon is off, when collection runs, then the vector channel is skipped and recall returns lexical candidates without error. |
| AC-4 | Given write-time hints, when the hints channel runs, then matches are capped so a memory cannot ride in on hints alone. |
| AC-5 | Given multiple channels, when they merge, then they merge by memory ID with the strongest calibrated score winning unless blended. |
| AC-6 | Given any raw query, when it is prepared, then it is escaped through the SQL helpers and the original natural-language string is preserved for the vector path. |
| AC-7 | Given collected candidates, when the phase ends, then per-channel signal provenance is attached and no content row has been loaded. |

## Implementation notes

- Phase 1 normalization runs once and feeds both the lexical and vector paths; keyword expansion applies to the lexical expression only so it cannot pollute the semantic query.
- Vectors live as DeepLake tensor columns searched on the GPU-backed engine, so semantic recall and the scoping filters run in one query rather than a database plus a separate vector index.
- The over-fetch multiplier and the hint cap are tunable; defaults are tracked in the parent open questions and must be confirmed before launch.
- An embedding tracker heals missing or stale vectors in the background, outside this read path; collection never blocks on it.

## Dependencies

- PRD-003 DeepLake schema (memory tables, FTS index, vector columns) and the SQL escaping helpers.
- PRD-006 memory pipeline (writes the content, hints, and vectors this phase reads).
- The nomic embed daemon (consumed, not built).
- PRD-007c authorization (consumes the merged ID set).

## Open questions

- [ ] What over-fetch multiplier do scoped vector recalls use before authorization?
- [ ] What is the hint cap, and is it per-agent tunable?
- [ ] Does keyword expansion run by default or only on demand?

## Related

- [parent index](./prd-007-retrieval-index.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
