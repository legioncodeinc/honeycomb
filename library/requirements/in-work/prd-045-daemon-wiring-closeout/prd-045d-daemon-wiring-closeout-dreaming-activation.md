# PRD-045d: Dreaming-loop activation + end-to-end proof (closes PRD-009)

> **Status:** Draft
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-009 Dreaming Loop
> **Priority:** P1
> **Effort:** M

## Overview

The dreaming loop is **fully wired but dormant by default**: `buildGatedDreamingWorker` constructs the real trigger
+ model client + worker and `start()` runs it, but only when `HONEYCOMB_DREAMING_ENABLED` (or the vault
`dreaming.enabled` setting) is true. This is intentional (default-OFF = no surprise model spend), but its dormancy
currently **strands the only live consumers of PRD-008 control-plane apply and the PRD-010 model router**. So unlike
006/013/016/018, the gap here is not "never wired" — it is "wired, never proven end-to-end, and its default posture
needs an explicit decision."

## Evidence

- Worker built + started: `buildGatedDreamingWorker` (`assemble.ts:926`), `dreamingWorker?.start()` (`assemble.ts:1265-1266`),
  stopped in `shutdown()` (`:1283-1286`).
- Gate vault-first then env: `readVaultDreamingEnabled` (`assemble.ts:947`) → `resolveDreamingConfig` (`:948`);
  returns `null` (no worker) when disabled (`:954`).
- Trigger `POST /api/diagnostics/dream` is mounted unconditionally (`assemble.ts:648`) and enqueues a `dreaming`
  job — but with the worker off, the job sits unleased.
- The dreaming runner is the sole live caller of `submitProposal` (`dreaming/runner.ts:284`) and the 010 router
  (`assemble.ts:979`).

## Goals

- Make an explicit, recorded **default-posture decision** (stay OFF / opt-in via vault / on-by-default with budget
  guard) and document the operator path to enable.
- Prove the loop **end-to-end when enabled**: `POST /api/diagnostics/dream` (or the token-budget trigger) →
  worker leases the `dreaming` job → model reasons → ontology apply (008c) → append-only state update.
- Confirm the dreaming apply path and the 045a pipeline graph-persist path do not double-write the graph.

## Non-Goals

- Rebuilding the dreaming algorithm, trigger, or runner (all built).
- Forcing dreaming ON in CI (the live proof is token-gated, per PRD-031/034).

## User stories

- As an operator, I want a documented, single switch to enable dreaming and a way to confirm a pass actually ran.
- As a developer, I want a live itest that proves an enabled dreaming pass consolidates the graph.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | A recorded default-posture decision + the exact enable mechanism (env + vault) documented. |
| d-AC-2 | A token-gated live itest proves an enabled pass runs to completion (enqueue → lease → model → apply → state). |
| d-AC-3 | With dreaming OFF, `POST /api/diagnostics/dream` still acks cleanly (`{ triggered:false }` / queued), no crash. |
| d-AC-4 | Coordination check: dreaming apply + 045a graph-persist do not double-write the same edge. |

## Implementation notes

- No composition-root surgery expected — the wiring exists. The work is a live itest harness that flips the enable
  flag, drives a turn, triggers a pass, and asserts a graph mutation + state-counter advance, plus the
  decision/doc.
- Reuse the PRD-031 assembled-daemon harness; gate on the live token like the other `*.itest.ts`.

## Open questions

- [ ] Default posture: keep OFF (current), or on-by-default once a hard token-budget cap exists?
- [ ] Should the pipeline (045a) be the primary graph writer and dreaming a periodic consolidator, to avoid overlap?
