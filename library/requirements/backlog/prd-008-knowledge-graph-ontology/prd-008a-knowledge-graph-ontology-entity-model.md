# PRD-008a: Entity Model and Inline Linker

> **Parent:** [PRD-008](./prd-008-knowledge-graph-ontology-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

Build the entity model (entities with a canonical name and type, weighted aspects, claim attributes living in `group_key`/`claim_key` slots) and the synchronous inline entity linker that runs at write time. The whole graph lives in DeepLake tables the daemon owns; nothing else writes to it. The model is derived from memories and carries provenance back to them, so it is never authoritative on its own. The inline linker is the cheapest write path into the graph: it links, never creates, calls no model, and does no network I/O, so it is safe to run right after the memory commit.

## Goals

- Model entities with a canonical name, a type from the fixed type set, and optional pinned/mounted state.
- Model aspects as weighted dimensions of an entity that rise when retrieval confirms them and decay when stale.
- Model claim attributes in `group_key`/`claim_key` slots with kind, status, confidence, importance, version lineage, and provenance.
- Run a synchronous inline entity linker that links proper nouns to existing agent entities, safely, on the write path.
- Scope all entity, aspect, and attribute rows by org, workspace, and `agent_id`.

## Non-Goals

- Dependency edges and supersession (PRD-008b).
- The ontology control plane, proposals, and assertions (PRD-008c).
- The background pipeline graph writer that bulk-upserts entities (PRD-006d).
- Model-driven graph reshaping (the dreaming loop).

## User stories

- As the system, I want a safe synchronous linker so that a newly written memory gives entity pages an immediate mention without risking the write path.
- As an agent, I want claim attributes in addressable slots so that a single fact about an entity can be updated without rewriting the entity.
- As a reviewer, I want every attribute to carry provenance so that I can trace a value back to the memory and proposal that produced it.

## Functional requirements

- **FR-1** An entity MUST carry a canonical name and a type drawn from the fixed set (person, project, system, tool, concept, skill, task, source, artifact, agent, policy, action, workflow, event, object_type, interface, observation, claim_slot, claim_value, unknown), and MAY be pinned or mounted from an external source.
- **FR-2** An aspect MUST be a weighted dimension of an entity; its weight MUST rise when retrieval keeps confirming it and decay toward a floor when it goes stale beyond a window.
- **FR-3** Inside an aspect, a `group_key` MUST be a navigable subdivision and a `claim_key` MUST identify the specific updateable slot a value lives in.
- **FR-4** An entity attribute MUST carry a `kind` of `attribute` or `constraint`, a `status` of `active`, `superseded`, or `deleted`, a confidence, an importance, a version lineage, and provenance back to the memory id, source, and proposal id that produced it.
- **FR-5** The inline entity linker MUST run synchronously at write time, scanning new memory content for proper nouns and linking to entities that already exist for the agent.
- **FR-6** The inline entity linker MUST create no entities, call no model, and do no network I/O, so it is safe to run right after the memory commit.
- **FR-7** Every entity, aspect, and attribute row MUST be scoped by org, workspace, and `agent_id`, and the linker MUST never link across the agent boundary.
- **FR-8** All names, keys, and content values interpolated into a statement MUST be escaped through the `sqlStr`/`sqlLike`/`sqlIdent` helpers, because the DeepLake query endpoint has no parameterized queries.
- **FR-9** All entity-model writes MUST go through the daemon on port 3850, the only DeepLake client; no other process writes the graph.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given new memory content, when the inline linker runs, then it scans for proper nouns and links to entities that already exist for the agent, creating nothing and calling no model. |
| AC-2 | Given the linker runs, when it executes, then it performs no network I/O and is safe to run right after the memory commit. |
| AC-3 | Given an entity attribute, when stored, then it carries `kind`, `status`, confidence, importance, version lineage, and provenance back to the memory and proposal. |
| AC-4 | Given an aspect, when retrieval confirms it, then its weight rises, and when it goes stale, its weight decays toward a floor. |
| AC-5 | Given a claim value, when stored, then it lives in an addressable `group_key`/`claim_key` slot under its aspect. |
| AC-6 | Given any write, when it executes, then it is scoped by org, workspace, and `agent_id` and never links across the agent boundary. |
| AC-7 | Given any interpolated name, key, or value, when a statement is built, then it is escaped through the SQL helpers. |

## Implementation notes

- The linker is the immediate-mention path: it gives an entity page a fresh mention the instant a memory commits, while the heavier upsert-by-canonical-name path runs later in the background (PRD-006d).
- Proper-noun detection must stay model-free to keep the write path fast and offline-safe; the detection approach is tracked below.
- Aspect weighting is driven by the feedback loop: confirmation raises weight, staleness decays it, so the graph shape tracks how memory is actually used.
- Provenance is not optional: an attribute with no traceable memory id is not a valid graph row, because the graph is an index over evidence, not a source of truth.

## Dependencies

- PRD-003b ontology tables (entities, aspects, attributes) and the SQL escaping helpers.
- PRD-006 memory pipeline (the linker runs right after the memory commit).
- The daemon (port 3850) as the only DeepLake writer.

## Open questions

- [ ] What proper-noun detection approach does the inline linker use (rules, dictionary, gazetteer)?
- [ ] What window and floor govern aspect weight decay?
- [ ] How are pinned and mounted entities represented on the entity row?

## Related

- [parent index](./prd-008-knowledge-graph-ontology-index.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
- [Schema](../../../knowledge/private/data/schema.md)
