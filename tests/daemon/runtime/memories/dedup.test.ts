/**
 * PRD-047c — the semantic / near-duplicate dedup stage suite.
 *
 * Verification posture (no live DeepLake, no creds — c-AC-3 runs in the orchestrator):
 *   - `recallMemories` is driven against a FAKE `StorageQuery` that answers the `<#>`
 *     vector arm, the hydration SELECT, the lexical arms, AND — for the new PRD-047c
 *     dedup stage — the candidate-embedding batch-fetch (`SELECT … AS embedding`,
 *     keyed by an `IN (...)` id list), reusing the SAME `fetchCandidateEmbeddings`
 *     helper PRD-047b's rerank uses.
 *   - c-AC-1: a fact present as a `memories` row + a `memory` summary + N `sessions`
 *     turns with within-threshold embeddings collapses to ONE hit — the highest-
 *     provenance `memories` copy. Dropped copies are REMOVED, not demoted.
 *   - c-AC-2: two semantically DIFFERENT hits, with embeddings just UNDER the
 *     threshold, both survive (the false-merge guard).
 *   - c-AC-4: every survivor keeps its `source`/`kind`/`secondary` provenance; a dedup
 *     embedding-fetch failure degrades to the un-deduped list, never a throw.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { recallMemories } from "../../../../src/daemon/runtime/memories/recall.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A 768-dim vector along `axis` (so cosine between two axes is deterministic). */
function unitVector(axis: number): number[] {
	const v = new Array(EMBEDDING_DIMS).fill(0) as number[];
	v[axis] = 1;
	return v;
}

/**
 * A 768-dim vector at a controlled ANGLE from axis 0: `[cosθ, sinθ, 0, …]`. The
 * normalized cosine similarity to `unitVector(0)` is `(1 + cosθ) / 2`, so a caller can
 * place a candidate JUST above or JUST below the 0.9 collapse threshold deterministically.
 */
