# PRD-045c: Wire the Ontology linker + `/api/ontology` surface (closes PRD-008)

> **Status:** Completed
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-008 Knowledge Graph and Ontology
> **Priority:** P1
> **Effort:** M

## Overview

PRD-008 shipped the entity model + inline linker (008a), dependency edges + append-only supersession (008b), and the
control-plane apply/proposals/assertions (008c). Two of its claimed deliverables are not live: the **inline entity
linker is never invoked**, and there is **no `/api/ontology/*` HTTP mount**. The control-plane apply runs only via the
pollinating runner — which is dormant by default (see 045d). So the knowledge graph is barely populated on real runs.

## Evidence of the gap

- `inlineLinkMemory` is exported with **zero callers** (`ontology/entity-model.ts:506`) — nothing in capture or the
  pipeline invokes it (AC-1 unreachable).
- No `mountOntologyApi` exists and none is fired in `assemble.ts`; the `/api/ontology` group is only a `protect:true`
  scaffold (`server.ts:96`) → falls through to 501.
- Apply/supersession are reachable only through the pollinating runner: `submitProposal` (`pollinating/runner.ts:284`),
  `supersedeClaim` (`ontology/control-plane.ts:338`) — dormant when pollinating is OFF.

## Goals

- Invoke `inlineLinkMemory` on a live path — the memory-pipeline graph-persist stage (045a) and/or capture — so
  entities are linked as memories land.
- Build + fire `mountOntologyApi` for `/api/ontology/*` (read entities/edges/assertions; reason-gated mutations),
  plus the matching CLI verbs PRD-008 promised.
- Ensure the control-plane apply runs on a live path independent of pollinating (via the pipeline graph-persist stage),
  with pollinating as an additional consolidation consumer.

## Non-Goals

- Re-deriving the entity model or supersession algorithm (built; this wires them).
- New schema — the knowledge-graph tables exist (PRD-003).

## User stories

- As a user browsing `/api/ontology`, I want to see the entities and edges extracted from my memories.
- As a developer, I want entity linking to happen as memories are written, not only during a pollinating pass.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | `inlineLinkMemory` is invoked on a live write path; cite the call site (pipeline graph-persist and/or capture). |
| c-AC-2 | `mountOntologyApi` is fired in `assemble.ts` (cite the line); `/api/ontology/*` returns real data (no 501). |
| c-AC-3 | A live itest proves: a captured/processed memory yields a linked entity readable via `/api/ontology`. |
| c-AC-4 | Append-only supersession applies on a live path; a superseded claim is observably tombstoned (not deleted). |
| c-AC-5 | Fail-soft mount + invocation (a mount/link error never crashes the daemon). |

## Implementation notes

- Sequence after 045a: the pipeline's graph-persist stage is the natural home for `inlineLinkMemory` + the
  control-plane apply, giving a live apply path that does not depend on the pollinating gate.
- Mount `/api/ontology` onto the existing `protect:true` group (no `server.ts` edit needed), mirroring the
  `/api/graph` and data-API mounts; fail-soft try/catch like the other seams.

## Open questions

- [ ] Linker on capture (synchronous, cheap) vs in the pipeline graph-persist stage (async, richer)? Prefer the
      pipeline to keep the turn path fast.
- [ ] Does `/api/ontology` need write routes now, or read-only first with mutations via the pipeline/pollinating apply?
