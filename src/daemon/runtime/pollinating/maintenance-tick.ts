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
	/** Clear the interval. Idempotent. */
	stop(): void;
}

/** Injectable timer seams for deterministic tests. */
export interface PollinatingMaintenanceTickOptions {
	/** Tick cadence in ms. Defaults to {@link DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Timer scheduler (real `setInterval` when omitted). */
	readonly setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
	/** Timer canceller (real `clearInterval` when omitted). */
	readonly clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Start the pollinating maintenance tick for one agent scope. Unrefs the timer so it
 * never keeps the process alive alone. Returns a handle whose `stop()` clears the timer.
 */
export function startPollinatingMaintenanceTick(
	trigger: PollinatingTrigger,
	scope: PollinatingScope,
	options: PollinatingMaintenanceTickOptions = {},
): PollinatingMaintenanceTickHandle {
	const intervalMs = options.intervalMs ?? DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS;
	const setTimer = options.setTimer ?? setInterval;
	const clearTimer = options.clearTimer ?? clearInterval;
	const tick = (): void => {
		void trigger.checkAndEnqueuePollinating(scope).catch(() => {
			/* fail-soft: a storage blip on the tick must not crash the daemon */
		});
	};
	const handle = setTimer(tick, intervalMs);
	if (typeof (handle as NodeJS.Timeout).unref === "function") {
		(handle as NodeJS.Timeout).unref();
	}
	return {
		stop(): void {
			clearTimer(handle);
		},
	};
}
