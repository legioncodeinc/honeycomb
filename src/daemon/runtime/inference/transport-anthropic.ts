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
 *
 * ── The usage-surfacing seam (PRD-060d / d-AC-1) ─────────────────────────────
 * The Anthropic Messages response carries a top-level `usage` object
 * (`{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`)
 * that this transport historically PARSED ONLY `content` from and DISCARDED. PRD-060d
 * needs Honeycomb's OWN inference (the Haiku skillify gate) token cost, so this module
 * now ADDITIVELY surfaces that `usage` through an injectable {@link UsageSink}: on every
 * successful `execute`/`stream` the parsed token counts + the call's model id are reported
 * to the sink. This is a PURE SIDE-CHANNEL — it changes NOTHING about routing, retries,
 * the KEEP/MERGE/SKIP gate, the model choice, or the returned {@link ProviderResult}: a
 * transport built WITHOUT a sink behaves byte-for-byte as before (the default is a no-op).
 * The sink is fed only on the success path (a thrown {@link ProviderError} reports nothing),
 * and a missing/malformed `usage` object surfaces zero counts rather than throwing.
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

/**
 * One usage report surfaced to a {@link UsageSink} after a successful provider call
 * (PRD-060d / d-AC-1). The four token counts mirror the Anthropic `usage` object the
 * transport historically discarded; `model` is the target model id the call ran against
 * (so the meter can attribute Haiku-vs-other and 060b's rate table can price the right
 * row), and `workload` is the routing workload (e.g. `memory_pollinating`) so a sink can
 * scope to a particular own-inference path. Every count is a non-negative integer.
 */
export interface UsageReport {
	/** The target model id this call ran against (the rate-table key + Haiku discriminant). */
	readonly model: string;
	/** The routing workload this call served (e.g. `memory_pollinating`). */
	readonly workload: string;
	/** Uncached prompt (input) tokens billed for this call. */
	readonly inputTokens: number;
	/** Completion (output) tokens billed for this call. */
	readonly outputTokens: number;
	/** Cache-READ (cache-hit) input tokens billed at the cache-read rate. */
	readonly cacheReadInputTokens: number;
	/** Cache-WRITE (cache-creation) input tokens billed at the cache-write rate. */
	readonly cacheCreationInputTokens: number;
}

/**
 * The usage-surfacing SEAM (PRD-060d / d-AC-1). The transport reports one
 * {@link UsageReport} per SUCCESSFUL call so a downstream meter (the skillify usage
 * sink) can roll up Honeycomb's own-inference token cost. `record` MUST be total +
 * non-throwing — it is called on the hot path and a sink failure must never break an
 * inference call. The production default is a no-op (no metering until a sink is wired),
 * so the seam is invisible to every existing caller and test.
 */
export interface UsageSink {
	/** Record one successful call's token usage. Total + non-throwing (hot-path safe). */
	record(report: UsageReport): void;
}

/** A no-op {@link UsageSink} — the default when no meter is wired (zero behavior change). */
export const noopUsageSink: UsageSink = {
	record(): void {
		/* discard — the historical behavior (usage was dropped) is preserved by default. */
	},
};

/**
 * The result of one provider POST: the joined completion text + the parsed {@link UsageReport}.
 * Both the Anthropic and the Portkey transports' `post` helpers return this shape (the per-provider
 * request reshaping + response parsing differ; the post-call plumbing below is shared).
 */
export interface PostResult {
	/** The joined completion text. */
	readonly output: string;
	/** The token usage parsed from the (provider-specific) response. */
	readonly usage: UsageReport;
}

/**
 * Build the `{ execute, stream }` {@link ProviderTransport} shape SHARED by every OpenAI/Anthropic-
 * compatible transport (the post-call plumbing the router calls). Given a provider-specific
 * `post(call) → { output, usage }` (which does the request reshaping + response parsing + error
 * mapping) and a {@link UsageSink}, this wires:
 *   - `execute` → await `post`, feed the sink (defensively), return `{ output }`;
 *   - `stream`  → the thin non-stream wrapper that yields ONE terminal {@link ProviderChunk}
 *                 carrying the full text (the pollinating path consumes a whole completion, not a
 *                 token stream; a real SSE body can replace this later without touching the router).
 * The sink is fed ONLY on the success path (a thrown {@link ProviderError} from `post` reports
 * nothing) and a sink fault is swallowed (hot-path safe — metering never breaks an inference call).
 *
 * Extracted so the Anthropic + Portkey transports share this identical plumbing rather than each
 * hand-rolling it (jscpd discipline): the transports differ in `post`, not in how `post` is wired.
 */
