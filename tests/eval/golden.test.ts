/**
 * PRD-027 D-5/D-6 / AC-5/AC-6 — the golden-set + harness + gate unit suite.
 *
 * Covers: the COMMITTED golden set validates + carries lexical-miss pairs; the harness
 * runner scores a deterministic fake recall correctly; the per-run key isolation; the
 * baseline gate (placeholder advisory vs enforced fail); and the semantic-vs-lexical
 * comparison (AC-6 behavioral bar). Pure — no creds, runs in `npm run ci`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	compareSemanticVsLexical,
	EPSILON,
	gateAgainstBaseline,
	loadBaseline,
	loadGoldenSet,
	parseGoldenSet,
	runEval,
	seedTextFor,
	uniqueKeyFor,
	type ExpectedIds,
	type GoldenSet,
	type SeededRecall,
} from "../../src/eval/golden.js";
import type { AggregateMetrics } from "../../src/eval/metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo-root `eval/` dir (this test lives at tests/eval/). */
const EVAL_DIR = join(HERE, "..", "..", "eval");

function readEval(name: string): string {
	return readFileSync(join(EVAL_DIR, name), "utf8");
}

describe("the committed golden set (D-5)", () => {
	const golden = loadGoldenSet(readEval("recall-golden.json"));

	it("validates and holds a substantive set (~30–50 pairs)", () => {
		expect(golden.pairs.length).toBeGreaterThanOrEqual(30);
		expect(golden.pairs.length).toBeLessThanOrEqual(60);
	});

	it("includes a meaningful share of lexical-MISS pairs (the semantic-lift exercisers)", () => {
		const misses = golden.pairs.filter((p) => p.lexicalMiss);
		// At least a quarter of the set must be lexical-miss so the semantic arm is exercised.
		expect(misses.length).toBeGreaterThanOrEqual(Math.ceil(golden.pairs.length / 4));
	});

	it("every pair has a non-empty key, memoryText, query and a positive relevance", () => {
		for (const p of golden.pairs) {
			expect(p.key.length).toBeGreaterThan(0);
			expect(p.memoryText.length).toBeGreaterThan(0);
			expect(p.query.length).toBeGreaterThan(0);
			expect(p.relevance).toBeGreaterThan(0);
		}
	});

	it("a lexical-miss pair genuinely shares no significant surface token with its target", () => {
		// Spot-check the contract that makes a lexical-miss pair semantic-only: tokenize
		// both sides, lowercase, drop stopwords + short tokens, assert no overlap.
		const STOP = new Set([
			"the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "on", "for", "we", "it",
			"how", "what", "do", "does", "if", "so", "that", "this", "with", "be", "at", "its", "not",
			"never", "must", "into", "before", "after", "out", "one", "two", "right", "still",
		]);
		const tokens = (s: string): Set<string> =>
			new Set(
				s
					.toLowerCase()
					.replace(/[^a-z0-9 ]/g, " ")
					.split(/\s+/)
					.filter((t) => t.length > 2 && !STOP.has(t)),
			);
		for (const p of golden.pairs.filter((x) => x.lexicalMiss)) {
			const q = tokens(p.query);
			const m = tokens(p.memoryText);
			const overlap = [...q].filter((t) => m.has(t));
			expect(overlap, `pair "${p.key}" tagged lexicalMiss but shares tokens: ${overlap.join(",")}`).toEqual([]);
		}
	});

	it("parseGoldenSet rejects duplicate keys", () => {
		expect(() =>
			parseGoldenSet({
				pairs: [
					{ key: "dup", memoryText: "x", query: "y", lexicalMiss: false },
					{ key: "dup", memoryText: "z", query: "w", lexicalMiss: false },
				],
			}),
		).toThrow(/duplicate pair key/);
	});

	it("parseGoldenSet defaults relevance to 1 when absent (binary)", () => {
		const set = parseGoldenSet({ pairs: [{ key: "k", memoryText: "x", query: "y", lexicalMiss: false }] });
		expect(set.pairs[0]!.relevance).toBe(1);
	});

	it("loadGoldenSet throws on malformed JSON and on an empty pair set", () => {
		expect(() => loadGoldenSet("{not json")).toThrow(/not valid JSON/);
		expect(() => loadGoldenSet(JSON.stringify({ pairs: [] }))).toThrow();
	});
});

