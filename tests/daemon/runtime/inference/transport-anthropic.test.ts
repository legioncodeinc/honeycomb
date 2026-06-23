/**
 * PRD-026 AC-T — Anthropic Messages transport tests.
 *
 * The real {@link createAnthropicTransport} is driven against an INJECTED fake
 * `fetch` — NO unit test touches the network. Each block proves one slice of the
 * contract the router depends on: the OpenAI → Anthropic request reshaping (system
 * split, `max_tokens` present, model from the target), the `content[]` → output
 * join, the HTTP status → thrown `ProviderError` mapping `providerStatus(thrown)`
 * reads, and the secret-never-leaked invariant (the api key never appears in a
 * thrown message or any captured fetch arg beyond the `x-api-key` header).
 */

import { describe, expect, it } from "vitest";

import {
	type InferenceRequest,
	ProviderError,
	type ProviderCall,
	type Target,
} from "../../../../src/daemon/runtime/inference/contracts.js";
import {
	ANTHROPIC_MESSAGES_URL,
	ANTHROPIC_VERSION,
	createAnthropicTransport,
	DEFAULT_MAX_TOKENS,
	type FetchLike,
	type FetchResponseLike,
} from "../../../../src/daemon/runtime/inference/transport-anthropic.js";

/** Mirror the router's `providerStatus` so the test asserts the exact extraction. */
function providerStatus(err: unknown): number {
	if (err instanceof ProviderError) return err.statusCode;
	return 500;
}

/** A throwaway target. */
function target(overrides: Partial<Target> = {}): Target {
	return {
		id: "sonnet",
		accountRef: "anthropic-main",
		model: "claude-sonnet-4-6",
		privacyTier: "private",
		capabilities: ["chat"],
		contextWindow: 200_000,
		...overrides,
	};
}

