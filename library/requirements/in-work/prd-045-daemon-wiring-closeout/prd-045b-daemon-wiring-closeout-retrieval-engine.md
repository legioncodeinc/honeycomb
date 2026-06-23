# PRD-045b: Wire (or de-scope) the Retrieval shaping engine (closes PRD-007)

> **Status:** Resolved — DE-SCOPED (2026-06-22)
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

- [x] Is supersession-aware currentness already partially covered by the 008 ontology supersession on read, making
      the 007 shaping phase redundant? **YES — redundant.** See Decision D-1, evidence below.
- [x] Does any consumer (dashboard recall center, MCP `memory_search`) actually want a confidence gate, or is raw
      ranked recall preferred? **Raw ranked recall — no consumer wants the gate.** See Decision D-1, evidence below.

## Decisions

### D-1 (b-AC-1): DE-SCOPE the five-phase `RecallEngine`. — 2026-06-22, `retrieval-worker-bee`

**Decision.** De-scope and remove the dormant five-phase `RecallEngine` orchestrator and its four phase modules
(`engine.ts`, `traversal.ts`, `authorization.ts`, `shaping.ts`, `gate.ts`) plus their dedicated phase tests. Live
recall stays exactly as shipped: `recallMemories` (lexical UNION-ALL + semantic `<#>` RRF, honest `degraded`) at
`src/daemon/runtime/memories/recall.ts:565`, reached from `POST /api/memories/recall`
(`src/daemon/runtime/memories/api.ts:296`). PRD-027 RRF ranking and PRD-025 embeddings are untouched.

**Rationale (evidence, not preference).**

1. **Zero production callers.** `createRecallEngine` / `new RecallEngine` appeared only inside `recall/` and tests —
   never in a route or the composition root (`assemble.ts`). The only live importer of anything under `recall/` is
   the VFS browse seam `src/daemon/runtime/vfs/api.ts`, which imports **collection + config + contracts** (`collectCandidates`,
   `resolveRecallConfig`, `bestScore`, `RecallScope`) — never the engine or any phase.

2. **OQ-1 — currentness is redundant (two independent ways).**
   - The live recall arms (`recall.ts`) read only `memories` / `memory` / `sessions`. A superseded *memory* is already
     handled by the append-only version-bump + soft-delete model: `buildMemoriesArmSql` filters `is_deleted = 0`
     (`recall.ts:197`) and the read model resolves the highest version, dropping tombstones (`reads.ts:155-197`). A
     modified/forgotten memory's stale version never surfaces.
   - The removed shaping phase's currentness query (`buildSupersededClaimsSql`) read `entity_attributes` — the PRD-008
     *ontology claim* table, keyed by `group_key`+`claim_key` with `status='superseded'`. Supersession on that table
     is already resolved **on read** by PRD-008's highest-active-version model (`ontology/supersede.ts`,
     `buildHighestActiveVersionSql`): the superseded version is never the active row a reader resolves. Worse,
     `entity_attributes` is **not even one of the three tables live recall searches** — the phase operated on a
     different corpus than live recall, re-deriving a downweight for a signal the source-of-truth read model already
     resolves.

3. **OQ-2 — no consumer wants the confidence gate.** Every production recall surface routes to
   `POST /api/memories/recall` → `recallMemories` and consumes the `{ hits, sources, degraded }` shape, NOT the gate's
   `{ injected, hits[] }` inject/empty decision:
   - MCP `memory_search` and `hivemind_search` → `mcp/src/handlers.ts:171,265` (the tool doc states "the WIRED recall,
     NOT a new engine").
   - SDK `recall()` → `src/sdk/client.ts:281`.
   - Dashboard recall → `src/dashboard/web/wire.ts:44`.
   - CLI `recall` → `src/commands/storage-handlers.ts:37`.
   The gate's confidence-threshold model (`minInjectionScore` 0.6) was designed for an auto-injection
   `user-prompt-submit` hook that was never built. Raw ranked recall with the honest `degraded` flag is what every
   live surface wants.

**Scope of removal (b-AC-3).** Removed: `engine.ts`, `traversal.ts`, `authorization.ts`, `shaping.ts`, `gate.ts` and
the tests `engine.test.ts`, `traversal.test.ts`, `authorization.test.ts`, `shaping.test.ts`, `gate.test.ts`.
**Retained (live / still useful):** `collection.ts`, `config.ts`, `contracts.ts` (the VFS browse path), and
`scope-clause.ts` (`buildScopeClause`, the canonical scope-clause chokepoint, still asserted by the PRD-011a/011e
suites and the live `recall-authz-live.itest.ts`). `RecallLogger` was relocated from `engine.ts` into `contracts.ts`
(the live `collection.ts` needs it). `recall/index.ts` and `recall/CONVENTIONS.md` were pruned to the retained
surface. Three boundary tests (`scope-clause-policy.test.ts`, `tenancy-resolution.test.ts`,
`recall-authz-live.itest.ts`) that referenced the removed re-query builder were re-expressed against the retained
`buildScopeClause` (the security guarantee they prove is unchanged).

**Verification.** `npx tsc --noEmit` clean; `npx vitest run` green (2692 passed / 7 pre-existing skips, 0 failures);
the live authz itest collects + skips cleanly with no token (PRD-031 skip-safe). The `degraded` flag stays honest —
no recall behavior changed.
