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
 * In-process counter for capture events that were acked to the hook but failed to
 * persist (batched flush / batch-insert failures). Threaded from the composition root
 * into the capture handler (increment on loss) and the `/health` + dashboard KPI seams
 * (read-only). Fail-soft: counting never throws and never blocks capture.
 */

/** A monotonic dropped-events counter (process-local, since daemon boot). */
export interface CaptureDroppedEventsCounter {
	/** Record one or more acked-but-lost events (defaults to 1). */
	increment(by?: number): void;
	/** The current total since boot. */
	read(): number;
}

/** Build a fresh in-memory dropped-events counter. */
export function createCaptureDroppedEventsCounter(): CaptureDroppedEventsCounter {
	let total = 0;
	return {
		increment(by = 1): void {
			const delta = Number.isFinite(by) ? Math.max(0, Math.trunc(by)) : 0;
			if (delta === 0) return;
			total += delta;
		},
		read(): number {
			return total;
		},
	};
}
