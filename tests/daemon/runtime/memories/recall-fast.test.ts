/**
 * PRD-077a — the single-round-trip FAST recall (`recallFast`) suite (L-A1..A7, L-A9).
 *
 * Verification posture (mirrors `recall.test.ts` / `recall-concurrency.test.ts`):
 *   - `recallFast` is driven against a FAKE `StorageQuery` keyed off WHICH arm each
 *     per-arm SQL targets (its `<#>` + `'…' AS source` fingerprint). No live DeepLake.
 *   - The fast path runs the SAME 7 arms as the heavy engine — 3 content-inline semantic
 *     (`memories`/`sessions`/`hive_graph_versions`) + 4 lexical (`memories`/`memory`/
 *     `sessions`/`hive_graph_versions`) — issued CONCURRENTLY in one `Promise.all`, fused
 *     with the EXISTING `fuseHits` RRF + recency, and SKIPS the hydrate hop, the dedup
 *     embedding fetch, the rerank, and every lifecycle source.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	buildFastSemanticArmSql,
	recallFast,
	recallMemories,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";
import { EMBEDDING_DIMS, serializeFloat4Array } from "../../../../src/daemon/storage/vector.js";
import { buildProjectScopeConjunct } from "../../../../src/daemon/runtime/recall/scope-clause.js";
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

/** An EmbedClient that throws — proves recallFast guards an unexpected embed throw (→ lexical). */
function throwingEmbed(): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			throw new Error("embed daemon exploded");
		},
	};
}

/** The distinct arm-kinds a recall statement can be, read from its SQL fingerprint. */
type ArmKind = "fastSemantic" | "vectorIds" | "hydrate" | "embedFetch" | "confidence" | "lexical";

/** Classify a statement by shape: the fast path issues ONLY `fastSemantic` + `lexical`. */
function kindOf(sql: string): ArmKind {
	if (/\bAS\s+embedding\b/i.test(sql)) return "embedFetch"; // rerank/dedup candidate fetch
	if (/\bAS\s+confidence\b/i.test(sql)) return "confidence"; // calibration fetch
	const hasVector = /<#>/.test(sql);
	const hasText = /\bAS\s+text\b/i.test(sql);
	if (hasVector && hasText) return "fastSemantic"; // content-inline `<#>` arm
	if (hasVector) return "vectorIds"; // heavy two-hop: ids + score only
	if (/\bIN\s*\(/i.test(sql) && hasText) return "hydrate"; // heavy two-hop: hydrate the ids' text
	return "lexical";
}

/** The `'<x>' AS source` literal an arm carries (fast-semantic / hydrate / lexical). */
function sourceLitOf(sql: string): string {
	const m = sql.match(/'(memories|memory|sessions|hive_graph_versions)'\s+AS\s+source/i);
	return m ? m[1]!.toLowerCase() : "";
}

/** The `FROM "<tbl>"` table an ids-only vector search targets. */
function tableOf(sql: string): string {
	const m = sql.match(/FROM\s+"([a-z_]+)"/i);
	return m ? m[1]!.toLowerCase() : "";
}

function memoriesRow(id: string, text: string, createdAt = ""): StorageRow {
	return { source: "memories", id, text, created_at: createdAt };
}
function sessionsRow(id: string, text: string, createdAt = ""): StorageRow {
	return { source: "sessions", id, text, created_at: createdAt };
}
/** A fast-semantic arm row (carries the extra `score` column; `rowsToRankedArm` ignores it). */
function semRow(source: string, id: string, text: string, score: number, createdAt = ""): StorageRow {
	return { source, id, text, created_at: createdAt, score };
}

/** The "relation does not exist" rejection a fresh partition returns for an absent table. */
function relationMissing(table: string): QueryResult {
	return queryError(`relation "${table}" does not exist`);
}

// ── L-A1 (a-AC-1): parallel, content-inline, one round-trip per arm ──────────────

describe("L-A1 (a-AC-1): recallFast issues the arms in PARALLEL, one round-trip each, no hydrate/dedup", () => {
	it("fires exactly 7 arms concurrently (peak in-flight == 7) with NO hydrate/dedup/confidence call", async () => {
		let inFlight = 0;
		let peak = 0;
		let released = false;
		const gates: Array<() => void> = [];
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string, _scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
				seen.push(sql);
				void opts;
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				if (!released) await new Promise<void>((resolve) => gates.push(resolve));
				inFlight -= 1;
				const kind = kindOf(sql);
				if (kind === "fastSemantic") return ok([semRow(sourceLitOf(sql), "sem-1", "a semantic hit", 0.9)], 1);
				return ok([], 0);
			},
		};

		// A wide pool so all 7 arms can be in flight at once (Wave 2 will size the real fast lane).
		const run = recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: new Semaphore(16) },
		);
		// Let the parked arms accumulate, then release them and finish. Pump enough microtask turns for
		// the arms to reach the (still-parked, `released=false`) storage stub: PRD-077 (L-B9) BOUNDS the
		// pre-arm embed via `Promise.race`, which adds a few microtask hops before the arms fire — so this
		// drains a generous fixed number of turns (mirrors the sibling `recall-hot-lane` 12-turn pump)
		// rather than the pre-077 exact-2. The assertion (all 7 parked at once) is unchanged.
		for (let i = 0; i < 12; i++) await Promise.resolve();
		expect(gates.length).toBe(7); // all 7 parked BEFORE any resolved → they ran concurrently.
		released = true;
		while (gates.length > 0) gates.shift()?.();
		await run;

		// Round-trip count == arm count: exactly 7 statements, 3 semantic + 4 lexical, nothing else.
		expect(seen).toHaveLength(7);
		expect(peak).toBe(7);
		const kinds = seen.map(kindOf);
		expect(kinds.filter((k) => k === "fastSemantic")).toHaveLength(3);
		expect(kinds.filter((k) => k === "lexical")).toHaveLength(4);
		// NO second hop (hydrate), NO dedup/rerank embedding fetch, NO calibration fetch.
		expect(kinds).not.toContain("hydrate");
		expect(kinds).not.toContain("vectorIds");
		expect(kinds).not.toContain("embedFetch");
		expect(kinds).not.toContain("confidence");
	});
});

