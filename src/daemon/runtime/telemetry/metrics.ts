/**
 * The fleet metrics snapshot service — PRD-071b (AC-4 / AC-071b.1 / AC-071b.2 / AC-071b.3).
 *
 * Writes a latest-wins `service_metrics` snapshot (actions taken, files processed, memories
 * created, all SINCE THE CURRENT PROCESS STARTED) to the fleet telemetry SQLite (Contract B), on a
 * short interval, so hivedoctor observes live counters without honeycomb pushing anything.
 *
 * ── Reuse, never recompute (AC-071b.2.1) ────────────────────────────────────────
 *   - `memoriesCreated` <- the DELTA of `fetchKpiCounts(...).memoryCount` (the dashboard's existing
 *     memory-corpus count, `src/daemon/runtime/dashboard/api.ts`) since this process's baseline.
 *   - `actionsTaken` <- the DELTA of the ROI ledger's row count (`roi_metrics`,
 *     `src/daemon/runtime/dashboard/roi-ledger.ts`'s append-only action log) since baseline.
 *   Both baselines are captured on `start()` (the first successful {@link MetricsSource.fetchTotals}
 *   call), so the FIRST snapshot after a restart writes zeros and every later snapshot reports
 *   growth since THIS process began — restart-reset semantics fall out of "baseline = totals at
 *   process start" for free, with no separate reset flag to maintain (AC-071b.3.1 / AC-6).
 *   `sessionCount`/`turnCount` are intentionally NOT double-counted into `actionsTaken`: the ROI
 *   ledger is the ledger of counted actions per PRD-071's own mapping guidance; turns are a
 *   DIFFERENT existing counter surfaced elsewhere on the dashboard.
 *
 * ── `filesProcessed` is a fresh in-memory counter (071b technical considerations, open question)
 *   PRD-071b explicitly leaves "is files-processed counted per file or per batch" as an OPEN
 *   QUESTION and describes it as "a NEW in-memory counter flushed to the snapshot" — i.e. this is
 *   the one metric that does NOT reuse an existing persisted counter (there is no existing
 *   per-file-processed counter in the dashboard/ROI surfaces to reuse without inventing one). This
 *   module exposes {@link MetricsService.recordFilesProcessed} as that counter's write side,
 *   reset to zero on every `start()` (so it is since-restart by construction). No production call
 *   site invokes it yet — wiring it to a specific pipeline event is left to the PRD's own open
 *   question, so the honest default is `0` rather than a fabricated mapping onto an unrelated
 *   counter.
 *
 * ── Fail-soft (AC-7) ─────────────────────────────────────────────────────────────
 *   A `fetchTotals()` failure (storage down, a fresh install with no creds) is caught and the
 *   snapshot write is skipped for that tick — it never throws into the daemon boot or memory path.
 *   Once storage recovers, the next successful fetch establishes the baseline and snapshots resume.
 */

import type { DaemonService } from "../services/types.js";
import type { FleetTelemetryStore } from "./fleet-store.js";
import { unrefTimer } from "./unref-timer.js";

/** The existing, already-computed totals this service reads (never recomputes). */
export interface MetricsTotals {
	/** The corpus-wide memory count (`fetchKpiCounts(...).memoryCount`). */
	readonly memoryCount: number;
	/** The ROI ledger's total row count (`COUNT(*) FROM roi_metrics`), the "actions taken" source. */
	readonly actionsTakenTotal: number;
}

/** The seam this service reads totals through — production wires the real dashboard counters. */
export interface MetricsSource {
	fetchTotals(): Promise<MetricsTotals>;
}

export interface MetricsClock {
	now(): Date;
}
export const systemMetricsClock: MetricsClock = { now: () => new Date() };

/** The snapshot cadence. Short enough to look "live" under hivedoctor's roughly-1s poll. */
export const DEFAULT_METRICS_FLUSH_INTERVAL_MS = 10_000;

export interface MetricsDeps {
	readonly store: FleetTelemetryStore;
	readonly source: MetricsSource;
	readonly flushIntervalMs?: number;
	readonly clock?: MetricsClock;
	/** A one-time failure sink (surfaced ONCE, never per tick). Defaults to a single stderr write. */
	readonly onceFailure?: (message: string) => void;
}

export interface MetricsService extends DaemonService {
	/** Increment the in-memory files-processed counter (071b technical considerations). */
	recordFilesProcessed(count?: number): void;
	/** Test-only hook: run one flush synchronously without waiting on the real interval. */
	_flushForTest?(): Promise<void>;
}

function defaultOnceFailure(): (message: string) => void {
	let fired = false;
	return (message: string): void => {
		if (fired) return;
		fired = true;
		process.stderr.write(`${message}\n`);
	};
}

/**
 * Create the real metrics snapshot service. `start()` resets the in-memory `filesProcessed`
 * counter and the baseline, then performs an IMMEDIATE synchronous-with-await flush (writing zeros
 * when the source resolves, AC-071b.3.1) before scheduling the periodic re-flush; `stop()` clears
 * the interval. A `fetchTotals()` failure at ANY point is caught and logged once — it never leaves
 * the write path or throws into the caller.
 */
export function createMetricsService(deps: MetricsDeps): MetricsService {
	const clock = deps.clock ?? systemMetricsClock;
	const intervalMs = deps.flushIntervalMs ?? DEFAULT_METRICS_FLUSH_INTERVAL_MS;
	const onceFailure = deps.onceFailure ?? defaultOnceFailure();
	let timer: ReturnType<typeof setInterval> | null = null;
	let baseline: MetricsTotals | undefined;
	let filesProcessed = 0;

	async function flush(): Promise<void> {
		let totals: MetricsTotals;
		try {
			totals = await deps.source.fetchTotals();
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			onceFailure(`honeycomb: fleet metrics snapshot failed (non-fatal): ${reason}`);
			return;
		}
		// The FIRST successful fetch (per process lifetime, i.e. since the last start()) becomes the
		// baseline — every later delta is "since this process started" by construction (AC-071b.3.1).
		if (baseline === undefined) baseline = totals;
		const memoriesCreated = Math.max(0, totals.memoryCount - baseline.memoryCount);
		const actionsTaken = Math.max(0, totals.actionsTakenTotal - baseline.actionsTakenTotal);
		deps.store.upsertMetrics({
			actionsTaken,
			filesProcessed,
			memoriesCreated,
			updatedAt: clock.now().toISOString(),
		});
	}

	return {
		recordFilesProcessed(count = 1): void {
			filesProcessed += count;
		},
		async start(): Promise<void> {
			filesProcessed = 0;
			baseline = undefined;
			await flush();
			if (timer !== null) clearInterval(timer);
			timer = setInterval(() => {
				void flush();
			}, intervalMs);
			unrefTimer(timer);
		},
		async stop(): Promise<void> {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		async _flushForTest(): Promise<void> {
			await flush();
		},
	};
}

/** The inert stub the bootstrap defaults to (mirrors `noopJobQueueService`'s convention). */
export const noopMetricsService: MetricsService = Object.freeze({
	recordFilesProcessed(): void {},
	async start(): Promise<void> {},
	async stop(): Promise<void> {},
});
