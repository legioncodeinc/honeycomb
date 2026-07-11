/**
 * PRD-078a — `recallFast` × the LOCAL ANN index integration suite.
 *
 * Covers the RECALL-level acceptance criteria (the module math lives in
 * `local-vector-index.test.ts`):
 *   - a-AC-3: the `memories` semantic arm is served from the index when ready+enabled, and the
 *     fused output (RRF + recency) is IDENTICAL to feeding the same rows via the `<#>` SQL path.
 *   - a-AC-4: disabled (flag off) / cold (not ready) / throwing index → the memories arm falls
 *     back to the `<#>` SQL path; never throws.
 *   - a-AC-5: the `HONEYCOMB_LOCAL_ANN_INDEX` flag toggles index-vs-SQL for the memories arm.
 *   - a-AC-6: on the warm path NO `memories` `<#>` Deep Lake query is issued (the storage stub
 *     never sees a content-inline memories-semantic statement).
 *
 * Driven against a FAKE `StorageQuery` (arm-classified by SQL fingerprint) + a FAKE
 * `LocalVectorIndex`, mirroring `recall-fast.test.ts`. No live DeepLake. No `.skip`/`.only`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { recallFast, resetFastRecallPool } from "../../../../src/daemon/runtime/memories/recall.js";
import { resetAmplificationConfigCache } from "../../../../src/daemon/runtime/memories/amplification-config.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";
import type { LocalVectorIndex } from "../../../../src/daemon/runtime/memories/local-vector-index.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return { async embed(): Promise<readonly number[] | null> { return result; } };
}

/** Classify an arm by SQL shape — the fast path issues content-inline `fastSemantic` + `lexical`. */
function kindOf(sql: string): "fastSemantic" | "lexical" | "other" {
	const hasVector = /<#>/.test(sql);
	const hasText = /\bAS\s+text\b/i.test(sql);
	if (hasVector && hasText) return "fastSemantic";
	if (!hasVector && hasText) return "lexical";
	return "other";
}

/** The `'<x>' AS source` literal an arm carries. */
function sourceLitOf(sql: string): string {
	const m = sql.match(/'(memories|memory|sessions|hive_graph_versions)'\s+AS\s+source/i);
	return m ? m[1]!.toLowerCase() : "";
}

function semRow(source: string, id: string, text: string, score: number, createdAt = ""): StorageRow {
	return { source, id, text, created_at: createdAt, score };
}
function memoriesRow(id: string, text: string, createdAt = ""): StorageRow {
	return { source: "memories", id, text, created_at: createdAt };
}

/**
 * A fake storage that serves ALL arms from a fixed row source. The `memories` fast-semantic SQL
 * returns `memoriesSemRows` — the SAME rows the index would serve — so the index path and the SQL
 * path see identical memories-arm data (the a-AC-3 parity comparison).
 */
function armStorage(opts: {
	memoriesSemRows: StorageRow[];
	sessionsSemRows?: StorageRow[];
	memoriesLexRows?: StorageRow[];
	seen?: string[];
}): StorageQuery {
	return {
		async query(sql: string, _scope: QueryScope, _o?: QueryOptions): Promise<QueryResult> {
			opts.seen?.push(sql);
			const kind = kindOf(sql);
			const src = sourceLitOf(sql);
			if (kind === "fastSemantic" && src === "memories") return ok(opts.memoriesSemRows, opts.memoriesSemRows.length);
			if (kind === "fastSemantic" && src === "sessions") return ok(opts.sessionsSemRows ?? [], (opts.sessionsSemRows ?? []).length);
			if (kind === "lexical" && src === "memories") return ok(opts.memoriesLexRows ?? [], (opts.memoriesLexRows ?? []).length);
			return ok([], 0);
		},
	};
}

/** A fake LocalVectorIndex returning `rows` for the memories arm. */
function fakeIndex(opts: { ready: boolean; rows?: StorageRow[]; throwOnSearch?: boolean }): LocalVectorIndex {
	return {
		ready: opts.ready,
		size: (opts.rows ?? []).length,
		search(): StorageRow[] {
			if (opts.throwOnSearch) throw new Error("index search exploded");
			return opts.rows ?? [];
		},
	};
}

afterEach(() => {
	delete process.env.HONEYCOMB_LOCAL_ANN_INDEX;
	delete process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS;
	resetAmplificationConfigCache();
	resetFastRecallPool();
});

// ── a-AC-3: index-sourced memories arm ⇒ fused output identical to the `<#>` SQL path ──

