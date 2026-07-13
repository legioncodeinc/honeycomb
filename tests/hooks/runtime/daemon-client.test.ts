/**
 * PRD-021c c-AC-1 + c-AC-2 — the production `DaemonHookClient` + `CredentialReader`.
 *
 * c-AC-1: a native hook event, normalized through the 019c shim + run through the
 * 019b `runCapture` core, is POSTed by the PRODUCTION `DaemonHookClient` (real
 * `fetch`, here a recording stub) to `/api/hooks/capture` stamping the
 * `x-honeycomb-runtime-path` header AND the tenancy the credential resolved.
 *
 * c-AC-2: the production `CredentialReader` reads `~/.honeycomb/credentials.json`
 * (a temp dir here) and the client stamps that identity's org/actor — so the hook
 * speaks as the SAME identity the CLI login wrote.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClaudeCodeShim } from "../../../src/hooks/claude-code/shim.js";
import {
	createCredentialReader,
	createDaemonHookClient,
	createFakeCredentialReader,
	type HookCoreDeps,
	type HookSessionMeta,
	runCapture,
} from "../../../src/hooks/shared/index.js";

/** A recording `fetch` stub: captures every request and returns the configured response. */
function recordingFetch(status = 201, body: unknown = { ok: true, id: "row-1" }) {
	const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[k.toLowerCase()] = v;
		}
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
		});
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const META: HookSessionMeta = {
	sessionId: "sess-c-ac-1",
	path: "conversations/sess-c-ac-1",
	cwd: "/repo/honeycomb",
	agent: "claude-code",
};

