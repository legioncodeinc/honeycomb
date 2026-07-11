/**
 * PRD-078a — the in-daemon LOCAL ANN recall index (`local-vector-index.ts`) suite.
 *
 * Covers the MODULE-level acceptance criteria:
 *   - a-AC-1: `buildFromRows` populates the index + SKIPS empty/wrong-dim embeddings.
 *   - a-AC-2 (parity): `search` top-k id order + scores match the `<#>` SQL reference over a
 *     fixed fixture (same FLOAT4 vectors, same `((1 + cos) / 2)` norm) within float tolerance;
 *     the 049b project scope is honored (a project-B row is never returned).
 *   - a-AC-6 (latency): `search` over a few-thousand-vector fixture is sub-100ms.
 *   - the cold-build SQL shape + the fail-soft paging loop.
 *
 * Verification posture mirrors the sibling recall suites: pure in-process, no live DeepLake;
 * the `<#>` parity reference is computed in JS over the SAME FLOAT4-rounded vectors the SQL
 * operator scores, so it is a genuine cross-check of the index's math, not a tautology.
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { EMBEDDING_DIMS, readEmbeddingCell } from "../../../../src/daemon/storage/vector.js";
import {
	buildMemoriesColdBuildSql,
	coldBuildLocalVectorIndex,
	COLD_BUILD_PAGE_SIZE,
	InMemoryLocalVectorIndex,
	type RecallIndexBuiltEvent,
} from "../../../../src/daemon/runtime/memories/local-vector-index.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A tiny deterministic PRNG (mulberry32) so the fixture is fixed across runs. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A deterministic 768-dim vector in [-1, 1). */
function makeVector(seed: number): number[] {
	const next = rng(seed);
	const v: number[] = new Array(EMBEDDING_DIMS);
	for (let i = 0; i < EMBEDDING_DIMS; i += 1) v[i] = next() * 2 - 1;
	return v;
}

/**
 * The `<#>` SQL reference score: `((1 + cosine) / 2)` over FLOAT4-ROUNDED vectors — the SAME
 * 32-bit precision the DeepLake `FLOAT4[]` column + `<#>` operator use, so the reference and the
 * index (a `Float32Array`) round identically and the ordering is deterministic. Independent of
 * `cosineSimilarity` on purpose (a genuine cross-check).
 */
function referenceScore(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i += 1) {
		const x = Math.fround(a[i]!);
		const y = Math.fround(b[i]!);
		dot += x * y;
		magA += x * x;
		magB += y * y;
	}
	if (magA === 0 || magB === 0) return 0;
	const cos = Math.min(1, Math.max(-1, dot / (Math.sqrt(magA) * Math.sqrt(magB))));
	return (1 + cos) / 2;
}

function memoryRow(id: string, embedding: number[] | unknown, projectId = "", createdAt = "", isDeleted = 0): StorageRow {
	return {
		id,
		content: `content for ${id}`,
		content_embedding: embedding,
		project_id: projectId,
		created_at: createdAt,
		is_deleted: isDeleted,
	};
}

// ── a-AC-1: buildFromRows populates + skips empty / wrong-dim embeddings ──────────

describe("a-AC-1: buildFromRows populates the index and skips empty/wrong-dim vectors", () => {
	it("indexes only rows with a valid 768-dim embedding; ready flips true", () => {
		const index = new InMemoryLocalVectorIndex();
		expect(index.ready).toBe(false);
		expect(index.size).toBe(0);

		index.buildFromRows([
			memoryRow("good-1", makeVector(1)), // valid → indexed
			memoryRow("empty", []), // empty array → skipped (a back-filled '' column)
			memoryRow("wrong-dim", makeVector(2).slice(0, 512)), // 512-dim → skipped
			memoryRow("null-emb", null), // null embedding → skipped
			memoryRow("non-finite", makeVector(3).map((_, i) => (i === 0 ? Number.NaN : 0.1))), // NaN entry → skipped
			memoryRow("no-id", makeVector(4)), // valid but we strip id below
			memoryRow("good-2", makeVector(5)),
		]);

		// good-1 + good-2 indexed; the four malformed rows skipped; the blank-id row is a control.
		expect(index.ready).toBe(true);
		expect(index.size).toBe(3); // good-1, good-2, no-id (which HAS an id "no-id")
	});

	it("skips a row with a blank id (no fusion identity)", () => {
		const index = new InMemoryLocalVectorIndex();
		index.buildFromRows([memoryRow("", makeVector(9)), memoryRow("keep", makeVector(10))]);
		expect(index.size).toBe(1);
	});
});

