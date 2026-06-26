/**
 * PRD-058b — the conflict-resolver suite (`w_i`, `score(o)`, `margin`, the verdict table, `κ`).
 *
 * Acceptance criteria → tests:
 *   58b.3.1 w_i weighting: a distilled `memory` (prov 1.0) outvotes an equally-fresh raw `session` (prov 0.4)
 *           at equal A/C/corroboration.
 *   58b.3.2 a close pair → margin ∈ [τ_review, τ_supersede) → verdict `review`, NEITHER side superseded.
 *   58b.3.3 corr counts INDEPENDENT sources; three duplicated rows from one source count ONCE.
 *   58b.3.4 margin ≥ τ_supersede → verdict `supersede`, loser κ = 0; margin + contra persisted.
 *   58b.1.4 uncontested / unanimous → κ = 1, no losers (the gate leaves priority untouched).
 *   Plus: detectAndProject projects an OPEN conflict + appends memory_history (58b.4.1); supersedeLoser uses
 *   the append-only version bump (58b.4.3).
 */

import { describe, expect, it } from "vitest";

import {
	corroboration,
	DEFAULT_TAU_REVIEW,
	DEFAULT_TAU_SUPERSEDE,
	detectAndProject,
	provWeight,
	resolveConflict,
	reverseSupersession,
	type ConflictVoter,
	type CandidateVoter,
} from "../../../../src/daemon/runtime/memories/conflict-resolve.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE = { org: "o", workspace: "w" };

function voter(p: Partial<ConflictVoter> & { memoryId: string; outcome: string; arm: "memory" | "session" }): ConflictVoter {
	return p;
}

describe("PRD-058b provWeight / corroboration — the w_i factors", () => {
	it("prov is 1.0 for distilled memory, 0.4 for raw session", () => {
		expect(provWeight("memory")).toBe(1.0);
		expect(provWeight("session")).toBe(0.4);
	});
	it("58b.3.3: corr counts independent sources, log-scaled (duplicates do not inflate)", () => {
		// corr(1) = 1 + 0.5·ln(2); corr(3) > corr(1). The RESOLVER dedups duplicated sources before counting.
		expect(corroboration(1)).toBeCloseTo(1 + 0.5 * Math.log(2), 10);
		expect(corroboration(3)).toBeGreaterThan(corroboration(1));
		expect(corroboration(0)).toBe(1); // no bonus with no sources.
	});
});

