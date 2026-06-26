# Memory Lifecycle Config Reference (`memory.lifecycle.*`)

> Category: Ai | Version: 1.0 | Date: June 2026 | Status: Shipped (PRD-058d)

The single config reference for the four memory-lifecycle engines: recency/activation (058a), conflicts (058b), stale-references (058c), and calibration (058e). Every knob lives in one typed block, `memory.lifecycle.*` in `agent.yaml`, with a matching `HONEYCOMB_LIFECYCLE_*` env override. This doc is the authoritative companion to the settings-page reference and is single-sourced from `src/shared/lifecycle-flags.ts` (`LIFECYCLE_FLAG_REFERENCE`), so the surface and this doc cannot drift.

**Related:**
- [`memory-lifecycle-scoring.md`](memory-lifecycle-scoring.md): the master equation `P(m | q, t) = R · A^a · C^c · (1 − σ)^s · κ`, the `H(m,t)` health scalar, and the parameter table this block governs.
- [`memory-pipeline.md`](memory-pipeline.md): the `memory.pipelineV2` / `HONEYCOMB_PIPELINE_*` precedent this config mirrors exactly.

---

## Precedence

The config resolves with one precedence model, identical to `memory.pipelineV2`:

1. `HONEYCOMB_LIFECYCLE_*` environment variable, per-key (highest).
2. `agent.yaml` `memory.lifecycle.*` value.
3. The documented default in `src/daemon/runtime/memories/lifecycle-config.ts` (last).

Env overrides yaml per-key; an absent key in both falls to the documented default. There is no second precedence model and no scattered toggle. The resolution is one zod `safeParse` boundary that coerces and clamps every numeric knob, so a fat-fingered value falls back to its default or clamps to a floor rather than crashing the daemon.

## Non-destructive defaults

A fresh install demotes nothing. Every term that can demote ships behind an exponent that defaults to the identity:

- `a = 1` (activation/freshness live but neutral-shaped),
- `c = 0` (calibrated confidence dormant until proven),
- `s = 0` (stale-ref posture `observe`, visible but inert),
- conflict auto-resolve off (detect and queue only, human-in-the-loop).

Turning a term on is a deliberate, reversible operator action.

## The parameters

| Symbol | Config path (`memory.lifecycle.*`) | Default | Env override (`HONEYCOMB_LIFECYCLE_*`) | Master-equation effect |
|---|---|---|---|---|
| `a` | `activationExponent` | `1` | `ACTIVATION_EXPONENT` | exponent on the activation/freshness term `A^a` |
| `c` | `confidenceExponent` | `0` | `CONFIDENCE_EXPONENT` | exponent on the calibrated-confidence term `C^c` (dormant until calibrated) |
| `s` | `stalenessExponent` | `0` | `STALENESS_EXPONENT` | exponent on the staleness term `(1 − σ)^s` (0 under observe) |
| `h(memories)` | `halfLifeDaysByClass.memories` | `180 d` | `HALFLIFE_MEMORIES_DAYS` | shapes `A` for distilled facts (slower decay) |
| `h(memory)` | `halfLifeDaysByClass.memory` | `45 d` | `HALFLIFE_MEMORY_DAYS` | shapes `A` for session summaries |
| `h(sessions)` | `halfLifeDaysByClass.sessions` | `10 d` | `HALFLIFE_SESSIONS_DAYS` | shapes `A` for raw dialogue (fastest decay) |
| `d` | `actrDecay` | `0.5` | `ACTR_DECAY` | ACT-R decay shaping `A` (Stage 2) |
| `A_min` | `activationFloor` | `0.05` | `ACTIVATION_FLOOR` | clamps `A` so a cold memory keeps a sliver of salience |
| `h_verify` | `verificationHalfLifeDays` | `14 d` | `VERIFICATION_HALFLIFE_DAYS` | shapes `σ` via the verification-freshness factor `v(m,t)` |
| `θ_detect` | `contradictionThreshold` | `0.6` | `CONTRADICTION_THRESHOLD` | gates conflict detection (`Contra > θ_detect`) |
| `γ` | `corroborationWeight` | `0.5` | `CORROBORATION_WEIGHT` | shapes the conflict vote weight `w_i` |
| `τ_supersede` | `supersedeMargin` | `0.5` | `SUPERSEDE_MARGIN` | conflict verdict cut (`margin ≥ τ_supersede → supersede`) |
| `τ_review` | `reviewMargin` | `0.15` | `REVIEW_MARGIN` | conflict verdict cut (`τ_review ≤ margin < τ_supersede → review`) |
| `ρ` | `openConflictSuppression` | `0` | `OPEN_CONFLICT_SUPPRESSION` | `κ` for the open-conflict loser (0 fully suppress, reversible) |

## The posture flags

| Flag | Config path | Default | Env override (`HONEYCOMB_LIFECYCLE_*`) | Effect |
|---|---|---|---|---|
| Conflict auto-resolve | `conflictAutoResolve` | `false` | `CONFLICT_AUTORESOLVE` | when off, conflicts are detected and queued only (human-in-the-loop) |
| Stale-ref posture | `staleRefPosture` | `observe` | `STALEREF_POSTURE` | `observe` (`s = 0`, inert) vs `execute` (`s > 0`, demote) |

Flipping `staleRefPosture` from `observe` to `execute` moves `s` from `0` to its configured value (defaulting to `1` when the explicit exponent is still the dormant `0`); no other term's exponent changes implicitly.

## The health scalar `H(m,t)`

The dashboard renders the query-independent health scalar:

```text
H(m,t) = A(m,t) · C(m) · (1 − σ(m,t)) · κ(m,t)      with  H ∈ [0,1]
```

`H` is a read-side projection of the already-emitted term fields (`freshnessScore`/`activation` for `A`, `calibratedConfidence` for `C`, the stale-ref `σ`, the conflict gate `κ`). It adds no column, no job, no write. A dormant term's factor is the identity, so `H` degrades gracefully to the terms that are live: an install with every engine off reads `H = 1`, not a phantom demotion.

## Surfaces

- **Dashboard:** the Memory health panel on the memories page renders the `H` badge, freshness, the open-conflict count and per-conflict resolve action, the stale-reference list and count, and the calibration view (ECE plus the reliability diagram).
- **CLI:** `honeycomb memory conflicts` (list/resolve), `honeycomb memory stale-refs` (list), and `honeycomb memory inspect <id> --lifecycle` (freshnessScore, calibratedConfidence, refStatus, open-conflict status, and the computed `H`).
- **Settings page:** this same flag reference (symbol, default, effect, env override).

Every resolve, from the dashboard and the CLI, goes through the one already-defined 058b `POST /api/memories/conflicts/:id/resolve` endpoint; 058d defines no new write path.
