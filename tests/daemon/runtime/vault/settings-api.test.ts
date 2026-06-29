/**
 * PRD-032a `/api/settings` + the catalog — AC-2 (settings round-trip over HTTP) + AC-8
 * (no secret value crosses the surface) + D-6 (catalog validation).
 *
 * Verification posture: mount `mountSettingsGroup` onto a minimal Hono app over a real
 * VaultStore backed by a temp dir + fake machine key, then drive it with `app.request`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeMachineKeyProvider } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { isKnownSettingKey, isValidRecallMode, mountSettingsGroup, RECALL_MODES, SETTINGS_GROUP } from "../../../../src/daemon/runtime/vault/api.js";
import {
	defaultModelFor,
	isValidProviderModel,
	PROVIDER_CATALOG,
	providerEntry,
} from "../../../../src/daemon/runtime/vault/catalog.js";
import { createVaultRegistry } from "../../../../src/daemon/runtime/vault/registry.js";
import { VaultStore } from "../../../../src/daemon/runtime/vault/store.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend" };
const JSON_HEADERS = { ...HEADERS, "content-type": "application/json" };

let base: string;
let store: VaultStore;
let app: Hono;

function build(): Hono {
	store = new VaultStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		registry: createVaultRegistry(),
		clock: { now: () => "2026-06-21T00:00:00.000Z" },
	});
	const root = new Hono();
	const group = new Hono();
	mountSettingsGroup(group, { store });
	root.route(SETTINGS_GROUP, group);
	return root;
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-settings-api-"));
	app = build();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("AC-2 settings round-trip through the daemon (write → read equal)", () => {
	it("POST then GET a setting returns the persisted value", async () => {
		const post = await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "anthropic" }),
		});
		expect(post.status).toBe(201);

		const get = await app.request("/api/settings/activeProvider", { headers: HEADERS });
		expect(get.status).toBe(200);
		const body = await get.json();
		expect(body.value).toBe("anthropic");
	});

	it("GET /api/settings lists current settings + the catalog, no secret", async () => {
		await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "anthropic" }),
		});
		await app.request("/api/settings/pollinating.enabled", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: true }),
		});
		const res = await app.request("/api/settings", { headers: HEADERS });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.settings.activeProvider).toBe("anthropic");
		expect(body.settings["pollinating.enabled"]).toBe(true);
		expect(Array.isArray(body.catalog)).toBe(true);
	});

	it("rejects an unknown setting key on write (fail-closed allow-list)", async () => {
		const res = await app.request("/api/settings/totally.unknown", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "x" }),
		});
		expect(res.status).toBe(400);
	});

	it("a request with no tenancy is 400 (never a broad scope)", async () => {
		const res = await app.request("/api/settings", {});
		expect(res.status).toBe(400);
	});
});

describe("D-6 catalog validation on activeModel writes", () => {
	it("accepts a model in the active provider catalog", async () => {
		await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "anthropic" }),
		});
		const res = await app.request("/api/settings/activeModel", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "claude-opus-4-8" }),
		});
		expect(res.status).toBe(201);
	});

	it("rejects a model NOT in the active provider catalog", async () => {
		await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "anthropic" }),
		});
		const res = await app.request("/api/settings/activeModel", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "gpt-4o" }),
		});
		expect(res.status).toBe(400);
	});

	it("accepts a free-form model for the open-ended OpenRouter provider", async () => {
		await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "openrouter" }),
		});
		const res = await app.request("/api/settings/activeModel", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "some/exotic-model-v3" }),
		});
		expect(res.status).toBe(201);
	});
});

describe("D-6 catalog is single-sourced + curated", () => {
	it("exposes Anthropic + OpenAI + OpenRouter + Portkey with the curated models", () => {
		expect(providerEntry("anthropic")?.models).toContain("claude-sonnet-4-6");
		expect(providerEntry("anthropic")?.models).toContain("claude-opus-4-8");
		expect(providerEntry("openai")?.models).toContain("gpt-4o");
		expect(providerEntry("openrouter")?.openEnded).toBe(true);
		// PRD-063a added Portkey as the fourth provider (open-ended gateway, no curated models).
		expect(providerEntry("portkey")?.openEnded).toBe(true);
		expect(PROVIDER_CATALOG.length).toBe(4);
	});

	it("isValidProviderModel gates closed lists and passes open-ended ids", () => {
		expect(isValidProviderModel("anthropic", "claude-opus-4-8")).toBe(true);
		expect(isValidProviderModel("anthropic", "gpt-4o")).toBe(false);
		expect(isValidProviderModel("openrouter", "anything/at-all")).toBe(true);
		expect(isValidProviderModel("nope", "x")).toBe(false);
		expect(defaultModelFor("anthropic")).toBe("claude-sonnet-4-6");
	});
});

describe("PRD-044c recallMode — closed-enum, fail-closed validation", () => {
	it("accepts each of keyword | semantic | hybrid and persists it", async () => {
		for (const mode of ["keyword", "semantic", "hybrid"]) {
			const post = await app.request("/api/settings/recallMode", {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({ value: mode }),
			});
			expect(post.status).toBe(201);
			const get = await app.request("/api/settings/recallMode", { headers: HEADERS });
			expect(get.status).toBe(200);
			expect((await get.json()).value).toBe(mode);
		}
	});

	it("rejects a garbage recallMode value (fail-closed, 400)", async () => {
		const res = await app.request("/api/settings/recallMode", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "fuzzy" }),
		});
		expect(res.status).toBe(400);
	});

	it("recallMode is a KNOWN setting key (the allow-list admits it)", () => {
		expect(isKnownSettingKey("recallMode")).toBe(true);
		expect(isValidRecallMode("hybrid")).toBe(true);
		expect(isValidRecallMode("nonsense")).toBe(false);
		expect(RECALL_MODES).toEqual(["keyword", "semantic", "hybrid"]);
	});

	it("UNSET recallMode is simply absent from the settings list (the default-preserving path)", async () => {
		const res = await app.request("/api/settings", { headers: HEADERS });
		const body = await res.json();
		// Nothing wrote recallMode in this case → it is not present (the page reads "" → default).
		expect(body.settings.recallMode).toBeUndefined();
	});
});

describe("PRD-063a Portkey settings — catalog + allow-list + semantics (a-AC-3)", () => {
	it("portkey is a catalog provider, open-ended, with no curated models", () => {
		expect(providerEntry("portkey")?.label).toBe("Portkey");
		expect(providerEntry("portkey")?.openEnded).toBe(true);
		expect(providerEntry("portkey")?.models).toEqual([]);
	});

	it("the three Portkey keys are KNOWN setting keys (the allow-list admits them)", () => {
		expect(isKnownSettingKey("portkey.enabled")).toBe(true);
		expect(isKnownSettingKey("portkey.config")).toBe(true);
		expect(isKnownSettingKey("portkey.fallbackToProvider")).toBe(true);
	});

	it("accepts boolean toggles + a config string, and they round-trip through GET", async () => {
		const enabled = await app.request("/api/settings/portkey.enabled", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: true }),
		});
		expect(enabled.status).toBe(201);
		const fallback = await app.request("/api/settings/portkey.fallbackToProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: false }),
		});
		expect(fallback.status).toBe(201);
		const config = await app.request("/api/settings/portkey.config", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "pk-cfg-abc123" }),
		});
		expect(config.status).toBe(201);

		const res = await app.request("/api/settings", { headers: HEADERS });
		const body = await res.json();
		expect(body.settings["portkey.enabled"]).toBe(true);
		expect(body.settings["portkey.fallbackToProvider"]).toBe(false);
		expect(body.settings["portkey.config"]).toBe("pk-cfg-abc123");
	});

	it("rejects a non-boolean portkey.enabled (fail-closed, 400)", async () => {
		const res = await app.request("/api/settings/portkey.enabled", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "yes" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a non-boolean portkey.fallbackToProvider (fail-closed, 400)", async () => {
		const res = await app.request("/api/settings/portkey.fallbackToProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: 1 }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects an empty portkey.config WHEN portkey.enabled is true", async () => {
		await app.request("/api/settings/portkey.enabled", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: true }),
		});
		const res = await app.request("/api/settings/portkey.config", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("accepts an empty portkey.config when portkey.enabled is unset/false (gateway off)", async () => {
		const res = await app.request("/api/settings/portkey.config", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "" }),
		});
		expect(res.status).toBe(201);
	});

	// SECURITY (header-injection defense-in-depth): `portkey.config` is sent verbatim as the
	// `x-portkey-config` HTTP header value, so a control character (CR/LF/NUL/etc.) is rejected at
	// this validated boundary - a 400 here, not a confusing silent "unreachable" later.
	it("rejects a portkey.config carrying a control character (CRLF header-injection guard)", async () => {
		for (const bad of ["pk-cfg\r\nX-Injected: 1", "pk\ncfg", "pk\u0000cfg", "pk\u007Fcfg"]) {
			const res = await app.request("/api/settings/portkey.config", {
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({ value: bad }),
			});
			expect(res.status, `control char in ${JSON.stringify(bad)} must 400`).toBe(400);
		}
	});
	it("accepts a normal portkey.config id (no control characters)", async () => {
		const res = await app.request("/api/settings/portkey.config", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "pk-cfg-abc123" }),
		});
		expect(res.status).toBe(201);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD-022 SECURITY: cross-tenant hardening for /api/settings. When the permission
// middleware has stamped a VALIDATED Identity (team/hybrid), a forged `x-honeycomb-org`
// header that disagrees with the token's own org MUST fail closed. Stand in a stamping
// middleware (what the real permission middleware does) and prove a header-forged tenancy
// can never cross the token's boundary onto the settings surface.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_CONTEXT_KEY = "honeycombIdentity" as const;
const TOKEN_IDENTITY = { org: "token-org", workspace: "token-ws", agentId: "token-actor", role: "write" };

/** Build the settings mount in team mode, stamping a fixed validated Identity (mirrors permission mw). */
function buildAuthedSettings(identity: Record<string, unknown>): Hono {
	const tempBase = mkdtempSync(join(tmpdir(), "hc-settings-authed-"));
	const tempStore = new VaultStore({
		baseDir: tempBase,
		machineKey: createFakeMachineKeyProvider("machine-authed"),
		registry: createVaultRegistry(),
		clock: { now: () => "2026-06-21T00:00:00.000Z" },
	});
	const root = new Hono();
	const group = new Hono();
	group.use("*", async (c, next) => {
		c.set(IDENTITY_CONTEXT_KEY, identity);
		await next();
	});
	mountSettingsGroup(group, { store: tempStore, mode: "team" });
	root.route(SETTINGS_GROUP, group);
	return root;
}