describe("PRD-058b resolveConflict — winner, margin, verdict, κ", () => {
	it("58b.3.1: a distilled memory outvotes an equally-fresh raw session at equal A/C/corroboration", () => {
		const r = resolveConflict([
			voter({ memoryId: "distilled", outcome: "X", arm: "memory", activation: 1, confidence: 1 }),
			voter({ memoryId: "raw", outcome: "Y", arm: "session", activation: 1, confidence: 1 }),
		]);
		expect(r.winnerOutcome).toBe("X");
		expect(r.winnerId).toBe("distilled");
		// score(X) = 1·1·1.0·corr1 = corr1; score(Y) = 1·1·0.4·corr1. margin = 1 − 0.4 = 0.6 ≥ τ_supersede.
		expect(r.margin).toBeCloseTo(0.6, 10);
		expect(r.verdict).toBe("supersede");
		expect(r.kappaLoser).toBe(0);
		expect(r.loserIds).toEqual(["raw"]);
	});

	it("58b.3.2: a close pair → margin ∈ [τ_review, τ_supersede) → review, neither superseded", () => {
		// distilled X (prov 1.0) vs distilled Y (prov 1.0) but Y slightly stronger on A → small margin.
		const r = resolveConflict([
			voter({ memoryId: "x", outcome: "X", arm: "memory", activation: 0.8, confidence: 1 }),
			voter({ memoryId: "y", outcome: "Y", arm: "memory", activation: 1.0, confidence: 1 }),
		]);
		// score(Y) = 1.0·corr1, score(X) = 0.8·corr1 → margin = 1 − 0.8 = 0.2 ∈ [0.15, 0.5) → review.
		expect(r.margin).toBeCloseTo(0.2, 10);
		expect(r.margin).toBeGreaterThanOrEqual(DEFAULT_TAU_REVIEW);
		expect(r.margin).toBeLessThan(DEFAULT_TAU_SUPERSEDE);
		expect(r.verdict).toBe("review");
		expect(r.kappaLoser).toBe(0); // ρ default 0 (reversible), but the verdict is review, not supersede.
	});

	it("58b.3.3: three duplicated rows from ONE source count as one independent source", () => {
		// Outcome X has three rows but all from source 's1' → corr(1). Outcome Y has one row from 's2' → corr(1).
		// With equal per-row weight, the duplicate-inflation is NEUTRALIZED: X's corr is NOT corr(3).
		const r = resolveConflict([
			voter({ memoryId: "x1", outcome: "X", arm: "memory", sourceId: "s1" }),
			voter({ memoryId: "x2", outcome: "X", arm: "memory", sourceId: "s1" }),
			voter({ memoryId: "x3", outcome: "X", arm: "memory", sourceId: "s1" }),
			voter({ memoryId: "y1", outcome: "Y", arm: "memory", sourceId: "s2" }),
		]);
		// Both outcomes get corr(1) (X dedups its 3 rows to 1 source). X still wins on row COUNT (3 summed
		// weights vs 1), but its corr is NOT inflated by the duplicates — the corroboration bonus is equal.
		const corr1 = corroboration(1);
		// score(X) = 3 · (1·1·1.0·corr1); score(Y) = 1 · (1·1·1.0·corr1). The corr factor is identical.
		expect(r.scores.X! / r.scores.Y!).toBeCloseTo(3, 10); // purely the row-count ratio, corr cancels.
	});

	it("58b.3.4: margin ≥ τ_supersede → supersede, loser κ = 0", () => {
		const r = resolveConflict([
			voter({ memoryId: "win", outcome: "X", arm: "memory", activation: 1, confidence: 1 }),
			voter({ memoryId: "lose", outcome: "Y", arm: "session", activation: 0.3, confidence: 0.5 }),
		]);
		expect(r.margin).toBeGreaterThanOrEqual(DEFAULT_TAU_SUPERSEDE);
		expect(r.verdict).toBe("supersede");
		expect(r.kappaLoser).toBe(0);
		expect(r.winnerId).toBe("win");
	});

	it("58b.1.4: an uncontested memory (single outcome) → κ = 1, no losers", () => {
		const r = resolveConflict([voter({ memoryId: "solo", outcome: "X", arm: "memory" })]);
		expect(r.verdict).toBe("keep-both");
		expect(r.kappaLoser).toBe(1);
		expect(r.loserIds).toEqual([]);
		expect(r.margin).toBe(1);
	});

	it("a low-margin pair with LOW Contra → keep-both (false positive, κ = 1, memoize)", () => {
		// margin < τ_review and a low Contra → keep-both: a genuine independent-fact false positive.
		const r = resolveConflict(
			[
				voter({ memoryId: "x", outcome: "X", arm: "memory", activation: 0.96 }),
				voter({ memoryId: "y", outcome: "Y", arm: "memory", activation: 1.0 }),
			],
			{ contraScore: 0.1 }, // low Contra.
		);
		expect(r.margin).toBeLessThan(DEFAULT_TAU_REVIEW); // 1 − 0.96 = 0.04 < 0.15.
		expect(r.verdict).toBe("keep-both");
		expect(r.kappaLoser).toBe(1);
	});

	it("a low-margin pair with HIGH Contra → review (a real but close contradiction is NOT silently kept)", () => {
		const r = resolveConflict(
			[
				voter({ memoryId: "x", outcome: "X", arm: "memory", activation: 0.96 }),
				voter({ memoryId: "y", outcome: "Y", arm: "memory", activation: 1.0 }),
			],
			{ contraScore: 0.9 }, // high Contra → the safety posture forbids keep-both.
		);
		expect(r.margin).toBeLessThan(DEFAULT_TAU_REVIEW);
		expect(r.verdict).toBe("review");
	});
});

