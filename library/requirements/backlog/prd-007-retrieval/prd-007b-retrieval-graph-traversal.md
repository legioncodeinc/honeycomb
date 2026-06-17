# PRD-007b: Graph Traversal

> **Parent:** [PRD-007](./prd-007-retrieval-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Build the structured and traversal candidate path: resolve focal entities in priority order, then walk the dependency graph within a budget to collect linked memory IDs. This is the structured-route and traversal part of phase 2 (collect). Like the other channels in PRD-007a, traversal emits memory IDs with scores and paths only, never content, and runs inside the daemon over the org/workspace partition. It consumes the ontology built in PRD-008 (entities, aspects, claim slots, dependency edges) and feeds its IDs into the merged candidate pool.

## Goals

- Resolve focal entities in a fixed priority order so the walk starts from the most relevant anchors.
- Resolve structured routes (entity, aspect, group, claim) when the graph is enabled.
- Walk the dependency graph within a strict budget honoring edge strength and confidence gates.
- Surface active constraints regardless of aspect limits so a constraint is never dropped by a cap.
- Return memory IDs with scores and paths, the constraints found, an entity count, and a timeout flag.

## Non-Goals

- Building the ontology, edges, or supersession (PRD-008); this phase reads them.
- Authorization (PRD-007c); traversal emits unauthorized IDs by design.
- Shaping the merged set (PRD-007d).

## User stories

- As recall, I want entity-centric traversal so that "what is true about X" can pull in linked evidence the text query alone would miss.
- As recall, I want active constraints surfaced even when aspect caps trim the walk so that a hard constraint is never silently dropped.
- As an operator, I want the walk bounded by a hard timeout so that a dense graph cannot stall a recall.

## Functional requirements

- **FR-1** Focal resolution MUST resolve in priority order: pinned entities, checkpoint entity IDs from session state, project-path matches, query-token matches against the entity FTS index, then a session-key fallback.
- **FR-2** When the graph is disabled, traversal MUST be skipped cleanly and contribute no IDs, leaving the lexical and vector channels (PRD-007a) to carry recall.
- **FR-3** Structured routes MUST resolve entity, aspect, `group_key`, and `claim_key` paths to memory IDs when the graph is enabled.
- **FR-4** The walk MUST enforce caps on aspects per entity, attributes per aspect, branching per focal entity, and total memory IDs collected.
- **FR-5** The walk MUST follow a dependency edge only when its strength times confidence clears the configured threshold, so loose `related_to` edges below the gate are not traversed.
- **FR-6** The walk MUST surface active constraints regardless of the aspect and attribute caps, so a constraint attribute is always returned if its entity is in the focal set.
- **FR-7** The walk MUST enforce a hard timeout; on timeout it MUST return what it has collected with a timeout flag set rather than failing the recall.
- **FR-8** Traversal MUST return memory IDs with scores and traversal paths, the constraints it found, an entity count, and the timeout flag, and MUST NOT load any content row.
- **FR-9** Traversal MUST run within the org/workspace partition, and its emitted IDs are still subject to the agent read-policy clause applied later in PRD-007c.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a query, when focal resolution runs, then it resolves in order: pinned, checkpoint IDs, project-path, entity FTS tokens, then session-key fallback. |
| AC-2 | Given the graph is disabled, when traversal runs, then it is skipped and contributes no candidates without error. |
| AC-3 | Given a focal set, when the walk runs, then it honors caps on aspects, attributes, branching, and total IDs. |
| AC-4 | Given a low strength-times-confidence edge, when the walk evaluates it, then the edge is not followed. |
| AC-5 | Given an active constraint under a focal entity, when caps trim the walk, then the constraint is still surfaced. |
| AC-6 | Given a dense graph, when the timeout fires, then the walk returns collected IDs with the timeout flag rather than failing. |
| AC-7 | Given the walk completes, then it returns IDs with scores and paths, constraints, an entity count, and the timeout flag, and no content was loaded. |

## Implementation notes

- Focal resolution priority is deliberate: explicit pins and session checkpoints beat fuzzy FTS token matches so the walk anchors on what the agent is actually working on.
- Edge gating uses the same strength and confidence fields recorded by PRD-008b, so a soft link with a required reason but low confidence stays out of recall.
- The emitted IDs merge into the PRD-007a pool by memory ID; structured evidence is one signal among lexical, semantic, and hint signals for the convolution in PRD-007d, never a dominant one.
- Default traversal budgets (cap values, edge threshold, timeout) are tunable and tracked below.

## Dependencies

- PRD-008 ontology (entities, aspects, claim slots, `entity_dependencies`, entity FTS index).
- PRD-005 session state (checkpoint entity IDs, session key).
- PRD-007a candidate collection (merges traversal IDs into the pool).
- PRD-007c authorization (applies the read-policy clause to traversal IDs).

## Open questions

- [ ] What are the default traversal budgets (aspects per entity, attributes per aspect, branching, total IDs)?
- [ ] What is the default edge strength-times-confidence threshold for traversal?
- [ ] What is the hard timeout budget for the walk?

## Related

- [parent index](./prd-007-retrieval-index.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
