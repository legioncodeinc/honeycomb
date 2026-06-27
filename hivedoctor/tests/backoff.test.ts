/** Backoff tests (geometric, floor/ceiling, jitter, reset, persisted rung). */

import { describe, expect, it } from "vitest";

import { createBackoff } from "../src/backoff.js";

describe("createBackoff", () => {
	it("grows geometrically from the floor with jitter disabled", () => {
		const b = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0, random: () => 0.5 });
		expect(b.delayMs()).toBe(1_000); // rung 0: floor * 2^0
		b.advance();
		expect(b.delayMs()).toBe(2_000); // rung 1: floor * 2^1
		b.advance();
		expect(b.delayMs()).toBe(4_000); // rung 2
		b.advance();
		expect(b.delayMs()).toBe(8_000); // rung 3
	});

	it("clamps to the ceiling", () => {
		const b = createBackoff({ floorMs: 1_000, ceilingMs: 5_000, jitter: 0 });
		for (let i = 0; i < 10; i++) b.advance();
		expect(b.delayMs()).toBe(5_000);
	});

	it("reset() returns to rung 0 (064a reset-on-healthy)", () => {
		const b = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0 });
		b.advance();
		b.advance();
		expect(b.rung).toBe(2);
		b.reset();
		expect(b.rung).toBe(0);
		expect(b.delayMs()).toBe(1_000);
	});

	it("rehydrates from a persisted initialRung", () => {
		const b = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0, initialRung: 3 });
		expect(b.rung).toBe(3);
		expect(b.delayMs()).toBe(8_000);
	});

	it("applies symmetric jitter within [1-j, 1+j] and never below floor or above ceiling", () => {
		// random()=0 -> lower bound (1 - jitter); random()=1 -> upper bound (1 + jitter), clamped.
		const low = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0.2, random: () => 0 });
		low.advance(); // rung 1, base 2000
		expect(low.delayMs()).toBe(1_600); // 2000 * 0.8

		const high = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0.2, random: () => 1 });
		high.advance(); // rung 1, base 2000
		expect(high.delayMs()).toBe(2_400); // 2000 * 1.2
	});

	it("does not overflow at a very large rung (clamped path)", () => {
		const b = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0, initialRung: 100 });
		expect(b.delayMs()).toBe(30_000);
	});
});
