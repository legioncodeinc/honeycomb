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
 *
 * PRD-022 cross-tenant hardening: the scope resolver MUST reject a forged `x-honeycomb-org`
 * header that disagrees with the validated Identity's own org, preventing an authenticated
 * caller for org A from writing secrets under org B's namespace.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeMachineKeyProvider, createFakeVaultProvider } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { mountSecretsApi, SECRETS_GROUP } from "../../../../src/daemon/runtime/secrets/api.js";
import { SecretExecRunner } from "../../../../src/daemon/runtime/secrets/exec.js";
import { SecretsStore } from "../../../../src/daemon/runtime/secrets/store.js";
import { IDENTITY_CONTEXT_KEY } from "../../../../src/daemon/runtime/middleware/permission.js";
import type { Identity } from "../../../../src/daemon/runtime/auth/contracts.js";

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

/**
 * Build an app with a validated Identity stamped onto the context (mirrors what the
 * permission middleware does in team/hybrid mode). This lets us test the cross-tenant
 * hardening: the scope resolver MUST reject a forged org header that disagrees with
 * the Identity's own org.
 */
function buildWithIdentity(identity: Identity): Hono {
	const store = new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		clock: { now: () => "2026-06-18T00:00:00.000Z" },
	});
	const root = new Hono();
	const group = new Hono();
	// Stamp the validated Identity onto the context (what permission middleware does).
	group.use("*", async (c, next) => {
		c.set(IDENTITY_CONTEXT_KEY, identity);
		await next();
	});
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

