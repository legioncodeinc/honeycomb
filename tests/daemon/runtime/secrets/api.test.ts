/**
 * PRD-012a API — the names-only `/api/secrets` surface (a-AC-2 / a-AC-5).
 *
 * Verification posture: mount `mountSecretsApi` onto a minimal Hono app over a real store
 * backed by a temp dir + fake machine key, then drive it with `app.request`. The decisive
 * assertions: GET lists NAMES, and there is NO value-returning route — a probe to
 * `GET /api/secrets/:name` does not exist (404), proving a value can never be read back.
 *
 * a-AC-2 the API lists names only; no value-returning endpoint exists.
 * a-AC-5 no decrypted value is ever returned through the API surface.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeMachineKeyProvider, createFakeVaultProvider } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { mountSecretsApi, SECRETS_GROUP } from "../../../../src/daemon/runtime/secrets/api.js";
import { SecretExecRunner } from "../../../../src/daemon/runtime/secrets/exec.js";
import { SecretsStore } from "../../../../src/daemon/runtime/secrets/store.js";

const SECRET = "sk-OPENAI-do-not-leak";
const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend" };

let base: string;
let app: Hono;

function build(): Hono {
	const store = new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		clock: { now: () => "2026-06-18T00:00:00.000Z" },
	});
	// Mount the group on a bare Hono at the real base path so `app.request("/api/secrets…")`
	// hits the handlers exactly as the daemon's group would route them.
	const root = new Hono();
	const group = new Hono();
	mountSecretsApi(group, { store });
	root.route(SECRETS_GROUP, group);
	return root;
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-secrets-api-"));
	app = build();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("a-AC-2 GET /api/secrets lists NAMES only", () => {
	it("returns the stored names, never their values", async () => {
		await app.request("/api/secrets/openai.key", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: SECRET }),
		});
		const res = await app.request("/api/secrets", { headers: HEADERS });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.names).toEqual(["openai.key"]);
		// The response carries no value, anywhere.
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});

	it("POST stores and echoes only the NAME back (never the value)", async () => {
		const res = await app.request("/api/secrets/openai.key", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: SECRET }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toEqual({ ok: true, name: "openai.key" });
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});
});

describe("a-AC-2 / a-AC-5 there is NO value-returning endpoint", () => {
	it("a probe to GET /api/secrets/:name does not exist (404), never returns a value", async () => {
		await app.request("/api/secrets/openai.key", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: SECRET }),
		});
		// THE security property: a GET on a specific name is not a route → 404 not found.
		const res = await app.request("/api/secrets/openai.key", { headers: HEADERS });
		expect(res.status).toBe(404);
		const text = await res.text();
		// Whatever the 404 body is, it must NOT contain the value.
		expect(text).not.toContain(SECRET);
	});

	it("no API response anywhere in a store→list→delete cycle echoes the value", async () => {
		const post = await app.request("/api/secrets/openai.key", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: SECRET }),
		});
		const list = await app.request("/api/secrets", { headers: HEADERS });
		const probe = await app.request("/api/secrets/openai.key", { headers: HEADERS });
		const del = await app.request("/api/secrets/openai.key", { method: "DELETE", headers: HEADERS });

		for (const r of [post, list, probe, del]) {
			expect(await r.text()).not.toContain(SECRET);
		}
	});
});

describe("DELETE + validation behave", () => {
	it("DELETE removes a secret and a re-list omits it", async () => {
		await app.request("/api/secrets/alpha", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: "v" }),
		});
		const del = await app.request("/api/secrets/alpha", { method: "DELETE", headers: HEADERS });
		expect(del.status).toBe(200);
		const list = await app.request("/api/secrets", { headers: HEADERS });
		expect((await list.json()).names).toEqual([]);
	});

	it("DELETE of an absent secret is a 404", async () => {
		const res = await app.request("/api/secrets/ghost", { method: "DELETE", headers: HEADERS });
		expect(res.status).toBe(404);
	});

	it("a request with no tenancy header is a 400 (fail-closed)", async () => {
		const res = await app.request("/api/secrets");
		expect(res.status).toBe(400);
	});

	it("a path-traversing name is rejected with 400", async () => {
		const res = await app.request("/api/secrets/..%2Fescape", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: "v" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("012b routes are honest 501 stubs WHEN no runner is wired (deferred assembly)", () => {
	it("POST /exec and GET /exec/:jobId are 501 not_implemented", async () => {
		const exec = await app.request("/api/secrets/exec", { method: "POST", headers: HEADERS });
		expect(exec.status).toBe(501);
		const status = await app.request("/api/secrets/exec/job-1", { headers: HEADERS });
		expect(status.status).toBe(501);
	});

	it("vault provider routes are 501 not_implemented", async () => {
		const bw = await app.request("/api/secrets/bitwarden/anything", { headers: HEADERS });
		expect(bw.status).toBe(501);
		const op = await app.request("/api/secrets/1password/anything", { headers: HEADERS });
		expect(op.status).toBe(501);
	});
});

// ── 012b wired exec routes (b-AC-1 / b-AC-3) over the HTTP surface ────────────
const NODE = process.execPath;

/** Build an app with the exec runner wired (real store + real spawn). */
function buildWithExec(): { app: Hono; runner: SecretExecRunner } {
	const store = new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		clock: { now: () => "2026-06-18T00:00:00.000Z" },
	});
	const runner = new SecretExecRunner({ store, vault: createFakeVaultProvider({ "op://ref": SECRET }) });
	const root = new Hono();
	const group = new Hono();
	mountSecretsApi(group, { store, execRunner: runner });
	root.route(SECRETS_GROUP, group);
	return { app: root, runner };
}

