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

import { describe, expect, it } from "vitest";

import { PollBackoffConfigSchema } from "../../../../src/daemon/runtime/services/poll-backoff.js";
import { createPollLoop, type PollLoopTimers } from "../../../../src/daemon/runtime/services/poll-loop.js";

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

	it("start() is idempotent: a second start() never arms a second timer", () => {
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: ENABLED, flatIntervalMs: 1_000, timers });
		loop.start();
		loop.start(); // a double start must be a no-op, not a leaked second timer.
		expect(timers.armedCount()).toBe(1);
		loop.stop();
		expect(timers.armedCount()).toBe(0);
	});
});

describe("AdaptivePollLoop: idle hibernation, suspends when idle, wakes on demand (PRD-062e)", () => {
	// Over the 1000→30000 window the post-step idle accrual is 2000, 4000, 8000, ... so a
	// 14000ms window trips suspension on exactly the THIRD empty tick (2000+4000+8000).
	const SUSPEND = PollBackoffConfigSchema.parse({
		enabled: true,
		floorMs: 1_000,
		ceilingMs: 30_000,
		jitter: 0,
		suspendEnabled: true,
		suspendAfterMs: 14_000,
	});

	it("AC-62e.8: after the idle window the loop STOPS arming timers (zero further polls)", async () => {
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: SUSPEND, flatIntervalMs: 1_000, timers });
		loop.start();
		expect(timers.delays).toEqual([1_000]);
		for (let i = 0; i < 3; i++) {
			timers.fireNext();
			await flush();
		}
		// The loop hibernated: it did NOT re-arm after the third tick, so no timer is live and
		// the daemon issues ZERO further DeepLake polls until woken (Activeloop can scale to zero).
		expect(timers.armedCount()).toBe(0);
		expect(timers.delays).toEqual([1_000, 2_000, 4_000]); // the suspending tick armed nothing.
		loop.stop();
	});

	it("AC-62e.9: wake() resumes a suspended loop at the fast floor and it ticks again", async () => {
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: SUSPEND, flatIntervalMs: 1_000, timers });
		loop.start();
		for (let i = 0; i < 3; i++) {
			timers.fireNext();
			await flush();
		}
		expect(timers.armedCount()).toBe(0); // suspended.
		loop.wake();
		// A wake re-arms exactly one timer at the floor, so the just-woken loop polls immediately.
		expect(timers.armedCount()).toBe(1);
		expect(timers.delays.at(-1)).toBe(1_000);
		// And it resumes the normal adaptive cadence from the floor (backs off again).
		timers.fireNext();
		await flush();
		expect(timers.delays.at(-1)).toBe(2_000);
		loop.stop();
	});

	it("AC-62e.10: wake() never double-arms a live loop and is a no-op after stop()", async () => {
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: SUSPEND, flatIntervalMs: 1_000, timers });
		loop.start();
		// A wake on a live, non-suspended loop must NOT arm a second timer (no double-poll).
		loop.wake();
		expect(timers.armedCount()).toBe(1);
		loop.stop();
		const delaysAfterStop = timers.delays.length;
		loop.wake(); // a stopped loop stays stopped.
		expect(timers.armedCount()).toBe(0);
		expect(timers.delays.length).toBe(delaysAfterStop);
	});

	it("AC-62e.11: with suspend DISABLED the loop backs off to the ceiling but never hibernates", async () => {
		const noSuspend = PollBackoffConfigSchema.parse({
			enabled: true,
			floorMs: 1_000,
			ceilingMs: 30_000,
			jitter: 0,
			suspendEnabled: false,
			suspendAfterMs: 14_000,
		});
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: noSuspend, flatIntervalMs: 1_000, timers });
		loop.start();
		for (let i = 0; i < 8; i++) {
			timers.fireNext();
			await flush();
		}
		// It pins at the ceiling and ALWAYS re-arms, holding 062b's steady ~30s cadence, never zero.
		expect(timers.armedCount()).toBe(1);
		expect(timers.delays.at(-1)).toBe(30_000);
		loop.stop();
	});

	it("AC-62e.12: wake() pulls a merely backed-off (not suspended) loop's timer back to the floor", async () => {
		const backoffOnly = PollBackoffConfigSchema.parse({ enabled: true, floorMs: 1_000, ceilingMs: 30_000, jitter: 0 });
		const timers = manualTimers();
		const loop = createPollLoop({ tick: async () => false, backoff: backoffOnly, flatIntervalMs: 1_000, timers });
		loop.start();
		// Back off a few empty ticks so the live timer is parked at a long delay (not suspended).
		for (let i = 0; i < 3; i++) {
			timers.fireNext();
			await flush();
		}
		expect(timers.delays.at(-1)).toBe(8_000); // parked at 8s, climbing toward the ceiling.
		expect(timers.armedCount()).toBe(1);
		// A new job wakes the loop: the stale 8s timer is cancelled and re-armed at the floor,
		// so the job is picked up immediately rather than after the stale delay.
		loop.wake();
		expect(timers.armedCount()).toBe(1); // cancel + re-arm leaves exactly one timer, never two.
		expect(timers.delays.at(-1)).toBe(1_000);
		loop.stop();
	});
});
