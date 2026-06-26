/**
 * PRD-058 — the useful-context@k (W-1) + ECE-over-time (W-2) eval-completeness suites.
 *
 * W-1: useful-context@k is the scoring-doc HEADLINE metric — "did the top-k surface a memory that is
 *      correct AND current AND non-conflicting?". The four per-term slices (freshness / staleness /
 *      contradiction / CRA) decompose it; this is the end-to-end conjunction. These tests pin the metric
 *      math (a correct-but-stale or correct-but-losing id does NOT count) and the engine-agnostic runner.
 *
 * W-2: the ECE-over-time slice is the standalone trend the per-fit monotone adoption gate
 *      (`shouldAdoptRefit`) implies — the curve the scoring doc commits. These tests pin the per-window
 *      ECE/Brier curve + the non-worsening verdict, reusing the SAME calibration math the 58e gate uses.
 *
 * The LIVE numeric runs are creds-gated and SKIP; the CODE + this coverage ship now.
 */

import { describe, expect, it } from "vitest";

import {
	aggregateUsefulContext,
	usefulContextAtK,
	type RankedResult,
	type UsefulContextCase,
} from "../../src/eval/metrics.js";
import {
	runEceOverTimeSlice,
	runUsefulContextSlice,
	type EceWindow,
	type UsefulContextPair,
} from "../../src/eval/golden.js";
import { fitIsotonic, type CalibrationSample } from "../../src/daemon/runtime/memories/calibration.js";

// ── W-1: useful-context@k ─────────────────────────────────────────────────────

describe("PRD-058 W-1 usefulContextAtK — correct AND current AND non-conflicting", () => {
	const ranked = (ids: string[]): RankedResult => ({ ids });

	it("a correct, non-excluded id in the top-k → useful (1)", () => {
		const c: UsefulContextCase = { caseId: "x", correctIds: ["good"], excludedIds: [] };
		expect(usefulContextAtK(ranked(["good", "other"]), c, 5)).toBe(1);
	});

	it("a correct-but-STALE id does NOT count (relevant but untrustworthy) → miss (0)", () => {
		const c: UsefulContextCase = { caseId: "x", correctIds: ["fresh", "stale"], excludedIds: ["stale"] };
		// Only the stale copy surfaced in the top-k → not useful.
		expect(usefulContextAtK(ranked(["stale", "noise"]), c, 5)).toBe(0);
		// The fresh copy surfaced → useful.
		expect(usefulContextAtK(ranked(["fresh", "stale"]), c, 5)).toBe(1);
	});

	it("a correct-but-LOSING conflict id does NOT count (the κ = ρ loser is excluded) → miss (0)", () => {
		const c: UsefulContextCase = { caseId: "x", correctIds: ["winner", "loser"], excludedIds: ["loser"] };
		expect(usefulContextAtK(ranked(["loser"]), c, 5)).toBe(0);
		expect(usefulContextAtK(ranked(["winner", "loser"]), c, 5)).toBe(1);
	});

	it("respects k: a useful id below the cutoff does not count at small k", () => {
		const c: UsefulContextCase = { caseId: "x", correctIds: ["good"], excludedIds: [] };
		expect(usefulContextAtK(ranked(["a", "b", "good"]), c, 1)).toBe(0); // good is at rank 3.
		expect(usefulContextAtK(ranked(["a", "b", "good"]), c, 5)).toBe(1);
	});

	it("aggregateUsefulContext: an empty set → all-zero, count 0, never NaN", () => {
		const m = aggregateUsefulContext([]);
		expect(m.count).toBe(0);
		expect(Number.isNaN(m.usefulAtK["5"])).toBe(false);
		expect(m.usefulAtK["5"]).toBe(0);
	});

	it("aggregateUsefulContext: means the per-case scores at each k", () => {
		const cases = [
			{ result: { ids: ["good"] }, useful: { caseId: "a", correctIds: ["good"], excludedIds: [] } },
			{ result: { ids: ["stale"] }, useful: { caseId: "b", correctIds: ["fresh", "stale"], excludedIds: ["stale"] } },
		];
		const m = aggregateUsefulContext(cases);
		expect(m.count).toBe(2);
		expect(m.usefulAtK["5"]).toBe(0.5); // one useful, one not.
	});
});