describe("b-AC-1 POST /api/secrets/exec → 202 + jobId; b-AC-3 GET status → redacted, scoped", () => {
	it("submits a job (202 + jobId) and the polled status shows REDACTED output, never the value", async () => {
		const { app: execApp, runner } = buildWithExec();
		// Seed the secret the exec will resolve into env.
		await execApp.request("/api/secrets/MY_SECRET", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ value: SECRET }),
		});

		const submit = await execApp.request("/api/secrets/exec", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				command: NODE,
				args: ["-e", "process.stdout.write('out:'+process.env.MY_SECRET)"],
				secretNames: ["MY_SECRET"],
			}),
		});
		expect(submit.status).toBe(202);
		const sBody = await submit.json();
		expect(typeof sBody.jobId).toBe("string");
		expect(JSON.stringify(sBody)).not.toContain(SECRET);

		await runner.waitFor(sBody.jobId);
		const status = await execApp.request(`/api/secrets/exec/${sBody.jobId}`, { headers: HEADERS });
		expect(status.status).toBe(200);
		const body = await status.json();
		expect(body.status).toBe("succeeded");
		expect(body.stdout).toContain("out:");
		// THE security property over HTTP: the value is never in the response body.
		expect(await (await execApp.request(`/api/secrets/exec/${sBody.jobId}`, { headers: HEADERS })).text()).not.toContain(
			SECRET,
		);
	});

	it("a POST /exec with no command is a 400", async () => {
		const { app: execApp } = buildWithExec();
		const res = await execApp.request("/api/secrets/exec", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ args: ["-e", "1"] }),
		});
		expect(res.status).toBe(400);
	});

	it("a status probe for another scope's job is a 404 (cross-scope is not an oracle)", async () => {
		const { app: execApp, runner } = buildWithExec();
		const submit = await execApp.request("/api/secrets/exec", {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ command: NODE, args: ["-e", "1"] }),
		});
		const { jobId } = await submit.json();
		await runner.waitFor(jobId);
		// A different org header → 404, even with a valid jobId.
		const cross = await execApp.request(`/api/secrets/exec/${jobId}`, {
			headers: { "x-honeycomb-org": "evil", "x-honeycomb-workspace": "backend" },
		});
		expect(cross.status).toBe(404);
	});

	it("the vault routes never return a value (resolution is by-reference inside exec)", async () => {
		const { app: execApp } = buildWithExec();
		const bw = await execApp.request("/api/secrets/bitwarden/anything", { headers: HEADERS });
		const op = await execApp.request("/api/secrets/1password/anything", { headers: HEADERS });
		expect(bw.status).toBe(400);
		expect(op.status).toBe(400);
		expect(await bw.text()).not.toContain(SECRET);
		expect(await op.text()).not.toContain(SECRET);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY REGRESSION (PRD-022 cross-WORKSPACE guard): the pentest finding
// "Sources API trusts x-honeycomb-workspace" applies to ALL scope resolvers,
// including the secrets API. When a validated Identity is present, the workspace
// MUST come from `identity.workspace`, NOT from the header.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_CONTEXT_KEY = "honeycombIdentity" as const;
const TOKEN_IDENTITY = { org: "token-org", workspace: "token-ws", agentId: "token-actor", role: "write" };

/** Build the secrets mount stamping a fixed validated Identity (mirrors permission mw). */
function buildAuthedSecrets(identity: Record<string, unknown>): Hono {
	const store = new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		clock: { now: () => "2026-06-18T00:00:00.000Z" },
	});
	const root = new Hono();
	const group = new Hono();
	group.use("*", async (c, next) => {
		c.set(IDENTITY_CONTEXT_KEY, identity);
		await next();
	});
	mountSecretsApi(group, { store });
	root.route(SECRETS_GROUP, group);
	return root;
}

