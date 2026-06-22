# EXECUTION LEDGER — PRD-009 Dreaming Loop

> /the-smoker run. Branch `prd-009-dreaming-loop` off main (PRD-001..008 + CI merged). PR → main.

**Scope:** index + 009a (token-budget trigger + `dreaming_state`) / 009b (dreaming session runner + mutation apply) / 009c (compaction mode + `--compact` CLI). 17 ACs. Corrective maintenance pass: reasons over summaries vs the entity graph with a stronger model, proposes structural cleanup via the ontology control plane.
**Builds on:** PRD-004 `memory_jobs` queue + maintenance loop, PRD-008c ontology control plane (`submitProposal` — the mutation apply path; destructive → pending review), PRD-005/004 capture+session (dreaming runs as a captured session), PRD-006 ModelClient seam (router dreaming workload — stronger than extraction). New `dreaming_state` catalog table (additive). Live DeepLake wired.

## Verification posture
Vitest: fake transport (dreaming_state version-bump + counter), fake model (dreaming session output), fake queue, the real 008c apply path (fake transport). Opt-in LIVE: the dreaming_state counter increment+reset (append-only version-bump — the proven pattern; watch the reset-not-lose-concurrent-writes race). Out of scope: redefining the control plane (008c, consumed), rewriting raw artifacts, selecting the model (router/PRD-010).

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | counter scope | per (org, workspace, agent_id) (FR-1) |
| D-2 | thresholds | `tokenThreshold` 100k; `maxInputTokens` 128k. Configurable under `memory.dreaming` |
| D-3 | dreaming_state writes + reset | append-only version-bumped (highest-version read); reset = SUBTRACT threshold (not hard-zero) so concurrent post-enqueue writes accumulate (FR-5); `pending_job_id` guard prevents a 2nd enqueue (FR-6) |
| D-4 | first-run / compaction | `backfillOnFirstRun` true; compaction SAMPLES recent summaries to `maxInputTokens` |
| D-5 | model | router `dreaming` workload via ModelClient seam (fake in tests), stronger than extraction |
| D-6 | mutation apply | via 008c `submitProposal` (bounded → direct apply; destructive/broad → pending review); append-only; never rewrite raw |

## Scaffold/seam plan
Wave 1: `dreaming_state` catalog table + dreaming config + the dreaming-job/mutation contracts + 009a trigger (counter/tick/enqueue/reset) + the dreaming session-runner HARNESS (payload-strategy injected; apply-via-008c wiring). Pre-wire 009b/009c stubs. Wave 2 fills 009b (incremental runner) ‖ 009c (compaction mode + CLI).

---

## AC Ledger (17 ACs)

### 009a Trigger — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Session-summary write → `dreaming_state.tokens_since_last_pass` += summary token count. | VERIFIED (trigger.test.ts a-AC-1 + live a-AC-1/5) |
| a-AC-2 | Counter crosses threshold + tick → exactly one dreaming job queued, counter resets. | VERIFIED (trigger.test.ts a-AC-2 — reset SUBTRACTS, append-only; live FR-5 race) |
| a-AC-3 | Pass already pending → no 2nd job until prior reaches terminal state. | VERIFIED (trigger.test.ts a-AC-3) |
| a-AC-4 | `dreaming.enabled: false` → counter still grows, no job queued. | VERIFIED (trigger.test.ts a-AC-4) |
| a-AC-5 | Daemon restart → counter reflects all writes committed before restart (durable). | VERIFIED (trigger.test.ts a-AC-5 highest-version read + live) |
| a-AC-6 | Two agent_ids in a workspace → independent counters. | VERIFIED (trigger.test.ts a-AC-6) |

### 009b Session Runner — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Pass starts → loads identity files + new summaries since last pass + graph snapshot + DREAMING.md, captures a transcript. | VERIFIED |
| b-AC-2 | Mutation set applied → each op via the ontology control plane with provenance; destructive → pending review. | VERIFIED |
| b-AC-3 | Incremental pass → only post-`last_pass_at` summaries + changed entities/attrs loaded; graph query tool available. | VERIFIED |
| b-AC-4 | `merge_entities` → prior rows advanced in status on append-only path, remain on disk with lineage. | VERIFIED |
| b-AC-5 | Successful pass → `last_pass_at` updated, `pending_job_id` cleared. | VERIFIED |
| b-AC-6 | Model call → uses the dreaming workload's stronger target, not extraction. | VERIFIED |

