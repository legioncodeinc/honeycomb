/**
 * Adaptive poll-loop runner — PRD-062b (L-B1 / L-B2, AC-2 / AC-3 / AC-9).
 *
 * ── Why a shared runner ──────────────────────────────────────────────────────
 * Both the pipeline stage worker and the pollinating worker (and the consolidated
 * lease coordinator) run the SAME poll loop: tick → skip-if-in-flight → run one
 * lease pass → schedule the next tick. PRD-062b adds adaptive backoff (idle →
 * slow, lease → fast) to that loop. Inlining the loop in each worker would
 * triple-duplicate it past the jscpd threshold and let the three copies drift. So
 * the loop lives here ONCE and every consumer drives it through the same seam.
 *
 * ── Two cadences behind one seam (the AC-9 parity contract) ──────────────────
 * - Backoff OFF (the pre-PRD path): a FLAT repeating interval at `flatIntervalMs`,
 *   driven by a single `setTimer(cb, ms)` registration — byte-for-byte the legacy
 *   `setInterval(cb, 1000)` behavior. With every PRD-062b flag off the daemon
 *   reproduces exactly this (parent AC-9), so a regression is a config rollback.
 * - Backoff ON: a SELF-RESCHEDULING one-shot loop. Each tick runs one lease pass,
 *   feeds the outcome to the {@link PollBackoff} state machine (empty → step toward
 *   the ceiling, leased → reset to the floor, AC-2 / AC-3), then re-arms a fresh
 *   `setTimer(cb, nextDelayMs)`. The injected `setTimer`/`clearTimer` seam is the
 *   SAME one the workers already expose, so the existing manual-clock test harness
 *   drives both cadences without change.
 *
 * ── The overlap guard is preserved ───────────────────────────────────────────
 * The "skip a tick if the previous run is still in flight" guard the workers shipped
 * (`running` flag) is preserved here and composes with backoff: a skipped tick does
 * NOT feed the state machine (it did no lease work), so a slow run never spuriously
 * resets or steps the backoff.
 *
 * ── No clock-of-record, no I/O ───────────────────────────────────────────────
 * The runner owns no DeepLake access and no wall clock. It calls the injected
 * `tick()` (which does the one lease pass and returns whether a job was processed)
 * and the injected `setTimer`/`clearTimer`. That keeps it unit-testable with the
 * manual-clock fake the workers already use.
 */

import { PollBackoff, PollBackoffConfigSchema } from "./poll-backoff.js";
import type { PollBackoffConfig } from "./poll-backoff.js";

/** A single lease pass: returns `true` when a job was processed, `false` when idle. */
export type PollTick = () => Promise<boolean>;

/** The injected timer seam (mirrors the workers' `setTimer`/`clearTimer`). */
export interface PollLoopTimers {
	/** Schedule a one-shot callback after `ms`; returns a handle for {@link clearTimer}. */
	readonly setTimer: (cb: () => void, ms: number) => unknown;
	/** Cancel a handle returned by {@link setTimer}. */
	readonly clearTimer: (handle: unknown) => void;
	/** Schedule a repeating callback. Defaults to {@link setTimer} for deterministic tests. */
	readonly setRepeatingTimer?: (cb: () => void, ms: number) => unknown;
	/** Cancel a handle returned by {@link setRepeatingTimer}. Defaults to {@link clearTimer}. */
	readonly clearRepeatingTimer?: (handle: unknown) => void;
}

/** Construction deps for {@link createPollLoop}. */
export interface PollLoopDeps {
	/**
	 * Run ONE lease pass. The runner guards overlap and feeds the boolean outcome to
	 * the backoff machine; the tick itself only does the lease+route+run work.
	 */
	readonly tick: PollTick;
	/** The resolved adaptive-backoff config (its `enabled` flag picks the cadence). */
	readonly backoff: PollBackoffConfig;
	/** The flat interval used when backoff is OFF (the pre-PRD `DEFAULT_POLL_INTERVAL_MS`). */
	readonly flatIntervalMs: number;
	/** The injected timer seam (real timers in prod, a manual clock in tests). */
	readonly timers: PollLoopTimers;
}

