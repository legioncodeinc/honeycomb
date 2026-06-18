/**
 * PRD-010 Wave 1 — contracts + router HARNESS smoke (the seams 010b/010c inherit).
 *
 * Not an AC test (010b owns the engine ACs) — this proves the Wave-1 SHAPE is
 * honest: the privacy comparator orders correctly, the trivial `explain` resolves
 * + records a redacted event, the multi-candidate path is an honest
 * `notImplemented` thrower (never fake-passing), the stream cancel handle is keyed
 * by request id, and the `RouterModelClient` bridge maps the 006 workload onto the
 * router. So Wave 2 inherits a verified skeleton.
 */

import { describe, expect, it } from "vitest";
import {
	createFakeProviderTransport,
	createFakeSecretResolver,
	type InferenceConfig,
	type RedactedRoutingEvent,
	type RoutingHistoryScope,
	type RoutingHistoryStore,
	tierRank,
	tierSatisfies,
} from "../../../../src/daemon/runtime/inference/contracts.js";
import { createInferenceRouter, RouterModelClient } from "../../../../src/daemon/runtime/inference/router.js";

/** A capturing in-memory history store so a test asserts the recorded redacted event. */
function capturingHistory(): RoutingHistoryStore & { events: RedactedRoutingEvent[] } {
	const events: RedactedRoutingEvent[] = [];
	return {
		events,
		record(event: RedactedRoutingEvent): Promise<void> {
			events.push(event);
			return Promise.resolve();
		},
		recent(_scope: RoutingHistoryScope, _limit: number): Promise<RedactedRoutingEvent[]> {
			return Promise.resolve([...events]);
		},
	};
}

/** A config with a single-target strict policy (the trivial case Wave 1 resolves). */
function singleTargetConfig(): InferenceConfig {
	return {
		accounts: [{ id: "acct", provider: "anthropic", apiKeyRef: "${KEY}" }],
		targets: [
			{
				id: "sonnet",
				accountRef: "acct",
				model: "claude-sonnet-4",
				privacyTier: "private",
				capabilities: ["chat"],
				contextWindow: 200_000,
			},
		],
		policies: [{ id: "p", mode: "strict", chain: ["sonnet"] }],
		workloads: [
			{ name: "memory_extraction", policyRef: "p", requiredCapabilities: ["chat"], minPrivacyTier: "public" },
		],
	};
}

/** A config with a TWO-target strict policy (the multi-candidate path = 010b stub). */
function twoTargetConfig(): InferenceConfig {
	const base = singleTargetConfig();
	return {
		...base,
		targets: [
			...base.targets,
			{
				id: "haiku",
				accountRef: "acct",
				model: "claude-haiku-4",
				privacyTier: "public",
				capabilities: ["chat"],
				contextWindow: 100_000,
			},
		],
		policies: [{ id: "p", mode: "strict", chain: ["sonnet", "haiku"] }],
	};
}

describe("PrivacyTier comparator (the pinned ordering Wave 2 inherits)", () => {
	it("orders public < private < restricted", () => {
		expect(tierRank("public")).toBeLessThan(tierRank("private"));
		expect(tierRank("private")).toBeLessThan(tierRank("restricted"));
	});

	it("tierSatisfies: a target at least as private as the floor passes; less private is blocked", () => {
		expect(tierSatisfies("restricted", "private")).toBe(true); // more private passes
		expect(tierSatisfies("private", "private")).toBe(true); // equal passes
		expect(tierSatisfies("public", "private")).toBe(false); // less private blocked
	});
});

describe("router harness: trivial explain works and records a redacted event", () => {
	it("resolves a single-target policy to that target without executing", async () => {
		const history = capturingHistory();
		const router = createInferenceRouter({
			config: singleTargetConfig(),
			transport: createFakeProviderTransport({}),
			secrets: createFakeSecretResolver({}),
			history,
		});
		const decision = await router.explain({
			requestId: "r1",
			workload: "memory_extraction",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(decision.servingTarget).toBe("sonnet");
		expect(decision.attempts).toEqual([{ targetId: "sonnet", outcome: "selected" }]);
		// A redacted event was recorded, carrying no message body.
		expect(history.events).toHaveLength(1);
		expect(JSON.stringify(history.events[0])).not.toContain("hi");
	});

	it("the multi-candidate path now resolves through the 010b gate+mode pipeline (filled in Wave 2)", async () => {
		// Wave 2 (010b) filled the gate+mode pipeline; the multi-candidate explain that
		// was an honest notImplemented thrower in Wave 1 now resolves to the strict head.
		const router = createInferenceRouter({
			config: twoTargetConfig(),
			transport: createFakeProviderTransport({}),
			secrets: createFakeSecretResolver({}),
			history: capturingHistory(),
		});
		const decision = await router.explain({ requestId: "r2", workload: "memory_extraction", messages: [] });
		expect(decision.servingTarget).toBe("sonnet"); // strict chain head
	});

	it("execute now runs the filled fallback path and returns the serving output (Wave 2)", async () => {
		// Wave 2 (010b) filled executeWithFallback; execute against a served target now
		// returns the provider output rather than throwing the Wave-1 stub.
		const router = createInferenceRouter({
			config: singleTargetConfig(),
			transport: createFakeProviderTransport({ sonnet: { text: "ok" } }),
			secrets: createFakeSecretResolver({ "${KEY}": "secret-value" }),
			history: capturingHistory(),
		});
		const result = await router.execute({ requestId: "r3", workload: "memory_extraction", messages: [] });
		expect(result.output).toBe("ok");
		expect(result.decision.servingTarget).toBe("sonnet");
	});

	it("cancel returns false for an unknown request id (no active stream)", () => {
		const router = createInferenceRouter({
			config: singleTargetConfig(),
			transport: createFakeProviderTransport({}),
			secrets: createFakeSecretResolver({}),
			history: capturingHistory(),
		});
		expect(router.cancel("nope")).toBe(false);
	});
});

describe("RouterModelClient bridge (D-9): maps the 006 workload onto the router", () => {
	it("routes a memory_extraction completion through the filled router and returns the output", async () => {
		const router = createInferenceRouter({
			config: singleTargetConfig(),
			transport: createFakeProviderTransport({ sonnet: { text: "out" } }),
			secrets: createFakeSecretResolver({ "${KEY}": "secret-value" }),
			history: capturingHistory(),
		});
		const client = new RouterModelClient(router);
		// Wave 2 (010b) filled executeWithFallback; the bridge now returns the raw
		// completion string the serving target produced (raw-text-in / raw-text-out).
		await expect(client.complete("memory_extraction", "prompt")).resolves.toBe("out");
	});
});
