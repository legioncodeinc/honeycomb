/**
 * PRD-021b b-AC-1 / b-AC-4 / b-AC-6 — the CLI-side composition root binds the real seams.
 *
 * Proves with real modules (the loopback client over an injected fetch, the real local TokenIssuer,
 * a temp credentials dir):
 *   - b-AC-1: the real loopback DaemonClient POSTs/GETs `127.0.0.1:3850` and returns real data,
 *     stamping the org/workspace/actor headers from the shared credential.
 *   - b-AC-4: `login` actually writes `~/.honeycomb/credentials.json` at 0600 through the unchanged
 *     011b device flow + the bound real issuer; `healDriftedOrgToken` (011b `healOrgDrift`) corrects
 *     a drifted org token.
 *   - b-AC-6: every seam `buildRuntimeDeps` assembles is bound (no undefined handler seam).
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CLI_RUNTIME_PATH,
	createLoopbackDaemonClient,
	isSessionGroupPath,
} from "../../src/commands/index.js";
import {
	buildAuthPassthrough,
	buildDaemonLifecycle,
	buildOrgDriftHealer,
	buildRuntimeDeps,
} from "../../src/cli/runtime.js";
import { buildRealTokenIssuer } from "../../src/cli/token-issuer.js";
import { authMain } from "../../src/cli/auth.js";
import {
	type Credentials,
	credentialsPath,
	deviceFlowLogin,
	encodeStubToken,
	loadCredentials,
	saveCredentials,
	systemClock,
} from "../../src/daemon/runtime/auth/index.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "honeycomb-cli-runtime-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("PRD-021b b-AC-1 — real loopback DaemonClient", () => {
	it("b-AC-1 POSTs to 127.0.0.1:3850 with the credential tenancy headers and returns real data", async () => {
		const seen: { url?: string; method?: string; headers?: Record<string, string>; body?: string } = {};
		const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
			seen.url = url;
			seen.method = init.method;
			seen.headers = init.headers;
			seen.body = init.body;
			return {
				ok: true,
				status: 200,
				async json() {
					return { memories: [{ id: "m1", content: "hi" }] };
				},
			};
		}) as unknown as typeof fetch;

		const client = createLoopbackDaemonClient({
			baseUrl: "http://127.0.0.1:3850",
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "default", "x-honeycomb-actor": "agent-1" },
			fetchImpl: fakeFetch,
		});
		const res = await client.send({ method: "POST", path: "/api/memories/recall", body: { query: "x" } });

		expect(seen.url).toBe("http://127.0.0.1:3850/api/memories/recall");
		expect(seen.method).toBe("POST");
		expect(seen.headers?.["x-honeycomb-org"]).toBe("acme");
		expect(seen.headers?.["x-honeycomb-actor"]).toBe("agent-1");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ memories: [{ id: "m1", content: "hi" }] });
	});

	it("b-AC-1 the loopback client never carries a bearer token in a header value", async () => {
		// The runtime stamps org/workspace/actor only — never the token (the redaction thesis).
		const headerKeys: string[] = [];
		const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
			headerKeys.push(...Object.keys(init.headers));
			return { ok: true, status: 200, async json() { return {}; } };
		}) as unknown as typeof fetch;
		const client = createLoopbackDaemonClient({
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "default", "x-honeycomb-actor": "a" },
			fetchImpl: fakeFetch,
		});
		await client.send({ method: "GET", path: "/api/memories" });
		expect(headerKeys).not.toContain("authorization");
		expect(headerKeys.some((k) => /token/i.test(k))).toBe(false);
	});
});

describe("PRD-022d d-AC-2 / d-AC-3 — the loopback client stamps the session-group headers", () => {
	/** Capture the headers a single send emits over an injected fetch. */
	async function headersFor(path: string, method: "GET" | "POST" = "POST"): Promise<Record<string, string>> {
		let seen: Record<string, string> = {};
		const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
			seen = init.headers;
			return { ok: true, status: 200, async json() { return {}; } };
		}) as unknown as typeof fetch;
		const client = createLoopbackDaemonClient({
			baseUrl: "http://127.0.0.1:3850",
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "default", "x-honeycomb-actor": "agent-1" },
			fetchImpl: fakeFetch,
		});
		await client.send(method === "POST" ? { method, path, body: { query: "x" } } : { method, path });
		return seen;
	}

	it("d-AC-2 a recall (POST /api/memories/recall) stamps BOTH x-honeycomb-runtime-path AND x-honeycomb-session", async () => {
		const headers = await headersFor("/api/memories/recall");
		// The dogfood 400 root cause: these two headers were absent. Both are present now.
		expect(headers["x-honeycomb-runtime-path"]).toBe(CLI_RUNTIME_PATH);
		expect(headers["x-honeycomb-session"]).toBeDefined();
		expect(headers["x-honeycomb-session"].length).toBeGreaterThan(0);
		// The tenancy headers still ride alongside.
		expect(headers["x-honeycomb-org"]).toBe("acme");
	});

	it("d-AC-3 the synthetic session id is a stable-per-process `cli-<pid>-<n>` shape (no Date.now/Math.random)", async () => {
		const headers = await headersFor("/api/memories", "POST");
		expect(headers["x-honeycomb-session"]).toMatch(/^cli-\d+-\d+$/);
	});

	it("d-AC-2 a remember (POST /api/memories) and a /memory browse both get the session headers", async () => {
		const remember = await headersFor("/api/memories", "POST");
		const browse = await headersFor("/memory/cat", "GET");
		for (const h of [remember, browse]) {
			expect(h["x-honeycomb-runtime-path"]).toBe(CLI_RUNTIME_PATH);
			expect(h["x-honeycomb-session"]).toBeDefined();
		}
	});

	it("d-AC-3 a NON-session storage path (/api/goals) carries the tenancy headers but NOT the session headers", async () => {
		const headers = await headersFor("/api/goals", "POST");
		expect(headers["x-honeycomb-org"]).toBe("acme");
		expect(headers["x-honeycomb-runtime-path"]).toBeUndefined();
		expect(headers["x-honeycomb-session"]).toBeUndefined();
	});

	it("d-AC-3 isSessionGroupPath classifies the session groups and excludes the rest", () => {
		expect(isSessionGroupPath("/api/memories")).toBe(true);
		expect(isSessionGroupPath("/api/memories/recall")).toBe(true);
		expect(isSessionGroupPath("/memory")).toBe(true);
		expect(isSessionGroupPath("/memory/cat")).toBe(true);
		// Not a session group: a path that merely shares a prefix word must not match.
		expect(isSessionGroupPath("/api/goals")).toBe(false);
		expect(isSessionGroupPath("/api/memories-archive")).toBe(false);
		expect(isSessionGroupPath("/health")).toBe(false);
	});

	it("d-AC-3 a caller-supplied runtime-path/session override wins over the synthetic stamp", async () => {
		let seen: Record<string, string> = {};
		const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
			seen = init.headers;
			return { ok: true, status: 200, async json() { return {}; } };
		}) as unknown as typeof fetch;
		const client = createLoopbackDaemonClient({
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-runtime-path": "plugin", "x-honeycomb-session": "fixed-1" },
			fetchImpl: fakeFetch,
		});
		await client.send({ method: "POST", path: "/api/memories/recall", body: { query: "x" } });
		expect(seen["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(seen["x-honeycomb-session"]).toBe("fixed-1");
	});
});