/** The poll loop a worker/coordinator starts + stops. */
export interface PollLoop {
	/** Start the loop (flat interval or adaptive self-reschedule per the config). */
	start(): void;
	/** Stop the loop. Idempotent. */
	stop(): void;
	/**
	 * Resume a loop that has SUSPENDED on the long idle backstop (PRD-062e), snapping
	 * its cadence back to the floor so a just-enqueued job is processed immediately.
	 * Wire this to the job queue's `enqueue` so a captured memory does not wait for the
	 * backstop. No-op UNLESS the loop is currently suspended on the backstop, so it never
	 * disturbs the normal adaptive cadence (and is a no-op when suspend is off, when the
	 * loop is stopped, or on the flat path). Idempotent and safe to call at any time.
	 */
	wake(): void;
}

/** The concrete loop. */
class AdaptivePollLoop implements PollLoop {
	private readonly tick: PollTick;
	private readonly flatIntervalMs: number;
	private readonly timers: PollLoopTimers;
	private readonly backoff: PollBackoff | null;
	private handle: unknown;
	private clearHandle: ((handle: unknown) => void) | undefined;
	private stopped = false;
	/** Guards against overlapping ticks on the poll loop (the workers' `running` flag). */
	private running = false;
	/** True while parked on the long idle backstop (PRD-062e); `wake()` clears it. */
	private suspended = false;

	constructor(deps: PollLoopDeps) {
		this.tick = deps.tick;
		this.flatIntervalMs = deps.flatIntervalMs;
		this.timers = deps.timers;
		// Only build the state machine when backoff is active; the flat path never
		// touches it, so a disabled loop is byte-for-byte the legacy interval.
		this.backoff = deps.backoff.enabled ? new PollBackoff(deps.backoff) : null;
	}

	start(): void {
		if (!this.stopped && this.handle !== undefined) return;
		this.stopped = false;
		if (this.backoff === null) {
			// ── Pre-PRD cadence (AC-9): a flat repeating interval. ──────────────────
			const setRepeatingTimer = this.timers.setRepeatingTimer ?? this.timers.setTimer;
			this.clearHandle = this.timers.clearRepeatingTimer ?? this.timers.clearTimer;
			this.handle = setRepeatingTimer(() => {
				this.fireGuarded(null);
			}, this.flatIntervalMs);
			return;
		}
		// ── Adaptive cadence: arm the first tick at the floor, then self-reschedule. ─
		this.scheduleNext(this.backoff.nextDelayMs());
	}

	/** Arm the next one-shot tick (adaptive path only). */
	private scheduleNext(ms: number): void {
		if (this.stopped) return;
		this.clearHandle = this.timers.clearTimer;
		this.handle = this.timers.setTimer(() => {
			this.fireGuarded(this.backoff);
		}, ms);
	}

	/**
	 * One guarded tick. Skips if a previous run is still in flight (never overlap).
	 * On the adaptive path, feeds the lease outcome to the state machine and re-arms
	 * the next tick; on the flat path, the repeating interval re-fires on its own.
	 */
	private fireGuarded(backoff: PollBackoff | null): void {
		if (this.running) return; // overlap guard — a slow run does not feed backoff.
		this.running = true;
		void this.tick()
			.then((processed) => {
				if (backoff === null) return;
				// Lease outcome → step (idle) or reset (leased). AC-2 / AC-3.
				if (processed) backoff.onLease();
				else backoff.onEmptyLease();
			})
			.catch(() => {
				if (backoff !== null) backoff.onEmptyLease();
			})
			.finally(() => {
				this.running = false;
				// Adaptive path re-arms a fresh one-shot at the new delay; flat path
				// relies on the repeating interval and does not reschedule here.
				if (backoff === null) return;
				// PRD-062e: once idle past the suspend threshold, park on the LONG backstop
				// instead of the ~30s ceiling, so DeepLake's compute pod scales to zero. A
				// lease (or wake()) resets the machine, so shouldSuspend() flips back off and
				// the fast cadence resumes. Suspend off → shouldSuspend() is always false and
				// this is byte-for-byte the 062b ceiling behavior.
				if (backoff.shouldSuspend()) {
					this.suspended = true;
					this.scheduleNext(backoff.suspendBackstopMs());
				} else {
					this.suspended = false;
					this.scheduleNext(backoff.nextDelayMs());
				}
			});
	}

