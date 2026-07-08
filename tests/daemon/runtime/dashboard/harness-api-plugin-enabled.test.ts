/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-006d d-AC-1 / d-AC-4 - the harness API surfaces plugin-enabled beside agent-present.
 *
 * Proves the tier-legal extension of `GET /api/diagnostics/harnesses`:
 *   - d-AC-1: each harness reports BOTH `installed` (agent-present) AND `pluginEnabled`, fed by an
 *             INJECTED resolver (mirroring `resolveInstalled`) - the daemon never imports the Tier-4
 *             `isPluginEnabled` (no upward import).
 *   - d-AC-4: plugin-enabled is derived, fail-soft false by default (no resolver injected → false for
 *             every harness), and NO secret/path rides the response (a plain boolean).
 */

import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import {
	buildHarnessStatuses,
	type HarnessStatus,
	mountHarnessApi,
} from "../../../../src/daemon/runtime/dashboard/harness-api.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
}

function makeDaemon() {
	const fake = new FakeDeepLakeTransport(() => []);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

async function getHarnesses(options: Parameters<typeof mountHarnessApi>[1]): Promise<HarnessStatus[]> {
	const { daemon } = makeDaemon();
	mountHarnessApi(daemon, options);
	const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
	expect(res.status).toBe(200);
	const json = (await res.json()) as { harnesses: HarnessStatus[] };
	return json.harnesses;
}

describe("PRD-006d d-AC-1 - agent-present AND plugin-enabled per harness", () => {
	it("d-AC-1 returns a pluginEnabled boolean for every harness, distinct from installed", async () => {
		const { daemon, storage } = makeDaemon();
		mountHarnessApi(daemon, {
			storage,
			// claude-code: agent present but plugin NOT enabled (the repairable state the card shows).
			installedHarnesses: new Set(["claude-code"]),
			resolvePluginEnabled: () => new Set(["cursor"]),
		});
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		const json = (await res.json()) as { harnesses: HarnessStatus[] };
		const claude = json.harnesses.find((h) => h.name === "claude-code");
		const cursor = json.harnesses.find((h) => h.name === "cursor");
		// Agent present, plugin not enabled - the two states are independently representable (d-AC-1).
		expect(claude?.installed).toBe(true);
		expect(claude?.pluginEnabled).toBe(false);
		// Plugin enabled but agent-marker not in the installed set - also independently representable.
		expect(cursor?.installed).toBe(false);
		expect(cursor?.pluginEnabled).toBe(true);
	});

	it("d-AC-1 every one of the six harnesses carries the pluginEnabled field", async () => {
		const harnesses = await getHarnesses({ storage: makeDaemon().storage, resolvePluginEnabled: () => new Set() });
		expect(harnesses).toHaveLength(6);
		for (const h of harnesses) {
			expect(typeof h.pluginEnabled).toBe("boolean");
		}
	});
});

describe("PRD-006d d-AC-4 - derived, fail-soft, no secret", () => {
	it("d-AC-4 with NO resolver injected, plugin-enabled is fail-soft false for every harness", async () => {
		// The pure daemon assembly injects no tier-legal resolver → the field defaults to false.
		const harnesses = await getHarnesses({
			storage: makeDaemon().storage,
			installedHarnesses: new Set(["claude-code"]),
		});
		for (const h of harnesses) {
			expect(h.pluginEnabled).toBe(false);
		}
		// installed is still reported honestly even though plugin-enabled defaulted off.
		expect(harnesses.find((h) => h.name === "claude-code")?.installed).toBe(true);
	});

	it("d-AC-4 the response carries NO token/secret/path (pluginEnabled is a plain boolean)", async () => {
		const { daemon, storage } = makeDaemon();
		mountHarnessApi(daemon, { storage, resolvePluginEnabled: () => new Set(["claude-code"]) });
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		const raw = (await res.text()).toLowerCase();
		for (const needle of [
			"token",
			"bearer",
			"authorization",
			"secret",
			"api_key",
			"apikey",
			"password",
			"credential",
		]) {
			expect(raw).not.toContain(needle);
		}
	});

	it("d-AC-1 buildHarnessStatuses folds the injected plugin-enabled set (back-compat: absent → false)", () => {
		const withEnabled = buildHarnessStatuses([], new Set(["claude-code"]), new Set(["claude-code"]));
		expect(withEnabled.find((h) => h.name === "claude-code")?.pluginEnabled).toBe(true);
		// The 2-arg call (existing callers) stays valid and yields plugin-enabled false everywhere.
		const legacy = buildHarnessStatuses([], new Set(["claude-code"]));
		for (const h of legacy) expect(h.pluginEnabled).toBe(false);
	});
});
