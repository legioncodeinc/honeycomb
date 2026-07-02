/**
 * PRD-047b — the rerank stage activation suite.
 *
 * Verification posture (no live DeepLake, no creds):
 *   - `recallMemories` is driven against a FAKE `StorageQuery` that answers the
 *     `<#>` vector arm, the hydration SELECT, the lexical arms, AND the new
 *     PRD-047b rerank embedding batch-fetch (a `SELECT … AS embedding` keyed by an
 *     `IN (...)` id list), keyed off WHICH statement-shape the SQL is.
 *   - b-AC-1: `embedding-cosine` reorders the fused top-N by cosine(query vector,
 *     candidate embedding); `none` leaves the RRF order untouched; a candidate with
 *     no hydrated embedding keeps its RRF position (never errors).
 *   - b-AC-2: a rerank that exceeds the 300ms budget keeps the pre-rerank (RRF)
 *     order — driven by an INJECTED clock, no real waiting.
 *   - b-AC-4: no query vector (embed down/degraded) → rerank skipped, RRF stands;
 *     a rerank-path failure degrades to RRF order, never a throw.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { recallMemories } from "../../../../src/daemon/runtime/memories/recall.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { RerankerConfig } from "../../../../src/daemon/runtime/recall/config.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A 768-dim query vector pointing along the first axis (so cosine is deterministic). */
function unitVector(axis: number): number[] {
	const v = new Array(EMBEDDING_DIMS).fill(0) as number[];
	v[axis] = 1;
	return v;
}

const QUERY_VECTOR = unitVector(0);

/** An EmbedClient that returns a fixed vector (or null). */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** Classify the statement shape recall emitted (extends the recall.test taxonomy with `rerank`). */
function kindOf(sql: string): "vector" | "rerank" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	if (sql.includes("<#>")) return "vector";
	// The rerank batch-fetch: selects `AS embedding`, keyed by an `IN (...)` id list.
	if (/AS\s+embedding/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "rerank";
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** Which table a vector/hydrate/rerank statement targets. */
function tableOf(sql: string): "memories" | "sessions" | "other" {
	if (/FROM\s+"memories"/i.test(sql)) return "memories";
	if (/FROM\s+"sessions"/i.test(sql)) return "sessions";
	return "other";
}

/**
 * A fake storage for the rerank path: answers the `<#>` arm with scored ids, the
 * hydration SELECT with text, the lexical arms, AND the PRD-047b rerank batch-fetch
 * with `(id, embedding)` rows. Records every statement for assertions.
 */
function rerankStorage(opts: {
	vector?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	hydrate?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	lexical?: { memories?: QueryResult; memory?: QueryResult; sessions?: QueryResult };
	embeddings?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	/** Force the rerank batch-fetch to FAIL (proves fail-soft to RRF order, b-AC-4). */
	failRerankFetch?: boolean;
}): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const kind = kindOf(sql);
			const table = tableOf(sql);
			// PRD-013: a table with no configured bucket (e.g. the `hive_graph_versions` arm this
			// test does not populate) resolves to EMPTY — modeling a real absent/empty table, not
			// the memories rows (which the prior `other → memories` fallback would have fabricated).
			const bucket = (m?: { memories?: StorageRow[]; sessions?: StorageRow[] }): StorageRow[] =>
				table === "memories" ? (m?.memories ?? []) : table === "sessions" ? (m?.sessions ?? []) : [];
			if (kind === "vector") return ok(bucket(opts.vector), 0);
			if (kind === "hydrate") return ok(bucket(opts.hydrate), 0);
			if (kind === "rerank") {
				if (opts.failRerankFetch) return queryError(`relation "${table}" missing column`);
				return ok(bucket(opts.embeddings), 0);
			}
			if (kind === "memories") return opts.lexical?.memories ?? ok([], 0);
			if (kind === "memory") return opts.lexical?.memory ?? ok([], 0);
			if (kind === "sessions") return opts.lexical?.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage, sqls };
}

/** An embedding row as the rerank batch-fetch projects it (`id`, `embedding`). */
function embRow(id: string, vec: number[]): StorageRow {
	return { id, embedding: vec };
}

