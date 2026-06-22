/**
 * PRD-046f f-AC-1..4 — the prime-scenario set + harness + gate unit suite.
 *
 * Every numeric expectation is HAND-COMPUTED (no "feels better" — the same discipline as
 * `metrics.test.ts`). Covers: the COMMITTED scenario set validates + is secret-free in shape;
 * the loader rejects a malformed / duplicate-key set; the pure pull-through / redundant-search
 * signals; the harness runner scores a DETERMINISTIC fake primed-vs-cold (primed surfaces the
 * target, cold does not — f-AC-3); and the prime baseline gate (placeholder advisory vs enforced
 * fail — f-AC-4). Pure — no creds, no daemon; runs in `npm run ci`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	aggregatePrime,
	comparePrimedVsCold,
	EPSILON_PRIME,
	gatePrimeAgainstBaseline,
	loadPrimeBaseline,
	loadPrimeScenarioSet,
	parsePrimeScenarioSet,
	pullThrough,
	redundantSearchReduction,
	runPrimeEval,
	scoreScenario,
	targetSeedTextFor,
	uniquePrimeKeyFor,
	type ColdBehavior,
	type ColdOutcome,
	type PrimeAggregate,
	type PrimedBehavior,
	type PrimedOutcome,
	type PrimeScenario,
	type PrimeScenarioSet,
} from "../../src/eval/prime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo-root `eval/` dir (this test lives at tests/eval/). */
const EVAL_DIR = join(HERE, "..", "..", "eval");

function readEval(name: string): string {
	return readFileSync(join(EVAL_DIR, name), "utf8");
}

describe("the committed prime-scenario set (f-AC-1)", () => {
	const set = loadPrimeScenarioSet(readEval("prime-golden.json"));

	it("validates and holds a substantive set (≥ 8 scenarios)", () => {
		expect(set.scenarios.length).toBeGreaterThanOrEqual(8);
	});

	it("every scenario has a non-empty key, target, task, and positive cold/primed counts", () => {
		for (const sc of set.scenarios) {
			expect(sc.key.length).toBeGreaterThan(0);
			expect(sc.targetMemoryText.length).toBeGreaterThan(0);
			expect(sc.task.length).toBeGreaterThan(0);
			expect(sc.coldSearchCount).toBeGreaterThan(0);
			expect(sc.primedResolveCount).toBeGreaterThan(0);
		}
	});

	it("every scenario carries distractor memories (pull-through is a real discrimination, not a one-item list)", () => {
		for (const sc of set.scenarios) {
			expect(sc.distractorMemoryTexts.length, `scenario "${sc.key}" needs distractors`).toBeGreaterThan(0);
		}
	});

	it("the cold blind-search cost exceeds the primed resolve cost (priming has room to win)", () => {
		for (const sc of set.scenarios) {
			expect(
				sc.coldSearchCount,
				`scenario "${sc.key}": cold (${sc.coldSearchCount}) must exceed primed (${sc.primedResolveCount})`,
			).toBeGreaterThan(sc.primedResolveCount);
		}
	});

	it("is secret-free in shape: no @-emails, no obvious key/token literals in any scenario text", () => {
		// A lightweight in-test guard (the grep proof in the report is the authority — f-AC-5).
		const blob = JSON.stringify(set);
		expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); // no emails
		expect(blob).not.toMatch(/sk-[A-Za-z0-9]{16,}/); // no OpenAI-style keys
		expect(blob).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/); // no AWS access keys
	});
});

