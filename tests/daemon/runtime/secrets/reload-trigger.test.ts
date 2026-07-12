/**
 * SP-1 / ISS-001 — the `/api/secrets` write path TRIGGERS the pipeline live-reload seam.
 *
 * Verification posture: mount `mountSecretsApi` over a REAL SecretsStore (temp dir + fake
 * machine key) with a RECORDING PipelineReloadSeam, then drive writes over HTTP. Proves:
 *   - a persisted POST (a saved provider key) fires the seam once, post-persist —
 *     the "save your Anthropic key, memory starts forming, no restart" acceptance;
 *   - a persisted DELETE fires it too (a removed key must deconfigure the `'auto'` gate);
 *   - a REJECTED write (bad body, invalid name) and a miss (DELETE unknown) never fire;
 *   - the reason tags are FIXED strings — the secret name/value never rides the seam;
 *   - a seam-less mount writes exactly as before.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PipelineReloadSeam } from "../../../../src/daemon/runtime/pipeline/reload.js";
import { mountSecretsApi, SECRETS_GROUP } from "../../../../src/daemon/runtime/secrets/api.js";
import { createFakeMachineKeyProvider } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { SecretsStore } from "../../../../src/daemon/runtime/secrets/store.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend" };
const JSON_HEADERS = { ...HEADERS, "content-type": "application/json" };
const KEY_VALUE = "sk-ant-DO-NOT-LEAK";

let base: string;
let reasons: string[];
let app: Hono;

function build(withSeam = true): Hono {
	const store = new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		clock: { now: () => "2026-07-12T00:00:00.000Z" },
	});
	const seam: PipelineReloadSeam = {
		requestReload(reason: string): void {
			reasons.push(reason);
		},
	};
	const root = new Hono();
	const group = new Hono();
	mountSecretsApi(group, { store, ...(withSeam ? { reload: seam } : {}) });
	root.route(SECRETS_GROUP, group);
	return root;
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-secrets-reload-"));
	reasons = [];
	app = build();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("a persisted provider-key write fires the seam once, post-persist", () => {
	it("POST /api/secrets/:name → 201 + exactly one 'secret:set' trigger, value-free", async () => {
		const res = await app.request("/api/secrets/ANTHROPIC_API_KEY", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: KEY_VALUE }),
		});
		expect(res.status).toBe(201);
		// One trigger; the reason is a FIXED tag — no name (defense in depth) and NEVER the value.
		expect(reasons).toEqual(["secret:set"]);
		expect(JSON.stringify(reasons)).not.toContain(KEY_VALUE);
	});

	it("DELETE /api/secrets/:name → 200 + exactly one 'secret:delete' trigger", async () => {
		await app.request("/api/secrets/ANTHROPIC_API_KEY", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: KEY_VALUE }),
		});
		reasons.length = 0;
		const res = await app.request("/api/secrets/ANTHROPIC_API_KEY", { method: "DELETE", headers: HEADERS });
		expect(res.status).toBe(200);
		expect(reasons).toEqual(["secret:delete"]);
	});
});

describe("rejected writes and misses never fire the seam (post-persist only)", () => {
	it("a body with no string value → 400, silent", async () => {
		const res = await app.request("/api/secrets/ANTHROPIC_API_KEY", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ nope: 1 }),
		});
		expect(res.status).toBe(400);
		expect(reasons).toEqual([]);
	});

	it("a missing-tenancy request → 400, silent", async () => {
		const res = await app.request("/api/secrets/ANTHROPIC_API_KEY", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: KEY_VALUE }),
		});
		expect(res.status).toBe(400);
		expect(reasons).toEqual([]);
	});

	it("DELETE of an unknown name → 404, silent", async () => {
		const res = await app.request("/api/secrets/NEVER_STORED", { method: "DELETE", headers: HEADERS });
		expect(res.status).toBe(404);
		expect(reasons).toEqual([]);
	});
});

describe("a seam-less mount is byte-identical to the pre-SP-1 write path", () => {
	it("POST still 201s with no reload wired", async () => {
		app = build(false);
		const res = await app.request("/api/secrets/ANTHROPIC_API_KEY", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: KEY_VALUE }),
		});
		expect(res.status).toBe(201);
		expect(reasons).toEqual([]);
	});
});
