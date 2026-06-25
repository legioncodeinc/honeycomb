/**
 * PRD-027 D-6 / AC-5 — the recall-quality METRICS unit suite.
 *
 * Every expectation here is HAND-COMPUTED (no "feels better" — the PRD risk note).
 * The metrics are pure functions over `(ranked ids, judgements)`, so each case fixes
 * a tiny ranked list + a relevance map and asserts the exact recall@k / MRR / nDCG.
 * These run in `npm run ci` (no creds, no daemon).
 */

import { describe, expect, it } from "vitest";

import {
	aggregateMetrics,
	dcgAtK,
	firstRelevantRank,
	idealDcgAtK,
	isRelevant,
	ndcgAtK,
	NDCG_K,
	recallAtK,
	reciprocalRank,
	RECALL_K_VALUES,
	type RankedResult,
	type RelevanceJudgements,
	type ScoredQuery,
} from "../../src/eval/metrics.js";

/** A close-enough float compare (the metrics are exact rationals; allow tiny fp drift). */
function near(actual: number, expected: number): void {
	expect(actual).toBeCloseTo(expected, 10);
}

describe("recall@k (D-6)", () => {
	const judg: RelevanceJudgements = { target: 1 };

	it("is 1 when the expected id is within the top-k, 0 otherwise", () => {
		// target at rank 3 (index 2).
		const r: RankedResult = { ids: ["a", "b", "target", "c", "d"] };
		expect(recallAtK(r, judg, 1)).toBe(0); // not in top-1
		expect(recallAtK(r, judg, 2)).toBe(0); // not in top-2
		expect(recallAtK(r, judg, 3)).toBe(1); // in top-3
		expect(recallAtK(r, judg, 5)).toBe(1); // in top-5
		expect(recallAtK(r, judg, 10)).toBe(1); // k beyond length → whole list
	});

	it("is 0 when the expected id is absent entirely", () => {
		const r: RankedResult = { ids: ["a", "b", "c"] };
		expect(recallAtK(r, judg, 10)).toBe(0);
	});

	it("clamps k to ≥ 1 and treats rank-1 as in top-1", () => {
		const r: RankedResult = { ids: ["target", "a"] };
		expect(recallAtK(r, judg, 0)).toBe(1); // clamped to 1, target at rank 1
		expect(recallAtK(r, judg, 1)).toBe(1);
	});
});

describe("firstRelevantRank + MRR (D-6)", () => {
	const judg: RelevanceJudgements = { target: 1 };

	it("reports the 1-based rank of the first relevant hit", () => {
		expect(firstRelevantRank({ ids: ["target"] }, judg)).toBe(1);
		expect(firstRelevantRank({ ids: ["a", "target"] }, judg)).toBe(2);
		expect(firstRelevantRank({ ids: ["a", "b", "c", "target"] }, judg)).toBe(4);
		expect(firstRelevantRank({ ids: ["a", "b"] }, judg)).toBeNull();
	});

	it("reciprocal rank is 1/rank, or 0 on a miss", () => {
		near(reciprocalRank({ ids: ["target"] }, judg), 1); // 1/1
		near(reciprocalRank({ ids: ["a", "target"] }, judg), 0.5); // 1/2
		near(reciprocalRank({ ids: ["a", "b", "target"] }, judg), 1 / 3); // 1/3
		expect(reciprocalRank({ ids: ["a", "b"] }, judg)).toBe(0); // miss → 0
	});

	it("takes the FIRST relevant of several relevant ids", () => {
		const multi: RelevanceJudgements = { x: 1, y: 1 };
		// y at rank 2, x at rank 4 → first relevant is rank 2.
		expect(firstRelevantRank({ ids: ["a", "y", "b", "x"] }, multi)).toBe(2);
		near(reciprocalRank({ ids: ["a", "y", "b", "x"] }, multi), 0.5);
	});
});