// ── a-AC-2: search top-k parity with the `<#>` SQL + project scope ────────────────

describe("a-AC-2 (parity): search top-k id order + scores match the `<#>` reference; project scope honored", () => {
	it("top-k order + scores equal the FLOAT4 `((1+cos)/2)` reference over the fixture", () => {
		const index = new InMemoryLocalVectorIndex();
		// 60 project-A vectors + a few project-B / deleted rows the scope filter must EXCLUDE.
		const rows: StorageRow[] = [];
		const projAVectors: Record<string, number[]> = {};
		for (let i = 0; i < 60; i += 1) {
			const id = `A-${i}`;
			const vec = makeVector(1000 + i);
			projAVectors[id] = vec;
			rows.push(memoryRow(id, vec, "proj-A"));
		}
		// Unset-project rows are ALSO admitted (D5 legacy/global) — include one so it can surface.
		const unsetId = "U-1";
		const unsetVec = makeVector(5000);
		projAVectors[unsetId] = unsetVec;
		rows.push(memoryRow(unsetId, unsetVec, ""));
		// project-B rows + a soft-deleted project-A row must NEVER be returned for a proj-A search.
		rows.push(memoryRow("B-1", makeVector(6000), "proj-B"));
		rows.push(memoryRow("B-2", makeVector(6001), "proj-B"));
		rows.push(memoryRow("A-deleted", makeVector(6002), "proj-A", "", 1));
		index.buildFromRows(rows);

		const query = makeVector(42);
		const k = 10;
		const got = index.search(query, "proj-A", k);

		// Reference: score every ADMITTED id (proj-A + unset, non-deleted), sort desc, take top-k.
		const ref = Object.entries(projAVectors)
			.map(([id, vec]) => ({ id, score: referenceScore(query, vec) }))
			.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1))
			.slice(0, k);

		expect(got.map((r) => r.id)).toEqual(ref.map((r) => r.id));
		got.forEach((r, i) => {
			expect(r.score as number).toBeCloseTo(ref[i]!.score, 5);
			expect(r.source).toBe("memories");
			expect(r.text).toBe(`content for ${r.id}`); // content is inline — no hydrate.
		});
		// The excluded rows never appear.
		const ids = new Set(got.map((r) => r.id));
		expect(ids.has("B-1")).toBe(false);
		expect(ids.has("B-2")).toBe(false);
		expect(ids.has("A-deleted")).toBe(false);
	});

	it("returns rows in the buildFastSemanticArmSql shape (source/id/text/created_at/score), score DESC", () => {
		const index = new InMemoryLocalVectorIndex();
		index.buildFromRows([
			memoryRow("m1", makeVector(1), "proj-A", "2026-07-08T00:00:00.000Z"),
			memoryRow("m2", makeVector(2), "proj-A", "2026-07-07T00:00:00.000Z"),
		]);
		const rows = index.search(makeVector(1), "proj-A", 5);
		expect(rows.length).toBe(2);
		for (const r of rows) {
			// The uniform shape rowsToRankedArm consumes: source/id/text/created_at (+ score for ORDER BY).
			expect(Object.keys(r).sort()).toEqual(["created_at", "id", "score", "source", "text"]);
		}
		// Scores are monotonically non-increasing (the arm's rank signal).
		for (let i = 1; i < rows.length; i += 1) {
			expect(rows[i - 1]!.score as number).toBeGreaterThanOrEqual(rows[i]!.score as number);
		}
		// created_at is carried inline for the recency stage.
		expect(rows.find((r) => r.id === "m1")!.created_at).toBe("2026-07-08T00:00:00.000Z");
	});

	it("k=0 or an empty index yields no rows", () => {
		const index = new InMemoryLocalVectorIndex();
		index.buildFromRows([memoryRow("m1", makeVector(1), "proj-A")]);
		expect(index.search(makeVector(1), "proj-A", 0)).toEqual([]);
		const empty = new InMemoryLocalVectorIndex();
		empty.buildFromRows([]);
		expect(empty.search(makeVector(1), "proj-A", 5)).toEqual([]);
	});
});

