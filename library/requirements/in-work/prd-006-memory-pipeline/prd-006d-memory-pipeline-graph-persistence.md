# PRD-006d: Graph Persistence

> **Parent:** [PRD-006](./prd-006-memory-pipeline-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the separate, non-fatal graph write that runs after the memory commit: upsert entities by canonical name, relationships by triple, and mention links insert-or-ignore, gated by graph flags. Graph persistence is intentionally decoupled from the memory write so a graph failure never reverts facts already committed. The facts matter more than the graph edges. This is the background bulk path that turns extracted entity triples into knowledge-graph structure; deliberate structural change goes through the ontology control plane (PRD-008). Writes are idempotent so reprocessing is safe, and every write threads org, workspace, and agent scope. Only the daemon touches the DeepLake store.

## Goals

- Run graph persistence as a separate write after the memory commit, never inside the memory transaction.
- Upsert entities by canonical name and relationships by the (source, target, type) triple.
- Insert-or-ignore mention links so reprocessing is idempotent.
- Make graph failures non-fatal: log a warning and leave written facts intact.
- Gate the whole stage behind `graph.enabled` and `graph.extractionWritesEnabled`.

## Non-Goals

- Extraction (PRD-006a), decision (PRD-006b), or the memory write (PRD-006c).
- The ontology control plane and deliberate structural edits (PRD-008); this is the background bulk path only.
- Graph reads, traversal, and recall boosting (retrieval, PRD-007).

## User stories

- As the pipeline, I want graph writes to be idempotent and non-fatal so that reprocessing is safe and a graph failure never costs me a fact.
- As a maintainer, I want graph writes behind a flag so that I can disable structural writes without disabling extraction.
- As retrieval, I want consistent entities and relationships so that graph-boosted recall has reliable structure to traverse.

## Functional requirements

- **FR-1** Graph persistence SHALL run as a write separate from and after the memory commit, never within the same transaction or write.
- **FR-2** Entities SHALL upsert by canonical name so the same entity is not duplicated across memories.
- **FR-3** Relationships SHALL upsert by the (source, target, type) triple.
- **FR-4** Mention links SHALL insert-or-ignore on their idempotency key so reprocessing the same memory is a no-op.
- **FR-5** The stage SHALL run only when `graph.enabled` and `graph.extractionWritesEnabled` (default on) are set.
- **FR-6** A failure in graph persistence SHALL log a warning and SHALL NOT revert or roll back facts already written by controlled writes.
- **FR-7** Every entity, relationship, and mention row SHALL thread `org`, `workspace`, and `agent_id`.
- **FR-8** All value interpolation SHALL route through the SQL escaping helpers, since the store has no parameterized queries.
- **FR-9** The stage SHALL write into the ontology defined by the knowledge-graph ontology (entities, entity_dependencies, memory_entity_mentions).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a committed memory, when graph persistence runs, then entities upsert by canonical name, relationships upsert by (source, target, type), and mention links insert-or-ignore. |
| AC-2 | Given the same memory is reprocessed, when graph persistence runs again, then no duplicate entities, relationships, or mention links are created. |
| AC-3 | Given graph persistence fails, when the pipeline continues, then a warning is logged and the facts already written are not reverted. |
| AC-4 | Given `graph.enabled` or `graph.extractionWritesEnabled` is off, when the pipeline runs, then no graph rows are written. |
| AC-5 | Given any graph write, when it commits, then the row carries org, workspace, and agent scope. |

## Implementation notes

- Gated by `graph.enabled` and `graph.extractionWritesEnabled` (default on). Every write threads org, workspace, and agent scope so graph structure stays inside the right tenancy.
- This is the background bulk path; deliberate structural change goes through the ontology control plane (PRD-008). Keeping the bulk path separate means the control plane can reason about structure without racing background writes.
- The non-fatal contract is deliberate: a failure here logs a warning and does not revert the facts already written, because the facts matter more than the graph edges. The mention-link idempotency key needs confirmation (see open questions).

## Dependencies

- PRD-006c (the committed memory this stage links from).
- The knowledge-graph ontology tables (`entities`, `entity_dependencies`, `memory_entity_mentions`) from PRD-003b.
- The graph flags (`graph.enabled`, `graph.extractionWritesEnabled`) in `agent.yaml`.

## Open questions

- [ ] What is the exact mention-link idempotency key (memory ID + entity canonical name, or a composite)?
- [ ] How are relationship-type collisions on the same (source, target) pair resolved on upsert?

## Related

- [parent index](./prd-006-memory-pipeline-index.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
