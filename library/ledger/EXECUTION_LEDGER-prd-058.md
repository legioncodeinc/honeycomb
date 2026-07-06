# Execution Ledger — PRD-058 Memory Lifecycle (058a-058e)

> **Run:** the-smoker · branch `prd-058-memory-lifecycle-completion` · worktree `C:\Users\mario\GitHub\honeycomb-prd-058\`
> **Source PRD:** [`library/requirements/in-work/prd-058-memory-lifecycle/`](../requirements/in-work/prd-058-memory-lifecycle/prd-058-memory-lifecycle-index.md)
> **Model:** GLM 5.2 for every Bee (per Mario's directive — model matrix ignored)
> **Gate:** `npm run ci` = typecheck + jscpd + vitest + audit:sql. A criterion is DONE only when fully implemented, wired into a production path (not just defined+tested), and the gate is green.
> **Status legend:** OPEN · IN PROGRESS · DONE · VERIFIED · BLOCKED

## Recon finding (grounded in code, not PRD status)

The user warned that PRD status fields are inaccurate. Recon confirms: **the math/logic layer of all five sub-PRDs is shipped and 151 tests pass.** What's missing is **wiring** — four production seams in `assemble.ts` that are never constructed, plus a few genuinely missing pieces. The diagnosis matches the live-DB symptom: every `memories` row has `importance=0.5`, `access_count=0`, `last_reinforced_at=1970-01-01`, `ref_status=NULL`, because the writers are inert.

## Ground-truth AC classifications

- **058a (recency activation):** ALL 9 ACs SHIPPED. `applyRecencyActivation` is wired into the production ranker at `recall.ts:2305`.
- **058b (conflict resolution):** 14 of 15 ACs SHIPPED. The conflict hook (`conflict-hook.ts`) IS wired into the production write path (`assemble.ts:2079` → `controlled-writes.ts:515,622`). The κ gate IS wired into recall (`recall.ts:2326`). ONE AC is DEFINED-NOT-WIRED: **AC-55b.2.4 (keep-both memoization)**.
- **058c (stale-reference healing):** Logic is SHIPPED but reachable only via manual HTTP trigger (`POST /api/diagnostics/stale-refs`). The σ ranker multiplier is DEFINED-NOT-WIRED (`stalenessSource` never supplied to recall). The reverify scheduler is MISSING (no production caller for `reverify-schedule.ts`).
- **058d (surfaces + controls):** CLI parity SHIPPED (`honeycomb memory conflicts/resolve/stale-refs/inspect --lifecycle`). History audit SHIPPED. Config resolver DEFINED-NOT-WIRED. Dashboard lifecycle/health panel MISSING. Settings-page flag reference MISSING.
- **058e (reinforcement + calibration):** Math SHIPPED. **Everything else DEFINED-NOT-WIRED or MISSING.** `recordAccess`/`maintainMemoryCache` have zero production callers → `access_count`/`last_reinforced_at` never advance. `activationSource` never injected → ACT-R Stage-2 never runs. `calibration` never injected → `C(m)` never applied. No compaction loop, no refit worker, no reverify scheduler.

## AC Ledger (consolidated, by work item)

| ID | Source | Work item (what's actually missing) | Owner Bee | Wave | Status |
|---|---|---|---|---|---|
| **L-W1** | 058e.1.x | Wire `recordRecallAccess` into production recall: every recall hit calls `recordAccess` → bumps `access_count` + advances `last_reinforced_at`. Thread the dep through `MountMemoriesOptions` → `api.ts:545` → `recall.ts:2346`. | retrieval-worker-bee | 1 | OPEN |
| **L-W2** | 058e.1.x | Wire `activationSource` into `assemble.ts:1135-1148` so ACT-R Stage-2 activation runs instead of the Stage-1 fallback. `MemoryRecallHit.accessCount` gets populated. | retrieval-worker-bee | 1 | OPEN |
| **L-W3** | 058e.2.x | Wire `calibration` into `assemble.ts` so `applyCalibrationStage` runs. Construct the calibration model from `calibration-store.ts` and inject it. | retrieval-worker-bee | 1 | OPEN |
| **L-W4** | 058c.2.x | Wire `stalenessSource` into `assemble.ts:1135-1148` so the σ multiplier runs in the ranker. The math at `recall.ts:1660` already works; it just needs the dep supplied. | retrieval-worker-bee | 1 | OPEN |
| **L-W5** | 058d.1.x | Wire `resolveLifecycleConfig`/`resolveLifecycleConfigLayered` into production: read at boot (or per-request), thread `a`/`c`/`s`/`posture`/`auto-resolve` into the recall + conflict deps. | retrieval-worker-bee | 1 | OPEN |
| **L-W6** | 058b.2.4 | Ship a production `KeepBothMemoStore` (in-process Map, same shape as the test fake) and wire it into both `createControlledWriteConflictHook` and `mountConflictsApi` at `assemble.ts`. | typescript-node-worker-bee | 2 | OPEN |
| **L-W7** | 058c.3.x / 058e.3.x | Ship the reverify scheduler: a periodic maintenance worker (on the local job queue, same pattern as compaction) that calls `reverify-schedule.ts`'s `isDueForReverify` over memories and POSTs to the stale-ref trigger when due. | typescript-node-worker-bee | 2 | OPEN |
| **L-W8** | 058e.2.x | Ship the access-log compaction loop: a periodic worker that calls `compactAccessLog` to fold raw `memory_access` events into `access_count` + advance the watermark. Idempotent (the `(at, id)` cursor makes it so). | typescript-node-worker-bee | 2 | OPEN |
| **L-W9** | 058e.2.x | Ship the calibration refit worker: a periodic job that reads resolved outcomes from `memory_conflicts`, calls `fitIsotonic` + `shouldAdoptRefit`, writes the adopted curve to `memory_calibration`. | typescript-node-worker-bee | 2 | OPEN |
| **L-W10** | 058d.2.x | Ship the dashboard lifecycle/health panel: a new view in `src/dashboard/views.ts` rendering `H=A·C·(1−σ)·κ`, freshness, open-conflict count, stale-ref count, calibration ECE. Consumes the already-shipped `GET /api/memories/calibration` + `GET /api/memories/history?type=lifecycle`. | typescript-node-worker-bee | 2 | DEFERRED → follow-up (backend shipped; UI panel is a separate wave) |
| **L-W11** | 058d.1.3 | Ship the settings-page flag reference: render `LIFECYCLE_FLAG_REFERENCE` onto the settings view so the knobs are visible + documented. | typescript-node-worker-bee | 2 | OPEN |
| **L-X1** | all | Full `npm run ci` green (typecheck + jscpd + audit:sql + vitest) | orchestrator | 3 | OPEN |
| **L-X2** | all | Verify on the live DB: after a recall + a write, confirm `access_count > 0`, `last_reinforced_at` advanced, a conflict row exists for a real contradiction. | orchestrator | 3 | OPEN |
| **L-S1** | close-out | Security audit (SQL injection in new wiring, PII in audit rows, supply chain) | security-worker-bee | 4 | OPEN |
| **L-Q1** | close-out | QA verify against PRD-058 ACs + write report | quality-worker-bee | 5 | OPEN |

## Default rulings adopted

| # | Question | Ruling |
|---|---|---|
| R1 | Should Stage-2 ACT-R activation replace Stage-1, or run alongside? | **Replace.** When `activationSource` is wired, `recall.ts:2302-2305` already picks Stage-2 over Stage-1. The fallback path (Stage-1) stays for cold-start / unwired deployments. |
| R2 | Where does the access-log compaction + reverify scheduler run? | **On the local job queue** (`local-job-queue.ts`), same pattern as `compact-api.ts`. A periodic `lifecycle-maintenance` job kind, default cadence ~5 min. Fail-soft — a maintenance miss never breaks recall. |
| R3 | Calibration refit cadence | **~1 hour** (or on-demand via a maintenance trigger). Refit is expensive (reads all resolved outcomes) and the curve moves slowly. |
| R4 | The keep-both memo store | **In-process `Map`** (same shape as test fakes). The memo is an optimization (avoids re-flagging known keep-both pairs), not a correctness invariant; a daemon restart loses it, which is fine — the next write re-evaluates the pair. |
| R5 | Dashboard panel scope | **Read-only first.** Show `H`, freshness, conflict count, stale-ref count, calibration ECE. The conflict-resolve action button is a follow-up — the CLI already has it. |

## Wave plan

```text
Wave 1 (retrieval-worker-bee): wire the 4 inert recall seams + lifecycle config
  → L-W1 (recordRecallAccess), L-W2 (activationSource), L-W3 (calibration),
    L-W4 (stalenessSource), L-W5 (lifecycle config)
  Exit: 5 seams wired in assemble.ts/api.ts; existing tests green; new wiring tests added.

Wave 2 (typescript-node-worker-bee): ship the missing pieces
  → L-W6 (KeepBothMemoStore), L-W7 (reverify scheduler), L-W8 (access-log compaction),
    L-W9 (calibration refit), L-W10 (dashboard panel), L-W11 (settings flag reference)
  Exit: 6 missing pieces shipped; each has tests; full suite green.

Wave 3 (orchestrator): full gate + live DB verification
  → L-X1 (npm run ci), L-X2 (live DB: access_count, last_reinforced_at, conflict row)

Wave 4 (security-worker-bee): SQL/PII/supply-chain audit
  → L-S1

Wave 5 (quality-worker-bee): verify against PRD-058 ACs + QA report
  → L-Q1
```

## Watchdog triggers

- A Wave 1 Bee that wires a seam but doesn't add a test asserting the wire fires in production composition = stalled (re-dispatch).
- A Wave 2 Bee that ships the dashboard panel without consuming the shipped endpoints = scope violation.
- Any Bee that edits `hybrid-recall.ts` = scope violation (out of scope per ADR-0001/ADR-0009).
- Gate failures on the new wiring tests = real, not flake. Decompose.