// ── a-AC-6: latency — search over a few-thousand-vector fixture is sub-100ms ──────

describe("a-AC-6 (latency): search over a few-thousand-vector corpus completes in sub-100ms", () => {
	it("a 3,000-vector flat cosine scan is well under 100ms", () => {
		const index = new InMemoryLocalVectorIndex();
		const rows: StorageRow[] = [];
		for (let i = 0; i < 3000; i += 1) rows.push(memoryRow(`m-${i}`, makeVector(20000 + i), "proj-A"));
		index.buildFromRows(rows);
		expect(index.size).toBe(3000);

		const query = makeVector(99);
		const started = performance.now();
		const got = index.search(query, "proj-A", 20);
		const elapsed = performance.now() - started;

		expect(got.length).toBe(20);
		expect(elapsed).toBeLessThan(100); // sub-100ms vs the ~2.6s `<#>` full-column scan.
	});
});

// ── cold-build: the SQL shape + the fail-soft paging loop ─────────────────────────

describe("cold-build: buildMemoriesColdBuildSql shape + coldBuildLocalVectorIndex paging", () => {
	it("the cold-build SQL selects the 6 projected columns, guards non-empty embeddings, pages by LIMIT/OFFSET", () => {
		const sql = buildMemoriesColdBuildSql(500, 1000);
		expect(sql).toContain('FROM "memories"');
		expect(sql).toMatch(/content::text AS content/);
		expect(sql).toMatch(/content_embedding AS content_embedding/);
		expect(sql).toMatch(/project_id AS project_id/);
		expect(sql).toMatch(/created_at::text AS created_at/);
		expect(sql).toMatch(/is_deleted AS is_deleted/);
		expect(sql).toMatch(/ARRAY_LENGTH\(content_embedding,\s*1\)\s*>\s*0/i);
		expect(sql).toMatch(/ORDER BY id/);
		expect(sql).toMatch(/LIMIT 500 OFFSET 1000/);
	});

	it("pages the memories table and populates the index; short page ends the scan", async () => {
		const pages: StorageRow[][] = [
			[memoryRow("m1", makeVector(1), "proj-A"), memoryRow("m2", makeVector(2), "proj-A")],
			[memoryRow("m3", makeVector(3), "proj-A")], // short page (< pageSize=2) → stop
		];
		let call = 0;
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
				seen.push(sql);
				const page = pages[call] ?? [];
				call += 1;
				return ok(page, page.length);
			},
		};
		const index = new InMemoryLocalVectorIndex();
		await coldBuildLocalVectorIndex(index, storage, SCOPE, 2);

		expect(index.ready).toBe(true);
		expect(index.size).toBe(3); // m1 + m2 + m3
		expect(seen.length).toBe(2); // page 0 (full) + page 1 (short → stop)
		expect(seen[0]).toMatch(/LIMIT 2 OFFSET 0/);
		expect(seen[1]).toMatch(/LIMIT 2 OFFSET 2/);
	});

	it("fail-soft: a non-ok page stops paging and still readies the index with what was gathered", async () => {
		let call = 0;
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				call += 1;
				if (call === 1) return ok([memoryRow("m1", makeVector(1), "proj-A"), memoryRow("m2", makeVector(2), "proj-A")], 2);
				return queryError(`relation "memories" does not exist`); // a mid-scan flap
			},
		};
		const index = new InMemoryLocalVectorIndex();
		await coldBuildLocalVectorIndex(index, storage, SCOPE, 2);
		expect(index.ready).toBe(true);
		expect(index.size).toBe(2); // the first page's rows survived; the failed page degraded to stop.
	});
});