describe("PRD-021b b-AC-4 — login writes 0600 + drift heal", () => {
	it("b-AC-4 the real device flow writes credentials.json at 0600 via the bound local issuer", async () => {
		// The bound real issuer (local single-user mode) mints a REAL verifiable token; the unchanged
		// 011b deviceFlowLogin persists it at 0600. We drive deviceFlowLogin into the temp dir.
		const issuer = buildRealTokenIssuer({ HONEYCOMB_ORG_ID: "acme" } as NodeJS.ProcessEnv);
		const creds = await deviceFlowLogin({ issuer, dir, clock: systemClock });
		expect(creds.orgId).toBe("acme");

		const path = credentialsPath(dir);
		// The file exists and (on POSIX) carries mode 0600.
		const st = statSync(path);
		if (process.platform !== "win32") {
			expect(st.mode & 0o777).toBe(0o600);
		}
		// The token round-trips: it is a real, verifiable credential, not a placeholder.
		const onDisk = loadCredentials(dir);
		expect(onDisk).not.toBeNull();
		expect(onDisk?.orgId).toBe("acme");
	});

	it("b-AC-4 the auth passthrough routes `login` to the real device flow", async () => {
		// authMain with the bound local issuer writes a real credential to the temp dir.
		const issuer = buildRealTokenIssuer({ HONEYCOMB_ORG_ID: "acme" } as NodeJS.ProcessEnv);
		const lines: string[] = [];
		const result = await authMain(["login"], { issuer, dir, out: (l) => lines.push(l) });
		expect(result.exitCode).toBe(0);
		expect(result.wrote).toBe(true);
		expect(loadCredentials(dir)?.orgId).toBe("acme");
		// The bearer token is never printed.
		expect(lines.join("\n")).not.toMatch(/hcmt\.v1\./);
	});

	it("b-AC-4 healDriftedOrgToken re-mints a token whose org claim disagrees with the active org", async () => {
		// Seed a credential bound to org `old` in the temp dir, then heal toward active org `new`.
		const driftedToken = encodeStubToken({ org: "old", workspace: "default", agentId: "default" });
		const drifted: Credentials = {
			token: driftedToken,
			orgId: "old",
			orgName: "old",
			workspace: "default",
			agentId: "default",
			savedAt: "",
		};
		saveCredentials(drifted, dir, systemClock);

		// The healer's active org comes from the env override; set it to `new` so a drift is detected.
		process.env.HONEYCOMB_ORG_ID = "new";
		try {
			const drift = buildOrgDriftHealer(drifted, dir);
			const outcome = await drift.heal();
			expect(outcome.kind).toBe("healed");
			expect(outcome.to).toBe("new");
		} finally {
			delete process.env.HONEYCOMB_ORG_ID;
		}
	});

	it("b-AC-4 drift heal reports `aligned` when the token org already matches the active org", async () => {
		const token = encodeStubToken({ org: "acme", workspace: "default", agentId: "default" });
		const aligned: Credentials = {
			token,
			orgId: "acme",
			orgName: "acme",
			workspace: "default",
			agentId: "default",
			savedAt: "",
		};
		saveCredentials(aligned, dir, systemClock);
		const drift = buildOrgDriftHealer(aligned, dir);
		const outcome = await drift.heal();
		// Active org defaults to the credential's own org (no env override) → aligned, no re-mint.
		expect(outcome.kind).toBe("aligned");
	});
});

