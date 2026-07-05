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
 * In-process counter for capture events GATED by the PRD-073 dormant-capture ladder — PRD-073b
 * (b-AC-3.1). Mirrors {@link import("./dropped-events.js").CaptureDroppedEventsCounter}: threaded
 * from the composition root into the capture handler (increment on a gated event, partitioned by
 * reason) and read by the `/health` detail seam so the dogfood probe can assert "N captures were
 * gated" per reason instead of inferring from absence. Process-local (reset on restart). Fail-soft:
 * counting never throws and never blocks capture.
 */

/** The machine-readable reasons a capture is gated by the 073 dormancy ladder. */
export type GatedCaptureReason = "no_bound_project" | "tenancy_unconfirmed";

/** The per-reason gated totals since boot (a closed, secret-free shape). */
export interface GatedCaptureCounts {
	/** Captures gated because the session cwd resolved to no bound project (073a). */
	readonly no_bound_project: number;
	/** Captures gated because tenancy was not confirmed (073c). */
	readonly tenancy_unconfirmed: number;
}

/** A monotonic gated-captures counter, partitioned by reason (process-local, since boot). */
export interface GatedCapturesCounter {
	/** Record one gated capture under the given reason. */
	increment(reason: GatedCaptureReason): void;
	/** The current per-reason totals since boot. */
	read(): GatedCaptureCounts;
	/** The sum across all reasons since boot. */
	total(): number;
}

/** Build a fresh in-memory gated-captures counter (all reasons start at 0). */
export function createGatedCapturesCounter(): GatedCapturesCounter {
	const counts = { no_bound_project: 0, tenancy_unconfirmed: 0 };
	return {
		increment(reason: GatedCaptureReason): void {
			counts[reason] += 1;
		},
		read(): GatedCaptureCounts {
			return { no_bound_project: counts.no_bound_project, tenancy_unconfirmed: counts.tenancy_unconfirmed };
		},
		total(): number {
			return counts.no_bound_project + counts.tenancy_unconfirmed;
		},
	};
}
