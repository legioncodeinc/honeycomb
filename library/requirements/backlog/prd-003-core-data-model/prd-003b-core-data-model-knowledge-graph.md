# PRD-003b: Knowledge Graph Tables

> **Parent:** [PRD-003](./prd-003-core-data-model-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Define the ontology tables on DeepLake: `entities`, `entity_aspects`, `entity_attributes`, `entity_dependencies`, `memory_entity_mentions`, `epistemic_assertions`, and `ontology_proposals`, including the version-lineage columns supersession appends to. All are `USING deeplake` tables written only by the daemon, scoped by `agent_id` within a workspace, with org/workspace isolation at the storage partition layer. Because DeepLake cannot safely UPDATE in place under concurrency, claim edits append a new version and mark the prior one superseded rather than mutating it.

## Goals

- Declare every ontology table as a shared `{ name, sql }` column-definition array the create and lazy heal paths iterate.
- Make claim supersession append-only: a new `entity_attributes` version row, the prior marked `superseded`, never an in-place mutate.
- Carry an audited control plane (`ontology_proposals`) with operation, status, JSONB payload, confidence, rationale, evidence, and risk note.
- Require a reason on loose `related_to` dependency edges so weak links are auditable.

## Non-Goals

- The extraction and decision logic that proposes entities and claims (PRD-006, PRD-008).
- The retrieval-time graph traversal that reads these tables (PRD-007).
- The legacy `relations` table (kept out of the new catalog; superseded by `entity_dependencies`).
- The storage adapter primitives (PRD-002).

## User stories

- As the graph writer, I want claim attributes with `claim_key`, `group_key`, `status`, and `version` so supersession can append a new version without mutating in place.
- As an auditor, I want `ontology_proposals` to record every proposed graph change with rationale, evidence, and a risk note so the control plane is reviewable.
- As recall, I want `entity_dependencies` typed and confidence-weighted so traversal can favor strong links and a required reason explains weak ones.

## Functional requirements

- FR-1: The catalog defines `entities` with `id`, canonical `name`, `type`, `agent_id` (default `'default'`), optional `source_id`/`source_type` provenance, `created_at`, `updated_at`.
- FR-2: The catalog defines `entity_attributes` with `id`, `aspect_id`, `agent_id`, `memory_id`, `kind` (default `'attribute'`), `content`, `confidence`, `importance`, `status` (default `'active'`), `superseded_by`, `claim_key`, `group_key`, `version` (BIGINT default `1`), `created_at`, `updated_at`.
- FR-3: Supersession INSERTs `version` N+1 with `status = 'active'` and sets the prior row's `status = 'superseded'` and `superseded_by` to the new id; readers take the highest active version per `claim_key`.
- FR-4: The catalog defines `entity_aspects` (weighted dimensions of an entity with `entity_id`, `name`, `weight`) and `memory_entity_mentions` (the join of `memory_id` to `entity_id` with mention count/score).
- FR-5: The catalog defines `entity_dependencies` as audited edges with `source_entity_id`, `target_entity_id`, `type`, `strength`, `confidence`, and a `reason` that is required for loose `related_to` edges.
- FR-6: The catalog defines `epistemic_assertions` recording who `claimed`, `believed`, `observed`, `decided`, `preferred`, `denied`, or `questioned`, with subject, predicate, and provenance.
- FR-7: The catalog defines `ontology_proposals` with `operation`, `status`, a JSONB `payload`, `confidence`, `rationale`, `evidence`, and `risk_note` as the audited control plane.
- FR-8: All writes go through the daemon escaping helpers and lazy heal; the legacy `relations` table is not created in the new catalog.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a claim attribute, when defined, then `entity_attributes` carries `kind`, `status`, `claim_key`, `group_key`, `version`, and `superseded_by`. |
| AC-2 | Given a claim edit, when applied, then a new `version` row is INSERTed and the prior row is marked `status = 'superseded'` rather than mutated. |
| AC-3 | Given a loose link between entities, when stored, then `entity_dependencies` carries `type`, `strength`, `confidence`, and a non-empty `reason` for `related_to`. |
| AC-4 | Given a graph change, when proposed, then `ontology_proposals` records `operation`, `status`, JSONB `payload`, `confidence`, `rationale`, `evidence`, and `risk_note`. |
| AC-5 | Given a memory references an entity, when persisted, then a `memory_entity_mentions` row joins `memory_id` to `entity_id`. |
| AC-6 | Given a reader resolves a claim, when multiple versions exist, then it returns the highest `version` with `status = 'active'`. |
| AC-7 | Given any ontology table does not exist, when the first write runs, then it is created from its column-definition array and the write retries once. |

## Implementation notes

- Daemon modules: schema definition module owns the seven column-definition arrays; the graph persistence stage (PRD-008) is the writer; retrieval (PRD-007) is the traversal reader.
- DeepLake write patterns: `entity_attributes` and `epistemic_assertions` are append-only version-bumped; `entities`, `entity_aspects` are UPDATE-or-INSERT by identity; `ontology_proposals` is append-only INSERT with status advanced by a new row.
- The legacy `relations` table is intentionally excluded; all new audited links use `entity_dependencies`.
- Edge cases: a `related_to` edge with an empty `reason` is rejected by the writer; concurrent supersession races are made observable by re-reading the highest version after write.
- Failure handling: missing-column writes heal via `ALTER ADD COLUMN`; permission errors are classified distinctly from schema gaps so credentials problems never trigger a heal.

## Dependencies

- PRD-002 storage adapter and SQL helpers.
- PRD-003a `memories` (`memory_id` foreign reference in mentions and attributes).
- PRD-008 ontology persistence (producer); PRD-007 retrieval (consumer).

## Open questions

- [ ] Should `entity_dependencies` strength be a continuous `FLOAT4` or a small enumerated band?
- [ ] Do `epistemic_assertions` need their own embedding column for assertion-level recall?

## Related

- [parent index](./prd-003-core-data-model-index.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
