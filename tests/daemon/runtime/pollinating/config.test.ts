/**
 * PRD-009 pollinating config + contracts — boundary validation.
 *
 * Proves the zod boundaries: the `memory.pollinating` config defaults + clamping
 * (D-2), and the contract parsers (job payload + mutation set + the mutation→
 * operation mapping that routes destructive ops to review).
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_MAX_INPUT_TOKENS,
	DEFAULT_TOKEN_THRESHOLD,
	PollinatingConfigError,
	resolvePollinatingConfig,
} from "../../../../src/daemon/runtime/pollinating/config.js";
import {
	POLLINATING_MUTATION_KINDS,
	MUTATION_KIND_TO_OPERATION,
	parsePollinatingJobPayload,
	parsePollinatingMutationSet,
} from "../../../../src/daemon/runtime/pollinating/contracts.js";

describe("pollinating config (memory.pollinating) boundary", () => {
	it("defaults: disabled, 100k threshold, 128k max input, backfill on", () => {
		const cfg = resolvePollinatingConfig({ read: () => ({}) });
		expect(cfg.enabled).toBe(false); // premium tier: off unless enabled.
		expect(cfg.tokenThreshold).toBe(DEFAULT_TOKEN_THRESHOLD);
		expect(cfg.maxInputTokens).toBe(DEFAULT_MAX_INPUT_TOKENS);
		expect(cfg.backfillOnFirstRun).toBe(true);
	});

	it("coerces env flags and clamps a fat-fingered threshold rather than failing", () => {
		const cfg = resolvePollinatingConfig({
			read: () => ({ enabled: "true", tokenThreshold: "abc", maxInputTokens: "50000", backfillOnFirstRun: "0" }),
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.tokenThreshold).toBe(DEFAULT_TOKEN_THRESHOLD); // non-numeric → default.
		expect(cfg.maxInputTokens).toBe(50_000);
		expect(cfg.backfillOnFirstRun).toBe(false);
	});

	it("exposes a structured error type for a structurally-impossible config", () => {
		expect(PollinatingConfigError).toBeTypeOf("function");
	});
});

describe("pollinating contracts boundary", () => {
	it("parses a pollinating-job payload, defaulting mode to incremental", () => {
		expect(parsePollinatingJobPayload({ agentId: "a1" })?.mode).toBe("incremental");
		expect(parsePollinatingJobPayload({ mode: "compaction", agentId: "a1" })?.mode).toBe("compaction");
		expect(parsePollinatingJobPayload({ mode: "bogus" })).toBeNull();
	});

	it("parses a mutation set and drops a malformed one", () => {
		const set = parsePollinatingMutationSet({
			summary: "s",
			mutations: [{ kind: "create_entity", payload: { name: "x" }, confidence: 0.8 }],
		});
		expect(set?.mutations).toHaveLength(1);
		expect(parsePollinatingMutationSet({ mutations: [{ kind: "not_a_kind" }] })).toBeNull();
	});

	it("maps every mutation kind to a control-plane operation; destructive ops are non-bounded", () => {
		for (const kind of POLLINATING_MUTATION_KINDS) {
			expect(MUTATION_KIND_TO_OPERATION[kind]).toBeTruthy();
		}
		// The destructive kinds map to operations OUTSIDE the 008c direct-apply allow-list.
		expect(MUTATION_KIND_TO_OPERATION.merge_entities).toBe("entity.merge");
		expect(MUTATION_KIND_TO_OPERATION.delete_entity).toBe("entity.archive");
		expect(MUTATION_KIND_TO_OPERATION.delete_attribute).toBe("claim.archive");
	});
});
