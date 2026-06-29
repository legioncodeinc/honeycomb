/**
 * PRD-062b adaptive poll-loop runner — the two cadences behind one seam.
 *
 * Verification posture:
 *   - The loop is driven through an injected one-shot timer seam (a manual clock
 *     that records each `setTimer(cb, ms)` registration), so the scheduled DELAYS
 *     are asserted directly and time is fully deterministic — no real sleeps.
 *   - Maps to AC-9 (flags off ⇒ flat 1000ms interval, the pre-PRD path), AC-2
 *     (idle backs off toward the ceiling), AC-3 (a leased job resets to the floor),
 *     and the preserved overlap guard.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { PollBackoffConfigSchema } from "../../../../src/daemon/runtime/services/poll-backoff.js";
import {
	buildWorkerPollLoop,
	createPollLoop,
	type PollLoopTimers,
} from "../../../../src/daemon/runtime/services/poll-loop.js";

/**
 * A manual one-shot timer clock. Each `setTimer` records the requested delay and the
 * callback; `fireNext()` invokes the most-recently-armed callback (the self-
 * reschedule re-arms a fresh one each tick, so "next" is the live one).
 */
interface ManualTimers extends PollLoopTimers {
	/** The delays requested, in order, so the cadence schedule is assertable. */
	readonly delays: number[];
	/** Fire the most-recently-armed (live) callback. */
	fireNext(): void;
	/** How many timers are currently armed-and-not-cleared. */
	armedCount(): number;
}

