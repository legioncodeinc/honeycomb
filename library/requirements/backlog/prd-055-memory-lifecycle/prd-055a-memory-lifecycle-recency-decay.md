# PRD-055a: Recency activation and decay policy

> **Parent:** [PRD-055 Memory Lifecycle](./prd-055-memory-lifecycle-index.md)
> **Implements:** the `A(m,t)` term, Stage 1, of [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M
> **Schema changes:** None (reads existing `created_at`; reads `last_reinforced_at` once 055e lands)

---

## Phase Overview

### Goals

Promote recency from a dormant, neutral knob into a measured, eval-gated recall default. Today `applyRecencyDampening` (PRD-047) is wired into `recallMemories` but ships with a half-life of roughly 100 years, an identity multiplier. This sub-PRD implements **Stage 1** of the activation term `A(m,t)` from the scoring model: a class-aware exponential decay, proven on the golden set, with a per-result freshness signal. Stage 2 (ACT-R activation + reinforcement) is sub-PRD 055e and is a parameter-continuous upgrade of the same term; 055a deliberately ships the simple form first because it is immediately measurable and has no new write path.

### The equation this implements

From the scoring model, Stage 1 activation:

```text
A_simple(m,t) = 2^( −(t − t_ref(m)) / h(class(m)) )      with  t_ref = max(created_at, last_reinforced_at)
```

and the master equation's contribution is `A^a`, where `a` (default `1.0`) is the eval-swept activation exponent. Half-life `h` is the interpretable knob; the implementation uses `λ = ln 2 / h`. Until 055e ships `last_reinforced_at`, `t_ref = created_at`, so 055a is correct and self-contained on day one.

### Scope

- Replace the near-infinite default half-life with measured per-class defaults: distilled `memories` decay slowest, `memory` summaries faster, raw `sessions` fastest (starting points `180 d` / `45 d` / `10 d`, finalized by the sweep).
- Keep recency a **soft, multiplicative** demotion applied last among score adjustments. It never hard-drops a row by age, never moves a row below the result set by age alone, and never disturbs dedup's provenance keep-decision.
- Emit a `freshnessScore = A_simple(m,t) ∈ [0,1]` on each recall hit, the exact multiplier applied, for the dashboard and agent consumers.
- Gate every default behind `npm run eval:recall` extended with a freshness-sensitivity slice.

### Out of scope

- ACT-R activation, access-frequency, and reinforcement (`u_k`, `t_k` series) -> sub-PRD 055e.
- Confidence, staleness, and conflict terms -> sub-PRDs 055e / 055c / 055b.
- Hard time-based deletion or expiry -> retention worker, PRD-030.
- Any change to RRF fusion, arm-class weights, or the dedup stage.

### Dependencies

- **Blocked by:** none (all infrastructure exists in `recall.ts`).
- **Forward-compatible with:** 055e, which swaps `A_simple` for `A_actr` behind the same `freshnessScore` field and `a` exponent.

---

## User Stories

### US-55a.1 - Stale memories are demoted, not dropped

**As an** agent recalling memory, **I want** a six-month-old fact to rank below an equally-relevant fact from last week, **so that** the freshest correct context reaches my prompt first.

**Acceptance criteria:**
- AC-55a.1.1 Given two hits with equal fused score `R` and embeddings on, when one has a larger `t − t_ref`, then it receives a smaller `freshnessScore` and ranks below the newer (`P = R · A^a` strictly orders them by `A`).
- AC-55a.1.2 Given any hit of any age, when recency runs, then it is never removed from the result set by age alone; `A_simple ∈ (0,1]` is a multiplier with no cutoff.
- AC-55a.1.3 Given recency runs, when applied, then it is the last score adjustment (`fuse -> rerank -> dedup -> recency -> optional budget+MMR`), so it cannot change which provenance copy dedup kept.

### US-55a.2 - Decay is class-aware

**As a** memory store, **I want** durable distilled facts to decay slower than raw session rows, **so that** a clean kept memory is not demoted as aggressively as an ephemeral tool-call blob.

**Acceptance criteria:**
- AC-55a.2.1 Given a `memories` hit and a `sessions` hit of identical age, when recency is applied, then the `sessions` hit receives the larger penalty because `h(sessions) < h(memories)`.
- AC-55a.2.2 Given per-class half-lives, when a caller overrides them via `memory.lifecycle.halfLifeDaysByClass`, then the override is honored and the defaults are ignored.
- AC-55a.2.3 Given a class with no configured half-life, when recency runs, then it falls back to the documented default for that class, never to the neutral 100-year value.

### US-55a.3 - Freshness is visible and honest

**As a** dashboard or agent consumer, **I want** each recalled memory to carry the multiplier that was applied, **so that** I can render or reason about staleness.

**Acceptance criteria:**
- AC-55a.3.1 Given a recall response, when results are returned, then every hit carries `freshnessScore ∈ [0,1]` equal to the recency multiplier applied to its fused score.
- AC-55a.3.2 Given embeddings are off (degraded recall), when results are returned, then `freshnessScore` is still computed from row age and `degraded: true` is still reported honestly.
- AC-55a.3.3 Given a row with a missing or unparseable timestamp, when recency runs, then the hit is treated as maximally fresh (`A = 1`) rather than dropped or errored.

---

## Data Model Changes

None for 055a. Recency reads the existing `created_at`. The `last_reinforced_at` column that makes `t_ref` reinforcement-aware is added by 055e via additive lazy schema-healing; until then `t_ref = created_at` and the code reads `last_reinforced_at` as nullable-defaulting-to-`created_at`.

---

## API / Endpoint Specs

`POST /api/memories/recall` response gains a per-hit field:

```jsonc
{
  "results": [
    { "source": "memories", "id": "…", "score": 0.81, "freshnessScore": 0.93, "degraded": false }
  ]
}
```

Optional request override (defaults from `memory.lifecycle.*` config):

```ts
const RecencyOverride = z.object({
  halfLifeDaysByClass: z.object({
    memories: z.number().positive().optional(),
    memory:   z.number().positive().optional(),
    sessions: z.number().positive().optional(),
  }).optional(),
  activationExponent: z.number().min(0).optional(), // the `a` in A^a; 0 = neutral
}).optional();
```

---

## Technical Considerations

- **Implementation form.** Compute `λ = ln(2) / h(class)` once per class, then `A = exp(−λ · Δt_days)`, `Δt_days = max(0, (t − t_ref)/86400_000)`. Clamp negative `Δt` (clock skew, future timestamps) to `0` so `A ≤ 1`.
- **Default selection is empirical.** Sweep candidate half-lives against the golden set; the shipped defaults are the ones that lift or hold recall@5 and MRR. Commit the sweep table to the PRD-027/047 eval log so the choice is auditable, not a round number.
- **Order is load-bearing.** Recency stays the final score adjustment. Moving it earlier would let it perturb dedup's provenance decision, which AC-55a.1.3 forbids.
- **Complementary, not redundant with versioning.** A superseded row is already excluded by `is_deleted` / `MAX(version)` before recency sees it. Recency is the *soft* freshness signal on top of the *hard* version invariant (see the currentness section of `retrieval.md`).
- **Fail-soft.** Missing timestamp -> `A = 1`. Recency never throws and never hangs; a degraded freshness estimate beats a 500.

---

## Files Touched

### Modified files
- `src/daemon/runtime/memories/recall.ts` - replace the neutral default in `applyRecencyDampening`, make it class-aware, emit `freshnessScore`, read `t_ref` from `max(created_at, last_reinforced_at)`.
- `src/daemon/runtime/memories/api.ts` - thread the optional override and surface `freshnessScore`.
- `src/eval/golden.ts` / `src/eval/metrics.ts` - add the freshness-sensitivity slice (stale-vs-fresh pairs at equal relevance).

### New files
- `tests/daemon/runtime/memories/recency-decay.spec.ts` - AC-55a.1.x through 55a.3.x.

---

## Test Plan

- Unit: half-life math (`A(h)= 0.5` at `Δt = h`), class-penalty ordering, clamp on future timestamps, multiplier-never-drops invariant, missing-timestamp -> `1`.
- Eval: `npm run eval:recall` passes at the new default on the freshness slice; commit the sweep table.
- Live: dogfood a recall against a real daemon with a deliberately aged fixture; confirm the newer fact ranks first and `freshnessScore` renders in the dashboard.

---

## Risks and Open Questions

- **Risk:** an over-aggressive half-life demotes a still-correct old fact below noise. **Mitigation:** the eval gate plus conservative per-class defaults; recency can only reorder, never drop (AC-55a.1.2).
- **Open question:** should the activation exponent `a` ship at `1.0` or be swept below it to keep recency gentle in the first release? Decide from the freshness-slice sweep; default `1.0` unless the slice shows over-demotion.

---

## Related

- [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) - the `A(m,t)` term, both stages.
- [`prd-055e-memory-lifecycle-reinforcement-calibration.md`](./prd-055e-memory-lifecycle-reinforcement-calibration.md) - the Stage 2 upgrade.
- [`retrieval.md`](../../../knowledge/private/ai/retrieval.md) - the shaping-stages table and the currentness invariant.