describe("a-AC-3: the fused output with an index-served memories arm equals the `<#>` SQL path", () => {
	it("index rows and SQL rows (identical R) produce byte-identical hits/sources", async () => {
		const R: StorageRow[] = [
			semRow("memories", "m1", "kept fact one", 0.95, "2026-07-08T00:00:00.000Z"),
			semRow("memories", "m2", "kept fact two", 0.80, "2000-01-01T00:00:00.000Z"),
		];
		const sessionsSem = [semRow("sessions", "s1", "a raw turn", 0.9, "2026-07-08T00:00:00.000Z")];
		const now = () => Date.parse("2026-07-09T00:00:00.000Z");

		// INDEX path: memories arm from the index; storage serves sessions-sem + lexical (+ memories-sem
		// SQL that is NEVER issued because the index served it).
		const idxSeen: string[] = [];
		const idxStorage = armStorage({ memoriesSemRows: R, sessionsSemRows: sessionsSem, seen: idxSeen });
		const indexResult = await recallFast(
			{ query: "widgets", scope: SCOPE, limit: 10, projectId: "proj-A", projectBound: true },
			{ storage: idxStorage, embed: fakeEmbed(VALID_QUERY_VECTOR), now, localVectorIndex: fakeIndex({ ready: true, rows: R }) },
		);

		// SQL path: no index injected → the memories-sem `<#>` SQL serves the SAME rows R.
		const sqlStorage = armStorage({ memoriesSemRows: R, sessionsSemRows: sessionsSem });
		const sqlResult = await recallFast(
			{ query: "widgets", scope: SCOPE, limit: 10, projectId: "proj-A", projectBound: true },
			{ storage: sqlStorage, embed: fakeEmbed(VALID_QUERY_VECTOR), now },
		);

		expect(indexResult.hits).toEqual(sqlResult.hits);
		expect(indexResult.sources).toEqual(sqlResult.sources);
		expect(indexResult.degraded).toBe(false);
		// The index-served memories hit surfaced, and recency demoted the ancient m2 below the fresh s1.
		const order = indexResult.hits.map((h) => h.id);
		expect(order).toContain("m1");
		expect(order.indexOf("m2")).toBeGreaterThan(order.indexOf("s1"));
		// a-AC-6: NO memories `<#>` query was issued on the index path.
		expect(idxSeen.some((s) => kindOf(s) === "fastSemantic" && sourceLitOf(s) === "memories")).toBe(false);
	});
});

// ── a-AC-4: disabled / cold / throwing index ⇒ fall back to the `<#>` SQL path ──

describe("a-AC-4: the memories arm falls back to `<#>` SQL when the index is absent/cold/throwing", () => {
	async function assertSqlFallback(index: LocalVectorIndex | undefined): Promise<void> {
		const seen: string[] = [];
		const storage = armStorage({
			memoriesSemRows: [semRow("memories", "m1", "a widget fact", 0.9)],
			seen,
		});
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), ...(index !== undefined ? { localVectorIndex: index } : {}) },
		);
		// The memories `<#>` SQL WAS issued (SQL fallback), and the recall answered with its rows.
		expect(seen.some((s) => kindOf(s) === "fastSemantic" && sourceLitOf(s) === "memories")).toBe(true);
		expect(result.hits.map((h) => h.id)).toContain("m1");
		expect(result.degraded).toBe(false); // semantic still ran (via SQL) — not a degraded lexical fallback.
	}

	it("ABSENT index → SQL path", async () => {
		await assertSqlFallback(undefined);
	});
	it("COLD (not ready) index → SQL path", async () => {
		await assertSqlFallback(fakeIndex({ ready: false, rows: [semRow("memories", "x", "unused", 0.9)] }));
	});
	it("THROWING index.search → SQL path, never throws", async () => {
		await assertSqlFallback(fakeIndex({ ready: true, throwOnSearch: true }));
	});
});

// ── a-AC-5: the flag toggles index-vs-SQL ──

describe("a-AC-5: HONEYCOMB_LOCAL_ANN_INDEX toggles index-vs-SQL for the memories arm", () => {
	it("flag ON (default) → index serves memories (no `<#>` memories query); flag OFF → `<#>` SQL", async () => {
		const idxRows = [semRow("memories", "m1", "from the index", 0.9)];

		// Flag ON (default — env unset).
		resetAmplificationConfigCache();
		const onSeen: string[] = [];
		const onResult = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{
				storage: armStorage({ memoriesSemRows: [semRow("memories", "sql", "from sql", 0.5)], seen: onSeen }),
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				localVectorIndex: fakeIndex({ ready: true, rows: idxRows }),
			},
		);
		expect(onSeen.some((s) => kindOf(s) === "fastSemantic" && sourceLitOf(s) === "memories")).toBe(false);
		expect(onResult.hits.map((h) => h.id)).toContain("m1"); // the index's row, not the SQL row.

		// Flag OFF → the memories `<#>` SQL is issued instead (kill-switch).
		process.env.HONEYCOMB_LOCAL_ANN_INDEX = "false";
		resetAmplificationConfigCache();
		const offSeen: string[] = [];
		const offResult = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{
				storage: armStorage({ memoriesSemRows: [semRow("memories", "sql", "from sql", 0.5)], seen: offSeen }),
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				localVectorIndex: fakeIndex({ ready: true, rows: idxRows }),
			},
		);
		expect(offSeen.some((s) => kindOf(s) === "fastSemantic" && sourceLitOf(s) === "memories")).toBe(true);
		expect(offResult.hits.map((h) => h.id)).toContain("sql"); // the SQL row, index bypassed.
	});
});

