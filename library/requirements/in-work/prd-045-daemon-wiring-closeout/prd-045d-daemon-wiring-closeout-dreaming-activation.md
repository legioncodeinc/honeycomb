# PRD-045d: Dreaming-loop activation + end-to-end proof (closes PRD-009)

> **Status:** Completed
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

## Decisions (recorded — d-AC-1)

> Status of this PRD: **Completed** (045d). All four ACs proven; see `reports/`-equivalent
> evidence inline below and the tests cited per AC. The decisions here are the recorded
> close-out, not a deferral.

### D-045d-1 — Default posture: stay **OFF**, opt-in (env OR vault). (d-AC-1)

**Decision.** Dreaming ships **default-OFF** and is **opt-in**. This is kept as the intentional
posture, not changed. The evidence:

- **No surprise model spend.** The dreaming pass calls the inference `memory_dreaming` workload
  against the operator's configured provider (Anthropic by default). An on-by-default loop would
  bill the operator for consolidation passes they never asked for. Default-OFF means a fresh
  install incurs **zero** model cost until the operator explicitly enables it. The config module
  encodes this as the false-safe default: `DreamingConfigSchema.enabled` defaults `false`
  (`src/daemon/runtime/dreaming/config.ts:63`), and `buildGatedDreamingWorker` constructs **none**
  of the heavy bits (model client, trigger, worker) when disabled
  (`src/daemon/runtime/assemble.ts:1181-1183`).
- **No hard token-budget cap exists yet.** On-by-default was contingent (parent open question) on a
  hard per-period spend cap. That cap is **not** built, so on-by-default would be unbounded spend —
  reason enough to keep OFF.
- **The pipeline already writes the graph live.** Since 045a/045c, the capture→pipeline path
  (`memory_extraction → … → memory_graph_persist`) and the inline ontology linker write the graph
  on **every captured turn**, live and free (no model premium beyond extraction). So the graph is
  **not** starved while dreaming is off — dreaming is a *periodic consolidator/compactor on top*,
  not the primary writer. This resolves the parent's second open question: **the pipeline (045a) is
  the primary graph writer; dreaming is the opt-in periodic consolidator.**

**Revisit when:** a hard token-budget cap (per-day / per-org spend ceiling with a kill-switch) is
implemented. Until then, OFF + opt-in is the safe, recorded posture.

### D-045d-2 — The exact enable mechanism (env + vault). (d-AC-1)

Two equivalent operator switches; **vault wins when present** (the documented precedence,
`readVaultDreamingEnabled` → `effectiveEnabled` at `src/daemon/runtime/assemble.ts:1174-1175`):

1. **Env var (process-level):**
   ```sh
   HONEYCOMB_DREAMING_ENABLED=true        # or "1" — anything else is OFF
   ```
   Read by `envDreamingConfigProvider` (`src/daemon/runtime/dreaming/config.ts:114-125`) →
   `resolveDreamingConfig`. Restart the daemon for it to take effect (the gate is read once at
   `start()`).

2. **Vault setting (persisted, survives restart, set from the CLI/dashboard):**
   ```
   setting key:  dreaming.enabled = true
   ```
   The key constant is `VAULT_DREAMING_ENABLED_KEY` (`assemble.ts:1029`); it is written via
   `POST /api/settings` (the CLI `settings` surface / the dashboard toggle) and read vault-first at
   assembly. A vault `true` enables dreaming **without** the env var; a vault `false` disables it
   **even when the env says true** (vault-first precedence).

For either switch, the inference key must be resolvable: an `inference:` block in `agent.yaml` plus
the provider key stored under the daemon's scope (e.g. `${ANTHROPIC_API_KEY}` in `.secrets/`). With
the switch ON but no key, the worker still runs but uses the no-op model client and produces
zero-mutation passes (boots clean, never crashes — `buildInferenceModelClient` never throws,
`assemble.ts:1197-1211`).

### D-045d-3 — How to confirm a pass actually ran. (d-AC-1)

- **Trigger one now (does not require the threshold):**
  ```sh
  honeycomb dream trigger            # POST /api/diagnostics/dream
  honeycomb dream trigger --compact  # full-graph compaction pass
  ```
  The ack tells you the state: `{triggered:true,status:"enqueued"}` (a pass was queued),
  `{triggered:true,status:"running"}` (one already pending / below threshold), or
  `{triggered:false,status:"skipped",reason:"disabled"}` (the master switch is OFF).
- **Confirm the pass completed:** the worker logs `dreaming.worker.completed` and the runner stamps
  the append-only `dreaming_state` counter — `last_pass_at` advances and `pending_job_id` is cleared
  (`recordPassComplete`, runner `finalize` at `runner.ts:305-313`). A graph mutation lands as an
  `ontology_proposals` row (`applied` for a bounded op, `pending` for a destructive merge/archive)
  plus the resulting `entity_attributes`/`entities` rows.
- **Discoverability:** this switch + confirmation procedure is the operator runbook for dreaming;
  it lives here in the PRD Decisions and is mirrored by the `honeycomb dream` CLI help text
  (`src/commands/dream.ts`).

## Open questions (resolved)

- [x] Default posture: **keep OFF + opt-in** (D-045d-1) — on-by-default deferred until a hard
  token-budget cap exists.
- [x] Pipeline vs dreaming as primary graph writer: **the 045a pipeline is the primary live writer;
  dreaming is the opt-in periodic consolidator** (D-045d-1). They do **not** double-write the same
  edge — the deterministic-id + presence-probe idempotency (045c) makes both apply paths converge to
  one row, proven by `tests/integration/dreaming-coordination-nodoublewrite.itest.ts` (d-AC-4).
