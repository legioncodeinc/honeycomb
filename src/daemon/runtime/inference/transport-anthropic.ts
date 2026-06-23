/**
 * Anthropic Messages-API provider transport — PRD-010 "real transport" finish
 * (PRD-026 AC-T / the only non-fake {@link ProviderTransport} in the product).
 *
 * The router (`router.ts` `executeWithFallback`) resolves an account's secret and
 * hands a {@link ProviderCall} to a {@link ProviderTransport}. Wave 1 shipped ONLY
 * the seam + `createFakeProviderTransport`; this module is the real HTTP body that
 * lets the daemon make an actual `memory_pollinating` call against Anthropic.
 *
 * ── What this transport does ─────────────────────────────────────────────────
 *   - `execute(call)` POSTs `https://api.anthropic.com/v1/messages` with the
 *     `x-api-key` + `anthropic-version` headers, mapping the OpenAI-shaped internal
 *     {@link InferenceRequest} onto the Anthropic Messages body (system messages
 *     hoisted to the top-level `system` string; the rest become the `messages`
 *     array; `max_tokens` is REQUIRED so a default is supplied), and joins the
 *     response `content[]` text blocks into the returned {@link ProviderResult.output}.
 *   - `stream(call)` is a THIN wrapper over `execute`: the pollinating path consumes a
 *     whole completion (it parses a mutation set defensively, not a token stream),
 *     so streaming yields a single terminal {@link ProviderChunk} carrying the full
 *     text. The seam shape is honoured so a future caller that DOES stream can swap
 *     in a real SSE body without touching the router. (See {@link AnthropicTransportDeps}.)
 *
 * ── Error mapping (so the router's 401/4xx/5xx fallback works) ───────────────
 * On a non-2xx response this THROWS a {@link ProviderError} carrying the HTTP
 * `statusCode` — exactly the shape `router.ts`'s `providerStatus(err)` reads
 * (`err instanceof ProviderError → err.statusCode`), mirroring
 * `createFakeProviderTransport`. So a 401 expires the account in-memory and other
 * 4xx/5xx fall through to the next target, identically to the fake.
 *
 * ── The secret-never-logged invariant ───────────────────────────────────────
 * `call.apiKey` is the resolved key, local to this one call. It is placed ONLY in
 * the `x-api-key` request header and is NEVER included in a thrown message, a log,
 * or any returned value. The thrown {@link ProviderError} message is a short status
 * string — never the response body (which a provider could echo a credential into)
 * and never the key. This is a daemon-only module (no agent surface).
 *
 * ── Seams (so OpenRouter / an OpenAI-compatible endpoint can reuse + tests inject) ──
 * `fetch` and the `baseUrl` are injectable. Tests inject a fake `fetch` so NO unit
 * test touches the network; a later OpenAI-compatible/OpenRouter transport can reuse
 * the same reshaping by overriding `baseUrl` (and, if needed, the header builder).
 */

import { z } from "zod";

import {
	type ProviderCall,
	type ProviderChunk,
	ProviderError,
	type ProviderResult,
	type ProviderTransport,
} from "./contracts.js";

/** The Anthropic Messages endpoint (default `baseUrl`). */
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages" as const;

/** The pinned Anthropic API version header value. */
export const ANTHROPIC_VERSION = "2023-06-01" as const;

/**
 * The fallback `max_tokens` when a request omits its own. The Anthropic Messages
 * API REQUIRES `max_tokens`, so the transport always sends one. 4096 is a sane
 * ceiling for the pollinating workload's mutation-set completion.
 */
export const DEFAULT_MAX_TOKENS = 4096 as const;

/** The `fetch` shape this transport depends on (a subset of the WHATWG `fetch`). */
export type FetchLike = (
	input: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body: string;
	},
) => Promise<FetchResponseLike>;

/** The response shape this transport reads (a subset of the WHATWG `Response`). */
export interface FetchResponseLike {
	/** The HTTP status code (the {@link ProviderError} branch reads this). */
	readonly status: number;
	/** Whether the status is 2xx. */
	readonly ok: boolean;
	/** Resolve the body as text (parsed as JSON on success; ignored on failure). */
	text(): Promise<string>;
}

