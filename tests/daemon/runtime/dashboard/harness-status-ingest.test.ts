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
 * PRD-006d F-2 - the daemon serves REAL plugin-enabled state via the reconcile-push ingest.
 *
 * Proves the tier-legal cross-process handoff on the daemon (Tier 2) side:
 *   - the in-memory holder starts empty (honest last-known -> false before the first push);
 *   - `POST /api/diagnostics/harness-status` writes the holder, and `GET /api/diagnostics/harnesses`
 *     then reports the pushed `pluginEnabled` PER harness (F-2 / d-AC-1);
 *   - the ingest self-gates to LOCAL mode (a non-local request never reaches the holder);
 *   - it is fail-soft: a malformed body is a clean 400 with the holder untouched (never a 500), and
 *     the ack carries NO secret/path (ids + a count only).
 */

import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { type HarnessStatus, mountHarnessApi } from "../../../../src/daemon/runtime/dashboard/harness-api.js";
import { createHarnessPluginStatusHolder } from "../../../../src/daemon/runtime/dashboard/harness-plugin-status.js";
import {
	type HarnessStatusIngestAck,
	mountHarnessStatusIngestApi,
} from "../../../../src/daemon/runtime/dashboard/harness-status-ingest.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(mode: RuntimeConfig["mode"] = "local"): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE, "content-type": "application/json" };
}

function makeDaemon(mode: RuntimeConfig["mode"] = "local"): {
	daemon: Daemon;
	storage: ReturnType<typeof createStorageClient>;
} {
	const fake = new FakeDeepLakeTransport(() => []);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(mode), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

/** Wire BOTH the telemetry read (through the holder) and the ingest write over ONE shared holder. */
function wireBoth(mode: RuntimeConfig["mode"] = "local"): {
	daemon: Daemon;
	holder: ReturnType<typeof createHarnessPluginStatusHolder>;
} {
	const { daemon, storage } = makeDaemon(mode);
	const holder = createHarnessPluginStatusHolder();
	mountHarnessApi(daemon, { storage, resolvePluginEnabled: () => holder.get() });
	mountHarnessStatusIngestApi(daemon, { holder });
	return { daemon, holder };
}

async function postStatus(daemon: Daemon, body: unknown): Promise<Response> {
	return daemon.app.request("/api/diagnostics/harness-status", {
		method: "POST",
		headers: headers(),
		body: JSON.stringify(body),
	});
}

async function getHarnesses(daemon: Daemon): Promise<HarnessStatus[]> {
	const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
	expect(res.status).toBe(200);
	return ((await res.json()) as { harnesses: HarnessStatus[] }).harnesses;
}

describe("PRD-006d F-2 - the holder + ingest serve real plugin-enabled state", () => {
	it("F-2 an ingest push makes the harnesses endpoint report the pushed pluginEnabled per harness", async () => {
		const { daemon } = wireBoth();
		// Before any push the endpoint honestly reports false everywhere (empty holder).
		for (const h of await getHarnesses(daemon)) expect(h.pluginEnabled).toBe(false);

		const res = await postStatus(daemon, {
			harnesses: [
				{ harness: "claude-code", pluginEnabled: true },
				{ harness: "cursor", pluginEnabled: false },
			],
		});
		expect(res.status).toBe(200);
		const ack = (await res.json()) as HarnessStatusIngestAck;
		expect(ack.accepted).toBe(true);
		expect(ack.enabledCount).toBe(1);

		// After the push the endpoint reflects the REAL per-harness state.
		const harnesses = await getHarnesses(daemon);
		expect(harnesses.find((h) => h.name === "claude-code")?.pluginEnabled).toBe(true);
		expect(harnesses.find((h) => h.name === "cursor")?.pluginEnabled).toBe(false);
	});

	it("F-2 a later push REPLACES the prior enabled set (last-known wins)", async () => {
		const { daemon } = wireBoth();
		await postStatus(daemon, { harnesses: [{ harness: "claude-code", pluginEnabled: true }] });
		await postStatus(daemon, { harnesses: [{ harness: "claude-code", pluginEnabled: false }] });
		expect((await getHarnesses(daemon)).find((h) => h.name === "claude-code")?.pluginEnabled).toBe(false);
	});

	it("F-2 the ingest self-gates to LOCAL mode (a team-mode request never reaches the holder)", async () => {
		const { daemon, holder } = wireBoth("team");
		const res = await postStatus(daemon, { harnesses: [{ harness: "claude-code", pluginEnabled: true }] });
		expect([401, 403, 404]).toContain(res.status);
		expect(holder.get().size).toBe(0); // untouched.
	});

	it("F-2 a malformed body is a clean 400 with the holder untouched (fail-soft, never a 500)", async () => {
		const { daemon, holder } = wireBoth();
		// Seed a known-good state first so we can prove the bad push does not clobber it.
		await postStatus(daemon, { harnesses: [{ harness: "claude-code", pluginEnabled: true }] });
		const res = await postStatus(daemon, { harnesses: [{ harness: "claude-code" }] });
		expect(res.status).toBe(400);
		expect(((await res.json()) as HarnessStatusIngestAck).accepted).toBe(false);
		// The prior enabled set survives the rejected push (never partially written).
		expect(holder.get().has("claude-code")).toBe(true);
	});

	it("F-2 a non-canonical harness id is dropped, never written to the holder (fail-soft, never a 500)", async () => {
		const { daemon, holder } = wireBoth();
		const res = await postStatus(daemon, {
			harnesses: [
				{ harness: "claude-code", pluginEnabled: true },
				{ harness: "not-a-real-harness", pluginEnabled: true },
			],
		});
		expect(res.status).toBe(200);
		const ack = (await res.json()) as HarnessStatusIngestAck;
		expect(ack.accepted).toBe(true);
		// Only the canonical id is counted/written; the bogus id never reaches the holder.
		expect(ack.enabledCount).toBe(1);
		expect(holder.get().has("claude-code")).toBe(true);
		expect(holder.get().has("not-a-real-harness")).toBe(false);
	});

	it("F-2 the ack carries NO token/secret/path (ids + a count only)", async () => {
		const { daemon } = wireBoth();
		const res = await postStatus(daemon, { harnesses: [{ harness: "claude-code", pluginEnabled: true }] });
		const raw = (await res.text()).toLowerCase();
		for (const needle of ["token", "bearer", "authorization", "secret", "apikey", "password", "credential"]) {
			expect(raw).not.toContain(needle);
		}
	});
});

describe("PRD-006d F-2 - the in-memory holder (FR-8)", () => {
	it("starts empty and round-trips a set of ids", () => {
		const holder = createHarnessPluginStatusHolder();
		expect(holder.get().size).toBe(0);
		holder.set(["claude-code", "cursor"]);
		expect([...holder.get()].sort()).toEqual(["claude-code", "cursor"]);
	});

	it("drops empty and whitespace-only entries so a malformed push cannot poison the set", () => {
		const holder = createHarnessPluginStatusHolder();
		holder.set(["claude-code", "", "   "]);
		expect(holder.get().has("claude-code")).toBe(true);
		expect(holder.get().has("")).toBe(false);
		expect(holder.get().has("   ")).toBe(false);
	});
});
