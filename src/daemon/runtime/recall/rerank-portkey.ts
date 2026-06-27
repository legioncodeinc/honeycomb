/**
 * Cohere-via-Portkey rerank transport — PRD-063c (c-AC-1 / c-AC-3).
 *
 * The FIRST provider reranker in the product. Honeycomb's recall pipeline today reranks with a
 * LOCAL `embedding-cosine` pass or `none`; this transport adds the `cohere` strategy, sending the
 * query + the fused top-N candidate TEXTS to Cohere THROUGH the Portkey gateway and returning the
 * relevance-ordered indices so {@link rerankHits} can reorder the window.
 *
 * ── Reuses 063b's Portkey foundation (c-D-2) ─────────────────────────────────
 * The host + auth are IDENTICAL to the 063b chat transport (`transport-portkey.ts`): the same
 * `x-portkey-api-key` + `x-portkey-config` header pair (via the shared {@link buildPortkeyHeaders}),
 * the same injectable {@link FetchLike}, and the same `${SECRET_REF}`-resolved key discipline. The
 * ONE difference is the PATH (`/v1/rerank`, {@link PORTKEY_RERANK_URL}) and the Cohere request/
 * response SHAPE (`{ model, query, documents, top_n }` → `{ results: [{ index, relevance_score }] }`,
 * c-D-1). No header object or base host is re-hand-rolled here (jscpd discipline).
 *
 * ── FAIL-SOFT is the cardinal rule (c-AC-3) ──────────────────────────────────
 * Reranking must NEVER break, stall, or empty a recall. EVERY failure path — a network/transport
 * error, a non-2xx gateway status, a malformed/garbage body, or an out-of-range index — resolves to
 * a {@link RerankCallResult} with `ok: false` (NEVER a throw the caller must catch on the hot path).
 * The caller ({@link rerankHits}) maps any `ok: false` straight to the RRF order. The timeout is the
 * CALLER's concern (it races this call against its bounded budget); this transport simply does ONE
 * round-trip and reports the outcome.
 *
 * ── The observed-failure signal (c-AC-3, reuses 063b) ────────────────────────
 * On a network/transport failure or a non-2xx status, {@link onTransportError} is fired with the
 * HTTP-like status code IMMEDIATELY before the failure result is returned — the SAME cached
 * last-failure signal the chat transport uses, so assembly flips `/health` `reasons.portkey` to
 * `unreachable` from a REAL rerank failure (never a probe). A malformed-but-2xx body does NOT fire it
 * (the gateway WAS reachable, the body was just bad) — exactly the chat transport's 502 rule.
 *
 * ── The secret-never-logged invariant (c-AC-2) ───────────────────────────────
 * `apiKey` is the resolved `PORTKEY_API_KEY`, local to one call. It is placed ONLY in the
 * `x-portkey-api-key` header (via {@link buildPortkeyHeaders}) and is NEVER included in a returned
 * value, a log line, or a thrown/returned error message. Daemon-only module (no agent surface).
 */

import { z } from "zod";

import type { SecretResolver } from "../inference/contracts.js";
import {
	type FetchLike,
	type FetchResponseLike,
	safeJsonParse,
} from "../inference/transport-anthropic.js";
import { buildPortkeyHeaders, PORTKEY_RERANK_URL } from "../inference/transport-portkey.js";

/** One reranked document: its `index` into the request `documents` array + its `relevance_score`. */
export interface RerankResultEntry {
	/** The position in the REQUEST `documents` array this score belongs to. */
	readonly index: number;
	/** Cohere's normalized relevance score in `[0,1]`; higher = more relevant. */
	readonly relevanceScore: number;
}

/**
 * The outcome of ONE rerank round-trip. FAIL-SOFT by type: a failure is a typed `ok: false` result,
 * NOT a throw — the caller maps it to the RRF order without a try/catch on the hot path.
 *   - `ok: true`  → `results` carries the (possibly re-ordered) per-document relevance scores.
 *   - `ok: false` → the rerank could not be applied (transport error, non-2xx, malformed body); the
 *                   caller keeps the RRF order. Carries NO message/body/key (c-AC-2).
 */
export type RerankCallResult =
	| { readonly ok: true; readonly results: readonly RerankResultEntry[] }
	| { readonly ok: false };

