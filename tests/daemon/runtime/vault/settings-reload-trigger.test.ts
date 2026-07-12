/**
 * SP-1 / ISS-001 — the `/api/settings` write path TRIGGERS the pipeline live-reload seam.
 *
 * Verification posture: mount `mountSettingsGroup` over a REAL VaultStore (temp dir + fake
 * machine key) with a RECORDING PipelineReloadSeam, then drive writes over HTTP. Proves:
 *   - every WATCHED key (activeProvider / activeModel / memory.enabled / portkey.*) fires the
 *     seam exactly once per persisted write, post-persist;
 *   - an UNWATCHED key (dashboard.*, recallMode, pollinating.enabled, embeddings.enabled)
 *     never fires it (unrelated settings churn costs no inference-client rebuild);
 *   - a REJECTED write (unknown provider, unknown key, bad body) never fires it — the trigger
 *     is post-persist only;
 *   - a seam-less mount (deps.reload absent) writes exactly as before (no throw, no trigger).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PipelineReloadSeam } from "../../../../src/daemon/runtime/pipeline/reload.js";
import { createFakeMachineKeyProvider } from "../../../../src/daemon/runtime/secrets/contracts.js";
import {
	isPipelineWatchedSettingKey,
	mountSettingsGroup,
	PIPELINE_WATCHED_SETTING_KEYS,
	SETTINGS_GROUP,
} from "../../../../src/daemon/runtime/vault/api.js";
import { createVaultRegistry } from "../../../../src/daemon/runtime/vault/registry.js";
import { VaultStore } from "../../../../src/daemon/runtime/vault/store.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend" };
const JSON_HEADERS = { ...HEADERS, "content-type": "application/json" };

let base: string;
let reasons: string[];
let app: Hono;

/** A recording seam: every `requestReload` reason lands in `reasons`, in order. */
function recordingSeam(): PipelineReloadSeam {
	return {
		requestReload(reason: string): void {
			reasons.push(reason);
		},
	};
}

function build(withSeam = true): Hono {
	const store = new VaultStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		registry: createVaultRegistry(),
		clock: { now: () => "2026-07-12T00:00:00.000Z" },
	});
	const root = new Hono();
	const group = new Hono();
	mountSettingsGroup(group, { store, ...(withSeam ? { reload: recordingSeam() } : {}) });
	root.route(SETTINGS_GROUP, group);
	return root;
}

async function post(key: string, value: unknown): Promise<number> {
	const res = await app.request(`/api/settings/${key}`, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ value }),
	});
	return res.status;
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-settings-reload-"));
	reasons = [];
	app = build();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("watched keys fire the seam exactly once per persisted write (post-persist)", () => {
	it("activeProvider + activeModel + memory.enabled + portkey.* each fire once", async () => {
		expect(await post("activeProvider", "anthropic")).toBe(201);
		expect(reasons).toEqual(["setting:activeProvider"]);

		expect(await post("activeModel", "claude-sonnet-4-6")).toBe(201);
		expect(reasons).toEqual(["setting:activeProvider", "setting:activeModel"]);

		expect(await post("memory.enabled", true)).toBe(201);
		expect(await post("portkey.fallbackToProvider", false)).toBe(201);
		expect(await post("portkey.config", "pk-config-id")).toBe(201); // valid while disabled
		expect(await post("portkey.enabled", true)).toBe(201); // model already set above
		expect(reasons).toEqual([
			"setting:activeProvider",
			"setting:activeModel",
			"setting:memory.enabled",
			"setting:portkey.fallbackToProvider",
			"setting:portkey.config",
			"setting:portkey.enabled",
		]);
	});

	it("the watched-key predicate matches the exported list and nothing else", () => {
		for (const key of PIPELINE_WATCHED_SETTING_KEYS) {
			expect(isPipelineWatchedSettingKey(key)).toBe(true);
		}
		for (const key of ["dashboard.theme", "recallMode", "pollinating.enabled", "embeddings.enabled", "portkey", ""]) {
			expect(isPipelineWatchedSettingKey(key)).toBe(false);
		}
	});
});

describe("unwatched keys NEVER fire the seam (no rebuild on unrelated churn)", () => {
	it("dashboard.* prefs, recallMode, pollinating/embeddings toggles write fine, zero triggers", async () => {
		expect(await post("dashboard.theme", "dark")).toBe(201);
		expect(await post("recallMode", "hybrid")).toBe(201);
		expect(await post("pollinating.enabled", true)).toBe(201);
		expect(await post("embeddings.enabled", false)).toBe(201);
		expect(reasons).toEqual([]);
	});
});

describe("a rejected write never fires the seam (the trigger is post-persist only)", () => {
	it("unknown provider (400), unknown key (400), and a bad body (400) all stay silent", async () => {
		expect(await post("activeProvider", "not-a-provider")).toBe(400);
		expect(await post("definitely-not-a-key", "x")).toBe(400);
		const res = await app.request("/api/settings/activeProvider", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: { nested: "object" } }), // non-scalar → 400
		});
		expect(res.status).toBe(400);
		expect(reasons).toEqual([]);
	});

	it("clearing activeModel under an enabled gateway stays 400 AND silent (ISS-005 kept)", async () => {
		expect(await post("activeProvider", "anthropic")).toBe(201);
		expect(await post("activeModel", "claude-sonnet-4-6")).toBe(201);
		expect(await post("portkey.config", "pk-config-id")).toBe(201);
		expect(await post("portkey.enabled", true)).toBe(201);
		reasons.length = 0;
		expect(await post("activeModel", "   ")).toBe(400); // the no_model guard from #300
		expect(reasons).toEqual([]);
	});
});

describe("a seam-less mount is byte-identical to the pre-SP-1 write path", () => {
	it("writes still 201 with no reload wired", async () => {
		app = build(false);
		expect(await post("activeProvider", "anthropic")).toBe(201);
		expect(reasons).toEqual([]);
	});
});
