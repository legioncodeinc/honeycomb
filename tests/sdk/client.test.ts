/**
 * PRD-019e SDK core — AC-named Vitest (e-AC-1, e-AC-2, e-AC-3, e-AC-6).
 *
 * Drives the fetch-only {@link createHoneycombClient} against a FAKE {@link Fetch}
 * seam — no daemon, no network, no DeepLake. Each `it` is named for the e-AC it
 * proves so the ledger row maps 1:1 to a landing test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHoneycombClient, isTokenTransportSafe, SECRET_REDACTED } from "../../src/sdk/client.js";
import {
	ApiError,
	type Fetch,
	type HttpMethod,
	NetworkError,
	type RetryPolicy,
	TimeoutError,
} from "../../src/sdk/contracts.js";

/** A recorded fetch call (URL + init) for header/body assertions. */
interface RecordedFetch {
	readonly url: string;
	readonly init?: RequestInit;
}

/** Build a fake `Fetch` that records every call and returns a scripted response. */
function recordingFetch(
	responder: (call: RecordedFetch, n: number) => Response | Promise<Response>,
): { fetch: Fetch; calls: RecordedFetch[] } {
	const calls: RecordedFetch[] = [];
	const fetch: Fetch = async (input, init) => {
		const call: RecordedFetch = { url: input, init };
		calls.push(call);
		return await responder(call, calls.length);
	};
	return { fetch, calls };
}

/** A JSON Response helper (no DOM types — `Response` is a Node 22 global). */
function jsonResponse(status: number, body: unknown): Response {
	return new Response(body === undefined ? "" : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Read a header off a recorded init, tolerating the Record shape we always emit. */
function header(init: RequestInit | undefined, name: string): string | undefined {
	const h = init?.headers as Record<string, string> | undefined;
	return h?.[name];
}

const ACTOR = { actor: "mario", actorType: "user" };
const DAEMON = "http://127.0.0.1:3850";

describe("e-AC-1: remember/recall carry token + actor + actorType", () => {
	it("e-AC-1 remember stamps actor + actorType + Authorization on the daemon call", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(201, { ok: true }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-123", ...ACTOR, fetch });

		await client.remember("the deploy is at 5pm", { path: "ops/deploy" });

		expect(calls).toHaveLength(1);
		expect(header(calls[0].init, "x-honeycomb-actor")).toBe("mario");
		expect(header(calls[0].init, "x-honeycomb-actor-type")).toBe("user");
		expect(header(calls[0].init, "authorization")).toBe("Bearer tok-123");
		expect(calls[0].url).toBe(`${DAEMON}/api/memories`);
		expect(JSON.parse(calls[0].init?.body as string)).toEqual({ text: "the deploy is at 5pm", path: "ops/deploy" });
	});

	it("e-AC-1 recall stamps actor + actorType + token and returns parsed results", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(200, { results: [{ path: "p", text: "t", score: 0.9 }] }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-123", ...ACTOR, fetch });

		const out = await client.recall("when is the deploy", { limit: 5 });

		expect(out).toEqual([{ path: "p", text: "t", score: 0.9 }]);
		expect(header(calls[0].init, "x-honeycomb-actor")).toBe("mario");
		expect(header(calls[0].init, "x-honeycomb-actor-type")).toBe("user");
		expect(header(calls[0].init, "authorization")).toBe("Bearer tok-123");
	});

	it("e-AC-1 with no token configured, no Authorization header is sent (but actor still is)", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(200, { results: [] }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch });

		await client.recall("q");

		expect(header(calls[0].init, "authorization")).toBeUndefined();
		expect(header(calls[0].init, "x-honeycomb-actor")).toBe("mario");
	});
});