describe("DCG / IDCG / nDCG (D-6, binary + graded)", () => {
	it("binary nDCG: a single relevant id at rank 2 → 1/log2(3) normalized by ideal 1/log2(2)=1", () => {
		const judg: RelevanceJudgements = { target: 1 };
		const r: RankedResult = { ids: ["a", "target", "b"] };
		// DCG = 1/log2(2+1) = 1/log2(3) ≈ 0.6309297536
		near(dcgAtK(r, judg, 10), 1 / Math.log2(3));
		// IDCG = best ordering: target at rank 1 → 1/log2(2) = 1
		near(idealDcgAtK(judg, 10), 1);
		// nDCG = DCG/IDCG = 1/log2(3)
		near(ndcgAtK(r, judg, 10), 1 / Math.log2(3));
	});

	it("perfect ranking → nDCG 1.0", () => {
		const judg: RelevanceJudgements = { target: 1 };
		near(ndcgAtK({ ids: ["target", "a", "b"] }, judg, 10), 1);
	});

	it("a complete miss → nDCG 0 (relevant id absent from the list)", () => {
		const judg: RelevanceJudgements = { target: 1 };
		expect(ndcgAtK({ ids: ["a", "b"] }, judg, 10)).toBe(0);
	});

	it("no judgements → nDCG 0, never NaN (IDCG is 0)", () => {
		expect(ndcgAtK({ ids: ["a"] }, {}, 10)).toBe(0);
		expect(idealDcgAtK({}, 10)).toBe(0);
	});

	it("graded relevance: two relevant ids, gains 3 and 1, ranked best-first", () => {
		// ids: hi (gain 3) at rank 1, lo (gain 1) at rank 3.
		const judg: RelevanceJudgements = { hi: 3, lo: 1 };
		const r: RankedResult = { ids: ["hi", "x", "lo"] };
		// DCG = 3/log2(2) + 1/log2(4) = 3 + 0.5 = 3.5
		near(dcgAtK(r, judg, 10), 3 + 1 / 2);
		// IDCG (best: hi rank1, lo rank2) = 3/log2(2) + 1/log2(3) = 3 + 0.6309297536
		near(idealDcgAtK(judg, 10), 3 + 1 / Math.log2(3));
		near(ndcgAtK(r, judg, 10), (3 + 0.5) / (3 + 1 / Math.log2(3)));
	});

	it("dcgAtK respects the top-k cutoff", () => {
		const judg: RelevanceJudgements = { target: 1 };
		// target at rank 3; with k=2 it is outside the cut → DCG 0.
		expect(dcgAtK({ ids: ["a", "b", "target"] }, judg, 2)).toBe(0);
	});
});

describe("DEDUP-INVARIANT nDCG via relevance classes (PRD-047c c-AC-3)", () => {
	// Each golden pair targets ONE distinct fact; the relevance class is duplicate COPIES
	// of that same fact. With a class map, DCG credits the class ONCE (best rank) and IDCG
	// ranks DISTINCT classes (one gain per class), so an engine scores the same whether it
	// returns one copy or many — the property the old clone-summing nDCG lacked.

	it("a single-fact class with the best member at rank 1 → nDCG 1.0 regardless of extra clones", () => {
		// Three copies of ONE fact (all class "c"), best at rank 1; two more clones follow.
		const judg: RelevanceJudgements = { c1: 1, c2: 1, c3: 1 };
		const classes = { c1: "c", c2: "c", c3: "c" };
		const r: RankedResult = { ids: ["c1", "x", "c2", "y", "c3"] };
		// DCG: class "c" credited ONCE at rank 1 → 1/log2(2) = 1. Clones c2/c3 add 0.
		near(dcgAtK(r, judg, 10, classes), 1);
		// IDCG: ONE distinct class, gain 1 at rank 1 → 1.
		near(idealDcgAtK(judg, 10, classes), 1);
		near(ndcgAtK(r, judg, 10, classes), 1);
	});

	it("DEDUP-INVARIANCE: adding more clones later in the ranking does not change nDCG", () => {
		const judg: RelevanceJudgements = { c1: 1, c2: 1, c3: 1, c4: 1 };
		const classes = { c1: "c", c2: "c", c3: "c", c4: "c" };
		// One copy at rank 1.
		const oneCopy: RankedResult = { ids: ["c1", "x", "y"] };
		// Same best rank (1) but three extra clones stuffed in later.
		const manyCopies: RankedResult = { ids: ["c1", "c2", "x", "c3", "c4"] };
		// Both score 1.0 — clone-stuffing earns nothing extra.
		near(ndcgAtK(oneCopy, judg, 10, classes), 1);
		near(ndcgAtK(manyCopies, judg, 10, classes), 1);
		expect(ndcgAtK(oneCopy, judg, 10, classes)).toBe(ndcgAtK(manyCopies, judg, 10, classes));
	});

	it("best class member at rank 2 → nDCG 1/log2(3) ≈ 0.6309, even with a clone at rank 1's neighbor", () => {
		// Best (first-seen) member of class "c" is at rank 2; a later clone at rank 4 adds 0.
		const judg: RelevanceJudgements = { c1: 1, c2: 1 };
		const classes = { c1: "c", c2: "c" };
		const r: RankedResult = { ids: ["x", "c1", "y", "c2"] };
		// DCG = 1/log2(2+1) = 1/log2(3); IDCG = 1 (one class at rank 1).
		near(dcgAtK(r, judg, 10, classes), 1 / Math.log2(3));
		near(idealDcgAtK(judg, 10, classes), 1);
		near(ndcgAtK(r, judg, 10, classes), 1 / Math.log2(3));
	});

	it("a distinct MISS (no class member surfaces) → nDCG 0", () => {
		const judg: RelevanceJudgements = { c1: 1, c2: 1 };
		const classes = { c1: "c", c2: "c" };
		expect(ndcgAtK({ ids: ["a", "b", "z"] }, judg, 10, classes)).toBe(0);
	});

	it("graded single-fact class: grade 3 at rank 2 → still 1/log2(3) (grade cancels in DCG/IDCG)", () => {
		// The class's grade is 3; best member at rank 2. DCG = 3/log2(3); IDCG = 3/log2(2) = 3.
		// nDCG = (3/log2(3))/3 = 1/log2(3) — dedup-invariant AND grade-normalized.
		const judg: RelevanceJudgements = { c1: 3, c2: 3 };
		const classes = { c1: "c", c2: "c" };
		const r: RankedResult = { ids: ["x", "c1", "c2"] };
		near(dcgAtK(r, judg, 10, classes), 3 / Math.log2(3));
		near(idealDcgAtK(judg, 10, classes), 3);
		near(ndcgAtK(r, judg, 10, classes), 1 / Math.log2(3));
	});

	it("two DISTINCT facts (two classes) still rank independently in DCG and IDCG", () => {
		// Class "a" (gain 3) at rank 1, class "b" (gain 1) at rank 3 — two distinct facts.
		const judg: RelevanceJudgements = { a1: 3, a2: 3, b1: 1 };
		const classes = { a1: "a", a2: "a", b1: "b" };
		const r: RankedResult = { ids: ["a1", "a2", "b1"] };
		// DCG: class a once at rank 1 (3), class b once at rank 3 (1/log2(4)=0.5). a2 adds 0.
		near(dcgAtK(r, judg, 10, classes), 3 + 0.5);
		// IDCG: two classes, gains 3 then 1, ideal ranks 1,2 → 3 + 1/log2(3).
		near(idealDcgAtK(judg, 10, classes), 3 + 1 / Math.log2(3));
		near(ndcgAtK(r, judg, 10, classes), (3 + 0.5) / (3 + 1 / Math.log2(3)));
	});

	it("without a class map the legacy per-id behavior is preserved (clone-summing)", () => {
		// No classes arg → each id is its own class → the old summing IDCG/DCG.
		const judg: RelevanceJudgements = { c1: 1, c2: 1 };
		const r: RankedResult = { ids: ["c1", "c2"] };
		// DCG = 1/log2(2) + 1/log2(3); IDCG = same → nDCG 1.0 (the pre-fix shape).
		near(dcgAtK(r, judg, 10), 1 + 1 / Math.log2(3));
		near(idealDcgAtK(judg, 10), 1 + 1 / Math.log2(3));
		near(ndcgAtK(r, judg, 10), 1);
	});
});