describe("PRD-058 W-1 runUsefulContextSlice — the engine-agnostic headline runner", () => {
	it("scores useful-context@k against a deterministic fake recall", async () => {
		const pairs: UsefulContextPair[] = [
			{ key: "fresh-wins", query: "deploy cadence", correctIds: ["fresh", "stale"], excludedIds: ["stale"] },
			{ key: "only-stale", query: "old policy", correctIds: ["f2", "s2"], excludedIds: ["s2"] },
		];
		// Recall returns the fresh copy for the first query, only the stale copy for the second.
		const recall = async (q: string): Promise<string[]> =>
			q === "deploy cadence" ? ["fresh", "stale"] : ["s2", "noise"];
		const report = await runUsefulContextSlice(pairs, recall);
		expect(report.metrics.usefulAtK["5"]).toBe(0.5); // first useful, second not (only stale surfaced).
		expect(report.cases.find((c) => c.key === "fresh-wins")!.usefulAtK["5"]).toBe(1);
		expect(report.cases.find((c) => c.key === "only-stale")!.usefulAtK["5"]).toBe(0);
	});
});

// ── W-2: ECE-over-time ────────────────────────────────────────────────────────

describe("PRD-058e W-2 runEceOverTimeSlice — the calibration trend curve", () => {
	/** A window of perfectly-calibrated samples (predicted ≈ observed) → low ECE. */
	function calibratedWindow(label: string): EceWindow {
		const samples: CalibrationSample[] = [];
		// Half at f≈1 with y=1, half at f≈0 with y=0 → the identity model is well-calibrated here.
		for (let i = 0; i < 20; i++) samples.push({ f: 0.95, y: 1 });
		for (let i = 0; i < 20; i++) samples.push({ f: 0.05, y: 0 });
		return { label, samples };
	}
	/** A window of MIScalibrated samples (high confidence, frequently wrong) → high ECE under identity. */
	function miscalibratedWindow(label: string): EceWindow {
		const samples: CalibrationSample[] = [];
		for (let i = 0; i < 20; i++) samples.push({ f: 0.9, y: i % 2 === 0 ? 1 : 0 }); // says .9, right half the time.
		return { label, samples };
	}

	it("computes a per-window ECE/Brier curve oldest-first", () => {
		const report = runEceOverTimeSlice([miscalibratedWindow("w1"), calibratedWindow("w2")]);
		expect(report.curve.map((p) => p.label)).toEqual(["w1", "w2"]);
		expect(report.curve[0]!.count).toBe(20);
		expect(report.curve[1]!.count).toBe(40);
		// The miscalibrated window has a HIGHER ECE than the calibrated one (the trend the curve shows).
		expect(report.curve[0]!.ece).toBeGreaterThan(report.curve[1]!.ece);
	});

	it("improved = true when the last window's ECE is ≤ the first's (calibration did not regress)", () => {
		const report = runEceOverTimeSlice([miscalibratedWindow("early"), calibratedWindow("late")]);
		expect(report.firstEce).toBeGreaterThan(report.lastEce);
		expect(report.improved).toBe(true);
	});

	it("improved = false when calibration got WORSE over time (a regression the curve surfaces)", () => {
		const report = runEceOverTimeSlice([calibratedWindow("early"), miscalibratedWindow("late")]);
		expect(report.lastEce).toBeGreaterThan(report.firstEce);
		expect(report.improved).toBe(false);
	});

	it("a fitted model lowers a window's ECE vs the identity default (the curve reflects the refit)", () => {
		const window = miscalibratedWindow("w");
		// Fit an isotonic curve over enough samples; with minSamples low it is non-identity.
		const fitted = fitIsotonic(window.samples, 1);
		const idReport = runEceOverTimeSlice([window]);
		const fitReport = runEceOverTimeSlice([{ ...window, model: fitted }]);
		// The fitted curve calibrates the over-confident 0.9 down toward the observed 0.5 → lower ECE.
		expect(fitReport.curve[0]!.ece).toBeLessThanOrEqual(idReport.curve[0]!.ece);
	});

	it("an empty window set → empty curve, improved true, never NaN", () => {
		const report = runEceOverTimeSlice([]);
		expect(report.curve).toHaveLength(0);
		expect(report.improved).toBe(true);
		expect(Number.isNaN(report.firstEce)).toBe(false);
	});
});