describe("PRD-047b b-AC-1 — embedding-cosine rerank reorders the fused top-N by cosine", () => {
	it("reorders RRF: the candidate whose embedding is closest to the query vector rises to #1", async () => {
		// Two distilled memories surface from the `<#>` arm. By the vector arm's order the
		// RRF rank is [far, near]. But `near`'s stored embedding is COLLINEAR with the query
		// (cosine 1.0) while `far`'s is orthogonal (cosine 0.5 after 0..1 normalization), so
		// the embedding-cosine rerank must lift `near` ABOVE `far`.
		const { storage, sqls } = rerankStorage({
			vector: { memories: [{ id: "far", score: 0.9 }, { id: "near", score: 0.8 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "far", text: "an orthogonal fact" },
					{ source: "memories", id: "near", text: "a collinear fact" },
				],
			},
			embeddings: {
				memories: [embRow("near", unitVector(0)), embRow("far", unitVector(1))],
			},
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			// Default strategy is `none` (b-AC-3 measured ~0 lift); activate cosine explicitly to prove the reorder.
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "embedding-cosine", timeoutMs: 300, window: 50 } },
		);

		// The rerank batch-fetch was actually issued (proves the stage ran).
		expect(sqls.some((s) => /AS\s+embedding/i.test(s))).toBe(true);
		// `near` (cosine 1.0) reordered ABOVE `far` (cosine 0.5) — RRF order was [far, near].
		expect(result.hits.map((h) => h.id)).toEqual(["near", "far"]);
		expect(result.degraded).toBe(false);
	});

	it("a candidate with NO hydrated embedding keeps its RRF position (never errors)", async () => {
		// Three candidates; only the middle one (`b`) has a stored embedding. The rerank must
		// not throw and must not move the un-embedded candidates relative to each other.
		const { storage } = rerankStorage({
			vector: { memories: [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }, { id: "c", score: 0.7 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "a", text: "fact a" },
					{ source: "memories", id: "b", text: "fact b" },
					{ source: "memories", id: "c", text: "fact c" },
				],
			},
			// Only `b` comes back from the embedding fetch (a, c had NULL embeddings → not returned).
			embeddings: { memories: [embRow("b", unitVector(0))] },
		});

		// Activate the cosine rerank explicitly (default is `none`); without this the stage
		// never runs and the no-embedding path is not exercised.
		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "embedding-cosine", timeoutMs: 300, window: 50 } },
		);

		// No throw; all three survive. The un-scored candidates (`a`, `c`) keep their EXACT
		// RRF slots and the only scored candidate (`b`) stays in its slot — a TOTAL-ORDER
		// rerank produces a deterministic, stable head with no cycle (guards FIX-1).
		const ids = result.hits.map((h) => h.id);
		expect(ids).toEqual(["a", "b", "c"]);

		// Determinism: the same input yields the identical head across repeated runs.
		const again = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "embedding-cosine", timeoutMs: 300, window: 50 } },
		);
		expect(again.hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
	});

	it("strategy `none` leaves the RRF order UNTOUCHED and issues NO rerank fetch", async () => {
		const noneConfig: RerankerConfig = { strategy: "none", timeoutMs: 300, window: 50 };
		const { storage, sqls } = rerankStorage({
			vector: { memories: [{ id: "far", score: 0.9 }, { id: "near", score: 0.8 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "far", text: "an orthogonal fact" },
					{ source: "memories", id: "near", text: "a collinear fact" },
				],
			},
			embeddings: { memories: [embRow("near", unitVector(0)), embRow("far", unitVector(1))] },
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			// Dedup OFF so the `AS embedding` assertion isolates the RERANK stage (PRD-047c
			// dedup also self-sources embeddings via the same batch-fetch shape).
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: noneConfig, dedup: { enabled: false, similarityThreshold: 0.9 } },
		);

		// RRF order preserved (the vector arm's order: far before near) — NO reorder.
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
		// And no rerank batch-fetch was ever issued.
		expect(sqls.some((s) => /AS\s+embedding/i.test(s))).toBe(false);
	});
});

describe("PRD-047b b-AC-2 — a rerank over the 300ms budget keeps the pre-rerank (RRF) order", () => {
	it("an injected clock that jumps past the timeout after the fetch → RRF order, no partial reorder", async () => {
		// `near` would win on cosine, but the injected clock reports the fetch took longer than
		// the budget, so the rerank must return the RRF order ([far, near]) unchanged.
		const { storage } = rerankStorage({
			vector: { memories: [{ id: "far", score: 0.9 }, { id: "near", score: 0.8 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "far", text: "an orthogonal fact" },
					{ source: "memories", id: "near", text: "a collinear fact" },
				],
			},
			embeddings: { memories: [embRow("near", unitVector(0)), embRow("far", unitVector(1))] },
		});

		// Clock: first read = start (0), second read = after-fetch (500 > 300 budget).
		const ticks = [0, 500];
		let i = 0;
		const now = (): number => ticks[Math.min(i++, ticks.length - 1)]!;

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "embedding-cosine", timeoutMs: 300, window: 50 }, now },
		);

		// Over budget → pre-rerank RRF order stands ([far, near]), never the cosine reorder.
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
	});

	it("within budget → the reorder DOES apply (proves the timeout gate is the only thing holding it back)", async () => {
		const { storage } = rerankStorage({
			vector: { memories: [{ id: "far", score: 0.9 }, { id: "near", score: 0.8 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "far", text: "an orthogonal fact" },
					{ source: "memories", id: "near", text: "a collinear fact" },
				],
			},
			embeddings: { memories: [embRow("near", unitVector(0)), embRow("far", unitVector(1))] },
		});

		const ticks = [0, 50]; // 50ms < 300ms budget.
		let i = 0;
		const now = (): number => ticks[Math.min(i++, ticks.length - 1)]!;

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(QUERY_VECTOR), reranker: { strategy: "embedding-cosine", timeoutMs: 300, window: 50 }, now },
		);

		expect(result.hits.map((h) => h.id)).toEqual(["near", "far"]);
	});
});

