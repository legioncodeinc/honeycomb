/**
 * PRD-058a, recency activation & decay (the `A(m,t)` Stage-1 term) suite.
 *
 * Verification posture (no live DeepLake, no creds, the numeric eval SKIPs in the orchestrator):
 *   - The pure activation helpers ({@link recencyActivation} / {@link halfLifeForSource} /
 *     {@link applyRecencyActivation}) are driven with CONTROLLED timestamps + scores + an injected
 *     `now`, so the class-aware exponential-decay math is deterministic with no real clock and no I/O.
 *   - The class-aware config ({@link RecencyConfigSchema}) is asserted directly (per-class defaults +
 *     overrides + the activation exponent).
 *   - End-to-end: `recallMemories` against a FAKE `StorageQuery` proves the creation timestamp flows
 *     onto the hit, `freshnessScore` is stamped on EVERY hit even with embeddings OFF (degraded), and
 *     the class-aware activation re-orders the final result while dropping nothing.
 *
 * Acceptance criteria → tests:
 *   58a.1.1 equal R, larger Δt → smaller freshnessScore, ranks below.
 *   58a.1.2 never removed by age alone (A ∈ (0,1], no cutoff).
 *   58a.1.3 recency is the LAST adjustment (cannot disturb dedup's provenance keep-decision).
 *   58a.2.1 sessions penalized harder than memories at equal age (h(sessions) < h(memories)).
 *   58a.2.2 caller `halfLifeDaysByClass` override honored.
 *   58a.2.3 class w/o configured half-life → documented default, never 100yr.
 *   58a.3.1 every hit carries freshnessScore ∈ [0,1].
 *   58a.3.2 embeddings off → freshnessScore still computed, degraded:true honest.
 *   58a.3.3 missing/unparseable timestamp → A = 1, not dropped/errored.
 * Plus the unit math: A(h) = 0.5 at Δt = h, future-timestamp clamp, the freshness-slice metric.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	applyRecencyActivation,
	halfLifeForSource,
	recallMemories,
	recencyActivation,
	type MemoryRecallHit,
} from "../../../../src/daemon/runtime/memories/recall.js";
import {
	DEFAULT_RECENCY_ACTIVATION_EXPONENT,
	DEFAULT_RECENCY_HALF_LIFE_DAYS,
	DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS,
	RecencyConfigSchema,
	resolveRecallConfig,
	envRecallConfigProvider,
} from "../../../../src/daemon/runtime/recall/config.js";
import { freshRanksFirst, freshnessSliceScore, type FreshnessCase } from "../../../../src/eval/metrics.js";
import { runFreshnessSlice, type FreshnessPair } from "../../../../src/eval/golden.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
/** A fixed "now" so every age is deterministic. */
const NOW = Date.parse("2026-06-26T00:00:00.000Z");

/** Build a minimal {@link MemoryRecallHit} with a controlled score + timestamp + source class. */
function hit(
	id: string,
	score: number,
	createdAt: string,
	source: MemoryRecallHit["source"] = "memories",
): MemoryRecallHit {
	const kind = source === "sessions" ? "session" : "memory";
	return { source, id, text: `text-${id}`, score, kind, secondary: kind === "session", createdAt, freshnessScore: 1 };
}