describe("loader validation (f-AC-1)", () => {
	it("parsePrimeScenarioSet rejects duplicate keys", () => {
		expect(() =>
			parsePrimeScenarioSet({
				scenarios: [
					{ key: "dup", targetMemoryText: "x", task: "t", coldSearchCount: 2, primedResolveCount: 1 },
					{ key: "dup", targetMemoryText: "y", task: "u", coldSearchCount: 2, primedResolveCount: 1 },
				],
			}),
		).toThrow(/duplicate scenario key/);
	});

	it("loadPrimeScenarioSet throws on malformed JSON and on an empty scenario set", () => {
		expect(() => loadPrimeScenarioSet("{not json")).toThrow(/not valid JSON/);
		expect(() => loadPrimeScenarioSet(JSON.stringify({ scenarios: [] }))).toThrow();
	});

	it("rejects a non-positive cold/primed count and a missing target", () => {
		expect(() =>
			parsePrimeScenarioSet({
				scenarios: [{ key: "k", targetMemoryText: "x", task: "t", coldSearchCount: 0, primedResolveCount: 1 }],
			}),
		).toThrow();
		expect(() =>
			parsePrimeScenarioSet({
				scenarios: [{ key: "k", targetMemoryText: "", task: "t", coldSearchCount: 2, primedResolveCount: 1 }],
			}),
		).toThrow();
	});

	it("defaults distractorMemoryTexts to [] when absent", () => {
		const set = parsePrimeScenarioSet({
			scenarios: [{ key: "k", targetMemoryText: "x", task: "t", coldSearchCount: 2, primedResolveCount: 1 }],
		});
		expect(set.scenarios[0]!.distractorMemoryTexts).toEqual([]);
	});
});

describe("per-run isolation keys (f-AC-1)", () => {
	it("uniquePrimeKeyFor + targetSeedTextFor stamp the run id; the task never carries it", () => {
		expect(uniquePrimeKeyFor("p-foo", "run42")).toBe("p-foo-run42");
		const sc: PrimeScenario = {
			key: "p-foo",
			targetMemoryText: "we decided to poll until convergence",
			distractorMemoryTexts: [],
			task: "what did we decide about stale reads",
			coldSearchCount: 3,
			primedResolveCount: 1,
		};
		expect(targetSeedTextFor(sc, "run42")).toBe("we decided to poll until convergence [run42]");
		expect(sc.task).not.toContain("run42");
	});
});

describe("the pure signals (f-AC-2, hand-computed)", () => {
	it("pull-through is 1 when the primed agent resolved the target, 0 when it did not", () => {
		expect(pullThrough({ resolvedTargetId: "id1", blindSearches: 0 })).toBe(1);
		expect(pullThrough({ resolvedTargetId: null, blindSearches: 2 })).toBe(0);
	});

	it("redundant-search reduction is cold − primed, floored at 0", () => {
		// cold ran 3, primed ran 0 → reduction 3.
		expect(redundantSearchReduction({ resolvedTargetId: "t", blindSearches: 0 }, { targetId: "t", blindSearches: 3 })).toBe(3);
		// cold ran 2, primed ran 2 → reduction 0.
		expect(redundantSearchReduction({ resolvedTargetId: null, blindSearches: 2 }, { targetId: "t", blindSearches: 2 })).toBe(0);
		// primed somehow ran MORE than cold → floored at 0 (never a negative reward).
		expect(redundantSearchReduction({ resolvedTargetId: null, blindSearches: 5 }, { targetId: "t", blindSearches: 2 })).toBe(0);
	});

	it("scoreScenario folds the two outcomes into one report row", () => {
		const sc: PrimeScenario = {
			key: "p-x",
			targetMemoryText: "m",
			distractorMemoryTexts: [],
			task: "t",
			coldSearchCount: 3,
			primedResolveCount: 1,
		};
		const primed: PrimedOutcome = { resolvedTargetId: "idT", blindSearches: 0 };
		const cold: ColdOutcome = { targetId: "idT", blindSearches: 3 };
		const row = scoreScenario(sc, primed, cold);
		expect(row.pullThrough).toBe(1);
		expect(row.primedBlindSearches).toBe(0);
		expect(row.coldBlindSearches).toBe(3);
		expect(row.searchReduction).toBe(3);
		expect(row.primedTargetId).toBe("idT");
		expect(row.coldTargetId).toBe("idT");
	});
});

