# Execution Ledger — PRD-062 DeepLake Compute Cost Reduction

> **Run:** the-smoker · branch `legion/hungry-ride-71865f` · started 2026-06-26
> **Source PRD:** [`library/requirements/in-work/prd-062-deeplake-compute-cost-reduction/`](../requirements/in-work/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md)
> **Gate:** `npm run ci` = typecheck + jscpd dup + vitest + audit:sql. A criterion is DONE only when its tests pass and the full gate is green.
> **Status legend:** OPEN · IN PROGRESS · DONE (implemented+tested) · VERIFIED (independent pass) · BLOCKED

## Default rulings adopted (open questions resolved for autonomous execution)

PRD open questions resolved to the PRD's stated defaults for this run. Product-level calls flagged for Mario at the end (non-blocking).

| # | Question | Ruling adopted |
|---|---|---|
| R1 | Idle backoff curve | Floor 1000ms, exponential ×2, ceiling **30s**, +jitter, reset-to-floor on any lease. |
| R2 | Single-poller consolidation | Both workers share **one combined lease pass** per tick over the union of pipeline+pollinating kinds; preserve kind isolation. Flag-guarded. |
| R3 | `DISCOVERY_SCAN_POLLS` reduction | **Not reduced** this run (correctness-first; AC-10 must not regress). |
| R4 | Telemetry persistence | **Log + in-memory counters only** (no `telemetry_counters` write). |
| R5 | Capture flush window | Flush every **1s** or **25 events**; force-flush on shutdown. In-memory buffer; worst-case loss = one window (documented). |
| R6 | Envelope byte budget | Cap tool input/response at **16 KB** each with `…[truncated N bytes]` marker. |
| R7 | Recall/grader semaphore | Shared bounded pool, max **6** in-flight DeepLake queries. |
| R8 | Fan-out coalescing | Batch **enqueue** side; controlled **writes** stay per-fact (append/version-bump preserved). |
| R9 | Flag defaults | Cost fixes **default-ON**; AC-9 parity tests set flags OFF to reproduce pre-PRD behavior. |
| R10 | Release sequencing / broker migration | Product calls; surfaced to Mario at end. Not blocking. |

## AC Ledger

| ID | Source | Criterion (abbrev) | Owner Bee | Wave | Status |
|---|---|---|---|---|---|
| L-A1 | 062a AC-1 / AC-62a.1 | Per-source DeepLake query meter; zero added queries in default mode | typescript-node-worker-bee | 1 | DONE |
| L-A2 | 062a AC-62a.2 | Idle-baseline harness + before/after report scaffold | typescript-node-worker-bee | 1 | DONE |
| L-B1 | 062b AC-2 / AC-62b.1 | Adaptive backoff (floor→30s, reset-on-job); idle ≤1 pass/30s | typescript-node-worker-bee | 2 | DONE |
| L-B2 | 062b AC-3 / AC-62b.2 | Lease resets interval to floor; active latency preserved | typescript-node-worker-bee | 2 | DONE |
| L-B3 | 062b AC-4 / AC-62b.3 | Single combined lease pass; kind isolation kept | typescript-node-worker-bee | 2 | DONE |
| L-B4 | 062b AC-10 | Lease single-winner + reaper reclaim intact | typescript-node-worker-bee | 2 | DONE |
| L-C1 | 062c AC-5 / AC-62c.1 | Batched multi-row capture append; forced flush on shutdown | typescript-node-worker-bee | 3 | DONE |
| L-C2 | 062c AC-6 / AC-62c.2 | Envelope trim (16KB+marker); field parity | typescript-node-worker-bee | 3 | DONE* |
| L-D1 | 062d AC-7 / AC-62d.1 | Fan-out enqueue coalescing; version-bump preserved | retrieval-worker-bee | 3 | DONE |
| L-D2 | 062d AC-7 / AC-62d.2 | Recall arms + grader under bounded semaphore (6); result parity | retrieval-worker-bee | 3 | DONE |
| L-X1 | 062 AC-9 | Every change env-flagged; flags-off reproduces pre-PRD behavior | each owner | 2-3 | DONE |

> *L-C2 note: envelope-size win delivered via tool-I/O capping (16 KB + marker). The AC-6.2.2 "invariant metadata not repeated per row" sub-point was **PRD-gated-declined** — the consumer audit found `metadata.sessionId` is read from the envelope by the skillify miner (no column carries it), so lifting it would be a silent capability cut, which the PRD's own gating rule forbids. Flagged for quality-worker-bee adjudication; full per-row metadata dedup would need an additive `session_id` column (follow-up, non-blocking).
| L-X2 | 062 AC-8 | No memory-quality regression (in-suite parity VERIFIED; live eval:recall deferred to rollout) | quality close-out | 4 | DEFERRED-live |
| L-S1 | close-out | security-worker-bee: zero Critical/High; SQL/PII/tenant-isolation cleared | security-worker-bee | 4 | VERIFIED |
| L-Q1 | close-out | quality-worker-bee: implementation matches PRD-062 (PASS, ready to merge) | quality-worker-bee | 4 | VERIFIED |

