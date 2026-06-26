/**
 * PRD-058c — the recall composition suite: `(1 − σ)^s` fed INTO the 058a recency-multiplier stage.
 *
 * These tests drive {@link applyRecencyActivation} directly with a {@link ResolvedStaleness} map (the same
 * value the recall orchestration builds from the staleness source), proving the staleness factor is one
 * more bounded multiplier in the SAME single demotion step — never a parallel score path.
 *
 * Acceptance criteria → tests:
 *   58c.2.1 observe (s = 0) → (1 − σ)^0 = 1: the memory is FLAGGED (σ/refStatus surfaced) but ranking is
 *           UNCHANGED.
 *   58c.2.2 execute (s > 0) → (1 − σ)^s < 1 fed into the 058a stage: the stale memory is DEMOTED, never
 *           hard-dropped (still present in the result set).
 *   58c.2.3 a memory whose σ falls (a returned reference) has its demotion LIFTED (re-ranks up).
 *   Plus: a missing/unparseable σ is NEUTRAL (unknown, factor 1) exactly as a missing timestamp is fresh.
 */

import { describe, expect, it } from "vitest";

import {
	applyRecencyActivation,
	DEFAULT_RECENCY_ACTIVATION_EXPONENT,
	DEFAULT_STALENESS_EXPONENT,
	type MemoryRecallHit,
	type ResolvedStaleness,
	type StalenessVerdictInput,
} from "../../../../src/daemon/runtime/memories/recall.js";

const NOW = Date.parse("2026-06-26T00:00:00.000Z");

/** Build a minimal hit with a controlled score; createdAt = NOW so recency is neutral (isolates staleness). */
function hit(id: string, score: number, source: MemoryRecallHit["source"] = "memories"): MemoryRecallHit {
	return {
		source,
		id,
		text: `text-${id}`,
		score,
		kind: source === "sessions" ? "session" : "memory",
		secondary: source === "sessions",
		createdAt: new Date(NOW).toISOString(),
		freshnessScore: 1,
	};
}

/** The fusion key the stage looks up by (`source id`). */
function key(source: MemoryRecallHit["source"], id: string): string {
	return `${source} ${id}`;
}

/** Build a ResolvedStaleness from `(id → verdict)` for `memories`-source hits, with an `s` exponent. */
function staleness(exponent: number, verdicts: Record<string, StalenessVerdictInput>): ResolvedStaleness {
	const byKey = new Map<string, StalenessVerdictInput>();
	for (const [id, v] of Object.entries(verdicts)) byKey.set(key("memories", id), v);
	return { byKey, exponent };
}

describe("PRD-058c observe posture (s = 0) — flagged but inert (58c.2.1)", () => {
	it("with s = 0 a stale memory is surfaced (σ/refStatus stamped) but ranking is UNCHANGED", () => {
		const hits = [hit("a", 1.0), hit("b", 0.9)];
		const resolved = staleness(DEFAULT_STALENESS_EXPONENT, {
			a: { sigma: 1, refStatus: "stale", staleRefs: ["src/x.ts#gone"] },
		});
		const out = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, resolved);
		// Order is unchanged (a still first) because (1 − σ)^0 = 1.
		expect(out.map((h) => h.id)).toEqual(["a", "b"]);
		const a = out.find((h) => h.id === "a")!;
		// But the staleness IS surfaced for the dashboard (visible-but-inert).
		expect(a.staleness).toBe(1);
		expect(a.refStatus).toBe("stale");
		expect(a.staleRefs).toEqual(["src/x.ts#gone"]);
	});
});

describe("PRD-058c execute posture (s > 0) — demote, never drop (58c.2.2)", () => {
	it("a fully-stale memory (σ = 1) with s = 1 is demoted below an equally-relevant fresh memory, still present", () => {
		const hits = [hit("stale", 1.0), hit("fresh", 0.9)];
		const resolved = staleness(1, {
			stale: { sigma: 1, refStatus: "stale", staleRefs: ["gone"] },
			fresh: { sigma: 0, refStatus: "fresh" },
		});
		const out = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, resolved);
		// stale had the higher base score (1.0) but (1 − 1)^1 = 0 sinks it BELOW fresh (0.9 · 1 = 0.9).
		expect(out.map((h) => h.id)).toEqual(["fresh", "stale"]);
		// NEVER dropped: the stale hit is still in the set.
		expect(out.find((h) => h.id === "stale")).toBeDefined();
		expect(out.find((h) => h.id === "stale")!.staleness).toBe(1);
	});

	it("a partial σ (a fuzzy rename, σ ∈ (0,1)) PARTIALLY demotes rather than zeroing", () => {
		const hits = [hit("partial", 1.0), hit("fresh", 0.8)];
		const resolved = staleness(1, {
			partial: { sigma: 0.3, refStatus: "stale" }, // (1 − 0.3)^1 = 0.7 → 1.0·0.7 = 0.7 < 0.8
			fresh: { sigma: 0, refStatus: "fresh" },
		});
		const out = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, resolved);
		expect(out.map((h) => h.id)).toEqual(["fresh", "partial"]);
		expect(out.find((h) => h.id === "partial")!.staleness).toBeCloseTo(0.3, 10);
	});
});

describe("PRD-058c demotion is lifted when σ falls (58c.2.3)", () => {
	it("the same memory ranks up once its σ drops back to 0 (a returned reference)", () => {
		const hits = [hit("m", 1.0), hit("other", 0.9)];
		const stale = staleness(1, { m: { sigma: 1, refStatus: "stale" }, other: { sigma: 0, refStatus: "fresh" } });
		const afterStale = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, stale);
		expect(afterStale.map((h) => h.id)).toEqual(["other", "m"]); // demoted.

		const fresh = staleness(1, { m: { sigma: 0, refStatus: "fresh" }, other: { sigma: 0, refStatus: "fresh" } });
		const afterFresh = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, fresh);
		expect(afterFresh.map((h) => h.id)).toEqual(["m", "other"]); // demotion lifted, m back on top.
		expect(afterFresh.find((h) => h.id === "m")!.refStatus).toBe("fresh");
	});
});

describe("PRD-058c neutral-on-missing — a hit with no verdict / unparseable σ is never demoted", () => {
	it("a hit absent from the verdict map keeps its order (factor 1, no staleness stamped)", () => {
		const hits = [hit("a", 1.0), hit("b", 0.9)];
		const resolved = staleness(1, {}); // empty map → both hits unknown.
		const out = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, resolved);
		expect(out.map((h) => h.id)).toEqual(["a", "b"]);
		expect(out.find((h) => h.id === "a")!.staleness).toBeUndefined();
	});

	it("an unparseable σ (NaN) is treated as 0 (neutral), never demoting the hit", () => {
		const hits = [hit("a", 1.0), hit("b", 0.9)];
		const resolved = staleness(1, { a: { sigma: Number.NaN, refStatus: "unknown" } });
		const out = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW, resolved);
		expect(out.map((h) => h.id)).toEqual(["a", "b"]); // NaN → σ 0 → factor 1.
		expect(out.find((h) => h.id === "a")!.staleness).toBe(0);
	});

	it("ABSENT staleness (no source) is the byte-for-byte pre-058c path (no fields stamped)", () => {
		const hits = [hit("a", 1.0), hit("b", 0.9)];
		const out = applyRecencyActivation(hits, undefined, DEFAULT_RECENCY_ACTIVATION_EXPONENT, NOW);
		expect(out.map((h) => h.id)).toEqual(["a", "b"]);
		expect(out.every((h) => h.staleness === undefined && h.refStatus === undefined)).toBe(true);
	});
});
