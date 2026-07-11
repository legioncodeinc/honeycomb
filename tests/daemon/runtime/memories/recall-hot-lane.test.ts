/**
 * PRD-077b — hot-lane isolation + load-shedding + server-side deadlines (L-B1..B3, L-B5, L-B7, L-B8).
 *
 * Verification posture (mirrors `recall-concurrency.test.ts` for the gated-storage + injected-
 * Semaphore pattern):
 *   - The recall engines are driven against a FAKE `StorageQuery`. No live DeepLake.
 *   - The fast lane (`recallFast`) is a DEDICATED `Semaphore` independent of the shared/heavy pool,
 *     bounded by a server-side deadline (`AbortSignal.timeout` threaded into every arm's query), and
 *     load-shed past a waiter-depth threshold. The heavy path keeps the shared pool and gains a
 *     generous deadline only (D-4) — it is NEVER shed.
 *   - Deadlines/thresholds are read from `amplificationConfig()`; a test overrides them via env +
 *     `resetAmplificationConfigCache()` (the documented test seam) and resets the lanes.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	recallFast,
	recallMemories,
	resetFastRecallPool,
	resetSharedRecallPool,
	type StalenessSource,
	type StalenessVerdictInput,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";
import {
	DEFAULT_RECALL_MAX_CONCURRENCY,
	resetAmplificationConfigCache,
} from "../../../../src/daemon/runtime/memories/amplification-config.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** The `'<x>' AS source` literal an arm carries (used to route per-arm rows). */
function sourceLitOf(sql: string): string {
	const m = sql.match(/'(memories|memory|sessions|hive_graph_versions)'\s+AS\s+source/i);
	return m ? m[1]!.toLowerCase() : "";
}
/** True when the statement is a lexical arm (no `<#>` cosine match). */
function isLexical(sql: string): boolean {
	return !/<#>/.test(sql);
}
function memoriesRow(id: string, text: string, createdAt = ""): StorageRow {
	return { source: "memories", id, text, created_at: createdAt };
}
function sessionsRow(id: string, text: string, createdAt = ""): StorageRow {
	return { source: "sessions", id, text, created_at: createdAt };
}

/** A storage whose every query HANGS until the caller's deadline `opts.signal` aborts it. */
function hangingStorage(): { storage: StorageQuery } {
	const storage: StorageQuery = {
		async query(_sql: string, _scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
			return new Promise<QueryResult>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(queryError("aborted by deadline signal")), {
					once: true,
				});
			});
		},
	};
	return { storage };
}

/** A gated storage that counts peak in-flight queries and parks until released (for cap assertions). */
function gatedStorage(): { storage: StorageQuery; peak: () => number; release: () => void } {
	let inFlight = 0;
	let peak = 0;
	let released = false;
	const gates: Array<() => void> = [];
	const storage: StorageQuery = {
		async query(): Promise<QueryResult> {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			if (!released) await new Promise<void>((resolve) => gates.push(resolve));
			inFlight -= 1;
			return ok([], 0);
		},
	};
	return {
		storage,
		peak: () => peak,
		release: () => {
			released = true;
			while (gates.length > 0) gates.shift()?.();
		},
	};
}

/**
 * A storage whose every query HANGS FOREVER — it never resolves AND ignores the abort signal (a stuck
 * daemon-side fetch, or an arm queued behind a saturated lane that never gets to run). The pre-fix-A
 * `await Promise.all(arms)` would wedge on this indefinitely; the raced deadline must cut it loose.
 */
function stuckStorage(): { storage: StorageQuery } {
	const storage: StorageQuery = {
		async query(): Promise<QueryResult> {
			return new Promise<QueryResult>(() => {}); // never settles, never observes the signal.
		},
	};
	return { storage };
}

/**
 * A gated storage that parks each query until `release()`, then settles it — `resolve` returns an empty
 * ok, `reject` THROWS (a hard arm throw, the worst case for permit release + unhandled rejections). Used
 * to prove the ABANDONED arms (the deadline won the race) still free their permits and never surface an
 * unhandledRejection when they settle in the background AFTER `recallFast` has already returned.
 */
function gatedReleasableStorage(outcome: "resolve" | "reject"): { storage: StorageQuery; release: () => void } {
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

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	// Restore any env knob a test mutated, then rebuild the config + both lanes from a clean slate.
	for (const k of [
		"HONEYCOMB_RECALL_FAST_DEADLINE_MS",
		"HONEYCOMB_RECALL_FAST_SHED_QUEUE_DEPTH",
		"HONEYCOMB_RECALL_HEAVY_DEADLINE_MS",
		"HONEYCOMB_RECALL_FAST_MAX_CONCURRENCY",
	]) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	resetAmplificationConfigCache();
	resetFastRecallPool();
	resetSharedRecallPool();
});

