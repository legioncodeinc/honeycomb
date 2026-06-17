# PRD-006a: Extraction

> **Parent:** [PRD-006](./prd-006-memory-pipeline-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Build the extraction worker that leases a job, calls the router-selected `memory_extraction` model, and decomposes a raw memory into bounded `facts` (content, type, confidence) and `entities` (source/relationship/target triples). Extraction is the first asynchronous stage of the pipeline: it runs off the write path as a durable `memory_jobs` entry on the daemon, after the raw content has already been committed. The work survives daemon restarts via the lease/complete/fail/dead lifecycle. Only the daemon touches the DeepLake GPU-backed store; the model output is structured material for the decision stage, not a write to `memories`.

## Goals

- Lease an extraction job from `memory_jobs` and process it under the lease/complete/fail/dead lifecycle with exponential backoff and a stale-lease reaper.
- Call the model the router selects for the `memory_extraction` workload and decompose the raw memory into facts and entity triples.
- Bound inputs and outputs so a single memory cannot produce an unbounded or oversized result.
- Survive bad model output: strip chain-of-thought, parse JSON defensively, and keep partial results rather than failing the whole job.
- Thread `org`, `workspace`, and `agent_id` through the job so extracted structure stays in scope.

## Non-Goals

- Deciding what to do with extracted facts (PRD-006b) or writing memories (PRD-006c).
- Graph persistence (PRD-006d) and retention (PRD-006e).
- Choosing or hosting the extraction model; the router selects it (model-provider-router).

## User stories

- As the pipeline, I want raw text decomposed into discrete facts and triples so that downstream stages can reason over structure rather than prose.
- As an operator, I want extraction to run as a durable job so that it resumes after a daemon restart instead of losing work.
- As a reviewer, I want invalid fields dropped with a warning so that one malformed fact never kills extraction of the rest.

## Functional requirements

- **FR-1** The extraction worker SHALL lease a job from `memory_jobs`, process it, and mark it complete, fail (with exponential backoff), or dead per the job lifecycle.
- **FR-2** A stale-lease reaper SHALL reclaim jobs whose lease expired so a crashed worker does not strand a job.
- **FR-3** The worker SHALL call the model selected by the router for the `memory_extraction` workload.
- **FR-4** The model SHALL decompose the memory into `facts`, each with `content`, a `type`, and a `confidence` between 0 and 1, and into `entities` as (source, relationship, target) triples.
- **FR-5** The worker SHALL strip chain-of-thought blocks from the model output before parsing JSON.
- **FR-6** Input SHALL be capped (around 12,000 characters) before the model call.
- **FR-7** Output SHALL be bounded to roughly 20 facts and 50 entities, with per-fact length limits applied.
- **FR-8** Invalid or malformed fields SHALL be logged as warnings and dropped, and partial valid results SHALL be kept rather than failing the whole job.
- **FR-9** Extraction SHALL run only when the pipeline is `enabled` and the extraction provider is not `none`; otherwise the job SHALL be skipped or no-opped.
- **FR-10** Every job SHALL thread `org`, `workspace`, and `agent_id` so the extracted structure stays within tenancy and scope.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a raw memory, when extraction runs, then it returns facts (each with confidence 0-1) and entity triples, with chain-of-thought stripped before JSON parsing. |
| AC-2 | Given an oversized input, when extraction runs, then input is capped at ~12,000 characters before the model call. |
| AC-3 | Given an oversized result, when extraction completes, then output is bounded to ~20 facts and ~50 entities with per-fact length limits. |
| AC-4 | Given partially invalid output, when extraction completes, then invalid fields are logged and dropped and partial results are kept rather than failing the job. |
| AC-5 | Given the pipeline is disabled or the extraction provider is `none`, when a job is leased, then extraction does not run. |
| AC-6 | Given a worker crashes mid-job, when the lease goes stale, then the reaper reclaims the job and it is retried. |

## Implementation notes

- Extraction runs only when the pipeline is `enabled` and the extraction provider is not `none`. The model is chosen by the router for the `memory_extraction` workload, so this worker holds no provider knowledge of its own.
- Partial results survive bad JSON: the parser strips chain-of-thought, tolerates truncation, and drops invalid fields with a warning. The point is that a slow or sloppy model never costs a captured memory its enrichment outright.
- Job payloads (facts and entity triples) are stored as `jsonb` on the job and also recorded for the decision stage's history. Exact caps and per-fact length limits are tuned for production (see open questions).

## Dependencies

- PRD-003/PRD-004 (`memory_jobs` table and the job lifecycle, lease/complete/fail/dead, backoff, reaper).
- The model-provider-router for the `memory_extraction` workload selection.
- PRD-005 capture, which commits the raw memory this stage reads.

## Open questions

- [ ] What are the exact production caps (input chars, max facts, max entities) and per-fact length limits?
- [ ] What is the extraction prompt/JSON contract the parser expects?

## Related

- [parent index](./prd-006-memory-pipeline-index.md)
- [Memory Pipeline](../../../knowledge/private/ai/memory-pipeline.md)
- [Model Provider Router](../../../knowledge/private/ai/model-provider-router.md)
