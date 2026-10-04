# PRD-006c: Controlled Writes

> **Parent:** [PRD-006](./prd-006-memory-pipeline-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Build the only stage that mutates `memories`: prefetch embeddings, gate ADD proposals by confidence and dedup, run contradiction checks on UPDATE/DELETE, and honor shadow and frozen modes. This is the single chokepoint where pipeline intent becomes durable state in the DeepLake GPU-backed store. Because DeepLake's query endpoint coalesces UPDATEs in a way that can silently drop concurrent edits, this stage avoids naive UPDATE on hot tables: it dedups with a SELECT-before-INSERT on the content hash and lands UPDATE/DELETE as append-only version-bumped writes. Only the daemon performs these writes, and every value interpolated into a query routes through the SQL escaping helpers.

## Goals

- Make controlled writes the only stage that mutates `memories`.
- Prefetch embeddings before the write so no network call happens while committing.
- Gate ADD proposals by confidence, non-empty normalized content, and content-hash dedup.
- Run contradiction checks on UPDATE/DELETE, flag them for review, and apply only under the autonomous flag, as append-only version-bumped writes.
- Honor `shadowMode` and `mutationsFrozen`, with `mutationsFrozen` superseding shadow mode.

## Non-Goals

- Producing proposals (PRD-006b) or extracting facts (PRD-006a).
- Graph persistence (PRD-006d), which is a separate non-fatal write after the memory commit.
- Retention and decay (PRD-006e).

## User stories

- As an operator, I want writes gated and reversible-by-mode so that I can run the pipeline in shadow before trusting it to mutate memory.
- As a maintainer, I want an emergency read-only brake so that I can freeze all mutations during an incident without disabling extraction.
- As the system, I want dedup by content hash so that reprocessing never inserts a duplicate memory.

## Functional requirements

- **FR-1** Controlled writes SHALL be the only stage that mutates the `memories` table.
- **FR-2** Embeddings SHALL be prefetched before the write so no network call happens while the daemon is committing.
- **FR-3** For each ADD proposal the stage SHALL apply the write only if fact confidence clears `minFactConfidenceForWrite` (default 0.7).
- **FR-4** The stage SHALL apply an ADD only if the normalized content is non-empty.
- **FR-5** The stage SHALL perform a SHA-256 content-hash dedup via SELECT-before-INSERT; on a hash hit it SHALL return the existing memory ID instead of inserting a duplicate.
- **FR-6** UPDATE and DELETE proposals SHALL run a contradiction check (negation and antonym tokens plus lexical overlap) and SHALL be flagged for review.
- **FR-7** UPDATE/DELETE SHALL apply only when `autonomous.allowUpdateDelete` is set, and SHALL land as append-only version-bumped writes rather than in-place mutations.
- **FR-8** Under `shadowMode` the stage SHALL write nothing; proposals SHALL be logged to history only.
- **FR-9** Under `mutationsFrozen` the stage SHALL write nothing, and `mutationsFrozen` SHALL supersede `shadowMode`.
- **FR-10** All values interpolated into a DeepLake query SHALL route through the `sqlStr`/`sqlLike`/`sqlIdent` escaping helpers, since the endpoint has no parameterized queries.
- **FR-11** Every write SHALL thread `org`, `workspace`, and `agent_id` so the memory stays within tenancy and scope.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an ADD proposal, when controlled writes run, then it is written only if fact confidence clears `minFactConfidenceForWrite` (default 0.7), normalized content is non-empty, and the SHA-256 content hash is not already present. |
| AC-2 | Given an ADD whose content hash already exists, when the stage runs, then the existing memory ID is returned and no duplicate is inserted. |
| AC-3 | Given an UPDATE or DELETE, when the stage runs, then a contradiction check runs, the proposal is flagged for review, and it applies only when `autonomous.allowUpdateDelete` is set, as an append-only version-bumped write. |
| AC-4 | Given `shadowMode`, when the stage runs, then no memory is written and proposals are logged only. |
| AC-5 | Given `mutationsFrozen`, when the stage runs, then no memory is written even if shadow mode is off; frozen supersedes shadow. |
| AC-6 | Given any write, when it commits, then embeddings were prefetched beforehand and no network call occurred during the commit. |

## Implementation notes

- Embeddings are prefetched before the write so no network call happens while committing; this keeps the commit window tight and avoids holding state open across a remote call.
- DeepLake's query endpoint coalesces UPDATEs and can silently drop concurrent edits, so the daemon does not lean on naive UPDATE for hot tables. Dedup is a SELECT-before-INSERT against the content hash, and UPDATE/DELETE land as append-only version-bumped writes rather than in-place mutations.
- The contradiction check (negation, antonym, lexical overlap) is a guardrail before any destructive change; combined with the `autonomous.allowUpdateDelete` gate and the review flag, it keeps the pipeline from silently deleting or rewriting memory until explicitly trusted.

## Dependencies

- PRD-006b (the proposals this stage applies).
- The embed daemon (prefetch) and the `memories`/`memory_history` tables (PRD-003/PRD-004).
- DeepLake storage semantics and the SQL escaping helpers (deeplake-storage).

## Open questions

- [ ] What is the production default for `minFactConfidenceForWrite` beyond the 0.7 baseline, per workload?
- [ ] How are the UPDATE/DELETE contradiction checks tuned before `autonomous.allowUpdateDelete` is enabled?

## Related

- [parent index](./prd-006-memory-pipeline-index.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
