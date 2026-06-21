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
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A valid 768-dim query vector for the semantic-arm tests. */
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

/** An EmbedClient that returns a fixed vector (or null) — the recall semantic seam. */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** An EmbedClient that throws — proves recall guards an unexpected embed throw (→ lexical). */
function throwingEmbed(): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			throw new Error("embed daemon exploded");
		},
	};
}

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

// ── PRD-025 AC-3 — the `<#>` cosine arm runs + `degraded` tells the truth ────────

/** Classify which kind of statement recall emitted, for the semantic-path fake. */
function kindOf(sql: string): "vector" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	// The vector arm: the `<#>` cosine operator, no `AS source` tag (IDs+score only).
	if (sql.includes("<#>")) return "vector";
	// The hydration SELECT: tagged with `AS source` AND keyed by an `IN (...)` id list.
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** Which table a vector / hydrate statement targets, read from its `FROM "<tbl>"`. */
function tableOf(sql: string): "memories" | "sessions" | "other" {
	if (/FROM\s+"memories"/i.test(sql)) return "memories";
	if (/FROM\s+"sessions"/i.test(sql)) return "sessions";
	return "other";
}

/**
 * A fake storage for the SEMANTIC path: it answers the `<#>` vector arm with scored
 * ids per table, the hydration SELECT with the matched rows' text, and the three
 * lexical arms with caller-supplied rows. Records every statement for assertions.
 */
function semanticStorage(opts: {
	vector?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	hydrate?: { memories?: StorageRow[]; sessions?: StorageRow[] };
	lexical?: { memories?: QueryResult; memory?: QueryResult; sessions?: QueryResult };
}): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const kind = kindOf(sql);
			const table = tableOf(sql);
			if (kind === "vector") return ok((opts.vector?.[table === "other" ? "memories" : table]) ?? [], 0);
			if (kind === "hydrate") return ok((opts.hydrate?.[table === "other" ? "memories" : table]) ?? [], 0);
			if (kind === "memories") return opts.lexical?.memories ?? ok([], 0);
			if (kind === "memory") return opts.lexical?.memory ?? ok([], 0);
			if (kind === "sessions") return opts.lexical?.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage, sqls };
}

