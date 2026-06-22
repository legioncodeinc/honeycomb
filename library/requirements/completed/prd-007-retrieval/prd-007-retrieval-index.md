# PRD-007: Retrieval

> **Status:** Completed
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None

---

## Overview

Recall has to be cheap, scoped, and current: cheap so it does not run a model on every query, scoped so it never returns a memory the requesting agent may not see, and current so a superseded fact never outranks the fact that replaced it. This module builds the five-phase recall engine over DeepLake with GPU-accelerated vector search: hybrid candidate collection (FTS, GPU vector, prospective hints, structured, traversal), the authorization boundary that re-queries with full org/workspace and agent scope before any content loads, the shaping that earns ranking quality (evidence convolution, rerank, dampening, currentness), and the confidence gate that decides whether to inject context automatically. Up to authorization, only IDs move; every content-bearing stage runs strictly on authorized rows.

## Goals

- Collect candidate IDs across FTS, GPU vector, prospective hints, structured routes, and bounded graph traversal, merging by ID.
- Enforce the authorization boundary (org/workspace partition plus agent read-policy) before any content-bearing stage.
- Shape the authorized set with evidence convolution, optional timeout-safe rerank, dampening, and currentness.
- Decide injection by a calibrated score gate where an empty injection is a real answer.

## Non-Goals

- The pipeline that writes the memories and hints recall reads (PRD-006).
- The virtual-filesystem browse surface (separate read path; referenced, not built here).
- Embedding model hosting (the embed daemon is consumed).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-007a-retrieval-candidate-collection`](./prd-007a-retrieval-candidate-collection.md) | FTS, GPU vector, and prospective-hints candidate channels. | Draft |
| [`prd-007b-retrieval-graph-traversal`](./prd-007b-retrieval-graph-traversal.md) | Focal resolution and bounded walk. | Draft |
| [`prd-007c-retrieval-authorization`](./prd-007c-retrieval-authorization.md) | Org/workspace + agent_id scope clause before content loads. | Draft |
| [`prd-007d-retrieval-shaping`](./prd-007d-retrieval-shaping.md) | Evidence convolution, rerank, dampening, currentness. | Draft |
| [`prd-007e-retrieval-confidence-gate`](./prd-007e-retrieval-confidence-gate.md) | Score gate and injection decision. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a query, when candidate collection runs, then FTS, GPU vector, hints, structured, and traversal channels each return memory IDs only (no content), merged by ID with the strongest calibrated score winning. |
| AC-2 | Given collected candidate IDs, when authorization runs, then the engine re-queries with the org/workspace partition and the agent read-policy clause, and only surviving IDs proceed to content-bearing stages. |
| AC-3 | Given a superseded claim, when shaping runs, then currentness downweights it so the current value of the claim slot outranks the value it replaced. |
| AC-4 | Given the top result, when the confidence gate runs, then context is injected only if the top score clears the minimum, and an empty injection is returned as a valid answer when nothing clears it. |

## Data model changes

None: reads the tables defined in PRD-003.

## API changes

Additive: recall, search, and similarity routes under `/api/memories` and `/memory/*`, plus the `user-prompt-submit` injection hook (scaffolded in PRD-004).

## Open questions

- [ ] What is the production minimum injection score, and is it per-agent tunable?
- [ ] What over-fetch multiplier do scoped vector recalls use before authorization?
- [ ] Which reranker is the default (embedding cosine versus LLM) and what is its timeout budget?

## Related

- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
