/**
 * ISS-007/ISS-008 — recall skips the embed when the supervisor's CURRENT state is not warm.
 *
 * The live-observed failure: the embed daemon wedges (accepts TCP, never replies) while /health
 * keeps reporting embeddings "on" from a one-shot warm latch — so EVERY recall burned the full
 * embed deadline (fast 1.5s / heavy 3s) before degrading to lexical. With the embed-liveness
 * gate wired, a not-warm supervisor (warming / suspect / failed) makes recall SKIP the embed
 * attempt outright: the lexical arms answer immediately, the degraded reason is distinctly
 * `embed_not_ready` (a healthy skip) vs `embed_timeout` (a burned deadline, which additionally
 * kicks the supervisor's on-demand liveness probe via `reportTimeout`).
 *
 * Verification posture mirrors `recall-embed-bound.test.ts`: FAKE `StorageQuery`, no live
 * DeepLake, deadlines driven via env + `resetAmplificationConfigCache()`. No `.skip`/`.only`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	recallFast,
	recallMemories,
	resetFastRecallPool,
	resetSharedRecallPool,
	type EmbedLivenessGate,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { Semaphore } from "../../../../src/daemon/runtime/memories/bounded-pool.js";
import { resetAmplificationConfigCache } from "../../../../src/daemon/runtime/memories/amplification-config.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

/** An embed whose promise NEVER resolves — the wedged embed daemon. */
function hangingEmbed(): EmbedClient & { calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		embed(): Promise<readonly number[] | null> {
			calls += 1;
			return new Promise<never>(() => {
				/* wedged: never resolves */
			});
		},
	};
}

/** A fast embed resolving `result` immediately (null models the client's fast-failure contract). */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/** A gate in a fixed state, recording `reportTimeout` calls. */
function fakeGate(ready: boolean): EmbedLivenessGate & { timeouts: () => number } {
	let timeouts = 0;
	return {
		ready: () => ready,
		reportTimeout: () => {
			timeouts += 1;
		},
		timeouts: () => timeouts,
	};
}

function isLexical(sql: string): boolean {
	return !/<#>/.test(sql);
}
function sourceLitOf(sql: string): string {
	const m = sql.match(/'(memories|memory|sessions|hive_graph_versions)'\s+AS\s+source/i);
	return m ? m[1]!.toLowerCase() : "";
}
function memoriesRow(id: string, text: string): StorageRow {
	return { source: "memories", id, text, created_at: "" };
}

/** A lexical-answering fake storage that records every SQL it sees. */
function lexicalStorage(seen: string[]): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			seen.push(sql);
			return isLexical(sql) && sourceLitOf(sql) === "memories" ? ok([memoriesRow("m1", "a widget fact")], 1) : ok([], 0);
		},
	};
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
	vi.restoreAllMocks();
});

describe("ISS-008 (fast): a not-warm gate SKIPS the embed — lexical answers immediately, reason embed_not_ready", () => {
	it("never calls the embed client, burns <100ms on the skip, and reports degradedReason 'embed_not_ready'", async () => {
		// Make the configured deadline LONG so the assertion below can only pass via the skip
		// (an attempted-and-timed-out embed would burn ≥2s here).
		process.env.HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS = "2000";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const seen: string[] = [];
		const embed = hangingEmbed();
		const gate = fakeGate(false); // supervisor state: warming / suspect / failed → not ready.

		const startedAt = Date.now();
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage: lexicalStorage(seen), embed, embedGate: gate, recallPool: new Semaphore(8) },
		);
		const elapsedMs = Date.now() - startedAt;

		// The embed attempt was SKIPPED outright: the client was never dialed, no deadline started.
		expect(embed.calls()).toBe(0);
		// The skip path burns effectively nothing — nowhere near the 2s deadline (the pre-fix cost).
		expect(elapsedMs).toBeLessThan(100);
		// Lexical floor answered: 4 lexical arms only, degraded with the DISTINCT not-ready reason.
		expect(seen).toHaveLength(4);
		expect(seen.every((s) => isLexical(s))).toBe(true);
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toBe("embed_not_ready");
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
		// A skip is NOT a timeout: the on-demand probe hook was not fired.
		expect(gate.timeouts()).toBe(0);
	});

	it("a READY gate leaves the semantic path untouched (all 7 arms, degraded:false, no reason)", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const seen: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				seen.push(sql);
				return isLexical(sql)
					? ok([], 0)
					: ok([{ source: sourceLitOf(sql), id: "sem-1", text: "a semantic hit", created_at: "", score: 0.9 }], 1);
			},
		};
		const gate = fakeGate(true);
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage, embed: fakeEmbed(VALID_QUERY_VECTOR), embedGate: gate, recallPool: new Semaphore(8) },
		);
		expect(seen).toHaveLength(7); // 3 semantic `<#>` + 4 lexical — byte-for-byte the ungated run.
		expect(result.degraded).toBe(false);
		expect(result.degradedReason).toBeUndefined();
		expect(gate.timeouts()).toBe(0);
	});
});

