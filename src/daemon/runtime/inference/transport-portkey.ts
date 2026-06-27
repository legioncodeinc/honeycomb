/**
 * Portkey gateway provider transport — PRD-063b (b-AC-1 / b-AC-6).
 *
 * The SECOND real {@link ProviderTransport} in the product (after the Anthropic one).
 * When the operator turns the Portkey gateway ON (`portkey.enabled` + `PORTKEY_API_KEY`),
 * the model-client factory builds THIS transport instead of resolving a per-provider key
 * and calling the provider's transport directly (the SUPERSESSION, PRD-063b). Portkey owns
 * the downstream provider routing, the model, guardrails, and fallbacks; Honeycomb sends
 * `activeModel` as the requested model (D-2) and the configured `portkey.config` id, and
 * consumes the standard OpenAI-shaped response.
 *
 * ── What this transport does ─────────────────────────────────────────────────
 *   - `execute(call)` POSTs `https://api.portkey.ai/v1/chat/completions` (the Portkey
 *     OpenAI-compatible gateway) with the `x-portkey-api-key` header carrying the resolved
 *     Portkey key and the `x-portkey-config` header carrying the config id, mapping the
 *     internal OpenAI-chat-shaped {@link InferenceRequest} onto the OpenAI chat-completions
 *     body verbatim (Portkey is OpenAI-compatible — no role hoisting), and joins the
 *     response `choices[].message.content` into the returned {@link ProviderResult.output}.
 *   - `stream(call)` is a THIN wrapper over `execute` (mirrors the Anthropic transport): the
 *     pollinating path consumes a whole completion, so streaming yields a single terminal
 *     {@link ProviderChunk} carrying the full text. A future SSE body can replace it without
 *     touching the router.
 *
 * ── Header names + base URL — confirmed against current Portkey docs (b-AC-1 / D-1 / b-OQ-2) ──
 * The base URL is `https://api.portkey.ai/v1/chat/completions` and the auth headers are
 * `x-portkey-api-key` (the Portkey key) + `x-portkey-config` (the config / virtual-key id),
 * confirmed against the Portkey API reference at build time (NOT hard-coded from memory). All
 * three are named exported constants so a future doc change is a one-line edit and a test can
 * assert the exact wire values.
 *
 * ── Error mapping (so the router's 401/4xx/5xx fallback works) ───────────────
 * On a non-2xx response this THROWS a {@link ProviderError} carrying the HTTP `statusCode`
 * (the shape `router.ts`'s `providerStatus(err)` reads), and a network/transport failure maps
 * to a 503 — exactly the Anthropic transport's contract, so the router falls back identically.
 * The thrown message is a short status string, NEVER the response body (which could echo a
 * credential) and NEVER the key.
 *
 * ── The secret-never-logged invariant (b-AC-3) ──────────────────────────────
 * `call.apiKey` is the resolved Portkey key, local to this one call. It is placed ONLY in the
 * `x-portkey-api-key` request header and is NEVER included in a thrown message, a log, or any
 * returned value. The config id is non-secret. This is a daemon-only module (no agent surface).
 *
 * ── The usage-surfacing seam (PRD-060d / b-AC-6) ─────────────────────────────
 * Portkey returns OpenAI-shaped `usage` (`{ prompt_tokens, completion_tokens, total_tokens }`,
 * with an optional `prompt_tokens_details.cached_tokens`). This transport surfaces those token
 * counts through the SAME {@link UsageSink} seam the Anthropic transport uses (re-imported, not
 * re-declared), mapping `prompt_tokens → inputTokens`, `completion_tokens → outputTokens`, and
 * the cached-read detail → `cacheReadInputTokens` (Portkey does not surface a cache-WRITE count,
 * so `cacheCreationInputTokens` stays 0). So PRD-060 ROI keeps capturing token/cost under the
 * gateway. A transport built WITHOUT a sink behaves byte-for-byte as before (the default is the
 * shared no-op). The sink is fed ONLY on the success path; a thrown {@link ProviderError}
 * reports nothing, and a missing/malformed `usage` surfaces zero counts rather than throwing.
 */

import { z } from "zod";

import {
	type ProviderCall,
	ProviderError,
	type ProviderTransport,
} from "./contracts.js";
import {
	type FetchLike,
	type FetchResponseLike,
	noopUsageSink,
	type PostResult,
	safeJsonParse,
	type UsageReport,
	type UsageSink,
	usageReportingTransport,
} from "./transport-anthropic.js";

/** The Portkey OpenAI-compatible chat-completions endpoint (default `baseUrl`). Confirmed vs Portkey docs. */
export const PORTKEY_CHAT_COMPLETIONS_URL = "https://api.portkey.ai/v1/chat/completions" as const;