/** Construction deps for {@link createAnthropicTransport}. Everything IO-touching is injectable. */
export interface AnthropicTransportDeps {
	/** The `fetch` implementation; defaults to `globalThis.fetch`. Tests inject a fake. */
	readonly fetch?: FetchLike;
	/** The endpoint URL; defaults to {@link ANTHROPIC_MESSAGES_URL}. Override for OpenRouter/compatible. */
	readonly baseUrl?: string;
	/** The default `max_tokens` when a request omits its own; defaults to {@link DEFAULT_MAX_TOKENS}. */
	readonly defaultMaxTokens?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Response boundary — zod validates the (untrusted) provider JSON.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The slice of the Anthropic Messages response we read: `content` is an array of
 * blocks; a `text` block carries the completion text. We tolerate (and skip)
 * non-text blocks (e.g. `tool_use`) by only joining the text of `type: "text"`
 * blocks. The schema is intentionally lenient on extra fields (provider may add
 * them) but strict on the shape we depend on.
 */
const AnthropicContentBlockSchema = z.object({
	type: z.string(),
	text: z.string().optional(),
});

/** The Anthropic Messages success-response shape (only the fields we read). */
const AnthropicMessagesResponseSchema = z.object({
	content: z.array(AnthropicContentBlockSchema).default([]),
});

/**
 * The OpenAI-shaped → Anthropic Messages reshaping. Pulls every `role: "system"`
 * message out into the top-level `system` string (joined by newlines when there is
 * more than one), maps the remaining messages to Anthropic's `{ role, content }`
 * (only `user`/`assistant` are valid Anthropic roles; any other non-system role is
 * coerced to `user`, the safe default for a single-prompt workload), and always
 * sets `max_tokens` (required by the API). Pure + total.
 */
export function toAnthropicBody(call: ProviderCall, defaultMaxTokens: number): {
	model: string;
	max_tokens: number;
	system?: string;
	messages: { role: "user" | "assistant"; content: string }[];
} {
	const systemParts: string[] = [];
	const messages: { role: "user" | "assistant"; content: string }[] = [];
	for (const m of call.request.messages) {
		if (m.role === "system") {
			systemParts.push(m.content);
			continue;
		}
		const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
		messages.push({ role, content: m.content });
	}
	const maxTokens = call.request.maxTokens ?? defaultMaxTokens;
	return {
		model: call.target.model,
		max_tokens: maxTokens,
		...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
		messages,
	};
}

/** Join the `content[]` text blocks of a parsed Anthropic response into one string. */
function joinContentText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("");
}

/**
 * Build the REAL Anthropic Messages {@link ProviderTransport} (PRD-026 AC-T). The
 * router injects nothing (production uses `globalThis.fetch` + the real endpoint);
 * tests inject a fake `fetch` so no unit test touches the network. The resolved
 * `call.apiKey` is placed only in the `x-api-key` header and never logged/thrown.
 */
export function createAnthropicTransport(deps: AnthropicTransportDeps = {}): ProviderTransport {
	const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const url = deps.baseUrl ?? ANTHROPIC_MESSAGES_URL;
	const defaultMaxTokens = deps.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

	async function post(call: ProviderCall): Promise<string> {
		const body = toAnthropicBody(call, defaultMaxTokens);
		let res: FetchResponseLike;
		try {
			res = await doFetch(url, {
				method: "POST",
				headers: {
					"x-api-key": call.apiKey,
					"anthropic-version": ANTHROPIC_VERSION,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			// A network/transport failure (DNS, connection reset, timeout) is treated as
			// a 503 so the router falls back to the next target. The cause text is NOT a
			// provider body, but we still keep the message short and key-free.
			const detail = err instanceof Error ? err.name : "network error";
			throw new ProviderError(503, `anthropic transport: request failed (${detail})`);
		}
		if (!res.ok) {
			// Map the HTTP status onto a ProviderError the router's providerStatus(err)
			// reads. NEVER include the response body (could echo a credential) or the key.
			throw new ProviderError(res.status, `anthropic transport: provider returned status ${res.status}`);
		}
		// Parse the (untrusted) success body at the boundary via zod.
		const raw: unknown = await res.text().then((t) => safeJson(t));
		const parsed = AnthropicMessagesResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new ProviderError(502, "anthropic transport: malformed provider response");
		}
		return joinContentText(parsed.data.content);
	}

	return {
		async execute(call: ProviderCall): Promise<ProviderResult> {
			const output = await post(call);
			return { output };
		},
		stream(call: ProviderCall): AsyncIterable<ProviderChunk> {
			// The pollinating path consumes a whole completion, not a token stream, so this
			// is a thin non-stream execute that yields one terminal chunk carrying the
			// full text. The seam shape is preserved; a real SSE body can replace this
			// later without touching the router (documented in the module header).
			async function* gen(): AsyncIterable<ProviderChunk> {
				const output = await post(call);
				yield { delta: output };
			}
			return gen();
		},
	};
}

/** Parse text as JSON, returning `undefined` on failure (the zod boundary rejects it). */
function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
