/**
 * PRD-058e, ACT-R base-level activation (the `A(m,t)` Stage-2 term).
 *
 * This is the rigorous upgrade of the PRD-058a Stage-1 single-access exponential
 * decay (`recall.ts` `recencyActivation`) to Anderson & Schooler's ACT-R
 * base-level activation over a usefulness-weighted access history. From the
 * scoring model (`memory-lifecycle-scoring.md` Term 1 Stage 2), over the access
 * series `t_1 < … < t_n` with usefulness weights `u_k ∈ [0,1]`:
 *
 *   B(m,t)      = ln( Σ_{k=1}^{n} u_k · (t − t_k)^(−d) )      # base-level activation
 *   A_actr(m,t) = clamp( exp( B(m,t) − B* ), A_min, 1 )       # bounded multiplier
 *
 * `B` rises with BOTH recency (recent `t_k` dominate the sum) AND frequency (more
 * terms), and the SPACING EFFECT falls out for free: the same number of accesses
 * spread over time decays slower than when bunched, because no single
 * `(t − t_k)^(−d)` term dominates (AC-55e.1.2). Reinforcement (`u_k ≈ 1`)
 * strengthens; a contradicted/ignored access (`u_k → 0`) does not inflate `B`
 * (AC-55e.1.3). A cold memory keeps a floor of salience (`A_min`, AC-55e.1.4),
 * graceful forgetting, never a cliff.
 *
 * ── Numerics (PRD-058e Technical Considerations) ─────────────────────────────
 *  - `(t − t_k)^(−d)` is guarded against `t_k = t` (an access logged at the same
 *    instant as the recall) with a small ε AGE FLOOR ({@link MIN_ACCESS_AGE_DAYS}),
 *    so a zero/negative age never produces `Infinity`/`NaN` (it would otherwise
 *    divide by zero). A FUTURE access (clock skew) is floored to that same minimum
 *    age, so it contributes a large-but-finite term, never `> ` a present-day one
 *    by being negative-age.
 *  - `B` is computed in LOG SPACE via a log-sum-exp over `ln(u_k) − d·ln(age_k)`,
 *    so a long, heavily-weighted history cannot overflow the sum.
 *  - A zero-usefulness access (`u_k = 0`) contributes `ln(0) = −∞` to the
 *    log-sum-exp, i.e. nothing, exactly the "does not inflate activation" rule.
 *
 * ── Stage-1 continuity (the migration is parameter-continuous) ────────────────
 * With a SINGLE access `(t_1, u_1 = 1)` and a matched decay, `B = −d·ln(age)` and
 * `A_actr = clamp(exp(−d·ln age − B*), A_min, 1) = clamp(age^(−d)/e^{B*}, …)`, the
 * single-access special case of the full form, monotone-decreasing in age exactly
 * like Stage 1 (`memory-lifecycle-scoring.md`: "Stage 1 is Stage 2 with a single
 * access and a matched d/h"). The two are not byte-identical (one is `2^(−Δt/h)`,
 * the other a power law), but both are smooth, bounded, monotone-in-age multipliers
 * in `(0,1]`, so swapping one for the other behind the same `freshnessScore` field
 * is parameter-continuous and eval-gated, never a discontinuity.
 *
 * Pure + synchronous: no I/O, no clock, no throw. The caller supplies the access
 * history (read from `memory_access` via `access-log.ts`), the wall-clock `now`,
 * and the parameters; this module is the math.
 */

/** ACT-R decay exponent `d`, default `0.5` (`memory-lifecycle-scoring.md`). Larger `d` forgets faster. */
export const DEFAULT_ACTR_DECAY = 0.5;

/**
 * Activation floor `A_min`, default `0.05` (`memory-lifecycle-scoring.md`). A cold,
 * never-reinforced memory keeps this sliver of salience so forgetting is graceful,
 * never zero-by-age (AC-55e.1.4).
 */
export const DEFAULT_ACTR_A_MIN = 0.05;

/**
 * Reference activation `B*` that pins the TOP of the range: a memory at or above
 * `B*` is maximally salient (`A_actr = 1`). The default `0` makes `A = exp(B)`,
 * clamped to `1`; the eval sweep calibrates `B*` so the busiest memories sit near
 * `A = 1` (PRD-058e). A single named, eval-tunable knob.
 */
export const DEFAULT_ACTR_B_STAR = 0;

/**
 * Milliseconds in a day, the age unit `B` is computed in, matching the Stage-1
 * `recencyActivation` day-based half-life so the two stages share an age scale.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The ε AGE FLOOR in DAYS for `(t − t_k)^(−d)` (PRD-058e numerics guard). An access
 * logged at (or after) the recall instant has age `≤ 0`, which would make the power
 * term `Infinity`/`NaN`; flooring the age at a small positive value (~1 minute) keeps
 * every term large-but-finite. Chosen well below any realistic half-life so it does
 * not distort a genuinely-recent access, only tames the singularity at `t_k = t`.
 */
export const MIN_ACCESS_AGE_DAYS = 1 / (24 * 60); // one minute, in days.

/** One access event in a memory's history: when it happened and how useful it was. */
export interface AccessEvent {
	/** The access time `t_k` as epoch milliseconds. */
	readonly atMs: number;
	/** The usefulness weight `u_k ∈ [0,1]` (creation = 1; ignored/contradicted → 0). */
	readonly usefulness: number;
}