describe("aggregatePrime (the eval headline, hand-computed)", () => {
	it("means pull-through + blind searches + reduction over the scenario set", () => {
		// S1: pull-through 1, primed 0, cold 3, reduction 3.
		// S2: pull-through 0, primed 2, cold 2, reduction 0.
		const reports = [
			scoreScenario(
				{ key: "s1", targetMemoryText: "m", distractorMemoryTexts: [], task: "t", coldSearchCount: 3, primedResolveCount: 1 },
				{ resolvedTargetId: "a", blindSearches: 0 },
				{ targetId: "a", blindSearches: 3 },
			),
			scoreScenario(
				{ key: "s2", targetMemoryText: "m", distractorMemoryTexts: [], task: "t", coldSearchCount: 2, primedResolveCount: 1 },
				{ resolvedTargetId: null, blindSearches: 2 },
				{ targetId: "b", blindSearches: 2 },
			),
		];
		const agg = aggregatePrime(reports);
		expect(agg.scenarioCount).toBe(2);
		expect(agg.pullThroughRate).toBeCloseTo(0.5, 10); // (1 + 0)/2
		expect(agg.primedBlindSearchMean).toBeCloseTo(1, 10); // (0 + 2)/2
		expect(agg.coldBlindSearchMean).toBeCloseTo(2.5, 10); // (3 + 2)/2
		expect(agg.searchReductionMean).toBeCloseTo(1.5, 10); // (3 + 0)/2
	});

	it("an empty set yields all-zero signals with scenarioCount 0 (never NaN)", () => {
		const agg = aggregatePrime([]);
		expect(agg.scenarioCount).toBe(0);
		expect(agg.pullThroughRate).toBe(0);
		expect(agg.searchReductionMean).toBe(0);
	});
});

describe("runPrimeEval + comparePrimedVsCold (f-AC-3, the 'priming helps' proof)", () => {
	const set: PrimeScenarioSet = {
		scenarios: [
			{ key: "a", targetMemoryText: "decision A", distractorMemoryTexts: ["noise"], task: "what is A", coldSearchCount: 3, primedResolveCount: 1 },
			{ key: "b", targetMemoryText: "decision B", distractorMemoryTexts: ["noise"], task: "what is B", coldSearchCount: 2, primedResolveCount: 1 },
		],
	};

	// DETERMINISTIC fake: PRIMED surfaces the target (the digest carried it) with zero blind
	// searches; COLD must blind-search (coldSearchCount) and reaches the target only at that cost.
	const primed: PrimedBehavior = async (sc) => ({ resolvedTargetId: `id-${sc.key}`, blindSearches: 0 });
	const cold: ColdBehavior = async (sc) => ({ targetId: `id-${sc.key}`, blindSearches: sc.coldSearchCount });

	it("primed beats cold: full pull-through where cold is structurally 0, and a positive reduction", async () => {
		const report = await runPrimeEval(set, primed, cold);
		expect(report.scenarios).toHaveLength(2);

		// Every scenario pulled through (primed surfaced the target); cold needed its blind searches.
		expect(report.aggregate.pullThroughRate).toBe(1); // both pulled through → 1.0
		expect(report.aggregate.primedBlindSearchMean).toBe(0); // primed needed no blind search
		expect(report.aggregate.coldBlindSearchMean).toBeCloseTo(2.5, 10); // (3 + 2)/2
		expect(report.aggregate.searchReductionMean).toBeCloseTo(2.5, 10); // cold − primed

		const lift = comparePrimedVsCold(report.aggregate);
		expect(lift.beats).toBe(true);
		expect(lift.pullThroughRate).toBe(1);
		expect(lift.searchReductionMean).toBeCloseTo(2.5, 10);
	});

	it("a COLD-EQUIVALENT primed arm (no digest) does NOT beat cold (the kill criterion has teeth)", async () => {
		// A prime the agent ignores: primed never resolves a target and blind-searches exactly like
		// cold → pull-through 0, reduction 0 → NOT a beat. This is the 'pull it' branch.
		const ignoredPrime: PrimedBehavior = async (sc) => ({ resolvedTargetId: null, blindSearches: sc.coldSearchCount });
		const report = await runPrimeEval(set, ignoredPrime, cold);
		expect(report.aggregate.pullThroughRate).toBe(0);
		expect(report.aggregate.searchReductionMean).toBe(0);
		expect(comparePrimedVsCold(report.aggregate).beats).toBe(false);
	});

	it("priming that pulls through but at a blind-search COST does not regress (reduction floored ≥ 0)", async () => {
		// Pull-through positive but primed ran as many searches as cold → reduction 0, still ≥ 0,
		// so no regression and the positive pull-through carries the beat.
		const costlyPrime: PrimedBehavior = async (sc) => ({ resolvedTargetId: `id-${sc.key}`, blindSearches: sc.coldSearchCount });
		const report = await runPrimeEval(set, costlyPrime, cold);
		expect(report.aggregate.pullThroughRate).toBe(1);
		expect(report.aggregate.searchReductionMean).toBe(0);
		expect(comparePrimedVsCold(report.aggregate).beats).toBe(true); // positive pull-through, no regression
	});
});

