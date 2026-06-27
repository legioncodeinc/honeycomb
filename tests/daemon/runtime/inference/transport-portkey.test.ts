/**
 * PRD-063b — Portkey gateway transport tests (b-AC-1 / b-AC-3 / b-AC-6 / b-AC-7).
 *
 * The real {@link createPortkeyTransport} is driven against an INJECTED fake `fetch` — NO unit
 * test touches the network. Each block proves one slice of the contract:
 *   - the request hits the Portkey base URL with the resolved key in `x-portkey-api-key` and the
 *     config id in `x-portkey-config` (b-AC-1 / b-AC-2 wire shape);
 *   - the OpenAI-shaped `choices[].message.content` → output join, and `activeModel` is sent (D-2);
 *   - the resolved key appears in NO thrown message + NO captured fetch arg beyond its header (b-AC-3);
 *   - the OpenAI `usage` block is surfaced through the shared {@link UsageSink} (b-AC-6);
 *   - the HTTP status → thrown `ProviderError` mapping + the `onTransportError` signal (b-AC-7).
 */

import { describe, expect, it } from "vitest";

import {
	type InferenceRequest,
	ProviderError,
	type ProviderCall,
	type Target,
} from "../../../../src/daemon/runtime/inference/contracts.js";
import {
	type FetchLike,
	type FetchResponseLike,
	type UsageReport,
	type UsageSink,
} from "../../../../src/daemon/runtime/inference/transport-anthropic.js";
import {
	createPortkeyTransport,
	PORTKEY_API_KEY_HEADER,
	PORTKEY_CHAT_COMPLETIONS_URL,
	PORTKEY_CONFIG_HEADER,
} from "../../../../src/daemon/runtime/inference/transport-portkey.js";

const PORTKEY_KEY = "pk-portkey-secret-KEY-DEADBEEF";
const CONFIG_ID = "pc-cfg-12345";

function target(overrides: Partial<Target> = {}): Target {
	return {
		id: "portkey-target",
		accountRef: "portkey-gateway",
		model: "claude-sonnet-4-6",
		privacyTier: "public",
		capabilities: ["chat"],
		contextWindow: 1_000_000,
		...overrides,
	};
}

function call(messages: InferenceRequest["messages"], apiKey = PORTKEY_KEY): ProviderCall {
	const request: InferenceRequest = { requestId: "req-1", workload: "memory_pollinating", messages };
	return { target: target(), apiKey, request };
}

/** A success response carrying the given OpenAI-shaped choices + usage. */
function okResponse(body: unknown): FetchResponseLike {
	return { status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(body)) };
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

/** A recording usage sink. */
function recordingSink(): { sink: UsageSink; reports: UsageReport[] } {
	const reports: UsageReport[] = [];
	return { sink: { record: (r) => reports.push(r) }, reports };
}

describe("b-AC-1 the request hits the Portkey URL with the auth + config headers", () => {
	it("POSTs the default Portkey base URL with x-portkey-api-key + x-portkey-config", async () => {
		const { fetch, calls } = recordingFetch(
			okResponse({ choices: [{ message: { content: "OUT" } }] }),
		);
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch });
		const res = await transport.execute(call([{ role: "user", content: "hi" }]));

		expect(res.output).toBe("OUT");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(PORTKEY_CHAT_COMPLETIONS_URL);
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.headers[PORTKEY_API_KEY_HEADER]).toBe(PORTKEY_KEY);
		expect(calls[0]?.init.headers[PORTKEY_CONFIG_HEADER]).toBe(CONFIG_ID);
	});

	it("sends activeModel as the requested model (D-2) and passes messages through verbatim (OpenAI-compatible)", async () => {
		const { fetch, calls } = recordingFetch(okResponse({ choices: [{ message: { content: "x" } }] }));
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch });
		await transport.execute({
			target: target({ model: "gpt-some-model" }),
			apiKey: PORTKEY_KEY,
			request: {
				requestId: "r",
				workload: "memory_pollinating",
				messages: [
					{ role: "system", content: "S" },
					{ role: "user", content: "U" },
				],
			},
		});
		const sent = JSON.parse(calls[0]?.init.body ?? "{}") as {
			model: string;
			messages: { role: string; content: string }[];
		};
		expect(sent.model, "the target model is the requested model (D-2)").toBe("gpt-some-model");
		// OpenAI-compatible: system is NOT hoisted (unlike the Anthropic transport) — passed verbatim.
		expect(sent.messages).toEqual([
			{ role: "system", content: "S" },
			{ role: "user", content: "U" },
		]);
	});

	it("joins multiple choice contents into the output", async () => {
		const { fetch } = recordingFetch(
			okResponse({ choices: [{ message: { content: "A" } }, { message: { content: "B" } }] }),
		);
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch });
		const res = await transport.execute(call([{ role: "user", content: "hi" }]));
		expect(res.output).toBe("AB");
	});
});

