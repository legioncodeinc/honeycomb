# PRD-006: Memory Pipeline

> **Status:** Backlog
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** Additive

---

## Overview

The pipeline turns raw captured memory into structured, deduplicated, graph-linked recall, and it does all of it asynchronously off the write path, because the one rule that cannot bend is that a slow or failing model must never cost the user a memory. The raw content is committed first; everything else is enrichment. This module builds the durable stages that run as `memory_jobs` on the daemon: LLM extraction of facts and entity triples, a per-fact add/update/delete/none decision, the controlled writes that are the only stage to mutate `memories` (dedup, confidence gate, shadow and frozen modes), separate non-fatal graph persistence, and the retention sweep that decays and batch-purges. Only the daemon touches DeepLake; shims are thin clients.

## Goals

- Run extraction, decision, controlled writes, graph persistence, and retention as durable, resumable jobs that survive daemon restarts.
- Commit raw content first and never lose a memory to a slow or failing model.
- Gate writes by confidence, dedup by content hash, and honor shadow and frozen modes.
- Keep graph persistence separate and non-fatal so a graph failure never reverts written facts.
- Run retention as batched, idempotent sweeps rather than cascading deletes.

## Non-Goals

- Capture intake itself (PRD-005); this module starts where capture ends.
- Retrieval and ranking (PRD-007).
- The ontology control plane (PRD-008); this module writes graph rows via the background path only.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-006a-memory-pipeline-extraction`](./prd-006a-memory-pipeline-extraction.md) | LLM extraction of facts and entity triples. | Draft |
| [`prd-006b-memory-pipeline-decision`](./prd-006b-memory-pipeline-decision.md) | Per-fact add/update/delete/none decision. | Draft |
| [`prd-006c-memory-pipeline-controlled-writes`](./prd-006c-memory-pipeline-controlled-writes.md) | Dedup, confidence gate, shadow/frozen modes. | Draft |
| [`prd-006d-memory-pipeline-graph-persistence`](./prd-006d-memory-pipeline-graph-persistence.md) | Entity/relation persistence (separate, non-fatal). | Draft |
| [`prd-006e-memory-pipeline-retention`](./prd-006e-memory-pipeline-retention.md) | Decay and batched purge sweep. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a raw memory, when extraction runs, then it produces bounded facts (with confidence) and entity triples, dropping invalid fields as warnings rather than failing the job. |
| AC-2 | Given an extracted fact, when the decision stage runs, then it records an add/update/delete/none proposal to `memory_history` with target ID, confidence, and reason. |
| AC-3 | Given an ADD proposal, when controlled writes run, then it is written only if fact confidence clears the threshold, content is non-empty, and the content hash is not already present. |
| AC-4 | Given `shadowMode` or `mutationsFrozen`, when the pipeline runs, then proposals are logged but no memory is written. |
| AC-5 | Given graph persistence fails, when the pipeline continues, then the facts already written are not reverted. |

## Data model changes

Additive: relies on `memories`, `memory_history`, `memory_jobs` (PRD-003, PRD-004) and writes graph rows defined in PRD-003b. May add prospective-hints storage.

## API changes

Additive: pipeline stats and control under `/api/pipeline/*` (scaffolded in PRD-004).

## Open questions

- [ ] What are the production defaults for `minFactConfidenceForWrite`, extraction input/output caps, and retention windows?
- [ ] Should prospective hints be in scope for v1 or deferred?
- [ ] How are UPDATE/DELETE contradiction checks tuned before `autonomous.allowUpdateDelete` is enabled?

## Related

- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