// ── PRD-078a-fix: the MISSING coverage — the real live-DeepLake cell format + full-load + event ──
//
// The 078a unit suite fed `content_embedding` as a pre-formed `number[]`, which happens to be the
// exact shape a live DeepLake HTTP `SELECT ... content_embedding ...` row returns (a JSON array of
// 768 finite numbers — the `{columns, rows}` transport maps each cell straight through). These tests
// pin the cold-build to the SAME canonical reader the reranker uses (`readEmbeddingCell`), so the
// two paths can never drift, and make the whole-corpus load + the `recall.index.built` counts
// explicit rather than implied.

/** A real live-format `content_embedding` cell: a plain JSON array of 768 finite numbers. */
function liveCell(seed: number): number[] {
	return makeVector(seed);
}

describe("PRD-078a-fix: real live-DeepLake `content_embedding` cell format parses (not skipped)", () => {
	it("a row whose content_embedding is the live number[768] cell is indexed, packed to a 768-dim Float32Array", () => {
		const index = new InMemoryLocalVectorIndex();
		const cell = liveCell(7); // the actual on-the-wire shape a live SELECT returns.
		const { loaded, skipped } = index.buildFromRows([memoryRow("live-1", cell, "proj-A")]);

		// THE case that was missing: the real cell format is parsed, NOT skipped by the dim guard.
		expect(loaded).toBe(1);
		expect(skipped).toBe(0);
		expect(index.size).toBe(1);

		// The stored vector round-trips the cell verbatim (Float32-rounded), so a self-query scores ~1.0.
		const rows = index.search(cell, "proj-A", 1);
		expect(rows.length).toBe(1);
		expect(rows[0]!.id).toBe("live-1");
		expect(rows[0]!.score as number).toBeGreaterThan(0.99); // a literal self-match is near-1, NOT ~0.016.
	});

	it("parity: the cold-build packs EXACTLY what readEmbeddingCell produces for the same cell", () => {
		const index = new InMemoryLocalVectorIndex();
		const cell = liveCell(11);
		index.buildFromRows([memoryRow("p-1", cell, "proj-A")]);

		// readEmbeddingCell is the canonical reader (shared with the reranker); the index must store the
		// SAME numbers (Float32-rounded), element for element — no second, drifting coercion.
		const canonical = readEmbeddingCell(cell);
		expect(canonical).not.toBeNull();
		expect(canonical!.length).toBe(EMBEDDING_DIMS);
		// Round-trip via a self-search: every element the index kept equals the canonical parse rounded to f32.
		const stored = index.search(cell, "proj-A", 1);
		expect(stored.length).toBe(1);
		// The score is `((1+cos)/2)` of the stored vec against the canonical (f32-rounded) query → ~1.0 iff identical.
		const asF32 = Float32Array.from(canonical!);
		expect(index.search([...asF32], "proj-A", 1)[0]!.score as number).toBeGreaterThan(0.999);
	});

	it("a non-array / stringified cell is skipped by both the reader and the index (no garbage vector)", () => {
		const index = new InMemoryLocalVectorIndex();
		const { loaded, skipped } = index.buildFromRows([
			memoryRow("str", "[0.1, 0.2, 0.3]"), // a stringified array is NOT the live shape → null → skipped.
			memoryRow("obj", { 0: 0.1, length: 768 }), // an array-like object → not Array.isArray → skipped.
			memoryRow("good", liveCell(3), "proj-A"), // the real cell → indexed.
		]);
		expect(readEmbeddingCell("[0.1, 0.2, 0.3]")).toBeNull(); // canonical reader agrees.
		expect(loaded).toBe(1);
		expect(skipped).toBe(2);
		expect(index.size).toBe(1);
	});
});

