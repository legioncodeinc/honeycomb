/**
 * PRD-058e, spaced re-verification scheduling suite (verification effort follows utility).
 *
 * Acceptance criteria → tests:
 *   58e.3.1 two stale-eligible memories → the higher-A_actr one is checked at a SHORTER interval.
 *   58e.3.2 a cold, low-activation memory → the LONGEST (bounded) interval / deferred, never
 *           starving the hot set (its interval is longest, so the hot set is always due first).
 * Plus the bounds: clamp into [min, max], monotone-decreasing in A, due-when-overdue.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_MAX_REVERIFY_INTERVAL_MS,
	DEFAULT_MIN_REVERIFY_INTERVAL_MS,
	DEFAULT_REVERIFY_SCHEDULE,
	isDueForReverify,
	reverifyIntervalMs,
} from "../../../../src/daemon/runtime/memories/reverify-schedule.js";

const NOW = Date.parse("2026-06-26T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

describe("PRD-058e reverifyIntervalMs, interval(A) = clamp(max·(1−A), min, max)", () => {
	it("58e.3.1 a higher A_actr yields a STRICTLY shorter interval", () => {
		const hot = reverifyIntervalMs(0.9);
		const cold = reverifyIntervalMs(0.1);
		expect(hot).toBeLessThan(cold);
	});

	it("58e.3.2 a cold (A → A_min) memory gets the LONGEST bounded interval, never ∞", () => {
		const cold = reverifyIntervalMs(0.05); // ≈ A_min.
		expect(cold).toBeLessThanOrEqual(DEFAULT_MAX_REVERIFY_INTERVAL_MS);
		expect(Number.isFinite(cold)).toBe(true);
		// And it is near the max (deferred, but bounded).
		expect(cold).toBeGreaterThan(DEFAULT_MAX_REVERIFY_INTERVAL_MS * 0.9);
	});

	it("a saturated (A = 1) memory gets the SHORTEST interval (min)", () => {
		expect(reverifyIntervalMs(1)).toBe(DEFAULT_MIN_REVERIFY_INTERVAL_MS);
	});

	it("the result is always within [min, max]", () => {
		for (const a of [0, 0.25, 0.5, 0.75, 1]) {
			const iv = reverifyIntervalMs(a);
			expect(iv).toBeGreaterThanOrEqual(DEFAULT_MIN_REVERIFY_INTERVAL_MS);
			expect(iv).toBeLessThanOrEqual(DEFAULT_MAX_REVERIFY_INTERVAL_MS);
		}
	});

	it("is monotone non-increasing in A", () => {
		let prev = Infinity;
		for (let a = 0; a <= 1.0001; a += 0.1) {
			const iv = reverifyIntervalMs(Math.min(1, a));
			expect(iv).toBeLessThanOrEqual(prev + 1e-6);
			prev = iv;
		}
	});

	it("a degenerate inverted config is normalized (min ≤ max)", () => {
		const iv = reverifyIntervalMs(0.5, { minIntervalMs: 100, maxIntervalMs: 10 });
		expect(iv).toBeGreaterThanOrEqual(10);
		expect(iv).toBeLessThanOrEqual(100);
	});
});

describe("PRD-058e isDueForReverify", () => {
	it("a never-checked memory is always due", () => {
		expect(isDueForReverify(0.05, null, NOW)).toBe(true);
	});

	it("58e.3.1 at equal last-check age, the hot memory becomes due before the cold one", () => {
		// hot A=0.95 → interval = 90d·0.05 = 4.5d; cold A=0.05 → interval = 90d·0.95 = 85.5d.
		// At an equal last-check age of 10 days, the hot memory is overdue and the cold one is not.
		const lastChecked = NOW - 10 * MS_PER_DAY;
		expect(isDueForReverify(0.95, lastChecked, NOW)).toBe(true); // hot: 10d > 4.5d interval.
		expect(isDueForReverify(0.05, lastChecked, NOW)).toBe(false); // cold: 10d < 85.5d interval.
	});

	it("58e.3.2 a cold memory is eventually due (deferred, not starved)", () => {
		const longAgo = NOW - 200 * MS_PER_DAY; // well past the 90-day cold interval.
		expect(isDueForReverify(0.05, longAgo, NOW, DEFAULT_REVERIFY_SCHEDULE)).toBe(true);
	});
});
