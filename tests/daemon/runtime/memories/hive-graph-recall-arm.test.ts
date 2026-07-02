/**
 * PRD-013 — the `hive_graph_versions` recall arm (Nectar's file-description integration).
 *
 * The 4th guarded arm added to Honeycomb's fused recall (PRD-013a lexical + PRD-013b semantic +
 * PRD-013c graceful fallback), plus the decision-#17 `nectar_rrf_multiplier` mechanism. Every test
 * is named `013-AC-...` and traces to an acceptance criterion in the PRD-013 folder.
 *
 * Verification posture mirrors `recall.test.ts`: `recallMemories` runs against a FAKE `StorageQuery`
 * keyed off WHICH arm each per-arm statement targets (read from its `'…' AS source` tag / `FROM "…"`
 * / `<#>` operator). No live DeepLake, no creds. The multiplier read is exercised against a temp
 * `nectar.json` written per test.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	ARM_CLASS_WEIGHT,
	RRF_K,
	buildHiveGraphVersionsArmSql,
	buildMemoriesArmSql,
	kindOfSource,
	recallMemories,
} from "../../../../src/daemon/runtime/memories/recall.js";
import {
	clampNectarRrfMultiplier,
	DEFAULT_NECTAR_RRF_MULTIPLIER,
	NECTAR_CONFIG_FILE_NAME,
	NECTAR_RRF_MULTIPLIER_BOOT_EVENT,
	readNectarRrfMultiplier,
	resolveNectarRrfMultiplierAtBoot,
} from "../../../../src/daemon/runtime/memories/nectar-recall-config.js";
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

/** Which arm/statement a per-arm recall SQL targets. */
function armTag(sql: string): "vector" | "hydrate" | "memories" | "memory" | "sessions" | "hive_graph_versions" | "other" {
	if (sql.includes("<#>")) return "vector"; // the semantic `<#>` cosine match (ids+score only).
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate"; // the semantic hydration SELECT.
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	if (/'hive_graph_versions'\s+AS\s+source/i.test(sql)) return "hive_graph_versions";
	return "other"; // e.g. the rerank/dedup embedding batch-fetch (id + embedding only).
}

/** Which table a vector/hydrate statement targets, read from its `FROM "<tbl>"`. */
function tableOf(sql: string): "memories" | "sessions" | "hive_graph_versions" | "other" {
	if (/FROM\s+"memories"/i.test(sql)) return "memories";
	if (/FROM\s+"sessions"/i.test(sql)) return "sessions";
	if (/FROM\s+"hive_graph_versions"/i.test(sql)) return "hive_graph_versions";
	return "other";
}

/** A lexical-only fake storage keyed per arm (the four lexical statements). */
function lexicalStorage(perArm: {
	memories?: QueryResult;
	memory?: QueryResult;
	sessions?: QueryResult;
	hive_graph_versions?: QueryResult;
}): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const tag = armTag(sql);
			if (tag === "memories") return perArm.memories ?? ok([], 0);
			if (tag === "memory") return perArm.memory ?? ok([], 0);
			if (tag === "sessions") return perArm.sessions ?? ok([], 0);
			if (tag === "hive_graph_versions") return perArm.hive_graph_versions ?? ok([], 0);
			return ok([], 0); // vector/hydrate/rerank-fetch (embeddings off) → empty.
		},
	};
	return { storage, sqls };
}

/** A full fake storage that also answers the semantic `<#>` + hydrate statements per table. */
function semanticStorage(opts: {
	vector?: Partial<Record<"memories" | "sessions" | "hive_graph_versions", StorageRow[]>>;
	hydrate?: Partial<Record<"memories" | "sessions" | "hive_graph_versions", StorageRow[]>>;
	lexical?: {
		memories?: QueryResult;
		memory?: QueryResult;
		sessions?: QueryResult;
		hive_graph_versions?: QueryResult;
	};
}): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const tag = armTag(sql);
			const table = tableOf(sql);
			if (tag === "vector") return ok(table === "other" ? [] : (opts.vector?.[table] ?? []), 0);
			if (tag === "hydrate") return ok(table === "other" ? [] : (opts.hydrate?.[table] ?? []), 0);
			if (tag === "memories") return opts.lexical?.memories ?? ok([], 0);
			if (tag === "memory") return opts.lexical?.memory ?? ok([], 0);
			if (tag === "sessions") return opts.lexical?.sessions ?? ok([], 0);
			if (tag === "hive_graph_versions") return opts.lexical?.hive_graph_versions ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage, sqls };
}

