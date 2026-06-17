# PRD-008c: Ontology Control Plane

> **Parent:** [PRD-008](./prd-008-knowledge-graph-ontology-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

Build the audited control plane for deliberate structural change: `ontology_proposals` with direct-apply versus pending-review routing, the apply path that copies evidence onto the resulting rows for lineage, and the `epistemic_assertions` attribution layer. This is the third and most trust-controlled write path into the graph, distinct from the inline linker (PRD-008a) and the background pipeline writer. It is driven from the `honeycomb ontology` CLI against the daemon on port 3850, the only DeepLake client. Raw source artifacts and transcripts are never rewritten when graph rows change.

## Goals

- Route every deliberate structural change through `ontology_proposals` with a full audit record.
- Apply bounded, explicit operations directly and write an applied proposal row with evidence copied onto the resulting rows.
- Send broad, risky, destructive, or generated-batch changes to a pending review queue instead of applying.
- Preserve attribution through `epistemic_assertions` without auto-promoting assertions into ontology truth.
- Expose the control plane through the `honeycomb ontology` CLI, scoped by org, workspace, and `agent_id`.

## Non-Goals

- The entity model and inline linker (PRD-008a).
- Dependency edges and supersession mechanics (PRD-008b), which the apply path invokes.
- The background pipeline graph writer (PRD-006d).
- Retrieval consumption of assertions (PRD-007), beyond not auto-promoting them here.

## User stories

- As an operator, I want structural changes audited and routed by risk so that bounded edits apply directly while broad refactors wait for review.
- As a reviewer, I want a pending queue for risky changes so that a destructive or generated batch cannot land unreviewed.
- As an analyst, I want epistemic assertions kept separate from facts so that "who believes X" never silently becomes "X is true."

## Functional requirements

- **FR-1** Every deliberate structural change MUST be recorded as an `ontology_proposal` carrying operation, status (`pending`, `applied`, `rejected`, `failed`), a `jsonb` payload, confidence, rationale, evidence, a risk note, and source provenance.
- **FR-2** The operation set MUST cover entities (create, rename, merge, archive), aspects (create, rename, archive), claim values (add, set, supersede, archive, restore version), links (create, update, archive), plus `extract` and `consolidate`.
- **FR-3** Clear, bounded, explicit operations MUST apply directly and write an applied proposal row alongside the change, with the applied evidence copied onto the resulting attribute and dependency rows for lineage.
- **FR-4** Broad refactors, risky or destructive changes, and generated batches MUST enter a pending review queue instead of applying.
- **FR-5** Raw source artifacts and transcripts MUST never be rewritten when graph or memory rows change.
- **FR-6** Claim-value supersession invoked by the apply path MUST use the append-only, version-bumped path from PRD-008b, never an in-place mutation.
- **FR-7** `epistemic_assertions` MUST preserve a predicate (`claims`, `believes`, `observed`, `decided`, `prefers`, `denies`, `questions`), the content, the speaker, a confidence, evidence, and a status; an assertion MAY link to a claim attribute but MUST stay a separate evidence-and-attribution layer.
- **FR-8** Epistemic assertions MUST NOT auto-promote into ontology truth; promoting an assertion to a claim MUST go through a proposal.
- **FR-9** The control plane MUST be driven from the `honeycomb ontology` CLI (pipeline explain, proposals, assertions, entity merge-plan, stream apply with dry-run), scoped by org, workspace, and `agent_id`, with all interpolation routed through the SQL escaping helpers.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a bounded explicit operation, when submitted, then it applies directly and writes an applied proposal row with evidence copied onto the resulting attribute and dependency rows. |
| AC-2 | Given a broad, risky, or generated batch change, when submitted, then it enters the pending review queue instead of applying. |
| AC-3 | Given any structural change, when graph rows change, then raw source artifacts and transcripts are never rewritten. |
| AC-4 | Given a supersede operation, when applied, then it uses the append-only version-bumped path, not an in-place update. |
| AC-5 | Given an epistemic assertion, when stored, then it carries a predicate, content, speaker, confidence, evidence, and status, and does not auto-promote into ontology truth. |
| AC-6 | Given a proposal, when recorded, then it carries operation, status, `jsonb` payload, confidence, rationale, evidence, risk note, and source provenance. |
| AC-7 | Given a CLI invocation (e.g. `stream apply --dry-run`), when run, then it is scoped by org/workspace/agent and reports the planned change without mutating on dry-run. |

## Implementation notes

- The two-mode model is the whole point: bounded operations are cheap and reversible enough to apply with an audit row, while broad or destructive changes are queued so a human (or a higher-trust process) signs off first.
- Evidence is copied onto the resulting rows at apply time so lineage survives even if the proposal row is later archived; the graph row itself points back to its evidence.
- Assertions are a parallel layer by design: who said what is genuinely different information from whether it is true, and conflating them would let opinion contaminate the fact graph.
- Risk-routing thresholds (confidence and risk-note cutoffs that send a change to review) are tunable and tracked in the parent open questions.

## Dependencies

- PRD-008a entity model and PRD-008b supersession path (the apply path operates on both).
- PRD-003b ontology tables (`ontology_proposals`, `epistemic_assertions`) and SQL escaping helpers.
- The `honeycomb ontology` CLI surface and the daemon (port 3850) as the only DeepLake client.

## Open questions

- [ ] What confidence and risk thresholds route a change to direct-apply versus the pending review queue?
- [ ] Who or what approves pending-queue items (human reviewer, higher-trust agent, both)?
- [ ] How do epistemic assertions surface in retrieval without auto-promoting into ontology truth?

## Related

- [parent index](./prd-008-knowledge-graph-ontology-index.md)
- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
