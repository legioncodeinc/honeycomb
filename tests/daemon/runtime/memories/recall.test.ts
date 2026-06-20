/**
 * PRD-022 `recallMemories` per-arm recall adapter — the recall-resilience suite.
 *
 * Verification posture:
 *   - `recallMemories` is exercised directly against a FAKE `StorageQuery` (a plain
 *     object whose `query(sql, scope)` returns a typed {@link QueryResult}), keyed
 *     off WHICH table the per-arm SQL targets. No live DeepLake, no creds.
 *   - The headline test is the LIVE DOGFOOD REGRESSION: on a fresh workspace
 *     partition only `memories` exists; the `memory` and `sessions` sibling arms
 *     fail with a `query_error` ("relation … does not exist"). Recall MUST still
 *     surface the `memories` hit — a missing sibling arm must NOT wipe the real one.
 *   - Recall still fails-soft OVERALL (every arm failing → empty, never a throw),
 *     keeps `degraded: true` (embeddings off, ledger D-4), preserves the soft-delete
 *     exclusion + per-arm LIMIT, and routes every value through the SQL guards.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	DEFAULT_RECALL_LIMIT,
	MAX_RECALL_LIMIT,
	buildMemoriesArmSql,
	buildMemoryArmSql,
	buildSessionsArmSql,
	recallMemories,
	resolveRecallLimit,
} from "../../../../src/daemon/runtime/memories/recall.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** Which arm a per-arm recall statement targets, read from its `'…' AS source` tag. */
function armOf(sql: string): "memories" | "memory" | "sessions" | "other" {
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/**
 * A fake `StorageQuery` that resolves each arm's statement to a caller-supplied
 * `QueryResult` (an `ok(rows)` or a `queryError(...)`), captured for assertions.
 * This is the seam that lets a sibling arm "not exist" deterministically.
 */
function fakeStorage(perArm: {
	memories: QueryResult;
	memory: QueryResult;
	sessions: QueryResult;
}): { storage: StorageQuery; sqls: string[] } {
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

/** A `memories`-arm hit row (shaped as the arm SELECT projects it). */
function memoriesRow(id: string, text: string): StorageRow {
	return { source: "memories", id, text };
}
/** A `sessions`-arm hit row. */
function sessionsRow(id: string, text: string): StorageRow {
	return { source: "sessions", id, text };
}

/** The "relation does not exist" rejection a fresh partition returns for an absent table. */
function relationMissing(table: string): QueryResult {
	return queryError(`relation "${table}" does not exist`);
}

describe("recallMemories runs the three arms resiliently (per-arm fail-soft)", () => {
	it("DOGFOOD REGRESSION: missing memory + sessions sibling tables → the memories hit STILL returns", async () => {
		// Fresh partition: only `memories` exists; the sibling arms fail the way DeepLake
		// rejects an absent relation. The OLD single-UNION-ALL wiped the whole recall here.
		const { storage } = fakeStorage({
			memories: ok([memoriesRow("mem-1", "a fact about widgets")], 1),
			memory: relationMissing("memory"),
			sessions: relationMissing("sessions"),
		});

		const result = await recallMemories({ query: "widgets", scope: SCOPE }, { storage });

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]?.source).toBe("memories");
		expect(result.hits[0]?.id).toBe("mem-1");
		expect(result.hits[0]?.text).toContain("widgets");
		expect(result.sources).toEqual(["memories"]);
		// Embeddings off → lexical-only; the fallback flag is surfaced.
		expect(result.degraded).toBe(true);
	});

	it("all arms fail (every table missing) → empty result, degraded, NO throw (overall fail-soft)", async () => {
		const { storage } = fakeStorage({
			memories: relationMissing("memories"),
			memory: relationMissing("memory"),
			sessions: relationMissing("sessions"),
		});

		const result = await recallMemories({ query: "anything", scope: SCOPE }, { storage });

		expect(result.hits).toEqual([]);
		expect(result.sources).toEqual([]);
		expect(result.degraded).toBe(true);
	});

	it("multi-arm success merges memories + sessions, distinct sources, capped at the overall limit", async () => {
		const { storage } = fakeStorage({
			memories: ok([memoriesRow("mem-1", "kept fact about widgets"), memoriesRow("mem-2", "another widget fact")], 1),
			memory: ok([], 1),
			sessions: ok([sessionsRow("sess/1", "a raw turn mentioning widgets")], 1),
		});

		const result = await recallMemories({ query: "widgets", scope: SCOPE, limit: 10 }, { storage });

		// memories arm (2) then sessions arm (1), merged in arm order.
		expect(result.hits.map((h) => h.source)).toEqual(["memories", "memories", "sessions"]);
		expect(result.hits.map((h) => h.id)).toEqual(["mem-1", "mem-2", "sess/1"]);
		// Distinct-source set reflects exactly the arms that surfaced a hit.
		expect(result.sources).toEqual(["memories", "sessions"]);
		expect(result.degraded).toBe(true);
	});

	it("merge order is memories → memory → sessions", async () => {
		const { storage } = fakeStorage({
			memories: ok([memoriesRow("mem-1", "m widgets")], 1),
			memory: ok([{ source: "memory", id: "sum/1", text: "summary widgets" }], 1),
			sessions: ok([sessionsRow("sess/1", "turn widgets")], 1),
		});

		const result = await recallMemories({ query: "widgets", scope: SCOPE }, { storage });

		expect(result.hits.map((h) => h.source)).toEqual(["memories", "memory", "sessions"]);
		expect(result.sources).toEqual(["memories", "memory", "sessions"]);
	});

	it("the merged union is capped at the overall (clamped) limit, not the per-arm sum", async () => {
		const many = Array.from({ length: 5 }, (_, i) => memoriesRow(`mem-${i}`, `widgets ${i}`));
		const { storage } = fakeStorage({
			memories: ok(many, 1),
			memory: ok([{ source: "memory", id: "sum/1", text: "summary widgets" }], 1),
			sessions: ok([sessionsRow("sess/1", "turn widgets")], 1),
		});

		const result = await recallMemories({ query: "widgets", scope: SCOPE, limit: 3 }, { storage });

		expect(result.hits).toHaveLength(3);
		// First-three are all from the memories arm (merge order), so only memories surfaced.
		expect(result.sources).toEqual(["memories"]);
	});

	it("an empty query short-circuits to empty without issuing any arm query", async () => {
		const { storage, sqls } = fakeStorage({
			memories: ok([memoriesRow("mem-1", "x")], 1),
			memory: ok([], 1),
			sessions: ok([], 1),
		});

		const result = await recallMemories({ query: "   ", scope: SCOPE }, { storage });

		expect(result.hits).toEqual([]);
		expect(result.sources).toEqual([]);
		expect(result.degraded).toBe(true);
		expect(sqls).toEqual([]);
	});

	it("a connection-style failure on one arm degrades that arm to empty, not the whole recall", async () => {
		// `queryError` is the relation-missing shape; a NON-query_error failure (e.g. the
		// storage layer surfaces a connection error) must also degrade per-arm.
		const { storage } = fakeStorage({
			memories: ok([memoriesRow("mem-1", "kept widgets")], 1),
			memory: { kind: "connection_error", message: "socket reset" },
			sessions: { kind: "timeout", message: "exceeded", timeoutMs: 1000 },
		});

		const result = await recallMemories({ query: "widgets", scope: SCOPE }, { storage });

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]?.source).toBe("memories");
		expect(result.sources).toEqual(["memories"]);
		expect(result.degraded).toBe(true);
	});
});