/** The ACT-R activation parameters (all eval-tunable; defaulted from the scoring model). */
export interface ActrParams {
	/** Decay exponent `d` (default {@link DEFAULT_ACTR_DECAY}). */
	readonly decay: number;
	/** Activation floor `A_min` (default {@link DEFAULT_ACTR_A_MIN}). */
	readonly aMin: number;
	/** Reference activation `B*` (default {@link DEFAULT_ACTR_B_STAR}). */
	readonly bStar: number;
}

/** The resolved defaults, frozen so a caller can spread + override individual knobs. */
export const DEFAULT_ACTR_PARAMS: ActrParams = Object.freeze({
	decay: DEFAULT_ACTR_DECAY,
	aMin: DEFAULT_ACTR_A_MIN,
	bStar: DEFAULT_ACTR_B_STAR,
});

/**
 * The age in DAYS of an access relative to `nowMs`, FLOORED at {@link MIN_ACCESS_AGE_DAYS}
 * (PRD-058e numerics guard). A same-instant or future access (age `≤ 0`) is floored to the
 * minimum so `age^(−d)` stays finite. Non-finite inputs floor too, never `NaN`.
 */
function accessAgeDays(atMs: number, nowMs: number): number {
	if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return MIN_ACCESS_AGE_DAYS;
	const ageDays = (nowMs - atMs) / MS_PER_DAY;
	return Math.max(MIN_ACCESS_AGE_DAYS, ageDays);
}

/**
 * Clamp a usefulness weight into `[0,1]` (PRD-058e partial reinforcement). A NaN or
 * out-of-range `u_k` (a hand-built history, a mis-graded access) is coerced rather than
 * allowed to poison the sum: `< 0 → 0`, `> 1 → 1`, non-finite → `0` (contributes nothing).
 */
function clampUsefulness(u: number): number {
	if (!Number.isFinite(u)) return 0;
	return Math.min(1, Math.max(0, u));
}

/**
 * The base-level activation `B(m,t) = ln( Σ_k u_k · (t − t_k)^(−d) )`, computed in LOG
 * SPACE via a numerically-stable log-sum-exp over the per-access log terms
 * `ln(u_k) − d·ln(age_k)` (PRD-058e). RULES:
 *  - An EMPTY history (no accesses) has an empty sum → `B = −∞` (the caller maps that to
 *    the `A_min` floor: a memory with no logged access is maximally cold, AC-55e.1.4).
 *  - A `u_k = 0` access contributes `ln(0) = −∞` to the log-sum-exp, i.e. it is OMITTED
 *    from the effective sum, a contradicted/ignored recall does not inflate `B`
 *    (AC-55e.1.3).
 *  - Every age is floored (see {@link accessAgeDays}) so no term is `Infinity`/`NaN`.
 * Returns `−Infinity` when the effective sum is empty (all-zero usefulness or no events);
 * a finite `B` otherwise. Pure + sync.
 */
export function baseLevelActivation(history: readonly AccessEvent[], nowMs: number, decay: number): number {
	const d = Number.isFinite(decay) && decay >= 0 ? decay : DEFAULT_ACTR_DECAY;
	// Per-access log terms: ln(u_k) − d·ln(age_k). A zero-usefulness term is omitted (its
	// ln(u) is −∞), which is exactly its log-sum-exp contribution of nothing.
	const logTerms: number[] = [];
	for (const ev of history) {
		const u = clampUsefulness(ev.usefulness);
		if (u === 0) continue; // ln(0) = −∞ → contributes nothing; skip to keep the sum finite.
		const ageDays = accessAgeDays(ev.atMs, nowMs);
		logTerms.push(Math.log(u) - d * Math.log(ageDays));
	}
	if (logTerms.length === 0) return Number.NEGATIVE_INFINITY; // empty effective sum → B = −∞.

	// Numerically-stable log-sum-exp: B = m + ln Σ exp(term − m), where m = max(term).
	const m = Math.max(...logTerms);
	if (!Number.isFinite(m)) return m; // all −∞ guarded above, but keep the invariant explicit.
	let sumExp = 0;
	for (const term of logTerms) sumExp += Math.exp(term - m);
	return m + Math.log(sumExp);
}

/**
 * The ACT-R activation multiplier `A_actr(m,t) = clamp( exp( B − B* ), A_min, 1 )`
 * (PRD-058e, `memory-lifecycle-scoring.md`). RULES:
 *  - `B = −∞` (empty/all-zero history) → `exp(−∞) = 0` → clamped UP to `A_min` (a cold
 *    memory keeps the floor, AC-55e.1.4), never `0`.
 *  - The result is clamped into `[A_min, 1]`: a very busy memory saturates at `1`
 *    (the rich-get-richer ceiling, PRD-058e Risk), a cold one floors at `A_min`.
 *  - `A_min` is itself clamped into `[0,1]` and `B*` coerced finite, so a hand-built
 *    param set can never invert the range. Pure + sync, never throws / NaNs.
 */
export function actrActivation(history: readonly AccessEvent[], nowMs: number, params: ActrParams = DEFAULT_ACTR_PARAMS): number {
	const aMin = Number.isFinite(params.aMin) ? Math.min(1, Math.max(0, params.aMin)) : DEFAULT_ACTR_A_MIN;
	const bStar = Number.isFinite(params.bStar) ? params.bStar : DEFAULT_ACTR_B_STAR;
	const b = baseLevelActivation(history, nowMs, params.decay);
	// exp(−∞ − B*) = 0 → the clamp lifts it to A_min (the cold-memory floor).
	const raw = Number.isFinite(b) ? Math.exp(b - bStar) : 0;
	return Math.min(1, Math.max(aMin, raw));
}
