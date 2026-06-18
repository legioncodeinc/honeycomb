/**
 * PRD-010c gateway suite — c-AC-1..c-AC-6 (FR-1..10).
 *
 * Verification posture (EXECUTION_LEDGER-prd-010): in-process via
 * `daemon.app.request(...)` against a daemon constructed in LOCAL mode (permission
 * open — the gateway's auth is the bootstrap's, not under test here). The gateway
 * is mounted AFTER `createDaemon(...)` via `mountInferenceGateway(...)` onto the
 * pre-scaffolded `/api/inference` + `/v1` groups, so it inherits the bootstrap
 * middleware with no re-wiring. No socket is bound.
 *
 * The unit boundary is the HTTP SHAPE MAPPING, NOT routing logic: every test drives
 * the handlers against a FAKE {@link InferenceRouter} (canned decisions + a canned
 * async-iterable stream + a `cancel` spy) and a fake {@link RoutingHistoryStore}.
 * 010b's real engine is never imported. Each `describe` is named after the c-AC it
 * proves so the ledger maps one-to-one to a passing test.
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import {
	type InferenceConfig,
	type InferenceRequest,
	type InferenceRouter,
	ProviderError,
	type ProviderChunk,
	type RedactedRoutingEvent,
	type RoutingDecision,
	type RoutingHistoryScope,
	type RoutingHistoryStore,
	type StreamResult,
} from "../../../../src/daemon/runtime/inference/contracts.js";
import {
	type InferenceGatewayDeps,
	MAX_REQUEST_BODY_BYTES,
	mountInferenceGateway,
} from "../../../../src/daemon/runtime/inference/gateway.js";

// ── Test scaffolding ─────────────────────────────────────────────────────────

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

/** Build a resolved local-mode config (permission open; the gateway mapping is the focus). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** The `x-honeycomb-*` headers a scoped request carries. */
function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		...extra,
	};
}

/** A serving decision for `workload`, served by `target`. */
function servedDecision(workload: string, target: string): RoutingDecision {
	return {
		servingTarget: target,
		attempts: [{ targetId: target, outcome: "selected" }],
		mode: "strict",
		workload,
		blockedCandidates: [],
	};
}

/** A blocked decision (no candidate passed the gates) for `workload`. */
function blockedDecision(workload: string): RoutingDecision {
	return {
		servingTarget: null,
		attempts: [{ targetId: "t-blocked", outcome: "blocked", reason: "privacy" }],
		mode: "strict",
		workload,
		blockedCandidates: [{ targetId: "t-blocked", reason: "privacy" }],
	};
}

/** A canned two-chunk async-iterable stream for a given completion text. */
function cannedChunks(text: string): AsyncIterable<ProviderChunk> {
	const mid = Math.ceil(text.length / 2);
	async function* gen(): AsyncIterable<ProviderChunk> {
		yield { delta: text.slice(0, mid) };
		yield { delta: text.slice(mid) };
	}
	return gen();
}

/**
 * Construct a FAKE {@link InferenceRouter} with recording spies. Scriptable per
 * test via the options; every entry point records the request it received and the
 * cancel calls so a test asserts the HTTP mapping precisely.
 */
interface FakeRouterOptions {
	readonly decision?: RoutingDecision;
	readonly output?: string;
	readonly executeThrows?: unknown;
	readonly streamThrows?: unknown;
	readonly cancelReturns?: boolean;
}

interface FakeRouter extends InferenceRouter {
	readonly explainCalls: InferenceRequest[];
	readonly executeCalls: InferenceRequest[];
	readonly streamCalls: InferenceRequest[];
	readonly cancelCalls: string[];
	readonly streamCancelled: { value: boolean };
}

