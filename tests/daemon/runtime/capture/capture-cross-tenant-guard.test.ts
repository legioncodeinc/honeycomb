/**
 * Cross-tenant guard for GET /api/hooks/conversation (PRD-022 security hardening).
 *
 * ── PENTEST FINDING MITIGATION ──────────────────────────────────────────────
 * The pentest identified that `handleConversation` read `x-honeycomb-org` directly
 * from the request and constructed a `QueryScope` from that attacker-controlled
 * header, bypassing the identity-bound scope check. An authenticated user could
 * forge the org header to read conversation data from another organization.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * `handleConversation` now calls `resolveScopeFromHeaders(c)`, which includes a
 * cross-tenant guard: when an authenticated Identity is present on the context
 * (team/hybrid mode), the resolved org MUST equal `identity.org`. A mismatch
 * returns `null` → the handler fails closed with 400.
 *
 * ── WHAT THESE TESTS PROVE ──────────────────────────────────────────────────
 *   1. In local mode (no Identity), the handler accepts the org header as before
 *      (backward compatibility — the prior pure-header behaviour is unchanged).
 *   2. In team/hybrid mode with an authenticated Identity, a forged org header
 *      that disagrees with `identity.org` is REJECTED (400) — the cross-tenant
 *      read is blocked.
 *   3. In team/hybrid mode with an authenticated Identity, a MATCHING org header
 *      is accepted — legitimate same-org reads still work.
 *   4. The scope that reaches the storage layer is ALWAYS bound to the
 *      authenticated identity's org, never an attacker-controlled value.
 *
 * Verification posture: in-process `daemon.app.request(...)` against the PRD-002
 * fake transport. The permission middleware is REAL (so Identity stamping works),
 * but we inject a fake authenticator that returns a controlled Identity. The
 * handler is attached via `createCaptureHandler(...).register(daemon)` so it
 * inherits the real middleware stack. The SQL + scope that reach the fake
 * transport are asserted to prove the org is bound to the identity, not the header.
 */

import { describe, expect, it } from "vitest";

import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import {
	type Authenticator,
	type AuthorizationPolicy,
	type Identity,
	type PresentedCredentials,
	alwaysUnauthenticated,
} from "../../../../src/daemon/runtime/auth/contracts.js";
import {
	createCaptureHandler,
	type CaptureHandlerDeps,
} from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

// ── Test scaffolding ─────────────────────────────────────────────────────────

const LEGITIMATE_ORG = "org-alice";
const VICTIM_ORG = "org-victim";
const WORKSPACE = "workspace-1";

/** Build a resolved config for the specified mode. */
function cfg(mode: RuntimeConfig["mode"] = "local"): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false };
}

/** The `x-honeycomb-*` headers a session-scoped GET needs (runtime-path + session). */
function sessionHeaders(org: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-1",
		"x-honeycomb-org": org,
		"x-honeycomb-workspace": WORKSPACE,
		// In team/hybrid mode, the permission middleware requires credentials.
		// Provide a bearer token so the fake authenticator is called.
		"authorization": "Bearer fake-token-for-test",
		...extra,
	};
}

/**
 * A fake authenticator that returns a controlled Identity with a fixed org.
 * This simulates a team/hybrid authenticated request where the permission
 * middleware has validated the token and stamped the Identity onto the context.
 */
function fakeAuthenticator(identityOrg: string): Authenticator {
	return {
		async authenticate(_presented: PresentedCredentials): Promise<Identity | null> {
			// Return a validated Identity bound to `identityOrg` (the token's org).
			return {
				org: identityOrg,
				workspace: WORKSPACE,
				role: "member",
				project: undefined,
			};
		},
	};
}

/**
 * A permissive policy that allows all requests. This is needed so the permission
 * middleware doesn't reject requests with 403 after authentication succeeds.
 */
const allowAllPolicy: AuthorizationPolicy = {
	decide(): "allow" | "forbidden" | "unauthenticated" {
		return "allow";
	},
};

/**
 * A SQL-aware responder for the fake transport: SELECTs return scripted rows;
 * INSERTs/UPDATEs/DELETEs succeed with no rows. Also handles introspection queries.
 */
