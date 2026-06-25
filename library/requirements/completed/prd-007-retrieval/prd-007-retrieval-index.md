# PRD-007: Retrieval

> **Status:** Completed — reconciled to shipped behavior (the five-phase engine was DE-SCOPED, see [PRD-045b](../prd-045-daemon-wiring-closeout/prd-045b-daemon-wiring-closeout-retrieval-engine.md))
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None

---

> **✅ Reconciled (2026-06-22 daemon-wiring close-out, PRD-045b).** What SHIPS and is LIVE is `recallMemories` —
> hybrid lexical (BM25/ILIKE UNION-ALL over `memories`/`memory`/`sessions`) + semantic (`<#>` cosine) recall, fused
> with reciprocal-rank fusion and an honest `degraded` flag (`memories/recall.ts:565`, reached from
> `POST /api/memories/recall`, `memories/api.ts:296`). The originally-specified five-phase `RecallEngine`
> (authorization-boundary re-query / currentness downweighting / confidence gate) had **zero production callers** and
> was **DE-SCOPED and removed** — its currentness was redundant with the append-only highest-version + soft-delete
> model and PRD-008 supersession-on-read, and its confidence gate had no consumer (every surface wants raw ranked
> recall). The acceptance criteria below are rewritten to the shipped behavior; no claim overstates runtime reality.
> Decision + evidence: [PRD-045b](../prd-045-daemon-wiring-closeout/prd-045b-daemon-wiring-closeout-retrieval-engine.md).
> Full audit: [`2026-06-22-daemon-wiring-liveness-audit.md`](../prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).

---

## Overview

> **What actually ships (PRD-045b reconciliation).** The live recall engine is `recallMemories`: hybrid lexical
> (BM25/ILIKE UNION-ALL over `memories`/`memory`/`sessions`) + semantic (`<#>` cosine) recall fused with RRF, scoped
> by the storage-partition `QueryScope`, with an honest `degraded` flag. The five-phase orchestrator described in the
> design narrative below (authorization-boundary re-query → currentness shaping → confidence gate) was built and
> tested but never wired, and was **de-scoped/removed** in PRD-045b (currentness redundant with the highest-version +
> soft-delete read models; gate had no consumer). The paragraph below is retained as the original design record.

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

> **Reconciliation note (PRD-045b, 2026-06-22).** AC-2/3/4 originally specified the five-phase `RecallEngine`
> (authorization-boundary re-query / currentness / confidence gate). That engine was de-scoped (zero production
> callers; currentness redundant; gate had no consumer). The criteria below describe the behavior that actually
> SHIPS on the live recall path (`recallMemories` → `POST /api/memories/recall`). The original AC text is retained
> beneath each row as the *historical/de-scoped* intent.

| ID | Criterion (shipped) |
|---|---|
| AC-1 | Given a query, when recall runs, hybrid candidate collection executes the lexical arms (BM25/ILIKE over `memories`/`memory`/`sessions`, each a guarded per-arm query that fails soft) and — when an embed client is available and the query embeds to a 768-dim vector — the semantic `<#>` cosine arm over `content_embedding`/`message_embedding`; the arms are fused by reciprocal-rank fusion and deduped by `source+id` (`memories/recall.ts:565`). *(007a candidate collection also remains live behind the VFS browse seam, `recall/collection.ts` via `vfs/api.ts`.)* |
| AC-2 | Given a recall request, tenancy is enforced by the storage-partition `QueryScope` (org/workspace) carried on every `storage.query` call: a request reads only within its resolved tenant, resolved fail-closed from `x-honeycomb-*` headers before the engine runs (`memories/api.ts:296-318`). The canonical inner-ring read-policy chokepoint `buildScopeClause` (`recall/scope-clause.ts`) is retained and proven by the PRD-011a/011e suites + the live `recall-authz-live.itest.ts`. *(De-scoped: the five-phase authorization re-query that pruned a wide candidate pool before content load — there is no separate candidate-pool/content-load split on the live path.)* |
| AC-3 | Given a superseded or forgotten memory, the current value outranks/replaces the stale one via the append-only highest-version + soft-delete model (`is_deleted = 0` on the recall arms, highest-version reads in `memories/reads.ts`) and PRD-008 supersession-on-read of `entity_attributes` (`ontology/supersede.ts`, `buildHighestActiveVersionSql`). *(De-scoped: a dedicated shaping "currentness" downweight phase — redundant with the read models above, and it operated on `entity_attributes`, a table the live recall arms do not even search.)* |
| AC-4 | Given a query, recall returns the RRF-ranked hits ordered by fused score with an honest `degraded` flag (true when the semantic arm did not run); raw ranked recall is the contract every consumer (MCP `memory_search`/`hivemind_search`, SDK `recall()`, dashboard, CLI) reads (`{ hits, sources, degraded }`). *(De-scoped: a confidence/injection gate returning `{ injected, hits[] }` with an empty-injection answer — no consumer wanted an inject/empty decision; raw ranked recall is preferred.)* |

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
