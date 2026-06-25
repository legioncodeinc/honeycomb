/**
 * PRD-049e — the dashboard SCOPE-SWITCHER enumeration endpoints suite (49e-AC-1 / 49e-AC-3).
 *
 * Verification posture (mirrors the projects-sync seam suite): the seam is mounted on a REAL daemon
 * (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group middleware is open) and
 * exercised in-process via `daemon.app.request(...)` — no socket, no live `api.deeplake.ai`. A FAKE
 * `DeeplakeAuthClient` (injected via `authClientFactory`) records its call ORDER so the 49e-AC-3
 * reMint-before-listWorkspaces assertion is deterministic, and a fake StorageQuery + temp `~/.deeplake`
 * back the projects read. A temp credentials dir holds the token the handlers resolve.
 *
 *   49e-AC-1 — /scope/orgs + /scope/workspaces are privilege-scoped by the token (the fake returns
 *              exactly what the token can see); /scope/projects lists the synced registry copy.
 *   49e-AC-3 — changing the Org RE-MINTS the org-bound token BEFORE enumerating the new org's
 *              workspaces (the recorded call order is `reMint` then `listWorkspaces`); a SAME-org
 *              request does NOT re-mint (the existing token is already bound).
 *   D-4      — no token rides any response body.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import type { DeeplakeAuthClient, OrgRow, WorkspaceRow } from "../../../../src/daemon/runtime/auth/deeplake-issuer.js";
import {
	type ScopeOrgsBody,
	type ScopeProjectsBody,
	type ScopeWorkspacesBody,
	mountScopeEnumerationApi,
} from "../../../../src/daemon/runtime/projects/scope-enumeration-api.js";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

const DEFAULT_SCOPE: QueryScope = { org: "acme", workspace: "backend" };

function fakeStorage(result: QueryResult): StorageQuery {
	return { async query(): Promise<QueryResult> { return result; } };
}

function registryRow(over: Partial<StorageRow> = {}): StorageRow {
	return {
		project_id: "api",
		name: "API",
		remote_signal: "github.com/acme/api",
		bound_paths: "[]",
		is_reserved: 0,
		org_id: "acme",
		workspace_id: "backend",
		created_at: "",
		updated_at: "",
		...over,
	};
}

/** A recording fake auth client: scripts the org/workspace lists + records the call order. */
function fakeAuthClient(opts: {
	orgs?: OrgRow[];
	workspaces?: WorkspaceRow[];
	calls: string[];
}): DeeplakeAuthClient {
	return {
		apiUrl: "https://api.deeplake.test",
		async getMe() {
			return { id: "u1", name: "User" };
		},
		async listOrgs() {
			opts.calls.push("listOrgs");
			return opts.orgs ?? [];
		},
		async listWorkspaces() {
			opts.calls.push("listWorkspaces");
			return opts.workspaces ?? [];
		},
		async reMint() {
			opts.calls.push("reMint");
			return "reminted-token";
		},
		async requestDeviceCode() {
			throw new Error("not used");
		},
		async pollDeviceToken() {
			throw new Error("not used");
		},
	};
}

/** Write a minimal valid credentials.json into the temp dir so the handlers resolve a token. */
function writeCreds(dir: string, org = "acme"): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "credentials.json"),
		JSON.stringify({ token: "tok-secret", orgId: org, orgName: "Acme", workspaceId: "backend", apiUrl: "https://api.deeplake.test", savedAt: "" }),
	);
}

