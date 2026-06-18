/**
 * PRD-011c — the evolved permission middleware (401 vs 403, role-from-Identity).
 *
 * Verification posture: in-process via `daemon.app.request(...)` with the PRD-011
 * `authenticator` + `policy` injected (fakes). No socket. These prove the NEW gate
 * shape while keeping the 004a INTENT (local open; team + no credential → 401; team
 * + valid credential + default-deny → 403) — the 004a tests themselves stay green in
 * server.test.ts via the retained legacy `permissionCheck` adapter.
 *
 * The load-bearing change: the role comes from the VALIDATED Identity an
 * Authenticator returns, NEVER from a request header. An `x-honeycomb-role: admin`
 * header is a bypass and is NOT honored.
 *
 * c-AC-3 team mode + no valid Bearer/API key → 401.
 * c-AC-2/004a team mode + valid credential + default-deny policy → 403.
 * c-AC-4 local mode → open, no token required.
 * c-AC-1 hybrid + no socket-peer info → fail closed, require a token (never trust Host).
 * + no-header-role: an x-honeycomb-role header cannot grant access.
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	type AuthorizationPolicy,
	type Identity,
	createFakeAuthenticator,
	defaultDenyPolicy,
} from "../../../../src/daemon/runtime/auth/index.js";

function cfg(mode: RuntimeConfig["mode"], over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false, ...over };
}

const storageStub = {
	async query() {
		return { kind: "ok", rows: [], durationMs: 0 } as const;
	},
};

/** A validated admin identity a fake authenticator can return for a known token. */
const ADMIN: Identity = { org: "acme", workspace: "backend", agentId: "agent-a", role: "admin" };

/** An allow-everything policy (stands in for the 011c RBAC admin-passes path). */
const allowAll: AuthorizationPolicy = { decide: () => "allow" };

/** Session headers the 004d runtime-path middleware requires on session groups. */
const sessionHeaders = { "x-honeycomb-runtime-path": "plugin", "x-honeycomb-session": "s1" };

describe("c-AC-3 team mode + no valid credential → 401", () => {
	it("returns 401 when no Bearer/API key is presented (default fail-closed authenticator)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			// Defaults: alwaysUnauthenticated + defaultDenyPolicy.
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe");
		expect(res.status).toBe(401);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("unauthorized");
	});

	it("returns 401 when a credential is presented but does not validate", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": ADMIN }),
			policy: allowAll,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer bad-token" },
		});
		expect(res.status).toBe(401);
	});
});

describe("c-AC-2 team mode + valid credential + default-deny policy → 403", () => {
	it("authenticates, then 403s when the policy denies (the fail-closed default)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": ADMIN }),
			policy: defaultDenyPolicy,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer good-token" },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("forbidden");
	});

	it("permits when authenticated AND the policy allows (200)", async () => {
		let reached = false;
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": ADMIN }),
			policy: allowAll,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => {
			reached = true;
			return c.json({ ok: true });
		});
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer good-token" },
		});
		expect(res.status).toBe(200);
		expect(reached).toBe(true);
	});

	it("an x-honeycomb-role header CANNOT grant access (no header-role trust)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			// No authenticator scripted for any token → every request is unauthenticated.
			authenticator: createFakeAuthenticator({}),
			policy: allowAll,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		// Present a spoofed admin role header AND a token — neither grants access,
		// because the role comes from the Identity (which the authenticator denies).
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { "x-honeycomb-role": "admin", authorization: "Bearer anything" },
		});
		expect(res.status).toBe(401);
	});
});

describe("c-AC-4 local mode → open, no token required", () => {
	it("runs the handler with no credential and a default-deny policy", async () => {
		let reached = false;
		const daemon = createDaemon({
			config: cfg("local"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({}),
			policy: defaultDenyPolicy, // must NOT fire in local mode.
		});
		daemon.group("/api/goals")?.get("/probe", (c) => {
			reached = true;
			return c.json({ ok: true });
		});
		const res = await daemon.app.request("/api/goals/probe");
		expect(res.status).toBe(200);
		expect(reached).toBe(true);
	});
});

describe("c-AC-1 hybrid + no socket-peer info → fail closed, require a token", () => {
	it("returns 401 with no credential, even with a forged Host header", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": ADMIN }),
			policy: allowAll,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		// A forged loopback Host must NOT be trusted (the default SocketPeerProbe trusts
		// nothing); with no token, hybrid fails closed to 401.
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { host: "127.0.0.1" },
		});
		expect(res.status).toBe(401);
	});

	it("permits in hybrid once a valid token is presented", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": ADMIN }),
			policy: allowAll,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer good-token" },
		});
		expect(res.status).toBe(200);
	});
});

describe("c-AC validated via x-api-key as well as Bearer", () => {
	it("authenticates an x-api-key credential", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "key-123": ADMIN }),
			policy: allowAll,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", { headers: { "x-api-key": "key-123" } });
		expect(res.status).toBe(200);
	});
});
