# PRD-045f: Wire the Skillify mining worker (closes PRD-016)

> **Status:** Completed
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-016 Skillify
> **Priority:** P1
> **Effort:** M

## Overview

PRD-016 shipped the skillify miner (the Haiku KEEP/MERGE/SKIP gate → append-only `skills` writes) and the enqueue
points, but **no worker leases `["skillify"]` jobs**, so mined jobs are never processed and the `skills` table is
never populated by mining. The `skillify pull` CLI verb is also unregistered. The `/api/skills` read endpoint and
the catalog are live, but with no producer there is nothing to read or propagate (this also blocks 045g).

## Evidence of the gap

- Skillify jobs ARE enqueued at runtime: session-end (`src/hooks/shared/session-end.ts:112`) and turn-counter
  (`capture/turn-counters.ts:150` → `capture-handler.ts:262-274`).
- But no worker leases them: `assemble.ts` starts only the pollinating worker, which leases `["pollinating"]` only
  (`pollinating/worker.ts:212-214`). No skillify worker is constructed.
- CLI `skillify pull` is implemented (`src/cli/skillify.ts`) but **not registered** in the verb table
  (`src/cli/skillify.ts:19` self-notes the dispatch wiring is deferred).
- LIVE today: `/api/skills` read (`product/api.ts:180-195`).

## Goals

- Construct + start a **skillify worker** in `assembleDaemon` that leases `["skillify"]` and runs the miner
  (KEEP/MERGE/SKIP → append-only `skills` write).
- Register the `skillify pull` CLI verb in the dispatch table so it is reachable.
- Confirm/repair the **session-start auto-pull seam** (see Open questions — investigators diverged on whether it is
  a no-op).

## Non-Goals

- Rebuilding the miner or the Haiku gate (built).
- Team propagation / publish — that is 045g (which depends on this).
- New schema — the `skills` table exists.

## User stories

- As a user, when a session ends, I want a worthwhile skill mined and written so it shows up in `/api/skills`.
- As a user, I want `honeycomb skillify pull` to actually run.

## Acceptance criteria

| ID | Criterion |
|---|---|
| f-AC-1 | `assembleDaemon` constructs + starts a worker leasing `["skillify"]`; cite the `assemble.ts` line. |
| f-AC-2 | A live itest proves: a session-end enqueue → the worker mines → an append-only `skills` row lands and is readable via `/api/skills`. |
| f-AC-3 | The `skillify pull` CLI verb is registered and dispatches (cite the verb-table entry). |
| f-AC-4 | Fail-soft: a miner/model error fails the job, never crashes the daemon or the capture path. |

## Implementation notes

- Mirror the pollinating worker lifecycle (build in `assembleDaemon`, start after `startServices()`, stop in
  `shutdown()`), leasing `["skillify"]`. Reuse `daemon.services.queue`.
- The miner already exists (`skillify/miner.ts`, `skillify/skills-write.ts`); the worker is a thin lease→mine→write
  loop.

## Open questions

- [ ] **Auto-pull discrepancy to resolve here:** one audit read the session-start auto-pull seam as live
      (`src/hooks/shared/session-start.ts:72`), the other found `src/hooks/runtime.ts:198` builds
      `SessionStartDeps` with **no `seams`**, making `seams.autoPullSkills` resolve to the no-op default. Confirm
      directly; if no-op, wire the real seam (overlaps 045g).
- [ ] Single skillify worker, or fold skillify + pipeline (045a) into one multi-kind worker?
