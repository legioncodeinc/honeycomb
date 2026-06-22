# PRD-045b: Wire (or de-scope) the Retrieval shaping engine (closes PRD-007)

> **Status:** Draft
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-007 Retrieval
> **Priority:** P1
> **Effort:** M

## Overview

Live recall works: `POST /api/memories/recall` calls `recallMemories`, a real lexical-UNION-ALL + semantic-`<#>`
engine with RRF fusion and an honest `degraded` flag. But the **engineered five-phase `RecallEngine`** that PRD-007
specified as its headline deliverable — candidate collection → authorization re-query boundary → shaping/currentness
(supersession downweighting) → confidence gate — has **zero production callers**, and its phases default to no-ops.
So AC-2 (authorization boundary), AC-3 (currentness), and AC-4 (confidence gate) are not on any live path.

This sub-PRD forces a decision and removes the doc/runtime gap: **either wire the phases onto the recall route, or
formally de-scope the five-phase engine and reconcile PRD-007 to describe what actually ships.**

## Evidence of the gap

- `createRecallEngine` / `new RecallEngine` appear only inside `recall/` and the QA report — never in a route
  (`recall/engine.ts:149`).
- Phases default to `noopTraversalPhase` / `noopAuthorizationPhase` / `noopShapingPhase` / `noopGatePhase`
  (`recall/engine.ts:121-124`).
- The live path is `memories/api.ts:238` → `recallMemories` (`memories/recall.ts:549`), which does NOT run the
  five-phase orchestrator. Recall IS scope-bound (queries carry the daemon scope), so the data layer isn't
  unauthorized — but the engineered currentness/confidence shaping is dormant.

## Goals

- Make an explicit, recorded decision: **wire** vs **de-scope** the five-phase engine.
- If wiring: route `recallMemories` results through the shaping + currentness + confidence phases (filling the no-op
  phases with real implementations) so supersession downweighting and the confidence gate apply on live recall.
- If de-scoping: delete/quarantine the dead engine, and rewrite PRD-007's AC-2/3/4 to match the shipped
  lexical+vector RRF behavior — no overstated doc.

## Non-Goals

- Changing the lexical+vector RRF fusion that already works (PRD-027 ranking stays).
- Re-adding embeddings work (PRD-025 is live).

## User stories

- As a user, when a memory has been superseded, I want recall to downweight the stale version (currentness), not
  return it co-equal — or I want the docs to stop claiming it does.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | A recorded decision (wire vs de-scope) with rationale lands in this sub-PRD's Decisions. |
| b-AC-2 | If wired: a live itest proves a superseded memory is downweighted/gated on `POST /api/memories/recall`; cite the phase invocation site. |
| b-AC-3 | If de-scoped: the dead engine is removed and PRD-007's AC-2/3/4 are rewritten to the shipped behavior. |
| b-AC-4 | No remaining gap between PRD-007's doc and runtime reality. |

## Implementation notes

- Wiring path: insert the engine between `recallMemories` candidate collection and the handler's JSON response in
  `memories/api.ts`, or have `recallMemories` itself invoke the shaping/gate phases. Keep `degraded` honest.
- De-scope path: prefer this if currentness is already approximated by ranking weights and the confidence gate has
  no product owner — cheaper and removes dead code.

## Open questions

- [ ] Is supersession-aware currentness already partially covered by the 008 ontology supersession on read, making
      the 007 shaping phase redundant?
- [ ] Does any consumer (dashboard recall center, MCP `memory_search`) actually want a confidence gate, or is raw
      ranked recall preferred?
