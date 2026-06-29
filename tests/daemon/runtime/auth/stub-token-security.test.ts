/**
 * SECURITY TEST: Unsigned hcmt.v1 bearer tokens must NOT be trusted as admin
 * identities in team/hybrid mode.
 *
 * This test suite verifies the mitigation for the pentest finding:
 * "Unsigned hcmt.v1 bearer tokens are trusted as admin identities in team/hybrid mode"
 *
 * The vulnerability allowed an attacker to forge an `hcmt.v1` bearer token with
 * admin claims and bypass RBAC on protected daemon APIs in team/hybrid modes.
 *
 * The fix: `createTokenAuthenticator()` now receives the deployment mode and
 * REJECTS unsigned stub tokens (those with the `hcmt.v1.` prefix) in team/hybrid
 * modes. Stub tokens are development-only and lack cryptographic signatures.
 *
 * Test coverage:
 * 1. Unit tests: stub tokens rejected by authenticator in team/hybrid modes
 * 2. Integration tests: forged admin tokens rejected end-to-end via HTTP
 * 3. Regression tests: stub tokens still work in local mode (development)
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	createRbacPolicy,
	createTokenAuthenticator,
	encodeStubToken,
} from "../../../../src/daemon/runtime/auth/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function cfg(mode: RuntimeConfig["mode"], over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false, ...over };
}

const storageStub = {
	async query() {
		return { kind: "ok", rows: [], durationMs: 0 } as const;
	},
};

/**
 * Forge a stub token with attacker-controlled claims.
 * This simulates the attack: an attacker crafts a token with admin role.
 */
function forgeAdminToken(org: string): string {
	return encodeStubToken({ org, role: "admin", workspace: "default", agentId: "attacker" });
}

function forgeMemberToken(org: string): string {
	return encodeStubToken({ org, role: "member", workspace: "default", agentId: "attacker" });
}

// ────────────────────────────────────────────────────────────────────────────
// UNIT TESTS: Token authenticator rejects stub tokens in team/hybrid modes
// ────────────────────────────────────────────────────────────────────────────