function createFakeRouter(opts: FakeRouterOptions = {}): FakeRouter {
	const explainCalls: InferenceRequest[] = [];
	const executeCalls: InferenceRequest[] = [];
	const streamCalls: InferenceRequest[] = [];
	const cancelCalls: string[] = [];
	const streamCancelled = { value: false };
	const decision = opts.decision ?? servedDecision("interactive", "t-primary");
	const output = opts.output ?? "hello world";

	return {
		explainCalls,
		executeCalls,
		streamCalls,
		cancelCalls,
		streamCancelled,
		explain(request: InferenceRequest): Promise<RoutingDecision> {
			explainCalls.push(request);
			return Promise.resolve(decision);
		},
		execute(request: InferenceRequest): Promise<{ decision: RoutingDecision; output: string }> {
			executeCalls.push(request);
			if (opts.executeThrows !== undefined) return Promise.reject(opts.executeThrows);
			return Promise.resolve({ decision, output });
		},
		stream(request: InferenceRequest): Promise<StreamResult> {
			streamCalls.push(request);
			if (opts.streamThrows !== undefined) return Promise.reject(opts.streamThrows);
			return Promise.resolve({
				decision,
				chunks: cannedChunks(output),
				cancel() {
					streamCancelled.value = true;
				},
			});
		},
		cancel(requestId: string): boolean {
			cancelCalls.push(requestId);
			return opts.cancelReturns ?? true;
		},
	};
}

/** A fake {@link RoutingHistoryStore} seeded with canned redacted events. */
function createFakeHistoryStore(seed: RedactedRoutingEvent[] = []): RoutingHistoryStore {
	return {
		record(): Promise<void> {
			return Promise.resolve();
		},
		recent(_scope: RoutingHistoryScope, limit: number): Promise<RedactedRoutingEvent[]> {
			return Promise.resolve(seed.slice(0, limit));
		},
	};
}

/** A minimal inference config with two routable targets (for `/v1/models`). */
function fakeConfig(): InferenceConfig {
	return {
		accounts: [{ id: "acct-1", provider: "anthropic", apiKeyRef: "${ANTHROPIC_KEY}" }],
		targets: [
			{
				id: "t-primary",
				accountRef: "acct-1",
				model: "claude-sonnet-4",
				privacyTier: "public",
				capabilities: ["chat", "streaming"],
				contextWindow: 200000,
			},
			{
				id: "t-fallback",
				accountRef: "acct-1",
				model: "claude-haiku-4",
				privacyTier: "public",
				capabilities: ["chat"],
				contextWindow: 100000,
			},
		],
		policies: [{ id: "p-1", mode: "strict", chain: ["t-primary", "t-fallback"] }],
		workloads: [{ name: "interactive", policyRef: "p-1", requiredCapabilities: ["chat"], minPrivacyTier: "public" }],
	};
}

/** Build a daemon with the gateway mounted onto its two groups. Returns the daemon + the fakes. */
function buildGateway(deps: Partial<InferenceGatewayDeps> & { router: InferenceRouter }): Daemon {
	const daemon = createDaemon({ config: cfg(), logger: createRequestLogger({ silent: true }) });
	const inference = daemon.group("/api/inference");
	const v1 = daemon.group("/v1");
	if (inference === undefined || v1 === undefined) {
		throw new Error("gateway test: route groups /api/inference and /v1 must be scaffolded");
	}
	mountInferenceGateway(
		{ inference, v1 },
		{
			router: deps.router,
			historyStore: deps.historyStore ?? createFakeHistoryStore(),
			config: deps.config ?? fakeConfig(),
		},
	);
	return daemon;
}

/** Read an SSE body into its `data:` frames (split on the blank-line delimiter). */
async function readSseFrames(res: Response): Promise<string[]> {
	const text = await res.text();
	return text
		.split("\n\n")
		.map((block) => block.trim())
		.filter((block) => block.startsWith("data:"))
		.map((block) => block.slice("data:".length).trim());
}

// ── c-AC-1: explain returns the decision WITHOUT executing ────────────────────

