/**
 * PRD-062d (L-D2) — the bounded-concurrency pool.
 *
 * Verifies the {@link Semaphore} caps in-flight tasks at `max`, hands permits forward
 * FIFO, never leaks a permit on a throwing task, and that {@link mapBounded} preserves
 * INPUT ORDER (the parity guarantee — it is a drop-in for `Promise.all`). The cap is
 * asserted DETERMINISTICALLY with manually-resolved tasks + the live `inFlight` counter,
 * never a real sleep.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { mapBounded, Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";

/** A manually-controllable deferred: a task the test resolves on demand (no timers). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("Semaphore: caps in-flight tasks at `max`", () => {
	it("never runs more than `max` tasks at once (deterministic in-flight counter)", async () => {
		const pool = new Semaphore(2);
		const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
		let peak = 0;

		// Launch 4 tasks under a width-2 pool; each parks on its gate so the test controls timing.
		const runs = gates.map((g) =>
			pool.run(async () => {
				peak = Math.max(peak, pool.inFlight);
				await g.promise;
			}),
		);

		// With width 2: exactly 2 are in flight, 2 are parked waiting.
		await Promise.resolve();
		expect(pool.inFlight).toBe(2);
		expect(pool.waiting).toBe(2);

		// Release the first two; the two waiters take their permits — still never above 2.
		gates[0].resolve();
		gates[1].resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(pool.inFlight).toBeLessThanOrEqual(2);

		gates[2].resolve();
		gates[3].resolve();
		await Promise.all(runs);

		expect(peak).toBeLessThanOrEqual(2);
		expect(pool.inFlight).toBe(0);
		expect(pool.waiting).toBe(0);
	});

	it("clamps a non-positive width up to 1 (a pool must admit at least one task)", () => {
		expect(new Semaphore(0).max).toBe(1);
		expect(new Semaphore(-5).max).toBe(1);
		expect(new Semaphore(Number.NaN).max).toBe(1);
		expect(new Semaphore(6).max).toBe(6);
	});

	it("releases the permit even when the task throws (no leak / wedge)", async () => {
		const pool = new Semaphore(1);
		await expect(
			pool.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// The permit was released despite the throw — the next task runs.
		expect(pool.inFlight).toBe(0);
		await expect(pool.run(async () => 42)).resolves.toBe(42);
	});
});

describe("mapBounded: order-preserving drop-in for Promise.all", () => {
	it("returns results in INPUT ORDER regardless of completion order (parity)", async () => {
		const pool = new Semaphore(3);
		const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
		const out = mapBounded([0, 1, 2], pool, (i) => gates[i].promise);

		// Resolve out of order: 2 first, then 0, then 1.
		gates[2].resolve(22);
		gates[0].resolve(0);
		gates[1].resolve(11);

		// Result array is still ordered by INPUT index, not completion order.
		expect(await out).toEqual([0, 11, 22]);
	});

	it("caps in-flight fn calls at the pool width across the whole map", async () => {
		const pool = new Semaphore(2);
		let peak = 0;
		const gates = Array.from({ length: 5 }, () => deferred<void>());
		const out = mapBounded(gates, pool, async (g) => {
			peak = Math.max(peak, pool.inFlight);
			await g.promise;
		});
		await Promise.resolve();
		expect(pool.inFlight).toBe(2);
		for (const g of gates) g.resolve();
		await out;
		expect(peak).toBeLessThanOrEqual(2);
	});
});
