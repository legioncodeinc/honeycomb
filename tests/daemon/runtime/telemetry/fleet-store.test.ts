/**
 * PRD-071 Contract B — the fleet telemetry SQLite store (`fleet-store.ts`).
 *
 * Runs against a temp-dir `node:sqlite` database, never the real `~/.honeycomb`. Covers: schema
 * creation, single-row latest-wins upserts (never appended), log append + rotation to the row cap,
 * fail-soft degrade on close, and that the store never requires a secret-shaped field (AC-10 is a
 * schema property here: every column is enum/numeric/timestamp except `service_logs.message`,
 * which callers redact before writing — this suite proves the message column simply stores what
 * it's given, unredacted-content responsibility lives in `logs.ts`/`redact.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	FLEET_SERVICE_NAME,
	fleetTelemetryDbPath,
	NULL_FLEET_TELEMETRY_STORE,
	openFleetTelemetryStore,
} from "../../../../src/daemon/runtime/telemetry/fleet-store.js";

let homeDir: string;

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "hc-fleet-store-"));
});

afterEach(() => {
	rmSync(homeDir, { recursive: true, force: true });
});

describe("PRD-071 Contract B: fleet telemetry store", () => {
	it("AC-1 opens (creating) the pinned path under the home dir and is a no-op on a fresh read", () => {
		const store = openFleetTelemetryStore({ homeDir });
		expect(store.persistent).toBe(true);
		expect(store.readStatus()).toBeNull();
		expect(store.readMetrics()).toBeNull();
		expect(store.readRecentLogs()).toEqual([]);
		store.close();
	});

	it("service_status is a single latest-wins row, never appended (AC-071b.1.2 pattern applied to status)", () => {
		const store = openFleetTelemetryStore({ memory: true });
		store.upsertStatus({ name: FLEET_SERVICE_NAME, bindingTime: "t0", lastSeen: "t0", health: "ok" });
		store.upsertStatus({ name: FLEET_SERVICE_NAME, bindingTime: "t0", lastSeen: "t1", health: "degraded" });
		const status = store.readStatus();
		expect(status?.lastSeen).toBe("t1");
		expect(status?.health).toBe("degraded");
		store.close();
	});

	it("AC-071a.2 status upsert carries deeplakeConnected + deeplakeLastComm when supplied", () => {
		const store = openFleetTelemetryStore({ memory: true });
		store.upsertStatus({
			name: FLEET_SERVICE_NAME,
			bindingTime: "t0",
			lastSeen: "t0",
			health: "ok",
			deeplakeConnected: true,
			deeplakeLastComm: "t0",
		});
		const status = store.readStatus();
		expect(status?.deeplakeConnected).toBe(true);
		expect(status?.deeplakeLastComm).toBe("t0");
		store.close();
	});

	it("AC-071b.1.2 service_metrics is a single latest-wins row, never appended", () => {
		const store = openFleetTelemetryStore({ memory: true });
		store.upsertMetrics({ actionsTaken: 1, filesProcessed: 0, memoriesCreated: 2, updatedAt: "t0" });
		store.upsertMetrics({ actionsTaken: 5, filesProcessed: 1, memoriesCreated: 9, updatedAt: "t1" });
		const metrics = store.readMetrics();
		expect(metrics).toEqual({ actionsTaken: 5, filesProcessed: 1, memoriesCreated: 9, updatedAt: "t1" });
		store.close();
	});

	it("AC-5 / AC-071c.1.1 appendLog writes a row carrying a timestamp + a verbosity level", () => {
		const store = openFleetTelemetryStore({ memory: true });
		store.appendLog("info", "GET /health -> 200 (1ms)");
		const rows = store.readRecentLogs();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.level).toBe("info");
		expect(rows[0]?.message).toBe("GET /health -> 200 (1ms)");
		expect(typeof rows[0]?.ts).toBe("string");
		expect(rows[0]?.ts.length).toBeGreaterThan(0);
		store.close();
	});

	it("AC-8 / AC-071c.2 rotates oldest rows once the log table exceeds its configured cap", () => {
		const store = openFleetTelemetryStore({ memory: true, maxLogRows: 5 });
		for (let i = 0; i < 12; i++) store.appendLog("info", `line-${i}`);
		const rows = store.readRecentLogs(100);
		expect(rows).toHaveLength(5);
		// Newest-first: the 5 most recent lines survive, oldest rotated out.
		expect(rows.map((r) => r.message)).toEqual(["line-11", "line-10", "line-9", "line-8", "line-7"]);
		store.close();
	});

	it("AC-9: opens in WAL journal mode so a concurrent read-only reader never contends with writes", () => {
		const store = openFleetTelemetryStore({ homeDir });
		store.upsertStatus({ name: FLEET_SERVICE_NAME, bindingTime: "t0", lastSeen: "t0", health: "ok" });
		// Opening a second read-only handle at the SAME path (hivedoctor's poller) must see the row
		// without honeycomb's own writer closing first — proves WAL, not a locked/rolled-back file.
		const reader = openFleetTelemetryStore({ homeDir });
		expect(reader.readStatus()?.health).toBe("ok");
		store.upsertStatus({ name: FLEET_SERVICE_NAME, bindingTime: "t0", lastSeen: "t1", health: "ok" });
		expect(reader.readStatus()?.lastSeen).toBe("t1");
		store.close();
		reader.close();
	});

	it("fleetTelemetryDbPath resolves the pinned Contract-B path under the given home dir", () => {
		expect(fleetTelemetryDbPath(homeDir)).toBe(join(homeDir, ".honeycomb", "telemetry", "honeycomb.sqlite"));
	});

	it("AC-7: writes and reads are fail-soft no-ops after close()", () => {
		const store = openFleetTelemetryStore({ memory: true });
		store.close();
		expect(() =>
			store.upsertStatus({ name: FLEET_SERVICE_NAME, bindingTime: "t0", lastSeen: "t0", health: "ok" }),
		).not.toThrow();
		expect(() =>
			store.upsertMetrics({ actionsTaken: 0, filesProcessed: 0, memoriesCreated: 0, updatedAt: "t0" }),
		).not.toThrow();
		expect(() => store.appendLog("info", "after close")).not.toThrow();
		expect(store.readStatus()).toBeNull();
		expect(store.readRecentLogs()).toEqual([]);
		// close() itself stays idempotent.
		expect(() => store.close()).not.toThrow();
	});

	it("AC-7: NULL_FLEET_TELEMETRY_STORE is a fully inert fallback", () => {
		expect(NULL_FLEET_TELEMETRY_STORE.persistent).toBe(false);
		expect(() =>
			NULL_FLEET_TELEMETRY_STORE.upsertStatus({ name: "x", bindingTime: "t", lastSeen: "t", health: "ok" }),
		).not.toThrow();
		expect(NULL_FLEET_TELEMETRY_STORE.readStatus()).toBeNull();
		expect(NULL_FLEET_TELEMETRY_STORE.readMetrics()).toBeNull();
		expect(NULL_FLEET_TELEMETRY_STORE.readRecentLogs()).toEqual([]);
	});
});
