/**
 * PRD-063c — the Cohere-via-Portkey rerank transport + seam (c-AC-1 / c-AC-2 / c-AC-3).
 *
 * Drives the REAL transport ({@link createPortkeyRerankClient}) + the REAL bound seam
 * ({@link buildCohereRerankSeam}) through a FAKE `fetch` — NO network is ever touched. Proves:
 *   c-AC-1  the request hits `POST /v1/rerank` with the resolved `x-portkey-api-key` + `x-portkey-config`
 *           headers and the Cohere body `{ model, query, documents, top_n }`; the response
 *           `results[].relevance_score` is surfaced (indexed back to the request order).
 *   c-AC-2  the resolved key appears in NO field of the captured call EXCEPT its auth header, and in NO
 *           returned value (grep-style assertion over the serialized seam result).
 *   c-AC-3  a hanging/error/non-2xx/malformed fetch each → `ok: false` (NEVER a throw), and the
 *           transport fires the `onTransportError` (unreachable) signal on transport/HTTP failures but
 *           NOT on a malformed-but-2xx body; a missing-key resolver also → `ok: false` (fail-soft).
 */

import { describe, expect, it, vi } from "vitest";

import { createFakeSecretResolver } from "../../../../src/daemon/runtime/inference/contracts.js";
import type { FetchLike, FetchResponseLike } from "../../../../src/daemon/runtime/inference/transport-anthropic.js";
import {
	PORTKEY_API_KEY_HEADER,
	PORTKEY_CONFIG_HEADER,
	PORTKEY_RERANK_URL,
} from "../../../../src/daemon/runtime/inference/transport-portkey.js";
import {
	buildCohereRerankSeam,
	createPortkeyRerankClient,
} from "../../../../src/daemon/runtime/recall/rerank-portkey.js";

const PORTKEY_KEY = "pk-portkey-secret-KEY-DEADBEEF";
const API_KEY_REF = "${PORTKEY_API_KEY}";
const CONFIG_ID = "pc-cfg-rerank-1";
const MODEL = "rerank-v3.5";

interface SeenCall {
	url: string;
	init: { method: string; headers: Record<string, string>; body: string };
}

/** A fake fetch that records the call and returns a fixed 2xx JSON body. */
function okFetch(body: unknown): { fetch: FetchLike; seen: SeenCall[] } {
	const seen: SeenCall[] = [];
	const fetch: FetchLike = (url, init) => {
		seen.push({ url, init });
		const res: FetchResponseLike = {
			status: 200,
			ok: true,
			text: () => Promise.resolve(JSON.stringify(body)),
		};
		return Promise.resolve(res);
	};
	return { fetch, seen };
}

describe("PRD-063c c-AC-1 — the rerank transport hits /v1/rerank with the auth header + Cohere body", () => {
	it("POSTs the resolved key header + config + { model, query, documents, top_n } and surfaces scores", async () => {
		const { fetch, seen } = okFetch({
			results: [
				{ index: 2, relevance_score: 0.9 },
				{ index: 0, relevance_score: 0.5 },
				{ index: 1, relevance_score: 0.1 },
			],
		});
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch });
		const out = await client.rerank(PORTKEY_KEY, {
			model: MODEL,
			query: "how do we wire portkey",
			documents: ["doc a", "doc b", "doc c"],
			topN: 3,
		});

		// One call, to the rerank URL (NOT the chat URL), with the SAME auth pair as 063b.
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe(PORTKEY_RERANK_URL);
		expect(seen[0]!.init.method).toBe("POST");
		expect(seen[0]!.init.headers[PORTKEY_API_KEY_HEADER]).toBe(PORTKEY_KEY);
		expect(seen[0]!.init.headers[PORTKEY_CONFIG_HEADER]).toBe(CONFIG_ID);
		// The Cohere body shape (c-D-1): `top_n` snake_case, documents verbatim.
		const body = JSON.parse(seen[0]!.init.body) as Record<string, unknown>;
		expect(body).toEqual({
			model: MODEL,
			query: "how do we wire portkey",
			documents: ["doc a", "doc b", "doc c"],
			top_n: 3,
		});
		// The scores come back indexed to the request `documents` order.
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.results).toEqual([
				{ index: 2, relevanceScore: 0.9 },
				{ index: 0, relevanceScore: 0.5 },
				{ index: 1, relevanceScore: 0.1 },
			]);
		}
	});

	it("drops an out-of-range index defensively (a bad index never crashes the reorder)", async () => {
		const { fetch } = okFetch({
			results: [
				{ index: 0, relevance_score: 0.9 },
				{ index: 7, relevance_score: 0.8 }, // out of range for a 2-doc request → dropped.
			],
		});
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch });
		const out = await client.rerank(PORTKEY_KEY, { model: MODEL, query: "q", documents: ["a", "b"], topN: 2 });
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.results).toEqual([{ index: 0, relevanceScore: 0.9 }]);
	});
});