/** A `hive_graph_versions` lexical-arm hit row (shaped as the arm SELECT projects it). */
function hiveGraphRow(id: string, text: string): StorageRow {
	return { source: "hive_graph_versions", id, text };
}
/** The "relation does not exist" rejection a fresh partition returns for an absent table. */
function relationMissing(table: string): QueryResult {
	return queryError(`relation "${table}" does not exist`);
}
/** The single-arm RRF contribution for a distilled hit at 1-based `rank`, scaled by `mult`. */
function rrfMemory(rank: number, mult = 1): number {
	return (ARM_CLASS_WEIGHT.memory * mult) / (RRF_K + rank);
}

// ── PRD-013a — the lexical arm SQL shape ─────────────────────────────────────

describe("013a — buildHiveGraphVersionsArmSql SQL shape", () => {
	it("013-AC-1: carries the latest-per-nectar MAX(seq) subquery joined on nectar+seq", () => {
		const sql = buildHiveGraphVersionsArmSql("login", 20);
		// The subquery collapses the append-only chain to the current row per nectar.
		expect(sql).toMatch(/INNER JOIN\s*\(\s*SELECT\s+nectar,\s*MAX\(seq\)\s+AS\s+max_seq/i);
		expect(sql).toMatch(/GROUP BY\s+nectar/i);
		expect(sql).toMatch(/ON\s+v\.nectar\s*=\s*latest\.nectar\s+AND\s+v\.seq\s*=\s*latest\.max_seq/i);
	});

	it("013-AC-2: filters the subquery to describe_status = 'described'", () => {
		const sql = buildHiveGraphVersionsArmSql("login", 20);
		expect(sql).toContain("describe_status = 'described'");
	});

	it("013-AC-3: guarded identifiers + sqlLike term + bare LIMIT; projects source/id/text/created_at over title/description/concepts", () => {
		const sql = buildHiveGraphVersionsArmSql("wid%get", 7);
		// Term wildcards are escaped by sqlLike — a literal `%` is not a live wildcard.
		expect(sql).toContain("ILIKE '%wid\\%get%'");
		// The four columns rowsToRankedArm reads, in the mirror shape of the other arms.
		expect(sql).toContain("'hive_graph_versions' AS source");
		expect(sql).toContain("v.nectar AS id");
		expect(sql).toContain("(v.title || v.description)::text AS text");
		expect(sql).toContain("v.described_at::text AS created_at");
		expect(sql).toContain('FROM "hive_graph_versions" v');
		// ILIKE over the three matched columns.
		expect(sql).toContain("v.title::text ILIKE");
		expect(sql).toContain("v.description::text ILIKE");
		expect(sql).toContain("v.concepts::text ILIKE");
		// Per-arm LIMIT as a bare clamped integer (no String() wrapper, no quotes).
		expect(sql).toMatch(/LIMIT 7\s*$/);
	});

	it("013-AC-4: threads the buildProjectScopeConjunct project_id segment into the latest-per-nectar subquery", () => {
		const projectClause = " AND (project_id = 'proj-A' OR project_id = '')";
		const sql = buildHiveGraphVersionsArmSql("login", 20, projectClause);
		// The scope conjunct lands INSIDE the subquery WHERE (after the described filter, before GROUP BY).
		expect(sql).toContain(`describe_status = 'described'${projectClause} GROUP BY nectar`);
	});

	it("013-AC-5: a single-quote injection in the term cannot break out of the literal", () => {
		// No underscore in the payload: sqlLike escapes `_` to `\_`, so the doubled-quote
		// property (the real injection floor) is asserted cleanly on a `_`-free string.
		const evil = "x'; DROP TABLE hivegraph; --";
		const sql = buildHiveGraphVersionsArmSql(evil, 1);
		// The injected quote is doubled by sqlLike, so it never closes the literal.
		expect(sql).toContain("x''; DROP TABLE hivegraph; --");
		// And no second live statement was produced (the `;` rides INSIDE the literal).
		expect(sql).not.toMatch(/'%x';\s*DROP TABLE/i);
	});

	it("013-AC-6: a fat-fingered per-arm limit is clamped to a positive integer", () => {
		expect(buildHiveGraphVersionsArmSql("t", 0)).toMatch(/LIMIT 1\s*$/);
		expect(buildHiveGraphVersionsArmSql("t", -10)).toMatch(/LIMIT 1\s*$/);
		expect(buildHiveGraphVersionsArmSql("t", 4.9)).toMatch(/LIMIT 4\s*$/);
	});
});

// ── PRD-013a — RecallSource + readSource + weight ────────────────────────────

describe("013a — RecallSource membership + weight class", () => {
	it("013-AC-7: kindOfSource maps hive_graph_versions to the distilled `memory` class (weight 1.0)", () => {
		expect(kindOfSource("hive_graph_versions")).toBe("memory");
		expect(ARM_CLASS_WEIGHT[kindOfSource("hive_graph_versions")]).toBe(1.0);
	});

	it("013-AC-8: a hive-graph arm row surfaces tagged `hive_graph_versions` (readSource recognizes it, NOT defaulted to sessions)", async () => {
		const { storage } = lexicalStorage({
			hive_graph_versions: ok([hiveGraphRow("nectar-1", "user login entry point, validates credentials")], 1),
		});
		const result = await recallMemories({ query: "login", scope: SCOPE }, { storage });
		expect(result.hits.map((h) => h.source)).toContain("hive_graph_versions");
		const hit = result.hits.find((h) => h.id === "nectar-1")!;
		expect(hit.source).toBe("hive_graph_versions"); // NOT re-tagged "sessions".
		expect(hit.kind).toBe("memory"); // distilled class, never a raw session dump.
		expect(hit.secondary).toBe(false);
		expect(result.sources).toContain("hive_graph_versions");
	});
});

// ── PRD-013a — fusion participation ──────────────────────────────────────────

describe("013a — the hive-graph arm participates in the RRF fusion", () => {
	it("013-AC-9: a hive-graph distilled hit (weight 1.0) fuses and outranks a raw sessions dump", async () => {
		const { storage } = lexicalStorage({
			hive_graph_versions: ok([hiveGraphRow("nectar-login", "the login session lifecycle")], 1),
			sessions: ok([{ source: "sessions", id: "sess/1", text: "raw turn about login" }], 1),
		});
		const result = await recallMemories({ query: "login", scope: SCOPE }, { storage });
		// The distilled hive-graph hit (1.0/61) outranks the raw session (0.4/61).
		expect(result.hits.map((h) => h.id)).toEqual(["nectar-login", "sess/1"]);
		expect(result.hits[0]!.score).toBeCloseTo(rrfMemory(1), 10);
		expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
	});

	it("013-AC-10: a nectar hit by BOTH the lexical and the semantic hive-graph arm fuses to ONE source+nectar hit", async () => {
		const { storage } = semanticStorage({
			vector: { hive_graph_versions: [{ id: "nectar-dup", score: 0.9 }] },
			hydrate: { hive_graph_versions: [{ source: "hive_graph_versions", id: "nectar-dup", text: "shared file description" }] },
			lexical: { hive_graph_versions: ok([hiveGraphRow("nectar-dup", "shared file description")], 1) },
		});
		const result = await recallMemories(
			{ query: "session refresh", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);
		expect(result.degraded).toBe(false);
		// The same nectar surfaced by both arms collapses to one hit; its score sums both contributions.
		const dups = result.hits.filter((h) => h.id === "nectar-dup");
		expect(dups).toHaveLength(1);
		expect(dups[0]!.source).toBe("hive_graph_versions");
		expect(dups[0]!.score).toBeGreaterThan(rrfMemory(1)); // corroborated across both arms.
	});
});

// ── PRD-013b — the semantic arm over `embedding` ─────────────────────────────

describe("013b — the hive-graph semantic arm runs `<#>` over the embedding column", () => {
	it("013-AC-11: with an injected EmbedClient + 768-dim vector, the semantic arm surfaces a lexical-MISS file by cosine; degraded:false", async () => {
		const { storage, sqls } = semanticStorage({
			// The file shares NO surface token with the query — a pure lexical miss — but the
			// `<#>` semantic arm returns it by cosine over the embedding.
			vector: { hive_graph_versions: [{ id: "nectar-sem", score: 0.93 }] },
			hydrate: { hive_graph_versions: [{ source: "hive_graph_versions", id: "nectar-sem", text: "refreshes JWT claims on each request" }] },
		});
		const result = await recallMemories(
			{ query: "where is the login logic", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);
		expect(result.degraded).toBe(false);
		expect(result.hits.some((h) => h.source === "hive_graph_versions" && h.id === "nectar-sem")).toBe(true);
		// The `<#>` cosine arm was issued over the hive_graph_versions table.
		expect(sqls.some((s) => s.includes("<#>") && /FROM\s+"hive_graph_versions"/i.test(s))).toBe(true);
	});

	it("013-AC-12: a non-768 query vector short-circuits the whole semantic path → no `<#>` for the arm, lexical still answers, degraded:true", async () => {
		const wrongDim = new Array(512).fill(0.1) as number[];
		const { storage, sqls } = semanticStorage({
			lexical: { hive_graph_versions: ok([hiveGraphRow("nectar-lex", "lexical floor description")], 1) },
		});
		const result = await recallMemories(
			{ query: "login", scope: SCOPE },
			{ storage, embed: fakeEmbed(wrongDim) },
		);
		expect(result.degraded).toBe(true);
		expect(sqls.some((s) => s.includes("<#>"))).toBe(false);
		expect(result.hits.map((h) => h.id)).toEqual(["nectar-lex"]);
	});
});

// ── PRD-013c — graceful BM25-only fallback + per-arm fail-soft ────────────────

describe("013c — graceful fallback + per-arm fail-soft", () => {
	it("013-AC-13: no EmbedClient → the hive-graph lexical arm still surfaces its BM25 hit; degraded:true", async () => {
		const { storage, sqls } = lexicalStorage({
			hive_graph_versions: ok([hiveGraphRow("nectar-bm25", "clean file description names the topic")], 1),
		});
		const result = await recallMemories({ query: "topic", scope: SCOPE }, { storage });
		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["nectar-bm25"]);
		expect(sqls.some((s) => s.includes("<#>"))).toBe(false);
	});

	it("013-AC-14: the hive_graph_versions table is absent (fresh workspace) → [] for THIS arm only; the other arms still answer", async () => {
		const { storage } = lexicalStorage({
			memories: ok([{ source: "memories", id: "mem-1", text: "a fact about login" }], 1),
			memory: relationMissing("memory"),
			sessions: relationMissing("sessions"),
			hive_graph_versions: relationMissing("hive_graph_versions"),
		});
		const result = await recallMemories({ query: "login", scope: SCOPE }, { storage });
		// The missing hive-graph table degrades to empty for that arm; memories still answers.
		expect(result.hits.map((h) => h.id)).toEqual(["mem-1"]);
		expect(result.sources).toEqual(["memories"]);
		expect(result.hits.some((h) => h.source === "hive_graph_versions")).toBe(false);
	});

	it("013-AC-15: EVERY arm failing (including hive_graph_versions) → empty result, degraded, NO throw", async () => {
		const { storage } = lexicalStorage({
			memories: relationMissing("memories"),
			memory: relationMissing("memory"),
			sessions: relationMissing("sessions"),
			hive_graph_versions: relationMissing("hive_graph_versions"),
		});
		const result = await recallMemories({ query: "anything", scope: SCOPE }, { storage });
		expect(result.hits).toEqual([]);
		expect(result.sources).toEqual([]);
		expect(result.degraded).toBe(true);
	});

	it("013-AC-16: keyword mode → the hive-graph arm is lexical-only (no `<#>`), degraded:false", async () => {
		const { storage, sqls } = semanticStorage({
			vector: { hive_graph_versions: [{ id: "nectar-sem-kw", score: 0.95 }] },
			hydrate: { hive_graph_versions: [{ source: "hive_graph_versions", id: "nectar-sem-kw", text: "semantic-only" }] },
			lexical: { hive_graph_versions: ok([hiveGraphRow("nectar-lex-kw", "lexical description")], 1) },
		});
		const result = await recallMemories(
			{ query: "anything", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallMode: "keyword" },
		);
		expect(sqls.some((s) => s.includes("<#>"))).toBe(false);
		expect(result.degraded).toBe(false);
		expect(result.hits.map((h) => h.id)).toEqual(["nectar-lex-kw"]);
		expect(result.hits.some((h) => h.id === "nectar-sem-kw")).toBe(false);
	});
});

// ── PRD-013a decision #17 — the nectar_rrf_multiplier read (fail-soft + clamp) ─

describe("013a decision#17 — nectar_rrf_multiplier read is fail-soft + clamped", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nectar-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	function writeConfig(contents: string): void {
		writeFileSync(join(dir, NECTAR_CONFIG_FILE_NAME), contents, "utf8");
	}

	it("013-AC-17: clampNectarRrfMultiplier — non-numeric → default 1.0; negative → 0; over-max → 10; in-range passes", () => {
		expect(clampNectarRrfMultiplier(undefined)).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
		expect(clampNectarRrfMultiplier("0.7")).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER); // a string is non-numeric.
		expect(clampNectarRrfMultiplier(Number.NaN)).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
		expect(clampNectarRrfMultiplier(Number.POSITIVE_INFINITY)).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
		expect(clampNectarRrfMultiplier(-3)).toBe(0);
		expect(clampNectarRrfMultiplier(99)).toBe(10);
		expect(clampNectarRrfMultiplier(0.7)).toBe(0.7);
		expect(clampNectarRrfMultiplier(0)).toBe(0);
		expect(clampNectarRrfMultiplier(10)).toBe(10);
	});

	it("013-AC-18: a missing nectar.json file → default 1.0", () => {
		expect(readNectarRrfMultiplier({ dir })).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER); // no file written.
	});

	it("013-AC-19: malformed JSON → default 1.0", () => {
		writeConfig("{ this is not: json ]");
		expect(readNectarRrfMultiplier({ dir })).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
	});

	it("013-AC-20: a non-object top level / absent recall block / missing key → default 1.0", () => {
		writeConfig("42");
		expect(readNectarRrfMultiplier({ dir })).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
		writeConfig(JSON.stringify({ somethingElse: true }));
		expect(readNectarRrfMultiplier({ dir })).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
		writeConfig(JSON.stringify({ recall: {} }));
		expect(readNectarRrfMultiplier({ dir })).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
	});

	it("013-AC-21: a non-numeric key value → default 1.0", () => {
		writeConfig(JSON.stringify({ recall: { nectar_rrf_multiplier: "0.7" } }));
		expect(readNectarRrfMultiplier({ dir })).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
	});

	it("013-AC-22: a valid numeric key is read and clamped ([0,10])", () => {
		writeConfig(JSON.stringify({ recall: { nectar_rrf_multiplier: 0.7 } }));
		expect(readNectarRrfMultiplier({ dir })).toBe(0.7);
		writeConfig(JSON.stringify({ recall: { nectar_rrf_multiplier: 25 } }));
		expect(readNectarRrfMultiplier({ dir })).toBe(10); // clamped.
		writeConfig(JSON.stringify({ recall: { nectar_rrf_multiplier: -1 } }));
		expect(readNectarRrfMultiplier({ dir })).toBe(0); // clamped.
	});

	it("013-AC-23: the resolved multiplier is logged ONCE at boot when non-default, and NOT when default", () => {
		const events: { name: string; fields?: Readonly<Record<string, unknown>> }[] = [];
		const logger = { event: (name: string, fields?: Readonly<Record<string, unknown>>) => events.push({ name, fields }) };

		// Non-default → exactly one boot event carrying the resolved multiplier.
		writeConfig(JSON.stringify({ recall: { nectar_rrf_multiplier: 0.5 } }));
		const nonDefault = resolveNectarRrfMultiplierAtBoot(logger, { dir });
		expect(nonDefault).toBe(0.5);
		expect(events).toHaveLength(1);
		expect(events[0]!.name).toBe(NECTAR_RRF_MULTIPLIER_BOOT_EVENT);
		expect(events[0]!.fields).toEqual({ multiplier: 0.5 });

		// Default (missing file) → no boot event.
		events.length = 0;
		const emptyDir = mkdtempSync(join(tmpdir(), "nectar-cfg-empty-"));
		try {
			const dflt = resolveNectarRrfMultiplierAtBoot(logger, { dir: emptyDir });
			expect(dflt).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
			expect(events).toHaveLength(0);
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});
});

