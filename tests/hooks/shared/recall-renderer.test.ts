/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-076a recall-renderer suite - a-AC-1 / a-AC-2 / a-AC-3 (the thin loopback recall POST).
 *
 * Drives the production {@link createRecallRenderer} against an injected `fetch` stub (no real
 * socket). Proves:
 *   - a-AC-1: the request POSTs `{ query, limit, tokenBudget, cwd }` to `/api/memories/recall`,
 *     with the prompt as `query`, the session `cwd` forwarded, and a bounded limit/tokenBudget.
 *   - a-AC-2: the request stamps the session-group headers (runtime-path + session) + tenancy;
 *     a signed-out credential is sent unscoped (no org header) and degrades to `[]`.
 *   - a-AC-3: EVERY degrade path - timeout, non-200, malformed body, unreachable - resolves to
 *     `[]` (no injection), never a throw.
 */

import { describe, expect, it, vi } from "vitest";

import type { HookSessionMeta } from "../../../src/hooks/shared/contracts.js";
import {
	createRecallRenderer,
	DEFAULT_RECALL_LIMIT,
	DEFAULT_RECALL_TOKEN_BUDGET,
	MIN_INJECTION_SCORE,
	RECALL_PATH,
} from "../../../src/hooks/shared/recall-renderer.js";

const META: HookSessionMeta = {
	sessionId: "sess-recall",
	path: "conv-1",
	cwd: "/repo/honeycomb",
	agent: "claude-code",
};

interface Seen {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

/** A recording fetch stub: captures the URL + method + headers + body and returns a configurable response. */
function recordingFetch(res: { status: number; body: string }): { fetch: typeof fetch; seen: Seen } {
	const seen: Seen = {};
	const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
		seen.url = url;
		seen.method = init.method;
		seen.headers = init.headers;
		seen.body = init.body;
		return {
			status: res.status,
			async text() {
				return res.body;
			},
		};
	}) as unknown as typeof fetch;
	return { fetch: fakeFetch, seen };
}

const HITS_BODY = JSON.stringify({
	hits: [
		{ source: "memories", id: "m1", text: "Token TTL dropped to 1h (decided 2026-07-01).", score: 2, kind: "memory" },
		// ISS-024: a raw session dump — the injection gate excludes it per-turn (drill-down only).
		{ source: "sessions", id: "conv-9", text: "auth refactor thread", score: 1, kind: "session", secondary: true },
	],
	sources: ["memories", "sessions"],
	degraded: false,
});

describe("PRD-076a recall renderer - a-AC-1 request shape", () => {
	it("a-AC-1: POSTs { query, limit, tokenBudget, cwd } to /api/memories/recall", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch });

		const hits = await renderer.render({
			meta: META,
			credential: { token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" },
			query: "what did we decide about auth?",
		});

		// It hit the recall route over loopback with a POST.
		expect(seen.url).toBe(`http://127.0.0.1:3850${RECALL_PATH}`);
		expect(seen.method).toBe("POST");
		// The body carries the prompt as `query`, the session cwd, and a bounded limit/budget.
		const body = JSON.parse(seen.body ?? "{}") as Record<string, unknown>;
		expect(body.query).toBe("what did we decide about auth?");
		expect(body.cwd).toBe("/repo/honeycomb");
		expect(body.limit).toBe(DEFAULT_RECALL_LIMIT);
		expect(body.tokenBudget).toBe(DEFAULT_RECALL_TOKEN_BUDGET);
		// The daemon-bounded hits are coerced to { ref, text } (ref = source:id for dedupe).
		// ISS-024: the raw sessions hit is gated out of per-turn injection.
		expect(hits).toEqual([{ ref: "memories:m1", text: "Token TTL dropped to 1h (decided 2026-07-01)." }]);
	});

	it("a-AC-1: an empty prompt is not sent (no recall on a blank turn)", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		const hits = await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "   " });
		expect(hits).toEqual([]);
		expect(seen.url, "no request is made for an empty query").toBeUndefined();
	});

	it("a-AC-1: a custom limit/tokenBudget overrides the defaults in the body", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch, limit: 3, tokenBudget: 200 });
		await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" });
		const body = JSON.parse(seen.body ?? "{}") as Record<string, unknown>;
		expect(body.limit).toBe(3);
		expect(body.tokenBudget).toBe(200);
	});
});