// ── L-A2 (a-AC-2): content::text inline + the 049b project segment on every arm ──

describe("L-A2 (a-AC-2): semantic arms SELECT content inline; every arm carries the project segment", () => {
	it("the memories semantic SQL SELECTs content::text (not ids-only) and every arm carries the 049b segment", async () => {
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return ok([], 0);
			},
		};
		await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(seen).toHaveLength(7);
		const memoriesSemantic = seen.find((s) => kindOf(s) === "fastSemantic" && sourceLitOf(s) === "memories")!;
		// Content-inline: the semantic arm SELECTs the text column, NOT ids-only. Column identifiers
		// are the bare sqlIdent-validated names (like the lexical arms' `${contentCol}::text`).
		expect(memoriesSemantic).toMatch(/\bcontent::text\s+AS\s+text/i);
		expect(memoriesSemantic).toMatch(/\bcreated_at::text\s+AS\s+created_at/i);
		expect(memoriesSemantic).toMatch(/<#>/); // still the `<#>` cosine match, single statement.
		// It is NOT the heavy ids-only vector-search shape (`SELECT id AS id, … AS score` with no text).
		expect(kindOf(memoriesSemantic)).toBe("fastSemantic");

		// The EXACT 049b project segment is ANDed into EVERY arm (all 7).
		const expectedSegment = buildProjectScopeConjunct({ projectId: "proj-A", bound: true });
		for (const sql of seen) {
			expect(sql, `arm missing the project segment: ${sql}`).toContain(expectedSegment);
		}
	});
});

// ── L-A3 (a-AC-3): RRF + recency + breadth parity vs the heavy path (refinements off) ──

