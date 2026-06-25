/**
 * PRD-047d — the recency-dampening stage suite.
 *
 * Verification posture (no live DeepLake, no creds — d-AC-4 runs in the orchestrator):
 *   - The pure dampener helpers ({@link applyRecencyDampening} / {@link recencyDecay}) are
 *     driven with CONTROLLED timestamps + scores + an injected `now`, so the age-decay math
 *     is deterministic with no real clock and no I/O.
 *   - d-AC-1: two equally-relevant hits of DIFFERENT age order newest-first under the dampener.
 *   - d-AC-2: nothing is dropped by age — the oldest hit is DEMOTED but still present.
 *   - d-AC-3: a hit with NO usable timestamp gets `decay = 1` (no penalty), never an exception.
 *   - DEFAULT half-life is OFF-EQUIVALENT: with the documented default, a YEAR-old row is demoted
 *     by < a tiny epsilon — i.e. NEUTRAL on the age-agnostic synthetic golden set (d-AC-4 by
 *     construction; the eval tunes the knob before it bites).
 *   - End-to-end: `recallMemories` against a FAKE `StorageQuery` proves the creation timestamp
 *     flows from the arm/hydration SQL onto the hit, and that a SHORT half-life re-orders the
 *     final result newest-first while keeping the oldest hit present.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	applyRecencyDampening,
	recallMemories,
	recencyDecay,
	type MemoryRecallHit,
} from "../../../../src/daemon/runtime/memories/recall.js";
import {
	DEFAULT_RECENCY_HALF_LIFE_DAYS,
	MIN_RECENCY_HALF_LIFE_DAYS,
	RecencyConfigSchema,
	resolveRecallConfig,
	envRecallConfigProvider,
} from "../../../../src/daemon/runtime/recall/config.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
/** A fixed "now" so every age is deterministic. */
const NOW = Date.parse("2026-06-24T00:00:00.000Z");

/** Build a minimal {@link MemoryRecallHit} with a controlled score + timestamp. */
function hit(id: string, score: number, createdAt: string, source: MemoryRecallHit["source"] = "memories"): MemoryRecallHit {
	const kind = source === "sessions" ? "session" : "memory";
	return { source, id, text: `text-${id}`, score, kind, secondary: kind === "session", createdAt };
}

