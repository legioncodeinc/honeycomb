/**
 * The fleet `TelemetryService` — PRD-071 composition root. Wires the check-in (071a) and metrics
 * (071b) sub-services over one already-open {@link FleetTelemetryStore} into a single
 * {@link DaemonService} that plugs into `server.ts`'s `DaemonServices.telemetry` slot, mirroring the
 * existing `noopJobQueueService`/`DaemonServices` DI convention (`CONVENTIONS.md` §0) — a Wave-2-style
 * seam so tests never touch real SQLite unless they opt in.
 *
 * Log emission (071c) is deliberately NOT owned by this service: `createFleetLogTap` builds a plain
 * {@link import("./logs.js").LogWriteThrough} that the daemon composition root (`assemble.ts`) wires
 * directly into `createRequestLogger({ store })` alongside the existing durable log store, since that
 * is the seam the logger already exposes (PRD-043a) — no second lifecycle to start/stop for logging.
 *
 * This service owns the STORE'S lifetime: `stop()` closes it after both sub-services have stopped,
 * so a shutdown-time log write from the (independently-owned) logger tap degrades to a no-op rather
 * than reopening or throwing (the store's own `closed` guard, `fleet-store.ts`).
 */

import type { DaemonService } from "../services/types.js";
import { type CheckinDeps, type CheckinService, createCheckinService, noopCheckinService } from "./checkin.js";
import type { FleetTelemetryStore } from "./fleet-store.js";
import { createMetricsService, type MetricsDeps, type MetricsService, noopMetricsService } from "./metrics.js";

export interface TelemetryService extends DaemonService {
	/** Increment the in-memory files-processed counter (071b technical considerations). */
	recordFilesProcessed(count?: number): void;
}

export interface CreateTelemetryServiceOptions {
	/** The already-open store (assemble.ts opens it; a test injects an in-memory one). */
	readonly store: FleetTelemetryStore;
	readonly health: CheckinDeps["health"];
	readonly deeplakeConnected?: CheckinDeps["deeplakeConnected"];
	readonly heartbeatIntervalMs?: CheckinDeps["heartbeatIntervalMs"];
	readonly checkinClock?: CheckinDeps["clock"];
	readonly metricsSource: MetricsDeps["source"];
	readonly metricsFlushIntervalMs?: MetricsDeps["flushIntervalMs"];
	readonly metricsClock?: MetricsDeps["clock"];
	readonly onceFailure?: (message: string) => void;
}

/**
 * Build the real `TelemetryService`. Does NOT open the store itself (the caller owns that so the
 * SAME store instance can also back the logger's fleet tap) — see the module doc for why logging
 * is wired separately. `start()` starts check-in then metrics (order is immaterial — neither reads
 * the other); `stop()` reverses that, THEN closes the store.
 */
export function createTelemetryService(options: CreateTelemetryServiceOptions): TelemetryService {
	const checkin: CheckinService = createCheckinService({
		store: options.store,
		health: options.health,
		...(options.deeplakeConnected !== undefined ? { deeplakeConnected: options.deeplakeConnected } : {}),
		...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
		...(options.checkinClock !== undefined ? { clock: options.checkinClock } : {}),
	});
	const metrics: MetricsService = createMetricsService({
		store: options.store,
		source: options.metricsSource,
		...(options.metricsFlushIntervalMs !== undefined ? { flushIntervalMs: options.metricsFlushIntervalMs } : {}),
		...(options.metricsClock !== undefined ? { clock: options.metricsClock } : {}),
		...(options.onceFailure !== undefined ? { onceFailure: options.onceFailure } : {}),
	});

	return {
		recordFilesProcessed(count?: number): void {
			metrics.recordFilesProcessed(count);
		},
		async start(): Promise<void> {
			await checkin.start();
			await metrics.start();
		},
		async stop(): Promise<void> {
			await metrics.stop();
			await checkin.stop();
			options.store.close();
		},
	};
}

/** The inert stub `server.ts` defaults `DaemonServices.telemetry` to (mirrors `noopJobQueueService`). */
export const noopTelemetryService: TelemetryService = Object.freeze({
	recordFilesProcessed(): void {},
	async start(): Promise<void> {
		await noopCheckinService.start();
		await noopMetricsService.start();
	},
	async stop(): Promise<void> {
		await noopMetricsService.stop();
		await noopCheckinService.stop();
	},
});
