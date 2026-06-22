# PRD-003: Core Data Model

> **Status:** Completed
> **Priority:** P0
> **Effort:** L
> **Schema changes:** Additive

---

## Overview

This module defines the canonical DeepLake table catalog for Honeycomb, built on the storage adapter primitives from PRD-002. It covers the distilled-memory engine tables (`memories`, embeddings, `memory_history`), the knowledge graph (entities, aspects, attributes, dependencies, mentions, assertions, ontology proposals), the capture and summary tables (`sessions` raw capture, session transcripts, `memory` for the VFS and wiki summaries), the product tables carried from hivemind (skills, rules, goals, kpis, codebase), and the tenancy and operations tables (agents roster, api_keys, telemetry). Every table is expressed as a `{ name, sql }` column-definition array so the lazy heal pass can converge it, and each carries the scope columns its access policy needs.

## Goals

- Define every durable table as a column-definition array that the create and heal paths share.
- Keep the three "memory" tables unambiguous: `sessions` (raw events), `memories` (distilled facts), `memory` (VFS and wiki summaries).
- Carry `agent_id` (default `'default'`) and `visibility` on engine tables, and explicit `org_id`/`workspace_id` on cross-cutting tables like `codebase`.
- Store embeddings as 768-dim nullable `FLOAT4[]` tensor columns and structured payloads as `JSONB`.

## Non-Goals

- The storage adapter primitives themselves (PRD-002).
- The pipeline, retrieval, and ontology logic that read and write these tables (PRD-006, PRD-007, PRD-008).
- Retention sweep implementation (PRD-006e); this module only declares retention-relevant columns.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-003a-core-data-model-memories`](./prd-003a-core-data-model-memories.md) | `memories`, embeddings, `memory_history` tables. | Draft |
| [`prd-003b-core-data-model-knowledge-graph`](./prd-003b-core-data-model-knowledge-graph.md) | entities/aspects/attributes/dependencies/mentions/assertions/ontology_proposals tables. | Draft |
| [`prd-003c-core-data-model-sessions-summaries`](./prd-003c-core-data-model-sessions-summaries.md) | `sessions` raw capture, session transcripts, `memory` (VFS/summaries) tables. | Draft |
| [`prd-003d-core-data-model-product-tables`](./prd-003d-core-data-model-product-tables.md) | skills/rules/goals/kpis/codebase tables. | Draft |
| [`prd-003e-core-data-model-agents-auth-telemetry`](./prd-003e-core-data-model-agents-auth-telemetry.md) | agents roster, api_keys, telemetry tables. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the catalog, when any table is first written, then it is created from its column-definition array and the heal pass converges it to that definition. |
| AC-2 | Given the three memory tables, when their roles are inspected, then `sessions` holds raw events, `memories` holds distilled facts, and `memory` holds VFS and wiki summaries, with no overlap. |
| AC-3 | Given an engine table, when a row is written, then it carries `agent_id` and `visibility`; given `codebase`, then the row carries explicit `org_id` and `workspace_id`. |
| AC-4 | Given any embedding column, when defined, then it is a nullable 768-dim `FLOAT4[]` tensor column. |

## Data model changes

Additive: introduces the full table catalog (capture, summaries, engine, knowledge graph, product, tenancy, telemetry) as DeepLake `USING deeplake` tables.

## API changes

None directly; these tables back the routes defined in PRD-004 and consumed by later modules.

## Open questions

- [ ] Should `session_transcripts` be a distinct table or a path convention within `memory`?
- [ ] Which tables need explicit tenancy columns versus relying on storage-layer partitioning alone?
- [ ] What is the retention column convention (soft-delete flag versus status string) standardized across tables?

## Related

- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Memory Virtual Filesystem](../../../knowledge/private/data/memory-virtual-filesystem.md)