// ── L-B1 (b-AC-1): the fast lane is independent of a saturated shared/heavy pool ──

describe("L-B1 (b-AC-1): a fast recall acquires its own lane even when the shared pool is saturated", () => {
	it("completes on the dedicated fast lane while a control routed through the saturated pool blocks forever", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();

		// A fully-saturated shared/heavy pool: hold its ONE slot and never release it.
		const shared = new Semaphore(1);
		await shared.acquire();
		expect(shared.inFlight).toBe(1);

		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				return isLexical(sql) && sourceLitOf(sql) === "memories"
					? ok([memoriesRow("m1", "a widget fact")], 1)
					: ok([], 0);
			},
		};

		// CONTROL: a fast recall FORCED onto the saturated shared pool — its 7 arms park forever.
		let controlDone = false;
		void recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: shared },
		).then(() => {
			controlDone = true;
		});

		// REAL: a fast recall on the DEDICATED lane (no injected pool) — it must complete despite the
		// shared pool being saturated, proving the lane is independent.
		const fast = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR) },
		);

		expect(fast.hits.map((h) => h.id)).toEqual(["m1"]);
		// The control (on the saturated shared pool) is still parked — the fast lane did not touch it.
		await Promise.resolve();
		expect(controlDone).toBe(false);
		expect(shared.inFlight).toBe(1); // still fully held; the fast lane consumed none of its slots.
	});
});

// ── L-B2 (b-AC-2): the fast-lane server-side deadline aborts + frees the slot ──

describe("L-B2 (b-AC-2): a fast recall past the server-side deadline returns degraded-empty and frees its slot", () => {
	it("a hanging storage stub is aborted daemon-side at the deadline; the handler returns within it and the slot is reusable", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const pool = new Semaphore(8);
		const { storage } = hangingStorage();

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool },
		);
		const elapsedMs = Date.now() - startedAt;

		// Returned a fail-soft empty degraded result, WITHIN the deadline (well under the 3000ms default).
		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(elapsedMs).toBeLessThan(1000);
		// Every fast-lane slot was released when its arm's query resolved (aborted) — the lane is drained.
		expect(pool.inFlight).toBe(0);
		expect(pool.waiting).toBe(0);
		// The freed slot is reusable by the next acquire (no leaked permit).
		await pool.acquire();
		expect(pool.inFlight).toBe(1);
		pool.release();
	});
});

// ── L-B3 (b-AC-3): queue-depth load-shedding on the fast lane only ──

describe("L-B3 (b-AC-3): past the shed queue-depth, a fast recall sheds without issuing a query", () => {
	it("sheds promptly (query stub NOT called), returns degraded-empty, and emits recall.shed with NO query text", async () => {
		process.env.HONEYCOMB_RECALL_FAST_SHED_QUEUE_DEPTH = "2";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		// Drive the fast lane's waiter backlog above the threshold (2): hold the one slot, park 3 waiters.
		const pool = new Semaphore(1);
		await pool.acquire();
		void pool.acquire();
		void pool.acquire();
		void pool.acquire();
		expect(pool.waiting).toBe(3);

		const query = vi.fn(async (): Promise<QueryResult> => ok([], 0));
		const onShed = vi.fn();
		const result = await recallFast(
			{ query: "super-secret widget query", scope: SCOPE },
			{ storage: { query }, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool, onShed },
		);

		// Shed: degraded-empty, and NO Deep Lake query was enqueued.
		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(query).not.toHaveBeenCalled();
		// The structured `recall.shed` event carried subsystem-state ONLY (lane/depth/threshold).
		expect(onShed).toHaveBeenCalledTimes(1);
		expect(onShed).toHaveBeenCalledWith({ lane: "fast", depth: 3, threshold: 2 });
		// D-5 secret-free: the event body contains NO query text.
		const payload = JSON.stringify(onShed.mock.calls[0]![0]);
		expect(payload).not.toContain("super-secret");
		expect(payload).not.toContain("widget");
	});
});

// ── L-B5 (b-AC-5): the heavy path still uses the shared pool at its existing budget ──

