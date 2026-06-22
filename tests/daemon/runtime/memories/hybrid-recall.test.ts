/**
 * PRD-045 W0 — native-hybrid recall (the `deeplake_hybrid_record` bench candidate).
 *
 * Verification posture (mirrors recall.test.ts): `hybridRecall` + `buildHybridArmSql`
 * are exercised against a FAKE `StorageQuery` keyed off which arm the SQL targets
 * (read from its `'…' AS source` tag) and a FAKE `EmbedClient`. No live DeepLake.
 * The tests prove the native operator SHAPE, the SQL-guard discipline, the score-max
 * cross-arm merge + dedup + arm-class weighting, and the cannot-run degrade — so the
 * A/B candidate is correct BEFORE the gated live benchmark scores it.
 */

import { describe, expect, it } from "vitest";

import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import { ARM_CLASS_WEIGHT } from "../../../../src/daemon/runtime/memories/recall.js";
import {
	DEFAULT_HYBRID_TEXT_WEIGHT,
	DEFAULT_HYBRID_VECTOR_WEIGHT,
	buildHybridArmSql,
	hybridRecall,
	resolveHybridWeights,
} from "../../../../src/daemon/runtime/memories/hybrid-recall.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A valid 768-dim query vector. */
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

/** An EmbedClient that returns a fixed vector (or null). */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** Which arm a hybrid statement targets, read from its `'…' AS source` tag. */
function armOf(sql: string): "memories" | "sessions" | "other" {
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** A fake `StorageQuery` resolving each arm to a caller-supplied result, capturing the SQL. */
function fakeStorage(perArm: { memories: QueryResult; sessions: QueryResult }): {
	storage: StorageQuery;
	sqls: string[];
} {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const arm = armOf(sql);
			if (arm === "other") return ok([], 0);
			return perArm[arm];
		},
	};
	return { storage, sqls };
}

/** A scored hybrid row (shaped as the arm SELECT projects it). */
function row(source: string, id: string, text: string, score: number): StorageRow {
	return { source, id, text, score };
}

describe("buildHybridArmSql emits the native deeplake_hybrid_record operator, guard-safe", () => {
	const weights = { vector: 0.7, text: 0.3 };
	const sql = buildHybridArmSql(
		{
			source: "memories",
			table: "memories",
			idColumn: "id",
			embeddingColumn: "content_embedding",
			textColumn: "content",
			hydrateFilter: "AND is_deleted = 0",
		},
		"how do we refresh the token",
		VALID_QUERY_VECTOR,
		weights,
		10,
	);

	it("uses the composite cast + deeplake_hybrid_record() with the tunable weights", () => {
		expect(sql).toContain("(content_embedding, content)::deeplake_hybrid_record <#>");
		expect(sql).toContain("deeplake_hybrid_record(ARRAY[");
		expect(sql).toContain(", 0.7, 0.3)"); // the (vector, text) weights, ratio-only.
	});

	it("orders by the fused score DESC, bounds the arm, and excludes null embeddings", () => {
		expect(sql).toContain("ORDER BY score DESC");
		expect(sql).toMatch(/LIMIT 10$/);
		expect(sql).toContain("ARRAY_LENGTH(content_embedding, 1) > 0");
		expect(sql).toContain("AND is_deleted = 0");
	});

	it("escapes the query text as a literal (no raw interpolation)", () => {
		const evil = buildHybridArmSql(
			{ source: "memories", table: "memories", idColumn: "id", embeddingColumn: "content_embedding", textColumn: "content", hydrateFilter: "" },
			"o'brien'; DROP TABLE memories; --",
			VALID_QUERY_VECTOR,
			weights,
			5,
		);
		// The single quote is doubled by sLiteral, so the injection can never close the literal early.
		expect(evil).toContain("o''brien''; DROP TABLE memories; --");
		expect(evil).not.toContain("'o'brien'"); // never an unescaped, statement-closing quote.
	});
});

