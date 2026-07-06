/**
 * PRD-007 recall config — Wave 1. Proves the D-1..D-6 defaults, the coerce/clamp
 * posture (a typo never takes the daemon down), and the env-provider wiring.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_HINT_CAP,
	DEFAULT_MIN_INJECTION_SCORE,
	DEFAULT_OVER_FETCH_MULTIPLIER,
	RecallConfigError,
	envRecallConfigProvider,
	resolveRecallConfig,
} from "../../../../src/daemon/runtime/recall/config.js";

describe("recall config — D-1..D-6 defaults", () => {
	it("resolves the documented defaults from an empty record", () => {
		const config = resolveRecallConfig({ read: () => ({}) });
		expect(config.overFetchMultiplier).toBe(DEFAULT_OVER_FETCH_MULTIPLIER); // D-1: 3.
		expect(config.hintCap).toBe(DEFAULT_HINT_CAP); // D-2: 3.
		expect(config.keywordExpansion).toBe(false); // D-2: OFF by default.
		expect(config.minInjectionScore).toBe(DEFAULT_MIN_INJECTION_SCORE); // D-6: 0.6.
		expect(config.graphEnabled).toBe(false);
		// D-3 traversal budgets.
		expect(config.traversal.aspectsPerEntity).toBe(10);
		expect(config.traversal.attrsPerAspect).toBe(20);
		expect(config.traversal.branching).toBe(5);
		expect(config.traversal.totalIds).toBe(100);
		expect(config.traversal.minEdgeWeight).toBe(0.3);
		expect(config.traversal.timeoutMs).toBe(500);
		// D-4 reranker (+ PRD-047b window). Default strategy is `none` (b-AC-3: the
		// embedding-cosine rerank measured ~0 lift on the synthetic golden set, so the
		// eval-driven default keeps RRF order; cosine/llm stay activatable via config).
		expect(config.reranker.strategy).toBe("none");
		expect(config.reranker.timeoutMs).toBe(300);
		expect(config.reranker.window).toBe(50);
		// PRD-047c dedup: ON by default (c-AC-3 — the direct fix for the ~12-clone eval
		// problem, neutral-or-better), threshold tuned HIGH (0.9) to avoid false merges.
		expect(config.dedup.enabled).toBe(true);
		expect(config.dedup.similarityThreshold).toBe(0.9);
	});
});

describe("recall config — PRD-047c dedup knobs", () => {
	it("the threshold clamps into [0,1] and a typo falls back to the default", () => {
		expect(resolveRecallConfig({ read: () => ({ dedup: { similarityThreshold: 1.5 } }) }).dedup.similarityThreshold).toBe(1);
		expect(resolveRecallConfig({ read: () => ({ dedup: { similarityThreshold: -1 } }) }).dedup.similarityThreshold).toBe(0);
		expect(resolveRecallConfig({ read: () => ({ dedup: { similarityThreshold: "nope" } }) }).dedup.similarityThreshold).toBe(0.9);
	});

	it("dedup can be turned OFF via the flag (escape hatch)", () => {
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: "false" } }) }).dedup.enabled).toBe(false);
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: "0" } }) }).dedup.enabled).toBe(false);
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: "true" } }) }).dedup.enabled).toBe(true);
	});

	it("trims surrounding whitespace on the dedup flag (the trailing-space env class)", () => {
		// A Windows scheduled-task `set "VAR=true" && …` chain leaks a trailing space; the trim keeps
		// `"true "` / `" true "` reading as ON and `"false "` / junk as OFF.
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: "true " } }) }).dedup.enabled).toBe(true);
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: " true " } }) }).dedup.enabled).toBe(true);
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: "false " } }) }).dedup.enabled).toBe(false);
		expect(resolveRecallConfig({ read: () => ({ dedup: { enabled: " nope " } }) }).dedup.enabled).toBe(false);
	});

	it("maps the dedup env vars from the env provider", () => {
		const provider = envRecallConfigProvider({
			HONEYCOMB_RECALL_DEDUP_ENABLED: "false",
			HONEYCOMB_RECALL_DEDUP_SIMILARITY_THRESHOLD: "0.95",
		} as NodeJS.ProcessEnv);
		const config = resolveRecallConfig(provider);
		expect(config.dedup.enabled).toBe(false);
		expect(config.dedup.similarityThreshold).toBe(0.95);
	});
});

describe("recall config — PRD-047b reranker window", () => {
	it("clamps a sub-1 window up to 1 and truncates a float", () => {
		expect(resolveRecallConfig({ read: () => ({ reranker: { window: 0 } }) }).reranker.window).toBe(1);
		expect(resolveRecallConfig({ read: () => ({ reranker: { window: 75.9 } }) }).reranker.window).toBe(75);
	});

	it("a non-numeric window falls back to the default (50)", () => {
		expect(resolveRecallConfig({ read: () => ({ reranker: { window: "nope" } }) }).reranker.window).toBe(50);
	});

	it("maps HONEYCOMB_RECALL_RERANKER_WINDOW from the env provider", () => {
		const provider = envRecallConfigProvider({ HONEYCOMB_RECALL_RERANKER_WINDOW: "20" } as NodeJS.ProcessEnv);
		expect(resolveRecallConfig(provider).reranker.window).toBe(20);
	});
});

describe("recall config — coerce/clamp (a typo never takes the daemon down)", () => {
	it("a non-numeric over-fetch falls back to the default", () => {
		const config = resolveRecallConfig({ read: () => ({ overFetchMultiplier: "not-a-number" }) });
		expect(config.overFetchMultiplier).toBe(DEFAULT_OVER_FETCH_MULTIPLIER);
	});

	it("an out-of-range injection score is clamped into [0,1]", () => {
		expect(resolveRecallConfig({ read: () => ({ minInjectionScore: 5 }) }).minInjectionScore).toBe(1);
		expect(resolveRecallConfig({ read: () => ({ minInjectionScore: -2 }) }).minInjectionScore).toBe(0);
	});

	it("a boolean flag reads true/1 as true, anything else false", () => {
		expect(resolveRecallConfig({ read: () => ({ keywordExpansion: "true" }) }).keywordExpansion).toBe(true);
		expect(resolveRecallConfig({ read: () => ({ keywordExpansion: "1" }) }).keywordExpansion).toBe(true);
		expect(resolveRecallConfig({ read: () => ({ keywordExpansion: "yes" }) }).keywordExpansion).toBe(false);
	});

	it("an unknown reranker strategy passed explicitly throws RecallConfigError", () => {
		expect(() => resolveRecallConfig({ read: () => ({ reranker: { strategy: "magic" } }) })).toThrow(RecallConfigError);
	});
});

describe("recall config — env provider", () => {
	it("maps HONEYCOMB_RECALL_* env keys onto the raw record", () => {
		const provider = envRecallConfigProvider({
			HONEYCOMB_RECALL_OVER_FETCH_MULTIPLIER: "5",
			HONEYCOMB_RECALL_HINT_CAP: "2",
			HONEYCOMB_RECALL_MIN_INJECTION_SCORE: "0.8",
		} as NodeJS.ProcessEnv);
		const config = resolveRecallConfig(provider);
		expect(config.overFetchMultiplier).toBe(5);
		expect(config.hintCap).toBe(2);
		expect(config.minInjectionScore).toBe(0.8);
	});
});
