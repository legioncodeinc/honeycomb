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
 * Periodic pollinating maintenance tick — calls {@link PollinatingTrigger.checkAndEnqueuePollinating}
 * on an interval so the token-budget loop can fire without a manual diagnostics POST. The trigger's
 * own enable/threshold/pending gates decide whether a pass is enqueued; this module only schedules
 * the check. Fail-soft: a tick failure never throws out of the timer.
 */

import type { PollinatingScope, PollinatingTrigger } from "./trigger.js";

/** Default maintenance interval: one minute (cheap counter read + optional enqueue). */
export const DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS = 60_000;

/** Handle returned by {@link startPollinatingMaintenanceTick} for shutdown cleanup. */
export interface PollinatingMaintenanceTickHandle {
	/** Cancel the pending tick and stop rescheduling. Idempotent. */
	stop(): void;
}

/** Injectable timer seams for deterministic tests. */
export interface PollinatingMaintenanceTickOptions {
	/** Tick cadence in ms. Defaults to {@link DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Timer scheduler (real `setTimeout` when omitted). */
	readonly setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
	/** Timer canceller (real `clearTimeout` when omitted). */
	readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Start the pollinating maintenance tick for one agent scope. Uses a self-rescheduling
 * `setTimeout` rather than `setInterval` so a check that hangs can never overlap the
 * next one — the next tick is scheduled only after the current check settles. Unrefs
 * each timer so it never keeps the process alive alone. Returns a handle whose
 * `stop()` cancels the pending tick.
 */
export function startPollinatingMaintenanceTick(
	trigger: PollinatingTrigger,
	scope: PollinatingScope,
	options: PollinatingMaintenanceTickOptions = {},
): PollinatingMaintenanceTickHandle {
	const intervalMs = options.intervalMs ?? DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS;
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
		void trigger
			.checkAndEnqueuePollinating(scope)
			.catch(() => {
				/* fail-soft: a storage blip on the tick must not crash the daemon */
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
