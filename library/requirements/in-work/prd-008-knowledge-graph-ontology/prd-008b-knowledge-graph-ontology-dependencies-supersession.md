# PRD-008b: Dependencies and Supersession

> **Parent:** [PRD-008](./prd-008-knowledge-graph-ontology-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

Build the audited dependency edges in `entity_dependencies` and the append-only supersession path that marks conflicting claim siblings superseded without mutating them in place. Both exist for the same reason: DeepLake's query endpoint coalesces concurrent UPDATEs in a way that can drop edits, so claim attributes are never mutated in place and edges carry an audit trail. Supersession is what lets retrieval (PRD-007d currentness) prefer the current value of a claim while keeping the full version history inspectable. The daemon on port 3850 is the only writer.

## Goals

- Record dependency edges in `entity_dependencies` with type, strength, confidence, and a required reason for loose links.
- Gate traversal so only edges whose strength times confidence clears a threshold are followed.
- Supersede conflicting claim siblings by append: write the new attribute with a fresh version and advance the prior sibling's status and `superseded_by`.
- Never mutate a claim attribute in place, and never auto-supersede a constraint.
- Keep the full version history intact on disk so it is inspected, not reconstructed.

## Non-Goals

- The entity model and inline linker (PRD-008a).
- The control plane, proposals, and assertions (PRD-008c).
- Retrieval currentness shaping (PRD-007d), which consumes this lineage.
- The legacy `relations` table, which is not used for new links.

## User stories

- As retrieval, I want supersession recorded as appends so that the current value of a claim outranks its predecessor while full history stays inspectable.
- As a reviewer, I want loose `related_to` edges to carry a required reason so that there is always an audit trail for soft links.
- As an operator, I want constraints exempt from auto-supersession so that a hard constraint is never silently replaced.

## Functional requirements

- **FR-1** Dependency edges MUST live in `entity_dependencies`, each with a type, a strength, a confidence, and, for loose `related_to` edges, a required reason.
- **FR-2** Traversal MUST follow an edge only when its strength times confidence clears the configured threshold, so soft low-confidence links are excluded from recall (consumed by PRD-007b).
- **FR-3** New audited links MUST use `entity_dependencies`; the legacy `relations` table MUST NOT be written for new links.
- **FR-4** When a new attribute lands in the same entity, aspect, `group_key`, and `claim_key` slot as an existing one, the conflicting sibling MUST be marked superseded rather than deleted.
- **FR-5** Supersession MUST be an append: the new attribute is written with a fresh version, and the prior sibling's `status` and `superseded_by` are advanced through the same append-only, version-bumped path the daemon uses for every concurrent-edit table.
- **FR-6** Claim attributes MUST NOT be mutated in place, because the DeepLake query endpoint coalesces concurrent UPDATEs in a way that can drop edits.
- **FR-7** Conflict detection MUST use lexical overlap plus negation and antonym signals, with an optional LLM semantic fallback.
- **FR-8** Constraints MUST NOT be auto-superseded; replacing a constraint MUST require a deliberate operation through the control plane (PRD-008c).
- **FR-9** Every name, key, and content value interpolated into a statement MUST be escaped through the `sqlStr`/`sqlLike`/`sqlIdent` helpers, and all writes MUST go through the daemon as the only DeepLake client.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a new attribute in the same entity/aspect/group/claim slot, when supersession runs, then the conflicting sibling is marked superseded (status and `superseded_by` advanced via the append-only version-bumped path), not deleted or mutated. |
| AC-2 | Given concurrent edits, when supersession runs, then no claim attribute is mutated in place and full version history remains on disk. |
| AC-3 | Given a loose `related_to` edge, when written, then it carries type, strength, confidence, and a required reason. |
| AC-4 | Given an edge, when traversal evaluates it, then it is followed only when strength times confidence clears the threshold. |
| AC-5 | Given a constraint, when a conflicting value arrives, then the constraint is not auto-superseded. |
| AC-6 | Given a conflict, when detection runs, then it uses lexical overlap plus negation and antonym signals with an optional LLM fallback. |
| AC-7 | Given any write, when a statement is built, then values are escaped through the SQL helpers and the write goes through the daemon. |

## Implementation notes

- Append-only supersession is not a style choice: the endpoint's UPDATE coalescing can silently drop edits, so the only safe way to record a status change is to append a version-bumped row, the same path used for every concurrent-edit table.
- Because the prior sibling keeps its row with `status` and `superseded_by` advanced, currentness shaping in PRD-007d can see both values and deterministically prefer the current one.
- Edge strength and confidence are the same fields PRD-007b's traversal gate reads, so a soft link with a recorded reason but low confidence stays out of recall.
- Conflict-detection thresholds (lexical overlap cutoff, when the LLM fallback fires) are tunable and tracked below.

## Dependencies

- PRD-008a entity model (entities, aspects, claim slots the edges and supersession operate on).
- PRD-003b ontology tables (`entity_dependencies`, attribute version columns) and SQL escaping helpers.
- The daemon append-only version-bump primitive shared across concurrent-edit tables.
- PRD-007b / PRD-007d (consume edges and supersession lineage).

## Open questions

- [ ] What lexical-overlap cutoff triggers a conflict, and when does the LLM semantic fallback fire?
- [ ] What is the default strength-times-confidence threshold for traversable edges?
- [ ] Should `deleted` attributes ever be hard-removed, or only ever marked?

## Related

- [parent index](./prd-008-knowledge-graph-ontology-index.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
