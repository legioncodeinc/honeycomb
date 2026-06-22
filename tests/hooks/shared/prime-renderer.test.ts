/**
 * PRD-046d prime-renderer suite — d-AC-1 / d-AC-4 (the thin loopback prime fetch).
 *
 * Drives the production {@link createPrimeRenderer} against an injected `fetch` stub (no
 * real socket). Proves:
 *   - d-AC-1: a 200 `{ digest, empty:false }` returns the digest VERBATIM, and the request
 *     stamps the session-group headers (runtime-path + session) + the credential tenancy so
 *     the `/api/memories/prime` route (a session group, fail-closed without them) is reached.
 *   - d-AC-4: EVERY degrade path — unreachable daemon, non-200, malformed body, a cold-repo
 *     `{ empty:true }`, and a timeout — resolves to "" (no injection), never a throw.
 */

import { describe, expect, it, vi } from "vitest";

import {
	createFakeCredentialReader,
	type HookSessionMeta,
} from "../../../src/hooks/shared/contracts.js";
import { createPrimeRenderer, PRIME_PATH } from "../../../src/hooks/shared/prime-renderer.js";

const META: HookSessionMeta = { sessionId: "sess-prime", path: "conv-1", cwd: "/repo", agent: "claude-code" };

/** A recording fetch stub: captures the URL + headers and returns a configurable response. */
function recordingFetch(res: { status: number; body: string }): {
	fetch: typeof fetch;
	seen: { url?: string; method?: string; headers?: Record<string, string> };
} {
	const seen: { url?: string; method?: string; headers?: Record<string, string> } = {};
	const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
		seen.url = url;
		seen.method = init.method;
		seen.headers = init.headers;
		return {
			status: res.status,
			async text() {
				return res.body;
			},
		};
	}) as unknown as typeof fetch;
	return { fetch: fakeFetch, seen };
}

describe("PRD-046d prime renderer — d-AC-1 fetch + inject", () => {
	it("d-AC-1: a 200 digest is returned VERBATIM and stamps the session-group + tenancy headers", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({
			status: 200,
			body: JSON.stringify({ digest: "## Memory\n- key: decided X", recent: [], durable: [], tokens: 7, empty: false }),
		});
		const renderer = createPrimeRenderer({
			credentials: createFakeCredentialReader({ token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" }),
			fetch: fakeFetch,
		});

		const digest = await renderer.render({
			meta: META,
			credential: { token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" },
		});

		// The digest is injected verbatim — the hook does NO assembly (d-AC-5).
		expect(digest).toBe("## Memory\n- key: decided X");
		// It hit the 046c route over loopback with a GET.
		expect(seen.url).toBe(`http://127.0.0.1:3850${PRIME_PATH}`);
		expect(seen.method).toBe("GET");
		// The session group REQUIRES these two — a bare GET without them is a 400/409.
		expect(seen.headers?.["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(seen.headers?.["x-honeycomb-session"]).toBe("sess-prime");
		// Tenancy scopes the digest to the repo/agent partition.
		expect(seen.headers?.["x-honeycomb-org"]).toBe("acme");
		expect(seen.headers?.["x-honeycomb-workspace"]).toBe("ws-1");
		expect(seen.headers?.["x-honeycomb-actor"]).toBe("agent-1");
	});

	it("d-AC-1: a credential with org but no workspace falls back to the `default` sentinel", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({
			status: 200,
			body: JSON.stringify({ digest: "D", recent: [], durable: [], tokens: 1, empty: false }),
		});
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: fakeFetch });
		await renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
		expect(seen.headers?.["x-honeycomb-workspace"]).toBe("default");
	});

	it("the renderer NEVER carries a bearer token in a header value (redaction)", async () => {
		const { fetch: fakeFetch, seen } = recordingFetch({
			status: 200,
			body: JSON.stringify({ digest: "D", recent: [], durable: [], tokens: 1, empty: false }),
		});
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: fakeFetch });
		await renderer.render({ meta: META, credential: { token: "secret-token-xyz", org: "acme" } });
		const keys = Object.keys(seen.headers ?? {});
		expect(keys).not.toContain("authorization");
		expect(keys.some((k) => /token/i.test(k))).toBe(false);
		expect(JSON.stringify(seen.headers)).not.toContain("secret-token-xyz");
	});
});

describe("PRD-046d prime renderer — d-AC-4 graceful degradation", () => {
	it("d-AC-4: a cold repo (`empty: true`) injects NOTHING (no placeholder banner)", async () => {
		const { fetch: fakeFetch } = recordingFetch({
			status: 200,
			body: JSON.stringify({ digest: "(no memory yet)", recent: [], durable: [], tokens: 0, empty: true }),
		});
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: fakeFetch });
		const digest = await renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
		expect(digest).toBe("");
	});

	it("d-AC-4: an unreachable daemon (fetch rejects) degrades to no injection, never a throw", async () => {
		const failingFetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: failingFetch });
		const digest = await renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
		expect(digest).toBe("");
	});

	it("d-AC-4: a non-200 status degrades to no injection", async () => {
		const { fetch: fakeFetch } = recordingFetch({ status: 400, body: JSON.stringify({ error: "bad_request" }) });
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: fakeFetch });
		const digest = await renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
		expect(digest).toBe("");
	});

	it("d-AC-4: a malformed body degrades to no injection", async () => {
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body: "{ not json" });
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: fakeFetch });
		const digest = await renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
		expect(digest).toBe("");
	});

	it("d-AC-4: a body missing the `digest` field degrades to no injection", async () => {
		const { fetch: fakeFetch } = recordingFetch({ status: 200, body: JSON.stringify({ recent: [], tokens: 0 }) });
		const renderer = createPrimeRenderer({ credentials: createFakeCredentialReader(), fetch: fakeFetch });
		const digest = await renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
		expect(digest).toBe("");
	});

	it("d-AC-4: a slow daemon is bounded by the timeout and degrades to no injection", async () => {
		vi.useFakeTimers();
		try {
			// A fetch that never resolves on its own — only the abort signal ends it.
			const hangingFetch = ((_url: string, init: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				})) as unknown as typeof fetch;
			const renderer = createPrimeRenderer({
				credentials: createFakeCredentialReader(),
				fetch: hangingFetch,
				timeoutMs: 50,
			});
			const pending = renderer.render({ meta: META, credential: { token: "t", org: "acme" } });
			// Advance past the timeout so the AbortController fires and the fetch rejects.
			await vi.advanceTimersByTimeAsync(60);
			expect(await pending).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});
});