> **Close-out result:** L-A1..L-X1 flipped DONE→**VERIFIED** by the security + quality close-out (zero Critical/High; quality PASS, every AC traced to code+tests). L-C2 deviation ruled an acceptable PRD-gated call. L-X2 in-suite parity VERIFIED (width-1 vs width-100 identical); the live `eval:recall` is creds-gated and deferred to rollout (SKIPs-with-reason, never a silent pass). Post-QA fix: removed a stray NUL-byte map-key separator in capture-handler.ts (replaced with a collision-free JSON key); typecheck + 70 capture tests green.

## Wave plan

- **Wave 1 (solo, foundational):** L-A1, L-A2 — query meter at the storage choke point + idle-baseline harness. Solo because the meter touches the shared DeepLake call site. Model: inherit Opus.
- **Wave 2 (queue/poll, in-tree):** L-B1..L-B4, L-X1 — backoff + consolidation in `stage-worker.ts` / `pollinating/worker.ts` / `job-queue.ts`. Append-only convergence care. Model: Opus.
- **Wave 3 (disjoint-file):** 062c (capture files) + 062d (pipeline+recall files) as two Bees; disjoint file sets, shared config edits sequenced. Models: Opus.
- **Wave 4 (close-out):** security-worker-bee → quality-worker-bee → eval:recall parity. Never quality before security.

**Parallelism note:** single integrated worktree, so overlapping-file work is sequenced to guarantee one clean branch.

## Watchdog / termination log

- No stalls/terminations.
- **Flake investigation (Wave 3 verify) — ATTRIBUTION SETTLED:** full-suite runs surfaced a *different* timeout-fragile test each time (`json-parsers.property`, `secrets/exec`, `hooks/runtime`). Pre-existing CPU-contention flakiness, NOT a PRD-062 regression. Evidence: (1) all pass in isolation; (2) `src/hooks/runtime.ts` imports **none** of the PRD-062-changed modules (import grep) so our code never runs in that test's process; (3) **decisive base comparison** — with ALL our changes stashed, the base full suite flaked the SAME tests *worse*: **8 failed (7 hook-runtime subtests + json-parsers) vs our 2**; the fragility is the repo's, our branch is no worse than base; (4) a clean low-load full run was 3736/0. One-retry rule applies in CI. Hardening added: `unref()` on the new poll-loop + lease-coordinator timers (mirrors capture-buffer).

## Blockers

_(none yet)_

## Verification log

- **Wave 1 (062a) — DONE.** query-meter.ts at the client.ts choke point (optional `source`, defaults `other`, in-memory counts, log-only). Integrated `npm run typecheck` clean; 256 storage tests pass incl. 12 new + pure-passthrough parity; jscpd 0% on new files. Source labels for lease/reaper/capture/recall deferred to their owning waves (count as `other` until then). Awaiting close-out VERIFIED.
- **Wave 3 (062c + 062d) — DONE.** 062c: capture-buffer.ts (1s/25-event flush, unref'd timer, shutdown-drain wired in assemble.ts), budgeted-stringify.ts (16 KB tool-I/O cap + marker), appendOnlyInsertMany multi-row append, `source: 'capture-write'`. 062d: bounded-pool.ts Semaphore (leak-safe run, no nesting), recall arms + grader behind a shared max-6 pool (parity proven width-1 vs width-100 identical), fan-out enqueue coalesced to one batched job (per-fact append/version-bump preserved, 3 facts → 3 INSERTs / 0 UPDATEs). Flags default-ON with flags-off parity tests. Integrated gate clean: typecheck ✓, jscpd 0.56% < 7 ✓, audit:sql OK ✓, **full vitest 3736 passed / 0 fail (clean run)** ✓. Awaiting close-out VERIFIED.
- **Wave 2 (062b) — DONE.** poll-backoff.ts (floor 1000 / ceiling 30000 / jitter 0.1, reset-on-lease) + poll-loop.ts runner + lease-coordinator.ts (one combined `lease(union-kinds)` per tick, kind isolation preserved, unrouted kind fail()ed). Threaded `poll-lease`/`poll-reaper` source labels into job-queue.ts reads. Flags default-ON: `HONEYCOMB_POLL_BACKOFF_ENABLED/_FLOOR_MS/_CEILING_MS/_JITTER`, `HONEYCOMB_POLL_CONSOLIDATE`; flags-off parity test green (AC-9). `DISCOVER_POLLS/RESOLVE_POLLS=8` + version-DESC convergence untouched (AC-10). Integrated typecheck clean; 96 service tests + 31 new 062b tests pass; property-test flake retried green in isolation; jscpd 0.57% < 7. Awaiting close-out VERIFIED.
