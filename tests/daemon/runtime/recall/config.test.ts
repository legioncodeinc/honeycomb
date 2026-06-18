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
		// D-4 reranker.
		expect(config.reranker.strategy).toBe("embedding-cosine");
		expect(config.reranker.timeoutMs).toBe(300);
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
