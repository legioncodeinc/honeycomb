/**
 * PRD-011c — the real RBAC policy (createRbacPolicy) + its end-to-end behaviour.
 *
 * Two layers, one named test per c-AC:
 *   - POLICY layer: call `createRbacPolicy().decide(identity, ctx)` directly to
 *     prove the 4-role matrix + write gate + project-scope gate in isolation.
 *   - END-TO-END layer: mount the REAL `permissionMiddleware` (via `createDaemon`)
 *     with this policy + a fake `Authenticator` and drive it through
 *     `daemon.app.request(...)`, exactly mirroring the Wave-1 permission.test.ts.
 *     This proves which LAYER returns which status — the authenticator owns 401
 *     (c-AC-3), the mode gate owns local-open (c-AC-4) and hybrid-fail-closed
 *     (c-AC-1), and this policy owns the 403s (c-AC-2/5/6).
 *
 * The role vocabulary is the FROZEN contract `Role` = admin | member | readonly |
 * agent (contracts.ts ROLES / ledger D-1). The 011c PRD prose's `operator` is the
 * reconciled `member`.
 *
 * c-AC-1 hybrid + no socket-peer info → fail closed, require a token (never Host).
 * c-AC-2 readonly on a write route → 403; admin passes all permission+scope checks.
 * c-AC-3 team mode + no valid Bearer/API key → 401.
 * c-AC-4 local mode → full access, no token required.
 * c-AC-5 project=alpha identity targeting project=beta → 403 unless admin.
 * c-AC-6 agent connector on a connectors-admin / token route → 403.
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	type AuthorizationContext,
	type Identity,
	createFakeAuthenticator,
	createRbacPolicy,
} from "../../../../src/daemon/runtime/auth/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures.
// ────────────────────────────────────────────────────────────────────────────

function cfg(mode: RuntimeConfig["mode"], over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false, ...over };
}

const storageStub = {
	async query() {
		return { kind: "ok", rows: [], durationMs: 0 } as const;
	},
};

/** Build an Identity for a role (optionally project-scoped). org/workspace/agentId fixed. */
function identity(role: Identity["role"], project?: string): Identity {
	return {
		org: "acme",
		workspace: "backend",
		agentId: "agent-a",
		role,
		...(project !== undefined ? { project } : {}),
	};
}

/** Build a request context (group + method + optional target project). */
function ctx(group: string, method: string, project?: string): AuthorizationContext {
	return { group, method, ...(project !== undefined ? { project } : {}) };
}

const policy = createRbacPolicy();

// ────────────────────────────────────────────────────────────────────────────
// c-AC-2 — readonly write route → 403; admin passes everything.
// ────────────────────────────────────────────────────────────────────────────

describe("c-AC-2 readonly on a write route → 403; admin passes all checks", () => {
	it("[policy] readonly GETs a data route (read) → allow", () => {
		expect(policy.decide(identity("readonly"), ctx("/api/memories", "GET"))).toBe("allow");
	});

	it("[policy] readonly POSTs a data route (write) → forbidden", () => {
		expect(policy.decide(identity("readonly"), ctx("/api/memories", "POST"))).toBe("forbidden");
	});

	it("[policy] readonly PUT/PATCH/DELETE are all forbidden (the whole write set)", () => {
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			expect(policy.decide(identity("readonly"), ctx("/api/skills", method))).toBe("forbidden");
		}
	});

	it("[policy] admin passes a write route, an admin route, AND a cross-project request", () => {
		expect(policy.decide(identity("admin"), ctx("/api/memories", "POST"))).toBe("allow");
		expect(policy.decide(identity("admin"), ctx("/api/secrets", "DELETE"))).toBe("allow");
		// admin bypasses project scope (c-AC-5): scoped alpha admin → beta still allows.
		expect(policy.decide(identity("admin", "alpha"), ctx("/api/memories", "POST", "beta"))).toBe(
			"allow",
		);
	});

	it("[policy] member writes a normal data route → allow (FR-4)", () => {
		expect(policy.decide(identity("member"), ctx("/api/memories", "POST"))).toBe("allow");
	});

	it("[e2e] readonly POST to a write route returns 403 through the middleware", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "ro-token": identity("readonly") }),
			policy,
		});
		daemon.group("/api/skills")?.post("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			method: "POST",
			headers: { authorization: "Bearer ro-token" },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("forbidden");
	});

	it("[e2e] readonly GET to the same route returns 200 (reads still flow)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "ro-token": identity("readonly") }),
			policy,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer ro-token" },
		});
		expect(res.status).toBe(200);
	});

	it("[e2e] admin passes a write route end-to-end (200)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "admin-token": identity("admin") }),
			policy,
		});
		daemon.group("/api/secrets")?.delete("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/secrets/probe", {
			method: "DELETE",
			headers: { authorization: "Bearer admin-token" },
		});
		expect(res.status).toBe(200);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// c-AC-6 — agent on a connectors-admin / token route → 403.
