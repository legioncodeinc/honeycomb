/**
 * IRD-122 — the dashboard scope-switch persistence suite (122-AC-1 / 122-AC-2 / 122-AC-4).
 *
 *   122-AC-2 — POST /scope/org-switch re-mints an org-bound token BEFORE persisting it, and the new
 *              token + org id/name land in the shared `~/.deeplake/credentials.json` (NO token in the
 *              response body, D-4). A SAME-org switch does not re-mint.
 *   IRD-122   — POST /scope/workspace-switch persists the workspace id (NO re-mint).
 *   local-mode gate — a team-mode daemon never serves these (security F-1).
 *
 * Verification posture mirrors `scope-enumeration-api.test.ts`: a REAL daemon in `local` mode,
 * exercised in-process via `daemon.app.request`. A FAKE `DeeplakeAuthClient` records the call ORDER so
 * the reMint-before-save assertion is deterministic; a temp credentials dir holds the persisted file.
 * NO network, NO live api.deeplake.ai.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { ok } from "../../../../src/daemon/storage/result.js";
import type { StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { DeeplakeAuthClient, OrgRow, WorkspaceRow } from "../../../../src/daemon/runtime/auth/index.js";
import {
	type OrgSwitchAck,
	type WorkspaceSwitchAck,
	mountScopeSwitchApi,
} from "../../../../src/daemon/runtime/projects/scope-switch-api.js";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

const storage: StorageQuery = { async query() { return ok([], 0); } };

/** A recording fake auth client: scripts org/workspace lists + the re-mint token; records call order. */
function fakeAuthClient(opts: { orgs?: OrgRow[]; workspaces?: WorkspaceRow[]; calls: string[] }): DeeplakeAuthClient {
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

/** Write a minimal valid credentials.json into the temp dir bound to `org`. */
function writeCreds(dir: string, org = "acme"): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "credentials.json"),
		JSON.stringify({
			token: "tok-secret",
			orgId: org,
			orgName: "Acme",
			workspaceId: "backend",
			apiUrl: "https://api.deeplake.test",
			savedAt: "",
		}),
	);
}

function readCreds(dir: string): { token: string; orgId: string; orgName?: string; workspaceId?: string } {
	return JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
}

let dir: string;
let calls: string[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-scopeswitch-"));
	calls = [];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function daemonWith(opts: { client: DeeplakeAuthClient; mode?: RuntimeConfig["mode"] }): Daemon {
	const daemon = createDaemon({
		config: cfg({ mode: opts.mode ?? "local" }),
		storage: storage as never,
		logger: createRequestLogger({ silent: true }),
	});
	mountScopeSwitchApi(daemon, {
		credentialsDir: dir,
		env: {},
		authClientFactory: () => opts.client,
	});
	return daemon;
}

async function postJson(daemon: Daemon, path: string, body: unknown): Promise<Response> {
	return daemon.app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("IRD-122 POST /api/diagnostics/scope/org-switch (122-AC-2)", () => {
	it("re-mints an org-bound token BEFORE persisting, and saves the new org (no token in the body)", async () => {
		writeCreds(dir, "acme");
		const client = fakeAuthClient({ orgs: [{ id: "acme", name: "Acme" }, { id: "globex", name: "Globex" }], calls });
		const daemon = daemonWith({ client });
		const res = await postJson(daemon, "/api/diagnostics/scope/org-switch", { org: "globex" });
		expect(res.status).toBe(200);
		const ack = (await res.json()) as OrgSwitchAck;
		expect(ack.switched).toBe(true);
		expect(ack.org).toBe("globex");
		expect(ack.reminted).toBe(true);
		// 122-AC-2: re-mint strictly precedes the save (and listOrgs precedes the re-mint).
		expect(calls).toEqual(["listOrgs", "reMint"]);
		// The persisted credential carries the NEW org + the re-minted token; the body carries NO token.
		const creds = readCreds(dir);
		expect(creds.orgId).toBe("globex");
		expect(creds.token).toBe("reminted-token");
		expect(creds.workspaceId).toBe("default"); // workspace resets under the new org.
		expect(JSON.stringify(ack)).not.toMatch(/tok-secret|reminted-token|bearer/i);
	});

	it("a SAME-org switch does NOT re-mint (idempotent success)", async () => {
		writeCreds(dir, "acme");
		const client = fakeAuthClient({ orgs: [{ id: "acme", name: "Acme" }], calls });
		const daemon = daemonWith({ client });
		const res = await postJson(daemon, "/api/diagnostics/scope/org-switch", { org: "acme" });
		const ack = (await res.json()) as OrgSwitchAck;
		expect(ack.switched).toBe(true);
		expect(ack.reminted).toBe(false);
		expect(calls).toEqual(["listOrgs"]); // no reMint.
	});

	it("an unknown org is rejected without a file write", async () => {
		writeCreds(dir, "acme");
		const client = fakeAuthClient({ orgs: [{ id: "acme", name: "Acme" }], calls });
		const daemon = daemonWith({ client });
		const res = await postJson(daemon, "/api/diagnostics/scope/org-switch", { org: "nope" });
		const ack = (await res.json()) as OrgSwitchAck;
		expect(ack.switched).toBe(false);
		expect(ack.error).toBe("unknown_org");
		expect(readCreds(dir).orgId).toBe("acme"); // untouched.
	});

	it("not logged in → a clean ack (never a 500)", async () => {
		const client = fakeAuthClient({ calls });
		const daemon = daemonWith({ client });
		const res = await postJson(daemon, "/api/diagnostics/scope/org-switch", { org: "globex" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as OrgSwitchAck).switched).toBe(false);
	});

	it("is NOT served in team mode (local-mode-only — security F-1)", async () => {
		writeCreds(dir);
		const client = fakeAuthClient({ orgs: [{ id: "acme", name: "Acme" }], calls });
		const daemon = daemonWith({ client, mode: "team" });
		const res = await postJson(daemon, "/api/diagnostics/scope/org-switch", { org: "globex" });
		expect([401, 403, 404]).toContain(res.status);
	});
});

describe("IRD-122 POST /api/diagnostics/scope/workspace-switch", () => {
	it("persists the workspace id WITHOUT a token re-mint", async () => {
		writeCreds(dir, "acme");
		const client = fakeAuthClient({ workspaces: [{ id: "team-x", name: "Team X" }], calls });
		const daemon = daemonWith({ client });
		const res = await postJson(daemon, "/api/diagnostics/scope/workspace-switch", { workspace: "team-x" });
		expect(res.status).toBe(200);
		const ack = (await res.json()) as WorkspaceSwitchAck;
		expect(ack.switched).toBe(true);
		expect(ack.workspace).toBe("team-x");
		expect(calls).not.toContain("reMint"); // no re-mint for a workspace switch.
		const creds = readCreds(dir);
		expect(creds.workspaceId).toBe("team-x");
		expect(creds.token).toBe("tok-secret"); // token unchanged (no re-mint).
	});

	it("resolves a workspace NAME to its id", async () => {
		writeCreds(dir, "acme");
		const client = fakeAuthClient({ workspaces: [{ id: "ws-123", name: "Backend" }], calls });
		const daemon = daemonWith({ client });
		const res = await postJson(daemon, "/api/diagnostics/scope/workspace-switch", { workspace: "Backend" });
		expect(((await res.json()) as WorkspaceSwitchAck).workspace).toBe("ws-123");
	});
});