describe("per-run isolation keys (D-5)", () => {
	it("uniqueKeyFor + seedTextFor stamp the run id so a live seed reads only its own rows", () => {
		expect(uniqueKeyFor("g-foo", "run42")).toBe("g-foo-run42");
		const pair = { key: "g-foo", memoryText: "the build times out", query: "ci fails", lexicalMiss: true, relevance: 1 };
		expect(seedTextFor(pair, "run42")).toBe("the build times out [run42]");
		// The query carries no run id — a lexical-miss pair's seed token never leaks into the query.
		expect(pair.query).not.toContain("run42");
	});
});

describe("runEval (the harness, AC-5)", () => {
	const golden: GoldenSet = {
		pairs: [
			{ key: "hit1", memoryText: "m1", query: "q1", lexicalMiss: false, relevance: 1 },
			{ key: "hit6", memoryText: "m2", query: "q2", lexicalMiss: true, relevance: 1 },
			{ key: "missing", memoryText: "m3", query: "q3", lexicalMiss: false, relevance: 1 },
		],
	};
	const expected: ExpectedIds = new Map([
		["hit1", "id1"],
		["hit6", "id2"],
		// "missing" intentionally has no seeded id → reported as a miss, expectedId null.
	]);

	// Fake recall: q1 → id1 at rank 1; q2 → id2 at rank 6; q3 → no id2/id1.
	const recall: SeededRecall = async (query: string) => {
		if (query === "q1") return ["id1", "x", "y"];
		if (query === "q2") return ["a", "b", "c", "d", "e", "id2"];
		return ["n1", "n2"];
	};

	it("scores per-query hit/miss + rank and aggregates the metrics (hand-computed)", async () => {
		const report = await runEval(golden, recall, expected);
		expect(report.queries).toHaveLength(3);

		const byKey = Object.fromEntries(report.queries.map((q) => [q.key, q]));
		expect(byKey.hit1!.hit).toBe(true);
		expect(byKey.hit1!.rank).toBe(1);
		expect(byKey.hit1!.expectedId).toBe("id1");

		expect(byKey.hit6!.hit).toBe(true);
		expect(byKey.hit6!.rank).toBe(6);
		expect(byKey.hit6!.lexicalMiss).toBe(true);

		// The unseeded pair → expectedId null, miss.
		expect(byKey.missing!.expectedId).toBeNull();
		expect(byKey.missing!.hit).toBe(false);
		expect(byKey.missing!.rank).toBeNull();

		// Aggregate: recall@1 = (1 + 0 + 0)/3; recall@5 = (1 + 0 + 0)/3; recall@10 = (1 + 1 + 0)/3.
		expect(report.metrics.recallAtK["1"]).toBeCloseTo(1 / 3, 10);
		expect(report.metrics.recallAtK["5"]).toBeCloseTo(1 / 3, 10);
		expect(report.metrics.recallAtK["10"]).toBeCloseTo(2 / 3, 10);
		// MRR = (1/1 + 1/6 + 0)/3
		expect(report.metrics.mrr).toBeCloseTo((1 + 1 / 6) / 3, 10);
	});
});

