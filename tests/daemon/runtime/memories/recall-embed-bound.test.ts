/**
 * PRD-077 (L-B9 + L-B10) — bound the pre-arm query embed on BOTH recall paths + instrument fast-path
 * phase timings.
 *
 * The regression the live run proved was missing: the query embed on the recall hot path ran BEFORE
 * the arm-deadline existed, so a slow/hung embed daemon blocked `recallFast` AND `runSemanticArms`
 * with zero completions. These tests drive a HANGING embed (a never-resolving promise — the key new
 * fixture) and assert both paths degrade to lexical-only `degraded:true` WITHIN the embed bound
 * instead of hanging, that a fast embed is byte-for-byte unchanged, and that the fast path emits ONE
 * secret-free `recall.timing` event.
 *
 * Verification posture mirrors `recall-hot-lane.test.ts`: FAKE `StorageQuery`, no live DeepLake; the
 * embed bounds are read from `amplificationConfig()` and a test overrides them via env +
 * `resetAmplificationConfigCache()`. No `.skip` / `.only`; `vitest run` is CI.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	recallFast,
	recallMemories,
	resetFastRecallPool,
	resetSharedRecallPool,
	type RecallTimingEvent,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";
import {
	DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS,
	DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS,
	MIN_RECALL_DEADLINE_MS,
	resetAmplificationConfigCache,
	resolveAmplificationConfig,
	type AmplificationConfigProvider,
	type RawAmplificationConfig,
} from "../../../../src/daemon/runtime/memories/amplification-config.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

/** A normal embed that resolves a fixed vector immediately. */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** The KEY new fixture: an embed whose promise NEVER resolves (a hung embed daemon). */
function hangingEmbed(): EmbedClient {
	return {
		embed(): Promise<readonly number[] | null> {
			return new Promise<never>(() => {
				/* never resolves — models a wedged embed daemon */
			});
		},
	};
}

/** A SLOW-but-under-budget embed: resolves the vector after `delayMs` (below the embed deadline). */
function slowEmbed(result: readonly number[] | null, delayMs: number): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return result;
		},
	};
}

function isLexical(sql: string): boolean {
	return !/<#>/.test(sql);
}
function sourceLitOf(sql: string): string {
	const m = sql.match(/'(memories|memory|sessions|hive_graph_versions)'\s+AS\s+source/i);
	return m ? m[1]!.toLowerCase() : "";
}
function memoriesRow(id: string, text: string, createdAt = ""): StorageRow {
	return { source: "memories", id, text, created_at: createdAt };
}
function semRow(source: string, id: string, text: string, score: number, createdAt = ""): StorageRow {
	return { source, id, text, created_at: createdAt, score };
}

function provider(raw: RawAmplificationConfig): AmplificationConfigProvider {
	return { read: () => raw };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	for (const k of ["HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS", "HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS"]) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	resetAmplificationConfigCache();
	resetFastRecallPool();
	resetSharedRecallPool();
});

// ── L-B9 fast: a hung embed degrades the fast path to lexical-only WITHIN the embed bound ──

describe("L-B9 (fast): a HANGING embed degrades recallFast to lexical-only degraded within the embed bound", () => {
	it("returns a lexical-only degraded result promptly (does NOT hang), running the 4 lexical arms alone", async () => {
		process.env.HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return isLexical(sql) && sourceLitOf(sql) === "memories"
					? ok([memoriesRow("m1", "a widget fact")], 1)
					: ok([], 0);
			},
		};

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: hangingEmbed(), recallPool: new Semaphore(8) },
		);
		const elapsedMs = Date.now() - startedAt;

		// Did NOT hang: resolved well within a second (the 50ms embed bound fired → lexical-only).
		expect(elapsedMs).toBeLessThan(1000);
		// ONLY the 4 lexical arms ran — NO `<#>` semantic statement was ever issued.
		expect(seen).toHaveLength(4);
		expect(seen.every((s) => isLexical(s))).toBe(true);
		// A lexical-only degraded result that still answered from the lexical floor.
		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
	});

	it("a SLOW-but-under-budget embed still runs the semantic arms (unchanged — the bound only bites the hung case)", async () => {
		process.env.HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS = "500";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return isLexical(sql) ? ok([], 0) : ok([semRow(sourceLitOf(sql), "sem-1", "a semantic hit", 0.9)], 1);
			},
		};
		// 20ms embed < the 500ms bound → the semantic arms run exactly as if the embed were instant.
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: slowEmbed(VALID_QUERY_VECTOR, 20), recallPool: new Semaphore(8) },
		);

		expect(seen).toHaveLength(7); // 3 semantic `<#>` + 4 lexical.
		expect(seen.filter((s) => !isLexical(s))).toHaveLength(3);
		expect(result.degraded).toBe(false);
		expect(result.hits.length).toBeGreaterThan(0);
	});
});

// ── L-B9 fast unchanged: a fast embed is byte-for-byte the pre-077 semantic run ──