describe("isRelevant", () => {
	it("treats any strictly-positive gain as relevant; 0 / absent as not", () => {
		expect(isRelevant({ a: 1 }, "a")).toBe(true);
		expect(isRelevant({ a: 3 }, "a")).toBe(true);
		expect(isRelevant({ a: 0 }, "a")).toBe(false);
		expect(isRelevant({}, "a")).toBe(false);
	});
});

describe("aggregateMetrics (the eval headline)", () => {
	it("means recall@k / MRR / nDCG over the query set (hand-computed)", () => {
		// Q1: target at rank 1 → recall@all 1, RR 1, nDCG 1.
		// Q2: target at rank 6 → recall@1 0, recall@5 0, recall@10 1, RR 1/6, nDCG 1/log2(7).
		const queries: ScoredQuery[] = [
			{ queryId: "q1", result: { ids: ["t1", "a", "b"] }, judgements: { t1: 1 } },
			{
				queryId: "q2",
				result: { ids: ["a", "b", "c", "d", "e", "t2"] },
				judgements: { t2: 1 },
			},
		];
		const m = aggregateMetrics(queries);
		expect(m.queryCount).toBe(2);
		// recall@1: (1 + 0)/2 = 0.5
		near(m.recallAtK["1"]!, 0.5);
		// recall@5: (1 + 0)/2 = 0.5  (t2 at rank 6 is outside top-5)
		near(m.recallAtK["5"]!, 0.5);
		// recall@10: (1 + 1)/2 = 1.0
		near(m.recallAtK["10"]!, 1);
		// MRR: (1 + 1/6)/2 = 0.5833333…
		near(m.mrr, (1 + 1 / 6) / 2);
		// nDCG@10: (1 + 1/log2(7))/2
		near(m.ndcg, (1 + 1 / Math.log2(7)) / 2);
	});

	it("an empty query set yields all-zero metrics with queryCount 0 (never NaN)", () => {
		const m = aggregateMetrics([]);
		expect(m.queryCount).toBe(0);
		expect(m.mrr).toBe(0);
		expect(m.ndcg).toBe(0);
		for (const k of RECALL_K_VALUES) expect(m.recallAtK[String(k)]).toBe(0);
	});

	it("reports recall@k for exactly k = 1, 5, 10 and nDCG at NDCG_K", () => {
		expect(RECALL_K_VALUES).toEqual([1, 5, 10]);
		expect(NDCG_K).toBe(10);
		const m = aggregateMetrics([{ queryId: "q", result: { ids: ["t"] }, judgements: { t: 1 } }]);
		expect(Object.keys(m.recallAtK).sort()).toEqual(["1", "10", "5"]);
	});
});
