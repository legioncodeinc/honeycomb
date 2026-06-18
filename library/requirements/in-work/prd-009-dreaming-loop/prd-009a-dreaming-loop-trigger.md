# PRD-009a: Token-Budget Trigger

> **Parent:** [PRD-009](./prd-009-dreaming-loop-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

A token-budget counter, persisted in a `dreaming_state` row in DeepLake, that increments on every session-summary write and queues a dreaming job when it crosses a configurable threshold. The trigger lives entirely inside the honeycomb daemon's maintenance loop; nothing outside the daemon reads or writes the counter, and the daemon is the only client that touches the DeepLake store. The trigger decides *when* a pass should run; PRD-009b owns running it and PRD-009c owns full-graph compaction.

## Goals

- Scale dreaming to actual usage by firing on accumulated summary tokens rather than a wall clock, so heavy users dream often and light users dream rarely.
- Persist the counter in DeepLake as a `dreaming_state` row scoped to org/workspace and `agent_id`, so a daemon restart never loses progress toward the threshold.
- Queue exactly one pending pass at a time and reset the counter atomically when a job is enqueued, so passes never stack.
- Keep the threshold and enablement declarative under `memory.dreaming` so an operator tunes cadence without code changes.

## Non-Goals

- Executing the dreaming pass or applying mutations (PRD-009b).
- Loading or sampling the graph for compaction (PRD-009c).
- Selecting the dreaming model; that resolves through the provider router workload (PRD-010).
- Counting interactive or extraction tokens; only session-summary writes increment this counter.

## User stories

- As a heavy user, I want dreaming to fire often without my configuring a schedule so that consolidation keeps pace with my volume.
- As a light user, I want dreaming to stay quiet until enough has accumulated so that I am not paying premium-model cost for trivial deltas.
- As an operator, I want to inspect tokens-since-last-pass so that I can predict when the next pass will run.

## Functional requirements

- FR-1: The daemon MUST maintain a `dreaming_state` row in DeepLake recording `tokens_since_last_pass`, `last_pass_at`, and `pending_job_id`, keyed by org/workspace and `agent_id` scope.
- FR-2: On every session-summary write, the daemon MUST increment `tokens_since_last_pass` by the summary's token count for the matching scope.
- FR-3: On each maintenance-loop tick, the daemon MUST compare `tokens_since_last_pass` against `memory.dreaming.tokenThreshold` (default 100000) for each scope.
- FR-4: When the counter meets or exceeds the threshold and no pass is pending for that scope, the daemon MUST enqueue exactly one dreaming job into `memory_jobs` and record its id in `pending_job_id`.
- FR-5: The counter MUST reset to zero atomically with the enqueue, so concurrent summary writes after enqueue accumulate toward the next pass and are not lost.
- FR-6: When `pending_job_id` is set, the daemon MUST NOT enqueue a second pass for that scope until the prior job reaches a terminal state.
- FR-7: When `memory.dreaming.enabled` is false, the daemon MUST still increment the counter but MUST NOT enqueue jobs, so re-enabling resumes from accumulated tokens.
- FR-8: The increment and threshold check MUST honor the append-only, version-bumped DeepLake write path; the daemon MUST never mutate the row in place outside that path.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a session-summary write, when it completes, then `dreaming_state.tokens_since_last_pass` increases by the summary's token count. |
| AC-2 | Given the counter crosses `tokenThreshold`, when the maintenance loop ticks, then exactly one dreaming job is queued and the counter resets to zero. |
| AC-3 | Given a pass already pending for a scope, when the counter crosses the threshold again, then no second job is enqueued until the first reaches a terminal state. |
| AC-4 | Given `memory.dreaming.enabled: false`, when summaries are written past the threshold, then the counter still grows but no job is queued. |
| AC-5 | Given a daemon restart between summary writes, when it comes back up, then `tokens_since_last_pass` reflects all writes that committed before the restart. |
| AC-6 | Given two `agent_id`s under the same workspace, when summaries are written, then each scope accumulates its own counter independently. |

## Implementation notes

- Counter lives in a `dreaming_state` row keyed by scope; default threshold around 100k tokens, configurable under `memory.dreaming`. Open question on whether scope is workspace, agent, or global is tracked below.
- Reset and enqueue must be a single transactional unit against DeepLake to avoid a race where a summary write between the threshold read and the reset is lost.
- The maintenance loop already ticks for other periodic work; the trigger adds a per-scope check rather than a new timer.
- Token counts come from the summary writer, not recomputed here, so the counter matches the synthesis stage's accounting.

## Dependencies

- DeepLake store and the daemon maintenance loop (the only DeepLake client).
- Session-summary write path (memory pipeline) for token counts.
- `memory_jobs` queue consumed by PRD-009b.

## Open questions

- [ ] Should the default `tokenThreshold` (around 100k) be per-workspace, per-agent, or global?
- [ ] Should the counter decay or expire if a workspace goes idle for a long period?

## Related

- [parent index](./prd-009-dreaming-loop-index.md)
- [Dreaming Loop](../../../knowledge/private/ai/dreaming-loop.md)
