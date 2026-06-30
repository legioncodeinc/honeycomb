/**
 * Deep Lake connection hibernation — the idle-cost master switch.
 *
 * Verification posture:
 *   - The controller owns no Deep Lake access and no wall clock: a MANUAL clock + a
 *     single-slot fake timer + fake {@link Pausable} handles drive the whole surface,
 *     so these are deterministic with no real timers and no network.
 *   - Transitions (hibernate/wake) are async (they await each handle's pause/resume),
 *     so a test awaits a real macrotask `tick()` after the trigger to flush them.
 *   - AC-H.1 disabled → no-op (rollback parity). AC-H.2 idle → hibernate pauses all.
 *     AC-H.3 touch re-arms the debounce. AC-H.4 touch while hibernated wakes + resumes.
 *     AC-H.5 a throwing handle never blocks the rest. AC-H.6 stop() cancels, never pauses.
 *     AC-H.7 the env resolver (default-ON, explicit rollback, clamp).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	createDeepLakeHibernation,
	DEFAULT_HIBERNATE_IDLE_MS,
	envHibernationConfigProvider,
	MIN_HIBERNATE_IDLE_MS,
	type Pausable,
} from "../../../../src/daemon/runtime/services/deeplake-hibernation.js";

/** Flush pending microtasks/async transitions via one real macrotask. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
		/** Advance the clock and fire any timer that comes due (re-armed timers chain). */
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

/** A fake handle recording pause/resume counts; may be told to throw to prove isolation. */
function fakePausable(
	label: string,
	opts: { throwOnPause?: boolean; throwOnResume?: boolean } = {},
): Pausable & { paused: number; resumed: number } {
	const h = {
		label,
		paused: 0,
		resumed: 0,
		pause(): void {
			h.paused++;
			if (opts.throwOnPause) throw new Error(`${label} pause boom`);
		},
		resume(): void {
			h.resumed++;
			if (opts.throwOnResume) throw new Error(`${label} resume boom`);
		},
	};
	return h;
}

describe("AC-H.1 disabled → start() is a no-op and nothing is ever paused (rollback parity)", () => {
	it("never arms a timer and never pauses a handle when enabled=false", () => {
		const h = harness();
		const a = fakePausable("a");
		const hib = createDeepLakeHibernation({
			pausables: [a],
			config: { enabled: false, idleMs: 1_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();
		expect(h.hasPending()).toBe(false);
		h.advance(10_000);
		expect(a.paused).toBe(0);
		expect(hib.isHibernated()).toBe(false);
	});
});

describe("AC-H.2 after idleMs of no activity → hibernate pauses every handle", () => {
	it("pauses all handles once the idle window elapses and reports hibernated", async () => {
		const h = harness();
		const a = fakePausable("a");
		const b = fakePausable("b");
		const hib = createDeepLakeHibernation({
			pausables: [a, b],
			config: { enabled: true, idleMs: 60_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();
		h.advance(59_999);
		expect(a.paused).toBe(0); // not yet
		h.advance(1);
		await tick();
		expect(a.paused).toBe(1);
		expect(b.paused).toBe(1);
		expect(hib.isHibernated()).toBe(true);
	});
});

describe("AC-H.3 touch() while active pushes the idle deadline out (debounce)", () => {
	it("does not hibernate until idleMs after the LAST touch", async () => {
		const h = harness();
		const a = fakePausable("a");
		const hib = createDeepLakeHibernation({
			pausables: [a],
			config: { enabled: true, idleMs: 60_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();
		h.advance(50_000);
		hib.touch(); // reset the clock-to-idle
		h.advance(50_000); // 50s since the touch — still short of 60s
		await tick();
		expect(a.paused).toBe(0);
		expect(hib.isHibernated()).toBe(false);
		h.advance(10_000); // now 60s since the touch
		await tick();
		expect(a.paused).toBe(1);
		expect(hib.isHibernated()).toBe(true);
	});
});

describe("AC-H.4 touch() while hibernated → wake resumes every handle and re-arms", () => {
	it("resumes all handles, clears hibernated, and can hibernate again after idle", async () => {
		const h = harness();
		const a = fakePausable("a");
		const b = fakePausable("b");
		const hib = createDeepLakeHibernation({
			pausables: [a, b],
			config: { enabled: true, idleMs: 30_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();
		h.advance(30_000);
		await tick();
		expect(hib.isHibernated()).toBe(true);

		hib.touch(); // wake
		await tick();
		expect(a.resumed).toBe(1);
		expect(b.resumed).toBe(1);
		expect(hib.isHibernated()).toBe(false);

		// A fresh idle window re-hibernates (the debounce was re-armed on wake).
		h.advance(30_000);
		await tick();
		expect(a.paused).toBe(2);
		expect(hib.isHibernated()).toBe(true);
	});
});

describe("AC-H.5 a handle that throws never blocks the others", () => {
	it("still pauses/resumes the remaining handles when one throws", async () => {
		const h = harness();
		const bad = fakePausable("bad", { throwOnPause: true, throwOnResume: true });
		const good = fakePausable("good");
		const hib = createDeepLakeHibernation({
			pausables: [bad, good],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();
		h.advance(10_000);
		await tick();
		expect(good.paused).toBe(1); // bad threw, good still paused
		expect(hib.isHibernated()).toBe(true);
		hib.touch();
		await tick();
		expect(good.resumed).toBe(1);
		expect(hib.isHibernated()).toBe(false);
	});
});

describe("AC-H.6 stop() cancels the pending timer and never pauses handles", () => {
	it("stops monitoring so no hibernate fires after stop()", async () => {
		const h = harness();
		const a = fakePausable("a");
		const hib = createDeepLakeHibernation({
			pausables: [a],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
		});
		hib.start();
		hib.stop();
		expect(h.hasPending()).toBe(false);
		h.advance(100_000);
		await tick();
		expect(a.paused).toBe(0);
	});
});

describe("AC-H.7 env resolver: default-ON, explicit rollback, idle clamp", () => {
	it("defaults enabled=true when the flag is absent (cost fix ships on)", () => {
		expect(envHibernationConfigProvider({}).enabled).toBe(true);
		expect(envHibernationConfigProvider({}).idleMs).toBe(DEFAULT_HIBERNATE_IDLE_MS);
	});
	it("ONLY an explicit false/0 rolls back; a typo or any other value stays enabled", () => {
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED: "false" }).enabled).toBe(false);
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED: "0" }).enabled).toBe(false);
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED: "true" }).enabled).toBe(true);
		// A malformed value must NOT silently disable the cost fix (Aikido AIK_AI_logic_bugs).
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED: "maybe" }).enabled).toBe(true);
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED: "" }).enabled).toBe(true);
	});
	it("clamps a too-small idle window up to the floor and ignores a non-numeric one", () => {
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS: "10" }).idleMs).toBe(
			MIN_HIBERNATE_IDLE_MS,
		);
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS: "oops" }).idleMs).toBe(
			DEFAULT_HIBERNATE_IDLE_MS,
		);
		expect(envHibernationConfigProvider({ HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS: "300000" }).idleMs).toBe(300_000);
	});
});
