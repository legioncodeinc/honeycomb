# PRD-005b: Embedding Attachment

> **Parent:** [PRD-005](./prd-005-capture-intake-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S

## Scope

Attach an optional 768-dim `nomic-embed-text-v1.5` vector to the captured row's `message_embedding` column via the embed daemon client, non-blocking and fail-soft. The embed daemon is consumed here, not built. Embeddings enrich semantic recall but never gate the turn: when embeddings are disabled or fail, the column is left null and the event is still captured and still lexically searchable. The daemon owns the write to DeepLake and the vector tensor it produces feeds the GPU-backed vector search in retrieval (PRD-007).

## Goals

- Compute a 768-dim `nomic-embed-text-v1.5` vector for the captured event's text when embeddings are enabled, and write it to `message_embedding`.
- Keep attachment non-blocking so capture never waits on the embedder for turn completion.
- Fail soft: on disable or failure, leave the column null and keep the event captured and lexically searchable.
- Write vectors as DeepLake tensors consumable by the GPU vector search consumed in retrieval.

## Non-Goals

- Hosting or building the embed daemon or the embedding model (consumed, not built).
- The capture INSERT itself (PRD-005a) and the capture guards (PRD-005c).
- The retrieval-side vector search that reads these vectors (PRD-007).

## User stories

- As capture, I want embeddings attached without blocking the turn so that semantic recall is enriched but never gated on the embedder.
- As an operator, I want embedding to be a toggle so that I can run capture with vectors off and still get lexical recall.
- As retrieval, I want consistent 768-dim vectors so that the GPU vector search can rank over them.

## Functional requirements

- **FR-1** When embeddings are enabled, the daemon SHALL request a 768-dim `nomic-embed-text-v1.5` vector for the event's text from the embed daemon client.
- **FR-2** The computed vector SHALL be written to the captured row's `message_embedding` column as a DeepLake tensor.
- **FR-3** Attachment SHALL be non-blocking with respect to turn completion: capture SHALL commit the row regardless of embedding latency.
- **FR-4** When embeddings are disabled, the daemon SHALL skip the embed call and leave `message_embedding` null.
- **FR-5** When the embed daemon is unreachable or returns an error, the daemon SHALL log the failure, leave `message_embedding` null, and SHALL NOT fail the capture write.
- **FR-6** An event captured with a null `message_embedding` SHALL remain fully lexically searchable.
- **FR-7** The embed call SHALL be issued only by the daemon (the sole DeepLake client); shims never invoke the embedder directly.
- **FR-8** Vectors SHALL be exactly 768-dim; a vector of any other dimensionality SHALL be rejected and treated as a failure (column left null).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given embeddings are enabled, when an event is captured, then a 768-dim vector is computed and written to `message_embedding`. |
| AC-2 | Given the embedder is disabled, when capture runs, then the column is left null and the event is still captured and lexically searchable. |
| AC-3 | Given the embedder fails or is unreachable, when capture runs, then the failure is logged, the column is null, and the capture write still succeeds. |
| AC-4 | Given embedding attachment is in flight, when the turn completes, then turn completion does not wait on the embed call. |
| AC-5 | Given a returned vector is not 768-dim, when attachment runs, then it is rejected and the column is left null. |

## Implementation notes

- Embedding is optional and non-blocking by design; the embed daemon is consumed here, not built. The vectors feed the GPU vector search in retrieval (PRD-007).
- Vectors are 768-dim `nomic-embed-text-v1.5` and are written as DeepLake tensors, consistent with how the pipeline writes embeddings elsewhere, so retrieval can rank lexical and semantic results together.
- The choice between inline-async attachment on the capture call versus a deferred follow-up embedding job is open (see below); either way the column starts null and capture never blocks on it.

## Dependencies

- PRD-005a (the capture INSERT that produces the row this attaches to).
- The embed daemon client and the `nomic-embed-text-v1.5` model (external, consumed).
- PRD-007 (retrieval consumes the vectors written here).

## Open questions

- [ ] Should embedding attachment be inline-async on the capture call or deferred to a follow-up embedding job?
- [ ] What is the embed daemon client contract (request/response shape, timeout, retry policy)?

## Related

- [parent index](./prd-005-capture-intake-index.md)
- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
