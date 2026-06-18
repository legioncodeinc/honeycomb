# PRD-009b: Dreaming Session Runner

> **Parent:** [PRD-009](./prd-009-dreaming-loop-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L

## Scope

Run a dreaming pass as a real captured session that loads identity files, unprocessed summaries since the last pass, and a graph snapshot, then applies the returned mutation set through the ontology control plane. The runner consumes a queued job from PRD-009a, executes it inside the honeycomb daemon against DeepLake tables the daemon owns, and routes the model call through the provider router's dreaming workload. This sub-PRD covers incremental passes; full-graph compaction is PRD-009c.

## Goals

- Make dreaming a first-class session that goes through the normal session-start hook, captures a transcript, and gets summarized at the end like any other session.
- Let the pass observe its own prior consolidation decisions by loading prior dreaming sessions and `MEMORY.md`, so adjustments compound across passes instead of restarting from amnesia.
- Keep regular passes incremental and bounded: only new summaries plus changed entities and attributes, with a graph query tool available on demand.
- Apply every returned mutation through the ontology control plane with provenance, so destructive ops land in the pending review queue rather than applying blind.

## Non-Goals

- Deciding when a pass runs or resetting the counter (PRD-009a).
- Walking the full graph for first-run or backfill (PRD-009c).
- Owning the ontology control plane or its pending-review queue; this runner is a consumer.
- Choosing the model directly; the router resolves the dreaming workload target.

## User stories

- As an operator, I want dreaming to go through the normal session lifecycle so that its consolidation decisions are captured and reviewable like any other session.
- As the dreaming agent, I want to see my prior passes so that I can tell whether earlier merges improved recall or earlier pruning was too aggressive.
- As a reviewer, I want destructive mutations queued for approval so that a bad merge never silently destroys lineage.

## Functional requirements

- FR-1: On dequeuing a dreaming job, the runner MUST start a real session through the normal session-start hook and capture a transcript that is summarized at session end.
- FR-2: The runner MUST load, per the identity preset, the startup identity files, prior dreaming sessions, `MEMORY.md`, and a `DREAMING.md` task prompt that is loaded only for dreaming sessions and never in normal startup.
- FR-3: For an incremental pass, the runner MUST load only summaries written since `last_pass_at` (chronological) plus entities and attributes that changed since the last pass, as a bounded payload.
- FR-4: The runner MUST expose a graph query tool so the model can inspect the rest of the graph on demand without loading it all up front.
- FR-5: The model MUST be resolved through the provider router's dreaming workload, which favors a stronger target than extraction uses.
- FR-6: The runner MUST accept the structured mutation set (`create_entity`, `merge_entities`, `delete_entity`, `update_aspect`, `supersede_attribute`, `create_attribute`, `delete_attribute`) plus a human-readable summary and token budget.
- FR-7: Each mutation MUST be applied through the ontology control plane so risky or destructive ops route to the pending review queue and every applied change keeps provenance.
- FR-8: Mutations MUST write through DeepLake's append-only, version-bumped path; a merge or supersession advances row status without destroying prior rows, and raw artifacts and transcripts are never rewritten.
- FR-9: On successful apply, the runner MUST update `dreaming_state.last_pass_at` and clear `pending_job_id` so PRD-009a can queue the next pass.
- FR-10: All reads and writes MUST be scoped to the job's org/workspace and `agent_id`; a pass MUST NOT read or mutate another agent's graph.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a queued pass, when it starts, then it loads identity files, new summaries since the last pass, a graph snapshot, and the `DREAMING.md` task prompt, and captures a transcript. |
| AC-2 | Given a returned mutation set, when it is applied, then each op routes through the ontology control plane with provenance and destructive ops land in pending review. |
| AC-3 | Given an incremental pass, when payload is assembled, then only post-`last_pass_at` summaries and changed entities/attributes are loaded, with a graph query tool available. |
| AC-4 | Given a `merge_entities` op, when applied, then prior rows are advanced in status on the append-only path and remain on disk with lineage intact. |
| AC-5 | Given a successful pass, when it finishes, then `last_pass_at` is updated and `pending_job_id` is cleared. |
| AC-6 | Given the model call, when routing resolves, then it uses the dreaming workload's stronger target, not the extraction target. |

## Implementation notes

- Regular passes are incremental: only new summaries plus changed entities/attributes, with a graph query tool available on demand. Bounded payload size is governed by `memory.dreaming.maxInputTokens` (default 128000).
- Model resolves through the router's dreaming workload; the workload key is owned by PRD-010 config and referenced here.
- Mutations write through DeepLake's append-only, version-bumped path; merges advance status without destroying prior rows.
- Because dreaming runs as a captured session, its own summary increments the PRD-009a counter on the same footing as any session.

## Dependencies

- PRD-009a (queued job, `dreaming_state` row).
- Ontology control plane and pending-review queue (consumed, owned elsewhere).
- PRD-010 provider router (dreaming workload resolution).
- Session-start hook, transcript capture, and summary pipeline.
- DeepLake store via the daemon.

## Open questions

- [ ] How are mutations attributed when a dreaming pass merges entities owned by different `agent_id`s?
- [ ] Should a pass that exceeds `maxInputTokens` truncate oldest summaries or split into multiple jobs?

## Related

- [parent index](./prd-009-dreaming-loop-index.md)
- [Dreaming Loop](../../../knowledge/private/ai/dreaming-loop.md)
- [Knowledge Graph Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