describe("b-AC-3 the resolved key never leaks (no thrown message, no captured arg beyond its header)", () => {
	it("a non-2xx throws a ProviderError whose message carries the status but NOT the key", async () => {
		const { fetch } = recordingFetch({ status: 401, ok: false, text: () => Promise.resolve("unauthorized: pk-...") });
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch });
		await expect(transport.execute(call([{ role: "user", content: "hi" }]))).rejects.toMatchObject({
			statusCode: 401,
		});
		try {
			await transport.execute(call([{ role: "user", content: "hi" }]));
		} catch (err) {
			expect(err).toBeInstanceOf(ProviderError);
			expect((err as Error).message).not.toContain(PORTKEY_KEY);
			// The thrown message is a short status string, NEVER the (potentially key-echoing) body.
			expect((err as Error).message).not.toContain("unauthorized");
		}
	});

	it("the key appears ONLY in the x-portkey-api-key header — never in the URL or the body", async () => {
		const { fetch, calls } = recordingFetch(okResponse({ choices: [{ message: { content: "x" } }] }));
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch });
		await transport.execute(call([{ role: "user", content: "secret-prompt" }]));
		const captured = calls[0];
		expect(captured?.url).not.toContain(PORTKEY_KEY);
		expect(captured?.init.body).not.toContain(PORTKEY_KEY);
		const headerHits = Object.entries(captured?.init.headers ?? {}).filter(([, v]) => v === PORTKEY_KEY);
		expect(headerHits.map(([k]) => k)).toEqual([PORTKEY_API_KEY_HEADER]);
	});
});

describe("b-AC-6 usage is surfaced through the shared UsageSink (ROI keeps capturing under Portkey)", () => {
	it("maps prompt_tokens/completion_tokens (+ cached) from a representative Portkey response", async () => {
		const { sink, reports } = recordingSink();
		const { fetch } = recordingFetch(
			okResponse({
				choices: [{ message: { content: "OUT" } }],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 34,
					total_tokens: 154,
					prompt_tokens_details: { cached_tokens: 40 },
				},
			}),
		);
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch, usageSink: sink });
		await transport.execute(call([{ role: "user", content: "hi" }]));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			model: "claude-sonnet-4-6",
			workload: "memory_pollinating",
			inputTokens: 120,
			outputTokens: 34,
			cacheReadInputTokens: 40,
			cacheCreationInputTokens: 0,
		});
	});

	it("a response with no usage surfaces zero counts (never throws, never drops the completion)", async () => {
		const { sink, reports } = recordingSink();
		const { fetch } = recordingFetch(okResponse({ choices: [{ message: { content: "OUT" } }] }));
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch, usageSink: sink });
		const res = await transport.execute(call([{ role: "user", content: "hi" }]));
		expect(res.output).toBe("OUT");
		expect(reports[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });
	});

	it("a thrown call reports NO usage (the sink is fed only on success)", async () => {
		const { sink, reports } = recordingSink();
		const { fetch } = recordingFetch({ status: 500, ok: false, text: () => Promise.resolve("err") });
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch, usageSink: sink });
		await expect(transport.execute(call([{ role: "user", content: "hi" }]))).rejects.toBeInstanceOf(ProviderError);
		expect(reports).toHaveLength(0);
	});
});

describe("b-AC-7 the onTransportError signal fires on an observed gateway failure (never on success/malformed-only)", () => {
	it("a network failure → 503 ProviderError + a 503 signal", async () => {
		const seen: number[] = [];
		const failingFetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch: failingFetch, onTransportError: (s) => seen.push(s) });
		await expect(transport.execute(call([{ role: "user", content: "hi" }]))).rejects.toMatchObject({ statusCode: 503 });
		expect(seen).toEqual([503]);
	});

	it("an auth-rejection (401) → a 401 signal", async () => {
		const seen: number[] = [];
		const { fetch } = recordingFetch({ status: 401, ok: false, text: () => Promise.resolve("nope") });
		const transport = createPortkeyTransport({ config: CONFIG_ID, fetch, onTransportError: (s) => seen.push(s) });
		await expect(transport.execute(call([{ role: "user", content: "hi" }]))).rejects.toMatchObject({ statusCode: 401 });
		expect(seen).toEqual([401]);
	});

	it("a SUCCESS fires NO signal; a malformed-but-reachable body (502) fires NO signal", async () => {
		const seen: number[] = [];
		const okFetch = recordingFetch(okResponse({ choices: [{ message: { content: "x" } }] }));
		const okTransport = createPortkeyTransport({ config: CONFIG_ID, fetch: okFetch.fetch, onTransportError: (s) => seen.push(s) });
		await okTransport.execute(call([{ role: "user", content: "hi" }]));
		expect(seen, "success → no unreachable signal").toEqual([]);

		// A reachable gateway that returns a non-JSON / malformed body is a 502 (gateway WAS reached) —
		// it must NOT be reported as unreachable.
		const badFetch: FetchLike = () => Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve("not json") });
		const badTransport = createPortkeyTransport({ config: CONFIG_ID, fetch: badFetch, onTransportError: (s) => seen.push(s) });
		await expect(badTransport.execute(call([{ role: "user", content: "hi" }]))).rejects.toMatchObject({ statusCode: 502 });
		expect(seen, "malformed-but-reachable → still no unreachable signal").toEqual([]);
	});
});
