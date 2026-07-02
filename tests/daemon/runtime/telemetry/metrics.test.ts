/**
 * PRD-071b — the fleet metrics snapshot service (`metrics.ts`).
 *
 * Drives {@link createMetricsService} against a fixture {@link MetricsSource} (no storage, no
 * DeepLake) and an in-memory fleet store. Covers AC-4, AC-071b.1.2 (latest-wins), AC-071b.2.1 (no
 * double counting / reuse-not-recompute), AC-071b.3.1 (restart resets to zero), and AC-7 (fail-soft
 * on a source failure).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFleetTelemetryStore } from "../../../../src/daemon/runtime/telemetry/fleet-store.js";
import {
	createMetricsService,
	type MetricsTotals,
	noopMetricsService,
} from "../../../../src/daemon/runtime/telemetry/metrics.js";

/** A scriptable fixture source: each call returns the next queued totals (or the last one repeated). */
function fixtureSource(script: readonly MetricsTotals[]) {
	let calls = 0;
	let failNext = false;
	return {
		failNextCall(): void {
			failNext = true;
		},
		callCount(): number {
			return calls;
		},
		async fetchTotals(): Promise<MetricsTotals> {
			calls++;
			if (failNext) {
				failNext = false;
				throw new Error("storage unavailable");
			}
			const i = Math.min(calls - 1, script.length - 1);
			return script[i] ?? { memoryCount: 0, actionsTakenTotal: 0 };
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PRD-071b: metrics snapshot service", () => {
	it("AC-071b.3.1 start() writes a ZEROED snapshot immediately (the baseline is the first read)", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const source = fixtureSource([{ memoryCount: 42, actionsTakenTotal: 7 }]);
		const service = createMetricsService({ store, source });
		await service.start();
		expect(store.readMetrics()).toEqual({
			actionsTaken: 0,
			filesProcessed: 0,
			memoriesCreated: 0,
			updatedAt: expect.any(String),
		});
		await service.stop();
		store.close();
	});

	it("AC-071b.2.1 later snapshots report growth SINCE the baseline, without double counting", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const source = fixtureSource([
			{ memoryCount: 10, actionsTakenTotal: 2 },
			{ memoryCount: 15, actionsTakenTotal: 5 },
			{ memoryCount: 15, actionsTakenTotal: 9 },
		]);
		const service = createMetricsService({ store, source, flushIntervalMs: 1_000 });
		await service.start(); // baseline = {10, 2} -> snapshot {0, 0}
		await service._flushForTest?.(); // totals {15, 5} -> delta {5, 3}
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 5, actionsTaken: 3 });
		await service._flushForTest?.(); // totals {15, 9} -> delta {5, 7}, memories unchanged
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 5, actionsTaken: 7 });
		await service.stop();
		store.close();
	});

	it("AC-071b.1.2 the metrics row is latest-wins, not an unbounded append", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const source = fixtureSource([
			{ memoryCount: 1, actionsTakenTotal: 0 },
			{ memoryCount: 2, actionsTakenTotal: 1 },
		]);
		const service = createMetricsService({ store, source });
		await service.start();
		await service._flushForTest?.();
		await service._flushForTest?.();
		// Reading the single-row table gives exactly one current value, never a history.
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 1, actionsTaken: 1 });
		await service.stop();
		store.close();
	});

	it("AC-071b.3.1 a restart resets since-restart counters to reflect the new process lifetime", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const source = fixtureSource([
			{ memoryCount: 100, actionsTakenTotal: 50 },
			{ memoryCount: 120, actionsTakenTotal: 60 },
		]);
		const service = createMetricsService({ store, source });
		await service.start(); // baseline 100/50
		await service._flushForTest?.(); // 120/60 -> delta 20/10
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 20, actionsTaken: 10 });

		// "Restart": start() again re-baselines from the NEXT fetch (simulating the new process
		// reading the corpus's current absolute totals as its zero point).
		await service.start();
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 0, actionsTaken: 0 });
		await service.stop();
		store.close();
	});

	it("AC-071b.3.1 an in-flight flush from a previous run never corrupts a restart's fresh baseline", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		// A manually-resolved source so one fetch can be held IN FLIGHT across a restart.
		const pending: Array<(totals: MetricsTotals) => void> = [];
		const source = {
			async fetchTotals(): Promise<MetricsTotals> {
				return new Promise((resolve) => {
					pending.push(resolve);
				});
			},
		};
		const service = createMetricsService({ store, source, flushIntervalMs: 1_000 });

		const firstStart = service.start();
		pending.shift()?.({ memoryCount: 10, actionsTakenTotal: 2 }); // run 1 baseline {10, 2}
		await firstStart;

		// A timer tick fires and its fetch STALLS in flight...
		await vi.advanceTimersByTimeAsync(1_000);
		const staleResolve = pending.shift();

		// ...then a restart re-baselines from fresh totals and writes the zero snapshot.
		const secondStart = service.start();
		pending.shift()?.({ memoryCount: 100, actionsTakenTotal: 50 }); // run 2 baseline {100, 50}
		await secondStart;
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 0, actionsTaken: 0 });

		// The STALE run-1 flush finally resolves: it must be discarded, never repopulate the
		// baseline or overwrite the restart's zero snapshot with run-1 deltas.
		staleResolve?.({ memoryCount: 60, actionsTakenTotal: 30 });
		await vi.advanceTimersByTimeAsync(0);
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 0, actionsTaken: 0 });

		// The next run-2 flush still computes deltas against run 2's own baseline {100, 50}.
		const nextFlush = service._flushForTest?.();
		pending.shift()?.({ memoryCount: 105, actionsTakenTotal: 51 });
		await nextFlush;
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 5, actionsTaken: 1 });

		await service.stop();
		store.close();
	});

	it("recordFilesProcessed() accumulates in-memory and resets to zero on start()", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const source = fixtureSource([{ memoryCount: 0, actionsTakenTotal: 0 }]);
		const service = createMetricsService({ store, source });
		await service.start();
		service.recordFilesProcessed();
		service.recordFilesProcessed(3);
		await service._flushForTest?.();
		expect(store.readMetrics()?.filesProcessed).toBe(4);

		await service.start(); // restart resets the in-memory counter
		expect(store.readMetrics()?.filesProcessed).toBe(0);
		await service.stop();
		store.close();
	});

	it("AC-7 a source failure is fail-soft: the write is skipped, never thrown", async () => {
		const store = openFleetTelemetryStore({ memory: true });
		const source = fixtureSource([{ memoryCount: 5, actionsTakenTotal: 1 }]);
		source.failNextCall();
		const service = createMetricsService({ store, source, onceFailure: () => {} });
		await expect(service.start()).resolves.toBeUndefined();
		expect(store.readMetrics()).toBeNull();
		// The next successful fetch establishes the baseline and resumes snapshots.
		await service._flushForTest?.();
		expect(store.readMetrics()).toMatchObject({ memoriesCreated: 0, actionsTaken: 0 });
		await service.stop();
		store.close();
	});

	it("noopMetricsService is inert and never throws", async () => {
		await expect(noopMetricsService.start()).resolves.toBeUndefined();
		expect(() => noopMetricsService.recordFilesProcessed()).not.toThrow();
		await expect(noopMetricsService.stop()).resolves.toBeUndefined();
	});
});
