# PRD-006b: Decision

> **Parent:** [PRD-006](./prd-006-memory-pipeline-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the decision stage that, for each extracted fact, runs a hybrid search for the top existing candidates and asks the model whether to add, update, delete, or none, recording every proposal to `memory_history`. Decision is the stage that prevents blind appending: by checking each new fact against existing memories it can dedup, supersede, or skip. It produces proposals, not writes; the controlled-writes stage (PRD-006c) is the only stage that mutates `memories`. Every proposal, applied or not, is written to `memory_history`, which is what makes shadow mode and audits possible. All work threads `org`, `workspace`, and `agent_id`, and only the daemon touches the DeepLake store.

## Goals

- For each extracted fact, fetch the top existing candidate memories via hybrid search.
- Ask the router-selected model to choose `add`, `update`, `delete`, or `none`, with a target memory ID, confidence, and reason.
- Short-circuit to an immediate `add` proposal without a model call when there are no candidates.
- Record every proposal, applied or not, to `memory_history` for shadow mode and audits.
- Keep all candidate lookups and proposals scoped by org, workspace, and agent.

## Non-Goals

- Extraction of the facts this stage consumes (PRD-006a).
- Writing or mutating memories (PRD-006c); decision only proposes.
- Graph persistence (PRD-006d) and retention (PRD-006e).

## User stories

- As the pipeline, I want a per-fact decision against existing memories so that I update or dedup instead of blindly appending.
- As an auditor, I want every proposal recorded to history so that I can review what the pipeline intended even when nothing was written.
- As an operator running shadow mode, I want decisions logged without writes so that I can validate the pipeline before trusting it.

## Functional requirements

- **FR-1** For each extracted fact, the decision stage SHALL run a hybrid search and retrieve the top few existing candidate memories within the fact's org/workspace/agent scope.
- **FR-2** The stage SHALL ask the router-selected model to return one of `add`, `update`, `delete`, or `none`.
- **FR-3** Each proposal SHALL include a target memory ID (where applicable), a confidence, and a reason.
- **FR-4** When a fact has no candidates, the stage SHALL propose an immediate `add` without a model call.
- **FR-5** Every proposal, whether it will be applied or not, SHALL be recorded to `memory_history`.
- **FR-6** Proposals recorded under shadow mode SHALL be attributed to the `pipeline-shadow` actor.
- **FR-7** The stage SHALL produce proposals only; it SHALL NOT write to or mutate the `memories` table.
- **FR-8** All hybrid search queries and history writes SHALL route value interpolation through the SQL escaping helpers, since the store has no parameterized queries.
- **FR-9** The hybrid search blend SHALL combine lexical and vector (GPU) matching against the candidate set, consistent with retrieval.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an extracted fact with candidates, when the decision stage runs, then it returns add/update/delete/none with a target memory ID, confidence, and reason. |
| AC-2 | Given a fact with no candidates, when the stage runs, then it proposes an immediate `add` without a model call. |
| AC-3 | Given any proposal, when the stage completes, then the proposal is recorded to `memory_history`. |
| AC-4 | Given shadow mode, when a proposal is recorded, then it is attributed to the `pipeline-shadow` actor and no memory is written. |
| AC-5 | Given a decision run, when it completes, then no `memories` rows were mutated by this stage. |

## Implementation notes

- The history recorded here, applied or not, is what makes shadow mode and audits possible. It is the canonical record of pipeline intent independent of whether the write stage acted.
- Hybrid search supplies the top few candidates per fact, combining lexical and vector matching as retrieval does, so the model decides against the same candidate set retrieval would surface. The candidate count and exact blend are tuned (see open questions).
- The no-candidate short-circuit avoids a model call where the answer is unambiguous, keeping the stage cheap on novel facts.

## Dependencies

- PRD-006a (the extracted facts this stage decides over).
- The hybrid search path shared with retrieval (PRD-007) for candidate lookup.
- `memory_history` table (PRD-003/PRD-004) and the model-provider-router.

## Open questions

- [ ] How many candidates per fact, and what lexical/vector blend, does decision-time hybrid search use?
- [ ] What is the decision prompt/JSON contract (fields and allowed values)?

## Related

- [parent index](./prd-006-memory-pipeline-index.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [Schema](../../../knowledge/private/data/schema.md)
