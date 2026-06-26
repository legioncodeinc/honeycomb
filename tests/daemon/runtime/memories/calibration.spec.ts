/**
 * PRD-058e, confidence calibration (the `C(m)` term) suite.
 *
 * Verification posture (pure math, no I/O): the isotonic fit, ECE/Brier, the adoption gate,
 * and (de)serialization are driven with controlled `(f, y)` samples, deterministic.
 *
 * Acceptance criteria → tests:
 *   58e.2.1 calibration refit → held-out ECE non-increasing (property test).
 *   58e.2.2 insufficient data → g identity, C = f (the `c` exponent stays 0 / dormant).
 *   58e.2.3 g clears the ECE gate → adoptable (the adoption decision is ECE-gated).
 * Plus: isotonic monotonicity, ECE computation on a known case, Brier, serialize round-trip,
 * and the fail-safe deserialize (corrupt blob → identity).
 */

import { describe, expect, it } from "vitest";

import {
	applyCalibration,
	brierScore,
	deserializeModel,
	expectedCalibrationError,
	fitIsotonic,
	IDENTITY_MODEL,
	serializeModel,
	shouldAdoptRefit,
	type CalibrationSample,
} from "../../../../src/daemon/runtime/memories/calibration.js";

/** A deterministic miscalibrated sample set: high raw confidence, lower true accuracy. */
function miscalibrated(n: number): CalibrationSample[] {
	const out: CalibrationSample[] = [];
	for (let i = 0; i < n; i++) {
		// Raw f spread across [0.5, 1]; true correctness lags (the model is over-confident).
		const f = 0.5 + (0.5 * (i % 10)) / 10;
		const y: 0 | 1 = i % 3 === 0 ? 1 : 0; // ~33% actually correct regardless of stated f.
		out.push({ f, y });
	}
	return out;
}

describe("PRD-058e fitIsotonic, monotone non-parametric calibration map", () => {
	it("58e.2.2 insufficient data → IDENTITY model (C = f, dormant)", () => {
		const model = fitIsotonic([{ f: 0.9, y: 1 }], 50);
		expect(model.identity).toBe(true);
		expect(applyCalibration(model, 0.42)).toBe(0.42); // C = f exactly.
	});

	it("produces a MONOTONE non-decreasing curve (isotonic guarantee)", () => {
		const samples: CalibrationSample[] = [];
		// Build a clearly monotone-with-noise signal: higher f → more likely correct.
		for (let i = 0; i < 200; i++) {
			const f = (i % 10) / 10; // 0, 0.1, … 0.9 repeating.
			const y: 0 | 1 = Math.random() < f ? 1 : 0;
			samples.push({ f, y });
		}
		const model = fitIsotonic(samples, 50);
		expect(model.identity).toBe(false);
		// g must be non-decreasing across the [0,1] range.
		let prev = -Infinity;
		for (let x = 0; x <= 1.0001; x += 0.05) {
			const g = applyCalibration(model, Math.min(1, x));
			expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = g;
		}
	});

	it("calibrated output is always within [0,1]", () => {
		const model = fitIsotonic(miscalibrated(120), 50);
		for (let x = 0; x <= 1; x += 0.1) {
			const g = applyCalibration(model, x);
			expect(g).toBeGreaterThanOrEqual(0);
			expect(g).toBeLessThanOrEqual(1);
		}
	});
});

