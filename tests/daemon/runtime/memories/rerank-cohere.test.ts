/**
 * PRD-063c — the `cohere` rerank branch through `recallMemories` (c-AC-1 / c-AC-3 / c-AC-4).
 *
 * Drives the LIVE recall engine against a FAKE `StorageQuery` (the rerank.test harness) PLUS an
 * injected fake {@link CohereRerankSeam} (no network, no real Portkey). Proves:
 *   c-AC-1  strategy `cohere` + the seam present → the engine sends the fused top-N candidate TEXTS
 *           to the seam and reorders the window by the returned relevance scores.
 *   c-AC-3  bounded + fail-soft: a HANGING seam (timeout via injected clock), an `ok:false` seam
 *           (error/malformed), each → the RRF order unchanged; recall still returns the hits.
 *   c-AC-4  byte-identical when off: strategy `cohere` with NO seam (gateway off), or strategy
 *           `embedding-cosine`/`none`, makes NO seam call and leaves behavior unchanged.
 */

import { describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	recallMemories,
	type CohereRerankSeam,
	type CohereRerankOutcome,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { RerankerConfig } from "../../../../src/daemon/runtime/recall/config.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

function unitVector(axis: number): number[] {
	const v = new Array(EMBEDDING_DIMS).fill(0) as number[];
	v[axis] = 1;
	return v;
}
const QUERY_VECTOR = unitVector(0);

function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** A complete `cohere` reranker config (env-resolved shape). */
function cohereConfig(over: Partial<RerankerConfig> = {}): RerankerConfig {
	return {
		strategy: "cohere",
		timeoutMs: 300,
		providerTimeoutMs: 1000,
		window: 50,
		cohereModel: "rerank-v3.5",
		...over,
	};
}

function kindOf(sql: string): "vector" | "rerank" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	if (sql.includes("<#>")) return "vector";
	if (/AS\s+embedding/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "rerank";
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}
function tableOf(sql: string): "memories" | "sessions" | "other" {
	if (/FROM\s+"memories"/i.test(sql)) return "memories";
	if (/FROM\s+"sessions"/i.test(sql)) return "sessions";
	return "other";
}

/** A fake storage that answers the `<#>` arm + the hydrate SELECT + the lexical arms. */
function recallStorage(opts: {
	vector?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	hydrate?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	lexical?: { memories?: QueryResult; memory?: QueryResult; sessions?: QueryResult };
}): StorageQuery {
	return {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			const kind = kindOf(sql);
			const table = tableOf(sql);
			const tbl = table === "other" ? "memories" : table;
			if (kind === "vector") return ok(opts.vector?.[tbl] ?? [], 0);
			if (kind === "hydrate") return ok(opts.hydrate?.[tbl] ?? [], 0);
			if (kind === "memories") return opts.lexical?.memories ?? ok([], 0);
			if (kind === "memory") return opts.lexical?.memory ?? ok([], 0);
			if (kind === "sessions") return opts.lexical?.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
}

/** A fake seam that records its calls + returns a fixed outcome (or hangs). */
function fakeSeam(behavior: {
	outcome?: CohereRerankOutcome;
	hang?: boolean;
}): { seam: CohereRerankSeam; calls: { query: string; documents: readonly string[]; topN: number }[] } {
	const calls: { query: string; documents: readonly string[]; topN: number }[] = [];
	const seam: CohereRerankSeam = {
		rerank(query, documents, topN) {
			calls.push({ query, documents, topN });
			if (behavior.hang) return new Promise<CohereRerankOutcome>(() => {}); // never resolves.
			return Promise.resolve(behavior.outcome ?? { ok: false });
		},
	};
	return { seam, calls };
}

/** Two distilled memories surfaced from the vector arm; RRF order [far, near]. */
function twoHitStorage(): StorageQuery {
	return recallStorage({
		vector: { memories: [{ id: "far", score: 0.9 }, { id: "near", score: 0.8 }] },
		hydrate: {
			memories: [
				{ source: "memories", id: "far", text: "an orthogonal fact" },
				{ source: "memories", id: "near", text: "a collinear fact" },
			],
		},
	});
}

describe("PRD-063c c-AC-1 — cohere rerank sends the candidate texts + reorders by relevance", () => {
	it("sends { query, documents, topN } to the seam and reorders the window by relevance_score", async () => {
		const storage = twoHitStorage();
		// RRF order is [far, near]; the seam scores `near` (index 1) above `far` (index 0), so the
		// reorder must lift `near` to #1.
		const { seam, calls } = fakeSeam({
			outcome: { ok: true, results: [{ index: 1, relevanceScore: 0.95 }, { index: 0, relevanceScore: 0.2 }] },
		});

		const result = await recallMemories(
			{ query: "how do we rerank", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: cohereConfig(), cohereRerank: seam },
		);

		// The seam saw the fused candidate TEXTS in RRF order + the window size.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.query).toBe("how do we rerank");
		expect(calls[0]!.documents).toEqual(["an orthogonal fact", "a collinear fact"]);
		expect(calls[0]!.topN).toBe(2);
		// `near` reordered above `far`.
		expect(result.hits.map((h) => h.id)).toEqual(["near", "far"]);
	});

	it("runs even on a lexical-only recall (no query vector) — cohere scores TEXT, not the vector", async () => {
		// embed returns null → degraded (lexical-only). The cohere branch still runs (unlike cosine).
		const storage = recallStorage({
			lexical: {
				memories: ok(
					[
						{ source: "memories", id: "a", text: "fact a", score: 2 },
						{ source: "memories", id: "b", text: "fact b", score: 1 },
					],
					0,
				),
			},
		});
		const { seam, calls } = fakeSeam({
			outcome: { ok: true, results: [{ index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.1 }] },
		});
		const result = await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(null), reranker: cohereConfig(), cohereRerank: seam },
		);
		expect(result.degraded).toBe(true); // lexical-only.
		expect(calls).toHaveLength(1); // the cohere rerank STILL ran.
		expect(result.hits.map((h) => h.id)).toEqual(["b", "a"]); // reordered by relevance.
	});
});

