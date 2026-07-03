/**
 * C-3 — pollinating maintenance tick calls `checkAndEnqueuePollinating` on an interval.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS,
	startPollinatingMaintenanceTick,
} from "../../../../src/daemon/runtime/pollinating/maintenance-tick.js";
import type { PollinatingTickResult } from "../../../../src/daemon/runtime/pollinating/trigger.js";
import type { PollinatingTrigger } from "../../../../src/daemon/runtime/pollinating/trigger.js";

describe("C-3 pollinating maintenance tick", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("invokes checkAndEnqueuePollinating on the configured interval", async () => {
		vi.useFakeTimers();
		const calls: PollinatingTickResult[] = [];
		const trigger = {
			checkAndEnqueuePollinating: vi.fn(async (): Promise<PollinatingTickResult> => {
				const result: PollinatingTickResult = {
					decision: "below_threshold",
					reason: "below-threshold",
					tokens: 0,
				};
				calls.push(result);
				return result;
			}),
		} as unknown as PollinatingTrigger;

		const handle = startPollinatingMaintenanceTick(
			trigger,
			{ agentId: "default" },
			{
				intervalMs: DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS,
			},
		);

		expect(trigger.checkAndEnqueuePollinating).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS);
		expect(trigger.checkAndEnqueuePollinating).toHaveBeenCalledTimes(1);
		expect(trigger.checkAndEnqueuePollinating).toHaveBeenCalledWith({ agentId: "default" });

		await vi.advanceTimersByTimeAsync(DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS);
		expect(trigger.checkAndEnqueuePollinating).toHaveBeenCalledTimes(2);
		expect(calls).toHaveLength(2);

		handle.stop();
		await vi.advanceTimersByTimeAsync(DEFAULT_POLLINATING_MAINTENANCE_INTERVAL_MS);
		expect(trigger.checkAndEnqueuePollinating).toHaveBeenCalledTimes(2);
	});
});