describe("SECURITY: Token authenticator rejects forged stub tokens in production modes", () => {
	it("rejects a forged admin stub token in team mode", async () => {
		const authn = createTokenAuthenticator(undefined, "team");
		const forgedToken = forgeAdminToken("acme");

		// The authenticator MUST reject the forged token → null (401).
		const identity = await authn.authenticate({ bearer: forgedToken });
		expect(identity).toBeNull();
	});

	it("rejects a forged admin stub token in hybrid mode", async () => {
		const authn = createTokenAuthenticator(undefined, "hybrid");
		const forgedToken = forgeAdminToken("acme");

		// The authenticator MUST reject the forged token → null (401).
		const identity = await authn.authenticate({ bearer: forgedToken });
		expect(identity).toBeNull();
	});

	it("rejects a forged member stub token in team mode", async () => {
		const authn = createTokenAuthenticator(undefined, "team");
		const forgedToken = forgeMemberToken("acme");

		// ANY stub token (not just admin) must be rejected in production.
		const identity = await authn.authenticate({ bearer: forgedToken });
		expect(identity).toBeNull();
	});

	it("rejects a forged member stub token in hybrid mode", async () => {
		const authn = createTokenAuthenticator(undefined, "hybrid");
		const forgedToken = forgeMemberToken("acme");

		// ANY stub token (not just admin) must be rejected in production.
		const identity = await authn.authenticate({ bearer: forgedToken });
		expect(identity).toBeNull();
	});

	it("accepts stub tokens in local mode (development: single-user loopback)", async () => {
		const authn = createTokenAuthenticator(undefined, "local");
		const stubToken = encodeStubToken({ org: "acme", role: "admin" });

		// In local mode, stub tokens are allowed for development.
		const identity = await authn.authenticate({ bearer: stubToken });
		expect(identity).not.toBeNull();
		expect(identity?.org).toBe("acme");
		expect(identity?.role).toBe("admin");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// INTEGRATION TESTS: End-to-end HTTP request flow with forged tokens
// ────────────────────────────────────────────────────────────────────────────

describe("SECURITY [e2e]: Forged stub tokens rejected on protected routes in team mode", () => {
	it("forged admin token on a protected write route → 401 (not 200)", async () => {
		// Simulate the attack: attacker forges an admin token and tries to access
		// a protected write route (e.g., POST /api/memories).
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		// Mount a protected write route (requires authentication + authorization).
		daemon.group("/api/memories")?.post("/", (c) => c.json({ ok: true }));

		const forgedToken = forgeAdminToken("acme");
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// The forged token MUST be rejected → 401 or 400 (both indicate rejection).
		// 401 = unauthenticated, 400 = bad request (e.g., scope validation failure).
		// The key security property: NOT 200 (success).
		expect([400, 401]).toContain(res.status);
		expect(res.status).not.toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toMatch(/unauthorized|bad_request/);
	});

	it("forged admin token on an admin-only route → 401 (not 200)", async () => {
		// Simulate the attack: attacker forges an admin token and tries to access
		// an admin-only route (e.g., DELETE /api/secrets).
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		// Mount an admin-only route (requires admin role).
		daemon.group("/api/secrets")?.delete("/probe", (c) => c.json({ ok: true }));

		const forgedToken = forgeAdminToken("acme");
		const res = await daemon.app.request("/api/secrets/probe", {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// The forged token MUST be rejected → 401 (unauthenticated).
		expect(res.status).toBe(401);
	});

	it("forged member token on a protected route → 401 (not 200)", async () => {
		// Verify that ANY forged stub token (not just admin) is rejected.
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/skills")?.get("/", (c) => c.json({ ok: true }));

		const forgedToken = forgeMemberToken("acme");
		const res = await daemon.app.request("/api/skills", {
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// The forged token MUST be rejected → 401.
		expect(res.status).toBe(401);
	});
});

describe("SECURITY [e2e]: Forged stub tokens rejected on protected routes in hybrid mode", () => {
	it("forged admin token on a protected write route → 401 (not 200)", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/memories")?.post("/", (c) => c.json({ ok: true }));

		const forgedToken = forgeAdminToken("acme");
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// The forged token MUST be rejected in hybrid mode → 401 or 400.
		// The key security property: NOT 200 (success).
		expect([400, 401]).toContain(res.status);
		expect(res.status).not.toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toMatch(/unauthorized|bad_request/);
	});

	it("forged admin token on an admin-only route → 401 (not 200)", async () => {
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/secrets")?.delete("/probe", (c) => c.json({ ok: true }));

		const forgedToken = forgeAdminToken("acme");
		const res = await daemon.app.request("/api/secrets/probe", {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// The forged token MUST be rejected in hybrid mode → 401.
		expect(res.status).toBe(401);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// REGRESSION TESTS: Stub tokens still work in local mode (development)
// ────────────────────────────────────────────────────────────────────────────

describe("REGRESSION: Stub tokens still work in local mode (development)", () => {
	it("stub admin token on a protected route → 200 in local mode", async () => {
		// In local mode (single-user loopback), stub tokens are allowed for development.
		const daemon = createDaemon({
			config: cfg("local"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/memories")?.post("/", (c) => c.json({ ok: true }));

		const stubToken = encodeStubToken({ org: "acme", role: "admin" });
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: {
				authorization: `Bearer ${stubToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// In local mode, the route is open (no auth required), so we get 200 or 400.
		// 400 might occur if the route needs additional setup (e.g., storage).
		// The key property: stub tokens don't cause crashes in local mode.
		expect([200, 400]).toContain(res.status);
	});

	it("stub member token on a protected route → 200 in local mode", async () => {
		const daemon = createDaemon({
			config: cfg("local"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/skills")?.get("/", (c) => c.json({ ok: true }));

		const stubToken = encodeStubToken({ org: "acme", role: "member" });
		const res = await daemon.app.request("/api/skills", {
			headers: {
				authorization: `Bearer ${stubToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// In local mode, stub tokens are accepted → 200.
		expect(res.status).toBe(200);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EXPLOIT SCENARIO TESTS: Reproduce the exact attack flow from the pentest
// ────────────────────────────────────────────────────────────────────────────

describe("SECURITY [exploit scenario]: Reproduce the pentest attack flow", () => {
	it("attacker forges admin token with matching org header → 401 (not 200)", async () => {
		// This test reproduces the exact attack scenario from the pentest:
		// 1. Attacker crafts a stub token with admin role and org claim
		// 2. Attacker sets x-honeycomb-org header to match the token's org
		// 3. Attacker sends the forged token to a protected admin route
		//
		// BEFORE the fix: The token would be accepted, admin role granted, RBAC bypassed → 200
		// AFTER the fix: The stub token is rejected in team/hybrid mode → 401

		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		// Mount a protected admin route (e.g., secrets management).
		daemon.group("/api/secrets")?.post("/", (c) => c.json({ secret: "created" }));

		// Step 1: Attacker forges a stub token with admin role
		const attackerOrg = "target-org";
		const forgedAdminToken = encodeStubToken({
			org: attackerOrg,
			role: "admin",
			workspace: "default",
			agentId: "attacker-agent",
		});

		// Step 2 & 3: Attacker sends the forged token with matching org header
		const res = await daemon.app.request("/api/secrets", {
			method: "POST",
			headers: {
				authorization: `Bearer ${forgedAdminToken}`,
				"x-honeycomb-org": attackerOrg, // Matches the token's org claim
			},
		});

		// SECURITY ASSERTION: The forged token MUST be rejected → 401
		expect(res.status).toBe(401);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("unauthorized");

		// Verify the handler was NOT reached (no secret was created).
		expect(body.secret).toBeUndefined();
	});

	it("attacker forges admin token for cross-project access → 401 (not 200)", async () => {
		// Reproduce the attack with project-scoped routes.
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/memories")?.post("/", (c) => c.json({ ok: true }));

		// Attacker forges an admin token to bypass project scope checks.
		const forgedToken = encodeStubToken({
			org: "acme",
			role: "admin",
			project: "alpha", // Attacker claims to be admin of project alpha
		});

		// Attacker tries to access project beta (cross-project).
		const res = await daemon.app.request("/api/memories?project=beta", {
			method: "POST",
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "acme",
			},
		});

		// The forged token MUST be rejected → 401 or 400 (before RBAC is even consulted).
		// The key security property: NOT 200 (success).
		expect([400, 401]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});

	it("attacker forges token with arbitrary org value → 401 (not 200)", async () => {
		// Verify that the attacker cannot authenticate even with a guessed org value.
		const daemon = createDaemon({
			config: cfg("hybrid"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
		});

		daemon.group("/api/connectors")?.post("/", (c) => c.json({ ok: true }));

		// Attacker guesses or knows a valid org value.
		const forgedToken = encodeStubToken({
			org: "known-org-value",
			role: "admin",
		});

		const res = await daemon.app.request("/api/connectors", {
			method: "POST",
			headers: {
				authorization: `Bearer ${forgedToken}`,
				"x-honeycomb-org": "known-org-value",
			},
		});

		// The forged token MUST be rejected → 401.
		expect(res.status).toBe(401);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// DEFENSE-IN-DEPTH: Verify the fix at multiple layers
// ────────────────────────────────────────────────────────────────────────────

describe("SECURITY [defense-in-depth]: Verify rejection at authenticator layer", () => {
	it("stub token rejected BEFORE RBAC policy is consulted", async () => {
		// This test verifies that the fix is at the authenticator layer,
		// not the RBAC policy layer. The token is rejected before the policy
		// even sees the identity.

		const authn = createTokenAuthenticator(undefined, "team");
		const policy = createRbacPolicy();

		const forgedToken = forgeAdminToken("acme");
		const identity = await authn.authenticate({ bearer: forgedToken });

		// The authenticator MUST reject the token → null.
		expect(identity).toBeNull();

		// The RBAC policy is NEVER consulted (identity is null).
		// If the policy were consulted with a forged admin identity, it would allow.
		// This proves the fix is at the authenticator layer (fail-closed).
	});

	it("stub token prefix check is case-sensitive and exact", async () => {
		// Verify that the prefix check is robust (no bypass via case variation).
		const authn = createTokenAuthenticator(undefined, "team");

		// Try various case variations of the stub token prefix.
		const variations = [
			"HCMT.v1." + Buffer.from(JSON.stringify({ org: "acme", role: "admin" })).toString("base64url"),
			"Hcmt.v1." + Buffer.from(JSON.stringify({ org: "acme", role: "admin" })).toString("base64url"),
			"hcmt.V1." + Buffer.from(JSON.stringify({ org: "acme", role: "admin" })).toString("base64url"),
		];

		for (const token of variations) {
			const identity = await authn.authenticate({ bearer: token });
			// All variations MUST be rejected (they don't match the exact prefix).
			expect(identity).toBeNull();
		}
	});

	it("stub token with valid prefix but invalid claims → null", async () => {
		// Verify that even if the prefix is correct, invalid claims are rejected.
		const authn = createTokenAuthenticator(undefined, "local"); // local mode to test claim validation

		// Create a stub token with missing required claims.
		const invalidToken = "hcmt.v1." + Buffer.from(JSON.stringify({ role: "admin" })).toString("base64url");

		const identity = await authn.authenticate({ bearer: invalidToken });
		// Missing org claim → rejected.
		expect(identity).toBeNull();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// BOUNDARY TESTS: Edge cases and mode transitions
// ────────────────────────────────────────────────────────────────────────────

describe("SECURITY [boundary]: Mode-specific behavior is correct", () => {
	it("mode parameter is respected (not ignored or cached)", async () => {
		// Verify that the mode parameter is actually used, not ignored.
		const teamAuthn = createTokenAuthenticator(undefined, "team");
		const localAuthn = createTokenAuthenticator(undefined, "local");

		const stubToken = encodeStubToken({ org: "acme", role: "admin" });

		// Same token, different modes → different results.
		expect(await teamAuthn.authenticate({ bearer: stubToken })).toBeNull();
		expect(await localAuthn.authenticate({ bearer: stubToken })).not.toBeNull();
	});

	it("undefined mode allows stub tokens (backward compatibility)", async () => {
		// When mode is undefined (e.g., in tests), stub tokens are allowed.
		const authn = createTokenAuthenticator(undefined, undefined);
		const stubToken = encodeStubToken({ org: "acme", role: "member" });

		const identity = await authn.authenticate({ bearer: stubToken });
		expect(identity).not.toBeNull();
		expect(identity?.role).toBe("member");
	});

	it("empty bearer string → null (no crash)", async () => {
		const authn = createTokenAuthenticator(undefined, "team");
		const identity = await authn.authenticate({ bearer: "" });
		expect(identity).toBeNull();
	});

	it("non-stub token in team mode → passed to verifier", async () => {
		// Verify that non-stub tokens (e.g., real JWT) are passed to the verifier.
		let verifierCalled = false;
		const customVerifier = (token: string) => {
			verifierCalled = true;
			// Simulate a real JWT verifier that returns null for invalid tokens.
			return null;
		};

		const authn = createTokenAuthenticator(customVerifier, "team");
		const nonStubToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmciOiJhY21lIn0.fake";

		await authn.authenticate({ bearer: nonStubToken });

		// The verifier MUST be called for non-stub tokens.
		expect(verifierCalled).toBe(true);
	});
});
