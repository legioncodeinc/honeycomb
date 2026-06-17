# PRD-007d: Shaping

> **Parent:** [PRD-007](./prd-007-retrieval-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Build the ranking-quality phase (phase 4 of recall) over the authorized set from PRD-007c: structured evidence convolution, optional timeout-safe reranking, dampening, and currentness shaping. This is where ranking quality is earned. Every operation here runs strictly on authorized rows, so a strong signal can reorder results but cannot pull in anything outside the read policy. Currentness ties directly to the append-only supersession recorded by the ontology (PRD-008b), so the current value of a claim slot outranks the value it replaced.

## Goals

- Convolve lexical, semantic, hint, traversal, and structured signals so no single channel dominates.
- Prefer results covering more facets of the query.
- Apply an optional, timeout-safe reranker that never fails the recall.
- Dampen three pathologies: gravity, hub, and resolution.
- Downweight superseded attributes so the current claim-slot value outranks its predecessor.

## Non-Goals

- Collecting or authorizing candidates (PRD-007a, PRD-007b, PRD-007c).
- The injection decision and hydration (PRD-007e).
- Building or maintaining the supersession lineage (PRD-008b); shaping reads `status` and slot keys.

## User stories

- As recall, I want shaping that balances signals so that a graph-only hit cannot dominate direct textual evidence and a stale claim cannot beat its correction.
- As an operator, I want reranking to be timeout-safe so that a slow reranker degrades to the original order rather than failing the recall.
- As an agent, I want decision and constraint memories boosted so that hard guidance outranks incidental chatter.

## Functional requirements

- **FR-1** Structured evidence convolution MUST compare each result's lexical, semantic, hint, traversal, and structured signals so that a graph-only or vector-only hit cannot dominate direct textual evidence.
- **FR-2** Facet coverage MUST prefer results that cover more of the query's facets over results that match a single facet strongly.
- **FR-3** An optional rehearsal boost MUST reward memories accessed often and recently, applied as a bounded adjustment so it cannot override strong direct evidence.
- **FR-4** Reranking MUST be optional and timeout-safe: an embedding reranker blends the original score with cosine similarity, or an LLM reranker may be used, and on timeout the original order MUST be kept rather than failing the recall.
- **FR-5** Gravity dampening MUST penalize semantic hits that share no query terms with the query.
- **FR-6** Hub dampening MUST penalize results hung off very high-degree entities so a hub entity cannot flood the top of the list.
- **FR-7** Resolution dampening MUST boost decision and constraint memories and temporal anchors.
- **FR-8** Currentness shaping MUST downweight superseded attributes, scoped by `group_key` plus `claim_key`, so the current value of a claim slot outranks the value it replaced.
- **FR-9** All shaping MUST run strictly on the authorized set from PRD-007c, and the reranker-calibrated scores MUST be preserved (not rebuilt from rank) for the confidence gate in PRD-007e.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a result with mixed signals, when convolution runs, then no single channel dominates and facet coverage prefers broader-covering results. |
| AC-2 | Given a reranker timeout, when shaping runs, then the original order is kept rather than failing the recall. |
| AC-3 | Given a superseded claim, when currentness runs, then it is downweighted so the current claim-slot value (by `group_key` + `claim_key`) outranks the value it replaced. |
| AC-4 | Given a semantic hit sharing no query terms, when gravity dampening runs, then it is penalized. |
| AC-5 | Given a result hung off a very high-degree entity, when hub dampening runs, then it is penalized. |
| AC-6 | Given a decision or constraint memory, when resolution dampening runs, then it is boosted. |
| AC-7 | Given shaping completes, then calibrated scores are preserved for the confidence gate and no unauthorized row was introduced. |

## Implementation notes

- Convolution is the antidote to channel imbalance: a memory that only appeared via traversal carries a weak structured signal and a strong one only if multiple channels agree.
- Reranking is wrapped in a timeout so the recall path stays bounded; on timeout the pre-rerank ordering is final, never an error.
- Currentness leans entirely on PRD-008b's append-only model: because a superseded sibling keeps its row with `status` advanced, shaping can see both the current and prior values and downweight the prior one deterministically.
- Dampening factors and the rehearsal boost are tunable; the default reranker and its timeout are tracked in the parent open questions.

## Dependencies

- PRD-007c authorization (provides the authorized set shaping runs on).
- PRD-008b supersession lineage (`status`, `group_key`, `claim_key`, `superseded_by`).
- PRD-008 entity degree data (for hub dampening).
- The embedding reranker / optional LLM reranker (consumed).

## Open questions

- [ ] Which reranker is the default (embedding cosine versus LLM) and what is its timeout budget?
- [ ] What are the default gravity, hub, and resolution dampening factors?
- [ ] Is the rehearsal boost on by default, and what window defines "recently"?

## Related

- [parent index](./prd-007-retrieval-index.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
