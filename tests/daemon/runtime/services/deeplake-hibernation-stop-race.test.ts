/**
 * PR 225 review findings (CodeRabbit Critical + Aikido siblings): stop() must be
 * authoritative over in-flight transitions, and a touch() landing mid-transition
 * must never be lost.
 *
 *   - Critical: an idle-timer-fired hibernate or a touch-triggered wake whose
 *     pause/resume sweep is in flight when `stop()` runs used to finish afterward
 *     and silently reinstate "active"/"hibernated", log a transition, re-arm the
 *     debounce, and (on the wake path) resume workers during teardown.
 *   - Sibling: a touch() arriving during an in-flight hibernate saw `state` still
 *     "active", did nothing, and the daemon ended hibernated despite fresh work.
 *
 * Verification posture mirrors the controller suite: a manual clock + a single-slot
 * fake timer, fake handles, and DEFERRED pause/resume promises so a test can hold a
 * transition open, inject the race, then settle it. No real timers, no network.
 */

import { describe, expect, it } from "vitest";

import {
	createDeepLakeHibernation,
	type HibernationLogger,
	type Pausable,
} from "../../../../src/daemon/runtime/services/deeplake-hibernation.js";

/** Flush pending microtasks / async transitions via one real macrotask. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A manual clock + a single-slot fake timer (the controller arms one timer at a time). */
function harness() {
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
		hasPending: (): boolean => pending !== null,
	};
}

/** A hand-rolled deferred so a test can hold a pause/resume open across the race. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A recording logger so transition events (or their absence) are assertable. */
function recordingLogger(): HibernationLogger & { events: string[] } {
	const events: string[] = [];
	return {
		events,
		info(event: string): void {
			events.push(event);
		},
	};
}

/** A counting handle whose pause/resume can be deferred to hold a transition open. */
function slowPausable(
	label: string,
	opts: { pauseGate?: Promise<void>; resumeGate?: Promise<void> } = {},
): Pausable & { paused: number; resumed: number } {
	const h = {
		label,
		paused: 0,
		resumed: 0,
		pause(): void | Promise<void> {
			h.paused++;
			return opts.pauseGate;
		},
		resume(): void | Promise<void> {
			h.resumed++;
			return opts.resumeGate;
		},
	};
	return h;
}

describe("PR225 Critical: stop() is authoritative over an in-flight transition", () => {
	it("stop() during an in-flight hibernate leaves state stopped, arms no timer, and never resumes workers afterward", async () => {
		const h = harness();
		const log = recordingLogger();
		const gate = deferred();
		const slow = slowPausable("slow", { pauseGate: gate.promise });
		const after = slowPausable("after");
		const hib = createDeepLakeHibernation({
			pausables: [slow, after],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
			logger: log,
		});
		hib.start();

		// The idle window elapses: the hibernate begins and its pause sweep is held
		// open on the first handle's deferred pause.
		h.advance(10_000);
		await flush();
		expect(slow.paused).toBe(1);
		expect(hib.isHibernated(), "still mid-transition, not yet hibernated").toBe(false);

		// Teardown races the in-flight pause sweep, then the sweep settles.
		hib.stop();
		gate.resolve();
		await flush();

		// stop() won: no hibernated state was reinstated, no transition was logged, no
		// timer was re-armed, and the sweep aborted before pausing the remaining handle.
		expect(hib.isHibernated()).toBe(false);
		expect(log.events).not.toContain("deeplake.hibernated");
		expect(h.hasPending(), "no debounce timer survives teardown").toBe(false);
		expect(after.paused, "the pause sweep aborted at the stop latch").toBe(0);

		// The controller stays inert after teardown: activity and time do nothing.
		hib.touch();
		h.advance(100_000);
		await flush();
		expect(slow.resumed, "workers are never resumed after stop()").toBe(0);
		expect(after.resumed).toBe(0);
		expect(h.hasPending()).toBe(false);
	});

	it("stop() during an in-flight wake leaves state stopped, arms no timer, and resumes no further workers", async () => {
		const h = harness();
		const log = recordingLogger();
		const gate = deferred();
		const slow = slowPausable("slow", { resumeGate: gate.promise });
		const after = slowPausable("after");
		const hib = createDeepLakeHibernation({
			pausables: [slow, after],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
			logger: log,
		});
		hib.start();
		h.advance(10_000);
		await flush();
		expect(hib.isHibernated()).toBe(true);

		// A touch triggers the wake; its resume sweep is held open on the first handle.
		hib.touch();
		await flush();
		expect(slow.resumed).toBe(1);
		expect(hib.isHibernated(), "still mid-transition, state not yet active").toBe(true);

		// Teardown races the in-flight resume sweep, then the sweep settles.
		hib.stop();
		gate.resolve();
		await flush();

		// stop() won: no active state was reinstated, no wake was logged, no debounce
		// was re-armed, and the remaining handle was never resumed during teardown.
		expect(hib.isHibernated()).toBe(false);
		expect(log.events).not.toContain("deeplake.woke");
		expect(h.hasPending(), "no debounce timer survives teardown").toBe(false);
		expect(after.resumed, "the resume sweep aborted at the stop latch").toBe(0);

		h.advance(100_000);
		await flush();
		expect(h.hasPending()).toBe(false);
	});
});

describe("PR225 Aikido sibling: a touch() landing mid-hibernate is queued, never lost", () => {
	it("touch() during an in-flight hibernate ends with the controller awake once the transition settles", async () => {
		const h = harness();
		const log = recordingLogger();
		const gate = deferred();
		const worker = slowPausable("worker", { pauseGate: gate.promise });
		const hib = createDeepLakeHibernation({
			pausables: [worker],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
			logger: log,
		});
		hib.start();

		// The hibernate begins; its pause sweep is held open.
		h.advance(10_000);
		await flush();
		expect(worker.paused).toBe(1);

		// Fresh work arrives mid-transition. The old code dropped this (state still read
		// "active", so the wake path saw nothing to do); it must now be queued.
		hib.touch();
		await flush();
		expect(worker.resumed, "the wake waits for the in-flight pause to settle").toBe(0);

		// The pause sweep settles: the hibernate completes and the queued wake fires
		// immediately, so the daemon ends AWAKE with its worker resumed.
		gate.resolve();
		await flush();
		expect(worker.resumed, "the queued wake resumed the worker").toBe(1);
		expect(hib.isHibernated(), "the controller ends awake, not hibernated").toBe(false);
		expect(log.events).toContain("deeplake.hibernated");
		expect(log.events).toContain("deeplake.woke");
		expect(h.hasPending(), "the debounce re-armed so a later idle can hibernate again").toBe(true);

		// And the cycle stays healthy: a fresh idle window hibernates again.
		h.advance(10_000);
		await flush();
		expect(worker.paused).toBe(2);
		expect(hib.isHibernated()).toBe(true);
	});
});
