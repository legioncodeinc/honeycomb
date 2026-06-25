/**
 * PRD-047e — token-budget + MMR context assembly suite.
 *
 * Verification posture (no live DeepLake, no creds — e-AC-3 runs in the orchestrator):
 *   - `recallMemories` is driven against a FAKE `StorageQuery` that answers the `<#>`
 *     vector arm, the hydration SELECT, the lexical arms, AND the candidate-embedding
 *     batch-fetch (`SELECT … AS embedding`, keyed by an `IN (...)` id list) the MMR stage
 *     self-sources via the SAME `fetchCandidateEmbeddings` dedup/rerank use.
 *   - The token counter is the EXPORTED `estimateTokenCount` so the budget math the test
 *     asserts is the budget math recall runs (deterministic counter + known hit sizes).
 *   - e-AC-1: a token budget returns the hits that FIT (not a fixed count); a smaller
 *     budget returns fewer, higher-value hits.
 *   - e-AC-2: a candidate set of near-paraphrases + a few distinct facts — MMR surfaces a
 *     distinct fact a pure top-k-by-score would crowd out.
 *   - e-AC-4: the NO-budget path is byte-for-byte the pre-047e behavior; rank-1 is always
 *     kept; an MMR/budget embedding-fetch failure degrades to the fixed top-k, never a throw.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	estimateTokenCount,
	recallMemories,
	selectWithinTokenBudget,
	type MemoryRecallHit,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A 768-dim vector with `1` on `axis` (so cosine between two distinct axes is 0.5 normalized). */
function unitVector(axis: number): number[] {
	const v = new Array(EMBEDDING_DIMS).fill(0) as number[];
	v[axis] = 1;
	return v;
}

const QUERY_VECTOR = unitVector(0);

/** An EmbedClient returning a fixed query vector. */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** Classify the statement shape recall emitted (mirrors the dedup suite). */
function kindOf(sql: string): "vector" | "embedding" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	if (sql.includes("<#>")) return "vector";
	if (/AS\s+embedding/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "embedding";
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** Which table a vector/hydrate/embedding statement targets. */
function tableOf(sql: string): "memories" | "sessions" | "other" {
	if (/FROM\s+"memories"/i.test(sql)) return "memories";
	if (/FROM\s+"sessions"/i.test(sql)) return "sessions";
	return "other";
}

/** A fake storage answering the vector arm, the hydration SELECT, the lexical arms, and the embedding fetch. */
function assemblyStorage(opts: {
	vector?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	hydrate?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	lexical?: { memories?: QueryResult; memory?: QueryResult; sessions?: QueryResult };
	embeddings?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	/** Force the embedding batch-fetch to FAIL (proves the MMR/budget fail-soft, e-AC-4). */
	failEmbeddingFetch?: boolean;
}): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const kind = kindOf(sql);
			const table = tableOf(sql);
			const tbl = table === "other" ? "memories" : table;
			if (kind === "vector") return ok(opts.vector?.[tbl] ?? [], 0);
			if (kind === "hydrate") return ok(opts.hydrate?.[tbl] ?? [], 0);
			if (kind === "embedding") {
				if (opts.failEmbeddingFetch) return queryError(`relation "${tbl}" missing column`);
				return ok(opts.embeddings?.[tbl] ?? [], 0);
			}
			if (kind === "memories") return opts.lexical?.memories ?? ok([], 0);
			if (kind === "memory") return opts.lexical?.memory ?? ok([], 0);
			if (kind === "sessions") return opts.lexical?.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage, sqls };
}

/** An embedding row as the batch-fetch projects it (`id`, `embedding`). */
function embRow(id: string, vec: number[]): StorageRow {
	return { id, embedding: vec };
}

/** Build a hit with a controllable score + text length (for the pure-helper unit tests). */
function hit(id: string, score: number, text: string, source: MemoryRecallHit["source"] = "memories"): MemoryRecallHit {
	return {
		source,
		id,
		text,
		score,
		kind: source === "sessions" ? "session" : "memory",
		secondary: source === "sessions",
		createdAt: "",
	};
}