describe("the prime baseline gate (f-AC-4)", () => {
	const committed = loadPrimeBaseline(readEval("prime-baseline.json"));

	function aggWith(pullThroughRate: number, searchReductionMean: number): PrimeAggregate {
		return { scenarioCount: 1, pullThroughRate, searchReductionMean, primedBlindSearchMean: 0, coldBlindSearchMean: 0 };
	}

	it("the committed baseline is a valid, ADVISORY placeholder until the first live measurement", () => {
		// Committed advisory (placeholder=true): the gate computes the verdict but never FAILS a run
		// until the measured baseline is committed (same posture as PRD-027/045). The numbers are valid.
		expect(committed.placeholder).toBe(true);
		expect(committed.pullThroughRate).toBeGreaterThan(0);
		expect(committed.pullThroughRate).toBeLessThanOrEqual(1);
		expect(committed.searchReductionMean).toBeGreaterThanOrEqual(0);
	});

	it("a PLACEHOLDER baseline makes the gate advisory — never fails, but reports the comparison", () => {
		const placeholder = { pullThroughRate: 0.9, searchReductionMean: 1.5, placeholder: true };
		const below = aggWith(0.1, 0.1); // far below the placeholder floor
		const v = gatePrimeAgainstBaseline(below, placeholder);
		expect(v.advisory).toBe(true);
		expect(v.passed).toBe(true); // advisory → never fails the run
		expect(v.reasons.length).toBeGreaterThan(0); // but the regression is still reported
	});

	it("an ENFORCED baseline FAILS when pull-through or reduction drops below baseline − ε", () => {
		const enforced = { pullThroughRate: 0.8, searchReductionMean: 1.5, placeholder: false };
		// floors: pull-through 0.75, reduction 1.45.
		const belowPull = aggWith(0.7, 1.5); // pull-through below floor
		const v1 = gatePrimeAgainstBaseline(belowPull, enforced);
		expect(v1.advisory).toBe(false);
		expect(v1.passed).toBe(false);
		expect(v1.reasons.some((r) => r.includes("pull-through"))).toBe(true);

		const belowRed = aggWith(0.8, 1.0); // reduction below floor
		const v2 = gatePrimeAgainstBaseline(belowRed, enforced);
		expect(v2.passed).toBe(false);
		expect(v2.reasons.some((r) => r.includes("search-reduction"))).toBe(true);
	});

	it("an ENFORCED baseline PASSES within ε of the baseline (noise tolerance)", () => {
		const enforced = { pullThroughRate: 0.8, searchReductionMean: 1.5, placeholder: false };
		const atFloor = aggWith(0.8 - EPSILON_PRIME, 1.5 - EPSILON_PRIME); // exactly at the floor passes
		expect(gatePrimeAgainstBaseline(atFloor, enforced).passed).toBe(true);
		expect(gatePrimeAgainstBaseline(aggWith(0.95, 2.0), enforced).passed).toBe(true); // above passes
	});

	it("EPSILON_PRIME is a small, named, positive tolerance", () => {
		expect(EPSILON_PRIME).toBeGreaterThan(0);
		expect(EPSILON_PRIME).toBeLessThanOrEqual(0.1);
	});
});
