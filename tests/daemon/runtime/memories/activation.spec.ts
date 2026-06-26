/**
 * PRD-058e, ACT-R base-level activation (the `A(m,t)` Stage-2 term) suite.
 *
 * Verification posture (pure math, no live DeepLake, no creds): the activation helpers
 * ({@link baseLevelActivation} / {@link actrActivation}) are driven with CONTROLLED access
 * histories + an injected `now`, so the recency-dominance / frequency-lift / spacing /
 * A_min-floor / u→0 behaviors are deterministic with no real clock and no I/O.
 *
 * Acceptance criteria → tests:
 *   58e.1.1 reinforced useful access → A_actr strictly higher than without it.
 *   58e.1.2 spread accesses ≥ bunched (spacing effect).
 *   58e.1.3 contradicted/ignored same turn → u_k → 0, no inflation.
 *   58e.1.4 cold memory → A_actr ≥ A_min.
 * Plus the unit math: log-space stability, the ε age-floor guard at t_k = t, future-access
 * clamp, monotone-in-age, and the property "more useful accesses never decrease A_actr".
 */

import { describe, expect, it } from "vitest";

import {
	actrActivation,
	baseLevelActivation,
	DEFAULT_ACTR_A_MIN,
	DEFAULT_ACTR_PARAMS,
	MIN_ACCESS_AGE_DAYS,
	type AccessEvent,
} from "../../../../src/daemon/runtime/memories/activation.js";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-06-26T00:00:00.000Z");

/** An access `days` before NOW with usefulness `u`. */
function access(days: number, u = 1): AccessEvent {
	return { atMs: NOW - days * MS_PER_DAY, usefulness: u };
}

describe("PRD-058e baseLevelActivation, B(m,t) = ln Σ u_k (t−t_k)^(−d)", () => {
	it("rises with recency: a more-recent single access has higher B than an older one", () => {
		const recent = baseLevelActivation([access(1)], NOW, 0.5);
		const old = baseLevelActivation([access(100)], NOW, 0.5);
		expect(recent).toBeGreaterThan(old);
	});

	it("rises with frequency: more useful accesses → higher B (58e.1.1 frequency lift)", () => {
		const one = baseLevelActivation([access(10)], NOW, 0.5);
		const three = baseLevelActivation([access(10), access(20), access(30)], NOW, 0.5);
		expect(three).toBeGreaterThan(one);
	});

	it("empty history → B = −∞ (a memory with no logged access is maximally cold)", () => {
		expect(baseLevelActivation([], NOW, 0.5)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("guards (t−t_k)^(−d) at t_k = t with the ε age floor (no Infinity/NaN)", () => {
		// An access logged at the exact recall instant: age 0 would divide by zero.
		const b = baseLevelActivation([{ atMs: NOW, usefulness: 1 }], NOW, 0.5);
		expect(Number.isFinite(b)).toBe(true);
		// It equals the value at the floored age: B = −d·ln(MIN_ACCESS_AGE_DAYS).
		expect(b).toBeCloseTo(-0.5 * Math.log(MIN_ACCESS_AGE_DAYS), 9);
	});

	it("a FUTURE access (clock skew) is floored to the min age, never negative-age", () => {
		const future: AccessEvent = { atMs: NOW + 5 * MS_PER_DAY, usefulness: 1 };
		const b = baseLevelActivation([future], NOW, 0.5);
		expect(Number.isFinite(b)).toBe(true);
		expect(b).toBeCloseTo(-0.5 * Math.log(MIN_ACCESS_AGE_DAYS), 9);
	});

	it("a u_k = 0 access contributes nothing (58e.1.3, no inflation from a non-useful recall)", () => {
		const useful = baseLevelActivation([access(10, 1)], NOW, 0.5);
		// Adding a zero-usefulness access must NOT change B.
		const withZero = baseLevelActivation([access(10, 1), access(2, 0)], NOW, 0.5);
		expect(withZero).toBeCloseTo(useful, 12);
	});

	it("log-space is stable over a long, heavily-weighted history (no overflow/NaN)", () => {
		const history = Array.from({ length: 500 }, (_, i) => access(i + 1, 1));
		const b = baseLevelActivation(history, NOW, 0.5);
		expect(Number.isFinite(b)).toBe(true);
	});
});

describe("PRD-058e actrActivation, A_actr = clamp(exp(B−B*), A_min, 1)", () => {
	it("58e.1.4 cold memory (no accesses) → A_actr = A_min, never 0", () => {
		expect(actrActivation([], NOW)).toBe(DEFAULT_ACTR_A_MIN);
	});

	it("58e.1.4 a memory whose only accesses are u=0 also floors at A_min", () => {
		expect(actrActivation([access(5, 0), access(2, 0)], NOW)).toBe(DEFAULT_ACTR_A_MIN);
	});

	it("clamps the top of the range at 1 (the rich-get-richer ceiling)", () => {
		// A burst of very recent, fully-useful accesses pushes exp(B) above 1 → clamped to 1.
		const hot = Array.from({ length: 20 }, () => access(MIN_ACCESS_AGE_DAYS, 1));
		expect(actrActivation(hot, NOW)).toBe(1);
	});

	it("58e.1.1 a reinforced useful access strictly RAISES A_actr vs not having it", () => {
		const base = [access(30, 1)];
		const reinforced = [access(30, 1), access(1, 1)]; // a fresh useful recall added.
		const aBase = actrActivation(base, NOW);
		const aReinforced = actrActivation(reinforced, NOW);
		expect(aReinforced).toBeGreaterThan(aBase);
	});

	it("58e.1.3 a contradicted access (u→0) does NOT inflate A_actr", () => {
		const base = [access(30, 1)];
		const withContradiction = [access(30, 1), access(1, 0)]; // recalled then contradicted same turn.
		expect(actrActivation(withContradiction, NOW)).toBeCloseTo(actrActivation(base, NOW), 12);
	});

	it("58e.1.2 SPACING: accesses spread over time ≥ the same number bunched", () => {
		// Three useful accesses, same count, same total span window, created at the same t_1.
		const spread = [access(60, 1), access(35, 1), access(10, 1)];
		const bunched = [access(60, 1), access(58, 1), access(56, 1)];
		const aSpread = actrActivation(spread, NOW);
		const aBunched = actrActivation(bunched, NOW);
		expect(aSpread).toBeGreaterThanOrEqual(aBunched);
	});

	it("property: adding any useful (u>0) access never DECREASES A_actr", () => {
		const histories: AccessEvent[][] = [
			[access(40, 1)],
			[access(40, 1), access(20, 0.5)],
			[access(40, 1), access(20, 0.5), access(5, 1)],
		];
		for (let i = 1; i < histories.length; i++) {
			const prev = actrActivation(histories[i - 1]!, NOW);
			const next = actrActivation(histories[i]!, NOW);
			expect(next).toBeGreaterThanOrEqual(prev - 1e-12);
		}
	});

	it("A_actr is always within [A_min, 1] for any history", () => {
		const cases: AccessEvent[][] = [[], [access(0.5, 1)], [access(1000, 0.1)], [access(1, 1), access(1, 1)]];
		for (const h of cases) {
			const a = actrActivation(h, NOW);
			expect(a).toBeGreaterThanOrEqual(DEFAULT_ACTR_PARAMS.aMin);
			expect(a).toBeLessThanOrEqual(1);
		}
	});

	it("a custom A_min floor is honored", () => {
		expect(actrActivation([], NOW, { ...DEFAULT_ACTR_PARAMS, aMin: 0.2 })).toBe(0.2);
	});
});