describe("hybridRecall merges the native arms by fused score (dedup + arm-class weight)", () => {
	it("orders by the engine score DESC and tags raw session hits secondary", async () => {
		const { storage } = fakeStorage({
			memories: ok([row("memories", "mem-1", "a distilled fact", 0.9), row("memories", "mem-2", "another fact", 0.4)], 2),
			sessions: ok([row("sessions", "sess-1", "a raw turn dump", 0.95)], 1),
		});

		const result = await hybridRecall(
			{ query: "token refresh", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(result.degraded).toBe(false);
		// The raw session scored 0.95 raw but is weighted by ARM_CLASS_WEIGHT.session (0.4) → 0.38,
		// so it sinks BELOW both distilled facts — mem-1 (0.9 × 1.0 = 0.90) and mem-2 (0.4 × 1.0 = 0.40)
		// — exactly the distilled-over-raw shaping the live RRF engine enforces (provenance parity).
		expect(result.hits.map((h) => h.id)).toEqual(["mem-1", "mem-2", "sess-1"]);
		const sess = result.hits.find((h) => h.id === "sess-1");
		expect(sess?.secondary).toBe(true);
		expect(sess?.kind).toBe("session");
		// The weighted scores are real (not fabricated): mem-1 keeps its full class weight.
		expect(result.hits[0]?.score).toBeCloseTo(0.9 * ARM_CLASS_WEIGHT.memory, 6);
		expect(result.sources.sort()).toEqual(["memories", "sessions"]);
	});

	it("degrades a failing arm to empty without sinking the recall (per-arm fail-soft)", async () => {
		const { storage } = fakeStorage({
			memories: ok([row("memories", "mem-1", "survives", 0.8)], 1),
			sessions: queryError(`relation "sessions" does not exist`),
		});

		const result = await hybridRecall(
			{ query: "anything", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(result.degraded).toBe(false); // the native path RAN; one arm just had no table.
		expect(result.hits.map((h) => h.id)).toEqual(["mem-1"]);
		expect(result.sources).toEqual(["memories"]);
	});

	it("cannot run without an embed seam → degraded, empty (the operator needs a vector)", async () => {
		const { storage, sqls } = fakeStorage({ memories: ok([], 0), sessions: ok([], 0) });
		const result = await hybridRecall({ query: "no embed here", scope: SCOPE }, { storage });
		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(sqls, "no arm SQL is issued when the query cannot be embedded").toHaveLength(0);
	});

	it("treats a null / wrong-dim embed as cannot-run (degraded, no throw)", async () => {
		const { storage } = fakeStorage({ memories: ok([], 0), sessions: ok([], 0) });
		const nullV = await hybridRecall({ query: "x", scope: SCOPE }, { storage, embed: fakeEmbed(null) });
		expect(nullV.degraded).toBe(true);
		const shortV = await hybridRecall({ query: "x", scope: SCOPE }, { storage, embed: fakeEmbed([0.1, 0.2]) });
		expect(shortV.degraded).toBe(true);
	});

	it("an empty query is the lexical floor (degraded, empty), never an embed call", async () => {
		const { storage, sqls } = fakeStorage({ memories: ok([], 0), sessions: ok([], 0) });
		const result = await hybridRecall({ query: "   ", scope: SCOPE }, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) });
		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(sqls).toHaveLength(0);
	});
});

describe("resolveHybridWeights reads the tuning env, defaulting a bad/missing value", () => {
	it("defaults to the balanced 0.5/0.5 when unset", () => {
		expect(resolveHybridWeights({})).toEqual({
			vector: DEFAULT_HYBRID_VECTOR_WEIGHT,
			text: DEFAULT_HYBRID_TEXT_WEIGHT,
		});
	});

	it("reads explicit weights and clamps a negative/non-numeric one to the default", () => {
		expect(resolveHybridWeights({ HONEYCOMB_HYBRID_VECTOR_WEIGHT: "0.8", HONEYCOMB_HYBRID_TEXT_WEIGHT: "0.2" })).toEqual({
			vector: 0.8,
			text: 0.2,
		});
		expect(resolveHybridWeights({ HONEYCOMB_HYBRID_VECTOR_WEIGHT: "-1", HONEYCOMB_HYBRID_TEXT_WEIGHT: "nope" })).toEqual({
			vector: DEFAULT_HYBRID_VECTOR_WEIGHT,
			text: DEFAULT_HYBRID_TEXT_WEIGHT,
		});
	});
});