describe("PRD-063c c-AC-3 — bounded + fail-soft to the RRF order", () => {
	it("a HANGING seam (timeout via injected clock) → the RRF order, recall still returns hits", async () => {
		const storage = twoHitStorage();
		const { seam } = fakeSeam({ hang: true });
		// An injected clock that jumps PAST the providerTimeoutMs so the race resolves to TIMED_OUT
		// deterministically with no real waiting.
		let t = 0;
		const now = (): number => {
			const v = t;
			t += 5000; // every sample advances 5s — well past the 1000ms budget.
			return v;
		};
		const result = await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: cohereConfig({ providerTimeoutMs: 10 }), cohereRerank: seam, now },
		);
		// RRF order preserved (no reorder); recall still returned both hits.
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
	});

	it("an ok:false seam (error/malformed) → the RRF order unchanged", async () => {
		const storage = twoHitStorage();
		const { seam, calls } = fakeSeam({ outcome: { ok: false } });
		const result = await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: cohereConfig(), cohereRerank: seam },
		);
		expect(calls).toHaveLength(1); // the seam was called…
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]); // …and fail-soft kept the RRF order.
	});

	it("a seam that REJECTS (despite the contract) → the RRF order, never a thrown recall", async () => {
		const storage = twoHitStorage();
		const seam: CohereRerankSeam = {
			rerank() {
				return Promise.reject(new Error("boom"));
			},
		};
		const result = await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: cohereConfig(), cohereRerank: seam },
		);
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
	});
});

describe("PRD-063c c-AC-4 — byte-identical when cohere is not in force", () => {
	it("strategy `cohere` with NO seam (gateway off) → no rerank, RRF order stands", async () => {
		const storage = twoHitStorage();
		const result = await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			// strategy is `cohere` but the seam is ABSENT → degrades to RRF (c-AC-4).
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: cohereConfig() },
		);
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
	});

	it("strategy `none` → the seam is NEVER called even when present", async () => {
		const storage = twoHitStorage();
		const { seam, calls } = fakeSeam({
			outcome: { ok: true, results: [{ index: 1, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.1 }] },
		});
		const result = await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			{
				storage,
				embed: fakeEmbed(QUERY_VECTOR),
				reranker: cohereConfig({ strategy: "none" }),
				cohereRerank: seam,
			},
		);
		expect(calls).toHaveLength(0); // `none` short-circuits before any rerank.
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
	});

	it("strategy `embedding-cosine` → the cohere seam is NEVER called", async () => {
		const storage = twoHitStorage();
		const seamCall = vi.fn();
		const seam: CohereRerankSeam = {
			rerank(query, documents, topN) {
				seamCall(query, documents, topN);
				return Promise.resolve({ ok: false });
			},
		};
		await recallMemories(
			{ query: "q", scope: SCOPE, limit: 10 },
			{
				storage,
				embed: fakeEmbed(QUERY_VECTOR),
				reranker: cohereConfig({ strategy: "embedding-cosine" }),
				cohereRerank: seam,
			},
		);
		expect(seamCall).not.toHaveBeenCalled(); // the cosine path never touches the cohere seam.
	});
});
