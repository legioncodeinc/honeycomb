/**
 * PRD-058e, spaced re-verification scheduling (verification effort follows utility).
 *
 * The activation machinery also paces the staleness re-verification cadence (058c)
 * and conflict re-evaluation: a HIGH-activation memory is re-checked MORE often, a
 * cold one LESS often, so scarce model/graph budget is spent where it matters
 * (US-55e.3). This module is the pure scheduling-interval function the maintenance
 * worker calls; the worker registration is a thin call into this.
 *
 * The mapping (AC-55e.3.1 / 55e.3.2):
 *   interval(A) = clamp( maxInterval · (1 − A), minInterval, maxInterval )
 *
 *  - A near `1` (a hot, busy memory) → interval near `minInterval` (re-checked
 *    soonest). Strictly: a higher `A_actr` yields a SHORTER interval (AC-55e.3.1).
 *  - A near `A_min` (a cold memory) → interval near `maxInterval` (re-checked
 *    latest / deferred), but never beyond `maxInterval` so the cold set is never
 *    STARVED out of re-verification entirely (AC-55e.3.2, "longest interval (or
 *    deferred), never starving the hot set", the hot set is served first because
 *    its interval is shortest, and the cold set still gets a bounded longest
 *    interval rather than `∞`).
 *  - The interval is monotone DECREASING in `A`, clamped into
 *    `[minInterval, maxInterval]`, so the order of due-ness always tracks
 *    activation: sort the stale-eligible set by interval ascending (equivalently by
 *    activation descending) and the hot memories are due first.
 *
 * Pure + synchronous: no I/O, no clock, no throw. The maintenance worker supplies
 * each memory's current `A_actr` (from `activation.ts`) and reads back the
 * interval; the worker owns WHEN it runs, this owns the cadence math.
 */

/** The default SHORTEST re-verification interval in ms (a maximally-hot memory). 1 day. */
export const DEFAULT_MIN_REVERIFY_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** The default LONGEST re-verification interval in ms (a cold memory; bounded, never `∞`). 90 days. */
export const DEFAULT_MAX_REVERIFY_INTERVAL_MS = 90 * 24 * 60 * 60 * 1_000;

/** The re-verification cadence bounds (eval-tunable). */
export interface ReverifyScheduleConfig {
	/** Shortest interval (ms) for a maximally-hot memory. Default {@link DEFAULT_MIN_REVERIFY_INTERVAL_MS}. */
	readonly minIntervalMs: number;
	/** Longest interval (ms) for a cold memory. Default {@link DEFAULT_MAX_REVERIFY_INTERVAL_MS}. */
	readonly maxIntervalMs: number;
}

/** The resolved cadence defaults, frozen for spread-and-override. */
export const DEFAULT_REVERIFY_SCHEDULE: ReverifyScheduleConfig = Object.freeze({
	minIntervalMs: DEFAULT_MIN_REVERIFY_INTERVAL_MS,
	maxIntervalMs: DEFAULT_MAX_REVERIFY_INTERVAL_MS,
});

/**
 * The re-verification interval (ms) for a memory with current activation `A_actr`
 * (PRD-058e). `interval(A) = clamp( maxInterval · (1 − A), minInterval, maxInterval )`.
 * RULES:
 *  - Monotone DECREASING in `A`: a higher activation → a shorter interval
 *    (AC-55e.3.1), so the hot set is due soonest.
 *  - Clamped into `[minInterval, maxInterval]`: a cold memory (`A → A_min`) gets the
 *    LONGEST bounded interval (AC-55e.3.2), never `∞` (so it is deferred, not
 *    starved), and a saturated memory (`A → 1`) gets the shortest.
 *  - `A` is clamped into `[0,1]`; a degenerate config where `min > max` is
 *    normalized (the smaller bound is the floor) so the result is always sane. Pure.
 */
export function reverifyIntervalMs(activation: number, config: ReverifyScheduleConfig = DEFAULT_REVERIFY_SCHEDULE): number {
	const a = Number.isFinite(activation) ? Math.min(1, Math.max(0, activation)) : 0;
	// Normalize bounds so 0 ≤ lo ≤ hi even if a hand-built config inverted them OR made BOTH negative.
	// `hi` is floored at `lo` (already ≥ 0) so a config with both bounds negative cannot leave `hi`
	// negative and return a negative interval (an invalid config must look "longest interval", never
	// "already overdue by a negative amount").
	const lo = Math.max(0, Math.min(config.minIntervalMs, config.maxIntervalMs));
	const hi = Math.max(lo, config.minIntervalMs, config.maxIntervalMs);
	const raw = hi * (1 - a); // A=1 → 0 (clamped up to lo); A=0 → hi.
	return Math.min(hi, Math.max(lo, raw));
}

/**
 * Is a memory DUE for re-verification (PRD-058e)? True when the time since its last
 * check (`nowMs − lastCheckedMs`) has reached its activation-paced interval. A
 * never-checked memory (`lastCheckedMs === null`) is always due. RULES:
 *  - The higher-`A_actr` memory's interval is shorter, so at equal last-check age it
 *    becomes due FIRST (AC-55e.3.1).
 *  - A cold memory's interval is the longest bounded value, so it is deferred but
 *    eventually due (AC-55e.3.2). Pure.
 */
export function isDueForReverify(
	activation: number,
	lastCheckedMs: number | null,
	nowMs: number,
	config: ReverifyScheduleConfig = DEFAULT_REVERIFY_SCHEDULE,
): boolean {
	if (lastCheckedMs === null || !Number.isFinite(lastCheckedMs)) return true; // never checked → due.
	const interval = reverifyIntervalMs(activation, config);
	return nowMs - lastCheckedMs >= interval;
}
