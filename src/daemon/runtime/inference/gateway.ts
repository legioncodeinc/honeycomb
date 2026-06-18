/**
 * Inference gateway — PRD-010c (Wave 2 FILLED).
 *
 * 010c mounts the native `/api/inference/*` + OpenAI-compat `/v1/*` HTTP surface
 * onto the daemon's pre-scaffolded route groups (`server.ts` ROUTE_GROUPS already
 * registers `/api/inference` and `/v1`). The handlers attach to the groups via the
 * `daemon.group(path)` sub-apps and route every request through the Wave-1
 * {@link InferenceRouter} + {@link RoutingHistoryStore} — the gateway is a THIN
 * HTTP shape adapter, never a second router (FR-7 / FR-9). It holds NO credentials
 * and never touches DeepLake directly; the router + the history store own those.
 *
 * Native API on the `/api/inference` group:
 *   - `POST   /api/inference/explain`        → router.explain — the decision, NO execution (c-AC-1)
 *   - `POST   /api/inference/execute`        → router.execute — routed inference + the attempt sequence
 *   - `POST   /api/inference/stream`         → router.stream  — SSE-streamed routed completion
 *   - `GET    /api/inference/status`         → coarse gateway liveness
 *   - `GET    /api/inference/history`        → historyStore.recent — redacted route+fallback rows (c-AC-6)
 *   - `DELETE /api/inference/requests/:id`   → router.cancel — cancel an active stream (c-AC-4)
 *
 * OpenAI-compatible gateway on the `/v1` group:
 *   - `GET    /v1/models`                    → list routable targets, OpenAI `{object:"list",data:[…]}` (c-AC-3)
 *   - `POST   /v1/chat/completions`          → map OpenAI req → InferenceRequest → router.execute /
 *                                              router.stream, returning OpenAI-shaped JSON / SSE chunks (c-AC-2/c-AC-3)
 *
 * ── Safety (c-AC-5) ─────────────────────────────────────────────────────────
 * Every body-bearing handler is guarded by {@link readClampedJson}: a request body
 * exceeding {@link MAX_REQUEST_BODY_BYTES} is REJECTED 413 (clamp-by-reject — the
 * AC's "clamped within limits"), never buffered unbounded. A provider/router error
 * is REDACTED through {@link redactedError} before return: the client sees a stable
 * sanitized message + a status class, never a raw provider body or anything that
 * could echo a credential.
 *
 * A {@link RoutingDecision} with `servingTarget === null` (every candidate blocked
 * or failed) maps to a clean 409, never a 500 — "nothing could serve this" is a
 * routing outcome, not a gateway fault.
 */

import type { Context, Hono } from "hono";

import type { InferenceConfig } from "./contracts.js";
import {
	type ChatMessage,
	type InferenceRequest,
	type InferenceRouter,
	ProviderError,
	type RoutingDecision,
	type RoutingHistoryScope,
	type RoutingHistoryStore,
} from "./contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// Clamp + redaction constants (c-AC-5).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The maximum accepted request-body size, in bytes (c-AC-5). A body larger than
 * this is rejected 413 before it is parsed, so an oversized payload can never be
 * buffered into memory unbounded. 1 MiB comfortably holds a large chat context
 * while bounding the worst case; it is the single documented clamp limit.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576; // 1 MiB

/** The default `GET /api/inference/history` page size when the caller omits `limit`. */
export const DEFAULT_HISTORY_PAGE_SIZE = 50;

// ────────────────────────────────────────────────────────────────────────────
// Gateway deps.
// ────────────────────────────────────────────────────────────────────────────

/** What the gateway needs to serve inference HTTP (010c wires these in). */
export interface InferenceGatewayDeps {
	/** The router the handlers call (explain/execute/stream/cancel). */
	readonly router: InferenceRouter;
	/** The telemetry store `GET /api/inference/history` reads through (c-AC-6). */
	readonly historyStore: RoutingHistoryStore;
	/**
	 * The resolved inference config, for `GET /v1/models` to list routable targets
	 * (c-AC-3). Optional: when absent, `/v1/models` reports an empty list rather
	 * than failing, so the gateway mounts even before config is wired.
	 */
	readonly config?: InferenceConfig;
}

/** The two daemon sub-apps the gateway attaches to (the pre-scaffolded groups). */
export interface InferenceGatewayGroups {
	/** The `daemon.group("/api/inference")` sub-app (native API). */
	readonly inference: Hono;
	/** The `daemon.group("/v1")` sub-app (OpenAI-compatible gateway). */
	readonly v1: Hono;
}