/** The Portkey auth header carrying the resolved `PORTKEY_API_KEY` (confirmed vs Portkey docs). */
export const PORTKEY_API_KEY_HEADER = "x-portkey-api-key" as const;

/** The Portkey header carrying the `portkey.config` / virtual-key id (confirmed vs Portkey docs). */
export const PORTKEY_CONFIG_HEADER = "x-portkey-config" as const;

/**
 * The fallback `max_tokens` when a request omits its own. Unlike the Anthropic Messages API,
 * the OpenAI chat-completions shape does NOT require `max_tokens`; Honeycomb still sends a sane
 * ceiling so the pollinating mutation-set completion is never truncated by a provider default.
 */
export const PORTKEY_DEFAULT_MAX_TOKENS = 4096 as const;

/** Construction deps for {@link createPortkeyTransport}. Everything IO-touching is injectable (test seam). */
export interface PortkeyTransportDeps {
	/**
	 * The Portkey config / virtual-key id sent in the `x-portkey-config` header. REQUIRED — the
	 * factory only builds this transport once `portkey.config` is present, so the id is always
	 * supplied (an empty id would be a misconfiguration the factory guards upstream).
	 */
	readonly config: string;
	/** The `fetch` implementation; defaults to `globalThis.fetch`. Tests inject a fake (no network). */
	readonly fetch?: FetchLike;
	/** The endpoint URL; defaults to {@link PORTKEY_CHAT_COMPLETIONS_URL}. Override for a fake-fetch test. */
	readonly baseUrl?: string;
	/** The default `max_tokens` when a request omits its own; defaults to {@link PORTKEY_DEFAULT_MAX_TOKENS}. */
	readonly defaultMaxTokens?: number;
	/**
	 * The usage sink the transport reports each successful call's token usage to (PRD-060d / b-AC-6).
	 * Defaults to the shared {@link noopUsageSink} so a transport built without one behaves EXACTLY as
	 * before — usage is surfaced ONLY when a meter is injected. SELECTION/metering only; never touches
	 * routing, the gate, or the credential path.
	 */
	readonly usageSink?: UsageSink;
	/**
	 * An OBSERVED-failure callback (PRD-063b / b-AC-7). Called with the HTTP-like status code on every
	 * FAILED call — a network/transport failure (503) or a non-2xx gateway response (e.g. 401 auth
	 * rejection, 5xx) — IMMEDIATELY before the {@link ProviderError} is thrown. This is the cached
	 * last-failure signal `/health` derives `reasons.portkey = "unreachable"` from: a REAL call failed
	 * to reach/authenticate the gateway, NOT a synchronous probe. Total + non-throwing (hot-path safe);
	 * a malformed-response 502 is NOT reported (the gateway WAS reachable, the body was just bad).
	 * Absent → no-op (no signal wired). Carries only the status code — never the key or a body.
	 */
	readonly onTransportError?: (statusCode: number) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Response boundary — zod validates the (untrusted) Portkey/OpenAI JSON.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The slice of the OpenAI chat-completions response we read. `choices` is an array; each
 * choice's `message.content` carries the completion text (nullable when a choice is a tool
 * call — we tolerate + skip a null/absent content). The schema is lenient on extra fields
 * (Portkey/the provider may add them) but strict on the shape we depend on.
 */
const PortkeyChoiceSchema = z.object({
	message: z
		.object({ content: z.string().nullable().optional() })
		.optional(),
});

/**
 * The OpenAI-shaped `usage` object Portkey returns (PRD-060d / b-AC-6). Each token field is an
 * optional non-negative integer defaulting to `0` (a response omitting `usage`, or a field,
 * surfaces zero rather than a NaN/throw). `prompt_tokens_details.cached_tokens` is the optional
 * cache-READ breakdown. Lenient on extra fields the provider may add.
 */
const PortkeyUsageSchema = z.object({
	prompt_tokens: z.number().int().nonnegative().catch(0).default(0),
	completion_tokens: z.number().int().nonnegative().catch(0).default(0),
	prompt_tokens_details: z
		.object({ cached_tokens: z.number().int().nonnegative().catch(0).default(0) })
		.partial()
		.optional(),
});

/** The all-zero usage fallback (a response with absent/null/malformed `usage` surfaces this, not a throw). */
const ZERO_PORTKEY_USAGE = { prompt_tokens: 0, completion_tokens: 0 } as const;

/** The OpenAI chat-completions success-response shape (only the fields we read). */
const PortkeyChatResponseSchema = z.object({
	choices: z.array(PortkeyChoiceSchema).default([]),
	// As with the Anthropic transport's usage block: `.catch()` so ANY invalid `usage` value
	// (null, a string, a malformed object) falls back to zero-usage and a VALID completion is
	// never dropped over its (side-channel) usage block.
	usage: PortkeyUsageSchema.default(ZERO_PORTKEY_USAGE).catch(ZERO_PORTKEY_USAGE),
});