describe("PRD-047b b-AC-4 — no-vector skip + rerank fail-soft keep the RRF order, never a 500", () => {
	it("embed returns null (degraded) → rerank SKIPPED, RRF/lexical order stands, no rerank fetch", async () => {
		const { storage, sqls } = rerankStorage({
			lexical: {
				memories: ok(
					[
						{ source: "memories", id: "lex-1", text: "first lexical fact" },
						{ source: "memories", id: "lex-2", text: "second lexical fact" },
					],
					0,
				),
			},
		});

		const result = await recallMemories(
			{ query: "fact", scope: SCOPE, limit: 10 },
			// no query vector → degraded, no rerank. Dedup OFF so `AS embedding` isolates the
			// RERANK stage (PRD-047c dedup self-sources embeddings via the same batch-fetch shape).
			{ storage, embed: fakeEmbed(null), dedup: { enabled: false, similarityThreshold: 0.9 } },
		);

		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["lex-1", "lex-2"]);
		// The rerank stage never fired (no query vector to score against).
		expect(sqls.some((s) => /AS\s+embedding/i.test(s))).toBe(false);
	});

	it("no embed client injected → rerank skipped, RRF order stands", async () => {
		const { storage, sqls } = rerankStorage({
			lexical: { memories: ok([{ source: "memories", id: "lex-only", text: "a fact" }], 0) },
		});

		const result = await recallMemories({ query: "fact", scope: SCOPE, limit: 10 }, { storage });

		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["lex-only"]);
		expect(sqls.some((s) => /AS\s+embedding/i.test(s))).toBe(false);
	});

	it("the rerank embedding batch-fetch FAILS → degrades to RRF order, never throws", async () => {
		const { storage } = rerankStorage({
			vector: { memories: [{ id: "far", score: 0.9 }, { id: "near", score: 0.8 }] },
			hydrate: {
				memories: [
					{ source: "memories", id: "far", text: "an orthogonal fact" },
					{ source: "memories", id: "near", text: "a collinear fact" },
				],
			},
			failRerankFetch: true, // the embedding column fetch errors.
		});

		// Activate the cosine rerank explicitly (default is `none`) so `failRerankFetch`
		// trips the RERANK batch-fetch, not just the dedup fetch; dedup OFF isolates the
		// rerank fail-soft path. Without this the rerank stage never runs.
		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{
				storage,
				embed: fakeEmbed(QUERY_VECTOR),
				reranker: { strategy: "embedding-cosine", timeoutMs: 300, window: 50 },
				dedup: { enabled: false, similarityThreshold: 0.9 },
			},
		);

		// A failed fetch contributes no embeddings → every candidate keeps RRF position.
		// (`runArm` swallows the error to [], so the rerank simply finds no embeddings.)
		expect(result.hits.map((h) => h.id)).toEqual(["far", "near"]);
		expect(result.degraded).toBe(false);
	});

	it("`keyword` mode → no semantic vector, so the rerank is skipped and lexical order stands", async () => {
		const { storage, sqls } = rerankStorage({
			lexical: {
				memories: ok(
					[
						{ source: "memories", id: "kw-1", text: "kw fact one" },
						{ source: "memories", id: "kw-2", text: "kw fact two" },
					],
					0,
				),
			},
		});

		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			// Dedup OFF so `AS embedding` isolates the RERANK stage (dedup self-sources embeddings).
			{ storage, embed: fakeEmbed(QUERY_VECTOR), recallMode: "keyword", dedup: { enabled: false, similarityThreshold: 0.9 } },
		);

		expect(result.degraded).toBe(false); // intentional lexical run, not a fallback.
		expect(result.hits.map((h) => h.id)).toEqual(["kw-1", "kw-2"]);
		expect(sqls.some((s) => /AS\s+embedding/i.test(s))).toBe(false);
	});
});