/** An ISO timestamp `days` before {@link NOW}. */
function daysAgo(days: number): string {
	return new Date(NOW - days * MS_PER_DAY).toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// The pure activation math, controlled timestamps + injected `now`.
// ════════════════════════════════════════════════════════════════════════════

describe("PRD-058a recencyActivation, the half-life math (A(h) = 0.5 at Δt = h)", () => {
	it("A = 0.5 EXACTLY at one half-life of age (λ = ln2/h)", () => {
		// At Δt = h the activation is exp(-ln2) = 0.5 for ANY half-life.
		expect(recencyActivation(NOW - 30 * MS_PER_DAY, NOW, 30)).toBeCloseTo(0.5, 12);
		expect(recencyActivation(NOW - 10 * MS_PER_DAY, NOW, 10)).toBeCloseTo(0.5, 12);
		expect(recencyActivation(NOW - 180 * MS_PER_DAY, NOW, 180)).toBeCloseTo(0.5, 12);
	});

	it("A = 0.25 at two half-lives, 1.0 at age 0, a smooth multiplier in (0,1]", () => {
		expect(recencyActivation(NOW - 60 * MS_PER_DAY, NOW, 30)).toBeCloseTo(0.25, 12);
		expect(recencyActivation(NOW, NOW, 30)).toBeCloseTo(1, 12);
	});

	it("a FUTURE timestamp is clamped to age 0 → A = 1 (never BOOSTED above present-day)", () => {
		const future = Date.parse("2027-01-01T00:00:00.000Z"); // ahead of NOW.
		expect(recencyActivation(future, NOW, 30)).toBe(1);
	});

	it("58a.3.3, a missing/unparseable (null/NaN) timestamp → A = 1, never NaN/throw", () => {
		expect(recencyActivation(null, NOW, 30)).toBe(1);
		expect(recencyActivation(Number.NaN, NOW, 30)).toBe(1);
	});
});

describe("PRD-058a halfLifeForSource, class half-life resolution (58a.2.2 / 58a.2.3)", () => {
	it("58a.2.3, an UNCONFIGURED class falls back to its DOCUMENTED default, never the 100-year neutral", () => {
		// No override at all → each class resolves to its documented per-class default.
		expect(halfLifeForSource("memories", undefined)).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.memories);
		expect(halfLifeForSource("memory", undefined)).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.memory);
		expect(halfLifeForSource("sessions", undefined)).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.sessions);
		// And NONE of them is the retired OFF-equivalent 100-year value.
		expect(halfLifeForSource("memories", undefined)).not.toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
		// A PARTIAL override (only `sessions` set) leaves the OTHER classes on their documented defaults.
		const partial = { sessions: 3 };
		expect(halfLifeForSource("sessions", partial)).toBe(3);
		expect(halfLifeForSource("memories", partial)).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.memories);
	});

	it("58a.2.2, a caller override is honored over the documented default", () => {
		const override = { memories: 5, memory: 5, sessions: 5 };
		expect(halfLifeForSource("memories", override)).toBe(5);
		expect(halfLifeForSource("memory", override)).toBe(5);
		expect(halfLifeForSource("sessions", override)).toBe(5);
	});

	it("the documented defaults satisfy h(sessions) < h(memory) < h(memories), the class-penalty ordering", () => {
		expect(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.sessions).toBeLessThan(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.memory);
		expect(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.memory).toBeLessThan(DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS.memories);
	});
});