describe("PRD-022 SECURITY: /api/secrets cross-workspace guard (pentest finding mitigation)", () => {
	it("a forged x-honeycomb-workspace is IGNORED when Identity is present — workspace comes from token", async () => {
		const app = buildAuthedSecrets(TOKEN_IDENTITY);
		// Store a secret with a forged workspace header.
		const res = await app.request("/api/secrets/test-key", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "token-org",
				"x-honeycomb-workspace": "victim-workspace", // ← forged workspace
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "secret-value" }),
		});
		expect(res.status).toBe(201);

		// List secrets — the scope resolver should use token-ws, not victim-workspace.
		const listRes = await app.request("/api/secrets", {
			headers: {
				"x-honeycomb-org": "token-org",
				"x-honeycomb-workspace": "token-ws", // ← legitimate workspace
			},
		});
		expect(listRes.status).toBe(200);
		const body = await listRes.json();
		// The secret should be accessible because the scope resolver used token-ws for both POST and GET.
		expect(body.names).toContain("test-key");
	});

	it("authenticated caller cannot access secrets from a different workspace by forging the header", async () => {
		// Create two apps with different workspaces.
		const appA = buildAuthedSecrets({ org: "shared-org", workspace: "workspace-a", agentId: "actor-a", role: "write" });
		const appB = buildAuthedSecrets({ org: "shared-org", workspace: "workspace-b", agentId: "actor-b", role: "write" });

		// Actor A stores a secret in workspace-a.
		await appA.request("/api/secrets/secret-a", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "shared-org",
				"x-honeycomb-workspace": "workspace-a",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "value-a" }),
		});

		// Actor B tries to list secrets by forging workspace-a header.
		const res = await appB.request("/api/secrets", {
			headers: {
				"x-honeycomb-org": "shared-org",
				"x-honeycomb-workspace": "workspace-a", // ← forged to access workspace-a
			},
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Actor B should NOT see secret-a (which is in workspace-a).
		// The scope resolver uses workspace-b from the token, not the forged header.
		expect(body.names).not.toContain("secret-a");
	});

	it("DELETE with forged workspace → deletes from token's workspace only", async () => {
		const app = buildAuthedSecrets(TOKEN_IDENTITY);
		// Store a secret in the token's workspace.
		await app.request("/api/secrets/test-key", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "token-org",
				"x-honeycomb-workspace": "token-ws",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "secret-value" }),
		});

		// DELETE with a forged workspace header.
		const res = await app.request("/api/secrets/test-key", {
			method: "DELETE",
			headers: {
				"x-honeycomb-org": "token-org",
				"x-honeycomb-workspace": "victim-workspace", // ← forged
			},
		});
		// The DELETE should succeed because the scope resolver uses token-ws.
		expect(res.status).toBe(200);

		// Verify the secret is gone from token-ws.
		const listRes = await app.request("/api/secrets", {
			headers: {
				"x-honeycomb-org": "token-org",
				"x-honeycomb-workspace": "token-ws",
			},
		});
		const body = await listRes.json();
		expect(body.names).not.toContain("test-key");
	});

	it("local mode (no Identity) still trusts the workspace header for backward compatibility", async () => {
		// Build an app WITHOUT stamping an Identity (local mode).
		const store = new SecretsStore({
			baseDir: base,
			machineKey: createFakeMachineKeyProvider("machine-A"),
			clock: { now: () => "2026-06-18T00:00:00.000Z" },
		});
		const root = new Hono();
		const group = new Hono();
		// NO Identity stamping middleware (local mode).
		mountSecretsApi(group, { store });
		root.route(SECRETS_GROUP, group);

		// POST with a workspace header (should be honored in local mode).
		const res = await root.request("/api/secrets/local-key", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "local-org",
				"x-honeycomb-workspace": "local-ws",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "local-value" }),
		});
		expect(res.status).toBe(201);

		// GET should also honor the workspace header in local mode.
		const listRes = await root.request("/api/secrets", {
			headers: {
				"x-honeycomb-org": "local-org",
				"x-honeycomb-workspace": "local-ws",
			},
		});
		expect(listRes.status).toBe(200);
		const body = await listRes.json();
		expect(body.names).toContain("local-key");
	});

	it("a forged x-honeycomb-org that disagrees with the token's org fails closed (400)", async () => {
		const app = buildAuthedSecrets(TOKEN_IDENTITY);
		const res = await app.request("/api/secrets", {
			headers: {
				"x-honeycomb-org": "victim-org", // ← forged org
				"x-honeycomb-workspace": "token-ws",
			},
		});
		expect(res.status).toBe(400);
	});
});