describe("L-B5 (b-AC-5): the dashboard/heavy recall is unchanged — shared pool at its existing budget", () => {
	it("recallMemories caps in-flight at DEFAULT_RECALL_MAX_CONCURRENCY (6) via the shared pool (no fast lane)", async () => {
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const { storage, peak, release } = gatedStorage();
		// No injected pool → the heavy path uses the process-wide shared pool sized from the config.
		const run = recallMemories({ query: "widgets", scope: SCOPE }, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) });

		// Let the 7 heavy arms (3 semantic `<#>` + 4 lexical) attempt to acquire; 6 admit, 1 parks.
		for (let i = 0; i < 12; i++) await Promise.resolve();
		expect(peak()).toBe(DEFAULT_RECALL_MAX_CONCURRENCY);
		expect(peak()).toBe(6);

		release();
		await run;
	});

	it("the fast lane admits all 7 of one recall's arms at once (a DISTINCT, wider budget of 8)", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const { storage, peak, release } = gatedStorage();
		const run = recallFast({ query: "widgets", scope: SCOPE }, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) });

		for (let i = 0; i < 12; i++) await Promise.resolve();
		// All 7 arms run concurrently on the fast lane (width 8) — the ~1.5s parallel wall-clock survives.
		expect(peak()).toBe(7);

		release();
		await run;
	});
});

// ── L-B7 (b-AC-7): fail-soft end to end — deadline / shed / transport error never throw ──

describe("L-B7 (b-AC-7): every fast-path failure degrades to a clean empty/degraded result, never a throw", () => {
	it("a server-side deadline degrades to empty (no throw)", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "40";
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const { storage } = hangingStorage();
		await expect(
			recallFast({ query: "widgets", scope: SCOPE }, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) }),
		).resolves.toEqual({ hits: [], sources: [], degraded: true });
	});

	it("a shed request degrades to empty (no throw)", async () => {
		process.env.HONEYCOMB_RECALL_FAST_SHED_QUEUE_DEPTH = "0";
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const pool = new Semaphore(1);
		await pool.acquire();
		void pool.acquire(); // one waiter → depth 1 > threshold 0 → shed.
		const query = vi.fn(async (): Promise<QueryResult> => ok([], 0));
		await expect(
			recallFast({ query: "widgets", scope: SCOPE }, { storage: { query }, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool }),
		).resolves.toEqual({ hits: [], sources: [], degraded: true });
		expect(query).not.toHaveBeenCalled();
	});

	it("a transport error on every arm degrades to no injection (no throw)", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				return queryError("connection reset by peer");
			},
		};
		const result = await recallFast({ query: "widgets", scope: SCOPE }, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) });
		expect(result.hits).toEqual([]);
	});
});

// ── L-B8 (b-AC-8 / D-4): the heavy path's generous deadline bounds a runaway arm ──