describe("PRD-058a applyRecencyActivation, ordering + freshnessScore (58a.1.x / 58a.3.1)", () => {
	it("58a.1.1, equal R, larger Δt → smaller freshnessScore, ranks BELOW the fresher hit", () => {
		const older = hit("old", 1.0, daysAgo(360)); // 2 half-lives @ 180d → A ≈ 0.25.
		const newer = hit("new", 1.0, daysAgo(1)); // ≈ fresh → A ≈ 0.996.
		// Pass oldest-first so a no-op (no re-order) would be caught.
		const ordered = applyRecencyActivation([older, newer], undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW);
		expect(ordered.map((h) => h.id)).toEqual(["new", "old"]);
		// The older hit's freshnessScore is strictly smaller (larger Δt → smaller A).
		const newFresh = ordered.find((h) => h.id === "new")!.freshnessScore;
		const oldFresh = ordered.find((h) => h.id === "old")!.freshnessScore;
		expect(oldFresh).toBeLessThan(newFresh);
		// P = R · A^a strictly orders them by A (equal R).
		expect(ordered[0]!.score).toBeGreaterThan(ordered[1]!.score);
	});

	it("58a.1.2, never removed by age alone: A ∈ (0,1], no cutoff (the oldest is demoted, not dropped)", () => {
		const hits = [
			hit("ancient", 1.0, daysAgo(3650)), // ~10 years old → tiny but POSITIVE A.
			hit("recent", 1.0, daysAgo(1)),
			hit("mid", 1.0, daysAgo(90)),
		];
		const ordered = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW);
		expect(ordered).toHaveLength(3); // count unchanged, no age cutoff.
		expect(ordered.map((h) => h.id).sort()).toEqual(["ancient", "mid", "recent"]);
		const ancient = ordered.find((h) => h.id === "ancient")!;
		expect(ancient.score).toBeGreaterThan(0); // a demotion, not a zero-out removal.
		expect(ancient.freshnessScore).toBeGreaterThan(0); // A ∈ (0,1], strictly positive.
		expect(ancient.freshnessScore).toBeLessThanOrEqual(1);
		expect(ordered[ordered.length - 1]!.id).toBe("ancient"); // demoted to LAST.
	});

	it("58a.2.1, at EQUAL age a sessions hit is penalized HARDER than a memories hit (h(sessions) < h(memories))", () => {
		// Equal score, equal age, different CLASS → the sessions hit gets the smaller A and ranks below.
		const sessionsHit = hit("raw", 1.0, daysAgo(10), "sessions"); // h=10 → A = 0.5.
		const memoriesHit = hit("fact", 1.0, daysAgo(10), "memories"); // h=180 → A ≈ 0.962.
		const ordered = applyRecencyActivation([sessionsHit, memoriesHit], undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW);
		const rawFresh = ordered.find((h) => h.id === "raw")!.freshnessScore;
		const factFresh = ordered.find((h) => h.id === "fact")!.freshnessScore;
		expect(rawFresh).toBeLessThan(factFresh); // sessions penalized harder at equal age.
		expect(rawFresh).toBeCloseTo(0.5, 6); // sessions @ 10d, h=10 → exactly 0.5.
		// And the harder-penalized raw hit ranks below the distilled fact (equal R, smaller A).
		expect(ordered.map((h) => h.id)).toEqual(["fact", "raw"]);
	});

	it("58a.2.2, a caller halfLifeDaysByClass override flips the class penalty", () => {
		// Override `memories` to decay FASTER than `sessions` → the memories hit is now penalized harder.
		const sessionsHit = hit("raw", 1.0, daysAgo(10), "sessions");
		const memoriesHit = hit("fact", 1.0, daysAgo(10), "memories");
		const override = { memories: 2, sessions: 1000 }; // memories now decays much faster than sessions.
		const ordered = applyRecencyActivation([memoriesHit, sessionsHit], override, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW);
		const rawFresh = ordered.find((h) => h.id === "raw")!.freshnessScore;
		const factFresh = ordered.find((h) => h.id === "fact")!.freshnessScore;
		expect(factFresh).toBeLessThan(rawFresh); // the override inverted the penalty.
		expect(ordered.map((h) => h.id)).toEqual(["raw", "fact"]);
	});

	it("58a.3.3, a hit with a missing/unparseable timestamp gets A = 1, is never dropped, and never throws", () => {
		const noTs = hit("no-ts", 1.0, ""); // empty → unparseable → A = 1.
		const garbage = hit("junk", 0.5, "not-a-date"); // non-ISO → A = 1.
		const dated = hit("dated", 1.0, daysAgo(1));
		let ordered: MemoryRecallHit[] = [];
		expect(() => {
			ordered = applyRecencyActivation([noTs, garbage, dated], undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW);
		}).not.toThrow();
		expect(ordered).toHaveLength(3); // nothing dropped.
		// The no-timestamp + garbage hits were NOT penalized: A = 1, freshnessScore = 1, score unchanged.
		const noTsOut = ordered.find((h) => h.id === "no-ts")!;
		expect(noTsOut.freshnessScore).toBe(1);
		expect(noTsOut.score).toBe(1.0);
		const junkOut = ordered.find((h) => h.id === "junk")!;
		expect(junkOut.freshnessScore).toBe(1);
		expect(junkOut.score).toBe(0.5);
	});

	it("the activation exponent `a` re-weights the ORDERING but freshnessScore stays the raw A_simple", () => {
		const older = hit("old", 1.0, daysAgo(180), "memories"); // A = 0.5 (one half-life @ 180d).
		const newer = hit("new", 1.0, daysAgo(1), "memories");
		// a = 0 (neutral): A^0 = 1 → NO age re-ordering on a score tie; but freshnessScore is still the raw A.
		const neutral = applyRecencyActivation([older, newer], undefined, 0, NOW);
		const oldNeutral = neutral.find((h) => h.id === "old")!;
		expect(oldNeutral.score).toBe(1.0); // R · A^0 = R (unchanged).
		expect(oldNeutral.freshnessScore).toBeCloseTo(0.5, 6); // the raw A is still surfaced honestly.
		// a = 1 (default): the ordering weight IS the raw A → the older hit is demoted.
		const active = applyRecencyActivation([older, newer], undefined, 1, NOW);
		expect(active.map((h) => h.id)).toEqual(["new", "old"]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The class-aware config (defaults + overrides + the activation exponent).
// ════════════════════════════════════════════════════════════════════════════

describe("PRD-058a RecencyConfigSchema, class-aware defaults, overrides, exponent", () => {
	it("defaults: per-class object present (unset classes undefined), exponent 1.0, legacy flat retained", () => {
		const def = RecencyConfigSchema.parse({});
		// The legacy flat knob remains for the back-compat dampener path.
		expect(def.halfLifeDays).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
		// The per-class object exists; an unconfigured class is undefined (→ runtime documented default).
		expect(def.halfLifeDaysByClass.memories).toBeUndefined();
		expect(def.halfLifeDaysByClass.memory).toBeUndefined();
		expect(def.halfLifeDaysByClass.sessions).toBeUndefined();
		// The activation exponent defaults to 1.0.
		expect(def.activationExponent).toBe(DEFAULT_RECENCY_ACTIVATION_EXPONENT);
	});

	it("a per-class override + exponent thread through, and out-of-range values are clamped (typo never bites)", () => {
		const parsed = RecencyConfigSchema.parse({
			halfLifeDaysByClass: { memories: 200, sessions: 7 },
			activationExponent: 0.5,
		});
		expect(parsed.halfLifeDaysByClass.memories).toBe(200);
		expect(parsed.halfLifeDaysByClass.sessions).toBe(7);
		expect(parsed.halfLifeDaysByClass.memory).toBeUndefined(); // unset class stays undefined.
		expect(parsed.activationExponent).toBe(0.5);
		// A negative exponent is clamped UP to 0 (never a stale-BOOSTING negative).
		expect(RecencyConfigSchema.parse({ activationExponent: -3 }).activationExponent).toBe(0);
		// A garbage exponent falls back to the default.
		expect(RecencyConfigSchema.parse({ activationExponent: "nope" }).activationExponent).toBe(
			DEFAULT_RECENCY_ACTIVATION_EXPONENT,
		);
		// A zero/negative per-class half-life is clamped UP to the floor (no div-by-zero / inversion).
		expect(RecencyConfigSchema.parse({ halfLifeDaysByClass: { memories: 0 } }).halfLifeDaysByClass.memories).toBe(1);
	});

	it("the env provider threads the class + exponent knobs through resolveRecallConfig", () => {
		const tuned = resolveRecallConfig(
			envRecallConfigProvider({
				HONEYCOMB_RECALL_RECENCY_HALF_LIFE_DAYS_SESSIONS: "4",
				HONEYCOMB_RECALL_RECENCY_ACTIVATION_EXPONENT: "0.8",
			} as NodeJS.ProcessEnv),
		);
		expect(tuned.recency.halfLifeDaysByClass.sessions).toBe(4);
		expect(tuned.recency.halfLifeDaysByClass.memories).toBeUndefined();
		expect(tuned.recency.activationExponent).toBe(0.8);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// End-to-end through recallMemories, freshnessScore on every hit, even degraded.
// ════════════════════════════════════════════════════════════════════════════

/** Classify the statement shape recall emitted (mirrors the recency-dampening suite). */
function kindOf(sql: string): "vector" | "dedup" | "hydrate" | "memories" | "memory" | "sessions" | "other" {
	if (sql.includes("<#>")) return "vector";
	if (/AS\s+embedding/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "dedup";
	if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) return "hydrate";
	if (/'memories'\s+AS\s+source/i.test(sql)) return "memories";
	if (/'memory'\s+AS\s+source/i.test(sql)) return "memory";
	if (/'sessions'\s+AS\s+source/i.test(sql)) return "sessions";
	return "other";
}

/** A purely-lexical fake storage (no embed seam injected) → recall runs DEGRADED. */
function lexicalStorage(opts: {
	memories?: QueryResult;
	memory?: QueryResult;
	sessions?: QueryResult;
}): { storage: StorageQuery } {
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			const kind = kindOf(sql);
			if (kind === "memories") return opts.memories ?? ok([], 0);
			if (kind === "memory") return opts.memory ?? ok([], 0);
			if (kind === "sessions") return opts.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage };
}

/** A lexical `memories` row as the arm projects it (`source`, `id`, `text`, `created_at`). */
function memRow(id: string, createdAt: string): StorageRow {
	return { source: "memories", id, text: `fact ${id}`, created_at: createdAt };
}

describe("PRD-058a end-to-end, freshnessScore on every hit, honest degraded, class-aware order", () => {
	it("58a.3.1 / 58a.3.2, embeddings OFF: every hit carries freshnessScore ∈ [0,1] and degraded stays true", async () => {
		const { storage } = lexicalStorage({
			memories: ok([memRow("old", daysAgo(360)), memRow("new", daysAgo(1))], 0),
		});
		// No embed seam → the lexical (degraded) path. freshnessScore is from row age, independent of embeddings.
		const result = await recallMemories({ query: "anything", scope: SCOPE, limit: 10 }, { storage, now: () => NOW });
		expect(result.degraded).toBe(true); // honest: no semantic arm ran.
		expect(result.hits).toHaveLength(2);
		for (const h of result.hits) {
			expect(h.freshnessScore).toBeGreaterThan(0);
			expect(h.freshnessScore).toBeLessThanOrEqual(1);
		}
		// The fresher hit ranks first and carries the higher freshnessScore.
		expect(result.hits.map((h) => h.id)).toEqual(["new", "old"]);
		expect(result.hits.find((h) => h.id === "new")!.freshnessScore).toBeGreaterThan(
			result.hits.find((h) => h.id === "old")!.freshnessScore,
		);
	});

	it("58a.1.2, a class override demotes the stale hit to LAST but never drops it", async () => {
		const { storage } = lexicalStorage({
			memories: ok([memRow("old", daysAgo(120)), memRow("new", daysAgo(1))], 0),
		});
		const result = await recallMemories(
			{ query: "anything", scope: SCOPE, limit: 10 },
			{ storage, recency: { halfLifeDaysByClass: { memories: 30 } }, now: () => NOW },
		);
		expect(result.hits.map((h) => h.id)).toEqual(["new", "old"]);
		expect(result.hits).toHaveLength(2); // demoted, not dropped.
	});

	it("58a.3.3, a row with no usable timestamp is treated as maximally fresh (A = 1), never dropped", async () => {
		const { storage } = lexicalStorage({
			memories: ok([memRow("no-ts", ""), memRow("dated", daysAgo(360))], 0),
		});
		const result = await recallMemories({ query: "anything", scope: SCOPE, limit: 10 }, { storage, now: () => NOW });
		expect(result.hits).toHaveLength(2);
		const noTs = result.hits.find((h) => h.id === "no-ts")!;
		expect(noTs.freshnessScore).toBe(1); // maximally fresh.
		// The no-timestamp hit (A=1) outranks the genuinely-aged "dated" hit (A≈0.25).
		expect(result.hits.map((h) => h.id)).toEqual(["no-ts", "dated"]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The freshness-sensitivity eval slice (PRD-058a Test Plan), pure scoring code.
// ════════════════════════════════════════════════════════════════════════════

describe("PRD-058a eval freshness slice, fresher ranks first at equal relevance", () => {
	it("freshRanksFirst passes when the fresh id outranks the stale id, fails otherwise", () => {
		const freshCase: FreshnessCase = { caseId: "c1", freshId: "fresh", staleId: "stale" };
		expect(freshRanksFirst({ ids: ["fresh", "stale"] }, freshCase)).toBe(true); // fresh above stale.
		expect(freshRanksFirst({ ids: ["stale", "fresh"] }, freshCase)).toBe(false); // stale above fresh → fail.
		expect(freshRanksFirst({ ids: ["other", "stale"] }, freshCase)).toBe(false); // fresh absent → fail.
		expect(freshRanksFirst({ ids: ["fresh", "other"] }, freshCase)).toBe(true); // fresh present, stale absent → pass.
	});

	it("freshnessSliceScore is the pass fraction; 0 on an empty slice (never NaN)", () => {
		const c: FreshnessCase = { caseId: "c", freshId: "f", staleId: "s" };
		expect(
			freshnessSliceScore([
				{ result: { ids: ["f", "s"] }, freshCase: c },
				{ result: { ids: ["s", "f"] }, freshCase: c },
			]),
		).toBe(0.5);
		expect(freshnessSliceScore([])).toBe(0);
	});

	it("runFreshnessSlice gates: every pair must rank fresher-first (engine-agnostic, fake recall)", async () => {
		const pairs: readonly FreshnessPair[] = [
			{ key: "p1", query: "q1", freshId: "f1", staleId: "s1" },
			{ key: "p2", query: "q2", freshId: "f2", staleId: "s2" },
		];
		// A fake recall that ranks the fresher copy first for both → the slice gate PASSES.
		const goodRecall = async (q: string): Promise<readonly string[]> =>
			q === "q1" ? ["f1", "s1"] : ["f2", "s2"];
		const goodReport = await runFreshnessSlice(pairs, goodRecall);
		expect(goodReport.passed).toBe(true);
		expect(goodReport.passFraction).toBe(1);
		expect(goodReport.cases.every((c) => c.freshFirst)).toBe(true);
		// A fake recall that inverts one pair → the gate FAILS (a real recency regression).
		const badRecall = async (q: string): Promise<readonly string[]> =>
			q === "q1" ? ["s1", "f1"] : ["f2", "s2"];
		const badReport = await runFreshnessSlice(pairs, badRecall);
		expect(badReport.passed).toBe(false);
		expect(badReport.passFraction).toBe(0.5);
	});
});