describe("PRD-058e ECE + Brier", () => {
	it("perfectly-calibrated samples → ECE 0", () => {
		// conf == accuracy in every bin: f=1 always-correct, f=0 always-wrong.
		const samples: CalibrationSample[] = [
			{ f: 1, y: 1 },
			{ f: 1, y: 1 },
			{ f: 0, y: 0 },
			{ f: 0, y: 0 },
		];
		expect(expectedCalibrationError(samples, IDENTITY_MODEL, 10)).toBeCloseTo(0, 12);
	});

	it("an over-confident set has positive ECE under the identity model", () => {
		// f=0.9 but only half are correct → a calibration gap.
		const samples: CalibrationSample[] = Array.from({ length: 10 }, (_, i) => ({ f: 0.9, y: (i % 2) as 0 | 1 }));
		const ece = expectedCalibrationError(samples, IDENTITY_MODEL, 10);
		expect(ece).toBeGreaterThan(0.3); // |0.9 − 0.5| ≈ 0.4.
	});

	it("fitting reduces ECE on the same data (the curve corrects the gap)", () => {
		const samples = miscalibrated(300);
		const eceRaw = expectedCalibrationError(samples, IDENTITY_MODEL, 10);
		const model = fitIsotonic(samples, 50);
		const eceFit = expectedCalibrationError(samples, model, 10);
		expect(eceFit).toBeLessThanOrEqual(eceRaw + 1e-9);
	});

	it("Brier score: perfect predictions → 0, worst → 1", () => {
		expect(brierScore([{ f: 1, y: 1 }, { f: 0, y: 0 }], IDENTITY_MODEL)).toBeCloseTo(0, 12);
		expect(brierScore([{ f: 1, y: 0 }, { f: 0, y: 1 }], IDENTITY_MODEL)).toBeCloseTo(1, 12);
	});

	it("empty sample set → ECE 0 and Brier 0 (nothing to measure)", () => {
		expect(expectedCalibrationError([], IDENTITY_MODEL)).toBe(0);
		expect(brierScore([], IDENTITY_MODEL)).toBe(0);
	});
});

describe("PRD-058e refit adoption gate (58e.2.1 / 58e.2.3)", () => {
	it("58e.2.1 PROPERTY: a refit is adopted only when held-out ECE does not increase", () => {
		// Across many random splits, adoption ⇒ candidate ECE < prior ECE (never an increase).
		for (let trial = 0; trial < 50; trial++) {
			const all = miscalibrated(200).map((s) => ({ f: s.f, y: (Math.random() < 0.5 ? s.y : ((1 - s.y) as 0 | 1)) }));
			const split = Math.floor(all.length / 2);
			const train = all.slice(0, split);
			const heldOut = all.slice(split);
			const prior = IDENTITY_MODEL;
			const candidate = fitIsotonic(train, 10);
			const priorEce = expectedCalibrationError(heldOut, prior, 10);
			const candEce = expectedCalibrationError(heldOut, candidate, 10);
			const adopt = shouldAdoptRefit(priorEce, candEce);
			if (adopt) expect(candEce).toBeLessThan(priorEce);
		}
	});

	it("58e.2.3 a candidate that beats the prior on held-out ECE IS adoptable", () => {
		expect(shouldAdoptRefit(0.4, 0.1)).toBe(true);
	});

	it("a tie or worse candidate is NOT adopted (never churn for no gain)", () => {
		expect(shouldAdoptRefit(0.2, 0.2)).toBe(false);
		expect(shouldAdoptRefit(0.1, 0.3)).toBe(false);
	});

	it("a non-finite candidate ECE never wins; no usable prior → adopt the candidate", () => {
		expect(shouldAdoptRefit(0.1, NaN)).toBe(false);
		expect(shouldAdoptRefit(NaN, 0.1)).toBe(true);
	});
});

describe("PRD-058e model serialization", () => {
	it("identity model round-trips to identity", () => {
		expect(deserializeModel(serializeModel(IDENTITY_MODEL)).identity).toBe(true);
	});

	it("a fitted curve round-trips with the same g(f) at sampled points", () => {
		const model = fitIsotonic(miscalibrated(200), 50);
		const round = deserializeModel(serializeModel(model));
		for (let x = 0; x <= 1; x += 0.1) {
			expect(applyCalibration(round, x)).toBeCloseTo(applyCalibration(model, x), 9);
		}
	});

	it("a corrupt / empty / unknown blob FAILS SAFE to the identity model (C = f)", () => {
		expect(deserializeModel("").identity).toBe(true);
		expect(deserializeModel("not json").identity).toBe(true);
		expect(deserializeModel(JSON.stringify({ format: "other" })).identity).toBe(true);
		expect(deserializeModel(JSON.stringify({ format: "isotonic-v1", identity: false, knots: "bad" })).identity).toBe(true);
	});
});
