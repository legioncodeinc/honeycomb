/**
 * PRD-062d (L-D2 / AC-62d.2.1 / AC-62d.2.2) — bounded recall concurrency.
 *
 * Two contracts:
 *  1. CAP: across a recall whose arms all hit storage, no more than `N` DeepLake
 *     queries are in flight at once (the injected {@link Semaphore} width). Asserted
 *     DETERMINISTICALLY with a controllable in-flight counter on the fake storage —
 *     each query parks until the test releases it, so the peak in-flight is exact and
 *     no real sleep is used.
 *  2. PARITY: the merged recall result WITH the semaphore is byte-identical to the
 *     result WITHOUT it (a width far above the arm count). The cap changes timing, not
 *     output — it must never reorder or drop a hit (parent AC-8).
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { recallMemories } from "../../../../src/daemon/runtime/memories/recall.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** Which arm a per-arm recall statement targets, read from its `'…' AS source` tag. */
function armOf(sql: string): "memories" | "memory" | "sessions" | "other" {
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** A `memories`-arm hit row (shaped as the arm SELECT projects it). */
function memoriesRow(id: string, text: string): StorageRow {
	return { source: "memories", id, text };
}
/** A `sessions`-arm hit row. */
function sessionsRow(id: string, text: string): StorageRow {
	return { source: "sessions", id, text };
}

/**
 * A fake storage that tracks LIVE in-flight queries: each `query` increments the
 * counter, records the peak, awaits a per-call gate the test releases, then resolves
 * the per-arm result. Driven purely by promise resolution (no timers), so the cap is
 * asserted deterministically.
 */
function gatedStorage(perArm: { memories: QueryResult; memory: QueryResult; sessions: QueryResult }): {
	storage: StorageQuery;
	peak: () => number;
	release: () => void;
	sources: string[];
} {
	let inFlight = 0;
	let peak = 0;
	let released = false;
	const gates: Array<() => void> = [];
	const sources: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			if (opts?.source !== undefined) sources.push(opts.source);
			// Park until released. Once `release()` has been called, later queries (admitted as
			// permits free) resolve immediately — so the run can drain to completion.
			if (!released) await new Promise<void>((resolve) => gates.push(resolve));
			inFlight -= 1;
			const arm = armOf(sql);
			return arm === "other" ? ok([], 0) : perArm[arm];
		},
	};
	return {
		storage,
		peak: () => peak,
		release: () => {
			released = true;
			while (gates.length > 0) gates.shift()?.();
		},
		sources,
	};
}

describe("recall concurrency: in-flight DeepLake queries are capped at N (AC-62d.2.1)", () => {
	it("never exceeds the injected semaphore width across the lexical arms", async () => {
		const { storage, peak, release, sources } = gatedStorage({
			memories: ok([memoriesRow("mem-1", "widget fact")], 1),
			memory: ok([], 0),
			sessions: ok([sessionsRow("s-1", "a widget turn")], 1),
		});
		const pool = new Semaphore(2);

		// Lexical-only recall (no embed) fires the THREE lexical arms; with width 2, at most 2 run at once.
		const run = recallMemories({ query: "widget", scope: SCOPE }, { storage, recallPool: pool });

		// Let the parked queries accumulate, then release them all and finish.
		await Promise.resolve();
		await Promise.resolve();
		release();
		const result = await run;

		expect(peak()).toBeLessThanOrEqual(2);
		// Every recall-arm read carried the 062a `recall-arm` source label.
		expect(sources.length).toBeGreaterThan(0);
		expect(sources.every((s) => s === "recall-arm")).toBe(true);
		// And the recall still produced its hits (the cap did not drop them).
		expect(result.hits.length).toBeGreaterThan(0);
	});
});

/** An ungated fake storage that resolves each arm immediately (for the parity comparison). */
function immediateStorage(perArm: { memories: QueryResult; memory: QueryResult; sessions: QueryResult }): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			const arm = armOf(sql);
			return arm === "other" ? ok([], 0) : perArm[arm];
		},
	};
}

describe("recall parity: the semaphore changes timing, not output (AC-62d.2.2 / AC-8)", () => {
	it("the merged result is identical with a narrow cap and with a wide (no-op) cap", async () => {
		const perArm = {
			memories: ok([memoriesRow("mem-1", "kept widget fact"), memoriesRow("mem-2", "another widget fact")], 2),
			memory: ok([], 0),
			sessions: ok([sessionsRow("s-1", "a widget turn"), sessionsRow("s-2", "more widget talk")], 2),
		};

		// Width 1 (near-serial) vs width 100 (effectively unbounded — the pre-PRD posture).
		const narrow = await recallMemories(
			{ query: "widget", scope: SCOPE },
			{ storage: immediateStorage(perArm), recallPool: new Semaphore(1) },
		);
		const wide = await recallMemories(
			{ query: "widget", scope: SCOPE },
			{ storage: immediateStorage(perArm), recallPool: new Semaphore(100) },
		);

		// Byte-identical merged hits, sources, and degraded flag — the cap reorders/drops nothing.
		expect(narrow.hits).toEqual(wide.hits);
		expect(narrow.sources).toEqual(wide.sources);
		expect(narrow.degraded).toBe(wide.degraded);
	});
});