describe("ISS-008 (fast): a burned embed deadline is reported distinctly and kicks the on-demand probe", () => {
	it("a hanging embed behind a READY gate → degradedReason 'embed_timeout' + reportTimeout fired once", async () => {
		process.env.HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetFastRecallPool();

		const seen: string[] = [];
		const gate = fakeGate(true); // the supervisor still believes it is warm — the wedge window.
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage: lexicalStorage(seen), embed: hangingEmbed(), embedGate: gate, recallPool: new Semaphore(8) },
		);

		expect(result.degraded).toBe(true);
		// DISTINCT from the skip: this run DID attempt the embed and burned the bounded deadline.
		expect(result.degradedReason).toBe("embed_timeout");
		// The wedge signature immediately triggers the supervisor's on-demand liveness check.
		expect(gate.timeouts()).toBe(1);
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
	});

	it("a fast embed FAILURE (null contract, no timeout) → 'embed_unavailable' and NO probe kick", async () => {
		resetAmplificationConfigCache();
		resetFastRecallPool();
		const seen: string[] = [];
		const gate = fakeGate(true);
		const result = await recallFast(
			{ query: "widgets", scope: SCOPE },
			{ storage: lexicalStorage(seen), embed: fakeEmbed(null), embedGate: gate, recallPool: new Semaphore(8) },
		);
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toBe("embed_unavailable");
		expect(gate.timeouts()).toBe(0);
	});
});

describe("ISS-008 (heavy): recallMemories honors the same gate + distinct reasons", () => {
	it("a not-warm gate skips the embed (never dialed, <100ms on the embed phase) with reason 'embed_not_ready'", async () => {
		process.env.HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS = "2000";
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const seen: string[] = [];
		const embed = hangingEmbed();
		const gate = fakeGate(false);

		const startedAt = Date.now();
		const result = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{
				storage: lexicalStorage(seen),
				embed,
				embedGate: gate,
				recallPool: new Semaphore(6),
				dedup: { enabled: false, similarityThreshold: 0.9 },
			},
		);
		const elapsedMs = Date.now() - startedAt;

		expect(embed.calls()).toBe(0);
		expect(elapsedMs).toBeLessThan(1000); // never the 2s deadline; the lexical arms bound the run.
		expect(seen.every((s) => isLexical(s))).toBe(true);
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toBe("embed_not_ready");
		expect(result.hits.map((h) => h.id)).toEqual(["m1"]);
		expect(gate.timeouts()).toBe(0);
	});

	it("a hanging embed behind a READY gate → 'embed_timeout' + reportTimeout fired", async () => {
		process.env.HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS = "50";
		resetAmplificationConfigCache();
		resetSharedRecallPool();

		const seen: string[] = [];
		const gate = fakeGate(true);
		const result = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{
				storage: lexicalStorage(seen),
				embed: hangingEmbed(),
				embedGate: gate,
				recallPool: new Semaphore(6),
				dedup: { enabled: false, similarityThreshold: 0.9 },
			},
		);
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toBe("embed_timeout");
		expect(gate.timeouts()).toBe(1);
	});

	it("keyword mode stays an INTENTIONAL lexical run: no degraded flag, no reason, gate untouched", async () => {
		resetAmplificationConfigCache();
		resetSharedRecallPool();
		const seen: string[] = [];
		const embed = hangingEmbed();
		const gate = fakeGate(false);
		const result = await recallMemories(
			{ query: "widgets", scope: SCOPE, limit: 10 },
			{
				storage: lexicalStorage(seen),
				embed,
				embedGate: gate,
				recallMode: "keyword",
				recallPool: new Semaphore(6),
				dedup: { enabled: false, similarityThreshold: 0.9 },
			},
		);
		expect(embed.calls()).toBe(0);
		expect(result.degraded).toBe(false); // PRD-044c/PRD-029 coherence: an intentional lexical run.
		expect(result.degradedReason).toBeUndefined();
	});
});