describe("c-AC-1 production DaemonHookClient: native event → shim → core → real POST with runtime-path header", () => {
	it("POSTs the normalized capture to /api/hooks/capture stamping x-honeycomb-runtime-path: legacy", async () => {
		const { fn, calls } = recordingFetch();
		// The credential resolves the tenancy the transport stamps (c-AC-2 dependency).
		const credentials = createFakeCredentialReader({ token: "tok", org: "acme", actor: "agent-7" });
		const daemon = createDaemonHookClient({ credentials, fetch: fn });
		const deps: HookCoreDeps = {
			daemon,
			credentials,
			context: {
				async render() {
					return "";
				},
			},
		};

		// REAL claude-code shim + normalize engine: native UserPromptSubmit → HookInput.
		const shim = createClaudeCodeShim();
		const input = shim.normalize({ name: "UserPromptSubmit", payload: { prompt: "hello memory" } }, META);
		expect(input?.runtimePath).toBe("legacy");

		const result = await runCapture(input!, deps, {});
		expect(result.ok).toBe(true);

		// Exactly one POST to the capture endpoint.
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.method).toBe("POST");
		expect(call.url).toBe("http://127.0.0.1:3850/api/hooks/capture");
		// The runtime-path header the shim stamped reached the wire (the c-AC-1 contract).
		expect(call.headers["x-honeycomb-runtime-path"]).toBe("legacy");
		expect(call.headers["x-honeycomb-session"]).toBe("sess-c-ac-1");
	});

	it("merges the resolved tenancy into BOTH the headers and the request body.metadata (the transport's job)", async () => {
		const { fn, calls } = recordingFetch();
		const credentials = createFakeCredentialReader({ token: "tok", org: "acme", actor: "agent-7" });
		const daemon = createDaemonHookClient({ credentials, fetch: fn });
		const deps: HookCoreDeps = {
			daemon,
			credentials,
			context: {
				async render() {
					return "";
				},
			},
		};

		const shim = createClaudeCodeShim();
		const input = shim.normalize({ name: "UserPromptSubmit", payload: { prompt: "scoped" } }, META);
		await runCapture(input!, deps, {});

		const call = calls[0];
		// Headers carry the tenancy (the daemon's capture boundary requires it).
		expect(call.headers["x-honeycomb-org"]).toBe("acme");
		expect(call.headers["x-honeycomb-workspace"]).toBe("default");
		expect(call.headers["x-honeycomb-actor"]).toBe("agent-7");
		// AND the body.metadata is enriched with org/workspace so CaptureMetadataSchema validates.
		const meta = (call.body as { metadata: Record<string, unknown> }).metadata;
		expect(meta.org).toBe("acme");
		expect(meta.workspace).toBe("default");
	});

	it("surfaces a 409 runtime-path conflict as the body status (not a throw) so the core branches", async () => {
		const { fn } = recordingFetch(409, { error: "runtime-path-conflict" });
		const credentials = createFakeCredentialReader({ token: "tok", org: "acme" });
		const daemon = createDaemonHookClient({ credentials, fetch: fn });
		const res = await daemon.send({
			endpoint: "capture",
			body: { event: { kind: "user_message", text: "x" }, metadata: {} },
			meta: META,
			runtimePath: "plugin",
		});
		expect(res.status).toBe(409);
	});

	it("a transport failure (daemon down) surfaces as status 0, never a throw (fail-soft)", async () => {
		const fn = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const credentials = createFakeCredentialReader(undefined);
		const daemon = createDaemonHookClient({ credentials, fetch: fn });
		const res = await daemon.send({ endpoint: "capture", body: {}, meta: META, runtimePath: "legacy" });
		expect(res.status).toBe(0);
	});

	it("aborts a stalled daemon request before the host hook timeout and fails soft", async () => {
		vi.useFakeTimers();
		try {
			let observedSignal: AbortSignal | undefined;
			const stalledFetch = ((_url: string | URL | Request, init?: RequestInit) => {
				observedSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					observedSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				});
			}) as typeof fetch;
			const daemon = createDaemonHookClient({
				credentials: createFakeCredentialReader(undefined),
				fetch: stalledFetch,
				timeoutMs: 50,
			});

			const response = daemon.send({ endpoint: "capture", body: {}, meta: META, runtimePath: "legacy" });
			await vi.advanceTimersByTimeAsync(50);

			expect((await response).status).toBe(0);
			expect(observedSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("an unscoped (signed-out) credential sends NO tenancy headers and does not enrich the body", async () => {
		const { fn, calls } = recordingFetch();
		const credentials = createFakeCredentialReader(undefined);
		const daemon = createDaemonHookClient({ credentials, fetch: fn });
		await daemon.send({
			endpoint: "capture",
			body: { event: {}, metadata: {} },
			meta: META,
			runtimePath: "legacy",
		});
		const call = calls[0];
		expect(call.headers["x-honeycomb-org"]).toBeUndefined();
		expect((call.body as { metadata: Record<string, unknown> }).metadata.org).toBeUndefined();
	});
});

describe("c-AC-2 production CredentialReader: reads ~/.honeycomb/credentials.json as the same identity", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "honeycomb-creds-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("maps the persisted credential file (token/orgId/agentId) onto the HookCredential", async () => {
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				token: "bearer-xyz",
				orgId: "acme",
				orgName: "Acme",
				workspace: "default",
				agentId: "agent-claude",
				savedAt: "2026-06-19T00:00:00Z",
			}),
		);
		const reader = createCredentialReader({ dir, env: {} });
		const cred = await reader.read();
		expect(cred).toBeDefined();
		expect(cred?.token).toBe("bearer-xyz");
		expect(cred?.org).toBe("acme");
		expect(cred?.workspace).toBe("default");
		expect(cred?.actor).toBe("agent-claude");
	});

	it("reads the persisted `workspace` verbatim — a non-default workspace is NOT collapsed to the `default` sentinel (tenancy partition fidelity)", async () => {
		// Regression for the go-live capture round-trip bug: the reader dropped the
		// file's `workspace`, so the transport stamped the `default` sentinel and the
		// captured row landed in the `default` partition while the read-back queried the
		// credential's real workspace — invisible on read-back. The reader MUST surface it.
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				token: "bearer-xyz",
				orgId: "acme",
				orgName: "Acme",
				workspace: "honeycomb_ci",
				agentId: "agent-claude",
				savedAt: "2026-06-19T00:00:00Z",
			}),
		);
		const reader = createCredentialReader({ dir, env: {} });
		const cred = await reader.read();
		expect(cred?.workspace).toBe("honeycomb_ci");

		// AND it flows through the production client onto BOTH the header and body.metadata,
		// so the daemon writes the row into the SAME partition the read-back queries.
		const { fn, calls } = recordingFetch();
		const daemon = createDaemonHookClient({ credentials: reader, fetch: fn });
		await daemon.send({
			endpoint: "capture",
			body: { event: {}, metadata: {} },
			meta: META,
			runtimePath: "legacy",
		});
		expect(calls[0].headers["x-honeycomb-workspace"]).toBe("honeycomb_ci");
		const meta = (calls[0].body as { metadata: Record<string, unknown> }).metadata;
		expect(meta.workspace).toBe("honeycomb_ci");
	});

	it("returns undefined for an absent file (read-only / signed-out), never a throw", async () => {
		const reader = createCredentialReader({ dir, env: {} });
		expect(await reader.read()).toBeUndefined();
	});

	it("returns undefined for a malformed file (a half-written credential is worse than none)", async () => {
		writeFileSync(join(dir, "credentials.json"), "{ not json");
		const reader = createCredentialReader({ dir, env: {} });
		expect(await reader.read()).toBeUndefined();
	});

	it("the HONEYCOMB_TOKEN env override wins over the file token (parity with the daemon store)", async () => {
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				token: "file-token",
				orgId: "acme",
				orgName: "Acme",
				workspace: "default",
				agentId: "agent-claude",
				savedAt: "2026-06-19T00:00:00Z",
			}),
		);
		const reader = createCredentialReader({ dir, env: { HONEYCOMB_TOKEN: "env-token" } });
		const cred = await reader.read();
		expect(cred?.token).toBe("env-token");
		// The file's identity fields still describe the active tenancy.
		expect(cred?.org).toBe("acme");
	});

	it("the production reader feeds the production client its identity end-to-end (c-AC-1 + c-AC-2)", async () => {
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				token: "bearer-xyz",
				orgId: "globex",
				orgName: "Globex",
				workspace: "default",
				agentId: "agent-9",
				savedAt: "2026-06-19T00:00:00Z",
			}),
		);
		const { fn, calls } = recordingFetch();
		const credentials = createCredentialReader({ dir, env: {} });
		const daemon = createDaemonHookClient({ credentials, fetch: fn });
		await daemon.send({
			endpoint: "capture",
			body: { event: {}, metadata: {} },
			meta: META,
			runtimePath: "legacy",
		});
		// The org the file claimed is the org stamped on the daemon call (same identity).
		expect(calls[0].headers["x-honeycomb-org"]).toBe("globex");
		expect(calls[0].headers["x-honeycomb-actor"]).toBe("agent-9");
	});
});

describe("C-4 transport observability", () => {
	it("writes a stderr diagnostic when fetch rejects (fail-soft status 0)", async () => {
		const writes: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
			writes.push(String(chunk));
			return origWrite(chunk, ...(args as Parameters<typeof process.stderr.write>));
		}) as typeof process.stderr.write;
		try {
			const fetchFails = (async () => {
				throw new Error("ECONNREFUSED");
			}) as typeof fetch;
			const daemon = createDaemonHookClient({
				credentials: createFakeCredentialReader({ token: "t", org: "o" }),
				fetch: fetchFails,
			});
			const res = await daemon.send({
				endpoint: "capture",
				body: { event: {}, metadata: {} },
				meta: META,
				runtimePath: "legacy",
			});
			expect(res.status).toBe(0);
			// The diagnostic carries the underlying cause so an operator can tell
			// ECONNREFUSED from a timeout.
			expect(
				writes.some((line) => line.includes("hook capture transport failed") && line.includes("ECONNREFUSED")),
			).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});
});
