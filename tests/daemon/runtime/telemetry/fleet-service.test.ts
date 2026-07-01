/**
 * PRD-071 — the composed fleet `TelemetryService` (`fleet-service.ts`): check-in + metrics over one
 * shared store, wired as a single {@link DaemonService} (the `DaemonServices.telemetry` slot).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createTelemetryService,
	noopTelemetryService,
} from "../../../../src/daemon/runtime/telemetry/fleet-service.js";
import { openFleetTelemetryStore } from "../../../../src/daemon/runtime/telemetry/fleet-store.js";
import type { MetricsTotals } from "../../../../src/daemon/runtime/telemetry/metrics.js";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PRD-071: createTelemetryService", () => {
	it("start() wires check-in AND metrics against the SAME store", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const totals: MetricsTotals = { memoryCount: 4, actionsTakenTotal: 1 };
		const service = createTelemetryService({
			store,
			health: () => "ok",
			metricsSource: { fetchTotals: async () => totals },
		});
		await service.start();
		expect(store.readStatus()?.health).toBe("ok");
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 0, actionsTaken: 0 });
		await service.stop();
	});

	it("recordFilesProcessed() reaches the underlying metrics service", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const service = createTelemetryService({
			store,
			health: () => "ok",
			metricsSource: { fetchTotals: async () => ({ memoryCount: 0, actionsTakenTotal: 0 }) },
			metricsFlushIntervalMs: 1_000,
		});
		await service.start();
		service.recordFilesProcessed(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(store.readMetrics()?.filesProcessed).toBe(2);
		await service.stop();
	});

	it("stop() closes the store AFTER both sub-services stop (a post-stop write is a fail-soft no-op)", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const service = createTelemetryService({
			store,
			health: () => "ok",
			metricsSource: { fetchTotals: async () => ({ memoryCount: 0, actionsTakenTotal: 0 }) },
		});
		await service.start();
		await service.stop();
		expect(() => store.appendLog("info", "post-shutdown")).not.toThrow();
		expect(store.readRecentLogs()).toEqual([]);
	});

	it("noopTelemetryService is inert and never throws", async () => {
		await expect(noopTelemetryService.start()).resolves.toBeUndefined();
		expect(() => noopTelemetryService.recordFilesProcessed()).not.toThrow();
		await expect(noopTelemetryService.stop()).resolves.toBeUndefined();
	});
});
