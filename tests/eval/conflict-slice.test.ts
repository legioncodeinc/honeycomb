/**
 * PRD-058b — the conflict eval slice suite (CRA + contradiction-detection precision/recall/F1).
 *
 * The committed slice answers two questions the scoring-model metrics table poses for the conflict term:
 * "do we detect the right contradiction pairs and ONLY those?" (contradiction PR/F1) and "do we pick the
 * right winner?" (Conflict Resolution Accuracy). These tests pin the math (no NaN, the vacuous cases) and
 * the engine-agnostic slice runner driven by deterministic predictors. The LIVE numeric run wires the real
 * detector + resolver against a labeled set and SKIPs without creds; the slice CODE + this coverage ship now.
 */

import { describe, expect, it } from "vitest";

import {
	conflictResolutionAccuracy,
	contradictionMetrics,
	type ConflictResolutionCase,
	type ContradictionCase,
} from "../../src/eval/metrics.js";
import { runConflictSlice, type ConflictPair } from "../../src/eval/golden.js";

describe("PRD-058b contradictionMetrics — detection precision / recall / F1", () => {
	it("a perfect classifier → precision = recall = F1 = 1", () => {
		const cases: ContradictionCase[] = [
			{ caseId: "a", labeledConflict: true, predictedConflict: true },
			{ caseId: "b", labeledConflict: false, predictedConflict: false },
		];
		expect(contradictionMetrics(cases)).toMatchObject({ precision: 1, recall: 1, f1: 1 });
	});

	it("a false positive (flagged an independent fact) drops precision below 1 — the forbidden failure mode is auditable", () => {
		const cases: ContradictionCase[] = [
			{ caseId: "a", labeledConflict: true, predictedConflict: true },
			{ caseId: "b", labeledConflict: false, predictedConflict: true }, // false alarm.
		];
		const m = contradictionMetrics(cases);
		expect(m.precision).toBeCloseTo(0.5, 10);
		expect(m.falsePositives).toBe(1);
	});

	it("a missed contradiction drops recall below 1", () => {
		const cases: ContradictionCase[] = [
			{ caseId: "a", labeledConflict: true, predictedConflict: false }, // missed.
			{ caseId: "b", labeledConflict: true, predictedConflict: true },
		];
		expect(contradictionMetrics(cases).recall).toBeCloseTo(0.5, 10);
	});

	it("an empty slice → no NaN (1/1/1 vacuously)", () => {
		const m = contradictionMetrics([]);
		expect(Number.isNaN(m.f1)).toBe(false);
		expect(m).toMatchObject({ count: 0, precision: 1, recall: 1 });
	});
});

describe("PRD-058b conflictResolutionAccuracy (CRA)", () => {
	it("counts the fraction whose predicted winner matches the labeled winner", () => {
		const cases: ConflictResolutionCase[] = [
			{ caseId: "a", expectedWinnerId: "x", predictedWinnerId: "x" },
			{ caseId: "b", expectedWinnerId: "y", predictedWinnerId: "z" }, // wrong winner.
		];
		expect(conflictResolutionAccuracy(cases)).toMatchObject({ count: 2, correct: 1, accuracy: 0.5 });
	});

	it("an empty set → accuracy 1 vacuously, never NaN", () => {
		const m = conflictResolutionAccuracy([]);
		expect(Number.isNaN(m.accuracy)).toBe(false);
		expect(m.accuracy).toBe(1);
	});
});

describe("PRD-058b runConflictSlice — the engine-agnostic slice runner", () => {
	it("scores detection PR/F1 + CRA against deterministic predictors", async () => {
		const pairs: ConflictPair[] = [
			{ key: "real", aId: "a", bId: "b", labeledConflict: true, expectedWinnerId: "a" },
			{ key: "independent", aId: "c", bId: "d", labeledConflict: false, expectedWinnerId: "" },
		];
		// Detector: flags the genuine pair, not the independent one. Resolver: picks the labeled winner.
		const detect = async (aId: string) => aId === "a";
		const pickWinner = async (aId: string) => aId; // picks "a" (the labeled winner).
		const report = await runConflictSlice(pairs, detect, pickWinner);
		expect(report.detection).toMatchObject({ precision: 1, recall: 1, f1: 1 });
		expect(report.resolution).toMatchObject({ count: 1, correct: 1, accuracy: 1 });
		expect(report.cases.find((c) => c.key === "real")!.predictedWinnerId).toBe("a");
	});

	it("CRA is scored ONLY over genuine conflicts the detector also caught", async () => {
		const pairs: ConflictPair[] = [
			{ key: "missed", aId: "a", bId: "b", labeledConflict: true, expectedWinnerId: "a" },
		];
		const detect = async () => false; // the detector MISSES the genuine conflict.
		const pickWinner = async () => "should-not-be-called";
		const report = await runConflictSlice(pairs, detect, pickWinner);
		// The winner predictor was never asked (the detector missed it) → CRA has nothing to score (vacuous 1).
		expect(report.resolution).toMatchObject({ count: 0, accuracy: 1 });
		expect(report.detection.recall).toBe(0); // the miss is surfaced in detection recall.
	});

	it("surfaces a contradiction false positive in the committed detection metrics (auditable)", async () => {
		const pairs: ConflictPair[] = [
			{ key: "independent", aId: "c", bId: "d", labeledConflict: false, expectedWinnerId: "" },
		];
		const detect = async () => true; // an over-eager detector flags an independent fact.
		const pickWinner = async () => "";
		const report = await runConflictSlice(pairs, detect, pickWinner);
		expect(report.detection.falsePositives).toBe(1);
		expect(report.detection.precision).toBe(0);
	});
});