describe("c-AC-1 POST /api/inference/explain returns the routing decision without executing", () => {
	it("calls router.explain and never execute/stream", async () => {
		const router = createFakeRouter({ decision: servedDecision("interactive", "t-primary") });
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/api/inference/explain", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ requestId: "r-1", workload: "interactive", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { decision: RoutingDecision };
		expect(body.decision.servingTarget).toBe("t-primary");
		// The contract of explain: the decision is resolved, NOTHING is executed.
		expect(router.explainCalls).toHaveLength(1);
		expect(router.executeCalls).toHaveLength(0);
		expect(router.streamCalls).toHaveLength(0);
	});

	it("maps a no-serving-target decision to a clean 409, not a 500", async () => {
		const router = createFakeRouter({ decision: blockedDecision("interactive") });
		const daemon = buildGateway({ router });
		// explain returns the blocked decision as a 200 (it's a valid explanation);
		// execute of the same blocked decision is the 409 path.
		const res = await daemon.app.request("/api/inference/execute", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ workload: "interactive", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("no_eligible_target");
	});
});

// ── c-AC-2: /v1/chat/completions streaming yields SSE chunks ───────────────────

describe("c-AC-2 POST /v1/chat/completions streaming streams routed inference over SSE", () => {
	it("returns text/event-stream with OpenAI chunk frames ending in [DONE]", async () => {
		const router = createFakeRouter({ decision: servedDecision("gpt-4o", "t-primary"), output: "streamed reply" });
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/v1/chat/completions", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(router.streamCalls).toHaveLength(1);
		expect(router.executeCalls).toHaveLength(0);

		const frames = await readSseFrames(res);
		expect(frames[frames.length - 1]).toBe("[DONE]");
		const dataFrames = frames.slice(0, -1).map((f) => JSON.parse(f) as { object: string; choices: { delta: { content: string } }[] });
		expect(dataFrames.length).toBeGreaterThan(0);
		for (const frame of dataFrames) expect(frame.object).toBe("chat.completion.chunk");
		const assembled = dataFrames.map((f) => f.choices[0].delta.content).join("");
		expect(assembled).toBe("streamed reply");
	});
});

// ── c-AC-3: /v1/models lists targets + a non-stream chat completes ─────────────

describe("c-AC-3 GET /v1/models lists routable targets and a non-stream chat completes", () => {
	it("lists targets in OpenAI list shape", async () => {
		const router = createFakeRouter({});
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/v1/models", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { object: string; data: { id: string; object: string }[] };
		expect(body.object).toBe("list");
		const ids = body.data.map((m) => m.id);
		expect(ids).toContain("t-primary");
		expect(ids).toContain("t-fallback");
		for (const model of body.data) expect(model.object).toBe("model");
	});

	it("completes a non-stream chat in OpenAI completion shape", async () => {
		const router = createFakeRouter({ decision: servedDecision("gpt-4o", "t-primary"), output: "the answer is 42" });
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/v1/chat/completions", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "the question" }] }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			object: string;
			choices: { message: { role: string; content: string }; finish_reason: string }[];
		};
		expect(body.object).toBe("chat.completion");
		expect(body.choices[0].message.role).toBe("assistant");
		expect(body.choices[0].message.content).toBe("the answer is 42");
		expect(body.choices[0].finish_reason).toBe("stop");
		expect(router.executeCalls).toHaveLength(1);
		expect(router.streamCalls).toHaveLength(0);
	});
});

// ── c-AC-4: DELETE cancels an active stream ───────────────────────────────────

describe("c-AC-4 DELETE /api/inference/requests/:id cancels an active stream", () => {
	it("calls router.cancel with the path id and reports cancelled", async () => {
		const router = createFakeRouter({ cancelReturns: true });
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/api/inference/requests/req-123", {
			method: "DELETE",
			headers: headers(),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { requestId: string; cancelled: boolean };
		expect(body.cancelled).toBe(true);
		expect(body.requestId).toBe("req-123");
		expect(router.cancelCalls).toEqual(["req-123"]);
	});

	it("reports 404 when no active stream matched the id", async () => {
		const router = createFakeRouter({ cancelReturns: false });
		const daemon = buildGateway({ router });
		const res = await daemon.app.request("/api/inference/requests/missing", {
			method: "DELETE",
			headers: headers(),
		});
		expect(res.status).toBe(404);
		expect(router.cancelCalls).toEqual(["missing"]);
	});
});

// ── c-AC-5: oversized body clamped + provider error redacted ───────────────────

