/**
 * PRD-071 — live wiring proof: `assembleDaemon` actually starts the fleet `TelemetryService` and
 * fans logger writes into the fleet store, end to end, against a fake `storage` + an injected
 * IN-MEMORY fleet store (never the real `~/.honeycomb`, never real DeepLake).
 *
 * Mirrors `assemble.test.ts`'s verification posture (in-process `daemon.app.request`, a temp
 * `runtimeDir` for the PID/lock guard, `noopEmbedSupervisor` so no real embed child spawns).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleDaemon } from "../../../src/daemon/runtime/assemble.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import { noopEmbedSupervisor } from "../../../src/daemon/runtime/services/embed-supervisor.js";
import { openFleetTelemetryStore } from "../../../src/daemon/runtime/telemetry/fleet-store.js";
import { createFleetLogTap } from "../../../src/daemon/runtime/telemetry/logs.js";
import type { StorageClient } from "../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../src/daemon/storage/result.js";

function fakeStorage(result: QueryResult): StorageClient {
	return {
		get endpoint() {
			return "https://example.invalid";
		},
		async connect() {
			return result;
		},
		async query() {
			return result;
		},
	} as unknown as StorageClient;
}

const OK_RESULT: QueryResult = { kind: "ok", rows: [{ "?column?": 1 }], durationMs: 1 };

let runtimeDir: string;

beforeEach(() => {
	runtimeDir = mkdtempSync(join(tmpdir(), "honeycomb-assemble-telemetry-"));
});

afterEach(() => {
	rmSync(runtimeDir, { recursive: true, force: true });
});

describe("PRD-071: assembleDaemon wires the real fleet TelemetryService when a store is injected", () => {
	it("AC-2 / AC-3: starting the daemon writes a service_status row with a binding time + health", async () => {
		const telemetryStore = openFleetTelemetryStore({ memory: true });
		const assembled = assembleDaemon({
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			telemetryStore,
		});
		await assembled.start();
		try {
			const status = telemetryStore.readStatus();
			expect(status).not.toBeNull();
			expect(status?.name).toBe("honeycomb");
			expect(status?.health).toBe("ok");
			expect(typeof status?.bindingTime).toBe("string");
		} finally {
			await assembled.shutdown();
		}
	});

	it("AC-5: a request through the running daemon is mirrored into service_logs", async () => {
		const telemetryStore = openFleetTelemetryStore({ memory: true });
		const assembled = assembleDaemon({
			storage: fakeStorage(OK_RESULT),
			// `assembleDaemon` only wires its OWN default logger's store into the fleet tap when it
			// builds the logger itself; a custom injected `logger` (here, silenced for clean test
			// output) is respected verbatim, so this test wires the SAME tap manually to prove the
			// mirroring contract `logs.ts` provides, independent of which logger instance is used.
			logger: createRequestLogger({ silent: true, store: createFleetLogTap(telemetryStore) }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			telemetryStore,
		});
		await assembled.start();
		try {
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
			const rows = telemetryStore.readRecentLogs();
			expect(rows.some((r) => r.message.includes("/health"))).toBe(true);
		} finally {
			await assembled.shutdown();
		}
	});

	it("a daemon assembled WITHOUT an injected telemetryStore (fake storage, no override) stays on the noop default", async () => {
		const assembled = assembleDaemon({
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
		});
		await assembled.start();
		try {
			// The noop telemetry service never opens `~/.honeycomb` — this is simply proving the
			// deterministic unit path never throws and the daemon still serves requests normally.
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
		} finally {
			await assembled.shutdown();
		}
	});
});