### 009c Compaction Mode — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `backfillOnFirstRun` + no prior pass → first run enters compaction (full graph), not incremental. | VERIFIED (compaction.test.ts c-AC-1) |
| c-AC-2 | `honeycomb dream trigger --compact` → full-graph compaction queued regardless of counter. | VERIFIED (compaction.test.ts c-AC-2) |
| c-AC-3 | Large graph → recent summaries SAMPLED, input within `maxInputTokens`. | VERIFIED (compaction.test.ts c-AC-3) |
| c-AC-4 | Compaction completes → next pass returns to incremental against post-compaction `last_pass_at`. | VERIFIED (compaction.test.ts c-AC-4) |
| c-AC-5 | Compaction destructive mutations → via control plane → pending review like any pass. | VERIFIED (compaction.test.ts c-AC-5) |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 threshold → queue + reset | a-AC-1,2 | VERIFIED |
| AC-2 destructive mutation → control plane + pending review | b-AC-2 | VERIFIED |
| AC-3 `--compact` → full-graph pass | c-AC-1,2 | VERIFIED (compaction.test.ts c-AC-1/c-AC-2) |

**Totals:** 17 ACs · **17 VERIFIED** · 0 OPEN — fully VERIFIED, close-out unlocked.

## Wave plan
```
Wave 1 (009a + dreaming_state + runner harness + stubs) ──► Wave 2 (009b ‖ 009c) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `typescript-node-worker-bee` opus — dreaming_state catalog table, dreaming config, contracts, 009a trigger (counter/tick/enqueue/append-only-reset), the runner harness (payload-strategy + 008c apply wiring), 009b/009c stubs. + opt-in live counter test.
- Wave 2 · 2 parallel `typescript-node-worker-bee` — 009b session runner (opus, payload assembly + graph-query-tool + model routing + mutation apply + state update), 009c compaction mode + `honeycomb dream` CLI (sonnet).
- Wave 3 · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Security: scope on dreaming reads/writes (no cross-agent), destructive mutations can't bypass review, no raw-artifact rewrite, the counter can't be driven to DoS, model output (mutations) injection-guarded through 008c.

## Watchdog / event log
- PRD-009 moved→in-work, branched off main (PRD-001..008 + CI merged).
- Wave 2: 009b session runner (opus,15 — incremental payload + graph-query-tool + 008c apply + state update) + 009c compaction + honeycomb dream CLI (sonnet,25). Orchestrator verify: ci=0 (604 tests/50 files), build/audit:sql/audit:openclaw green; all b/c AC names present, live counter 2/2. b-AC + index VERIFIED. All 17 VERIFIED (mutation apply transitively live-covered via 008c). Wave 3 dispatched.
- security (opus): 0 Critical/High, no code changes. Injection guarded (incl. CLI builds no SQL), scope agent-bound on every read incl. graph-query tool + compaction, destructive→pending (can't bypass 008c review), counter reset floors at 0 (no underflow), prompt-injection contained by review queue. 3 Medium/Low documented (counter-wedge probe injected at daemon assembly, counter overflow clamp, audit:sql excludes CLI). ci=0 (604), build/audit green, npm audit 0, live counter 2/2. Report: reports/2026-06-17-security-report.md. quality dispatched.
- quality (sonnet): CLEAN TO SHIP — 17/17 ACs PASS (named tests), live counter 2/2, scope/append-only/destructive-pending confirmed, no Medium+ findings. 3 Suggestions (S-1 assembly TODO, S-2 PRD-019 identity note, S-3 latent double-sqlIdent on table name — harmless now). Report: reports/2026-06-17-qa-report.md. **RUN COMPLETE: 17/17 VERIFIED, shipped.**
