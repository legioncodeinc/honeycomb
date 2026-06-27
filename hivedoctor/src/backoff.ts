/**
 * HiveDoctor geometric backoff (PRD-064a scope + technical considerations).
 *
 * "Geometric with jitter, floor 1s, ceiling 30s; persisted rung; reset on healthy"
 * (064a). Mirrors the bounded-backoff precedent in src/daemon/runtime/services/
 * embed-supervisor.ts (a fixed `restartBackoffMs` there; HiveDoctor generalizes it to
 * a geometric schedule with jitter and a persisted rung so a reboot does not reset a
 * crash loop's memory - 064a technical considerations).
 *
 * The "rung" here is the BACKOFF rung (the geometric step count), distinct from the
 * REMEDIATION rung (which ladder action runs). It is a pure, injectable-RNG value
 * object: no timers, no I/O. The supervisor owns the persistence (writes the rung to
 * state.json) and the sleeping; this module only computes the next delay and advances
 * or resets the rung. Keeping it pure makes it trivially testable with a seeded RNG.
 *
 * Built-ins only (no npm); the RNG is injected so tests are deterministic.
 */

/** Tuning for {@link createBackoff}. */
export interface BackoffOptions {
	/** Floor delay in ms (the rung-0 base, before jitter). */
	readonly floorMs: number;
	/** Ceiling delay in ms (the geometric series is clamped here). */
	readonly ceilingMs: number;
	/**
	 * Jitter fraction in [0, 1]. The computed delay is multiplied by a random factor in
	 * `[1 - jitter, 1 + jitter]` (clamped to the ceiling), spreading retries so many
	 * boxes that flapped together do not stampede the daemon in lockstep. Default 0.2.
	 */
	readonly jitter?: number;
	/** Injected RNG returning [0, 1); defaults to Math.random. */
	readonly random?: () => number;
	/** The starting rung (default 0), used to rehydrate from persisted state across restarts. */
	readonly initialRung?: number;
}

/** A pure backoff state machine over a geometric, jittered, clamped schedule. */
export interface Backoff {
	/** The current backoff rung (0-based geometric step count). Persist this to state.json. */
	readonly rung: number;
	/**
	 * Compute the delay for the CURRENT rung (floor * 2^rung, clamped to ceiling, then
	 * jittered). Pure aside from the injected RNG; does not advance the rung.
	 */
	delayMs(): number;
	/** Advance to the next rung (call after a failed attempt). Returns the new rung. */
	advance(): number;
	/** Reset to rung 0 (call on a confirmed return to healthy - 064a). */
	reset(): void;
}

/** Clamp `n` into `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
	if (n < lo) return lo;
	if (n > hi) return hi;
	return n;
}

/**
 * Build a backoff machine. `floorMs` and `ceilingMs` are assumed already normalized by
 * config resolution (ceiling >= floor); this module clamps defensively anyway so a
 * direct caller cannot produce a negative or inverted delay.
 */
export function createBackoff(options: BackoffOptions): Backoff {
	const floor = Math.max(1, Math.floor(options.floorMs));
	const ceiling = Math.max(floor, Math.floor(options.ceilingMs));
	const jitter = clamp(options.jitter ?? 0.2, 0, 1);
	const random = options.random ?? Math.random;
	let rung = Math.max(0, Math.floor(options.initialRung ?? 0));

	return {
		get rung(): number {
			return rung;
		},
		delayMs(): number {
			// Geometric base: floor * 2^rung, clamped to the ceiling BEFORE jitter so the jitter
			// band is centered on the clamped value (a huge rung does not overflow via 2^rung
			// because we clamp the exponent's effect through Math.min on the ratio).
			const factor = rung >= 30 ? ceiling / floor : 2 ** rung;
			const base = clamp(floor * factor, floor, ceiling);
			// Symmetric multiplicative jitter in [1 - jitter, 1 + jitter].
			const jittered = base * (1 - jitter + random() * (2 * jitter));
			return Math.round(clamp(jittered, floor, ceiling));
		},
		advance(): number {
			rung += 1;
			return rung;
		},
		reset(): void {
			rung = 0;
		},
	};
}