describe("AC-3 recall runs the `<#>` cosine arm and reports `degraded` honestly", () => {
	it("SEMANTIC RAN → degraded:false: the `<#>` arm surfaces a lexical-MISS memory", async () => {
		// The captured memory shares NO surface token with the query — a pure lexical miss —
		// but the semantic `<#>` arm returns it by cosine. degraded MUST be false.
		const { storage, sqls } = semanticStorage({
			vector: { memories: [{ id: "mem-sem-1", score: 0.92 }] },
			hydrate: { memories: [{ source: "memories", id: "mem-sem-1", text: "the build is timing out on the pack step" }] },
			lexical: { memories: ok([], 0), memory: ok([], 0), sessions: ok([], 0) },
		});

		const result = await recallMemories(
			{ query: "CI keeps failing during publish", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(result.degraded, "the semantic arm ran → not degraded").toBe(false);
		expect(result.hits.map((h) => h.id)).toContain("mem-sem-1");
		expect(result.hits.find((h) => h.id === "mem-sem-1")?.text).toContain("pack step");
		expect(result.sources).toContain("memories");
		// The `<#>` cosine arm was actually issued (proves it reached vectorSearch).
		expect(sqls.some((s) => s.includes("<#>"))).toBe(true);
	});

	it("SEMANTIC RAN over sessions too → a captured turn surfaces by cosine, degraded:false", async () => {
		const { storage } = semanticStorage({
			vector: { sessions: [{ id: "conversations/s1", score: 0.81 }] },
			hydrate: {
				sessions: [{ source: "sessions", id: "conversations/s1", text: "the build is timing out on the pack step" }],
			},
		});

		const result = await recallMemories(
			{ query: "CI keeps failing during publish", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(result.degraded).toBe(false);
		expect(result.hits.some((h) => h.source === "sessions" && h.id === "conversations/s1")).toBe(true);
	});

	it("FALLBACK (embed returns null) → degraded:true, lexical-only, no `<#>` arm issued", async () => {
		const { storage, sqls } = semanticStorage({
			lexical: { memories: ok([{ source: "memories", id: "mem-lex-1", text: "a widget fact" }], 0) },
		});

		const result = await recallMemories(
			{ query: "widget", scope: SCOPE },
			{ storage, embed: fakeEmbed(null) }, // off / unreachable / timeout → null.
		);

		expect(result.degraded, "embed null → genuine fallback").toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["mem-lex-1"]);
		// No `<#>` statement was issued — the cosine arm short-circuits on a null embed.
		expect(sqls.some((s) => s.includes("<#>"))).toBe(false);
	});

	it("FALLBACK (no embed client injected) → degraded:true (the lexical floor is unchanged)", async () => {
		const { storage, sqls } = semanticStorage({
			lexical: { memories: ok([{ source: "memories", id: "mem-lex-2", text: "another fact" }], 0) },
		});

		const result = await recallMemories({ query: "fact", scope: SCOPE }, { storage });

		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["mem-lex-2"]);
		expect(sqls.some((s) => s.includes("<#>"))).toBe(false);
	});

	it("FALLBACK (embed THROWS) → recall never throws, degrades to lexical, degraded:true", async () => {
		const { storage } = semanticStorage({
			lexical: { memories: ok([{ source: "memories", id: "mem-lex-3", text: "resilient fact" }], 0) },
		});

		const result = await recallMemories(
			{ query: "resilient", scope: SCOPE },
			{ storage, embed: throwingEmbed() },
		);

		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["mem-lex-3"]);
	});

	it("AC-6 defense-in-depth: a wrong-dim query vector is NOT run as a semantic arm → degraded:true", async () => {
		// The embed-client already dim-guards, but recall double-checks: a non-768 vector
		// reaching recall must NOT be sent to the `<#>` arm — it degrades to lexical.
		const wrongDim = new Array(512).fill(0.1) as number[];
		const { storage, sqls } = semanticStorage({
			lexical: { memories: ok([{ source: "memories", id: "mem-lex-4", text: "dim guard fact" }], 0) },
		});

		const result = await recallMemories(
			{ query: "dim guard", scope: SCOPE },
			{ storage, embed: fakeEmbed(wrongDim) },
		);

		expect(result.degraded, "a wrong-dim vector never runs the semantic arm").toBe(true);
		expect(sqls.some((s) => s.includes("<#>")), "no `<#>` arm for a malformed vector").toBe(false);
		expect(result.hits.map((h) => h.id)).toEqual(["mem-lex-4"]);
	});

	it("SEMANTIC RAN but found nothing → still degraded:false (honest: it ran, it just missed)", async () => {
		// Empty vector results + empty lexical → the semantic arm RAN (degraded false) even
		// though no hit surfaced. "Ran and missed" is not a degrade.
		const { storage } = semanticStorage({ vector: {}, hydrate: {}, lexical: {} });

		const result = await recallMemories(
			{ query: "nothing matches", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(result.degraded).toBe(false);
		expect(result.hits).toEqual([]);
	});

	it("merges semantic hits AHEAD of lexical hits, deduped by source+id", async () => {
		// The same memory id is surfaced by BOTH the semantic and lexical arms; it appears ONCE.
		const { storage } = semanticStorage({
			vector: { memories: [{ id: "dup-mem", score: 0.9 }] },
			hydrate: { memories: [{ source: "memories", id: "dup-mem", text: "shared fact" }] },
			lexical: {
				memories: ok([{ source: "memories", id: "dup-mem", text: "shared fact" }], 0),
				memory: ok([], 0),
				sessions: ok([{ source: "sessions", id: "sess/9", text: "a raw turn" }], 0),
			},
		});

		const result = await recallMemories(
			{ query: "shared", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(result.degraded).toBe(false);
		// dup-mem appears exactly once; the sessions lexical hit also surfaces.
		expect(result.hits.filter((h) => h.id === "dup-mem")).toHaveLength(1);
		expect(result.hits.some((h) => h.id === "sess/9")).toBe(true);
	});
});
