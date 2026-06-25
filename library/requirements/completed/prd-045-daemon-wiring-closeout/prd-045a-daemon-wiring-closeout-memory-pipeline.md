# PRD-045a: Wire the Memory Pipeline worker (closes PRD-006)

> **Status:** Completed
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-006 Memory Pipeline
> **Priority:** P0
> **Effort:** L

## Overview

PRD-006 shipped the durable five-stage memory pipeline (extraction → decision → controlled-write →
graph-persist → retention) as `memory_jobs`, but **the daemon never constructs a worker for it and capture never
enqueues pipeline jobs**. Captured turns are summarized and (meant to be) skillified, but never run through
fact-extraction/dedup/graph. This is the single largest "Completed ≠ live" gap and it cascades: the extraction
stage is the only would-be free-tier consumer of the PRD-010 model router, which is therefore also stranded.

## Evidence of the gap

- `assemble.ts` builds **only** the pollinating worker (`buildGatedPollinatingWorker`, started at `assemble.ts:1265`).
  No pipeline worker is constructed anywhere in the composition root.
- Capture enqueues only `summary`/`skillify` cue jobs (`src/daemon/runtime/capture/capture-handler.ts:268-275`),
  never `memory_extraction` / `memory_decision` / `memory_controlled_write` / `memory_graph_persist` /
  `memory_retention`.
- The engine exists but is unleased: `createStageWorker` (`pipeline/stage-worker.ts:238`), `createPipelineHandlers`
  (`pipeline/handlers.ts:51`); extraction calls `ModelClient.complete("memory_extraction", …)`
  (`pipeline/extraction.ts:271`) — which never fires because nothing leases the job.
- Per CONVENTIONS, only the extraction stage core is filled; the other four handlers are stubs.

## Goals

- Construct + start a **pipeline job worker** in `assembleDaemon` (after `startServices()`, like the pollinating
  worker) that leases the five pipeline job kinds and runs `createPipelineHandlers`.
- Enqueue the pipeline entry job on capture (or via a cue) so a captured turn enters the pipeline.
- Fill the four stub stage handlers (decision, controlled-write, graph-persist, retention) to the minimum that
  makes the wired path produce real, persisted output.
- Thread the real `ModelClient` (010 router) into the extraction stage so extraction actually runs.

## Non-Goals

- Redesigning the pipeline algorithm or its stage contracts — the stage interfaces exist; this wires + fills them.
- New DeepLake schema (the `memory`, knowledge-graph, and `memory_jobs` tables already exist).
- The `/api/inference/*` HTTP gateway (separate follow-up); extraction uses the in-process `ModelClient`.

## User stories

- As an operator, when a turn is captured, I want it to flow through the pipeline so durable memories and graph
  edges are produced — not just a raw `sessions` row.
- As a developer, I want the pipeline worker visible in the assembled daemon so I can prove it leases and completes
  jobs.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | `assembleDaemon` constructs + starts a pipeline worker leasing the five pipeline kinds; cite the `assemble.ts` line. |
| a-AC-2 | A captured turn enqueues the pipeline entry job (cite the enqueue site replacing/augmenting `capture-handler.ts:268-275`). |
| a-AC-3 | A live itest (PRD-031 net) proves: capture → extraction produces ≥1 persisted fact/edge under the daemon scope. |
| a-AC-4 | The four previously-stub stages produce real output (decision routes, controlled-write persists, graph-persist links, retention applies) — each covered by a test. |
| a-AC-5 | Fail-soft: a pipeline job error fails the job (dead-letter per the queue contract), never crashes the daemon or the capture path. |

## Implementation notes

- Mirror the pollinating worker lifecycle: build in `assembleDaemon`, start in `start()` after `daemon.startServices()`,
  stop in `shutdown()`. Lease `["memory_extraction", …]` (or a single entry kind that fans out).
- Reuse `daemon.services.queue` as both enqueuer and lease source — do not stand up a second queue.
- Keep the model dependency fail-soft: an absent `agent.yaml`/`inference:` block degrades extraction to the no-op
  client (zero-mutation pass), exactly as pollinating does.

## Default posture & enable mechanism (recorded decision — 2026-06-22 close-out)

The pipeline worker is **constructed, started, and leasing** on every boot, and capture enqueues the entry job — it is
genuinely live (a-AC-1/a-AC-2). The **stage handlers, however, are gated OFF by default** (`pipeline/config.ts`:
`enabled`, `graph.enabled`, `graph.extractionWritesEnabled`, `autonomous.enabled` all default `false`, false-safe).
This is a **deliberate "no surprise model spend" posture** — identical in spirit to the pollinating default-OFF decision
([PRD-045d](./prd-045d-daemon-wiring-closeout-pollinating-activation.md)): extraction calls the PRD-010 model router, so
a vanilla boot must not silently incur model cost. The wired path is **proven on the enabled path** by the deterministic
chain test + the token-gated live itest (a-AC-3/a-AC-4). Confirmed and accepted by the product owner during the
close-out (QA warning W2).

**Operator enable mechanism (env, `HONEYCOMB_PIPELINE_` prefix):**
- `HONEYCOMB_PIPELINE_ENABLED=true` — master switch (off → no stage runs).
- `HONEYCOMB_PIPELINE_GRAPH_ENABLED=true` + `HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES=true` — graph-persist +
  `inlineLinkMemory` writes (045c live apply path).
- `HONEYCOMB_PIPELINE_AUTONOMOUS_ENABLED=true` (+ `..._ALLOW_UPDATE_DELETE`) — retention / autonomous mutations.
- Extraction additionally requires an `inference:` block in `agent.yaml` + the provider key; absent → fail-soft
  zero-mutation pass (never crashes).

## Open questions (resolved during close-out)

- [x] Single entry job kind that fans out to later stages, or enqueue each stage explicitly? → **entry-fan-out** (one
      cheap `memory_extraction` entry job; each stage fans out to the next).
- [x] Does the pipeline run inline-per-turn or batched? → **per-turn entry job**, downstream stages run as leased jobs.
- [x] Overlap with the pollinating consolidation pass → **no double-write**: linker + control-plane apply use
      deterministic IDs + presence-probe, so the pipeline graph-persist path and the pollinating apply path converge to
      one row (proven by 045d's `pollinate-coordination-nodoublewrite.test.ts`).