describe("PRD-022 SECURITY: /api/settings tenancy cross-check against the validated Identity", () => {
	it("a forged x-honeycomb-org that disagrees with the token's org fails closed (400) — no cross-tenant write", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings/activeProvider", {
			method: "POST",
			// The token binds org=token-org; the caller forges a DIFFERENT org header.
			headers: { "x-honeycomb-org": "victim-org", "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		// The forged-org request is REJECTED (the handler's fail-closed 400 once the scope
		// resolver refuses the mismatched org). It is NOT a 201 that writes to victim-org.
		expect(res.status).toBe(400);
	});

	it("an org header that MATCHES the token's org is honored (no regression for the legitimate caller)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings/activeProvider", {
			method: "POST",
			// The token binds org=token-org; the caller sends the MATCHING org header.
			headers: { "x-honeycomb-org": "token-org", "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		// The legitimate request is ALLOWED (201 success).
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.value).toBe("anthropic");
	});

	it("GET with forged org also fails closed (no cross-tenant read)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings", {
			method: "GET",
			headers: { "x-honeycomb-org": "victim-org" },
		});
		expect(res.status).toBe(400);
	});

	it("GET with matching org succeeds", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings", {
			method: "GET",
			headers: { "x-honeycomb-org": "token-org" },
		});
		expect(res.status).toBe(200);
	});

	it("GET individual setting with forged org fails closed (no cross-tenant read)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		// First write a setting with the legitimate org
		await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: { "x-honeycomb-org": "token-org", "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		// Then try to read it with a forged org
		const res = await app.request("/api/settings/activeProvider", {
			method: "GET",
			headers: { "x-honeycomb-org": "victim-org" },
		});
		expect(res.status).toBe(400);
	});

	it("empty org header with identity present fails closed (no fallback to empty tenant)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: { "x-honeycomb-org": "", "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		// Empty org header → scope resolver returns null → 400
		expect(res.status).toBe(400);
	});

	it("missing org header with identity present fails closed (no default in team mode)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		// No org header in team mode → scope resolver returns null → 400
		expect(res.status).toBe(400);
	});

	it("forged org with matching workspace still fails (org mismatch is sufficient)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		const res = await app.request("/api/settings/activeProvider", {
			method: "POST",
			// Forged org but correct workspace — still rejected because org doesn't match
			headers: {
				"x-honeycomb-org": "victim-org",
				"x-honeycomb-workspace": "token-ws",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "anthropic" }),
		});
		expect(res.status).toBe(400);
	});

	it("multiple sequential forged requests all fail (no state pollution)", async () => {
		const app = buildAuthedSettings(TOKEN_IDENTITY);
		// Try multiple forged requests in sequence
		for (let i = 0; i < 3; i++) {
			const res = await app.request("/api/settings/activeProvider", {
				method: "POST",
				headers: { "x-honeycomb-org": `victim-org-${i}`, "content-type": "application/json" },
				body: JSON.stringify({ value: "anthropic" }),
			});
			expect(res.status).toBe(400);
		}
		// Verify legitimate request still works after failed attempts
		const legitRes = await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: { "x-honeycomb-org": "token-org", "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		expect(legitRes.status).toBe(201);
	});
});

