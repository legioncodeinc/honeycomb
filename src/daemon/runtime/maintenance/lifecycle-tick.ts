/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * Periodic lifecycle maintenance ticks — the L-W7 / L-W8 / L-W9 schedulers.
 *
 * Wave 1 shipped the cadence math (`reverify-schedule.ts`, `access-log.ts compactAccessLog`,
 * `calibration.ts`) with ZERO production callers. The route modules
 * ({@link mountReverifyApi}, {@link mountCompactAccessLogApi}, {@link mountCalibrateApi}) are the
 * HTTP triggers; THIS module is the PERIODIC trigger that fires each pass on its own cadence without
 * a manual `POST`. Mirrors {@link startPollinatingMaintenanceTick} (PRD-024): a self-rescheduling
 * `setTimeout` per worker so a check that hangs can never overlap the next one. Unrefs each timer so
 * a pending tick never keeps the process alive alone. Fail-soft: a tick failure is swallowed and the
 * next tick is rescheduled — a maintenance miss NEVER breaks recall.
 *
 * The three cadences (PRD-058c/058e):
 *   - `lifecycle_reverify`        ~5 min   (the reverify scan + stale-ref re-check).
 *   - `lifecycle_compact_access`  ~5 min   (fold raw `memory_access` events into `access_count`).
 *   - `lifecycle_calibrate`       ~1 hour  (fit + adopt a calibration curve).
 *
 * Each tick calls the SAME pass function the route calls — there is one definition of the work. The
 * route is for operators; this is the autopilot. Both are fail-soft.
 */

/** Default cadence for the reverify maintenance tick (L-W7 / PRD-058c). Five minutes. */
export const DEFAULT_REVERIFY_TICK_INTERVAL_MS = 5 * 60 * 1_000;

/** Default cadence for the access-log compaction tick (L-W8 / PRD-058e). Five minutes. */
export const DEFAULT_COMPACT_ACCESS_TICK_INTERVAL_MS = 5 * 60 * 1_000;

/** Default cadence for the calibration refit tick (L-W9 / PRD-058e). One hour. */
export const DEFAULT_CALIBRATE_TICK_INTERVAL_MS = 60 * 60 * 1_000;

/** Handle returned by {@link startLifecycleTick} for shutdown cleanup. */
export interface LifecycleTickHandle {
	/** Cancel the pending tick and stop rescheduling. Idempotent. */
	stop(): void;
}

/** Injectable timer seams for deterministic tests. */
export interface LifecycleTickOptions {
	/** Tick cadence in ms. Required (each worker has its own default the caller threads in). */
	readonly intervalMs: number;
	/** Timer scheduler (real `setTimeout` when omitted). */
	readonly setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
	/** Timer canceller (real `clearTimeout` when omitted). */
	readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Start ONE self-rescheduling lifecycle maintenance tick. Calls `pass()` on the cadence; the pass
 * is the SAME function the corresponding route invokes (one definition of the work). FAIL-SOFT: a
 * rejected pass is swallowed (the maintenance posture — a miss never breaks recall), and the next
 * tick is rescheduled regardless. Unrefs each timer so the tick never keeps the process alive alone.
 * Returns a handle whose `stop()` cancels the pending tick. Idempotent stop.
 *
 * The `kind` label is purely diagnostic (logged on each tick + on a swallowed failure) so an operator
 * reading stderr can tell the three ticks apart. It is NOT a queue job kind here — the tick IS the
 * trigger, mirroring {@link startPollinatingMaintenanceTick}.
 */
export function startLifecycleTick(
	kind: string,
	pass: () => Promise<void>,
	options: LifecycleTickOptions,
): LifecycleTickHandle {
	const intervalMs = Math.max(1_000, Math.trunc(options.intervalMs));
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? clearTimeout;

	let stopped = false;
	let handle: ReturnType<typeof setTimeout> | null = null;

	const schedule = (): void => {
		if (stopped) return;
		handle = setTimer(tick, intervalMs);
		if (typeof (handle as NodeJS.Timeout).unref === "function") {
			(handle as NodeJS.Timeout).unref();
		}
	};

	const tick = (): void => {
		handle = null;
		void pass()
			.catch((err: unknown) => {
				// Fail-soft: a maintenance miss never breaks recall. Log to stderr so an operator can see it,
				// then reschedule — the next tick retries. The error shape is best-effort (mirrors the
				// assemble.ts mount-failure logging posture: err.message if Error, else String(err)).
				const reason = err instanceof Error ? err.message : String(err);
				process.stderr.write(`honeycomb: ${kind} maintenance tick failed (non-fatal): ${reason}\n`);
			})
			.finally(schedule);
	};

	schedule();
	return {
		stop(): void {
			stopped = true;
			if (handle !== null) {
				clearTimer(handle);
				handle = null;
			}
		},
	};
}