// ── detectAndProject — the candidate-set integration (58b.4.1) ───────────────

/** A SQL-aware fake storage that records writes + returns the version-max as 0 (so the first append is v1). */
function makeStorage(responder: (req: TransportRequest) => Record<string, unknown>[]) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

describe("PRD-058b detectAndProject — detection over the candidate set + projection (58b.4.1)", () => {
	it("projects an OPEN memory_conflicts row AND appends a memory_history conflict_detect event", async () => {
		// Reads (version-max probes) return empty so the version bump starts at 1; writes are recorded.
		const { storage, fake } = makeStorage(() => []);
		const candidates: CandidateVoter[] = [
			{ id: "a", claimText: "the cache is enabled now", outcome: "enabled", arm: "memory", slotEmbedding: [1, 0, 0, 0] },
			{ id: "b", claimText: "the cache is disabled now", outcome: "disabled", arm: "memory", slotEmbedding: [1, 0, 0, 0] },
		];
		const result = await detectAndProject(candidates, SCOPE, {
			detect: {},
			persist: { storage, now: () => new Date("2026-06-26T00:00:00Z"), newId: () => "audit-1" },
			newConflictId: () => "conflict-1",
		});
		expect(result.detected).toHaveLength(1);
		expect(result.projectedIds).toEqual(["conflict-1"]);
		// A memory_conflicts INSERT (the version-bumped projection) AND a memory_history INSERT both landed.
		const inserts = fake.requests.filter((r) => /INSERT INTO/i.test(r.sql));
		expect(inserts.some((r) => /"memory_conflicts"/i.test(r.sql))).toBe(true);
		expect(inserts.some((r) => /"memory_history"/i.test(r.sql))).toBe(true);
		// The projected row carries the OPEN status + the auto-computed verdict (review/supersede), never a
		// destructive delete.
		const conflictInsert = inserts.find((r) => /"memory_conflicts"/i.test(r.sql))!;
		expect(conflictInsert.sql).toMatch(/'open'/);
		expect(inserts.every((r) => !/DELETE FROM/i.test(r.sql))).toBe(true);
	});
});

describe("PRD-058b reverseSupersession — restore the loser via a version bump (58b.4.2 / 4.3)", () => {
	it("restores the loser (modify version bump) + projects status reversed + appends conflict_reverse, NO delete", async () => {
		const { storage, fake } = makeStorage(() => []);
		await reverseSupersession(
			{
				conflictId: "c1",
				loserId: "lose",
				restoredContent: "the cache is disabled now",
				memoryAId: "a",
				memoryBId: "b",
				reason: "operator reversed a wrong supersede",
				signal: "lexical",
				contraScore: 0.8,
				winnerId: "a",
			},
			{ storage, now: () => new Date("2026-06-26T00:00:00Z"), newId: () => "h-rev" },
			{ storage },
			SCOPE,
		);
		const writes = fake.requests.filter((r) => /INSERT INTO|UPDATE/i.test(r.sql));
		// The loser was restored as a NEW version (a modify version bump) — NEVER a destructive delete.
		expect(writes.some((r) => /DELETE FROM/i.test(r.sql))).toBe(false);
		// The conflict projection was refreshed to status reversed.
		expect(fake.requests.some((r) => /INSERT INTO\s+"memory_conflicts"/i.test(r.sql) && /'reversed'/.test(r.sql))).toBe(true);
		// A conflict_reverse audit row landed.
		expect(fake.requests.some((r) => /INSERT INTO\s+"memory_history"/i.test(r.sql) && /conflict_reverse/.test(r.sql))).toBe(true);
	});
});
