# Knowledge Graph and Ontology

> Category: Ai | Version: 1.0 | Date: June 2026 | Status: Active

The structured layer over memories: entities, aspects, claim slots, dependencies, epistemic assertions, and the control plane that governs how the graph changes.

**Related:**
- [`memory-pipeline.md`](memory-pipeline.md)
- [`retrieval.md`](retrieval.md)
- [`pollinating-loop.md`](pollinating-loop.md)
- [`../data/schema.md`](../data/schema.md)
- [`../security/scoping-and-visibility.md`](../security/scoping-and-visibility.md)

---

## Why a graph at all

Flat memories answer "what did I say about X." A graph answers "what is true about X right now, what does X depend on, and who claimed it." Honeycomb's ontology is the navigation layer that makes entity-centric recall and currentness possible. It is derived from memories and carries provenance back to them, so it is never authoritative on its own. It is a fast index over evidence, and it can be rebuilt. The whole graph lives in DeepLake tables that the daemon owns; nothing else writes to it.

## The shape

The ontology nests from entity down to a single updateable claim.

```mermaid
flowchart TD
    entity["entity (person, project, tool, concept, ...)"] --> aspect["aspect (weighted dimension)"]
    aspect --> groupKey["group_key (navigable subdivision)"]
    groupKey --> claimKey["claim_key (updateable slot)"]
    claimKey --> attr["entity_attribute (the value)"]
    entity --> dep["entity_dependencies (outgoing edges)"]
    attr --> prov["provenance: memory_id, source, proposal_id"]
```

An **entity** has a canonical name and a type, and can be pinned or mounted from an external source. **Aspects** are weighted dimensions of an entity. `confirmAspectWeight` and `decayAspectWeight` in `src/daemon/runtime/ontology/entity-model.ts` compute a raise and a decay, and tests call them. Recall does not. Inside an aspect, a `group_key` is a navigable subdivision and a `claim_key` is the specific slot a value lives in. An **entity_attribute** is the value in that slot, with a `kind` of `attribute` or `constraint`, a `status` of `active`, `superseded`, or `deleted`, a confidence and importance, a version lineage, and provenance back to the memory and proposal that produced it.

Entity types include person, project, system, tool, concept, skill, task, source, artifact, agent, policy, action, workflow, event, object_type, interface, observation, claim_slot, claim_value, and unknown.

## Dependencies, not relations

Edges between entities live in `entity_dependencies`. Each edge has a type, a strength, a confidence, and (for loose `related_to` edges) a required reason so there is always an audit trail for soft links. A minimum strength-times-confidence gate is parsed as `minEdgeWeight` on the recall traversal config. No live recall walker applies it. The older `relations` table is legacy; new audited links use `entity_dependencies`.

## Supersession and currentness

When a new attribute lands in the same entity, aspect, group, and claim slot as an existing one, the conflicting sibling is marked superseded rather than deleted. Conflict detection uses lexical overlap plus negation and antonym signals, with an optional LLM semantic fallback. Constraints are not auto-superseded. This is what lets retrieval prefer the current value of a claim while keeping the full version history inspectable, which is the currentness shaping described in [`retrieval.md`](retrieval.md).

Supersession is also where DeepLake's storage shape matters. The query endpoint coalesces concurrent UPDATEs in a way that can drop edits, so claim attributes are never mutated in place. A supersession is an append: the new attribute is written with a fresh version, and the prior sibling's `status` and `superseded_by` are advanced through the same append-only, version-bumped path the daemon uses for every concurrent-edit table. The full history is therefore intact on disk, not reconstructed. Because the endpoint has no parameterized queries, every name, key, and content value interpolated into a statement is escaped through the `sqlStr`/`sqlLike`/`sqlIdent` helpers.

## Epistemic assertions

Some statements are not facts about the world, they are facts about who said what. The `epistemic_assertions` layer preserves attribution: a predicate (`claims`, `believes`, `observed`, `decided`, `prefers`, `denies`, `questions`), the content, the speaker, a confidence, evidence, and a status. Assertions can link to a claim attribute but stay a separate evidence and attribution layer. They do not auto-promote into ontology truth, because who believes something is different from whether it is true.

## How the graph gets written

There are three write paths into the graph, and they are deliberately different in trust.

The **inline entity linker** (`inlineLinkMemory` in `src/daemon/runtime/ontology/entity-model.ts`) scans memory content for proper nouns and links to entities that already exist. It creates nothing, calls no model, and does no network I/O. The only production call is the graph-persist stage (`src/daemon/runtime/pipeline/graph-persist.ts`), after the triples are written, and that call is skipped when there are no triples. The controlled-write commit does not call it.

The **pipeline graph writer** runs in the background after extraction, gated by `graph.extractionWritesEnabled`. It upserts entities by canonical name and edges by triple. Org and workspace ride the storage partition. The writer sets `agentId` to `scope.workspace ?? "default"`, so the row's `agent_id` is the workspace id. This is the bulk path and it is non-fatal: a graph failure never reverts the facts that were already written.

The **ontology control plane** is the audited path for deliberate structural change.

## The ontology control plane

Structured changes go through `ontology_proposals`. A proposal has an operation, a status (`pending`, `applied`, `rejected`, `failed`), a `jsonb` payload, a confidence, a rationale, evidence, a risk note, and source provenance. The operation set covers entities (create, rename, merge, archive), aspects (create, rename, archive), claim values (add, set, supersede, archive, restore version), links (create, update, archive), plus `extract` and `consolidate`.

The mutation model has two modes. Clear, bounded, explicit operations apply directly and write an applied proposal row alongside the change, with the applied evidence copied onto the resulting attribute and dependency rows for lineage. Broad refactors, risky or destructive changes, and generated batches go into a pending review queue instead. Raw source artifacts and transcripts are never rewritten when graph or memory rows change.

`runOntologyCommand` in `src/cli/ontology.ts` implements `pipeline explain`, `proposals`, `assertions`, `entity merge-plan`, and `stream apply`. Nothing in production `src/` calls it. That function refuses a live `stream apply` unless `--dry-run` is set.

The registered `honeycomb ontology` verb is the storage mapper in `src/commands/storage-handlers.ts`. It dispatches onto `/api/ontology/<sub>`. The mounted routes in `src/daemon/runtime/ontology/api.ts` are `GET /`, `GET /entities`, `GET /edges`, `GET /claims`, `GET /assertions`, and `POST /proposals`. There is no `pipeline explain`, `merge-plan`, or `stream apply` route.

## Traversal

PRD-045b de-scoped the recall traversal engine and removed `src/daemon/runtime/recall/traversal.ts`. The budgets remain config: `TraversalConfigSchema` in `src/daemon/runtime/recall/config.ts` still parses `aspectsPerEntity`, `attrsPerAspect`, `branching`, `totalIds`, `minEdgeWeight`, and `timeoutMs`. No other `src` file walks focal entities. Live recall sources are `memories`, `memory`, `sessions`, and `hive_graph_versions` (`src/daemon/runtime/memories/recall.ts`). That de-scope is the shipped retrieval shape. The candidate pool in [`retrieval.md`](retrieval.md) is those recall arms.

## Feedback and communities

`confirmAspectWeight` and `decayAspectWeight` (`entity-model.ts`) raise an aspect weight on confirmation and decay a stale aspect toward a floor. Call sites under `src/` are those definitions. Tests call them. Recall does not. There is no community, Louvain, or cluster walker under `src/daemon`. The heavier, model-driven reshaping of the graph is the pollinating job described in [`pollinating-loop.md`](pollinating-loop.md). The tables behind the graph are documented in [`../data/schema.md`](../data/schema.md).
