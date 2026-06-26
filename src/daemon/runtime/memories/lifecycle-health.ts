/**
 * PRD-058d — the read-side memory-health scalar `H(m,t)` (the pure projection).
 *
 * `H(m,t) = A(m,t) · C(m) · (1 − σ(m,t)) · κ(m,t)`, with `H ∈ [0,1]` — the query-independent part
 * of the master equation `P(m | q, t) = R · A^a · C^c · (1 − σ)^s · κ` (`memory-lifecycle-scoring.md`).
 * It is "how much should this memory be trusted right now, independent of any query," and it is what
 * the lifecycle panel renders per memory.
 *
 * THE LOAD-BEARING RULE (058d Technical Considerations): `H` is a PURE projection of the fields the
 * other terms already emit (`A`/freshness from 058a/058e, `C`/calibrated confidence from 058e, `σ`/
 * staleness from 058c, `κ`/conflict gate from 058b). It adds NO column, NO job, NO write. A DORMANT
 * term's factor is the IDENTITY: a memory with no activation reads `A = 1`, no calibration reads
 * `C = 1`, no stale-ref data reads `σ = 0` (so `1 − σ = 1`), no open conflict reads `κ = 1`. So `H`
 * degrades GRACEFULLY to the terms that are live — an install with every engine off renders `H = 1`,
 * not an error and not a phantom demotion.
 *
 * Pure, synchronous, dependency-free. The api / CLI / dashboard all call {@link assembleHealth} so the
 * projection lives in ONE place (jscpd discipline) and the four surfaces can never compute `H` differently.
 */

/** The per-term inputs to `H` — each OPTIONAL, an absent term resolving to its identity factor. */
export interface LifecycleHealthInputs {
	/** Activation/freshness `A(m,t) ∈ (0,1]` (058a/058e). Absent → identity `1`. */
	readonly activation?: number;
	/** The freshness score the recall hit carries (058a), an alias for `A` when `activation` is absent. */
	readonly freshnessScore?: number;
	/** Calibrated confidence `C(m) ∈ [0,1]` (058e). Absent → identity `1` (calibration dormant). */
	readonly calibratedConfidence?: number;
	/** Staleness probability `σ(m,t) ∈ [0,1]` (058c). Absent → `0` (no stale data → `1 − σ = 1`). */
	readonly staleness?: number;
	/** Conflict gate `κ(m,t) ∈ {0} ∪ (0,1]` (058b). Absent → identity `1` (uncontested). */
	readonly kappa?: number;
}

/** The assembled health projection: the scalar `H` plus the per-term factors it multiplied (for the badge breakdown). */
export interface MemoryHealth {
	/** The health scalar `H ∈ [0,1]`. */
	readonly health: number;
	/** The activation factor used (`A`, identity `1` when dormant). */
	readonly activation: number;
	/** The confidence factor used (`C`, identity `1` when dormant). */
	readonly confidence: number;
	/** The staleness PROBABILITY used (`σ`, `0` when no stale data); the factor multiplied is `1 − σ`. */
	readonly staleness: number;
	/** The conflict-gate factor used (`κ`, identity `1` when uncontested). */
	readonly kappa: number;
}

/** Clamp a value into `[0,1]`; a non-finite value falls back to `fallback`. */
function unit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

/**
 * Assemble the read-side health scalar `H(m,t) = A · C · (1 − σ) · κ` from the emitted term fields
 * (058d). Each absent term takes its IDENTITY: `A = 1`, `C = 1`, `σ = 0` (→ `1 − σ = 1`), `κ = 1`, so a
 * dormant term never demotes and `H` reflects only the live terms. `activation` wins over
 * `freshnessScore` when both are present (they are the same `A`; the hit carries one or the other).
 * Pure; never throws; the result is bounded `[0,1]` by construction (every factor is in `[0,1]`).
 */
export function assembleHealth(inputs: LifecycleHealthInputs): MemoryHealth {
	const activation = unit(inputs.activation ?? inputs.freshnessScore, 1);
	const confidence = unit(inputs.calibratedConfidence, 1);
	const staleness = unit(inputs.staleness, 0);
	const kappa = unit(inputs.kappa, 1);
	const health = activation * confidence * (1 - staleness) * kappa;
	return { health, activation, confidence, staleness, kappa };
}