/** A single fail-soft outcome, shared so the failure shape is constructed in exactly one place. */
const RERANK_FAILED: RerankCallResult = Object.freeze({ ok: false });

/** Construction deps for {@link createPortkeyRerankClient}. Everything IO-touching is injectable (test seam). */
export interface PortkeyRerankDeps {
	/** The Portkey config / virtual-key id sent in the `x-portkey-config` header (the `portkey.config` setting). */
	readonly config: string;
	/** The `fetch` implementation; defaults to `globalThis.fetch`. Tests inject a fake (no network). */
	readonly fetch?: FetchLike;
	/** The endpoint URL; defaults to {@link PORTKEY_RERANK_URL}. Override for a fake-fetch test. */
	readonly baseUrl?: string;
	/**
	 * The observed-failure callback (c-AC-3, reuses the 063b `recordPortkeyUnreachable` seam). Fired
	 * with the HTTP-like status on a transport failure (503) or a non-2xx gateway status, just before
	 * the `ok: false` result is returned. A malformed-but-2xx body does NOT fire it. Total +
	 * non-throwing (a faulty observer never breaks a recall). Absent → no signal wired.
	 */
	readonly onTransportError?: (statusCode: number) => void;
}

/** The Cohere rerank request body Portkey forwards (c-D-1). `top_n` bounds how many results come back. */
export interface RerankRequest {
	/** The Cohere rerank model id (e.g. `rerank-v3.5`); the operator may configure it in Portkey. */
	readonly model: string;
	/** The natural-language query the documents are scored against. */
	readonly query: string;
	/** The candidate document TEXTS, in the caller's window order. */
	readonly documents: readonly string[];
	/** The max number of results to return (the caller passes the window size). */
	readonly topN: number;
}