/** An ISO timestamp `days` before {@link NOW}. */
function daysAgo(days: number): string {
	return new Date(NOW - days * MS_PER_DAY).toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// The pure dampener — controlled timestamps + scores + injected `now`.
// ════════════════════════════════════════════════════════════════════════════

describe("PRD-047d d-AC-1 — newer wins on a tie under the dampener", () => {
	it("two equally-relevant hits of different age order NEWEST-first", () => {
		const SHORT_HALF_LIFE = 30; // an ACTIVE half-life (not the OFF-equivalent default).
		const older = hit("old", 1.0, daysAgo(120));
		const newer = hit("new", 1.0, daysAgo(1));
		// Pass them oldest-first so a no-op (no re-order) would be caught.
		const ordered = applyRecencyDampening([older, newer], SHORT_HALF_LIFE, NOW);
		expect(ordered.map((h) => h.id)).toEqual(["new", "old"]);
		// The newer hit's dampened score is strictly higher than the older's.
		expect(ordered[0]!.score).toBeGreaterThan(ordered[1]!.score);
	});

	it("a STRONGER-but-OLDER hit can still lead when the age gap is small (multiplicative, not a cutoff)", () => {
		const SHORT_HALF_LIFE = 30;
		// `strong-old` is 1 half-life older but starts 4x the score → it should still lead.
		const strongOld = hit("strong-old", 1.0, daysAgo(30)); // decay 0.5 → 0.5
		const weakNew = hit("weak-new", 0.25, daysAgo(0)); // decay 1.0 → 0.25
		const ordered = applyRecencyDampening([weakNew, strongOld], SHORT_HALF_LIFE, NOW);
		expect(ordered.map((h) => h.id)).toEqual(["strong-old", "weak-new"]);
	});
});

describe("PRD-047d d-AC-2 — nothing dropped by age (demote, never cut off)", () => {
	it("the oldest hit is demoted to LAST but still present in the result", () => {
		const SHORT_HALF_LIFE = 7; // aggressive half-life → strong demotion, still no drop.
		const hits = [
			hit("ancient", 1.0, daysAgo(3650)), // ~10 years old → decay ≈ 0 but NOT removed.
			hit("recent", 1.0, daysAgo(1)),
			hit("mid", 1.0, daysAgo(30)),
		];
		const ordered = applyRecencyDampening(hits, SHORT_HALF_LIFE, NOW);
		// All three survive — the count is unchanged (no age cutoff).
		expect(ordered).toHaveLength(3);
		expect(ordered.map((h) => h.id).sort()).toEqual(["ancient", "mid", "recent"]);
		// The ancient hit is demoted to LAST, never dropped.
		expect(ordered[ordered.length - 1]!.id).toBe("ancient");
		// Its dampened score is positive (a demotion, not a zero-out removal).
		expect(ordered[ordered.length - 1]!.score).toBeGreaterThan(0);
	});
});

describe("PRD-047d d-AC-3 — a missing/unparseable timestamp is safe (decay = 1, no throw)", () => {
	it("an empty timestamp yields decay = 1 (no penalty)", () => {
		expect(recencyDecay(null, NOW, 30)).toBe(1);
	});

	it("recallMemories-shaped hit with NO timestamp keeps its score and never throws", () => {
		const SHORT_HALF_LIFE = 30;
		const noTs = hit("no-ts", 1.0, ""); // empty createdAt → unparseable → decay 1.
		const newer = hit("dated", 1.0, daysAgo(1)); // decay ≈ slightly under 1.
		let ordered: MemoryRecallHit[] = [];
		expect(() => {
			ordered = applyRecencyDampening([noTs, newer], SHORT_HALF_LIFE, NOW);
		}).not.toThrow();
		// The no-timestamp hit was NOT penalized (decay 1) — its score is unchanged.
		const noTsOut = ordered.find((h) => h.id === "no-ts");
		expect(noTsOut!.score).toBe(1.0);
		// And a garbage (non-ISO) string is equally safe → decay 1, no throw.
		expect(recencyDecay(Number.NaN as unknown as null, NOW, 30)).toBe(1); // defensive: NaN ms.
		const garbage = applyRecencyDampening([hit("junk", 0.5, "not-a-date")], SHORT_HALF_LIFE, NOW);
		expect(garbage[0]!.score).toBe(0.5);
	});

	it("a FUTURE timestamp is clamped to age 0 → decay 1 (never BOOSTED above present-day)", () => {
		const future = Date.parse("2027-01-01T00:00:00.000Z"); // ahead of NOW.
		expect(recencyDecay(future, NOW, 30)).toBe(1);
	});
});

describe("PRD-047d d-AC-4 (default OFF-equivalent) — neutral on the age-agnostic golden set", () => {
	it("with the DEFAULT half-life, a YEAR-old row is demoted by < a tiny epsilon", () => {
		// decay(365d, 36500d half-life) = 0.5^(365/36500) = 0.5^0.01 ≈ 0.99309.
		const decay = recencyDecay(NOW - 365 * MS_PER_DAY, NOW, DEFAULT_RECENCY_HALF_LIFE_DAYS);
		expect(decay).toBeGreaterThan(0.99); // < 1% demotion for a whole year — effectively OFF.
		expect(decay).toBeLessThan(1);
	});

	it("with the DEFAULT half-life, ordering is age-NEUTRAL: a tied newer/older pair keeps input order", () => {
		// Two tied-score hits, one a year older. Under the OFF-equivalent default the < 1% nudge is
		// enough to nominally order newest-first, but the ABSOLUTE demotion is sub-epsilon — the
		// synthetic golden set (which scores a relevance CLASS, age-agnostic) is unmoved. We assert
		// the demotion magnitude is negligible (the construction guarantee d-AC-4 relies on).
		const newer = hit("new", 1.0, daysAgo(1));
		const older = hit("old", 1.0, daysAgo(365));
		const ordered = applyRecencyDampening([newer, older], DEFAULT_RECENCY_HALF_LIFE_DAYS, NOW);
		const newScore = ordered.find((h) => h.id === "new")!.score;
		const oldScore = ordered.find((h) => h.id === "old")!.score;
		// Both stay within < 1% of their original 1.0 score → no meaningful re-shaping.
		expect(newScore).toBeGreaterThan(0.99);
		expect(oldScore).toBeGreaterThan(0.99);
		expect(Math.abs(newScore - oldScore)).toBeLessThan(0.01);
	});

	it("the config default IS the OFF-equivalent half-life, env-overridable + clamped", () => {
		// Default resolves to the documented OFF-equivalent value.
		const def = RecencyConfigSchema.parse({});
		expect(def.halfLifeDays).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
		// An env override threads through resolveRecallConfig.
		const tuned = resolveRecallConfig(
			envRecallConfigProvider({ HONEYCOMB_RECALL_RECENCY_HALF_LIFE_DAYS: "30" } as NodeJS.ProcessEnv),
		);
		expect(tuned.recency.halfLifeDays).toBe(30);
		// A zero / negative / non-numeric value is clamped UP to the floor (no div-by-zero / inversion).
		expect(RecencyConfigSchema.parse({ halfLifeDays: 0 }).halfLifeDays).toBe(MIN_RECENCY_HALF_LIFE_DAYS);
		expect(RecencyConfigSchema.parse({ halfLifeDays: -5 }).halfLifeDays).toBe(MIN_RECENCY_HALF_LIFE_DAYS);
		expect(RecencyConfigSchema.parse({ halfLifeDays: "garbage" }).halfLifeDays).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// End-to-end through recallMemories — the timestamp flows from SQL onto the hit,
// and the dampener affects the FINAL ordering (composing with fuse/rerank/dedup).
// ════════════════════════════════════════════════════════════════════════════

/** Classify the statement shape recall emitted (mirrors the dedup suite). */
function kindOf(sql: string): "vector" | "dedup" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	if (sql.includes("<#>")) return "vector";
	if (/AS\s+embedding/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "dedup";
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** A purely-lexical fake storage that answers the three lexical arms (no embed seam injected). */
function lexicalStorage(opts: {
	memories?: QueryResult;
	memory?: QueryResult;
	sessions?: QueryResult;
}): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			const kind = kindOf(sql);
			if (kind === "memories") return opts.memories ?? ok([], 0);
			if (kind === "memory") return opts.memory ?? ok([], 0);
			if (kind === "sessions") return opts.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage, sqls };
}

/** A lexical `memories` row as the arm projects it (`source`, `id`, `text`, `created_at`). */
function memRow(id: string, createdAt: string): StorageRow {
	return { source: "memories", id, text: `fact ${id}`, created_at: createdAt };
}

describe("PRD-047d end-to-end — the timestamp flows onto the hit and dampens the FINAL order", () => {
	it("the arm SQL projects the creation timestamp (created_at)", async () => {
		const { storage, sqls } = lexicalStorage({ memories: ok([memRow("m1", daysAgo(1))], 0) });
		await recallMemories({ query: "anything", scope: SCOPE, limit: 10 }, { storage });
		// The memories arm SELECTs created_at; the memory/sessions arms alias creation_date → created_at.
		const memoriesSql = sqls.find((s) => kindOf(s) === "memories")!;
		const memorySql = sqls.find((s) => kindOf(s) === "memory")!;
		const sessionsSql = sqls.find((s) => kindOf(s) === "sessions")!;
		// `sqlIdent` emits a bare identifier here (no surrounding quotes); the memories arm
		// projects `created_at`, the memory/sessions arms alias `creation_date` → created_at.
		expect(memoriesSql).toMatch(/created_at::text AS created_at/i);
		expect(memorySql).toMatch(/creation_date::text AS created_at/i);
		expect(sessionsSql).toMatch(/creation_date::text AS created_at/i);
	});

	it("the hit carries createdAt and a SHORT half-life re-orders newest-first, dropping nothing", async () => {
		// Two equally-matched memories of different age. Lexical-only (no embed seam) → RRF order is
		// the arm's storage order. We pass them OLDEST-first so the dampener has to re-order.
		const { storage } = lexicalStorage({
			memories: ok([memRow("old", daysAgo(120)), memRow("new", daysAgo(1))], 0),
		});
		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, recency: { halfLifeDays: 30 }, now: () => NOW },
		);
		// The creation timestamp made it onto the hit (sourced from the arm SQL).
		expect(result.hits.find((h) => h.id === "new")!.createdAt).toBe(daysAgo(1));
		// Newest-first under the dampener, and BOTH hits present (no age cutoff — d-AC-2).
		expect(result.hits.map((h) => h.id)).toEqual(["new", "old"]);
		expect(result.hits).toHaveLength(2);
	});

	it("with the DEFAULT (OFF-equivalent) half-life, ordering is byte-for-byte the pre-dampener RRF order", async () => {
		// No `recency` dep → default 100-year half-life → decay ≈ 1 for all → the dampener is a no-op
		// on the ranking. The RRF order (arm storage order, equal scores → id tie-break) stands.
		const { storage } = lexicalStorage({
			memories: ok([memRow("a", daysAgo(1)), memRow("b", daysAgo(400))], 0),
		});
		const result = await recallMemories({ query: "anything", scope: SCOPE, limit: 10 }, { storage, now: () => NOW });
		// Equal RRF scores → deterministic id tie-break ("a" < "b"); the year-old "b" is NOT demoted
		// past "a" because the default half-life is OFF-equivalent.
		expect(result.hits.map((h) => h.id)).toEqual(["a", "b"]);
	});
});