describe("PRD-076a recall renderer - a-AC-2 header stamp + signed-out degrade", () => {
	it("a-AC-2: stamps the session-group + tenancy headers (mirrors prime-renderer)", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		await renderer.render({
			meta: META,
			credential: { token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" },
			query: "auth?",
		});
		// The session group REQUIRES these two - a bare POST without them is a 400.
		expect(seen.headers?.["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(seen.headers?.["x-honeycomb-session"]).toBe("sess-recall");
		// Tenancy scopes the recall to the repo/agent partition.
		expect(seen.headers?.["x-honeycomb-org"]).toBe("acme");
		expect(seen.headers?.["x-honeycomb-workspace"]).toBe("ws-1");
		expect(seen.headers?.["x-honeycomb-actor"]).toBe("agent-1");
	});

	it("a-AC-2: an org-less credential falls back to the default workspace sentinel", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" });
		expect(seen.headers?.["x-honeycomb-workspace"]).toBe("default");
	});

	it("a-AC-2: a signed-out credential stamps NO org and degrades to [] (daemon fail-closes)", async () => {
		// The daemon fail-closes an org-less recall (400); the renderer degrades to [] on the non-200.
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 400, body: JSON.stringify({ error: "no_org" }) });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		const hits = await renderer.render({ meta: META, credential: undefined, query: "auth?" });
		expect(hits).toEqual([]);
		expect(seen.headers?.["x-honeycomb-org"]).toBeUndefined();
		expect(seen.headers?.["x-honeycomb-workspace"]).toBeUndefined();
	});

	it("a-AC-2: the renderer NEVER carries a bearer token in a header value (redaction)", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		await renderer.render({ meta: META, credential: { token: "secret-token-xyz", org: "acme" }, query: "auth?" });
		const keys = Object.keys(seen.headers ?? {});
		expect(keys).not.toContain("authorization");
		expect(keys.some((k) => /token/i.test(k))).toBe(false);
		expect(JSON.stringify(seen.headers)).not.toContain("secret-token-xyz");
	});
});

describe("PRD-076a recall renderer - a-AC-3 graceful degradation (never a throw)", () => {
	it("a-AC-3: an unreachable daemon (fetch rejects) degrades to []", async () => {
		const failingFetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const renderer = createRecallRenderer({ fetch: failingFetch });
		expect(await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" })).toEqual([]);
	});

	it("a-AC-3: a non-200 status (500) degrades to []", async () => {
		const { fetch: fakeFetch } = recordingFetch({ status: 500, body: JSON.stringify({ error: "boom" }) });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		expect(await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" })).toEqual([]);
	});

	it("a-AC-3: a malformed body degrades to []", async () => {
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body: "{ not json" });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		expect(await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" })).toEqual([]);
	});

	it("a-AC-3: a body with no hits array degrades to []", async () => {
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body: JSON.stringify({ sources: [], degraded: true }) });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		expect(await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" })).toEqual([]);
	});

	it("ISS-024: below-floor scores are gated out; missing scores are kept (fail-open)", async () => {
		const body = JSON.stringify({
			hits: [
				// A real fresh rank-1 hit (1/61 ≈ 0.016) — comfortably above the floor.
				{ source: "memories", id: "m-keep", text: "kept fact", score: 0.016, kind: "memory" },
				// The live-observed noise tier: fused scores rendering as 0.00 — gated.
				{ source: "memories", id: "m-noise", text: "deep-conjunct-rank noise", score: 0.001, kind: "memory" },
				// An older daemon that omits `score` entirely — kept, never blanked (fail-open).
				{ source: "memories", id: "m-legacy", text: "legacy shape", kind: "memory" },
			],
			sources: ["memories"],
			degraded: false,
		});
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		const hits = await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" });
		expect(hits).toEqual([
			{ ref: "memories:m-keep", text: "kept fact" },
			{ ref: "memories:m-legacy", text: "legacy shape" },
		]);
	});

	it("ISS-024: raw session dumps are gated on EITHER provenance signal (secondary OR kind)", async () => {
		const body = JSON.stringify({
			hits: [
				// Signal 1: `secondary: true` alone (kind absent — a thin/older projection).
				{ source: "sessions", id: "s1", text: '{"event":{"kind":"tool_call"}}', score: 0.06, secondary: true },
				// Signal 2: `kind: "session"` alone (secondary absent).
				{ source: "sessions", id: "s2", text: "raw turn text", score: 0.05, kind: "session" },
				// A distilled hit rides through untouched.
				{ source: "memory", id: "sum-1", text: "a session summary", score: 0.02, kind: "memory", secondary: false },
			],
			sources: ["sessions", "memory"],
			degraded: false,
		});
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body });
		const renderer = createRecallRenderer({ fetch: fakeFetch });
		const hits = await renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" });
		expect(hits).toEqual([{ ref: "memory:sum-1", text: "a session summary" }]);
	});

	it("ISS-024: a custom minScore overrides the default floor", async () => {
		const body = JSON.stringify({
			hits: [
				{ source: "memories", id: "m1", text: "just above default floor", score: MIN_INJECTION_SCORE, kind: "memory" },
			],
			sources: ["memories"],
			degraded: false,
		});
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body });
		// A stricter floor gates the hit the default admits.
		const strict = createRecallRenderer({ fetch: fakeFetch, minScore: 0.01 });
		expect(await strict.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" })).toEqual([]);
		const { fetch: laxFetch } = recordingFetch({ status: 200, body });
		// minScore: 0 disables the floor entirely (score >= 0 always passes).
		const lax = createRecallRenderer({ fetch: laxFetch, minScore: 0 });
		expect(await lax.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" })).toEqual([
			{ ref: "memories:m1", text: "just above default floor" },
		]);
	});

	it("a-AC-3: a slow daemon is bounded by the timeout and degrades to []", async () => {
		vi.useFakeTimers();
		try {
			const hangingFetch = ((_url: string, init: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				})) as unknown as typeof fetch;
			const renderer = createRecallRenderer({ fetch: hangingFetch, timeoutMs: 50 });
			const pending = renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" });
			await vi.advanceTimersByTimeAsync(60);
			expect(await pending).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