/**
 * The internal OpenAI-chat → OpenAI chat-completions body mapping. Portkey is OpenAI-compatible,
 * so the internal {@link InferenceRequest} messages pass through verbatim (NO Anthropic-style
 * system hoisting); the model is the call's target model (D-2: `activeModel`), and `max_tokens`
 * is always sent (a sane ceiling, not required by the API). Pure + total.
 */
export function toPortkeyBody(call: ProviderCall, defaultMaxTokens: number): {
	model: string;
	max_tokens: number;
	messages: { role: string; content: string }[];
} {
	return {
		model: call.target.model,
		max_tokens: call.request.maxTokens ?? defaultMaxTokens,
		messages: call.request.messages.map((m) => ({ role: m.role, content: m.content })),
	};
}

/** Join the `choices[].message.content` of a parsed OpenAI-shaped response into one string. */
function joinChoiceText(choices: readonly { message?: { content?: string | null } }[]): string {
	return choices
		.map((c) => c.message?.content)
		.filter((t): t is string => typeof t === "string")
		.join("");
}

/**
 * Build the REAL Portkey gateway {@link ProviderTransport} (b-AC-1). The factory injects the
 * `config` id (production uses `globalThis.fetch` + the real endpoint); tests inject a fake
 * `fetch` + `baseUrl` so no unit test touches the network. The resolved `call.apiKey` is placed
 * only in the `x-portkey-api-key` header and never logged/thrown.
 */
export function createPortkeyTransport(deps: PortkeyTransportDeps): ProviderTransport {
	const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const url = deps.baseUrl ?? PORTKEY_CHAT_COMPLETIONS_URL;
	const defaultMaxTokens = deps.defaultMaxTokens ?? PORTKEY_DEFAULT_MAX_TOKENS;
	const usageSink: UsageSink = deps.usageSink ?? noopUsageSink;
	const configId = deps.config;
	const onTransportError = deps.onTransportError;

	/** Fire the observed-failure signal defensively (b-AC-7) — a faulty observer never breaks a call. */
	function reportTransportError(statusCode: number): void {
		if (onTransportError === undefined) return;
		try {
			onTransportError(statusCode);
		} catch {
			/* an observer fault is swallowed: the health signal is best-effort, never breaks inference. */
		}
	}

	/**
	 * POST the call and return BOTH the joined completion text AND the parsed `usage` (b-AC-6).
	 * Throws a {@link ProviderError} on any failure — a thrown call surfaces NO usage (the sink
	 * is fed only on success).
	 */
	async function post(call: ProviderCall): Promise<PostResult> {
		const body = toPortkeyBody(call, defaultMaxTokens);
		let res: FetchResponseLike;
		try {
			res = await doFetch(url, {
				method: "POST",
				headers: {
					[PORTKEY_API_KEY_HEADER]: call.apiKey,
					[PORTKEY_CONFIG_HEADER]: configId,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			// A network/transport failure (DNS, connection reset, timeout) → 503 so the router's
			// fallback (when on, D-3) engages. The cause text is the error NAME only, never a body/key.
			// Signal the observed unreachability (b-AC-7) before throwing.
			reportTransportError(503);
			const detail = err instanceof Error ? err.name : "network error";
			throw new ProviderError(503, `portkey transport: request failed (${detail})`);
		}
		if (!res.ok) {
			// Map the HTTP status onto a ProviderError the router's providerStatus(err) reads.
			// NEVER include the response body (could echo a credential) or the key. An auth-rejection
			// (401/403) or a 5xx is an observed gateway failure → signal unreachability (b-AC-7).
			reportTransportError(res.status);
			throw new ProviderError(res.status, `portkey transport: gateway returned status ${res.status}`);
		}
		const raw: unknown = await res.text().then((t) => safeJsonParse(t));
		const parsed = PortkeyChatResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new ProviderError(502, "portkey transport: malformed gateway response");
		}
		const u = parsed.data.usage;
		const usage: UsageReport = {
			model: call.target.model,
			workload: call.request.workload,
			inputTokens: u.prompt_tokens,
			outputTokens: u.completion_tokens,
			cacheReadInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
			// Portkey's OpenAI-shaped usage has no cache-WRITE field; surface 0 (never fabricate).
			cacheCreationInputTokens: 0,
		};
		return { output: joinChoiceText(parsed.data.choices), usage };
	}

	// The `{ execute, stream }` plumbing is the SHARED OpenAI/Anthropic-compatible wrapper
	// (jscpd discipline) — this transport supplies only the provider-specific `post` (which adds
	// the Portkey auth/config headers + the observed-failure signal on top of the shared shape).
	return usageReportingTransport(post, usageSink);
}
