/**
 * The 30-minute auto-update poll loop (PRD-064e AC-064e.1 / .4 / .6).
 *
 * Wakes on a 30-minute TTL, jittered to avoid a thundering herd against npm + the
 * install CDN (PRD-064e Scope: "jittered to avoid a thundering herd"), and on each tick
 * runs ONE update transaction through {@link file://./update-engine.ts}. The loop owns
 * the cadence; the engine owns the gate + the transaction. Serialization with the watch
 * loop's rung-2 reinstall is the engine's job (the shared install lock), so two installs
 * can never overlap even though the poll runs on its own timer (AC-064e.6).
 *
 * Opt-out (AC-064e.4): when `autoUpdateDisabled` is true the loop NEVER ticks -- it is a
 * no-op `start()` -- so a disabled box does no registry/CDN polling at all. (The engine
 * ALSO declines via the gate; this is belt-and-suspenders so a disabled install is
 * completely quiet on the network.)
 *
 * Determinism: the clock + sleep are injected (the same {@link PollClock} shape the
 * supervisor uses), so a test drives ticks without real timers. The jitter source is
 * injected too, so the jittered delay is reproducible.
 *
 * Crash-safety (design principle 1): a transaction NEVER throws (the engine resolves a
 * value), but the per-tick call is ALSO wrapped so even an unexpected throw is logged and
 * swallowed -- the loop keeps polling. `start()` resolves when `stop()` is called.
 */

import type { Logger } from "../logger.js";
import type { UpdateEngine, UpdateTransactionResult } from "./update-engine.js";

/** The default poll TTL: 30 minutes (PRD-064e). */
export const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000;

/** The default jitter fraction: up to +/-10% of the interval. */
export const DEFAULT_JITTER_FRACTION = 0.1;

/** Injected clock + scheduler so tests drive time deterministically (mirrors SupervisorClock). */
export interface PollClock {
	/** Sleep `ms`. */
	sleep(ms: number): Promise<void>;
	/** Current wall-clock ms (unused by the cadence, provided for parity/telemetry). */
	now(): number;
}

/** Construction deps for {@link createUpdatePollLoop}. */
export interface UpdatePollLoopDeps {
	/** The update engine the loop ticks. */
	readonly engine: UpdateEngine;
	/** Logger. */
	readonly logger: Logger;
	/** Injected clock/timer. */
	readonly clock: PollClock;
	/**
	 * True when auto-update is disabled (`--no-auto-update`, env, or a pin). A disabled
	 * loop never ticks and never polls the network (AC-064e.4).
	 */
	readonly autoUpdateDisabled: boolean;
	/** Base poll TTL in ms (default {@link DEFAULT_POLL_INTERVAL_MS}). */
	readonly pollIntervalMs?: number;
	/** Jitter fraction in [0,1) applied to the interval (default {@link DEFAULT_JITTER_FRACTION}). */
	readonly jitterFraction?: number;
	/** Injected jitter source returning [0,1) (default `Math.random`), so jitter is reproducible. */
	readonly random?: () => number;
}

/** The poll-loop surface. */
export interface UpdatePollLoop {
	/** Arm + run the poll loop (resolves when `stop()` is called). Idempotent. No-op when disabled. */
	start(): Promise<void>;
	/** Disarm the poll loop. Idempotent. */
	stop(): void;
	/**
	 * Run exactly ONE poll tick (an update transaction). Exposed so tests can step the
	 * loop without the interval wait. Crash-safe: never throws. Returns the transaction
	 * result, or null when the loop is disabled.
	 */
	tick(): Promise<UpdateTransactionResult | null>;
}

/**
 * Compute a jittered delay: `interval * (1 + jitter * (2*rand - 1))`, clamped to a
 * non-negative integer. With jitter 0.1 and rand in [0,1), the delay lands in
 * [0.9*interval, 1.1*interval).
 */
export function jitteredDelay(intervalMs: number, jitterFraction: number, rand: number): number {
	const clampedFraction = jitterFraction < 0 ? 0 : jitterFraction >= 1 ? 0.999 : jitterFraction;
	const offset = clampedFraction * (2 * rand - 1);
	const delay = Math.round(intervalMs * (1 + offset));
	return delay < 0 ? 0 : delay;
}

/** Build the auto-update poll loop. */
export function createUpdatePollLoop(deps: UpdatePollLoopDeps): UpdatePollLoop {
	const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const jitterFraction = deps.jitterFraction ?? DEFAULT_JITTER_FRACTION;
	const random = deps.random ?? Math.random;

	let running = false;

	async function tick(): Promise<UpdateTransactionResult | null> {
		// A disabled loop never ticks -- no registry/CDN poll at all (AC-064e.4).
		if (deps.autoUpdateDisabled) return null;
		try {
			const result = await deps.engine.runUpdateTransaction();
			deps.logger.debug("autoupdate.tick", { status: result.status });
			return result;
		} catch (error) {
			// The engine should never throw, but the loop must keep polling regardless.
			deps.logger.error("autoupdate.tick_threw", {
				reason: error instanceof Error ? error.message : "unknown",
			});
			return { status: "install_failed", detail: "tick-threw" };
		}
	}

	return {
		tick,

		async start(): Promise<void> {
			// Honest opt-out: a disabled loop is a no-op start (it never arms a timer).
			if (deps.autoUpdateDisabled) {
				deps.logger.info("autoupdate.disabled");
				return;
			}
			if (running) return;
			running = true;
			deps.logger.info("autoupdate.loop_start", { intervalMs });

			while (running) {
				// Sleep a jittered interval FIRST so the loop does not stampede an update on boot
				// (the first poll lands ~30 min after start, jittered).
				const delay = jitteredDelay(intervalMs, jitterFraction, random());
				await deps.clock.sleep(delay);
				if (!running) break;
				await tick();
			}
		},

		stop(): void {
			running = false;
		},
	};
}
