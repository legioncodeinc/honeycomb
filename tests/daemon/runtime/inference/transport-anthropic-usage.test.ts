/**
 * PRD-060d / d-AC-1 — the Anthropic transport surfaces the `usage` it historically discarded.
 *
 * The transport used to parse ONLY `content` and drop the response's `usage` block. PRD-060d
 * needs Honeycomb's OWN inference (the Haiku skillify gate) token cost, so the transport now
 * ADDITIVELY surfaces `usage` through an injectable {@link UsageSink}. These tests prove:
 *   - input/output (+ cache) token counts are CAPTURED from a transport response, not dropped;
 *   - the report is attributed with the call's model + workload;
 *   - both `execute` AND `stream` feed the sink (the pollinating path streams);
 *   - the sink is fed ONLY on success — a thrown {@link ProviderError} reports nothing;
 *   - a missing/malformed `usage` surfaces zero counts (never a throw);
 *   - a transport built WITHOUT a sink is byte-for-byte unchanged (no regression).
 *
 * Driven against an INJECTED fake `fetch` — NO unit test touches the network.
 */

import { describe, expect, it } from "vitest";

import {
	type InferenceRequest,
	ProviderError,
	type ProviderCall,
	type Target,
} from "../../../../src/daemon/runtime/inference/contracts.js";
import {
	createAnthropicTransport,
	type FetchLike,
	type FetchResponseLike,
	type UsageReport,
	type UsageSink,
} from "../../../../src/daemon/runtime/inference/transport-anthropic.js";

/** A Haiku target (the skillify-gate model the meter prices). */
function target(overrides: Partial<Target> = {}): Target {
	return {
		id: "haiku",
		accountRef: "anthropic-main",
		model: "claude-haiku-4-5",
		privacyTier: "private",
		capabilities: ["chat"],
		contextWindow: 200_000,
		...overrides,
	};
}

/** Build a {@link ProviderCall}. */
function call(workload = "memory_pollinating"): ProviderCall {
	const request: InferenceRequest = {
		requestId: "req-1",
		workload,
		messages: [{ role: "user", content: "mine this" }],
	};
	return { target: target(), apiKey: "sk-ant-secret-KEY", request };
}

/** A 200 OK response carrying the given content + usage blocks. */
function okResponse(content: unknown, usage?: unknown): FetchResponseLike {
	const body = usage === undefined ? { content } : { content, usage };
	return { status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(body)) };
}

/** A fake fetch that always returns `response`. */
function fetchReturning(response: FetchResponseLike): FetchLike {
	return () => Promise.resolve(response);
}

/** A recording sink that captures every report. */
function recordingSink(): UsageSink & { reports: UsageReport[] } {
	const reports: UsageReport[] = [];
	return { reports, record: (r) => reports.push(r) };
}

describe("d-AC-1: transport surfaces usage on a successful execute (captured, not dropped)", () => {
	it("captures input/output + cache token counts from the response usage block", async () => {
		const sink = recordingSink();
		const transport = createAnthropicTransport({
			fetch: fetchReturning(
				okResponse([{ type: "text", text: "ok" }], {
					input_tokens: 1234,
					output_tokens: 567,
					cache_read_input_tokens: 800,
					cache_creation_input_tokens: 40,
				}),
			),
			usageSink: sink,
		});

		const result = await transport.execute(call());

		// The completion is unchanged (behavior-preserving).
		expect(result.output).toBe("ok");
		// The usage was CAPTURED, not dropped (d-AC-1).
		expect(sink.reports).toHaveLength(1);
		const report = sink.reports[0];
		expect(report?.inputTokens).toBe(1234);
		expect(report?.outputTokens).toBe(567);
		expect(report?.cacheReadInputTokens).toBe(800);
		expect(report?.cacheCreationInputTokens).toBe(40);
		// Attributed with the call's model + workload (so the meter prices Haiku + scopes).
		expect(report?.model).toBe("claude-haiku-4-5");
		expect(report?.workload).toBe("memory_pollinating");
	});

	it("stream() also feeds the sink (the pollinating path streams a whole completion)", async () => {
		const sink = recordingSink();
		const transport = createAnthropicTransport({
			fetch: fetchReturning(
				okResponse([{ type: "text", text: "pollinated" }], { input_tokens: 10, output_tokens: 3 }),
			),
			usageSink: sink,
		});

		const chunks: string[] = [];
		for await (const c of transport.stream(call())) chunks.push(c.delta);

		expect(chunks).toEqual(["pollinated"]);
		expect(sink.reports).toHaveLength(1);
		expect(sink.reports[0]?.inputTokens).toBe(10);
		expect(sink.reports[0]?.outputTokens).toBe(3);
		// Fields absent from the response usage default to 0 (surfaced, never NaN/throw).
		expect(sink.reports[0]?.cacheReadInputTokens).toBe(0);
		expect(sink.reports[0]?.cacheCreationInputTokens).toBe(0);
	});
});

describe("d-AC-1: usage is surfaced ONLY on success + degrades safely", () => {
	it("a thrown ProviderError reports NO usage (the sink is fed only on success)", async () => {
		const sink = recordingSink();
		const errorResponse: FetchResponseLike = {
			status: 500,
			ok: false,
			text: () => Promise.resolve("upstream boom"),
		};
		const transport = createAnthropicTransport({ fetch: fetchReturning(errorResponse), usageSink: sink });

		await expect(transport.execute(call())).rejects.toBeInstanceOf(ProviderError);
		expect(sink.reports).toHaveLength(0);
	});

	it("a response with NO usage block surfaces zero counts (never throws)", async () => {
		const sink = recordingSink();
		const transport = createAnthropicTransport({
			fetch: fetchReturning(okResponse([{ type: "text", text: "ok" }])),
			usageSink: sink,
		});

		const result = await transport.execute(call());
		expect(result.output).toBe("ok");
		expect(sink.reports).toHaveLength(1);
		expect(sink.reports[0]).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	it("a malformed usage field degrades to 0 for that field (defensive, no throw)", async () => {
		const sink = recordingSink();
		const transport = createAnthropicTransport({
			fetch: fetchReturning(
				okResponse([{ type: "text", text: "ok" }], {
					input_tokens: "not-a-number",
					output_tokens: 99,
				}),
			),
			usageSink: sink,
		});

		await transport.execute(call());
		expect(sink.reports[0]?.inputTokens).toBe(0); // malformed → 0
		expect(sink.reports[0]?.outputTokens).toBe(99); // the good field still lands
	});

	it("a sink that throws never breaks the inference call (hot-path safe)", async () => {
		const throwingSink: UsageSink = {
			record: () => {
				throw new Error("sink fault");
			},
		};
		const transport = createAnthropicTransport({
			fetch: fetchReturning(okResponse([{ type: "text", text: "ok" }], { input_tokens: 5 })),
			usageSink: throwingSink,
		});

		// The sink fault is swallowed — execute still resolves with the completion.
		await expect(transport.execute(call())).resolves.toEqual({ output: "ok" });
	});
});

describe("d-AC-1: a transport built without a sink is unchanged (no regression)", () => {
	it("executes + returns the completion with no sink wired", async () => {
		const transport = createAnthropicTransport({
			fetch: fetchReturning(okResponse([{ type: "text", text: "ok" }], { input_tokens: 7 })),
		});
		await expect(transport.execute(call())).resolves.toEqual({ output: "ok" });
	});
});