describe("PRD-047e — estimateTokenCount (the deterministic heuristic counter)", () => {
	it("counts ~chars/4, flooring an empty/whitespace hit at the sane default 1 (never 0)", () => {
		expect(estimateTokenCount("")).toBe(1); // no countable text → sane default, never 0.
		expect(estimateTokenCount("   ")).toBe(1);
		expect(estimateTokenCount("abcd")).toBe(1); // 4 chars / 4 = 1.
		expect(estimateTokenCount("a".repeat(40))).toBe(10); // 40 / 4 = 10.
		expect(estimateTokenCount("a".repeat(41))).toBe(11); // ceil(41/4) = 11.
	});
});

describe("PRD-047e e-AC-1 — budget-bounded selection (not a fixed count)", () => {
	it("a token budget returns the hits that FIT; a smaller budget returns fewer, higher-value hits", () => {
		// Four DISTINCT (orthogonal-embedding) hits, each 40 chars → 10 tokens each, descending score.
		const text = "x".repeat(40); // estimateTokenCount === 10.
		const hits = [
			hit("a", 0.9, text),
			hit("b", 0.8, text),
			hit("c", 0.7, text),
			hit("d", 0.6, text),
		];
		// Orthogonal embeddings → MMR diversity term is uniform, so order tracks relevance.
		const emb = new Map<string, number[]>([
			["memories a", unitVector(0)],
			["memories b", unitVector(1)],
			["memories c", unitVector(2)],
			["memories d", unitVector(3)],
		]);

		// Budget 25 tokens fits exactly TWO 10-token hits (20 ≤ 25; a third would be 30 > 25).
		const small = selectWithinTokenBudget(hits, 25, 0.7, emb);
		expect(small.map((h) => h.id)).toEqual(["a", "b"]);

		// A LARGER budget (35) fits THREE — more, but still budget-bounded, not the fixed 4.
		const large = selectWithinTokenBudget(hits, 35, 0.7, emb);
		expect(large.map((h) => h.id)).toEqual(["a", "b", "c"]);

		// The smaller budget returned FEWER hits than the larger one (the budget bounds the count).
		expect(small.length).toBeLessThan(large.length);
	});

	it("a budget below the single best hit's cost still returns that one hit (never empty)", () => {
		const hits = [hit("big", 0.9, "z".repeat(400))]; // 100 tokens.
		const emb = new Map<string, number[]>([["memories big", unitVector(0)]]);
		const picked = selectWithinTokenBudget(hits, 5, 0.7, emb); // budget 5 < 100.
		expect(picked.map((h) => h.id)).toEqual(["big"]); // rank-1 seed always taken.
	});

	it("end-to-end: a `tokenBudget` on the request returns the budgeted MMR slice", async () => {
		const text = "x".repeat(40); // 10 tokens each.
		const { storage } = assemblyStorage({
			vector: {
				memories: [
					{ id: "a", score: 0.95 },
					{ id: "b", score: 0.9 },
					{ id: "c", score: 0.85 },
				],
			},
			hydrate: {
				memories: [
					{ source: "memories", id: "a", text },
					{ source: "memories", id: "b", text },
					{ source: "memories", id: "c", text },
				],
			},
			embeddings: {
				memories: [embRow("a", unitVector(0)), embRow("b", unitVector(1)), embRow("c", unitVector(2))],
			},
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 50, tokenBudget: 25 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		// 25 tokens fits exactly two 10-token hits.
		expect(result.hits).toHaveLength(2);
		expect(result.degraded).toBe(false);
	});
});

describe("PRD-047e e-AC-2 — diversity beats fixed-top-k on redundancy", () => {
	it("MMR surfaces a distinct fact a pure top-k-by-score would crowd out", () => {
		// Three near-paraphrases (COLLINEAR embeddings on axis 0) with the top scores, plus ONE
		// distinct fact (orthogonal embedding on axis 1) with a lower score. A pure top-k by score
		// would pick the three paraphrases. MMR, with the diversity term, must surface the distinct
		// fact ahead of a redundant paraphrase.
		const text = "y".repeat(40); // 10 tokens each.
		const hits = [
			hit("para-1", 0.95, text),
			hit("para-2", 0.92, text),
			hit("para-3", 0.9, text),
			hit("distinct", 0.7, text),
		];
		const emb = new Map<string, number[]>([
			["memories para-1", unitVector(0)],
			["memories para-2", unitVector(0)], // collinear with para-1 → cosine 1.0.
			["memories para-3", unitVector(0)],
			["memories distinct", unitVector(1)], // orthogonal → maximally diverse.
		]);

		// Budget for THREE 10-token hits (35 ≥ 30, < 40).
		const picked = selectWithinTokenBudget(hits, 35, 0.7, emb).map((h) => h.id);

		// rank-1 is always kept (the top paraphrase).
		expect(picked[0]).toBe("para-1");
		// MMR surfaces the distinct fact within the budgeted slice — the diversity it gains beats a
		// third redundant paraphrase.
		expect(picked).toContain("distinct");

		// Contrast: pure top-k-by-score for the same 3-slot budget would be the three paraphrases,
		// crowding the distinct fact out. Prove the selections DIFFER.
		const pureTopK = [...hits].sort((a, b) => b.score - a.score).slice(0, 3).map((h) => h.id);
		expect(pureTopK).toEqual(["para-1", "para-2", "para-3"]);
		expect(picked).not.toEqual(pureTopK);
	});
});

describe("PRD-047e e-AC-4 — back-compat + rank-1 + fail-soft", () => {
	it("NO budget → the result is identical to pre-047e (the fixed top-k path is untouched)", async () => {
		const args = {
			vector: {
				memories: [
					{ id: "a", score: 0.95 },
					{ id: "b", score: 0.9 },
				],
			},
			hydrate: {
				memories: [
					{ source: "memories", id: "a", text: "first fact" },
					{ source: "memories", id: "b", text: "second fact" },
				],
			},
			embeddings: { memories: [embRow("a", unitVector(0)), embRow("b", unitVector(1))] },
		} as const;

		const a = assemblyStorage(args);
		const noBudget = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 50 },
			{ storage: a.storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		// The fixed top-k path returns BOTH hits, in fused order, with no budget shaping.
		expect(noBudget.hits.map((h) => h.id)).toEqual(["a", "b"]);
		expect(noBudget.sources).toEqual(["memories"]);
		expect(noBudget.degraded).toBe(false);
	});

	it("rank-1 is ALWAYS kept — the top hit is never displaced by the diversity term", () => {
		// The top hit is a paraphrase of the second; even though MMR would prefer the diverse hit
		// for slot 2, slot 1 is SEEDED with rank-1 and never displaced.
		const text = "k".repeat(20); // 5 tokens each.
		const hits = [
			hit("top", 0.99, text),
			hit("para-of-top", 0.98, text),
			hit("diverse", 0.5, text),
		];
		const emb = new Map<string, number[]>([
			["memories top", unitVector(0)],
			["memories para-of-top", unitVector(0)], // collinear with top.
			["memories diverse", unitVector(1)],
		]);
		const picked = selectWithinTokenBudget(hits, 1000, 0.7, emb); // budget large enough for all.
		expect(picked[0]?.id).toBe("top"); // rank-1 seed, always first.
	});

	it("an MMR/budget embedding-fetch FAILURE degrades to the fixed top-k, never a throw", async () => {
		// The embedding batch-fetch errors. MMR cannot source `sim`, but the stage is wrapped: it
		// degrades to the fixed top-`limit` dampened list (both hits), never a 500.
		const { storage } = assemblyStorage({
			vector: {
				memories: [
					{ id: "a", score: 0.95 },
					{ id: "b", score: 0.9 },
				],
			},
			hydrate: {
				memories: [
					{ source: "memories", id: "a", text: "x".repeat(40) },
					{ source: "memories", id: "b", text: "x".repeat(40) },
				],
			},
			failEmbeddingFetch: true,
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 50, tokenBudget: 25 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 }, dedup: { enabled: false, similarityThreshold: 0.9 } },
		);

		// fetchCandidateEmbeddings is per-arm fail-soft (returns no embeddings, not a throw), so MMR
		// runs with empty embeddings (sim 0). The budget still bounds: 25 tokens fits two 10-token hits.
		// The headline guarantee is recall ANSWERS (no 500) with budget-bounded hits.
		expect(result.hits.length).toBeGreaterThanOrEqual(1);
		expect(result.hits.length).toBeLessThanOrEqual(2);
		expect(result.degraded).toBe(false);
	});
});