/**
 * A fake storage that serves BOTH the fast path's content-inline arms AND the heavy path's
 * two-hop semantic (vector-ids → hydrate) + lexical arms from ONE row source, so the two
 * engines see identical arm data. Dedup/rerank/lifecycle are disabled on the heavy side, so
 * both reduce to `fuseHits` + recency over the same arms.
 */
function parityStorage(): StorageQuery {
	// Per-source semantic ids (score-desc order) and the row text/created_at they hydrate to.
	const semanticIds: Record<string, string[]> = {
		memories: ["m1", "m2"],
		sessions: ["s1"],
		hive_graph_versions: [],
	};
	const text: Record<string, string> = { m1: "kept fact one", m2: "kept fact two", s1: "a raw turn" };
	// m2 is ancient so recency demotes it; m1/s1 are fresh — proves the recency stage participates.
	const createdAt: Record<string, string> = {
		m1: "2026-07-08T00:00:00.000Z",
		m2: "2000-01-01T00:00:00.000Z",
		s1: "2026-07-08T00:00:00.000Z",
	};
	const lexical: Record<string, StorageRow[]> = {
		memories: [memoriesRow("m1", text.m1!, createdAt.m1!)],
		memory: [],
		sessions: [sessionsRow("s1", text.s1!, createdAt.s1!)],
		hive_graph_versions: [],
	};
	return {
		async query(sql: string): Promise<QueryResult> {
			const kind = kindOf(sql);
			if (kind === "fastSemantic") {
				const src = sourceLitOf(sql);
				const rows = (semanticIds[src] ?? []).map((id, i) => semRow(src, id, text[id] ?? "", 0.9 - i * 0.1, createdAt[id] ?? ""));
				return ok(rows, rows.length);
			}
			if (kind === "vectorIds") {
				const tbl = tableOf(sql);
				const rows = (semanticIds[tbl] ?? []).map((id, i) => ({ id, score: 0.9 - i * 0.1 }) as StorageRow);
				return ok(rows, rows.length);
			}
			if (kind === "hydrate") {
				const src = sourceLitOf(sql);
				const rows = (semanticIds[src] ?? []).map((id) => ({ source: src, id, text: text[id] ?? "", created_at: createdAt[id] ?? "" }) as StorageRow);
				return ok(rows, rows.length);
			}
			if (kind === "lexical") {
				return ok(lexical[sourceLitOf(sql)] ?? [], 1);
			}
			// embedFetch / confidence must not be requested in this parity config (dedup/rerank off).
			return ok([], 0);
		},
	};
}

describe("L-A3 (a-AC-3): fast top-k == heavy with dedup/rerank/lifecycle disabled (same arms, fuseHits, recency)", () => {
	it("the fast path's hits equal the heavy path's over the same fixture", async () => {
		const now = () => Date.parse("2026-07-09T00:00:00.000Z");
		const fast = await recallFast(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{ storage: parityStorage(), embed: fakeEmbed(VALID_QUERY_VECTOR), now },
		);
		const heavy = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{
				storage: parityStorage(),
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				now,
				// Disable exactly the refinements the fast path drops → both reduce to fuse + recency.
				reranker: { strategy: "none", timeoutMs: 1, providerTimeoutMs: 1, window: 10, cohereModel: "x" },
				dedup: { enabled: false, similarityThreshold: 0.9 },
			},
		);

		// Same breadth (both surfaced the memories + sessions arms), same fused+recency order, same scores.
		expect(fast.sources).toEqual(heavy.sources);
		expect(fast.hits).toEqual(heavy.hits);
		// And recency genuinely participated: the ancient m2 is demoted below the fresh s1 (a raw session).
		const order = fast.hits.map((h) => h.id);
		expect(order.indexOf("m2")).toBeGreaterThan(order.indexOf("s1"));
	});
});

// ── L-A4 (a-AC-8): no dedup / rerank / lifecycle seam is touched on the fast path ──