function angledVector(theta: number): number[] {
	const v = new Array(EMBEDDING_DIMS).fill(0) as number[];
	v[0] = Math.cos(theta);
	v[1] = Math.sin(theta);
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

/** Classify the statement shape recall emitted. */
function kindOf(sql: string): "vector" | "dedup" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	if (sql.includes("<#>")) return "vector";
	// The candidate-embedding batch-fetch (rerank + dedup share it): `AS embedding` + `IN (...)`.
	if (/AS\s+embedding/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "dedup";
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** Which table a vector/hydrate/dedup statement targets. */
function tableOf(sql: string): "memories" | "sessions" | "other" {
	if (/FROM\s+"memories"/i.test(sql)) return "memories";
	if (/FROM\s+"sessions"/i.test(sql)) return "sessions";
	return "other";
}

/**
 * A fake storage for the dedup path: answers the `<#>` arm, the hydration SELECT, the
 * lexical arms, AND the dedup candidate-embedding batch-fetch with `(id, embedding)` rows.
 */
function dedupStorage(opts: {
	vector?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	hydrate?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	lexical?: { memories?: QueryResult; memory?: QueryResult; sessions?: QueryResult };
	embeddings?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	/** Force the embedding batch-fetch to FAIL (proves dedup fail-soft, c-AC-4). */
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
			if (kind === "dedup") {
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

describe("PRD-047c c-AC-1 — near-duplicates collapse to the highest-provenance copy", () => {
	it("a fact as memories + memory-summary + N sessions (within-threshold) collapses to ONE — the memories copy", async () => {
		// The SAME fact lives in all three tables. The `memories` row and the two `sessions`
		// turns carry COLLINEAR embeddings (cosine 1.0 > 0.9) so they cluster. The `memory`
		// summary has NO embedding column, so it folds into the established cluster by text
		// containment. The survivor MUST be the highest-provenance `memories` copy.
		const factText = "the deploy uses a blue-green cutover";
		const { storage } = dedupStorage({
			vector: {
				memories: [{ id: "mem-fact", score: 0.95 }],
				sessions: [{ id: "sess/1", score: 0.9 }, { id: "sess/2", score: 0.85 }],
			},
			hydrate: {
				memories: [{ source: "memories", id: "mem-fact", text: factText }],
				sessions: [
					{ source: "sessions", id: "sess/1", text: `raw turn: ${factText}` },
					{ source: "sessions", id: "sess/2", text: `another turn — ${factText}` },
				],
			},
			lexical: {
				// The `memory` summary arm surfaces the same fact (no embedding column → text fold-in).
				memory: ok([{ source: "memory", id: "sum/1", text: factText }], 0),
			},
			embeddings: {
				// All embedding-bearing copies are collinear → cosine 1.0, well above 0.9.
				memories: [embRow("mem-fact", unitVector(0))],
				sessions: [embRow("sess/1", unitVector(0)), embRow("sess/2", unitVector(0))],
			},
		});

		const result = await recallMemories(
			{ query: "deploy cutover", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		// Collapsed to exactly ONE hit — the highest-provenance `memories` copy.
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]?.source).toBe("memories");
		expect(result.hits[0]?.id).toBe("mem-fact");
		// The dropped copies are REMOVED, not demoted: no sessions/summary copy survives.
		expect(result.hits.some((h) => h.source === "sessions")).toBe(false);
		expect(result.hits.some((h) => h.source === "memory")).toBe(false);
		// `sources` is recomputed from the survivors (honest coverage signal).
		expect(result.sources).toEqual(["memories"]);
		expect(result.degraded).toBe(false);
	});

	it("within a class, the higher fused score wins the keep-decision", async () => {
		// Two `sessions` turns of the SAME fact (collinear embeddings), no memories/summary
		// copy. The survivor is the higher-fused-score session (sess/1 ranks above sess/2 by
		// the vector arm's order → higher RRF), and the cluster collapses to it.
		const factText = "the cache ttl is five minutes";
		const { storage } = dedupStorage({
			vector: { sessions: [{ id: "sess/1", score: 0.95 }, { id: "sess/2", score: 0.8 }] },
			hydrate: {
				sessions: [
					{ source: "sessions", id: "sess/1", text: factText },
					{ source: "sessions", id: "sess/2", text: `${factText} (restated)` },
				],
			},
			embeddings: { sessions: [embRow("sess/1", unitVector(0)), embRow("sess/2", unitVector(0))] },
		});

		const result = await recallMemories(
			{ query: "cache ttl", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]?.id).toBe("sess/1"); // the higher fused score within the class.
	});
});

describe("PRD-047c c-AC-2 — distinct facts below the threshold both survive (false-merge guard)", () => {
	it("two memories whose embeddings sit JUST UNDER the threshold are NOT merged", async () => {
		// `near` is collinear with the query (cosine 1.0); `other` is angled so its similarity
		// to `near` is just BELOW 0.9. The two are semantically distinct → BOTH must survive.
		// cos(near, other): near = unit(0); other = angledVector(θ). similarity(near,other) =
		// (1 + cos θ)/2. Pick θ so (1 + cos θ)/2 = 0.85 < 0.9  →  cos θ = 0.7.
		const theta = Math.acos(0.7);
		const { storage } = dedupStorage({
			vector: { memories: [{ id: "near", score: 0.95 }, { id: "other", score: 0.9 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "near", text: "fact about widgets" },
					{ source: "memories", id: "other", text: "an unrelated fact about gadgets" },
				],
			},
			embeddings: { memories: [embRow("near", unitVector(0)), embRow("other", angledVector(theta))] },
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		// Both distinct facts survive — under the threshold is NOT a collapse.
		const ids = result.hits.map((h) => h.id).sort();
		expect(ids).toEqual(["near", "other"]);
	});

	it("a candidate with NO embedding and no text overlap stands alone (never folded)", async () => {
		// `mem-a` (embedded) and `sum/x` (a memory summary, NO embedding) share no text → the
		// summary must NOT fold into the embedded cluster; both survive.
		const { storage } = dedupStorage({
			vector: { memories: [{ id: "mem-a", score: 0.95 }] },
			hydrate: { memories: [{ source: "memories", id: "mem-a", text: "a fact about widgets" }] },
			lexical: { memory: ok([{ source: "memory", id: "sum/x", text: "a totally different summary" }], 0) },
			embeddings: { memories: [embRow("mem-a", unitVector(0))] },
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		const ids = result.hits.map((h) => h.id).sort();
		expect(ids).toEqual(["mem-a", "sum/x"]);
	});
});

describe("PRD-047c c-AC-4 — provenance preserved + dedup fail-soft", () => {
	it("every surviving hit keeps its source / kind / secondary provenance", async () => {
		// One distilled `memories` fact + one DISTINCT raw `sessions` dump (orthogonal embeddings,
		// cosine 0.5 < 0.9 → no merge). Both survive; each keeps its provenance class + secondary flag.
		const { storage } = dedupStorage({
			vector: { memories: [{ id: "mem-fact", score: 0.95 }], sessions: [{ id: "sess/raw", score: 0.9 }] },
			hydrate: {
				memories: [{ source: "memories", id: "mem-fact", text: "a distilled fact" }],
				sessions: [{ source: "sessions", id: "sess/raw", text: "a distinct raw turn" }],
			},
			embeddings: { memories: [embRow("mem-fact", unitVector(0))], sessions: [embRow("sess/raw", unitVector(1))] },
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		const fact = result.hits.find((h) => h.id === "mem-fact");
		const dump = result.hits.find((h) => h.id === "sess/raw");
		expect(fact).toBeDefined();
		expect(dump).toBeDefined();
		expect(fact!.kind).toBe("memory");
		expect(fact!.secondary).toBe(false);
		expect(dump!.kind).toBe("session");
		expect(dump!.secondary).toBe(true);
	});

	it("a dedup embedding-fetch FAILURE degrades to the un-deduped list, never a throw", async () => {
		// Two collinear-fact copies that WOULD collapse — but the embedding batch-fetch errors,
		// so dedup finds no embeddings and degrades to the un-deduped fused list (both survive).
		const { storage } = dedupStorage({
			vector: { memories: [{ id: "dup-1", score: 0.95 }, { id: "dup-2", score: 0.9 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "dup-1", text: "the same fact" },
					{ source: "memories", id: "dup-2", text: "the same fact" },
				],
			},
			failEmbeddingFetch: true, // the embedding column fetch errors.
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "none", timeoutMs: 300, window: 50 } },
		);

		// Fail-soft: both candidates survive (no collapse), never a 500.
		expect(result.hits.map((h) => h.id).sort()).toEqual(["dup-1", "dup-2"]);
		expect(result.degraded).toBe(false);
	});

	it("dedup OFF (escape hatch) → near-dups are NOT collapsed", async () => {
		// With `enabled: false`, two collinear copies both survive — proving the stage is the
		// thing collapsing them, and the knob disables it.
		const { storage } = dedupStorage({
			vector: { memories: [{ id: "dup-1", score: 0.95 }, { id: "dup-2", score: 0.9 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "dup-1", text: "the same fact" },
					{ source: "memories", id: "dup-2", text: "the same fact" },
				],
			},
			embeddings: { memories: [embRow("dup-1", unitVector(0)), embRow("dup-2", unitVector(0))] },
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{
				storage,
				embed: fakeEmbed(QUERY_VECTOR),
				reranker: { strategy: "none", timeoutMs: 300, window: 50 },
				dedup: { enabled: false, similarityThreshold: 0.9 },
			},
		);

		expect(result.hits.map((h) => h.id).sort()).toEqual(["dup-1", "dup-2"]);
	});
});
