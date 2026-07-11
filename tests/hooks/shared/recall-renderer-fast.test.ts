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
 * PRD-077a — L-A8 (a-AC-6): the recall renderer POSTs `fast: true` while its header
 * stamp + `AbortController` + fail-soft `[]` contract is UNCHANGED. Drives the production
 * {@link createRecallRenderer} against an injected `fetch` stub (no real socket).
 */

import { describe, expect, it, vi } from "vitest";

import type { HookSessionMeta } from "../../../src/hooks/shared/contracts.js";
import { createRecallRenderer, RECALL_PATH } from "../../../src/hooks/shared/recall-renderer.js";

const META: HookSessionMeta = {
	sessionId: "sess-recall",
	path: "conv-1",
	cwd: "/repo/honeycomb",
	agent: "claude-code",
};

interface Seen {
	url?: string;
	headers?: Record<string, string>;
	body?: string;
}

function recordingFetch(res: { status: number; body: string }): { fetch: typeof fetch; seen: Seen } {
	const seen: Seen = {};
	const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
		seen.url = url;
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
	hits: [{ source: "memories", id: "m1", text: "a recalled fact", score: 1, kind: "memory" }],
	sources: ["memories"],
	degraded: false,
});

describe("L-A8 (a-AC-6): the renderer POSTs fast:true with the session/tenancy headers intact", () => {
	it("the request body carries fast:true alongside query/limit/tokenBudget/cwd", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({ status: 200, body: HITS_BODY });
		const renderer = createRecallRenderer({ fetch: fakeFetch });

		const hits = await renderer.render({
			meta: META,
			credential: { token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" },
			query: "what did we decide about auth?",
		});

		expect(seen.url).toBe(`http://127.0.0.1:3850${RECALL_PATH}`);
		const body = JSON.parse(seen.body ?? "{}") as Record<string, unknown>;
		// PRD-077a: the per-turn recall opts into the fast path.
		expect(body.fast).toBe(true);
		expect(body.query).toBe("what did we decide about auth?");
		expect(body.cwd).toBe("/repo/honeycomb");
		// The session-group + tenancy headers are UNCHANGED (a bare POST without them 400s).
		expect(seen.headers?.["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(seen.headers?.["x-honeycomb-session"]).toBe("sess-recall");
		expect(seen.headers?.["x-honeycomb-org"]).toBe("acme");
		expect(seen.headers?.["x-honeycomb-workspace"]).toBe("ws-1");
		expect(seen.headers?.["x-honeycomb-actor"]).toBe("agent-1");
		// The hits still coerce to { ref, text } — the fast selector does not change the response contract.
		expect(hits).toEqual([{ ref: "memories:m1", text: "a recalled fact" }]);
	});

	it("a hanging daemon is still bounded by the timeout and degrades to [] (fail-soft unchanged)", async () => {
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