describe("L-A4 (a-AC-8): recallFast calls NO dedup, rerank, or lifecycle source", () => {
	it("none of fetchCandidateEmbeddings / rerank / activation / staleness / conflict / calibration fire", async () => {
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				if (kindOf(sql) === "fastSemantic") return ok([semRow(sourceLitOf(sql), "x", "hit", 0.9)], 1);
				return ok([], 0);
			},
		};
		const cohereRerank = { rerank: vi.fn(async () => ({ ok: false as const })) };
		const activationSource = { load: vi.fn(async () => new Map()) };
		const stalenessSource = { load: vi.fn(async () => new Map()) };
		const conflictSuppression = { loadSuppressed: vi.fn(async () => new Set<string>()) };
		const recordRecallAccess = vi.fn(async () => {});

		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{
				storage,
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				// Even fully wired, these seams must be untouched on the fast path.
				reranker: { strategy: "cohere", timeoutMs: 1, providerTimeoutMs: 1, window: 10, cohereModel: "x" },
				dedup: { enabled: true, similarityThreshold: 0.9 },
				cohereRerank,
				activationSource,
				stalenessSource,
				conflictSuppression,
				recordRecallAccess,
			},
		);

		expect(cohereRerank.rerank).not.toHaveBeenCalled();
		expect(activationSource.load).not.toHaveBeenCalled();
		expect(stalenessSource.load).not.toHaveBeenCalled();
		expect(conflictSuppression.loadSuppressed).not.toHaveBeenCalled();
		expect(recordRecallAccess).not.toHaveBeenCalled();
		// And no dedup/rerank candidate-embedding fetch or calibration fetch was issued.
		expect(seen.map(kindOf)).not.toContain("embedFetch");
		expect(seen.map(kindOf)).not.toContain("confidence");
		// The recall still answered with the semantic hits (the seams being off did not empty it).
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.degraded).toBe(false);
	});
});

// ── L-A5 (a-AC-4): embed-unavailable degrade (semantic dropped, lexical alone) ──

describe("L-A5 (a-AC-4): a null / throwing embed drops the semantic arms and runs lexical alone (degraded)", () => {
	it("null embed → only the 4 lexical arms run, degraded:true, no throw", async () => {
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return kindOf(sql) === "lexical" && sourceLitOf(sql) === "memories"
					? ok([memoriesRow("m1", "a widget fact")], 1)
					: ok([], 0);
			},
		};
		const result = await recallFast({ query: "widgets", scope: SCOPE }, { storage, embed: fakeEmbed(null) });

		expect(seen).toHaveLength(4); // ONLY the lexical arms — no `<#>` statement issued.
		expect(seen.map(kindOf).every((k) => k === "lexical")).toBe(true);
		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
	});

	it("a throwing embed also degrades to lexical-only, never throws", async () => {
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return ok([], 0);
			},
		};
		const result = await recallFast({ query: "widgets", scope: SCOPE }, { storage, embed: throwingEmbed() });
		expect(seen).toHaveLength(4);
		expect(result.degraded).toBe(true);
		expect(result.hits).toEqual([]);
	});

	it("a wrong-dim embed (defense in depth) also drops the semantic arms", async () => {
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return ok([], 0);
			},
		};
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(new Array(512).fill(0.1) as number[]) },
		);
		expect(seen).toHaveLength(4);
		expect(result.degraded).toBe(true);
	});
});

// ── L-A6 (a-AC-9): a starved sibling arm is harmless; a populated arm fuses ──

describe("L-A6 (a-AC-9): a 0-row / missing sibling arm degrades to empty-for-that-arm, recall still succeeds", () => {
	it("missing memory + hive_graph siblings do not fail the recall; the memories + sessions arms flow into fusion", async () => {
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				const src = sourceLitOf(sql);
				if (kindOf(sql) !== "lexical") return ok([], 0);
				if (src === "memories") return ok([memoriesRow("m1", "a widget fact")], 1);
				if (src === "sessions") return ok([sessionsRow("sess/1", "a raw widget turn")], 1);
				if (src === "memory") return relationMissing("memory"); // starved / absent sibling
				return relationMissing("hive_graph_versions"); // starved / absent sibling
			},
		};
		// Lexical-only (no embed) so this focuses on the sibling-arm tolerance.
		const result = await recallFast({ query: "widgets", scope: SCOPE, limit: 10 }, { storage });

		// The missing siblings degraded to [] for their arm; the populated arms still fused.
		expect(result.hits.map((h) => h.id)).toEqual(["m1", "sess/1"]);
		expect(result.sources).toEqual(["memories", "sessions"]);
		expect(result.degraded).toBe(true);
	});
});

