# PRD-058e: Reinforcement, activation, and confidence calibration

> **Parent:** [PRD-058 Memory Lifecycle](./prd-058-memory-lifecycle-index.md)
> **Implements:** the `A(m,t)` term Stage 2 (ACT-R) and the `C(m)` term of [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L
> **Schema changes:** Additive (access-event log, `last_reinforced_at`, calibration model store)

---

## Phase Overview

### Goals

This is the sub-PRD that makes the store a *memory* rather than an aging cache. It adds two things the simple decay of 058a cannot express:

1. **Reinforcement.** A memory that is recalled and confirmed useful should become harder to forget, exactly as retrieval strengthens human memory (the testing effect). This upgrades activation from single-access exponential decay to the full ACT-R base-level activation over a usefulness-weighted access history, from which the spacing effect emerges for free.
2. **Calibration.** Raw model confidence is systematically miscalibrated. The store should *learn* how much to trust its own confidence from outcomes it already observes, which memories win conflicts and pass re-verification, and map raw confidence through a fitted calibration curve.

Together these close the loop: using a memory well strengthens it; being proven right makes its confidence trustworthy. Both are eval-gated and ship dormant (exponent `0`) until measured.

### The equations this implements

ACT-R activation (Stage 2 of `A`), over access history `t_1 < … < t_n` with usefulness weights `u_k ∈ [0,1]`:

```text
B(m,t)     = ln( Σ_{k=1}^{n} u_k · (t − t_k)^(−d) )           # base-level activation, d ≈ 0.5
A_actr(m,t)= clamp( exp( B(m,t) − B* ), A_min, 1 )            # bounded multiplier for the master equation
```

Calibrated confidence (`C` term):

```text
C(m) = g( f(m) )            # g = isotonic regression fit on observed (raw confidence -> correctness)
```

quality tracked by `ECE = Σ_b (|B_b|/N)·|acc(B_b) − conf(B_b)|` and the Brier score.

### Scope

- **Access-event log.** Append `(t_k, u_k, kind)` whenever a memory is created (`u=1`), recalled-and-injected, reinforced (confirmed useful), or down-weighted (ignored/contradicted, `u→0`).
- **Activation upgrade.** Compute `A_actr` from the event log; expose it behind the same `freshnessScore` field and `a` exponent 058a defined, so the swap is invisible to callers.
- **`last_reinforced_at`.** Maintained from the event log so 058a's `t_ref` becomes reinforcement-aware.
- **Calibration curve.** Periodically refit `g` from resolved outcomes; expose `C(m)` and activate the `c` exponent once ECE clears a threshold.
- **Spaced re-verification hook.** The activation/event machinery also drives the staleness re-verification cadence (058c) and conflict re-evaluation: a low-activation memory is re-checked less often, a high-activation one more often, so verification effort follows utility.

### Out of scope

- The reinforcement *signal source* wiring per harness (what counts as "confirmed useful" in each host) beyond a documented default; the default is "injected into context and not contradicted or down-ranked in the same session." Per-harness richer signals are a follow-on.
- Staleness and conflict mechanics themselves (058c / 058b); this sub-PRD only feeds them activation and calibrated confidence.

### Dependencies

- **Blocked by:** 058a (defines `freshnessScore`, the `a` exponent, and `t_ref`).
- **Feeds:** 058b (uses `A` and `C` in conflict weights `w_i`), 058c (uses activation to pace re-verification), 058d (renders reinforcement events and calibration health).

---

## User Stories

### US-55e.1 - Use strengthens memory

**As a** memory store, **I want** a fact that keeps proving useful to resist forgetting, **so that** salience tracks real utility, not raw age.

**Acceptance criteria:**
- AC-55e.1.1 Given a memory recalled and confirmed useful at time `t_k`, when activation is next computed, then `A_actr` is strictly higher than it would have been without that access (the event entered `B` with `u_k > 0`).
- AC-55e.1.2 Given two memories created at the same time with the same number of useful accesses, when one's accesses are spread over time and the other's are bunched, then the spread one has the higher or equal `A_actr` (spacing effect).
- AC-55e.1.3 Given a memory recalled but then contradicted or ignored in the same turn, when the access is logged, then `u_k → 0` so the non-useful recall does not inflate activation.
- AC-55e.1.4 Given a never-reinforced cold memory, when activation is computed, then `A_actr ≥ A_min` (graceful forgetting, never zero by age).

### US-55e.2 - The store learns to trust its own confidence

**As a** retrieval consumer, **I want** confidence values that mean what they say, **so that** a `0.9` memory is right about 90% of the time.

**Acceptance criteria:**
- AC-55e.2.1 Given a growing set of resolved outcomes (conflict wins/losses, re-verification pass/fail), when the calibration curve `g` is refit, then ECE on a held-out slice is non-increasing across refits.
- AC-55e.2.2 Given insufficient outcome data, when calibration runs, then `g` is the identity (`C = f`) and the `c` exponent stays `0` (dormant), so an unproven calibration never perturbs ranking.
- AC-55e.2.3 Given `g` clears the ECE-threshold gate, when `c` is activated, then the change is eval-gated like every other term (no recall@5 / MRR regression past `baseline − ε`).

### US-55e.3 - Verification effort follows utility

**As a** maintenance worker, **I want** to re-verify and re-evaluate high-activation memories more often than cold ones, **so that** scarce model/graph budget is spent where it matters.

**Acceptance criteria:**
- AC-55e.3.1 Given two stale-eligible memories, when re-verification is scheduled, then the higher-`A_actr` one is checked at a shorter interval.
- AC-55e.3.2 Given a cold, low-activation memory, when scheduling runs, then it is re-checked at the longest interval (or deferred), never starving the hot set.

---

## Data Model Changes

| Model | Change | Type | Nullable | Default | Index |
|---|---|---|---|---|---|
| `memory_access` (new) | `id` | `UUID` (PK) | no | `gen_random_uuid()` | primary |
| | `memory_id` | `UUID` | no | - | index |
| | `org`/`workspace`/`agent_id` | scope cols | no | - | composite index |
| | `at` | `timestamptz` | no | `now()` | index |
| | `usefulness` | `float [0,1]` | no | `1.0` | no |
| | `kind` | `enum('create','recall','reinforce','downweight')` | no | - | no |
| `memories` | `last_reinforced_at` | `timestamptz` | yes | null | index |
| `memories` | `access_count` | `int` (denormalized cache) | yes | `0` | no |
| `memory_calibration` (new) | `id` / `fit_at` / `model_blob` / `ece` / `brier` / `n_samples` | curve snapshot | - | - | `fit_at` index |

All added via additive lazy schema-healing, no migration, no backfill. `memory_access` is append-only and feeds the retention worker's purge horizon (old raw access events compact into the denormalized `access_count` + `last_reinforced_at` so the log does not grow without bound). The calibration curve is stored as a small serialized isotonic model, refit on a schedule, versioned by `fit_at`.

---

## API / Endpoint Specs

- **Internal:** a `recordAccess(memoryId, usefulness, kind)` daemon call invoked from the recall path (on inject) and the session-end summary worker (to grade usefulness from the turn outcome). No public write endpoint, reinforcement is daemon-internal so it cannot be spoofed by a client.
- **Read:** recall responses gain `activation` (the `A_actr` value), `accessCount`, and `calibratedConfidence` (`C`) alongside the existing `freshnessScore` and `score`, for the dashboard.
- **Calibration introspection:** `GET /api/memories/calibration` returns the current curve's `ece`, `brier`, `n_samples`, and a reliability-diagram payload for 058d.

---

## Technical Considerations

- **Off the hot path.** Activation is computed at recall time from the event log (bounded by `access_count`, and the log is compacted), and reinforcement grading happens in the session-end summary worker, not on the capture write path. The one rule that cannot bend still holds: no model or aggregation step can cost the user a memory.
- **Usefulness grading.** Default signal: a recalled memory that was injected and not contradicted/down-ranked in the same session scores `u ≈ 1`; one ignored or contradicted scores `u ≈ 0`. The grader reuses the conflict detector (058b) to spot contradiction. Graded usefulness is the partial-reinforcement weight `u_k`.
- **ACT-R numerics.** Guard `(t − t_k)^{−d}` against `t_k = t` (use a small `ε` floor on age); compute `B` in log space; cache per-memory `B` between writes and invalidate on a new access event. `B*` is calibrated so the busiest memories sit near `A = 1`.
- **Calibration fit.** Isotonic regression (monotone, no parametric assumption) over `(f, y)` pairs where `y ∈ {0,1}` is the observed correctness from resolved conflicts and re-verifications. Refit on a schedule; keep the prior curve until the new one beats it on held-out ECE. Cold-start = identity.
- **Eventual consistency.** Access-event read-backs and calibration reads poll to convergence, never single-read, per the repo rule.

---

## Files Touched

### New files
- `src/daemon/runtime/memories/activation.ts` - `B(m,t)` and `A_actr` from the event log.
- `src/daemon/runtime/memories/access-log.ts` - `recordAccess`, compaction into `last_reinforced_at` / `access_count`.
- `src/daemon/runtime/memories/calibration.ts` - isotonic fit, ECE/Brier, `g(f)`.
- `src/daemon/runtime/memories/usefulness-grader.ts` - grade `u_k` from session outcome (reuses the conflict detector).
- `tests/daemon/runtime/memories/activation.spec.ts`, `calibration.spec.ts`, `usefulness-grader.spec.ts`.

### Modified files
- `src/daemon/runtime/memories/recall.ts` - swap `A_simple` for `A_actr` behind `freshnessScore`; emit `activation`, `calibratedConfidence`; record a `recall` access event on inject.
- the session-end summary worker - invoke the usefulness grader and `recordAccess(reinforce|downweight)`.
- the maintenance/retention workers - activation-paced re-verification scheduling; access-log compaction.
- `src/daemon/storage/schema` source - `memory_access`, `memory_calibration`, `last_reinforced_at`, `access_count` ColumnDefs.

---

## Test Plan

- Unit: ACT-R math (recency dominance, frequency lift, spacing effect AC-55e.1.2), `A_min` floor, `u→0` on contradiction, isotonic monotonicity, ECE computation.
- Property: more useful accesses never decrease `A_actr`; calibration refit never increases held-out ECE (AC-55e.2.1).
- Eval: `npm run eval:recall` with the `c` exponent activated must hold the baseline; commit the ECE-over-time curve.
- Live: dogfood a memory recalled across several sessions, confirm `access_count` rises, `A_actr` climbs with use, and a deliberately-wrong memory's calibrated confidence drops after it loses a conflict.

---

## Risks and Open Questions

- **Risk:** a feedback loop where high activation -> more recall -> more reinforcement -> runaway dominance (rich-get-richer). **Mitigation:** the `clamp(…, A_min, 1)` ceiling bounds it, and usefulness grading (`u→0` on non-useful recall) breaks the loop for memories that surface but do not help.
- **Risk:** usefulness grading is noisy. **Mitigation:** partial weights `u_k ∈ [0,1]` rather than binary; the activation sum is robust to a few mis-graded accesses; ships behind the eval gate.
- **Open question:** purge horizon for `memory_access`, how many raw events to keep before compacting to `access_count` + `last_reinforced_at`? Start at the last `N = 32` events per memory; confirm against the activation-fidelity-vs-storage tradeoff on dogfood data.
- **Open question:** should down-weighted (`u≈0`, repeatedly ignored) memories eventually be proposed for retention purge rather than just demoted? Likely yes as a follow-on, but only through the existing retention worker, never a new destructive path here.

---

## Related

- [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) - the `A` (Stage 2) and `C` terms.
- [`prd-058a-memory-lifecycle-recency-decay.md`](./prd-058a-memory-lifecycle-recency-decay.md) - the Stage 1 form this upgrades.
- [`memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md) - the summary worker and retention worker this hooks.