describe("e-AC-2: typed errors + GET-retries / mutation-no-retry", () => {
	/** A no-backoff retry policy so the test never actually waits. */
	const fastRetry: RetryPolicy = {
		maxAttempts: (m: HttpMethod) => (m === "GET" ? 3 : 1),
		backoffMs: () => 0,
	};

	it("e-AC-2 non-2xx surfaces an ApiError with status + body", async () => {
		const { fetch } = recordingFetch(() => jsonResponse(404, { error: "not_found" }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch, retry: fastRetry });

		await expect(client.memory.get("missing")).rejects.toBeInstanceOf(ApiError);
		const err = await client.memory.get("missing").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(404);
		expect((err as ApiError).body).toEqual({ error: "not_found" });
	});

	it("e-AC-2 a transport failure surfaces a NetworkError", async () => {
		const failing: Fetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch: failing, retry: fastRetry });

		const err = await client.memory.get("x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(NetworkError);
		expect((err as NetworkError).cause).toBeInstanceOf(Error);
	});

	it("e-AC-2 a request past the budget surfaces a TimeoutError", async () => {
		// A fetch that never resolves until aborted → the client's AbortController fires.
		const hanging: Fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch: hanging, retry: fastRetry, timeoutMs: 10 });

		const err = await client.memory.get("x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TimeoutError);
		expect((err as TimeoutError).timeoutMs).toBe(10);
	});

	it("e-AC-2 GET retries on a transient 503 and then succeeds", async () => {
		const { fetch, calls } = recordingFetch((_c, n) =>
			n < 3 ? jsonResponse(503, { error: "unavailable" }) : jsonResponse(200, { path: "p", text: "t" }),
		);
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch, retry: fastRetry });

		const out = await client.memory.get("p");
		expect(out).toEqual({ path: "p", text: "t" });
		expect(calls).toHaveLength(3); // two transient + one success
	});

	it("e-AC-2 GET retries on a transient transport failure and then succeeds", async () => {
		// `memory.get` is a GET (idempotent), so the policy retries it; `recall` is a
		// POST and would NOT — proving the split runs off the HTTP method, not the call.
		let n = 0;
		const flaky: Fetch = async (input, init) => {
			n++;
			if (n < 2) throw new Error("ETIMEDOUT");
			void input;
			void init;
			return jsonResponse(200, { path: "p", text: "t" });
		};
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch: flaky, retry: fastRetry });

		await expect(client.memory.get("p")).resolves.toEqual({ path: "p", text: "t" });
		expect(n).toBe(2);
	});

	it("e-AC-2 a MUTATION does NOT retry on a transient 503 (not idempotent)", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(503, { error: "unavailable" }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch, retry: fastRetry });

		const err = await client.remember("x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(503);
		expect(calls).toHaveLength(1); // exactly one attempt — no double-apply
	});

	it("e-AC-2 a MUTATION does NOT retry on a transient transport failure", async () => {
		let n = 0;
		const failing: Fetch = async () => {
			n++;
			throw new Error("ECONNRESET");
		};
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch: failing, retry: fastRetry });

		await expect(client.goals.add("ship it")).rejects.toBeInstanceOf(NetworkError);
		expect(n).toBe(1); // one attempt only
	});
});