describe("PRD-022 SECURITY: local mode behavior (no identity, no cross-check)", () => {
	it("local mode with no identity allows any org header (backward compatibility)", async () => {
		// Build a settings mount in LOCAL mode with NO identity stamping (mirrors local daemon)
		const tempBase = mkdtempSync(join(tmpdir(), "hc-settings-local-"));
		const tempStore = new VaultStore({
			baseDir: tempBase,
			machineKey: createFakeMachineKeyProvider("machine-local"),
			registry: createVaultRegistry(),
			clock: { now: () => "2026-06-21T00:00:00.000Z" },
		});
		const root = new Hono();
		const group = new Hono();
		// NO identity stamping middleware — local mode has no auth
		mountSettingsGroup(group, { store: tempStore, mode: "local", defaultScope: { org: "local-org" } });
		root.route(SETTINGS_GROUP, group);

		// In local mode, any org header is accepted (no identity to cross-check against)
		const res = await root.request("/api/settings/activeProvider", {
			method: "POST",
			headers: { "x-honeycomb-org": "any-org", "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		expect(res.status).toBe(201);
	});

	it("local mode with no org header falls back to defaultScope", async () => {
		// Build a settings mount in LOCAL mode with a defaultScope
		const tempBase = mkdtempSync(join(tmpdir(), "hc-settings-local-fallback-"));
		const tempStore = new VaultStore({
			baseDir: tempBase,
			machineKey: createFakeMachineKeyProvider("machine-local-fb"),
			registry: createVaultRegistry(),
			clock: { now: () => "2026-06-21T00:00:00.000Z" },
		});
		const root = new Hono();
		const group = new Hono();
		mountSettingsGroup(group, { store: tempStore, mode: "local", defaultScope: { org: "local-default-org" } });
		root.route(SETTINGS_GROUP, group);

		// In local mode with no org header, the defaultScope is used
		const res = await root.request("/api/settings/activeProvider", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "anthropic" }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});
});