// ── a-AC-6: warm path issues no memories `<#>` Deep Lake query ──

describe("a-AC-6: no memories `<#>` Deep Lake query is issued on the warm index path", () => {
	it("the storage stub never sees a memories content-inline semantic statement", async () => {
		const seen: string[] = [];
		const storage = armStorage({ memoriesSemRows: [semRow("memories", "sql", "x", 0.5)], seen });
		await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), localVectorIndex: fakeIndex({ ready: true, rows: [memoriesRow("m1", "hit")] }) },
		);
		const memoriesSemantic = seen.filter((s) => kindOf(s) === "fastSemantic" && sourceLitOf(s) === "memories");
		expect(memoriesSemantic).toHaveLength(0);
		// The OTHER arms still ran (sessions/hive semantic + 4 lexical = 6 Deep Lake queries).
		expect(seen.length).toBe(6);
	});
});

// ── PRD-078a-fix: PARTIAL fusion on the deadline cut — the instant local-index memories arm survives ──
//
// The live bug (Phase 078a): 078a made the `memories` semantic arm instant (served from the in-RAM local
// index), but the remaining 6 Deep Lake arms (sessions/hive semantic + 4 lexical) still hit the fast
// deadline, and fix A's deadline-race returned EMPTY (`{hits:[],sources:[],degraded:true}`) — DISCARDING
// the instant local-index memories rows that were already in hand. Live: `{"armsMs":3012,"arms":6,
// "semanticRan":true,"hits":0}`. The fix fuses whatever completed + the local index rather than returning
// empty. Only a TRULY-empty cut (no local rows AND no arm resolved) returns empty-degraded, as fix A did.

/** A storage whose every query HANGS FOREVER (never resolves, ignores the abort signal). */
function stuckStorage(): StorageQuery {
	return {
		async query(): Promise<QueryResult> {
			return new Promise<QueryResult>(() => {}); // never settles.
		},
	};
}

/**
 * A storage that serves the arms matching `resolveWhen` immediately (from `rows`) and HANGS every other
 * arm forever — the "partial Deep Lake" shape: some arms beat the deadline, others do not.
 */
function partialStorage(resolveWhen: (sql: string) => boolean, rows: (sql: string) => StorageRow[]): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			if (resolveWhen(sql)) return ok(rows(sql), rows(sql).length);
			return new Promise<QueryResult>(() => {}); // the non-matching arms hang past the deadline.
		},
	};
}

/** A storage that PARKS every query until `release()`, then settles it (resolve empty / reject-throw). */
function gatedStorage(outcome: "resolve" | "reject"): { storage: StorageQuery; release: () => void } {
	const gates: Array<() => void> = [];
	let released = false;
	const storage: StorageQuery = {
		async query(): Promise<QueryResult> {
			if (!released) await new Promise<void>((resolve) => gates.push(resolve));
			if (outcome === "reject") throw new Error("arm threw after the deadline cut");
			return ok([], 0);
		},
	};
	return {
		storage,
		release: () => {
			released = true;
			while (gates.length > 0) gates.shift()?.();
		},
	};
}