	/**
	 * Resume a suspended loop (PRD-062e). Resets the backoff to the floor and, when the
	 * loop is parked on the long backstop and not mid-tick, re-arms the next tick
	 * immediately so a just-enqueued job is picked up without waiting for the backstop.
	 * No-op on the flat path (no backoff machine) or when stopped.
	 */
	wake(): void {
		if (this.backoff === null || this.stopped) return;
		// No-op UNLESS the loop is parked on the long idle backstop — that is the only
		// state a just-enqueued job would otherwise wait out. `suspended` is never set
		// when suspend is off, so this is a true no-op there and the normal adaptive
		// cadence is never disturbed (do not touch the backoff before this guard).
		if (!this.suspended) return;
		this.backoff.resume();
		if (this.running) return; // an in-flight backstop tick's finally() reschedules at the (now) floor.
		this.suspended = false;
		if (this.handle !== undefined) this.timers.clearTimer(this.handle);
		this.scheduleNext(this.backoff.nextDelayMs());
	}

	stop(): void {
		this.stopped = true;
		if (this.handle !== undefined) {
			(this.clearHandle ?? this.timers.clearTimer)(this.handle);
			this.handle = undefined;
			this.clearHandle = undefined;
		}
	}
}

/**
 * Build an {@link PollLoop}. When `deps.backoff.enabled` is false the loop is the
 * exact pre-PRD flat interval (AC-9 parity); when true it self-reschedules with
 * adaptive backoff (AC-2 / AC-3). The overlap guard is preserved in both modes.
 */
export function createPollLoop(deps: PollLoopDeps): PollLoop {
	return new AdaptivePollLoop(deps);
}

/** The poll-loop knobs a worker exposes on its construction deps. */
export interface WorkerPollLoopOptions {
	/** Run ONE lease pass (the worker's `runOnce`). */
	readonly tick: PollTick;
	/** The flat interval when backoff is OFF (the worker's `pollIntervalMs` default). */
	readonly flatIntervalMs: number;
	/** The resolved adaptive-backoff config; un-passed → the schema's disabled default. */
	readonly backoff?: PollBackoffConfig;
	/** Injected timer scheduler (real `setInterval` otherwise). */
	readonly setTimer?: (cb: () => void, ms: number) => unknown;
	/** Injected timer canceller (real `clearInterval` otherwise). */
	readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Build a worker's poll loop from its standard construction knobs (PRD-062b). Both
 * the pipeline stage worker and the pollinating worker construct an identical loop —
 * same flat-interval default, same `setInterval`/`clearInterval` fallback, same
 * disabled-backoff default — so that wiring lives here ONCE rather than being copied
 * into each worker's constructor (jscpd discipline). The loop owns the cadence (flat
 * when backoff is off, the AC-9 pre-PRD path; adaptive self-reschedule when on) and
 * preserves the overlap guard.
 */
export function buildWorkerPollLoop(options: WorkerPollLoopOptions): PollLoop {
	const setTimer =
		options.setTimer ??
		((cb, ms) => {
			// PRD-062b hardening: a background poll timer must NEVER keep the process alive or
			// burden test/shutdown teardown — unref it (mirrors the capture-buffer flush timer).
			const t = setTimeout(cb, ms);
			if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
			return t;
		});
	const clearTimer =
		options.clearTimer ??
		((handle) => {
			if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
		});
	const setRepeatingTimer =
		options.setTimer === undefined
			? (cb: () => void, ms: number) => {
					const t = setInterval(cb, ms);
					if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
					return t;
				}
			: undefined;
	const clearRepeatingTimer =
		options.clearTimer === undefined
			? (handle: unknown) => {
					if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
				}
			: undefined;
	return createPollLoop({
		tick: options.tick,
		backoff: options.backoff ?? PollBackoffConfigSchema.parse({}),
		flatIntervalMs: options.flatIntervalMs,
		timers: { setTimer, clearTimer, setRepeatingTimer, clearRepeatingTimer },
	});
}