describe("L-B9 (fast unchanged): a fast embed runs the semantic arms exactly as before (degraded:false)", () => {
	it("an instant embed issues all 7 arms and returns a non-degraded semantic result", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return isLexical(sql) ? ok([], 0) : ok([semRow(sourceLitOf(sql), "sem-1", "a semantic hit", 0.9)], 1);
			},
		};
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: new Semaphore(8) },
		);
		expect(seen).toHaveLength(7);
		expect(seen.filter((s) => !isLexical(s))).toHaveLength(3);
		expect(result.degraded).toBe(false);
		expect(result.hits.length).toBeGreaterThan(0);
	});
});

// ── L-B9 heavy: a hung embed degrades the heavy path to lexical-only WITHIN the embed bound ──

describe("L-B9 (heavy): a HANGING embed degrades recallMemories to lexical-only degraded within the embed bound", () => {
	it("returns the lexical arms' hits promptly (does NOT hang), degraded:true, no `<#>` semantic statement", async () => {
		process.env.HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return isLexical(sql) && sourceLitOf(sql) === "memories"
					? ok([memoriesRow("m1", "a widget fact")], 1)
					: ok([], 0);
			},
		};

		const startedAt = Date.now();
		const result = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{ storage, embed: hangingEmbed(), recallPool: new Semaphore(6), dedup: { enabled: false, similarityThreshold: 0.9 } },
		);
		const elapsedMs = Date.now() - startedAt;

		// Did NOT hang: bounded by the 50ms heavy embed deadline → lexical-only fallback.
		expect(elapsedMs).toBeLessThan(1000);
		// NO semantic `<#>` statement was issued (the embed never produced a vector).
		expect(seen.every((s) => isLexical(s))).toBe(true);
		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
	});
});

// ── L-B10: the fast path emits ONE secret-free recall.timing event ──

describe("L-B10: recallFast emits a single secret-free recall.timing event with the phase durations", () => {
	it("fires onTiming once with embedMs/armsMs/fuseMs/totalMs (+ counts) and NO query text", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				return isLexical(sql) && sourceLitOf(sql) === "memories" ? ok([memoriesRow("m1", "a widget fact")], 1) : ok([], 0);
			},
		};
		const onTiming = vi.fn<(e: RecallTimingEvent) => void>();
		const secretQuery = "super-secret-timing-probe-widget";
		const result = await recallFast(
			{ query: secretQuery, scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), recallPool: new Semaphore(8), onTiming },
		);

		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
		expect(onTiming).toHaveBeenCalledTimes(1);
		const event = onTiming.mock.calls[0]![0];
		// All four phase durations are present and are non-negative numbers.
		for (const key of ["embedMs", "armsMs", "fuseMs", "totalMs"] as const) {
			expect(typeof event[key], key).toBe("number");
			expect(event[key], key).toBeGreaterThanOrEqual(0);
		}
		expect(event.lane).toBe("fast");
		expect(event.arms).toBe(7);
		expect(event.semanticRan).toBe(true);
		expect(event.hits).toBe(1);
		// D-5 secret-free: the serialized event carries NO query text.
		const payload = JSON.stringify(event);
		expect(payload).not.toContain("super-secret");
		expect(payload).not.toContain("widget");
	});

	it("is zero-cost when the onTiming seam is absent (no throw, normal result)", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				return ok([], 0);
			},
		};
		await expect(
			recallFast({ query: "widgets", scope: SCOPE }, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) }),
		).resolves.toMatchObject({ degraded: false });
	});
});

// ── L-B9 config: the two embed-deadline knobs resolve to defaults, honor an override, and clamp ──

describe("L-B9 (config): the fast + heavy embed-deadline knobs default, override, and clamp via the provider seam", () => {
	it("an empty record yields fast-embed 1500ms and heavy-embed 3000ms", () => {
		const cfg = resolveAmplificationConfig(provider({}));
		expect(cfg.recallFastEmbedDeadlineMs).toBe(DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS);
		expect(cfg.recallFastEmbedDeadlineMs).toBe(1500);
		expect(cfg.recallHeavyEmbedDeadlineMs).toBe(DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS);
		expect(cfg.recallHeavyEmbedDeadlineMs).toBe(3000);
	});

	it("a numeric override is honored for each knob", () => {
		const cfg = resolveAmplificationConfig(provider({ recallFastEmbedDeadlineMs: "800", recallHeavyEmbedDeadlineMs: 2000 }));
		expect(cfg.recallFastEmbedDeadlineMs).toBe(800);
		expect(cfg.recallHeavyEmbedDeadlineMs).toBe(2000);
	});

	it("a non-numeric value falls back to the default; a sub-floor value clamps up to the 1ms floor", () => {
		const fallback = resolveAmplificationConfig(provider({ recallFastEmbedDeadlineMs: "abc", recallHeavyEmbedDeadlineMs: "??" }));
		expect(fallback.recallFastEmbedDeadlineMs).toBe(DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS);
		expect(fallback.recallHeavyEmbedDeadlineMs).toBe(DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS);
		const clamped = resolveAmplificationConfig(provider({ recallFastEmbedDeadlineMs: 0, recallHeavyEmbedDeadlineMs: -100 }));
		expect(clamped.recallFastEmbedDeadlineMs).toBe(MIN_RECALL_DEADLINE_MS);
		expect(clamped.recallHeavyEmbedDeadlineMs).toBe(MIN_RECALL_DEADLINE_MS);
	});
});
