/**
 * PRD-058b — the contradiction-detector suite (`Contra(a,b) = sim · max(opp_lexical, P_contradiction)`).
 *
 * Acceptance criteria → tests:
 *   58b.2.1 high sim + opposite outcome + ZERO shared tokens → Contra = sim · P_contradiction clears θ,
 *           signal = 'model'.
 *   58b.2.2 a cheap lexical contradiction → opp = max flags from the lexical signal ALONE, signal = 'lexical',
 *           BEFORE any model call.
 *   58b.2.3 provider `none` (no model seam) → P_contradiction skipped, opp = opp_lexical, still recorded, no throw.
 *   58b.2.4 a keep-both memoized pair → not re-flagged on the normalized (sorted) pair.
 *   Plus: the 058e contradiction-detector seam is satisfied (createContradictionDetector); fail-soft on a
 *   throwing embed/model.
 */

import { describe, expect, it, vi } from "vitest";

import {
	contraScore,
	createContradictionDetector,
	DEFAULT_THETA_DETECT,
	detectConflicts,
	oppLexical,
	parsePContradiction,
	scorePair,
	type ConflictCandidate,
	type KeepBothMemo,
} from "../../../../src/daemon/runtime/memories/conflict-detect.js";
import { createFakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

/** An embed client that returns a FIXED vector per text (so sim is deterministic). */
function fixedEmbed(byText: Record<string, readonly number[]>): EmbedClient {
	return { async embed(text: string) { return byText[text] ?? null; } };
}

/** Two parallel (identical-direction) 4-vectors → cosine sim ≈ 1 (same claim slot). */
const VEC_SAME_A = [1, 0, 0, 0];
const VEC_SAME_B = [1, 0, 0, 0];

describe("PRD-058b contraScore — sim · max(opp_lexical, P_contradiction)", () => {
	it("multiplies sim by the larger of the two opposition signals", () => {
		expect(contraScore(0.9, 0.2, 0.8)).toBeCloseTo(0.9 * 0.8, 10); // model opp wins the max.
		expect(contraScore(0.9, 0.7, 0.2)).toBeCloseTo(0.9 * 0.7, 10); // lexical opp wins the max.
		expect(contraScore(0.9, 0.5, undefined)).toBeCloseTo(0.9 * 0.5, 10); // no model verdict → opp = opp_lexical.
	});
	it("clamps every input to [0,1] (a garbage signal cannot push Contra out of range)", () => {
		expect(contraScore(2, 5, -1)).toBe(1); // sim clamped to 1, opp clamped to 1.
		expect(contraScore(Number.NaN, 0.5, 0.5)).toBe(0); // non-finite sim → 0.
	});
});

describe("PRD-058b oppLexical — the symmetric pair heuristic", () => {
	it("flags a negation-vs-assertion polarity flip with overlap", () => {
		// Same subject (deploy/fridays overlap), one side negates ("do not / never").
		expect(oppLexical("we deploy on fridays", "we never deploy on fridays")).toBeGreaterThan(0);
	});
	it("flags an antonym-pole flip across the two", () => {
		expect(oppLexical("the cache is enabled", "the cache is disabled")).toBeGreaterThan(0);
	});
	it("returns 0 for two compatible statements (no flip)", () => {
		expect(oppLexical("we use drizzle for the orm", "we use drizzle in the api")).toBe(0);
	});
	it("returns 0 when the two share no subject (overlap below floor)", () => {
		expect(oppLexical("the cache is enabled", "bananas are yellow")).toBe(0);
	});
});

describe("PRD-058b parsePContradiction — tolerant probability extraction", () => {
	it("extracts a bare probability, clamps out-of-range, returns null on garbage/empty", () => {
		expect(parsePContradiction("0.82")).toBeCloseTo(0.82, 10);
		expect(parsePContradiction("<think>hmm</think> 0.9")).toBeCloseTo(0.9, 10);
		expect(parsePContradiction("1.5")).toBe(1); // clamped.
		expect(parsePContradiction("")).toBeNull();
		expect(parsePContradiction("no number here")).toBeNull();
	});
});

describe("PRD-058b scorePair — the deciding signal + flag", () => {
	it("58b.2.1: high sim + opposite outcome + ZERO shared tokens → Contra = sim·P_contradiction, signal=model", async () => {
		// Zero shared tokens → opp_lexical = 0. The two embed to the SAME direction → sim ≈ 1. The model
		// judge returns a strong contradiction → opp = P_contradiction, Contra clears θ, signal = 'model'.
		const model = createFakeModelClient({ memory_extraction: "0.95" });
		const a: ConflictCandidate = { id: "a", claimText: "ship on fridays", slotEmbedding: VEC_SAME_A };
		const b: ConflictCandidate = { id: "b", claimText: "freeze deploys before the weekend", slotEmbedding: VEC_SAME_B };
		const scored = await scorePair(a, b, { model });
		expect(scored.oppLexical).toBe(0); // zero shared tokens.
		expect(scored.sim).toBeGreaterThan(0.99);
		expect(scored.pContradiction).toBeCloseTo(0.95, 10);
		expect(scored.signal).toBe("model");
		expect(scored.flagged).toBe(true);
		expect(model.calls).toHaveLength(1); // the model WAS consulted (high sim, lexically inconclusive).
	});

	it("58b.2.2: a cheap lexical contradiction flags from the lexical signal ALONE, signal=lexical, NO model call", async () => {
		const model = createFakeModelClient({ memory_extraction: "0.99" });
		// Strong lexical opposition (antonym flip + high overlap) on the SAME embedding → opp_lexical conclusive.
		const a: ConflictCandidate = { id: "a", claimText: "the feature flag is enabled in prod", slotEmbedding: VEC_SAME_A };
		const b: ConflictCandidate = { id: "b", claimText: "the feature flag is disabled in prod", slotEmbedding: VEC_SAME_B };
		const scored = await scorePair(a, b, { model });
		expect(scored.oppLexical).toBeGreaterThanOrEqual(0.5); // conclusive lexical opp.
		expect(scored.signal).toBe("lexical");
		expect(scored.flagged).toBe(true);
		expect(model.calls).toHaveLength(0); // cheap-first: the model was NEVER consulted.
	});

	it("58b.2.3: provider `none` (no model seam) → P_contradiction skipped, opp = opp_lexical, no throw", async () => {
		// No `model` dep → the verdict is skipped entirely; opp = opp_lexical. A high lexical opp still flags.
		const a: ConflictCandidate = { id: "a", claimText: "the cache is enabled now", slotEmbedding: VEC_SAME_A };
		const b: ConflictCandidate = { id: "b", claimText: "the cache is disabled now", slotEmbedding: VEC_SAME_B };
		const scored = await scorePair(a, b, {}); // provider none.
		expect(scored.pContradiction).toBeNull(); // skipped.
		expect(scored.signal).toBe("lexical");
		expect(scored.flagged).toBe(true);
	});

	it("fail-soft: a throwing model judge degrades to the lexical signal, never throws", async () => {
		const model = { complete: vi.fn().mockRejectedValue(new Error("router down")) } as any;
		// Lexically inconclusive but high sim → the judge is consulted, throws, and we fall back to opp_lexical = 0.
		const a: ConflictCandidate = { id: "a", claimText: "ship on fridays", slotEmbedding: VEC_SAME_A };
		const b: ConflictCandidate = { id: "b", claimText: "freeze before the weekend", slotEmbedding: VEC_SAME_B };
		const scored = await scorePair(a, b, { model });
		expect(scored.pContradiction).toBeNull(); // the throw → no verdict.
		expect(scored.flagged).toBe(false); // opp_lexical 0 → Contra 0 → not flagged (no throw).
	});
});

describe("PRD-058b detectConflicts — over the candidate set, with memoization", () => {
	// Overlap 4/6 ≈ 0.667 (shared the/cache/is/now), antonym flip enabled/disabled → Contra ≈ 0.667 > θ (0.6).
	const a: ConflictCandidate = { id: "a", claimText: "the cache is enabled now", slotEmbedding: VEC_SAME_A };
	const b: ConflictCandidate = { id: "b", claimText: "the cache is disabled now", slotEmbedding: VEC_SAME_B };

	it("flags a contradictory pair over the candidate set, normalized (sorted) once", async () => {
		const flagged = await detectConflicts([a, b], {});
		expect(flagged).toHaveLength(1);
		expect(flagged[0]!.memoryAId).toBe("a"); // normalized (sorted) lower id.
		expect(flagged[0]!.memoryBId).toBe("b");
		expect(flagged[0]!.contraScore).toBeGreaterThan(DEFAULT_THETA_DETECT);
		expect(flagged[0]!.signal).toBe("lexical");
	});

	it("58b.2.4: a keep-both memoized pair is NOT re-flagged (normalized pair)", async () => {
		// Memoize the normalized pair (b,a) → must suppress the (a,b) flag regardless of detection order.
		const memo: KeepBothMemo = { has: (x, y) => x === "a" && y === "b" };
		const flagged = await detectConflicts([b, a], { memo }); // reversed input order.
		expect(flagged).toHaveLength(0); // memoized → not re-flagged.
	});

	it("does not flag two compatible facts (Contra below θ)", async () => {
		const c: ConflictCandidate = { id: "c", claimText: "we use drizzle for the orm", slotEmbedding: VEC_SAME_A };
		const d: ConflictCandidate = { id: "d", claimText: "we use drizzle in the api", slotEmbedding: VEC_SAME_B };
		const flagged = await detectConflicts([c, d], {});
		expect(flagged).toHaveLength(0);
	});
});

describe("PRD-058b createContradictionDetector — the 058e seam", () => {
	it("returns P_contradiction from the model for a contradicting outcome", async () => {
		const model = createFakeModelClient({ memory_extraction: "0.9" });
		const detector = createContradictionDetector({ model });
		const p = await detector.detect("we use drizzle", "we migrated off drizzle to prisma");
		expect(p).toBeCloseTo(0.9, 10);
	});
	it("provider `none` → 0 (no contradiction), the 058e stub parity", async () => {
		const detector = createContradictionDetector({});
		expect(await detector.detect("a", "b")).toBe(0);
	});
	it("fail-soft: a throwing model → 0, never throws into the grader", async () => {
		const model = { complete: vi.fn().mockRejectedValue(new Error("down")) } as any;
		const detector = createContradictionDetector({ model });
		expect(await detector.detect("a", "b")).toBe(0);
	});
});
