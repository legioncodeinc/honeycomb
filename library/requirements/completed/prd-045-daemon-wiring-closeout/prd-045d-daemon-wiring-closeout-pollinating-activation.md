# PRD-045d: Pollinating-loop activation + end-to-end proof (closes PRD-009)

> **Status:** Completed
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-009 Pollinating Loop
> **Priority:** P1
> **Effort:** M

## Overview

The pollinating loop is **fully wired but dormant by default**: `buildGatedPollinatingWorker` constructs the real trigger
+ model client + worker and `start()` runs it, but only when `HONEYCOMB_POLLINATING_ENABLED` (or the vault
`pollinating.enabled` setting) is true. This is intentional (default-OFF = no surprise model spend), but its dormancy
currently **strands the only live consumers of PRD-008 control-plane apply and the PRD-010 model router**. So unlike
006/013/016/018, the gap here is not "never wired" — it is "wired, never proven end-to-end, and its default posture
needs an explicit decision."

## Evidence

- Worker built + started: `buildGatedPollinatingWorker` (`assemble.ts:926`), `pollinatingWorker?.start()` (`assemble.ts:1265-1266`),
  stopped in `shutdown()` (`:1283-1286`).
- Gate vault-first then env: `readVaultPollinatingEnabled` (`assemble.ts:947`) → `resolvePollinatingConfig` (`:948`);
  returns `null` (no worker) when disabled (`:954`).
- Trigger `POST /api/diagnostics/pollinate` is mounted unconditionally (`assemble.ts:648`) and enqueues a `pollinating`
  job — but with the worker off, the job sits unleased.
- The pollinating runner is the sole live caller of `submitProposal` (`pollinating/runner.ts:284`) and the 010 router
  (`assemble.ts:979`).

## Goals

- Make an explicit, recorded **default-posture decision** (stay OFF / opt-in via vault / on-by-default with budget
  guard) and document the operator path to enable.
- Prove the loop **end-to-end when enabled**: `POST /api/diagnostics/pollinate` (or the token-budget trigger) →
  worker leases the `pollinating` job → model reasons → ontology apply (008c) → append-only state update.
- Confirm the pollinating apply path and the 045a pipeline graph-persist path do not double-write the graph.

## Non-Goals

- Rebuilding the pollinating algorithm, trigger, or runner (all built).
- Forcing pollinating ON in CI (the live proof is token-gated, per PRD-031/034).

## User stories

- As an operator, I want a documented, single switch to enable pollinating and a way to confirm a pass actually ran.
- As a developer, I want a live itest that proves an enabled pollinating pass consolidates the graph.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | A recorded default-posture decision + the exact enable mechanism (env + vault) documented. |
| d-AC-2 | A token-gated live itest proves an enabled pass runs to completion (enqueue → lease → model → apply → state). |
| d-AC-3 | With pollinating OFF, `POST /api/diagnostics/pollinate` still acks cleanly (`{ triggered:false }` / queued), no crash. |
| d-AC-4 | Coordination check: pollinating apply + 045a graph-persist do not double-write the same edge. |

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

**Decision.** Pollinating ships **default-OFF** and is **opt-in**. This is kept as the intentional
posture, not changed. The evidence:

- **No surprise model spend.** The pollinating pass calls the inference `memory_pollinating` workload
  against the operator's configured provider (Anthropic by default). An on-by-default loop would
  bill the operator for consolidation passes they never asked for. Default-OFF means a fresh
  install incurs **zero** model cost until the operator explicitly enables it. The config module
  encodes this as the false-safe default: `PollinatingConfigSchema.enabled` defaults `false`
  (`src/daemon/runtime/pollinating/config.ts:63`), and `buildGatedPollinatingWorker` constructs **none**
  of the heavy bits (model client, trigger, worker) when disabled
  (`src/daemon/runtime/assemble.ts:1181-1183`).
- **No hard token-budget cap exists yet.** On-by-default was contingent (parent open question) on a
  hard per-period spend cap. That cap is **not** built, so on-by-default would be unbounded spend —
  reason enough to keep OFF.
