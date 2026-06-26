/**
 * PRD-058c — the staleness precision/recall/F1 eval slice suite.
 *
 * The committed slice answers "do we flag the dead references and ONLY those?" — the staleness analogue of
 * the 058a freshness ordering gate. These tests pin the precision/recall/F1 math (no NaN, the
 * no-flag/no-label vacuous cases) and the engine-agnostic slice runner driven by a deterministic predictor.
 * The LIVE numeric run wires the real diagnostic against a seeded snapshot and SKIPs without creds; the
 * slice CODE + this coverage ship now.
 */

import { describe, expect, it } from "vitest";

import { stalenessMetrics, type StalenessCase } from "../../src/eval/metrics.js";
import { runStalenessSlice, type StalenessPair, type StalenessPredictor } from "../../src/eval/golden.js";

describe("PRD-058c stalenessMetrics — precision / recall / F1", () => {
	it("a perfect classifier → precision = recall = F1 = 1", () => {
		const cases: StalenessCase[] = [
			{ caseId: "a", labeledStale: true, predictedStale: true },
			{ caseId: "b", labeledStale: false, predictedStale: false },
		];
		expect(stalenessMetrics(cases)).toMatchObject({ precision: 1, recall: 1, f1: 1, truePositives: 1 });
	});

	it("a false positive (flagged a fresh memory) drops precision below 1", () => {
		const cases: StalenessCase[] = [
			{ caseId: "a", labeledStale: true, predictedStale: true },
			{ caseId: "b", labeledStale: false, predictedStale: true }, // false alarm
		];
		const m = stalenessMetrics(cases);
		expect(m.precision).toBeCloseTo(0.5, 10);
		expect(m.recall).toBe(1);
		expect(m.falsePositives).toBe(1);
	});

	it("a false negative (missed a dangling ref) drops recall below 1", () => {
		const cases: StalenessCase[] = [
			{ caseId: "a", labeledStale: true, predictedStale: false }, // missed
			{ caseId: "b", labeledStale: true, predictedStale: true },
		];
		const m = stalenessMetrics(cases);
		expect(m.recall).toBeCloseTo(0.5, 10);
		expect(m.precision).toBe(1);
		expect(m.falseNegatives).toBe(1);
	});

	it("no flags raised → precision is vacuously 1 (no false alarm), never NaN", () => {
		const cases: StalenessCase[] = [{ caseId: "a", labeledStale: false, predictedStale: false }];
		expect(stalenessMetrics(cases).precision).toBe(1);
	});

	it("nothing labeled stale → recall is vacuously 1 (nothing to miss), never NaN", () => {
		const cases: StalenessCase[] = [{ caseId: "a", labeledStale: false, predictedStale: false }];
		expect(stalenessMetrics(cases).recall).toBe(1);
	});

	it("an empty slice → no NaN (1/1/1 vacuously)", () => {
		const m = stalenessMetrics([]);
		expect(Number.isNaN(m.f1)).toBe(false);
		expect(m).toMatchObject({ count: 0, precision: 1, recall: 1 });
	});
});

describe("PRD-058c runStalenessSlice — the engine-agnostic slice runner", () => {
	it("scores a labeled set against a deterministic predictor (flags content containing #gone)", async () => {
		const pairs: StalenessPair[] = [
			{ key: "dangling", content: "the call src/a.ts#gone runs it", labeledStale: true },
			{ key: "fresh", content: "the call src/a.ts#keep runs it", labeledStale: false },
		];
		// A toy predictor: flag any content naming `#gone` (stands in for the real diagnostic verdict).
		const predict: StalenessPredictor = async (content) => /#gone\b/.test(content);
		const report = await runStalenessSlice(pairs, predict);
		expect(report.cases).toHaveLength(2);
		expect(report.metrics).toMatchObject({ precision: 1, recall: 1, f1: 1 });
		expect(report.cases.find((c) => c.key === "dangling")!.predictedStale).toBe(true);
		expect(report.cases.find((c) => c.key === "fresh")!.predictedStale).toBe(false);
	});

	it("surfaces a false positive in the committed metrics (auditable, not asserted-away)", async () => {
		const pairs: StalenessPair[] = [{ key: "fresh", content: "src/a.ts#keep", labeledStale: false }];
		const predict: StalenessPredictor = async () => true; // an over-eager predictor
		const report = await runStalenessSlice(pairs, predict);
		expect(report.metrics.falsePositives).toBe(1);
		expect(report.metrics.precision).toBe(0);
	});
});