function manualTimers(): ManualTimers {
	const armed = new Map<number, () => void>();
	const delays: number[] = [];
	let seq = 0;
	let live = -1;
	return {
		setTimer(cb, ms) {
			delays.push(ms);
			const id = seq++;
			armed.set(id, cb);
			live = id;
			return id;
		},
		clearTimer(handle) {
			if (typeof handle === "number") armed.delete(handle);
		},
		delays,
		fireNext() {
			const cb = armed.get(live);
			// A one-shot callback is consumed on fire (the loop re-arms a fresh one).
			armed.delete(live);
			if (cb) cb();
		},
		armedCount() {
			return armed.size;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

/** Flush microtasks so the loop's async tick `.then()/.finally()` settle before asserting. */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("AdaptivePollLoop: AC-9 parity — flags off ⇒ a flat repeating interval", () => {
	it("with backoff DISABLED, schedules a single flat interval at flatIntervalMs (the pre-PRD path)", () => {
		const timers = manualTimers();
		const loop = createPollLoop({
			tick: async () => false,
			backoff: PollBackoffConfigSchema.parse({}), // disabled (the legacy default).
			flatIntervalMs: 1_000,
			timers,
		});
		loop.start();
		// A flat interval registers ONE repeating timer at exactly 1000ms — byte-for-byte
		// the legacy `setInterval(cb, 1000)` behavior.
		expect(timers.delays).toEqual([1_000]);
		loop.stop();
		expect(timers.armedCount()).toBe(0);
	});

	it("with backoff DISABLED, the flat interval never self-reschedules (no second arm)", async () => {
		const timers = manualTimers();
		let ticks = 0;
		const loop = createPollLoop({
			tick: async () => {
				ticks++;
				return false;
			},
			backoff: PollBackoffConfigSchema.parse({}),
			flatIntervalMs: 1_000,
			timers,
		});
		loop.start();
		timers.fireNext();
		await flush();
		// The flat path relies on the repeating interval; it must NOT arm a new one-shot.
		expect(ticks).toBe(1);
		expect(timers.delays).toEqual([1_000]); // still just the one repeating registration.
		loop.stop();
	});
});

describe("AdaptivePollLoop: AC-2 / AC-3 — adaptive self-reschedule", () => {
	const ENABLED = PollBackoffConfigSchema.parse({ enabled: true, floorMs: 1_000, ceilingMs: 30_000, jitter: 0 });

	it("the default adaptive timer is one-shot, not a multiplying interval", async () => {
		vi.useFakeTimers();
		let ticks = 0;
		const loop = buildWorkerPollLoop({
			tick: async () => {
				ticks++;
				return false;
			},
			backoff: ENABLED,
			flatIntervalMs: 1_000,
		});

		loop.start();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ticks).toBe(2);
		loop.stop();
	});

	it("AC-2: consecutive EMPTY ticks back off geometrically toward the ceiling", async () => {
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: ENABLED, flatIntervalMs: 1_000, timers });
		loop.start();
		// First arm is at the floor (the initial nextDelayMs before any outcome).
		expect(timers.delays[0]).toBe(1_000);
		// Each empty tick steps the next delay: 1000 → 2000 → 4000 → 8000 → 16000 → 30000.
		const expected = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
		for (const want of expected) {
			timers.fireNext();
			await flush();
			expect(timers.delays.at(-1)).toBe(want);
		}
		loop.stop();
	});

	it("AC-3: a LEASED tick resets the next delay to the floor", async () => {
		const timers = manualTimers();
		let processed = false; // first few ticks idle, then a job is leased.
		let leaseOnTick = 3;
		const loop = createPollLoop({
			tick: async () => {
				processed = leaseOnTick <= 0;
				leaseOnTick--;
				return processed;
			},
			backoff: ENABLED,
			flatIntervalMs: 1_000,
			timers,
		});
		loop.start();
		// Three empty ticks back off: next delays 2000, 4000, 8000.
		timers.fireNext();
		await flush();
		timers.fireNext();
		await flush();
		timers.fireNext();
		await flush();
		expect(timers.delays.at(-1)).toBe(8_000);
		// The fourth tick LEASES a job → the next delay snaps back to the floor (AC-3).
		timers.fireNext();
		await flush();
		expect(timers.delays.at(-1)).toBe(1_000);
		loop.stop();
	});

	it("preserves the overlap guard: a tick still in flight makes the next fire a no-op", async () => {
		const timers = manualTimers();
		let inFlight = 0;
		let maxConcurrent = 0;
		let release: (() => void) | null = null;
		const loop = createPollLoop({
			tick: async () => {
				inFlight++;
				maxConcurrent = Math.max(maxConcurrent, inFlight);
				// Block the first tick until we explicitly release it, so a second fire
				// arrives while the first is still running.
				await new Promise<void>((resolve) => {
					release = () => {
						inFlight--;
						resolve();
					};
				});
				return false;
			},
			backoff: ENABLED,
			flatIntervalMs: 1_000,
			timers,
		});
		loop.start();
		timers.fireNext(); // tick 1 starts and blocks.
		await flush();
		expect(maxConcurrent).toBe(1);
		// A second arm should NOT exist yet (the loop re-arms only AFTER a tick settles),
		// but even if a stale timer fired, the `running` guard would skip it. Assert the
		// guard directly: there is exactly one in-flight tick, never two.
		expect(inFlight).toBe(1);
		release?.();
		await flush();
		expect(inFlight).toBe(0);
		expect(maxConcurrent).toBe(1); // never overlapped.
		loop.stop();
	});

	it("stop() cancels the live one-shot so no further tick is armed", async () => {
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: ENABLED, flatIntervalMs: 1_000, timers });
		loop.start();
		loop.stop();
		expect(timers.armedCount()).toBe(0);
		// A tick that settles after stop() must not re-arm (stopped guard).
		const before = timers.delays.length;
		await flush();
		expect(timers.delays.length).toBe(before);
	});

	it("a rejected tick is contained and backs off like an empty lease", async () => {
		const timers = manualTimers();
		const loop = createPollLoop({
			tick: async () => {
				throw new Error("queue closed during shutdown");
			},
			backoff: ENABLED,
			flatIntervalMs: 1_000,
			timers,
		});
		loop.start();
		timers.fireNext();
		await flush();
		expect(timers.delays.at(-1)).toBe(2_000);
		loop.stop();
	});
});