// ── PRD-013a decision #17 — the multiplier scales ONLY the hive-graph contribution ─

describe("013a decision#17 — the multiplier is applied per-SOURCE in the fusion", () => {
	/** Recall one hive-graph + one memories hit, at a given multiplier, returning both scores. */
	async function scoresAt(multiplier: number | undefined): Promise<{ hive: number; mem: number }> {
		const { storage } = lexicalStorage({
			memories: ok([{ source: "memories", id: "mem-1", text: "a fact about login" }], 1),
			hive_graph_versions: ok([hiveGraphRow("nectar-1", "the login file description")], 1),
		});
		const result = await recallMemories(
			{ query: "login", scope: SCOPE },
			{ storage, ...(multiplier !== undefined ? { nectarRrfMultiplier: multiplier } : {}) },
		);
		const hive = result.hits.find((h) => h.source === "hive_graph_versions")!.score;
		const mem = result.hits.find((h) => h.source === "memories")!.score;
		return { hive, mem };
	}

	it("013-AC-24: multiplier 3 triples the hive-graph contribution and leaves the memories contribution unchanged", async () => {
		const base = await scoresAt(1);
		const tripled = await scoresAt(3);
		// The hive-graph score scales by exactly the multiplier; memories is untouched.
		expect(base.hive).toBeCloseTo(rrfMemory(1, 1), 10);
		expect(tripled.hive).toBeCloseTo(rrfMemory(1, 3), 10);
		expect(tripled.hive).toBeCloseTo(base.hive * 3, 10);
		expect(tripled.mem).toBeCloseTo(base.mem, 10); // memories contribution is multiplier-invariant.
		expect(base.mem).toBeCloseTo(rrfMemory(1, 1), 10);
	});

	it("013-AC-25: an ABSENT deps.nectarRrfMultiplier defaults to 1.0 (byte-identical to the other arms)", async () => {
		const dflt = await scoresAt(undefined);
		expect(dflt.hive).toBeCloseTo(rrfMemory(1, 1), 10);
		expect(dflt.hive).toBeCloseTo(dflt.mem, 10);
	});

	it("013-AC-26: multiplier 0 zeroes the hive-graph contribution (clamped, never inverts) and it ranks below memories", async () => {
		const { storage } = lexicalStorage({
			memories: ok([{ source: "memories", id: "mem-1", text: "login fact" }], 1),
			hive_graph_versions: ok([hiveGraphRow("nectar-1", "login file description")], 1),
		});
		const result = await recallMemories(
			{ query: "login", scope: SCOPE },
			{ storage, nectarRrfMultiplier: 0 },
		);
		const hive = result.hits.find((h) => h.source === "hive_graph_versions")!;
		expect(hive.score).toBe(0);
		// With a zero contribution the hive-graph hit ranks beneath the memories hit.
		expect(result.hits[result.hits.length - 1]!.source).toBe("hive_graph_versions");
	});
});