describe("per-arm recall SQL builders keep the guards, limits, and soft-delete exclusion", () => {
	it("the memories arm routes the term through sqlLike, excludes soft-deleted rows, and carries the per-arm LIMIT", () => {
		const sql = buildMemoriesArmSql("wid%get", 7);
		// Term wildcards are escaped (sqlLike) — a literal `%` is not a live wildcard.
		expect(sql).toContain("ILIKE '%wid\\%get%'");
		// Soft-delete exclusion preserved (sqlIdent yields a bare validated identifier).
		expect(sql).toContain("is_deleted = 0");
		// Per-arm LIMIT preserved as a bare clamped integer (no String() wrapper, no quotes).
		expect(sql).toMatch(/LIMIT 7\s*$/);
		expect(sql).toContain('FROM "memories"');
		expect(sql).toContain("'memories' AS source");
	});

	it("the memory arm and sessions arm match their own columns/tables with guarded ILIKE + LIMIT", () => {
		const memorySql = buildMemoryArmSql("term", 5);
		expect(memorySql).toContain('FROM "memory"');
		expect(memorySql).toContain("summary::text ILIKE");
		expect(memorySql).toMatch(/LIMIT 5\s*$/);

		const sessionsSql = buildSessionsArmSql("term", 5);
		expect(sessionsSql).toContain('FROM "sessions"');
		expect(sessionsSql).toContain("message::text ILIKE");
		expect(sessionsSql).toMatch(/LIMIT 5\s*$/);
	});

	it("a single-quote injection in the term cannot break out of the literal in any arm", () => {
		const evil = "x'; DROP TABLE memories; --";
		for (const sql of [buildMemoriesArmSql(evil, 1), buildMemoryArmSql(evil, 1), buildSessionsArmSql(evil, 1)]) {
			// The injected quote is doubled by sqlStr/sqlLike, so it never closes the literal.
			expect(sql).toContain("x''; DROP TABLE memories; --");
			// And no second live statement was produced (the `;` rides INSIDE the literal).
			expect(sql).not.toMatch(/'%x';\s*DROP TABLE/i);
		}
	});

	it("a fat-fingered per-arm limit is clamped to a positive integer in the SQL", () => {
		expect(buildMemoriesArmSql("t", 0)).toMatch(/LIMIT 1\s*$/);
		expect(buildMemoriesArmSql("t", -10)).toMatch(/LIMIT 1\s*$/);
		expect(buildMemoriesArmSql("t", 4.9)).toMatch(/LIMIT 4\s*$/);
	});
});

describe("resolveRecallLimit clamps the caller limit into [1, MAX]", () => {
	it("defaults a missing/non-finite limit", () => {
		expect(resolveRecallLimit(undefined)).toBe(DEFAULT_RECALL_LIMIT);
		expect(resolveRecallLimit(Number.NaN)).toBe(DEFAULT_RECALL_LIMIT);
	});
	it("defaults a sub-1 limit and clamps an over-max limit", () => {
		expect(resolveRecallLimit(0)).toBe(DEFAULT_RECALL_LIMIT);
		expect(resolveRecallLimit(-5)).toBe(DEFAULT_RECALL_LIMIT);
		expect(resolveRecallLimit(MAX_RECALL_LIMIT + 1000)).toBe(MAX_RECALL_LIMIT);
	});
	it("honors and truncates an in-range limit", () => {
		expect(resolveRecallLimit(15)).toBe(15);
		expect(resolveRecallLimit(15.9)).toBe(15);
	});
});