/**
 * Mount the inference gateway handlers onto the daemon's two pre-scaffolded route
 * groups (010c). The handlers register RELATIVE to each group base and inherit the
 * permission middleware the bootstrap already mounted (FR-10: requests stay scoped
 * to the calling org/workspace), so there is NO auth re-wiring and no edit to
 * `server.ts`.
 *
 * @param groups - the `/api/inference` + `/v1` sub-apps from `daemon.group(...)`.
 * @param deps   - the router + history store (+ optional config) to route through.
 */
export function mountInferenceGateway(groups: InferenceGatewayGroups, deps: InferenceGatewayDeps): void {
	mountNativeApi(groups.inference, deps);
	mountOpenAiGateway(groups.v1, deps);
}

// ────────────────────────────────────────────────────────────────────────────
// Native API — /api/inference/*
// ────────────────────────────────────────────────────────────────────────────

function mountNativeApi(group: Hono, deps: InferenceGatewayDeps): void {
	const { router, historyStore } = deps;

	// GET /api/inference/status — coarse gateway liveness (FR-1). No router call.
	group.get("/status", (c) => c.json({ status: "ok", surface: "inference" }));

	// POST /api/inference/explain — the routing decision, NO execution (c-AC-1 / FR-2).
	group.post("/explain", async (c) => {
		const parsed = await readClampedJson(c);
		if (!parsed.ok) return parsed.response;
		const reqResult = toInferenceRequest(parsed.body);
		if (!reqResult.ok) return c.json({ error: "bad_request", reason: reqResult.reason }, 400);
		try {
			const decision = await router.explain(reqResult.request);
			return c.json({ decision });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// POST /api/inference/execute — routed inference + the recorded attempt sequence (FR-3).
	group.post("/execute", async (c) => {
		const parsed = await readClampedJson(c);
		if (!parsed.ok) return parsed.response;
		const reqResult = toInferenceRequest(parsed.body);
		if (!reqResult.ok) return c.json({ error: "bad_request", reason: reqResult.reason }, 400);
		try {
			const result = await router.execute(reqResult.request);
			const blocked = noServingTargetResponse(c, result.decision);
			if (blocked !== null) return blocked;
			return c.json({ decision: result.decision, output: result.output });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// POST /api/inference/stream — routed completion over SSE (FR-4).
	group.post("/stream", async (c) => {
		const parsed = await readClampedJson(c);
		if (!parsed.ok) return parsed.response;
		const reqResult = toInferenceRequest(parsed.body);
		if (!reqResult.ok) return c.json({ error: "bad_request", reason: reqResult.reason }, 400);
		try {
			const stream = await router.stream({ ...reqResult.request, stream: true });
			const blocked = noServingTargetResponse(c, stream.decision);
			if (blocked !== null) {
				stream.cancel();
				return blocked;
			}
			return nativeSseResponse(stream);
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// GET /api/inference/history — redacted route + fallback rows (c-AC-6 / FR-5).
	group.get("/history", async (c) => {
		const scope = historyScope(c);
		if (scope === null) {
			return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
		}
		const limit = parseLimit(c.req.query("limit"));
		try {
			const rows = await historyStore.recent(scope, limit);
			// The store redacts by construction; we surface the rows verbatim — they
			// carry only ids, gate reasons, status codes, mode (no secret/body).
			return c.json({ events: rows });
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	// DELETE /api/inference/requests/:id — cancel an active stream by id (c-AC-4 / FR-4).
	group.delete("/requests/:id", (c) => {
		const id = c.req.param("id");
		const cancelled = router.cancel(id);
		return c.json({ requestId: id, cancelled }, cancelled ? 200 : 404);
	});
}

// ────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible gateway — /v1/*
// ────────────────────────────────────────────────────────────────────────────

function mountOpenAiGateway(group: Hono, deps: InferenceGatewayDeps): void {
	const { router, config } = deps;

	// GET /v1/models — list routable targets in OpenAI list shape (c-AC-3 / FR-6).
	group.get("/models", (c) => {
		const targets = config?.targets ?? [];
		const data = targets.map((t) => ({
			id: t.id,
			object: "model" as const,
			created: 0,
			owned_by: t.accountRef,
		}));
		return c.json({ object: "list", data });
	});

	// POST /v1/chat/completions — map OpenAI req → InferenceRequest → router (c-AC-2/c-AC-3 / FR-6/FR-7).
	group.post("/chat/completions", async (c) => {
		const parsed = await readClampedJson(c);
		if (!parsed.ok) return parsed.response;
		const mapped = toOpenAiRequest(parsed.body);
		if (!mapped.ok) return c.json(openAiError(mapped.reason, "invalid_request_error"), 400);
		const { request, model } = mapped;

		if (request.stream === true) {
			try {
				const stream = await router.stream(request);
				if (stream.decision.servingTarget === null) {
					stream.cancel();
					return c.json(openAiError("no eligible target could serve this request", "no_eligible_target"), 409);
				}
				return openAiSseResponse(stream, model, request.requestId);
			} catch (err) {
				return openAiErrorResponse(c, err);
			}
		}

		try {
			const result = await router.execute(request);
			if (result.decision.servingTarget === null) {
				return c.json(openAiError("no eligible target could serve this request", "no_eligible_target"), 409);
			}
			return c.json(openAiCompletion(result.output, model, request.requestId, result.decision.servingTarget));
		} catch (err) {
			return openAiErrorResponse(c, err);
		}
	});
}

// ────────────────────────────────────────────────────────────────────────────
// Body clamp + JSON read (c-AC-5).
// ────────────────────────────────────────────────────────────────────────────

/** The outcome of {@link readClampedJson}: a parsed body, or a ready-made error response. */
type ClampedRead = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly response: Response };

/**
 * Read + size-clamp a JSON request body (c-AC-5). Rejects 413 when the body exceeds
 * {@link MAX_REQUEST_BODY_BYTES} — checked via the declared `content-length` AND by
 * measuring the raw text, so a lying/absent header cannot smuggle an oversized body
 * past the guard. A non-JSON body is a clean 400. The body is never buffered beyond
 * the clamp.
 */
async function readClampedJson(c: Context): Promise<ClampedRead> {
	const declared = Number(c.req.header("content-length"));
	if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
		return { ok: false, response: c.json({ error: "payload_too_large", limitBytes: MAX_REQUEST_BODY_BYTES }, 413) };
	}
	let raw: string;
	try {
		raw = await c.req.text();
	} catch {
		return { ok: false, response: c.json({ error: "bad_request", reason: "could not read request body" }, 400) };
	}
	// Byte length (not char length) — multibyte content must be measured honestly.
	if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BODY_BYTES) {
		return { ok: false, response: c.json({ error: "payload_too_large", limitBytes: MAX_REQUEST_BODY_BYTES }, 413) };
	}
	try {
		return { ok: true, body: raw.length === 0 ? {} : JSON.parse(raw) };
	} catch {
		return { ok: false, response: c.json({ error: "bad_request", reason: "request body must be JSON" }, 400) };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Request mapping (native + OpenAI → InferenceRequest).
// ────────────────────────────────────────────────────────────────────────────

/** The result of mapping a body into an {@link InferenceRequest}. */
type RequestMap =
	| { readonly ok: true; readonly request: InferenceRequest }
	| { readonly ok: false; readonly reason: string };

/**
 * Map a NATIVE request body onto an {@link InferenceRequest}. The native body IS
 * the inference shape (requestId/workload/messages/…); this validates the minimum
 * required fields and synthesizes a request id when the caller omits one.
 */
function toInferenceRequest(body: unknown): RequestMap {
	if (body === null || typeof body !== "object") return { ok: false, reason: "body must be an object" };
	const b = body as Record<string, unknown>;
	if (typeof b.workload !== "string" || b.workload.length === 0) {
		return { ok: false, reason: "workload is required" };
	}
	const messages = normalizeMessages(b.messages);
	if (messages === null) return { ok: false, reason: "messages must be a non-empty array of {role,content}" };
	const request: InferenceRequest = {
		requestId: typeof b.requestId === "string" && b.requestId.length > 0 ? b.requestId : freshRequestId(),
		workload: b.workload,
		messages,
		...(typeof b.maxTokens === "number" ? { maxTokens: b.maxTokens } : {}),
		...(typeof b.stream === "boolean" ? { stream: b.stream } : {}),
		...(typeof b.contextTokens === "number" ? { contextTokens: b.contextTokens } : {}),
	};
	return { ok: true, request };
}

/** The result of mapping an OpenAI chat body: the request + the echoed model name. */
type OpenAiMap =
	| { readonly ok: true; readonly request: InferenceRequest; readonly model: string }
	| { readonly ok: false; readonly reason: string };

/**
 * Map an OpenAI `/v1/chat/completions` body onto an {@link InferenceRequest}
 * (FR-7). The OpenAI `model` field selects the workload (an OpenAI client passes a
 * model name; here that names the routing workload), `messages` maps straight
 * across, and `stream`/`max_tokens` mirror the OpenAI fields. The mapped `model`
 * is echoed back in the OpenAI response shape.
 */
function toOpenAiRequest(body: unknown): OpenAiMap {
	if (body === null || typeof body !== "object") return { ok: false, reason: "body must be an object" };
	const b = body as Record<string, unknown>;
	if (typeof b.model !== "string" || b.model.length === 0) return { ok: false, reason: "model is required" };
	const messages = normalizeMessages(b.messages);
	if (messages === null) return { ok: false, reason: "messages must be a non-empty array of {role,content}" };
	const maxTokens = b.max_tokens;
	const request: InferenceRequest = {
		requestId: freshRequestId(),
		// The OpenAI `model` names the routing workload (the gateway is a shape adapter).
		workload: b.model,
		messages,
		...(typeof maxTokens === "number" ? { maxTokens } : {}),
		...(typeof b.stream === "boolean" ? { stream: b.stream } : {}),
	};
	return { ok: true, request, model: b.model };
}

/** Validate + normalize a `messages` array into {@link ChatMessage}s, or `null` when invalid. */
function normalizeMessages(raw: unknown): ChatMessage[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: ChatMessage[] = [];
	for (const m of raw) {
		if (m === null || typeof m !== "object") return null;
		const msg = m as Record<string, unknown>;
		if (typeof msg.role !== "string" || typeof msg.content !== "string") return null;
		out.push({ role: msg.role, content: msg.content });
	}
	return out;
}

/** A unique gateway-side request id (keys the decision + the stream-cancel handle). */
function freshRequestId(): string {
	return `gw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// SSE responses (native + OpenAI).
// ────────────────────────────────────────────────────────────────────────────

/** The headers every SSE response carries. */
const SSE_HEADERS: Record<string, string> = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
};

/**
 * Stream a router result as native SSE (c-AC-2): one `data: {json}\n\n` frame per
 * chunk, a final `data: [DONE]\n\n` sentinel. The router's `cancel` handle is wired
 * to the stream's `cancel` callback so a `DELETE /requests/:id` (or a dropped
 * client) tears the underlying provider stream down. A provider error mid-stream is
 * surfaced as a redacted `error` frame, never a raw body.
 */
function nativeSseResponse(stream: {
	readonly chunks: AsyncIterable<{ readonly delta: string }>;
	cancel(): void;
}): Response {
	const body = sseStream(stream, (delta) => sseFrame({ delta }));
	return new Response(body, { headers: SSE_HEADERS });
}

/**
 * Stream a router result as OpenAI-compatible SSE chunks (c-AC-2): each frame is an
 * OpenAI `chat.completion.chunk` carrying the delta, terminated by `data: [DONE]`.
 */
function openAiSseResponse(
	stream: { readonly chunks: AsyncIterable<{ readonly delta: string }>; cancel(): void },
	model: string,
	requestId: string,
): Response {
	const id = `chatcmpl-${requestId}`;
	const body = sseStream(stream, (delta) =>
		sseFrame({
			id,
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
		}),
	);
	return new Response(body, { headers: SSE_HEADERS });
}

/**
 * Drive an async chunk stream into a `ReadableStream` of SSE bytes, framing each
 * chunk through `frameFor` and closing with `data: [DONE]`. On a provider error the
 * stream emits a single redacted `error` frame then `[DONE]`; the underlying
 * provider stream is cancelled when the consumer cancels (back-pressure-safe).
 */
function sseStream(
	stream: { readonly chunks: AsyncIterable<{ readonly delta: string }>; cancel(): void },
	frameFor: (delta: string) => string,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of stream.chunks) {
					controller.enqueue(encoder.encode(frameFor(chunk.delta)));
				}
			} catch (err) {
				controller.enqueue(encoder.encode(sseFrame({ error: redactedError(err).message })));
			} finally {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			}
		},
		cancel() {
			// The consumer (or a DELETE) abandoned the stream — tear the provider down.
			stream.cancel();
		},
	});
}

/** Frame a JSON-serializable payload as one SSE `data:` event. */
function sseFrame(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

// ────────────────────────────────────────────────────────────────────────────
// OpenAI response shapes.
// ────────────────────────────────────────────────────────────────────────────

/** Build a non-streamed OpenAI `chat.completion` response from the router output. */
function openAiCompletion(output: string, model: string, requestId: string, servingTarget: string): unknown {
	return {
		id: `chatcmpl-${requestId}`,
		object: "chat.completion",
		created: 0,
		// The serving target rides in `model` so a debugging client sees what served.
		model,
		system_fingerprint: servingTarget,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: output },
				finish_reason: "stop",
			},
		],
	};
}

/** Build an OpenAI-shaped error envelope (the sanitized `error` object clients expect). */
function openAiError(message: string, type: string): unknown {
	return { error: { message, type, code: null, param: null } };
}

// ────────────────────────────────────────────────────────────────────────────
// Error redaction (c-AC-5) + decision → HTTP mapping.
// ────────────────────────────────────────────────────────────────────────────

/** A redacted error: a stable client-safe message + an HTTP status. Never a raw body. */
interface RedactedError {
	readonly status: number;
	readonly message: string;
}

/**
 * Redact any thrown error into a client-safe shape (c-AC-5). A {@link ProviderError}
 * keeps its HTTP-like status (so 4xx stays 4xx, 5xx stays 5xx) but its message is
 * replaced with a fixed status-class string — the raw provider body NEVER reaches
 * the client. Any other error becomes a generic 500. No error message string from
 * the thrown value is ever forwarded, so a credential echoed in a provider body
 * cannot leak.
 */
function redactedError(err: unknown): RedactedError {
	if (err instanceof ProviderError) {
		const status = err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 502;
		return { status, message: `upstream provider returned status ${status}` };
	}
	return { status: 500, message: "internal routing error" };
}

/** Send the redacted error as a native JSON error response (c-AC-5). */
function errorResponse(c: Context, err: unknown): Response {
	const red = redactedError(err);
	return c.json({ error: "inference_error", reason: red.message }, statusCodeOf(red.status));
}

/** Send the redacted error as an OpenAI-shaped error response (c-AC-5). */
function openAiErrorResponse(c: Context, err: unknown): Response {
	const red = redactedError(err);
	return c.json(openAiError(red.message, "upstream_error"), statusCodeOf(red.status));
}

/**
 * Map a decision with no serving target to a clean 409 (every candidate blocked or
 * failed is a routing OUTCOME, not a gateway fault) — returns `null` when a target
 * did serve so the caller proceeds normally.
 */
function noServingTargetResponse(c: Context, decision: RoutingDecision): Response | null {
	if (decision.servingTarget !== null) return null;
	return c.json(
		{ error: "no_eligible_target", reason: "no eligible target could serve this request", decision },
		409,
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Scope + limit parsing.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the {@link RoutingHistoryScope} for a `GET /api/inference/history` read
 * from the same `x-honeycomb-*` headers the rest of the daemon reads (FR-10). The
 * org is required; the workspace defaults to empty (the partition the store wrote
 * with an absent workspace). Returns `null` when the org is missing.
 */
function historyScope(c: Context): RoutingHistoryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org === undefined || org.length === 0) return null;
	const workspace = c.req.header("x-honeycomb-workspace") ?? "";
	return { org, workspace };
}

/** Parse a `limit` query value into a positive integer, defaulting when absent/invalid. */
function parseLimit(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_HISTORY_PAGE_SIZE;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_PAGE_SIZE;
	return Math.trunc(n);
}

/**
 * Narrow an arbitrary HTTP status int to the {@link ContentfulStatusCode} union
 * Hono's `c.json` accepts. Our redaction only ever produces 4xx/5xx, but the
 * provider status arrives as a plain `number`, so this keeps the call type-safe
 * without a cast that could smuggle a non-error status through.
 */
function statusCodeOf(status: number): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 {
	switch (status) {
		case 400:
			return 400;
		case 401:
			return 401;
		case 403:
			return 403;
		case 404:
			return 404;
		case 409:
			return 409;
		case 413:
			return 413;
		case 429:
			return 429;
		case 502:
			return 502;
		case 503:
			return 503;
		default:
			// Any other 4xx/5xx collapses to a generic 502 (upstream) or 500 (internal).
			return status >= 500 ? 500 : 502;
	}
}