describe("PRD-078a-fix: the deadline cut fuses the local-index memories arm instead of discarding it", () => {
	it("KEY: local index has hits + all 6 Deep Lake arms HANG → returns the local hits within the deadline, degraded", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "80";
		resetAmplificationConfigCache();
		const onTiming = vi.fn();

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{
				storage: stuckStorage(),
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				localVectorIndex: fakeIndex({ ready: true, rows: [memoriesRow("m1", "an instant kept fact")] }),
				recallPool: new Semaphore(8),
				onTiming,
			},
		);
		const elapsedMs = Date.now() - startedAt;

		// The instant local-index memories row survived the deadline cut (pre-fix this was `hits: []`).
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits.map((h) => h.id)).toContain("m1");
		// A deadline cut → PARTIAL → degraded true.
		expect(result.degraded).toBe(true);
		// Bounded by the 80ms deadline, NOT the never-resolving Deep Lake arms.
		expect(elapsedMs).toBeLessThan(1000);
		// L-B10: the timing event reports the local ANN contribution (a count only).
		expect(onTiming).toHaveBeenCalledTimes(1);
		const ev = onTiming.mock.calls[0]![0] as { annHits: number; hits: number; semanticRan: boolean };
		expect(ev.annHits).toBe(1);
		expect(ev.hits).toBeGreaterThan(0);
		expect(ev.semanticRan).toBe(true);
		// Secret-free: the serialized timing event carries NO query text.
		const payload = JSON.stringify(onTiming.mock.calls[0]![0]);
		expect(payload).not.toContain("widgets");
	});

	it("PARTIAL: local memories + one Deep Lake arm resolves, the rest HANG → fuses both, degraded, within deadline", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "80";
		resetAmplificationConfigCache();

		// Only the sessions LEXICAL arm beats the deadline; every other Deep Lake arm hangs.
		const storage = partialStorage(
			(sql) => kindOf(sql) === "lexical" && sourceLitOf(sql) === "sessions",
			() => [{ source: "sessions", id: "s1", text: "a resolved raw turn", created_at: "" }],
		);

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{
				storage,
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				localVectorIndex: fakeIndex({ ready: true, rows: [memoriesRow("m1", "an instant kept fact")] }),
				recallPool: new Semaphore(8),
			},
		);
		const elapsedMs = Date.now() - startedAt;

		const ids = result.hits.map((h) => h.id);
		expect(ids).toContain("m1"); // the instant local-index arm.
		expect(ids).toContain("s1"); // the one Deep Lake arm that resolved before the cut.
		expect(result.degraded).toBe(true); // still a partial (some arms cut).
		expect(elapsedMs).toBeLessThan(1000);
	});

	it("ALL COMPLETE: local memories + every Deep Lake arm resolves fast → degraded false, all arms fused (no cut)", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "80";
		resetAmplificationConfigCache();

		// Every arm resolves immediately; the sessions lexical arm carries a row so fusion has ≥2 arms.
		const storage = partialStorage(
			() => true,
			(sql) =>
				kindOf(sql) === "lexical" && sourceLitOf(sql) === "sessions"
					? [{ source: "sessions", id: "s1", text: "a raw turn", created_at: "" }]
					: [],
		);

		const result = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{
				storage,
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				localVectorIndex: fakeIndex({ ready: true, rows: [memoriesRow("m1", "an instant kept fact")] }),
				recallPool: new Semaphore(8),
			},
		);

		expect(result.hits.map((h) => h.id)).toEqual(["m1", "s1"]);
		// No deadline fired → the honest embed-based degraded (semantic ran) → false.
		expect(result.degraded).toBe(false);
	});

	it("TRULY EMPTY: NO local rows (cold index) + all arms HANG → empty degraded within deadline (fix A behavior)", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "80";
		resetAmplificationConfigCache();

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{
				storage: stuckStorage(),
				embed: fakeEmbed(VALID_QUERY_VECTOR),
				localVectorIndex: fakeIndex({ ready: false, rows: [memoriesRow("m1", "unused — index cold")] }),
				recallPool: new Semaphore(8),
			},
		);
		const elapsedMs = Date.now() - startedAt;

		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(elapsedMs).toBeLessThan(1000);
	});

	it("no permit leak + no unhandledRejection: abandoned arms that REJECT later free their permits; local hits still returned", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "80";
		resetAmplificationConfigCache();

		const pool = new Semaphore(8);
		const { storage, release } = gatedStorage("reject");

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await recallFast(
				{ query: "widgets", scope: SCOPE, projectId: "proj-A", projectBound: true },
				{
					storage,
					embed: fakeEmbed(VALID_QUERY_VECTOR),
					localVectorIndex: fakeIndex({ ready: true, rows: [memoriesRow("m1", "an instant kept fact")] }),
					recallPool: pool,
				},
			);
			// The local-index memories arm surfaced despite the Deep Lake arms being cut mid-flight.
			expect(result.hits.map((h) => h.id)).toContain("m1");
			expect(result.degraded).toBe(true);
			// The index served memories, so only the 6 remaining Deep Lake arms acquired a permit and parked.
			expect(pool.inFlight).toBe(6);

			// Let the abandoned arms THROW in the background — each `Semaphore.run` finally frees its permit.
			release();
			await new Promise((r) => setTimeout(r, 20));
			expect(pool.inFlight).toBe(0);
			expect(unhandled).toEqual([]); // the per-arm swallow-catch marked every rejection handled.
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