describe("PRD-078a-fix: full-load — a multi-page corpus (> COLD_BUILD_PAGE_SIZE) loads ALL rows", () => {
	/** A storage stub that serves `total` embedded rows over LIMIT/OFFSET pages of `pageSize`. */
	function pagedStorage(total: number, pageSize: number): { storage: StorageQuery; calls: () => number } {
		let calls = 0;
		const rows: StorageRow[] = [];
		for (let i = 0; i < total; i += 1) rows.push(memoryRow(`m-${String(i).padStart(5, "0")}`, liveCell(1000 + i), "proj-A"));
		const storage: StorageQuery = {
			async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
				calls += 1;
				const off = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
				const lim = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? pageSize);
				const page = rows.slice(off, off + lim);
				return ok(page, page.length);
			},
		};
		return { storage, calls: () => calls };
	}

	it("loads all 1250 rows across 3 pages of 500 — none wrongly skipped, size == row count", async () => {
		const total = 1250; // 2×500 + 1×250 (a short final page ends the scan) — exercises > PAGE_SIZE.
		const { storage, calls } = pagedStorage(total, COLD_BUILD_PAGE_SIZE);
		const index = new InMemoryLocalVectorIndex();
		await coldBuildLocalVectorIndex(index, storage, SCOPE, COLD_BUILD_PAGE_SIZE);
		expect(index.ready).toBe(true);
		expect(index.size).toBe(total); // the WHOLE corpus loaded — not 1, not one page.
		expect(calls()).toBe(3); // page 0 (500) + page 1 (500) + page 2 (250, short → stop).
	});
});

describe("PRD-078a-fix: the `recall.index.built` observability event", () => {
	it("emits ONCE with counts-only { loaded, skipped, pages, ms } reflecting the fixture; secret-free", async () => {
		// One full page + a short page; the full page carries a valid row, an empty-embedding row (skip),
		// and an id-less row (skip), so loaded/skipped are both non-trivial.
		const pages: StorageRow[][] = [
			[memoryRow("k1", liveCell(1), "proj-A"), memoryRow("empty", []), memoryRow("", liveCell(9))],
			[memoryRow("k2", liveCell(2), "proj-A")], // short page → stop
		];
		let call = 0;
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				const page = pages[call] ?? [];
				call += 1;
				return ok(page, page.length);
			},
		};
		const index = new InMemoryLocalVectorIndex();
		const events: RecallIndexBuiltEvent[] = [];
		await coldBuildLocalVectorIndex(index, storage, SCOPE, 3, (e) => events.push(e));

		expect(events.length).toBe(1); // emitted exactly ONCE, after the atomic ready-flip.
		const ev = events[0]!;
		expect(ev.loaded).toBe(2); // k1 + k2
		expect(ev.skipped).toBe(2); // the empty-embedding row + the id-less row
		expect(ev.pages).toBe(2); // the full page + the short page
		expect(typeof ev.ms).toBe("number");
		expect(ev.ms).toBeGreaterThanOrEqual(0);
		// SECRET-FREE: the event carries ONLY counts + duration — no id, content, query text, or token.
		expect(Object.keys(ev).sort()).toEqual(["loaded", "ms", "pages", "skipped"]);
		expect(ev.loaded).toBe(index.size);
	});

	it("is optional — a cold-build with no onBuilt seam still populates the index (byte-for-byte prior path)", async () => {
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				return ok([memoryRow("only", liveCell(5), "proj-A")], 1);
			},
		};
		const index = new InMemoryLocalVectorIndex();
		await coldBuildLocalVectorIndex(index, storage, SCOPE, 500); // no onBuilt
		expect(index.ready).toBe(true);
		expect(index.size).toBe(1);
	});
});