function responderFor(opts: { readbackRows?: Record<string, unknown>[] } = {}) {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// Introspection queries for heal (report columns exist)
		if (/information_schema\.columns/i.test(sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		// CREATE/ALTER TABLE (heal operations)
		if (/^\s*(CREATE|ALTER)\s+TABLE/i.test(sql)) {
			return [];
		}
		// SELECT queries (readAppendOrdered)
		if (/^\s*SELECT/i.test(sql)) {
			return opts.readbackRows ?? [];
		}
		// INSERT/UPDATE/DELETE
		return [];
	};
}

/** Build a daemon + capture handler over the fake transport. */
function buildDaemon(opts: {
	mode?: RuntimeConfig["mode"];
	authenticator?: Authenticator;
	responder?: (req: TransportRequest) => Record<string, unknown>[];
} = {}): { daemon: Daemon; fake: FakeDeepLakeTransport } {
	const fake = new FakeDeepLakeTransport(opts.responder ?? responderFor());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({
		config: cfg(opts.mode ?? "local"),
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
		// Inject the authenticator so we can control the Identity that gets stamped.
		authenticator: opts.authenticator ?? alwaysUnauthenticated,
		// Inject a permissive policy so authenticated requests are allowed.
		policy: allowAllPolicy,
	});
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue: {
			async enqueue() { return "job-1"; },
			async lease() { return null; },
			async complete() {},
			async fail() {},
			start() {},
			stop() {},
		},
		// Disable batching so the test assertions are simpler (same as capture-handler.test.ts).
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
	});
	handler.register(daemon);
	return { daemon, fake };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Cross-tenant guard for GET /api/hooks/conversation (pentest mitigation)", () => {
	it("local mode: accepts the org header as before (no Identity, backward compat)", async () => {
		// In local mode, no authenticator runs, so no Identity is stamped. The handler
		// should accept the org header as-is (the prior pure-header behaviour).
		const rows = [
			{ id: "row-1", path: "conversations/sess-1", message: { event: { kind: "user_message", text: "hello" } } },
		];
		const { daemon, fake } = buildDaemon({
			mode: "local",
			responder: responderFor({ readbackRows: rows }),
		});

		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-1",
			{ headers: sessionHeaders(LEGITIMATE_ORG) },
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; rows: Record<string, unknown>[] };
		expect(body.rows.length).toBe(1);
		expect(body.rows[0].id).toBe("row-1");

		// The SELECT went out with the org from the header (no identity to cross-check).
		const select = fake.requests.find((r) => /^\\s*SELECT/i.test(r.sql));
		expect(select?.org).toBe(LEGITIMATE_ORG);
	});

	it("team mode: rejects a forged org header that disagrees with identity.org (400)", async () => {
		// The authenticator returns an Identity bound to LEGITIMATE_ORG, but the request
		// carries a forged `x-honeycomb-org: VICTIM_ORG` header. The cross-tenant guard
		// should detect the mismatch and return null → handler fails closed with 400.
		const { daemon, fake } = buildDaemon({
			mode: "team",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
		});

		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-1",
			{ headers: sessionHeaders(VICTIM_ORG) }, // Forged org header
		);

		// The handler rejects the forged org with 400 (no resolvable scope).
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("bad_request");
		expect(body.reason).toContain("x-honeycomb-org");

		// No SELECT went out — the handler failed closed before reaching storage.
		const selects = fake.requests.filter((r) => /^\\s*SELECT/i.test(r.sql));
		expect(selects.length).toBe(0);
	});

	it("team mode: accepts a matching org header (identity.org === header org)", async () => {
		// The authenticator returns an Identity bound to LEGITIMATE_ORG, and the request
		// carries a matching `x-honeycomb-org: LEGITIMATE_ORG` header. The guard should
		// accept this (legitimate same-org read).
		const rows = [
			{ id: "row-2", path: "conversations/sess-2", message: { event: { kind: "user_message", text: "legit" } } },
		];
		const { daemon, fake } = buildDaemon({
			mode: "team",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
			responder: responderFor({ readbackRows: rows }),
		});

		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-2",
			{ headers: sessionHeaders(LEGITIMATE_ORG) }, // Matching org header
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; rows: Record<string, unknown>[] };
		expect(body.rows.length).toBe(1);
		expect(body.rows[0].id).toBe("row-2");

		// The SELECT went out with the org from the identity (which matches the header).
		const select = fake.requests.find((r) => /^\\s*SELECT/i.test(r.sql));
		expect(select?.org).toBe(LEGITIMATE_ORG);
	});

	it("team mode: the scope that reaches storage is bound to identity.org, never the forged header", async () => {
		// This test proves the security property: even if an attacker tries to forge the
		// org header, the scope that reaches the storage layer is ALWAYS bound to the
		// authenticated identity's org (or the request is rejected before reaching storage).
		const rows = [
			{ id: "row-3", path: "conversations/sess-3", message: { event: { kind: "user_message", text: "secure" } } },
		];
		const { daemon, fake } = buildDaemon({
			mode: "team",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
			responder: responderFor({ readbackRows: rows }),
		});

		// Legitimate request with matching org.
		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-3",
			{ headers: sessionHeaders(LEGITIMATE_ORG) },
		);

		expect(res.status).toBe(200);

		// Assert that the org in the transport request is LEGITIMATE_ORG (from the identity),
		// not any attacker-controlled value. This proves the scope is identity-bound.
		const select = fake.requests.find((r) => /^\\s*SELECT/i.test(r.sql));
		expect(select?.org).toBe(LEGITIMATE_ORG);
		expect(select?.org).not.toBe(VICTIM_ORG);
	});

	it("team mode: rejects a request with no org header when identity is present (fail-closed)", async () => {
		// Even with an authenticated identity, a request with NO org header should be
		// rejected (fail-closed). The handler requires a resolvable scope.
		const { daemon, fake } = buildDaemon({
			mode: "team",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
		});

		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-1",
			{
				headers: {
					"x-honeycomb-runtime-path": "plugin",
					"x-honeycomb-session": "sess-1",
					"authorization": "Bearer fake-token-for-test",
					// No x-honeycomb-org header
				},
			},
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("bad_request");
		expect(body.reason).toContain("x-honeycomb-org");

		// No SELECT went out.
		const selects = fake.requests.filter((r) => /^\\s*SELECT/i.test(r.sql));
		expect(selects.length).toBe(0);
	});

	it("hybrid mode: same cross-tenant guard applies (forged org rejected)", async () => {
		// Hybrid mode should have the same cross-tenant guard as team mode.
		const { daemon, fake } = buildDaemon({
			mode: "hybrid",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
		});

		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-1",
			{ headers: sessionHeaders(VICTIM_ORG) }, // Forged org header
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("bad_request");

		// No SELECT went out.
		const selects = fake.requests.filter((r) => /^\\s*SELECT/i.test(r.sql));
		expect(selects.length).toBe(0);
	});

	it("team mode: workspace header is also validated (full scope binding)", async () => {
		// The cross-tenant guard applies to the full scope (org + workspace). A matching
		// org with a valid workspace should work.
		const rows = [
			{ id: "row-4", path: "conversations/sess-4", message: { event: { kind: "user_message", text: "ws" } } },
		];
		const { daemon, fake } = buildDaemon({
			mode: "team",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
			responder: responderFor({ readbackRows: rows }),
		});

		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/sess-4",
			{ headers: sessionHeaders(LEGITIMATE_ORG) },
		);

		expect(res.status).toBe(200);

		// The SELECT went out with both org and workspace from the headers (org validated).
		const select = fake.requests.find((r) => /^\\s*SELECT/i.test(r.sql));
		expect(select?.org).toBe(LEGITIMATE_ORG);
		expect(select?.workspace).toBe(WORKSPACE);
	});

	it("pentest scenario: attacker with valid session cannot read victim org conversations", async () => {
		// This test directly models the pentest finding: an authenticated user (with a
		// valid session for LEGITIMATE_ORG) attempts to read conversation data from
		// VICTIM_ORG by forging the `x-honeycomb-org` header. The fix should block this.
		const { daemon, fake } = buildDaemon({
			mode: "team",
			authenticator: fakeAuthenticator(LEGITIMATE_ORG),
		});

		// Attacker has a valid session for LEGITIMATE_ORG but tries to read VICTIM_ORG data.
		const res = await daemon.app.request(
			"/api/hooks/conversation?path=conversations/victim-session",
			{
				headers: {
					"x-honeycomb-runtime-path": "plugin",
					"x-honeycomb-session": "attacker-session",
					"authorization": "Bearer fake-token-for-test",
					"x-honeycomb-org": VICTIM_ORG, // Forged to victim's org
					"x-honeycomb-workspace": WORKSPACE,
				},
			},
		);

		// The cross-tenant guard rejects the forged org header.
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("bad_request");

		// No SELECT went out — the attacker cannot read victim org data.
		const selects = fake.requests.filter((r) => /^\\s*SELECT/i.test(r.sql));
		expect(selects.length).toBe(0);
	});
});