// ── L-A7 (a-AC-5): every identifier/term/vector/project routes through the guards ──

describe("L-A7 (a-AC-5): buildFastSemanticArmSql routes identifiers/vector/source/project through the guards", () => {
	it("the vector rides serializeFloat4Array, the source is sLiteral-quoted, the table is sqlIdent-quoted, the project segment is buildProjectScopeConjunct", () => {
		const spec = {
			source: "memories",
			table: "memories",
			idColumn: "id",
			embeddingColumn: "content_embedding",
			textColumn: "content",
			timestampColumn: "created_at",
			hydrateFilter: `AND "is_deleted" = 0`,
		} as const;
		const projectClause = buildProjectScopeConjunct({ projectId: "proj-A", bound: true });
		const sql = buildFastSemanticArmSql(spec, VALID_QUERY_VECTOR, 5, projectClause);

		// The 768-float query vector rides the SAME serializeFloat4Array numeric fragment (no hand-quoting).
		expect(sql).toContain(serializeFloat4Array(VALID_QUERY_VECTOR));
		expect(sql).toContain("::float4[]");
		// The table rides `FROM "<sqlIdent>"`; the source is an sLiteral; column identifiers are the
		// bare sqlIdent-validated names; the project segment is the verbatim buildProjectScopeConjunct.
		expect(sql).toContain('FROM "memories"');
		expect(sql).toContain(`'memories' AS source`);
		expect(sql).toContain(`content::text AS text`);
		expect(sql).toContain(projectClause);
		// The null-embedding guard + score normalization are the `buildVectorSearchSql` shape.
		expect(sql).toMatch(/ARRAY_LENGTH\(content_embedding,\s*1\)\s*>\s*0/i);
		expect(sql).toContain(`((1 + (content_embedding <#>`);
	});
});

// ── L-A9 (a-AC-7): the heavy recallMemories path is UNCHANGED (two-hop + dedup fire) ──

describe("L-A9 (a-AC-7): the heavy recallMemories path still runs the two-hop semantic + dedup", () => {
	it("the heavy path issues a hydrate (IN-list) query AND a dedup embedding fetch — the fast path is additive", async () => {
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				const kind = kindOf(sql);
				if (kind === "vectorIds") {
					// The memories vector arm returns 2 ids so a dedup pass has ≥2 candidates to fetch for.
					return tableOf(sql) === "memories" ? ok([{ id: "m1", score: 0.9 }, { id: "m2", score: 0.8 }] as StorageRow[], 2) : ok([], 0);
				}
				if (kind === "hydrate") {
					return ok([
						{ source: "memories", id: "m1", text: "fact one", created_at: "" },
						{ source: "memories", id: "m2", text: "fact two", created_at: "" },
					] as StorageRow[], 2);
				}
				if (kind === "embedFetch") {
					return ok([
						{ id: "m1", embedding: new Array(EMBEDDING_DIMS).fill(0.1) },
						{ id: "m2", embedding: new Array(EMBEDDING_DIMS).fill(0.2) },
					] as StorageRow[], 2);
				}
				return ok([], 0);
			},
		};
		// Heavy path with DEFAULTS: two-hop semantic + default-ON dedup (the byte-for-byte dashboard path).
		const result = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		const kinds = seen.map(kindOf);
		expect(kinds, "the heavy path hydrates the semantic ids (second hop)").toContain("hydrate");
		expect(kinds, "the heavy path runs the dedup candidate-embedding fetch").toContain("embedFetch");
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.degraded).toBe(false);
	});
});