// ────────────────────────────────────────────────────────────────────────────

describe("c-AC-6 agent connector on a connectors-admin or token route → 403", () => {
	it("[policy] agent on a connectors-admin route (read AND write) → forbidden", () => {
		expect(policy.decide(identity("agent"), ctx("/api/connectors", "GET"))).toBe("forbidden");
		expect(policy.decide(identity("agent"), ctx("/api/connectors", "POST"))).toBe("forbidden");
	});

	it("[policy] agent on a token/admin route (/api/auth, /api/secrets, /api/org) → forbidden", () => {
		for (const group of ["/api/auth", "/api/secrets", "/api/org"]) {
			expect(policy.decide(identity("agent"), ctx(group, "GET"))).toBe("forbidden");
		}
	});

	it("[policy] agent on a normal data route → allow (it reads+writes its own data, FR-4/FR-5)", () => {
		expect(policy.decide(identity("agent"), ctx("/api/memories", "POST"))).toBe("allow");
		expect(policy.decide(identity("agent"), ctx("/api/memories", "GET"))).toBe("allow");
	});

	it("[policy] member (operator) administers connectors → allow", () => {
		expect(policy.decide(identity("member"), ctx("/api/connectors", "POST"))).toBe("allow");
	});

	it("[e2e] agent hitting /api/connectors returns 403 through the middleware", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "agent-token": identity("agent") }),
			policy,
		});
		daemon.group("/api/connectors")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/connectors/probe", {
			headers: { authorization: "Bearer agent-token" },
		});
		expect(res.status).toBe(403);
	});

	it("[e2e] agent hitting a token route (/api/auth) returns 403", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "agent-token": identity("agent") }),
			policy,
		});
		daemon.group("/api/auth")?.post("/tokens", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/auth/tokens", {
			method: "POST",
			headers: { authorization: "Bearer agent-token" },
		});
		expect(res.status).toBe(403);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// c-AC-5 — project alpha identity targeting project beta → 403 unless admin.
// ────────────────────────────────────────────────────────────────────────────

describe("c-AC-5 project=alpha targeting project=beta → 403 unless admin", () => {
	it("[policy] member scoped alpha → beta is forbidden", () => {
		expect(policy.decide(identity("member", "alpha"), ctx("/api/memories", "POST", "beta"))).toBe(
			"forbidden",
		);
	});

	it("[policy] member scoped alpha → alpha is allowed (same project)", () => {
		expect(policy.decide(identity("member", "alpha"), ctx("/api/memories", "POST", "alpha"))).toBe(
			"allow",
		);
	});

	it("[policy] member scoped alpha with NO target project → allowed (nothing to cross)", () => {
		expect(policy.decide(identity("member", "alpha"), ctx("/api/memories", "GET"))).toBe("allow");
	});

	it("[policy] unscoped member → any project is allowed", () => {
		expect(policy.decide(identity("member"), ctx("/api/memories", "POST", "beta"))).toBe("allow");
	});

	it("[policy] admin scoped alpha → beta is allowed (admin bypasses scope)", () => {
		expect(policy.decide(identity("admin", "alpha"), ctx("/api/memories", "POST", "beta"))).toBe(
			"allow",
		);
	});

	// e2e uses /api/skills (a non-session `write` group) so the project-scope gate
	// is exercised WITHOUT the session runtime-path middleware in the way.
	it("[e2e] member scoped alpha targeting ?project=beta returns 403", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "alpha-token": identity("member", "alpha") }),
			policy,
		});
		daemon.group("/api/skills")?.post("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe?project=beta", {
			method: "POST",
			headers: { authorization: "Bearer alpha-token" },
		});
		expect(res.status).toBe(403);
	});

	it("[e2e] member scoped alpha targeting ?project=alpha returns 200", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "alpha-token": identity("member", "alpha") }),
			policy,
		});
		daemon.group("/api/skills")?.post("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe?project=alpha", {
			method: "POST",
			headers: { authorization: "Bearer alpha-token" },
		});
		expect(res.status).toBe(200);
	});

	it("[e2e] admin scoped alpha targeting ?project=beta returns 200 (admin exempt)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "admin-token": identity("admin", "alpha") }),
			policy,
		});
		daemon.group("/api/skills")?.post("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe?project=beta", {
			method: "POST",
			headers: { authorization: "Bearer admin-token" },
		});
		expect(res.status).toBe(200);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// c-AC-3 — team mode + no valid credential → 401 (the AUTHENTICATOR layer).