describe("e-AC-3: runs Node/Bun/browser, no native dependency", () => {
	it("e-AC-3 the core client module imports nothing Node-only (no node:*)", () => {
		// Static source scan: client.ts must not pull a Node-only module so it runs in
		// Bun + the browser. Only the standard fetch/AbortController/setTimeout globals.
		const clientSrc = readFileSync(fileURLToPath(new URL("../../src/sdk/client.ts", import.meta.url)), "utf-8");
		// No `node:` builtin imports, and no bare `fs`/`http`/`https`/`net` imports.
		expect(/from\s+["']node:/.test(clientSrc)).toBe(false);
		expect(/\brequire\s*\(/.test(clientSrc)).toBe(false);
		expect(/from\s+["'](fs|http|https|net|child_process|os|path)["']/.test(clientSrc)).toBe(false);
	});

	it("e-AC-3 the contracts module (the client's only import) is also node-free", () => {
		const contractsSrc = readFileSync(fileURLToPath(new URL("../../src/sdk/contracts.ts", import.meta.url)), "utf-8");
		expect(/from\s+["']node:/.test(contractsSrc)).toBe(false);
		expect(/\brequire\s*\(/.test(contractsSrc)).toBe(false);
	});

	it("e-AC-3 the client runs against an injected fetch with zero ambient globals beyond standard", async () => {
		// Proving runnability: construct + call with only the injected fetch seam.
		const { fetch } = recordingFetch(() => jsonResponse(200, { results: [] }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch });
		await expect(client.recall("q")).resolves.toEqual([]);
	});
});

describe("e-AC-6: secrets names + redacted only", () => {
	it("e-AC-6 secrets.list returns NAMES only (never a value field)", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(200, { names: ["OPENAI_API_KEY", "GH_TOKEN"] }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "t", ...ACTOR, fetch });

		const names = await client.secrets.list();

		expect(names).toEqual([{ name: "OPENAI_API_KEY" }, { name: "GH_TOKEN" }]);
		// Each descriptor has ONLY a name — no `value` key anywhere.
		for (const n of names) expect(Object.keys(n)).toEqual(["name"]);
		expect(calls[0].url).toBe(`${DAEMON}/api/secrets`);
	});

	it("e-AC-6 secrets.list honors a prefix filter client-side", async () => {
		const { fetch } = recordingFetch(() => jsonResponse(200, { names: ["OPENAI_API_KEY", "GH_TOKEN"] }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch });
		const names = await client.secrets.list("OPENAI");
		expect(names).toEqual([{ name: "OPENAI_API_KEY" }]);
	});

	it("e-AC-6 secrets.exec returns REDACTED output only — never a raw value", async () => {
		// Even if the daemon body carried extra fields, the SDK surface only exposes redactedOutput.
		const { fetch } = recordingFetch(() => jsonResponse(200, { redactedOutput: "token=***REDACTED***" }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "t", ...ACTOR, fetch });

		const out = await client.secrets.exec("echo $OPENAI_API_KEY");

		expect(out).toEqual({ redactedOutput: "token=***REDACTED***" });
		expect(Object.keys(out)).toEqual(["redactedOutput"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY REGRESSIONS (PRD-019 security audit, 2026-06-18)
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-H1 secrets.exec never promotes a raw stdout/output field", () => {
	it("SEC-H1 a daemon body carrying raw stdout/output is NOT surfaced — redaction sentinel instead", async () => {
		// A misbehaving daemon attaches the unredacted command output under `stdout`/`output`
		// instead of `redactedOutput`. The SDK value-safe floor must NOT promote it.
		const leak = "OPENAI_API_KEY=sk-live-supersecret";
		const { fetch } = recordingFetch(() => jsonResponse(200, { stdout: leak, output: leak }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "t", ...ACTOR, fetch });

		const out = await client.secrets.exec("echo $OPENAI_API_KEY");

		expect(out).toEqual({ redactedOutput: SECRET_REDACTED });
		expect(JSON.stringify(out)).not.toContain("sk-live-supersecret");
	});

	it("SEC-H1 an explicit redactedOutput projection is still surfaced verbatim", async () => {
		const { fetch } = recordingFetch(() => jsonResponse(200, { redactedOutput: "ok=***" }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "t", ...ACTOR, fetch });
		expect(await client.secrets.exec("echo x")).toEqual({ redactedOutput: "ok=***" });
	});
});

describe("SEC-M1 the bearer token is attached only on a transport-safe daemonUrl", () => {
	it("SEC-M1 a plaintext NON-loopback daemonUrl gets NO Authorization header (no token exfil)", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(200, { results: [] }));
		const client = createHoneycombClient({
			daemonUrl: "http://evil.example.com:3850",
			token: "tok-secret",
			...ACTOR,
			fetch,
		});
		await client.recall("anything");
		expect(header(calls[0].init, "authorization")).toBeUndefined();
	});

	it("SEC-M1 a loopback http daemonUrl DOES carry the token (local mode preserved)", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(200, { results: [] }));
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-secret", ...ACTOR, fetch });
		await client.recall("anything");
		expect(header(calls[0].init, "authorization")).toBe("Bearer tok-secret");
	});

	it("SEC-M1 an HTTPS remote daemonUrl DOES carry the token (team/hybrid mode preserved)", async () => {
		const { fetch, calls } = recordingFetch(() => jsonResponse(200, { results: [] }));
		const client = createHoneycombClient({
			daemonUrl: "https://daemon.team.example.com",
			token: "tok-secret",
			...ACTOR,
			fetch,
		});
		await client.recall("anything");
		expect(header(calls[0].init, "authorization")).toBe("Bearer tok-secret");
	});

	it("SEC-M1 isTokenTransportSafe classifies loopback/https as safe and plaintext-remote/unparseable as unsafe", () => {
		expect(isTokenTransportSafe("http://127.0.0.1:3850")).toBe(true);
		expect(isTokenTransportSafe("http://localhost:3850")).toBe(true);
		expect(isTokenTransportSafe("https://daemon.example.com")).toBe(true);
		expect(isTokenTransportSafe("http://evil.example.com")).toBe(false);
		expect(isTokenTransportSafe("not-a-url")).toBe(false);
	});
});