/** The rerank client the recall stage calls. ONE method; always resolves (never rejects). */
export interface PortkeyRerankClient {
	/** Run ONE rerank round-trip. Resolves to a {@link RerankCallResult}; NEVER rejects (c-AC-3). */
	rerank(apiKey: string, request: RerankRequest): Promise<RerankCallResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// Response boundary — zod validates the (untrusted) Cohere/Portkey JSON.
// ────────────────────────────────────────────────────────────────────────────

/**
 * One entry of the Cohere rerank response `results` array (c-D-1). `index` is the position into the
 * REQUEST `documents`, `relevance_score` the normalized `[0,1]` score. Lenient on extra fields the
 * gateway/provider may add; strict on the two we depend on.
 */
const RerankResultSchema = z.object({
	index: z.number().int().nonnegative(),
	relevance_score: z.number(),
});

/** The Cohere rerank success-response shape (only the field we read). */
const RerankResponseSchema = z.object({
	results: z.array(RerankResultSchema).default([]),
});

/**
 * Build the REAL Cohere-via-Portkey rerank client (c-AC-1). The recall stage injects the `config`
 * id; production uses `globalThis.fetch` + the real {@link PORTKEY_RERANK_URL}, a test injects a fake
 * `fetch` + `baseUrl` so no unit test touches the network. `rerank` NEVER rejects — every failure is
 * a typed `ok: false` the caller maps to the RRF order (c-AC-3).
 */
export function createPortkeyRerankClient(deps: PortkeyRerankDeps): PortkeyRerankClient {
	const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const url = deps.baseUrl ?? PORTKEY_RERANK_URL;
	const configId = deps.config;
	const onTransportError = deps.onTransportError;

	/** Fire the observed-failure signal defensively (c-AC-3) — a faulty observer never breaks a recall. */
	function reportTransportError(statusCode: number): void {
		if (onTransportError === undefined) return;
		try {
			onTransportError(statusCode);
		} catch {
			/* an observer fault is swallowed: the health signal is best-effort, never breaks recall. */
		}
	}

	return {
		async rerank(apiKey: string, request: RerankRequest): Promise<RerankCallResult> {
			// The Cohere rerank body (c-D-1): `{ model, query, documents, top_n }`.
			const body = {
				model: request.model,
				query: request.query,
				documents: request.documents,
				top_n: request.topN,
			};
			let res: FetchResponseLike;
			try {
				res = await doFetch(url, {
					method: "POST",
					// SAME auth pair as the chat transport (c-D-2); the key lives only in the header (c-AC-2).
					headers: buildPortkeyHeaders(apiKey, configId),
					body: JSON.stringify(body),
				});
			} catch {
				// A network/transport failure (DNS, reset, abort/timeout) → 503 signal + fail-soft (c-AC-3).
				// NEVER surface the error (it could carry a body/key) — only the typed failure result.
				reportTransportError(503);
				return RERANK_FAILED;
			}
			if (!res.ok) {
				// A non-2xx gateway status (auth 401/403, rate-limit 429, 5xx) is an observed failure → signal
				// unreachability + fail-soft. NEVER read/surface the body (it could echo a credential).
				reportTransportError(res.status);
				return RERANK_FAILED;
			}
			// A 2xx with a malformed/garbage body is NOT an unreachability (the gateway WAS reachable) — do
			// NOT fire the signal; just fail soft to the RRF order (c-AC-3, mirrors the chat transport's 502).
			const raw: unknown = await res.text().then((t) => safeJsonParse(t)).catch(() => undefined);
			const parsed = RerankResponseSchema.safeParse(raw);
			if (!parsed.success) return RERANK_FAILED;
			// Drop any index that points outside the request window (a defensive guard: a bad index must
			// never leapfrog or crash the reorder). An empty surviving set is still `ok` — the caller keeps
			// the un-moved candidates in RRF order.
			const results = parsed.data.results
				.filter((r) => r.index < request.documents.length)
				.map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
			return { ok: true, results };
		},
	};
}

/**
 * The recall-engine rerank seam (PRD-063c / c-D-2): a `rerank(query, documents, topN)` function with
 * the secret + transport + config + health-signal ALL closed over, so the recall engine never sees
 * any of them (c-AC-2). Structurally satisfies `memories/recall.ts`'s `CohereRerankSeam` WITHOUT
 * importing it (no cross-module type cycle); the engine consumes it by shape.
 */
export interface CohereRerankSeamLike {
	rerank(query: string, documents: readonly string[], topN: number): Promise<RerankCallResult>;
}

/** Construction deps for {@link buildCohereRerankSeam}. Assembly supplies the resolver + config + model. */
export interface CohereRerankSeamDeps {
	/** The rerank transport (production: {@link createPortkeyRerankClient}; a test injects a fake). */
	readonly client: PortkeyRerankClient;
	/** The `${SECRET_REF}` resolver (the SAME `createSecretResolver` 063b uses) — resolves `PORTKEY_API_KEY`. */
	readonly secrets: SecretResolver;
	/** The `${PORTKEY_API_KEY}` reference the resolver decrypts at call time (never inlined). */
	readonly apiKeyRef: string;
	/** The Cohere rerank model id (the resolved `RerankerConfig.cohereModel`). */
	readonly model: string;
}

/**
 * Build the bound Cohere rerank seam (c-AC-1 / c-AC-2 / c-AC-3). On each call it resolves
 * `PORTKEY_API_KEY` through the `${SECRET_REF}` resolver — the key is decrypted IN-PROCESS for that
 * one call and placed ONLY in the transport's auth header, NEVER logged, returned, or stored. A
 * resolver failure (missing key) is caught and degrades to `ok: false` so a misconfigured key fails
 * SOFT to the RRF order (never a thrown recall, c-AC-3). The `rerank` function ALWAYS resolves.
 */
export function buildCohereRerankSeam(deps: CohereRerankSeamDeps): CohereRerankSeamLike {
	return {
		async rerank(query: string, documents: readonly string[], topN: number): Promise<RerankCallResult> {
			let apiKey: string;
			try {
				// Resolve the key at call time (the only moment it exists in-process). A missing/undecryptable
				// key REJECTS → caught here → fail-soft `ok: false` (the RRF order stands, c-AC-3). The error is
				// NOT surfaced (it could name the secret) — only the typed failure is returned.
				apiKey = await deps.secrets.resolve(deps.apiKeyRef);
			} catch {
				return { ok: false };
			}
			return deps.client.rerank(apiKey, { model: deps.model, query, documents, topN });
		},
	};
}