- **The pipeline already writes the graph live.** Since 045a/045c, the capture→pipeline path
  (`memory_extraction → … → memory_graph_persist`) and the inline ontology linker write the graph
  on **every captured turn**, live and free (no model premium beyond extraction). So the graph is
  **not** starved while pollinating is off — pollinating is a *periodic consolidator/compactor on top*,
  not the primary writer. This resolves the parent's second open question: **the pipeline (045a) is
  the primary graph writer; pollinating is the opt-in periodic consolidator.**

**Revisit when:** a hard token-budget cap (per-day / per-org spend ceiling with a kill-switch) is
implemented. Until then, OFF + opt-in is the safe, recorded posture.

### D-045d-2 — The exact enable mechanism (env + vault). (d-AC-1)

Two equivalent operator switches; **vault wins when present** (the documented precedence,
`readVaultPollinatingEnabled` → `effectiveEnabled` at `src/daemon/runtime/assemble.ts:1174-1175`):

1. **Env var (process-level):**
   ```sh
   HONEYCOMB_POLLINATING_ENABLED=true        # or "1" — anything else is OFF
   ```
   Read by `envPollinatingConfigProvider` (`src/daemon/runtime/pollinating/config.ts:114-125`) →
   `resolvePollinatingConfig`. Restart the daemon for it to take effect (the gate is read once at
   `start()`).

2. **Vault setting (persisted, survives restart, set from the CLI/dashboard):**
   ```
   setting key:  pollinating.enabled = true
   ```
   The key constant is `VAULT_POLLINATING_ENABLED_KEY` (`assemble.ts:1029`); it is written via
   `POST /api/settings` (the CLI `settings` surface / the dashboard toggle) and read vault-first at
   assembly. A vault `true` enables pollinating **without** the env var; a vault `false` disables it
   **even when the env says true** (vault-first precedence).

For either switch, the inference key must be resolvable: an `inference:` block in `agent.yaml` plus
the provider key stored under the daemon's scope (e.g. `${ANTHROPIC_API_KEY}` in `.secrets/`). With
the switch ON but no key, the worker still runs but uses the no-op model client and produces
zero-mutation passes (boots clean, never crashes — `buildInferenceModelClient` never throws,
`assemble.ts:1197-1211`).

### D-045d-3 — How to confirm a pass actually ran. (d-AC-1)

- **Trigger one now (does not require the threshold):**
  ```sh
  honeycomb pollinate trigger            # POST /api/diagnostics/pollinate
  honeycomb pollinate trigger --compact  # full-graph compaction pass
  ```
  The ack tells you the state: `{triggered:true,status:"enqueued"}` (a pass was queued),
  `{triggered:true,status:"running"}` (one already pending / below threshold), or
  `{triggered:false,status:"skipped",reason:"disabled"}` (the master switch is OFF).
- **Confirm the pass completed:** the worker logs `pollinating.worker.completed` and the runner stamps
  the append-only `pollinating_state` counter — `last_pass_at` advances and `pending_job_id` is cleared
  (`recordPassComplete`, runner `finalize` at `runner.ts:305-313`). A graph mutation lands as an
  `ontology_proposals` row (`applied` for a bounded op, `pending` for a destructive merge/archive)
  plus the resulting `entity_attributes`/`entities` rows.
- **Discoverability:** this switch + confirmation procedure is the operator runbook for pollinating;
  it lives here in the PRD Decisions and is mirrored by the `honeycomb pollinate` CLI help text
  (`src/commands/pollinate.ts`).

## Open questions (resolved)

- [x] Default posture: **keep OFF + opt-in** (D-045d-1) — on-by-default deferred until a hard
  token-budget cap exists.
- [x] Pipeline vs pollinating as primary graph writer: **the 045a pipeline is the primary live writer;
  pollinating is the opt-in periodic consolidator** (D-045d-1). They do **not** double-write the same
  edge — the deterministic-id + presence-probe idempotency (045c) makes both apply paths converge to
  one row, proven by `tests/integration/pollinating-coordination-nodoublewrite.itest.ts` (d-AC-4).