describe("the baseline gate (AC-6)", () => {
	const committed = loadBaseline(readEval("recall-baseline.json"));

	it("the committed baseline is the Wave-3 MEASURED, ENFORCED floor (placeholder flipped off)", () => {
		// Wave 3 ran the live eval (stabilized), measured recall@5≈0.583 / MRR≈0.585 across 4
		// runs, and committed the baseline AT-OR-BELOW that with ε headroom, flipping placeholder
		// off so the gate ENFORCES. The committed numbers are valid probabilities in (0, 1].
		expect(committed.placeholder).toBe(false);
		expect(committed.recallAt5).toBeGreaterThan(0);
		expect(committed.recallAt5).toBeLessThanOrEqual(1);
		expect(committed.mrr).toBeGreaterThan(0);
		expect(committed.mrr).toBeLessThanOrEqual(1);
	});

	function metricsWith(recallAt5: number, mrr: number): AggregateMetrics {
		// Build an AggregateMetrics with the two gated fields set (others irrelevant to the gate).
		return { queryCount: 1, recallAtK: { "1": 0, "5": recallAt5, "10": 0 }, mrr, ndcg: 0 };
	}

	it("the committed ENFORCED baseline is non-advisory and FAILS a run far below its floor", () => {
		// With placeholder off the gate is enforced: a run far below the committed floor FAILS
		// (the regression gate has teeth), and reports why.
		const m = metricsWith(0.1, 0.1);
		const v = gateAgainstBaseline(m, committed);
		expect(v.advisory).toBe(false);
		expect(v.passed).toBe(false);
		expect(v.reasons.length).toBeGreaterThan(0);
	});

	it("a PLACEHOLDER baseline makes the gate advisory — never fails, but reports the comparison", () => {
		// The advisory branch (placeholder true) still holds for any future re-seed of the baseline.
		const placeholder = { recallAt5: 0.9, mrr: 0.9, placeholder: true };
		const m = metricsWith(0.1, 0.1); // far below the placeholder floor
		const v = gateAgainstBaseline(m, placeholder);
		expect(v.advisory).toBe(true);
		expect(v.passed).toBe(true); // advisory → never fails the run
		expect(v.reasons.length).toBeGreaterThan(0); // but the regression is still reported
	});

	it("an ENFORCED baseline FAILS when recall@5 or MRR drops below baseline − ε", () => {
		const enforced = { recallAt5: 0.8, mrr: 0.6, placeholder: false };
		// recall@5 floor = 0.75, mrr floor = 0.55.
		const below = metricsWith(0.7, 0.6); // recall@5 below floor
		const v1 = gateAgainstBaseline(below, enforced);
		expect(v1.advisory).toBe(false);
		expect(v1.passed).toBe(false);
		expect(v1.reasons.some((r) => r.includes("recall@5"))).toBe(true);

		const belowMrr = metricsWith(0.8, 0.5); // mrr below floor
		expect(gateAgainstBaseline(belowMrr, enforced).passed).toBe(false);
	});

	it("an ENFORCED baseline PASSES within ε of the baseline (noise tolerance)", () => {
		const enforced = { recallAt5: 0.8, mrr: 0.6, placeholder: false };
		// Exactly at the floor (baseline − ε) passes.
		const atFloor = metricsWith(0.8 - EPSILON, 0.6 - EPSILON);
		expect(gateAgainstBaseline(atFloor, enforced).passed).toBe(true);
		// Above the baseline obviously passes.
		expect(gateAgainstBaseline(metricsWith(0.9, 0.7), enforced).passed).toBe(true);
	});

	it("EPSILON is a small, named, positive tolerance", () => {
		expect(EPSILON).toBeGreaterThan(0);
		expect(EPSILON).toBeLessThanOrEqual(0.1);
	});
});

describe("semantic vs lexical comparison (AC-6 behavioral bar)", () => {
	function m(recallAt5: number, mrr: number): AggregateMetrics {
		return { queryCount: 1, recallAtK: { "1": 0, "5": recallAt5, "10": 0 }, mrr, ndcg: 0 };
	}

	it("semantic BEATS lexical when it improves a metric with no regression", () => {
		const v = compareSemanticVsLexical(m(0.9, 0.7), m(0.6, 0.5));
		expect(v.beats).toBe(true);
		expect(v.recallAt5Delta).toBeCloseTo(0.3, 10);
		expect(v.mrrDelta).toBeCloseTo(0.2, 10);
	});

	it("semantic does NOT beat lexical when it regresses either metric", () => {
		// recall up but MRR down → regression → not a clean beat.
		expect(compareSemanticVsLexical(m(0.9, 0.4), m(0.6, 0.5)).beats).toBe(false);
	});

	it("equal metrics do not count as a beat (no improvement)", () => {
		expect(compareSemanticVsLexical(m(0.6, 0.5), m(0.6, 0.5)).beats).toBe(false);
	});
});