/** Build a {@link ProviderCall} with the given messages + apiKey. */
function call(messages: InferenceRequest["messages"], apiKey = "sk-ant-secret-KEY", maxTokens?: number): ProviderCall {
	const request: InferenceRequest = {
		requestId: "req-1",
		workload: "memory_pollinating",
		messages,
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
	return { target: target(), apiKey, request };
}

/** A success response carrying the given content blocks. */
function okResponse(content: unknown): FetchResponseLike {
	return {
		status: 200,
		ok: true,
		text: () => Promise.resolve(JSON.stringify({ content })),
	};
}

/** A captured-call recording fake `fetch` that always returns `response`. */
function recordingFetch(response: FetchResponseLike): {
	fetch: FetchLike;
	calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[];
} {
	const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
	const fetch: FetchLike = (url, init) => {
		calls.push({ url, init });
		return Promise.resolve(response);
	};
	return { fetch, calls };
}

describe("AC-T transport: request reshaping (system split, max_tokens, model)", () => {
	it("hoists system messages, keeps user/assistant, sets max_tokens + model + headers", async () => {
		const { fetch, calls } = recordingFetch(okResponse([{ type: "text", text: "ok" }]));
		const transport = createAnthropicTransport({ fetch });

		await transport.execute(
			call([
				{ role: "system", content: "you are a pollinator" },
				{ role: "user", content: "consolidate" },
				{ role: "assistant", content: "thinking" },
			]),
		);

		expect(calls).toHaveLength(1);
		const sent = calls[0];
		expect(sent?.url).toBe(ANTHROPIC_MESSAGES_URL);
		expect(sent?.init.method).toBe("POST");
		expect(sent?.init.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
		expect(sent?.init.headers["content-type"]).toBe("application/json");
		const body = JSON.parse(sent?.init.body ?? "{}") as {
			model: string;
			max_tokens: number;
			system?: string;
			messages: { role: string; content: string }[];
		};
		expect(body.model).toBe("claude-sonnet-4-6");
		expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
		expect(body.system).toBe("you are a pollinator");
		expect(body.messages).toEqual([
			{ role: "user", content: "consolidate" },
			{ role: "assistant", content: "thinking" },
		]);
	});

	it("uses request.maxTokens when supplied and joins multiple system messages", async () => {
		const { fetch, calls } = recordingFetch(okResponse([{ type: "text", text: "ok" }]));
		const transport = createAnthropicTransport({ fetch });

		await transport.execute(
			call(
				[
					{ role: "system", content: "rule one" },
					{ role: "system", content: "rule two" },
					{ role: "user", content: "go" },
				],
				"sk-ant-secret-KEY",
				512,
			),
		);

		const body = JSON.parse(calls[0]?.init.body ?? "{}") as { max_tokens: number; system?: string };
		expect(body.max_tokens).toBe(512);
		expect(body.system).toBe("rule one\n\nrule two");
	});
});

describe("AC-T transport: response content[] join → output", () => {
	it("joins only text blocks and skips non-text blocks", async () => {
		const { fetch } = recordingFetch(
			okResponse([
				{ type: "text", text: "Hello " },
				{ type: "tool_use", id: "x" },
				{ type: "text", text: "world" },
			]),
		);
		const transport = createAnthropicTransport({ fetch });

		const result = await transport.execute(call([{ role: "user", content: "hi" }]));
		expect(result.output).toBe("Hello world");
	});

	it("stream yields a single terminal chunk carrying the full text", async () => {
		const { fetch } = recordingFetch(okResponse([{ type: "text", text: "pollinated" }]));
		const transport = createAnthropicTransport({ fetch });

		const chunks: string[] = [];
		for await (const c of transport.stream(call([{ role: "user", content: "hi" }]))) {
			chunks.push(c.delta);
		}
		expect(chunks).toEqual(["pollinated"]);
	});
});

describe("AC-T transport: HTTP status → thrown ProviderError (providerStatus reads it)", () => {
	function errorResponse(status: number): FetchResponseLike {
		return {
			status,
			ok: false,
			// A hostile provider that echoes the key into the body — must NOT leak.
			text: () => Promise.resolve(`{"error":"boom sk-ant-secret-KEY"}`),
		};
	}

	for (const status of [401, 429, 500]) {
		it(`maps ${status} to a ProviderError whose statusCode providerStatus extracts`, async () => {
			const { fetch } = recordingFetch(errorResponse(status));
			const transport = createAnthropicTransport({ fetch });

			let thrown: unknown;
			try {
				await transport.execute(call([{ role: "user", content: "hi" }]));
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(ProviderError);
			expect(providerStatus(thrown)).toBe(status);
		});
	}

	it("maps a network failure to 503 and a malformed body to 502", async () => {
		const netFetch: FetchLike = () => Promise.reject(new Error("ECONNRESET"));
		const netTransport = createAnthropicTransport({ fetch: netFetch });
		await expect(netTransport.execute(call([{ role: "user", content: "hi" }]))).rejects.toMatchObject({
			statusCode: 503,
		});

		const badBody: FetchResponseLike = { status: 200, ok: true, text: () => Promise.resolve("not json") };
		const badTransport = createAnthropicTransport({ fetch: () => Promise.resolve(badBody) });
		await expect(badTransport.execute(call([{ role: "user", content: "hi" }]))).rejects.toMatchObject({
			statusCode: 502,
		});
	});
});

describe("AC-T transport: api key never leaks (thrown message / body), only the header", () => {
	it("never includes the key in a thrown error message", async () => {
		const errorResponse: FetchResponseLike = {
			status: 403,
			ok: false,
			text: () => Promise.resolve(`{"error":"key sk-ant-secret-KEY rejected"}`),
		};
		const { fetch } = recordingFetch(errorResponse);
		const transport = createAnthropicTransport({ fetch });

		let message = "";
		try {
			await transport.execute(call([{ role: "user", content: "hi" }], "sk-ant-secret-KEY"));
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).not.toContain("sk-ant-secret-KEY");
		expect(message).toContain("403");
	});

	it("places the key ONLY in the x-api-key header, never the URL or body", async () => {
		const { fetch, calls } = recordingFetch(okResponse([{ type: "text", text: "ok" }]));
		const transport = createAnthropicTransport({ fetch });

		await transport.execute(call([{ role: "user", content: "hi" }], "sk-ant-secret-KEY"));
		const sent = calls[0];
		expect(sent?.init.headers["x-api-key"]).toBe("sk-ant-secret-KEY");
		expect(sent?.url).not.toContain("sk-ant-secret-KEY");
		expect(sent?.init.body).not.toContain("sk-ant-secret-KEY");
	});
});
