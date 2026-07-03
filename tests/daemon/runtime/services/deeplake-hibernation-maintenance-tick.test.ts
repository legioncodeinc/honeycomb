/**
 * Integration proof for the consolidated design's tick-coverage gap: PRD-223's
 * pollinating maintenance tick calls `checkAndEnqueuePollinating`, which queries
 * Deeplake, so if the hibernation controller did NOT manage it the tick would keep
 * the Activeloop pod warm forever and silently defeat scale-to-zero.
 *
 * These tests wire the REAL {@link createDeepLakeHibernation} controller to the REAL
 * {@link startPollinatingMaintenanceTick} handle through the SAME `Pausable` shape
 * `assemble.ts` registers (pause → stop + drop the handle; resume → re-arm a fresh
 * tick, because the handle self-schedules and is not restartable after stop()).
 *
 * Verification posture mirrors the controller suite: a manual clock + a single-slot
 * fake timer drive the controller, and the tick gets its own injected timer seam so
 * ticks fire deterministically — no real timers, no network.
 */

import { describe, expect, it, vi } from "vitest";

import {
	createDeepLakeHibernation,
	type Pausable,
} from "../../../../src/daemon/runtime/services/deeplake-hibernation.js";
import {
	type PollinatingMaintenanceTickHandle,
	startPollinatingMaintenanceTick,
} from "../../../../src/daemon/runtime/pollinating/maintenance-tick.js";
import type {
	PollinatingScope,
	PollinatingTickResult,
	PollinatingTrigger,
} from "../../../../src/daemon/runtime/pollinating/trigger.js";

/** Flush pending microtasks / async transitions via one real macrotask. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A manual clock + a single-slot fake timer for the hibernation controller. */
function hibHarness() {
	let t = 0;
	let pending: { cb: () => void; at: number; id: number } | null = null;
	let nextId = 1;
	return {
		now: (): number => t,
		timers: {
			setTimer: (cb: () => void, ms: number): unknown => {
				const id = nextId++;
				pending = { cb, at: t + ms, id };
				return id;
			},
			clearTimer: (id: unknown): void => {
				if (pending?.id === id) pending = null;
			},
		},
		advance(ms: number): void {
			t += ms;
			while (pending && pending.at <= t) {
				const cur = pending;
				pending = null;
				cur.cb();
			}
		},
	};
}

/** A single-slot injected timer seam for the maintenance tick, fired on demand. */
function tickScheduler() {
	let pending: (() => void) | null = null;
	return {
		setTimer: (cb: () => void): ReturnType<typeof setTimeout> => {
			pending = cb;
			return 0 as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (): void => {
			pending = null;
		},
		/** Fire the currently-scheduled tick callback, if any. */
		fire(): void {
			const cur = pending;
			pending = null;
			cur?.();
		},
		hasPending: (): boolean => pending !== null,
	};
}

/** A fake trigger counting `checkAndEnqueuePollinating` calls (a below-threshold no-op result). */
function fakeTrigger() {
	return {
		checkAndEnqueuePollinating: vi.fn(
			async (): Promise<PollinatingTickResult> => ({
				decision: "below_threshold",
				reason: "below-threshold",
				tokens: 0,
			}),
		),
	} as unknown as PollinatingTrigger & { checkAndEnqueuePollinating: ReturnType<typeof vi.fn> };
}

describe("AC-H.8 the PRD-223 pollinating maintenance tick is a hibernation-managed handle", () => {
	const scope: PollinatingScope = { agentId: "default" };

	it("stops the tick while hibernated and re-arms a live tick on wake", async () => {
		const h = hibHarness();
		const sched = tickScheduler();
		const trigger = fakeTrigger();

		// Wire the tick as a Pausable EXACTLY like assemble.ts does: pause stops + drops the
		// handle, resume re-arms a fresh one (a stopped tick cannot be restarted in place).
		let maintenanceTick: PollinatingMaintenanceTickHandle | null = null;
		const armTick = (): void => {
			if (maintenanceTick === null) {
				maintenanceTick = startPollinatingMaintenanceTick(trigger, scope, {
					setTimer: sched.setTimer,
					clearTimer: sched.clearTimer,
				});
			}
		};
		armTick();
		const tickPausable: Pausable = {
			label: "pollinating-maintenance-tick",
			pause: () => {
				if (maintenanceTick !== null) {
					maintenanceTick.stop();
					maintenanceTick = null;
				}
			},
			resume: armTick,
		};

		const hib = createDeepLakeHibernation({
			pausables: [tickPausable],
			config: { enabled: true, idleMs: 30_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();

		// While active, the tick fires and reschedules itself (queries Deeplake each pass).
		expect(sched.hasPending()).toBe(true);
		sched.fire();
		await flush();
		expect(trigger.checkAndEnqueuePollinating).toHaveBeenCalledTimes(1);
		expect(sched.hasPending()).toBe(true); // rescheduled

		// Idle window elapses → hibernate → the tick is stopped and its timer is cancelled,
		// so no further Deeplake query is issued while hibernated (the pod can scale to zero).
		h.advance(30_000);
		await flush();
		expect(hib.isHibernated()).toBe(true);
		expect(sched.hasPending()).toBe(false);
		const callsWhileHibernated = trigger.checkAndEnqueuePollinating.mock.calls.length;

		// An inbound request wakes the daemon → the tick is re-armed with a fresh handle.
		hib.touch();
		await flush();
		expect(hib.isHibernated()).toBe(false);
		expect(sched.hasPending()).toBe(true);

		// The re-armed tick fires again — proving it genuinely resumed (not a dead handle).
		sched.fire();
		await flush();
		expect(trigger.checkAndEnqueuePollinating.mock.calls.length).toBe(callsWhileHibernated + 1);
	});
});
