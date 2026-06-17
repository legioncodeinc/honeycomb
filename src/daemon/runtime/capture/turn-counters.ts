/**
 * Per-turn counters that cue background workers (PRD-005a FR-8 / a-AC-5 / D-1).
 *
 * Capture is the cheap, always-on front of the system. On a turn-terminating
 * event it bumps two per-session counters and, when a threshold is crossed,
 * ENQUEUES a cue-job to the `memory_jobs` queue (D-1) for the summary worker
 * and/or the skillify miner. It NEVER runs a worker inline — the workers
 * themselves are PRD-006 / skillify (out of scope here). This module owns the
 * counting + threshold logic; the capture handler owns the enqueue side effect.
 *
 * ── Counter model (D-1, documented per the brief) ────────────────────────────
 * v1 keeps the counters in an in-memory per-session `Map` on the daemon. The
 * daemon is the single, long-lived process, so an in-process map is sufficient
 * and avoids a storage round-trip on the hot capture path. The trade-off: a
 * daemon restart resets the counters, so at most one threshold crossing is
 * delayed across a restart — acceptable because the cue is an OPTIMIZATION (the
 * workers also run on their own cadence), not a correctness invariant. A durable
 * counter (a `memory_jobs`-adjacent table) is a later refinement if needed.
 *
 * ── Thresholds (D-1 defaults; configurable) ──────────────────────────────────
 *   - summary  every ~20 messages  → enqueue a `summary` cue-job
 *   - skillify every ~10 turns     → enqueue a `skillify` cue-job
 *
 * ── The Stop-event seam (FR-8 impl-note) ─────────────────────────────────────
 * {@link tryStopCounterTrigger} models the Stop-event path: a Stop event may fire
 * the skillify miner INDEPENDENTLY of the summary worker. 005a wires the seam
 * (the turn-count bump + the skillify cue) so the Stop path is honoured; the
 * miner itself is elsewhere.
 */

/** A cue the capture handler should enqueue to `memory_jobs` (NOT run inline). */
export interface MemoryCue {
	/** The job kind: `"summary"` or `"skillify"`. Routes to its worker (PRD-006). */
	readonly kind: "summary" | "skillify";
	/** The session whose threshold crossing produced the cue. */
	readonly sessionId: string;
	/** The conversation path the cue pertains to (FR-6 grouping key). */
	readonly path: string;
	/** The counter value at the crossing, for the worker's diagnostics. */
	readonly count: number;
}

/** Threshold tuning (D-1). All optional; each falls back to the documented default. */
export interface TurnCounterConfig {
	/** Messages between summary cues. Default 20. */
	readonly summaryEveryMessages?: number;
	/** Turns between skillify cues. Default 10. */
	readonly skillifyEveryTurns?: number;
	/**
	 * Hard cap on the number of distinct sessions tracked in the in-memory map
	 * (memory-exhaustion guard). When a new session would exceed this cap, the
	 * oldest-inserted session's counts are evicted first (FIFO). Default
	 * {@link DEFAULT_MAX_SESSIONS}.
	 */
	readonly maxSessions?: number;
}

/** The D-1 default: a summary cue every ~20 messages. */
export const DEFAULT_SUMMARY_EVERY_MESSAGES = 20;
/** The D-1 default: a skillify cue every ~10 turns. */
export const DEFAULT_SKILLIFY_EVERY_TURNS = 10;
/**
 * Default hard cap on tracked sessions. `sessionId` is attacker-controllable
 * request metadata on the always-on capture hot path; without a cap an attacker
 * could send unbounded distinct session ids and grow this map without bound
 * (memory-exhaustion DoS). 50k entries is far above any legitimate concurrent
 * session count yet bounds worst-case memory to a few MB. Each entry is two
 * small integers, so eviction never loses durable state — the counters are an
 * optimization (cues also fire on the workers' own cadence), not a correctness
 * invariant (see the D-1 module note), so evicting the oldest session at worst
 * delays one cue for a long-idle session.
 */
export const DEFAULT_MAX_SESSIONS = 50_000;

/** A session's running counts. */
interface SessionCounts {
	/** Messages captured for this session since the last summary cue boundary. */
	messages: number;
	/** Turn-terminating events seen for this session. */
	turns: number;
}