export function usageReportingTransport(
	post: (call: ProviderCall) => Promise<PostResult>,
	usageSink: UsageSink,
): ProviderTransport {
	function reportUsage(usage: UsageReport): void {
		try {
			usageSink.record(usage);
		} catch {
			/* a sink fault is swallowed: metering is best-effort and never breaks inference. */
		}
	}
	return {
		async execute(call: ProviderCall): Promise<ProviderResult> {
			const { output, usage } = await post(call);
			reportUsage(usage);
			return { output };
		},
		stream(call: ProviderCall): AsyncIterable<ProviderChunk> {
			async function* gen(): AsyncIterable<ProviderChunk> {
				const { output, usage } = await post(call);
				reportUsage(usage);
				yield { delta: output };
			}
			return gen();
		},
	};
}

/** Parse text as JSON, returning `undefined` on failure (the zod boundary rejects it). Shared. */
export function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Construction deps for {@link createAnthropicTransport}. Everything IO-touching is injectable. */
export interface AnthropicTransportDeps {
	/** The `fetch` implementation; defaults to `globalThis.fetch`. Tests inject a fake. */
	readonly fetch?: FetchLike;
	/** The endpoint URL; defaults to {@link ANTHROPIC_MESSAGES_URL}. Override for OpenRouter/compatible. */
	readonly baseUrl?: string;
	/** The default `max_tokens` when a request omits its own; defaults to {@link DEFAULT_MAX_TOKENS}. */
	readonly defaultMaxTokens?: number;
	/**
	 * The usage sink the transport reports each successful call's token usage to (PRD-060d /
	 * d-AC-1). Defaults to {@link noopUsageSink} so a transport built without one behaves
	 * EXACTLY as before — usage is surfaced ONLY when a meter is injected.
	 */
	readonly usageSink?: UsageSink;
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

/**
 * The Anthropic Messages `usage` object (PRD-060d / d-AC-1) — the token counts the
 * transport historically discarded. Each field is an optional non-negative integer that
 * defaults to `0` (a response omitting `usage`, or a field, surfaces zero rather than a
 * NaN/throw). The shape is lenient on extra fields the provider may add.
 */
const AnthropicUsageSchema = z.object({
	input_tokens: z.number().int().nonnegative().catch(0).default(0),
	output_tokens: z.number().int().nonnegative().catch(0).default(0),
	cache_read_input_tokens: z.number().int().nonnegative().catch(0).default(0),
	cache_creation_input_tokens: z.number().int().nonnegative().catch(0).default(0),
});

/** The all-zero usage fallback (a response with absent/null/malformed `usage` surfaces this, not a throw). */
const ZERO_USAGE = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
} as const;

/** The Anthropic Messages success-response shape (only the fields we read). */
const AnthropicMessagesResponseSchema = z.object({
	content: z.array(AnthropicContentBlockSchema).default([]),
	// Finding (usage-failsoft): `.default(ZERO_USAGE)` only covers `usage === undefined`. A response with
	// `usage: null` or a malformed `usage` object would FAIL the object parse and -- because this field is
	// part of the whole-response schema -- bubble up to a 502 that DROPS an otherwise-valid completion.
	// `.catch(ZERO_USAGE)` makes ANY invalid value (null, a string, a malformed object) fall back to
	// zero-usage so a valid completion is NEVER dropped over its (side-channel) usage block.
	usage: AnthropicUsageSchema.default(ZERO_USAGE).catch(ZERO_USAGE),
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
	const usageSink: UsageSink = deps.usageSink ?? noopUsageSink;

	/**
	 * POST the call and return BOTH the joined completion text AND the parsed `usage`
	 * (PRD-060d / d-AC-1). The usage is surfaced to the caller (which feeds the sink on the
	 * success path) rather than discarded. Throws a {@link ProviderError} on any failure — a
	 * thrown call surfaces NO usage (the sink is fed only on success).
	 */
	async function post(call: ProviderCall): Promise<{ output: string; usage: UsageReport }> {
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
		const raw: unknown = await res.text().then((t) => safeJsonParse(t));
		const parsed = AnthropicMessagesResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new ProviderError(502, "anthropic transport: malformed provider response");
		}
		// Surface the `usage` the transport historically discarded (PRD-060d). Attribute it to
		// the call's target model + workload so the meter can price Haiku tokens (060b) and a
		// sink can scope to a particular own-inference path.
		const u = parsed.data.usage;
		const usage: UsageReport = {
			model: call.target.model,
			workload: call.request.workload,
			inputTokens: u.input_tokens,
			outputTokens: u.output_tokens,
			cacheReadInputTokens: u.cache_read_input_tokens,
			cacheCreationInputTokens: u.cache_creation_input_tokens,
		};
		return { output: joinContentText(parsed.data.content), usage };
	}

	// The `{ execute, stream }` plumbing is the SHARED OpenAI/Anthropic-compatible wrapper
	// (jscpd discipline) — this transport supplies only the provider-specific `post`.
	return usageReportingTransport(post, usageSink);
}