let dir: string;
let calls: string[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-scopeenum-"));
	calls = [];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function daemonWith(opts: {
	storage: StorageQuery;
	client: DeeplakeAuthClient;
	mode?: RuntimeConfig["mode"];
}): Daemon {
	const daemon = createDaemon({ config: cfg({ mode: opts.mode ?? "local" }), storage: opts.storage as never, logger: createRequestLogger({ silent: true }) });
	mountScopeEnumerationApi(daemon, {
		storage: opts.storage,
		defaultScope: DEFAULT_SCOPE,
		credentialsDir: dir,
		projectsDir: dir,
		env: {},
		authClientFactory: () => opts.client,
	});
	return daemon;
}

describe("PRD-049e GET /api/diagnostics/scope/orgs (49e-AC-1)", () => {
	it("returns the token's privilege-scoped orgs (id+name), no token in the body", async () => {
		writeCreds(dir);
		const client = fakeAuthClient({ orgs: [{ id: "acme", name: "Acme" }, { id: "globex", name: "Globex" }], calls });
		const daemon = daemonWith({ storage: fakeStorage(ok([], 0)), client });
		const res = await daemon.app.request("/api/diagnostics/scope/orgs");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ScopeOrgsBody;
		expect(body.orgs.map((o) => o.id)).toEqual(["acme", "globex"]);
		expect(JSON.stringify(body)).not.toMatch(/tok-secret|token|bearer/i);
	});

	it("with no credential → an empty list (never a 500)", async () => {
		const client = fakeAuthClient({ calls });
		const daemon = daemonWith({ storage: fakeStorage(ok([], 0)), client });
		const res = await daemon.app.request("/api/diagnostics/scope/orgs");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ScopeOrgsBody;
		expect(body.orgs).toEqual([]);
	});

	it("is NOT served in team mode (the read is local-mode-only — D-4 / security F-1)", async () => {
		writeCreds(dir);
		const client = fakeAuthClient({ orgs: [{ id: "acme", name: "Acme" }], calls });
		const daemon = daemonWith({ storage: fakeStorage(ok([], 0)), client, mode: "team" });
		const res = await daemon.app.request("/api/diagnostics/scope/orgs");
		// In team/hybrid the read never serves the org list: either the protected group's auth gate
		// rejects an unauthenticated loopback request (401), or — if it reached the handler — the
		// handler's own local-mode self-gate 404s. EITHER way it is NOT a 200 with the orgs (no
		// privilege-scoped enumeration leaks outside local mode). The local-mode 200 path is covered above.
		expect(res.status).not.toBe(200);
		expect([401, 403, 404]).toContain(res.status);
	});
});

describe("PRD-049e GET /api/diagnostics/scope/workspaces (49e-AC-1 / 49e-AC-3)", () => {
	it("49e-AC-3: changing the Org RE-MINTS the org-bound token BEFORE enumerating the new org", async () => {
		writeCreds(dir, "acme"); // the credential is bound to acme
		const client = fakeAuthClient({ workspaces: [{ id: "team-x", name: "Team X" }], calls });
		const daemon = daemonWith({ storage: fakeStorage(ok([], 0)), client });
		// Request a DIFFERENT org → the re-mint must precede the workspace enumeration.
		const res = await daemon.app.request("/api/diagnostics/scope/workspaces?org=globex");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ScopeWorkspacesBody;
		expect(body.reminted).toBe(true);
		expect(body.org).toBe("globex");
		expect(body.workspaces.map((w) => w.id)).toEqual(["team-x"]);
		// THE load-bearing 49e-AC-3 assertion: reMint strictly precedes listWorkspaces.
		expect(calls).toEqual(["reMint", "listWorkspaces"]);
	});

	it("a SAME-org request does NOT re-mint (the existing token is already org-bound)", async () => {
		writeCreds(dir, "acme");
		const client = fakeAuthClient({ workspaces: [{ id: "backend", name: "Backend" }], calls });
		const daemon = daemonWith({ storage: fakeStorage(ok([], 0)), client });
		const res = await daemon.app.request("/api/diagnostics/scope/workspaces?org=acme");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ScopeWorkspacesBody;
		expect(body.reminted).toBe(false);
		expect(calls).toEqual(["listWorkspaces"]);
	});
});

describe("PRD-049e GET /api/diagnostics/scope/projects (49e-AC-1)", () => {
	it("lists the workspace's synced registry projects (049a cache)", async () => {
		writeCreds(dir);
		const client = fakeAuthClient({ calls });
		// The storage query feeds syncRegistryToCache, which writes the cache the read then returns.
		const daemon = daemonWith({ storage: fakeStorage(ok([registryRow()], 1)), client });
		const res = await daemon.app.request("/api/diagnostics/scope/projects");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ScopeProjectsBody;
		expect(body.projects.map((p) => p.projectId)).toContain("api");
		expect(body.workspace).toBe("backend");
		expect(JSON.stringify(body)).not.toMatch(/tok-secret|token|bearer/i);
	});
});