// ────────────────────────────────────────────────────────────────────────────

describe("c-AC-3 team mode + no valid Bearer/API key → 401", () => {
	it("[e2e] no credential presented → 401 before the policy is consulted", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": identity("admin") }),
			policy,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe");
		expect(res.status).toBe(401);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("unauthorized");
	});

	it("[e2e] a presented-but-invalid credential → 401 (authenticator returns null)", async () => {
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": identity("admin") }),
			policy,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer nope" },
		});
		expect(res.status).toBe(401);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// c-AC-4 — local mode → full access, no token required (the MODE gate).
// ────────────────────────────────────────────────────────────────────────────

describe("c-AC-4 local mode → full access, no token required", () => {
	it("[e2e] local mode runs the handler with NO credential, even with default-deny would-be policy", async () => {
		let reached = false;
		const daemon = createDaemon({
			config: cfg("local"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({}),
			policy, // the real policy must never even be reached in local mode.
		});
		daemon.group("/api/secrets")?.delete("/probe", (c) => {
			reached = true;
			return c.json({ ok: true });
		});
		// A write to an admin route with no token: local mode opens it anyway.
		const res = await daemon.app.request("/api/secrets/probe", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(reached).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// c-AC-1 — hybrid + no socket-peer info → fail closed, require a token.
// ────────────────────────────────────────────────────────────────────────────

describe("c-AC-1 hybrid + no socket-peer info → fail closed, require a token (never Host)", () => {
	it("[e2e] hybrid + forged loopback Host + no token → 401 (Host is never trusted)", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": identity("admin") }),
			policy,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { host: "127.0.0.1" },
		});
		expect(res.status).toBe(401);
	});

	it("[e2e] hybrid + valid token → the policy runs (admin allowed → 200)", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "good-token": identity("admin") }),
			policy,
		});
		daemon.group("/api/skills")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/skills/probe", {
			headers: { authorization: "Bearer good-token" },
		});
		expect(res.status).toBe(200);
	});

	it("[e2e] hybrid + valid token but insufficient role → the policy 403s (agent on /api/connectors)", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			authenticator: createFakeAuthenticator({ "agent-token": identity("agent") }),
			policy,
		});
		daemon.group("/api/connectors")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/connectors/probe", {
			headers: { authorization: "Bearer agent-token" },
		});
		expect(res.status).toBe(403);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Fail-closed defaults — the classification table never widens on the unknown.
// ────────────────────────────────────────────────────────────────────────────

describe("fail-closed classification (unknown group → admin-only)", () => {
	it("[policy] an unclassified group is locked to admin (default capability)", () => {
		// A group not in the table → DEFAULT_CAPABILITY = admin.
		expect(policy.decide(identity("member"), ctx("/api/totally-new", "GET"))).toBe("forbidden");
		expect(policy.decide(identity("agent"), ctx("/api/totally-new", "GET"))).toBe("forbidden");
		expect(policy.decide(identity("admin"), ctx("/api/totally-new", "GET"))).toBe("allow");
	});
});