describe("c-AC-5 oversized body is clamped within limits and a provider error is redacted", () => {
	it("rejects an oversized request body with 413 before routing", async () => {
		const router = createFakeRouter({});
		const daemon = buildGateway({ router });

		const huge = "x".repeat(MAX_REQUEST_BODY_BYTES + 1024);
		const res = await daemon.app.request("/api/inference/execute", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ workload: "interactive", messages: [{ role: "user", content: huge }] }),
		});

		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string; limitBytes: number };
		expect(body.error).toBe("payload_too_large");
		expect(body.limitBytes).toBe(MAX_REQUEST_BODY_BYTES);
		// The body never reached the router.
		expect(router.executeCalls).toHaveLength(0);
	});

	it("redacts a provider error so no raw provider body leaks to the client", async () => {
		const secretLeak = "ProviderError: 401 invalid api key sk-LIVE-SECRET-abc123 from anthropic";
		const router = createFakeRouter({ executeThrows: new ProviderError(401, secretLeak) });
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/api/inference/execute", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ workload: "interactive", messages: [{ role: "user", content: "hi" }] }),
		});

		// 401 status class preserved, but the raw message (with the key) is gone.
		expect(res.status).toBe(401);
		const raw = await res.text();
		expect(raw).not.toContain("sk-LIVE-SECRET");
		expect(raw).not.toContain("invalid api key");
		const body = JSON.parse(raw) as { error: string; reason: string };
		expect(body.error).toBe("inference_error");
		expect(body.reason).toBe("upstream provider returned status 401");
	});

	it("redacts an OpenAI-gateway provider error into the OpenAI error envelope", async () => {
		const router = createFakeRouter({ executeThrows: new ProviderError(503, "raw upstream body sk-LEAK-xyz overloaded") });
		const daemon = buildGateway({ router });

		const res = await daemon.app.request("/v1/chat/completions", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(res.status).toBe(503);
		const raw = await res.text();
		expect(raw).not.toContain("sk-LEAK");
		const body = JSON.parse(raw) as { error: { message: string; type: string } };
		expect(body.error.type).toBe("upstream_error");
		expect(body.error.message).toBe("upstream provider returned status 503");
	});
});

// ── c-AC-6: history returns redacted rows (no secret/body field) ───────────────

describe("c-AC-6 GET /api/inference/history returns route and fallback decisions with secrets and bodies stripped", () => {
	it("returns the store's redacted events carrying no secret/body field", async () => {
		const seed: RedactedRoutingEvent[] = [
			{
				requestId: "r-9",
				workload: "interactive",
				servingTarget: "t-fallback",
				mode: "strict",
				attempts: [
					{ targetId: "t-primary", outcome: "failed", statusCode: 503, reason: "5xx" },
					{ targetId: "t-fallback", outcome: "selected" },
				],
				blockedCandidates: [],
			},
		];
		const router = createFakeRouter({});
		const daemon = buildGateway({ router, historyStore: createFakeHistoryStore(seed) });

		const res = await daemon.app.request("/api/inference/history?limit=10", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const raw = await res.text();
		const body = JSON.parse(raw) as { events: RedactedRoutingEvent[] };
		expect(body.events).toHaveLength(1);

		const event = body.events[0];
		// The route + fallback sequence is present (b-AC-4 shape preserved through HTTP).
		expect(event.attempts.map((a) => a.targetId)).toEqual(["t-primary", "t-fallback"]);
		expect(event.servingTarget).toBe("t-fallback");

		// No field can carry a secret or a request/response body — assert the shape
		// carries only the redaction-safe keys.
		const eventKeys = Object.keys(event).sort();
		expect(eventKeys).toEqual(
			["attempts", "blockedCandidates", "mode", "requestId", "servingTarget", "workload"].sort(),
		);
		// And no key in the serialized payload hints at a secret/body/prompt/key.
		for (const banned of ["apiKey", "secret", "prompt", "messages", "content", "completion", "body", "key"]) {
			expect(raw).not.toContain(`"${banned}"`);
		}
	});

	it("requires the org header (scoped read, FR-10)", async () => {
		const router = createFakeRouter({});
		const daemon = buildGateway({ router });
		const res = await daemon.app.request("/api/inference/history", {
			method: "GET",
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
	});
});