describe("PRD-063c c-AC-2 — the resolved key never leaks beyond its auth header", () => {
	it("appears in no captured call field but the header, and in no returned value", async () => {
		const { fetch, seen } = okFetch({ results: [{ index: 0, relevance_score: 0.5 }] });
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch });
		const out = await client.rerank(PORTKEY_KEY, { model: MODEL, query: "q", documents: ["only doc"], topN: 1 });

		// The URL + body carry NO key; only the auth header does.
		expect(seen[0]!.url).not.toContain(PORTKEY_KEY);
		expect(seen[0]!.init.body).not.toContain(PORTKEY_KEY);
		const headersMinusAuth = { ...seen[0]!.init.headers };
		delete headersMinusAuth[PORTKEY_API_KEY_HEADER];
		expect(JSON.stringify(headersMinusAuth)).not.toContain(PORTKEY_KEY);
		// The returned value carries NO key (grep-style over the serialized result).
		expect(JSON.stringify(out)).not.toContain(PORTKEY_KEY);
	});

	it("the bound seam resolves the key via ${SECRET_REF} and surfaces no key in its result", async () => {
		const { fetch, seen } = okFetch({ results: [{ index: 0, relevance_score: 0.7 }] });
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch });
		const seam = buildCohereRerankSeam({
			client,
			secrets: createFakeSecretResolver({ [API_KEY_REF]: PORTKEY_KEY }),
			apiKeyRef: API_KEY_REF,
			model: MODEL,
		});
		const out = await seam.rerank("q", ["doc"], 1);
		// The resolver decrypted the key and it reached ONLY the header.
		expect(seen[0]!.init.headers[PORTKEY_API_KEY_HEADER]).toBe(PORTKEY_KEY);
		expect(JSON.stringify(out)).not.toContain(PORTKEY_KEY);
		expect(out.ok).toBe(true);
	});
});

describe("PRD-063c c-AC-3 — every failure path is fail-soft (ok:false, never a throw) + the signal", () => {
	it("a network/transport error → ok:false AND fires the unreachable signal (503)", async () => {
		const onTransportError = vi.fn();
		const fetch: FetchLike = () => Promise.reject(new Error("ECONNRESET"));
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch, onTransportError });
		const out = await client.rerank(PORTKEY_KEY, { model: MODEL, query: "q", documents: ["a"], topN: 1 });
		expect(out).toEqual({ ok: false });
		expect(onTransportError).toHaveBeenCalledWith(503);
	});

	it("a non-2xx gateway status → ok:false AND fires the unreachable signal with the status", async () => {
		const onTransportError = vi.fn();
		const fetch: FetchLike = () =>
			Promise.resolve({ status: 401, ok: false, text: () => Promise.resolve("unauthorized") });
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch, onTransportError });
		const out = await client.rerank(PORTKEY_KEY, { model: MODEL, query: "q", documents: ["a"], topN: 1 });
		expect(out).toEqual({ ok: false });
		expect(onTransportError).toHaveBeenCalledWith(401);
	});

	it("a malformed 2xx body → ok:false but does NOT fire the signal (the gateway WAS reachable)", async () => {
		const onTransportError = vi.fn();
		const fetch: FetchLike = () =>
			Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve("}{ not json") });
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch, onTransportError });
		const out = await client.rerank(PORTKEY_KEY, { model: MODEL, query: "q", documents: ["a"], topN: 1 });
		expect(out).toEqual({ ok: false });
		expect(onTransportError).not.toHaveBeenCalled();
	});

	it("a 2xx body with the WRONG shape → ok:false (no throw, no signal)", async () => {
		const onTransportError = vi.fn();
		const fetch: FetchLike = () =>
			Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify({ nope: true })) });
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch, onTransportError });
		const out = await client.rerank(PORTKEY_KEY, { model: MODEL, query: "q", documents: ["a"], topN: 1 });
		// A wrong-shape 2xx body is malformed (no `results`) → it FAILS validation → ok:false (the caller
		// keeps RRF). Never coerced to an empty-but-ok result; never a throw; never a transport signal.
		expect(out).toEqual({ ok: false });
		expect(onTransportError).not.toHaveBeenCalled();
	});

	it("a missing key (resolver rejects) → the seam returns ok:false, never a throw, never a fetch", async () => {
		const { fetch, seen } = okFetch({ results: [{ index: 0, relevance_score: 1 }] });
		const client = createPortkeyRerankClient({ config: CONFIG_ID, fetch });
		const seam = buildCohereRerankSeam({
			client,
			secrets: createFakeSecretResolver({}), // no PORTKEY_API_KEY → resolver rejects.
			apiKeyRef: API_KEY_REF,
			model: MODEL,
		});
		const out = await seam.rerank("q", ["doc"], 1);
		expect(out).toEqual({ ok: false });
		expect(seen).toHaveLength(0); // never reached the transport (no key resolved).
	});
});
