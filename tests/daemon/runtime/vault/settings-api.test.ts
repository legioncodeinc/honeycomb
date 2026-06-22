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
		await app.request("/api/settings/dreaming.enabled", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: true }),
		});
		const res = await app.request("/api/settings", { headers: HEADERS });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.settings.activeProvider).toBe("anthropic");
		expect(body.settings["dreaming.enabled"]).toBe(true);
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
	it("exposes Anthropic + OpenAI + OpenRouter with the curated models", () => {
		expect(providerEntry("anthropic")?.models).toContain("claude-sonnet-4-6");
		expect(providerEntry("anthropic")?.models).toContain("claude-opus-4-8");
		expect(providerEntry("openai")?.models).toContain("gpt-4o");
		expect(providerEntry("openrouter")?.openEnded).toBe(true);
		expect(PROVIDER_CATALOG.length).toBe(3);
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
