/**
 * PRD-071a — the fleet check-in / heartbeat service (`checkin.ts`).
 *
 * Runs against an in-memory fleet store + a controllable fake clock — no real timers, no real
 * SQLite file. Covers AC-2, AC-3, AC-6, AC-071a.2, AC-071a.3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCheckinService, noopCheckinService } from "../../../../src/daemon/runtime/telemetry/checkin.js";
import {
	NULL_FLEET_TELEMETRY_STORE,
	openFleetTelemetryStore,
} from "../../../../src/daemon/runtime/telemetry/fleet-store.js";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PRD-071a: check-in service", () => {
	it("AC-2 / AC-071a.2.1 start() writes an initial status row with a binding time + the current health", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const service = createCheckinService({ store, health: () => "ok" });
		await service.start();
		const status = store.readStatus();
		expect(status?.health).toBe("ok");
		expect(status?.bindingTime).toBe(service.bindingTime);
		expect(status?.lastSeen).toBe(service.bindingTime);
		await service.stop();
		store.close();
	});

	it("AC-071a.2.2 the health field always matches the SAME source /health reads (never recomputed)", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		let health: "ok" | "degraded" | "unconfigured" = "ok";
		const service = createCheckinService({ store, health: () => health });
		await service.start();
		expect(store.readStatus()?.health).toBe("ok");
		health = "degraded";
		service._tickForTest?.();
		expect(store.readStatus()?.health).toBe("degraded");
		await service.stop();
		store.close();
	});

	it("AC-3 / AC-071a.3.1 the heartbeat advances last_seen on interval even with no other change", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const service = createCheckinService({ store, health: () => "ok", heartbeatIntervalMs: 5_000 });
		await service.start();
		const first = store.readStatus()?.lastSeen;
		await vi.advanceTimersByTimeAsync(5_000);
		const second = store.readStatus()?.lastSeen;
		expect(second).not.toBe(first);
		await vi.advanceTimersByTimeAsync(5_000);
		const third = store.readStatus()?.lastSeen;
		expect(third).not.toBe(second);
		await service.stop();
		store.close();
	});

	it("AC-6 / AC-071a.3.2 a restart re-stamps binding_time for the new process", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const service = createCheckinService({ store, health: () => "ok" });
		await service.start();
		const firstBinding = service.bindingTime;
		await service.stop();
		// Simulate a small time gap before the "restart".
		vi.advanceTimersByTime(1_000);
		await service.start();
		const secondBinding = service.bindingTime;
		expect(secondBinding).not.toBe(firstBinding);
		expect(store.readStatus()?.bindingTime).toBe(secondBinding);
		await service.stop();
		store.close();
	});

	it("stop() clears the heartbeat so no further writes happen after shutdown", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const service = createCheckinService({ store, health: () => "ok", heartbeatIntervalMs: 1_000 });
		await service.start();
		await service.stop();
		const afterStop = store.readStatus()?.lastSeen;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(store.readStatus()?.lastSeen).toBe(afterStop);
		store.close();
	});

	it("AC-7 a throwing store/health is fail-soft: start() resolves and the heartbeat never throws", async () => {
		const throwingStore = {
			...NULL_FLEET_TELEMETRY_STORE,
			upsertStatus(): void {
				throw new Error("disk full");
			},
		};
		const failures: string[] = [];
		const service = createCheckinService({
			store: throwingStore,
			health: () => "ok",
			heartbeatIntervalMs: 1_000,
			onceFailure: (message) => failures.push(message),
		});
		await expect(service.start()).resolves.toBeUndefined();
		// The heartbeat keeps ticking without an escaping throw, and the failure surfaces ONCE.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("disk full");
		await service.stop();

		// A throwing health thunk is equally contained.
		const store2 = openFleetTelemetryStore({ memory: true });
		const service2 = createCheckinService({
			store: store2,
			health: () => {
				throw new Error("health unavailable");
			},
			onceFailure: () => {},
		});
		await expect(service2.start()).resolves.toBeUndefined();
		expect(() => service2._tickForTest?.()).not.toThrow();
		await service2.stop();
		store2.close();
	});

	it("AC-7 noopCheckinService is inert (fail-soft default) and never throws", async () => {
		await expect(noopCheckinService.start()).resolves.toBeUndefined();
		await expect(noopCheckinService.stop()).resolves.toBeUndefined();
		expect(noopCheckinService.bindingTime).toBeUndefined();
	});
});
