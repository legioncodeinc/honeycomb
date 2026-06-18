# PRD-009c: Compaction Mode

> **Parent:** [PRD-009](./prd-009-dreaming-loop-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

A first-run and on-demand compaction mode that loads the entire entity graph, samples recent summaries, and reasons about duplicates, merges, and junk across the whole graph in one deliberate pass. Compaction is a mode of the PRD-009b session runner: same session lifecycle, same mutation format, same ontology control plane apply path. Only the input scope differs (full graph versus incremental delta) and the entry conditions differ (first run or explicit `--compact`). The pass runs inside the honeycomb daemon against DeepLake tables the daemon owns.

## Goals

- Clean up a graph that grew messy before dreaming was enabled, in one full-graph pass, so accumulated duplicates and junk are reconciled at once.
- Let an operator force a full pass on demand via `honeycomb dream trigger --compact`, regardless of the token counter state.
- Enter compaction automatically on first run when `backfillOnFirstRun: true` and no prior pass exists.
- Bound premium-model cost on large graphs by sampling recent summaries rather than loading them all.

## Non-Goals

- Defining the mutation format or the apply path; both are reused from PRD-009b.
- Changing the token-budget trigger; compaction bypasses it rather than altering it (PRD-009a).
- Selecting the model; the dreaming workload resolves through the router (PRD-010).

## User stories

- As an operator with a graph that grew messy before dreaming was enabled, I want a single full-graph pass so that accumulated duplicates and junk get cleaned up at once.
- As an operator, I want to trigger compaction on demand so that I can force a cleanup after a large import without waiting for the counter.
- As a new install, I want a backfill pass on first run so that my graph starts consolidated rather than accumulating noise until the first threshold.

## Functional requirements

- FR-1: When `backfillOnFirstRun: true` and no prior dreaming pass exists for a scope, the first dreaming run MUST enter compaction mode instead of an incremental pass.
- FR-2: `honeycomb dream trigger --compact` MUST queue a full-graph compaction pass for the target scope regardless of `tokens_since_last_pass`.
- FR-3: In compaction mode, the runner MUST load the entire entity graph (entities, aspects, attributes, relationships) for the scope rather than the incremental delta.
- FR-4: The runner MUST sample recent summaries rather than loading all of them, bounding input to `memory.dreaming.maxInputTokens`.
- FR-5: Compaction MUST emit mutations in the same structured format as incremental passes and apply them through the ontology control plane with provenance and pending review for destructive ops.
- FR-6: A compaction pass MUST run as a real captured session through the same PRD-009b lifecycle, so it is transcribed, summarized, and reviewable.
- FR-7: Compaction reads and writes MUST be scoped to the target org/workspace and `agent_id`; a compaction pass MUST NOT span scopes.
- FR-8: On completion, compaction MUST update `dreaming_state.last_pass_at` and clear `pending_job_id`, so subsequent passes return to incremental mode.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given `backfillOnFirstRun: true` and no prior pass, when dreaming first runs, then it enters compaction mode and walks the full graph instead of the incremental payload. |
| AC-2 | Given `honeycomb dream trigger --compact`, when it runs, then a full-graph compaction pass is queued regardless of the token counter state. |
| AC-3 | Given a large graph, when compaction assembles input, then recent summaries are sampled and total input stays within `maxInputTokens`. |
| AC-4 | Given a compaction pass completes, when the next pass runs, then it operates in incremental mode against the post-compaction `last_pass_at`. |
| AC-5 | Given compaction-emitted destructive mutations, when applied, then they route through the ontology control plane and land in pending review like any pass. |

## Implementation notes

- Compaction reuses the same mutation format as incremental passes; only the input scope differs (full graph vs delta).
- Sample recent summaries rather than loading all of them to bound input tokens; sampling strategy is an open question below.
- Graph-size guardrails: very large graphs may need chunked traversal or a budget cap, tracked as an open question, to keep premium-model cost bounded.
- `honeycomb dream trigger --compact` is exposed by the `honeycomb dream` CLI verb (parent index, API changes) and enqueues into the same `memory_jobs` queue PRD-009b consumes.

## Dependencies

- PRD-009b session runner (lifecycle, mutation apply, model resolution).
- PRD-009a `dreaming_state` row (for `last_pass_at` and pending-job bookkeeping).
- `honeycomb dream` CLI verb and daemon endpoint.
- DeepLake store via the daemon.

## Open questions

- [ ] Should compaction mode be rate-limited or budget-capped to bound premium-model cost on large graphs?
- [ ] What sampling strategy selects "recent" summaries for compaction (count, token budget, recency window)?

## Related

- [parent index](./prd-009-dreaming-loop-index.md)
- [Dreaming Loop](../../../knowledge/private/ai/dreaming-loop.md)