/**
 * The per-session counter store (D-1). Construct one per daemon; the capture
 * handler bumps it on every accepted event and reads back the cues to enqueue.
 */
export class TurnCounters {
	private readonly summaryEvery: number;
	private readonly skillifyEvery: number;
	private readonly maxSessions: number;
	private readonly counts = new Map<string, SessionCounts>();

	constructor(config: TurnCounterConfig = {}) {
		this.summaryEvery = config.summaryEveryMessages ?? DEFAULT_SUMMARY_EVERY_MESSAGES;
		this.skillifyEvery = config.skillifyEveryTurns ?? DEFAULT_SKILLIFY_EVERY_TURNS;
		// Clamp to at least 1 so a misconfigured 0/negative cap can never disable
		// tracking entirely (which would silently drop every cue).
		const cap = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.maxSessions = Number.isFinite(cap) && cap >= 1 ? Math.trunc(cap) : DEFAULT_MAX_SESSIONS;
	}

	/**
	 * Get-or-create the counts for a session. Creating a NEW session enforces the
	 * {@link DEFAULT_MAX_SESSIONS} cap first: if the map is at capacity, the
	 * oldest-inserted session is evicted (FIFO via Map insertion order) before the
	 * new one is recorded, so an attacker streaming unbounded distinct session ids
	 * can never grow this in-memory map without bound (memory-exhaustion DoS guard).
	 */
	private entry(sessionId: string): SessionCounts {
		let e = this.counts.get(sessionId);
		if (e === undefined) {
			if (this.counts.size >= this.maxSessions) {
				// Evict the oldest entry (first key in insertion order) to make room.
				const oldest = this.counts.keys().next().value;
				if (oldest !== undefined) this.counts.delete(oldest);
			}
			e = { messages: 0, turns: 0 };
			this.counts.set(sessionId, e);
		}
		return e;
	}

	/**
	 * Record one captured EVENT (message) for a session and, when the summary
	 * threshold is crossed, return a `summary` cue to enqueue. Returns `null`
	 * below the threshold. Every accepted event bumps the message count (FR-8); a
	 * turn-terminating event additionally bumps the turn count via
	 * {@link recordTurnTermination}.
	 */
	recordMessage(sessionId: string, path: string): MemoryCue | null {
		const e = this.entry(sessionId);
		e.messages += 1;
		if (e.messages % this.summaryEvery === 0) {
			return { kind: "summary", sessionId, path, count: e.messages };
		}
		return null;
	}

	/**
	 * Record a turn-terminating event (FR-8 / a-AC-5) and, when the skillify
	 * threshold is crossed, return a `skillify` cue to enqueue. Returns `null`
	 * below the threshold. This is the {@link tryStopCounterTrigger} mechanism:
	 * the Stop-event path may fire skillify independently of summary, which is
	 * exactly a turn-count crossing here.
	 */
	recordTurnTermination(sessionId: string, path: string): MemoryCue | null {
		const e = this.entry(sessionId);
		e.turns += 1;
		if (e.turns % this.skillifyEvery === 0) {
			return { kind: "skillify", sessionId, path, count: e.turns };
		}
		return null;
	}

	/** Current counts for a session (testing / diagnostics). */
	peek(sessionId: string): { messages: number; turns: number } {
		const e = this.counts.get(sessionId);
		return { messages: e?.messages ?? 0, turns: e?.turns ?? 0 };
	}

	/** Number of distinct sessions currently tracked (bounded by the cap). */
	size(): number {
		return this.counts.size;
	}
}

/**
 * The Stop-event trigger (FR-8 impl-note): a Stop event evaluates the per-turn
 * counter and may produce a skillify cue independently of the summary worker.
 * Thin wrapper over {@link TurnCounters.recordTurnTermination} named for the
 * `tryStopCounterTrigger` notion in the PRD so the call site reads intentionally
 * and the Stop path is explicit at the handler.
 */
export function tryStopCounterTrigger(counters: TurnCounters, sessionId: string, path: string): MemoryCue | null {
	return counters.recordTurnTermination(sessionId, path);
}