describe("L-B8 (b-AC-8 / D-4): a hanging heavy arm is bounded by the generous deadline; a sub-deadline recall is unchanged", () => {
	it("a hanging arm is aborted at the heavy deadline; the handler returns the partial set (degraded) and frees its slots", async () => {
		process.env.HONEYCOMB_RECALL_HEAVY_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const pool = new Semaphore(6);
		// The memories lexical arm returns immediately; the sessions lexical arm HANGS until aborted.
		const storage: StorageQuery = {
			async query(sql: string, _scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
				if (isLexical(sql) && sourceLitOf(sql) === "memories") return ok([memoriesRow("m1", "a widget fact")], 1);
				if (isLexical(sql) && sourceLitOf(sql) === "sessions") {
					return new Promise<QueryResult>((resolve) => {
						opts?.signal?.addEventListener("abort", () => resolve(queryError("aborted by heavy deadline")), { once: true });
					});
				}
				return ok([], 0);
			},
		};

		const startedAt = Date.now();
		// Lexical-only (no embed) so the hanging arm is the sessions lexical arm; degraded is true.
		const result = await recallMemories({ query: "widgets", scope: SCOPE, limit: 10 }, { storage, recallPool: pool });
		const elapsedMs = Date.now() - startedAt;

		// Returned within the deadline (not a 25-minute hang), with the arm that COMPLETED (partial).
		expect(elapsedMs).toBeLessThan(1000);
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
		expect(result.degraded).toBe(true);
		// The aborted arm's slot (and every other) was released.
		expect(pool.inFlight).toBe(0);
	});

	it("a sub-deadline heavy recall is unaffected — full arms + ranking over a fixture", async () => {
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				if (!isLexical(sql)) return ok([], 0);
				if (sourceLitOf(sql) === "memories") return ok([memoriesRow("m1", "a widget fact")], 1);
				if (sourceLitOf(sql) === "sessions") return ok([sessionsRow("s1", "a raw widget turn")], 1);
				return ok([], 0);
			},
		};
		const result = await recallMemories({ query: "widgets", scope: SCOPE, limit: 10 }, { storage });

		// The happy path is byte-for-byte: both arms fuse, degraded reflects the lexical-only run.
		expect(result.hits.map((h) => h.id)).toEqual(["m1", "s1"]);
		expect(result.sources).toEqual(["memories", "sessions"]);
		expect(result.degraded).toBe(true);
	});

	it("POST-fan-out I/O is bounded too: a hanging staleness source is cut at the heavy deadline (the WHOLE heavy recall is bounded, not just the arms)", async () => {
		// The bug this covers: the heavy deadline was threaded into the arm fan-out but NOT into the
		// post-fan-out storage reads (dedup/rerank/staleness/conflict/calibration/MMR), so a slow retry
		// storm on THOSE could still pin the heavy recall past its deadline. Here the arms return instantly
		// but the staleness source (a post-fan-out read) hangs until the heavy deadline aborts it.
		process.env.HONEYCOMB_RECALL_HEAVY_DEADLINE_MS = "80";
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				if (isLexical(sql) && sourceLitOf(sql) === "memories") return ok([memoriesRow("m1", "a widget fact")], 1);
				return ok([], 0);
			},
		};
		// A staleness source that HANGS until the heavy deadline signal aborts it — the exact post-fan-out
		// retry-storm the fix bounds. Without the heavySignal threaded in, this would pin recall forever.
		const stalenessSource: StalenessSource = {
			exponent: 1,
			load(_hits, _scope, signal?: AbortSignal): Promise<Map<string, StalenessVerdictInput>> {
				return new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve(new Map<string, StalenessVerdictInput>()), { once: true });
				});
			},
		};

		const startedAt = Date.now();
		const result = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{ storage, stalenessSource },
		);
		const elapsedMs = Date.now() - startedAt;

		// Bounded by the heavy deadline (not a hang), and the fused hit still returns (the source degrades
		// to neutral on the deadline abort). Proves the heavy deadline now covers the post-fan-out read.
		expect(elapsedMs).toBeLessThan(1000);
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
	});
});

// ── fix A (PRD-077): recallFast RACES the whole arm phase against the deadline ────
//
// The bug: the per-arm deadline `AbortSignal` only aborts an arm AFTER it acquires a fast-lane slot and
// starts its `storage.query`. An arm QUEUED waiting for a slot (a saturated lane) — or a fetch that is
// stuck and ignores the signal — is NOT bounded by it, so `await Promise.all(arms)` parked for tens of
// seconds past the ~3000ms budget (live-observed `armsMs: 73273`). The fix races `Promise.all(arms)`
// against a deadline sentinel that RESOLVES on the deadline signal, so `recallFast`'s wall-clock is
// bounded by `recallFastDeadlineMs` REGARDLESS of whether the arms have resolved.