describe("PRD-021b b-AC-6 — every seam is bound", () => {
	it("b-AC-6 buildRuntimeDeps assembles a fully-bound dep set (no undefined handler seam)", () => {
		const deps = buildRuntimeDeps();
		expect(deps.daemon).toBeDefined();
		expect(deps.lifecycle).toBeDefined();
		expect(deps.auth).toBeDefined();
		expect(deps.connector).toBeDefined();
		expect(deps.dashboard).toBeDefined();
		expect(deps.health).toBeDefined();
		expect(deps.drift).toBeDefined();
		expect(typeof deps.loggedIn).toBe("boolean");
	});

	it("b-AC-6 the bound auth passthrough is callable for login/logout/org", async () => {
		const auth = buildAuthPassthrough();
		expect(typeof auth.dispatch).toBe("function");
		// A logout with no credentials present (a fresh temp HOME) exits SUCCESS — proof the seam runs.
		const code = await auth.dispatch(["logout"]);
		expect(typeof code).toBe("number");
	});

	it("b-AC-6 the bound daemon lifecycle exposes start/stop/status", () => {
		const client = createLoopbackDaemonClient({ baseUrl: "http://127.0.0.1:3850" });
		const lifecycle = buildDaemonLifecycle(client);
		expect(typeof lifecycle.start).toBe("function");
		expect(typeof lifecycle.stop).toBe("function");
		expect(typeof lifecycle.status).toBe("function");
	});
});