// ── PRD-022 cross-tenant hardening (prevents forged org header writes) ────────
describe("PRD-022 cross-tenant hardening: forged x-honeycomb-org is rejected", () => {
	it("an authenticated caller for org A cannot write secrets under org B by forging the header", async () => {
		// The validated Identity says the caller is authenticated for org-a.
		const identity: Identity = {
			org: "org-a",
			workspace: "ws-a",
			agentId: "default",
			role: "member",
		};
		const authedApp = buildWithIdentity(identity);

		// The attacker tries to write a secret to org-b by forging the x-honeycomb-org header.
		const res = await authedApp.request("/api/secrets/evil-secret", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "org-b", // FORGED: disagrees with identity.org
				"x-honeycomb-workspace": "ws-b",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "attacker-controlled-value" }),
		});

		// THE SECURITY PROPERTY: the request is rejected (400 bad tenancy) because the
		// header org disagrees with the validated Identity's org. The secret is NOT written
		// under org-b's namespace.
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");

		// Verify the secret was NOT written to org-b's scope directory (org-b__ws-b).
		const orgBScopeDir = join(base, ".secrets", "org-b__ws-b");
		expect(existsSync(orgBScopeDir)).toBe(false);
	});

	it("a matching org header (identity.org === header org) allows the write", async () => {
		const identity: Identity = {
			org: "org-a",
			workspace: "ws-a",
			agentId: "default",
			role: "member",
		};
		const authedApp = buildWithIdentity(identity);

		// The header org MATCHES the validated Identity's org → allowed.
		const res = await authedApp.request("/api/secrets/legit-secret", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "org-a", // MATCHES identity.org
				"x-honeycomb-workspace": "ws-a",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "legitimate-value" }),
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.name).toBe("legit-secret");

		// Verify the secret WAS written to the correct scope directory (org-a__ws-a).
		const scopeDir = join(base, ".secrets", "org-a__ws-a");
		expect(existsSync(scopeDir)).toBe(true);
		const files = readdirSync(scopeDir, { recursive: true });
		expect(files.some((f) => String(f).includes("legit-secret"))).toBe(true);
	});

	it("GET /api/secrets with a forged org header is rejected (list isolation)", async () => {
		const identity: Identity = {
			org: "org-a",
			workspace: "ws-a",
			agentId: "default",
			role: "member",
		};
		const authedApp = buildWithIdentity(identity);

		// First, write a secret to org-a (the caller's own org).
		await authedApp.request("/api/secrets/org-a-secret", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "org-a",
				"x-honeycomb-workspace": "ws-a",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "org-a-value" }),
		});

		// Now try to list secrets for org-b by forging the header.
		const listRes = await authedApp.request("/api/secrets", {
			headers: {
				"x-honeycomb-org": "org-b", // FORGED
				"x-honeycomb-workspace": "ws-b",
			},
		});

		// THE SECURITY PROPERTY: the list request is rejected (400) because the header
		// org disagrees with the validated Identity's org. The caller cannot enumerate
		// another tenant's secret names.
		expect(listRes.status).toBe(400);
		const body = await listRes.json();
		expect(body.error).toBe("bad_request");
	});

	it("DELETE with a forged org header is rejected (cannot delete another tenant's secrets)", async () => {
		const identity: Identity = {
			org: "org-a",
			workspace: "ws-a",
			agentId: "default",
			role: "member",
		};
		const authedApp = buildWithIdentity(identity);

		// Write a secret to org-a.
		await authedApp.request("/api/secrets/protected-secret", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "org-a",
				"x-honeycomb-workspace": "ws-a",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "protected-value" }),
		});

		// Try to delete a secret from org-b by forging the header.
		const delRes = await authedApp.request("/api/secrets/protected-secret", {
			method: "DELETE",
			headers: {
				"x-honeycomb-org": "org-b", // FORGED
				"x-honeycomb-workspace": "ws-b",
			},
		});

		// THE SECURITY PROPERTY: the delete request is rejected (400).
		expect(delRes.status).toBe(400);
		const body = await delRes.json();
		expect(body.error).toBe("bad_request");

		// Verify the secret still exists in the correct scope directory (org-a__ws-a).
		const scopeDir = join(base, ".secrets", "org-a__ws-a");
		expect(existsSync(scopeDir)).toBe(true);
		const files = readdirSync(scopeDir, { recursive: true });
		expect(files.some((f) => String(f).includes("protected-secret"))).toBe(true);
	});

	it("local mode (no Identity stamped) still allows header-based scope (backward compat)", async () => {
		// In local mode, no Identity is stamped, so the header-based scope is trusted.
		// This test uses the original build() which does NOT stamp an Identity.
		const localApp = build();

		const res = await localApp.request("/api/secrets/local-secret", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "local-org",
				"x-honeycomb-workspace": "local-ws",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "local-value" }),
		});

		// In local mode (no Identity), the header org is trusted → write succeeds.
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	it("an admin role does NOT bypass the org check (org boundary is absolute)", async () => {
		// Even an admin for org-a cannot write to org-b by forging the header.
		const identity: Identity = {
			org: "org-a",
			workspace: "ws-a",
			agentId: "default",
			role: "admin", // ADMIN role
		};
		const authedApp = buildWithIdentity(identity);

		const res = await authedApp.request("/api/secrets/admin-evil", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "org-b", // FORGED
				"x-honeycomb-workspace": "ws-b",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "admin-attacker-value" }),
		});

		// THE SECURITY PROPERTY: even an admin cannot cross the org boundary.
		// The org check is absolute and happens before any role-based logic.
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");

		// Verify the secret was NOT written to org-b's scope directory (org-b__ws-b).
		const orgBScopeDir = join(base, ".secrets", "org-b__ws-b");
		expect(existsSync(orgBScopeDir)).toBe(false);
	});

	it("workspace mismatch is allowed (only org is cross-checked against Identity)", async () => {
		// The cross-tenant guard checks ONLY the org, not the workspace.
		// A caller for org-a can target any workspace within org-a.
		const identity: Identity = {
			org: "org-a",
			workspace: "ws-a",
			agentId: "default",
			role: "member",
		};
		const authedApp = buildWithIdentity(identity);

		const res = await authedApp.request("/api/secrets/cross-ws-secret", {
			method: "POST",
			headers: {
				"x-honeycomb-org": "org-a", // MATCHES identity.org
				"x-honeycomb-workspace": "ws-different", // Different workspace, but same org
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "cross-ws-value" }),
		});

		// The write succeeds because the org matches (workspace is not cross-checked).
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});
});