describe("fix A (PRD-077): a saturated-lane / stuck-fetch fast recall returns within the deadline, not the hang", () => {
	it("A-core: with arm queries that HANG FOREVER, recallFast returns degraded-empty within the deadline", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const pool = new Semaphore(8);
		const { storage } = stuckStorage();

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool },
		);
		const elapsedMs = Date.now() - startedAt;

		// Bounded by the 50ms deadline — NOT the never-resolving arms (pre-fix this awaited Promise.all forever).
		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(elapsedMs).toBeLessThan(1000);
	});

	it("A-core (saturated lane): when EVERY fast-lane slot is held, the queued arms never start yet recallFast still returns within the deadline", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		// A fully-saturated fast lane: hold its only slot so all 7 arms PARK in `pool.run` (query never called).
		// The shed gate does not fire (the backlog builds AFTER the start-of-call `waiting` snapshot).
		const pool = new Semaphore(1);
		await pool.acquire();
		const query = vi.fn(async (): Promise<QueryResult> => ok([], 0));

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage: { query }, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool },
		);
		const elapsedMs = Date.now() - startedAt;

		expect(result).toEqual({ hits: [], sources: [], degraded: true });
		expect(elapsedMs).toBeLessThan(1000);
		// The arms never acquired a slot (they queued behind the held permit) — the deadline race freed the call.
		expect(query).not.toHaveBeenCalled();
	});

	it("timing is emitted on the deadline-cut path: onTiming fires once with hits:0, degraded, and a bounded armsMs", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const pool = new Semaphore(8);
		const { storage } = stuckStorage();
		const onTiming = vi.fn();

		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool, onTiming },
		);

		expect(result.degraded).toBe(true);
		// The L-B10 timing event STILL fires on the deadline cut (one emit site for both paths).
		expect(onTiming).toHaveBeenCalledTimes(1);
		const ev = onTiming.mock.calls[0]![0] as {
			lane: string;
			armsMs: number;
			fuseMs: number;
			arms: number;
			semanticRan: boolean;
			hits: number;
		};
		expect(ev.lane).toBe("fast");
		expect(ev.hits).toBe(0); // deadline-cut → no hits injected.
		expect(ev.fuseMs).toBe(0); // fusion never ran.
		expect(ev.arms).toBe(7); // 3 semantic + 4 lexical were issued before the cut.
		expect(ev.semanticRan).toBe(true);
		// armsMs records the deadline-bounded wait (≈ the 50ms deadline), not a 73s hang.
		expect(ev.armsMs).toBeLessThan(1000);
	});

	it("PRD-078a-fix (adapted, no local index): SOME arms resolve before the deadline + others hang → the resolved arms are FUSED (partial), degraded, within the deadline", async () => {
		// The bug this covers: pre-078a-fix a deadline cut returned {hits:[],degraded:true}, discarding the
		// arms that ALREADY resolved. Here the memories lexical arm returns instantly while the other 6 arms
		// hang forever — the deadline must FUSE the one survivor (a partial degraded result), not throw it away.
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "80";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const pool = new Semaphore(8);
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				if (isLexical(sql) && sourceLitOf(sql) === "memories") return ok([memoriesRow("m1", "a widget fact")], 1);
				return new Promise<QueryResult>(() => {}); // every other arm hangs forever (ignores the signal).
			},
		};

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool },
		);
		const elapsedMs = Date.now() - startedAt;

		// The one resolved arm survives the deadline cut — FUSED, not discarded — and the recall is bounded.
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
		expect(result.degraded).toBe(true); // a partial (deadline-cut) recall is degraded.
		expect(elapsedMs).toBeLessThan(1000);
	});

	it("no permit leak + no unhandledRejection: abandoned arms that RESOLVE later free their fast-lane permits", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const pool = new Semaphore(8);
		const { storage, release } = gatedReleasableStorage("resolve");

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await recallFast(
				{ query: "widgets", scope: SCOPE },
				{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool },
			);
			expect(result).toEqual({ hits: [], sources: [], degraded: true });
			// The 7 arms acquired a slot and parked; after the deadline cut they still hold their permits.
			expect(pool.inFlight).toBe(7);

			// Let the ABANDONED arms settle in the background → each `pool.run` finally RELEASES its permit.
			release();
			await new Promise((r) => setTimeout(r, 20));
			expect(pool.inFlight).toBe(0);
			expect(pool.waiting).toBe(0);
			// The freed slots are reusable (no leaked permit).
			await pool.acquire();
			expect(pool.inFlight).toBe(1);
			pool.release();
			// The abandoned arms settling produced NO unhandledRejection.
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("no unhandledRejection: abandoned arms that REJECT (throw) later are swallowed and still free their permits", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const pool = new Semaphore(8);
		const { storage, release } = gatedReleasableStorage("reject");
		const onArmError = vi.fn();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await recallFast(
				{ query: "widgets", scope: SCOPE },
				{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: pool, onArmError },
			);
			expect(result.degraded).toBe(true);
			expect(pool.inFlight).toBe(7);

			// Let the abandoned arms THROW in the background.
			release();
			await new Promise((r) => setTimeout(r, 20));
			// The rejecting arms freed their permits (Semaphore.run finally) AND raised no unhandledRejection
			// (the per-arm swallow-catch marks each handled).
			expect(pool.inFlight).toBe(0);
			expect(unhandled).toEqual([]);
			// PRD-077 (fix A) observability: the swallowed rejection is SURFACED (not hidden) — `onArmError`
			// fires with the reason for every abandoned arm that threw, and the payload is secret-free (a
			// reason string only, no query text).
			expect(onArmError).toHaveBeenCalled();
			expect(onArmError.mock.calls[0]![0]).toEqual({ reason: "arm threw after the deadline cut" });
			expect(JSON.stringify(onArmError.mock.calls[0]![0])).not.toContain("widgets");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does NOT fire onArmError on the happy path (arms resolve, no unexpected throw)", async () => {
		process.env.HONEYCOMB_RECALL_FAST_DEADLINE_MS = "3000";
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const onArmError = vi.fn();
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				return ok([], 0);
			},
		};
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), onArmError },
		);
		expect(result.degraded).toBe(false);
		expect(onArmError).not.toHaveBeenCalled();
	});
});
