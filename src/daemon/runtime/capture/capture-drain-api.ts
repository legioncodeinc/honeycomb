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
 * The operator FORCE-DRAIN trigger seam — PRD-079b (b-AC-4).
 *
 * A daemon route that forces ONE {@link CaptureOutbox.drainDue} pass and returns the counts. The
 * `honeycomb capture drain` CLI verb POSTs here; the dashboard could call it too. It is the SAME
 * `drainDue` seam the background interval + the recovery kick (b-AC-3) run — the operator command
 * reuses it over the daemon HTTP surface rather than a second code path.
 *
 * ── It is the HTTP TRIGGER, never new drain logic (the dispatcher thesis) ─────
 *   The handler holds NO re-append/backoff/dead-letter logic and issues NO SQL. It calls the
 *   already-constructed outbox's `drainDue()` (which OWNS the guarded SQL, the bounded backoff, the
 *   dead-letter transition, and the fail-soft floor) exactly once and renders the result. The route
 *   is the wiring; the outbox is the work.
 *
 * ── Attaches onto the already-mounted, protected `/api/diagnostics` group (NO server.ts edit) ──
 *   Mirrors {@link import("../maintenance/compact-api.js").mountCompactApi}: the composition root
 *   calls `mountCaptureDrainApi(daemon, { outbox })` ONCE after `createDaemon(...)`, attaching
 *   `POST /api/diagnostics/capture-drain` onto the `/api/diagnostics` group (session-agnostic,
 *   `protect: true` — open in `local` mode, gated in team/hybrid). If the group is not scaffolded
 *   (unknown daemon shape) the attach is a no-op.
 *
 * ── Fail-soft, never 500 (the maintenance posture) ───────────────────────────
 *   `drainDue()` is itself fail-soft (it swallows every fault and returns zero-counts on a bad pass),
 *   so this route can only ever return a 200 with an honest count triple. A belt-and-suspenders
 *   try/catch degrades even an unexpected throw to `{ drained: 0, retried: 0, deadLettered: 0 }` —
 *   the operator command NEVER surfaces a crash.
 */

import type { Context } from "hono";

import type { Daemon } from "../server.js";
import type { CaptureOutbox } from "./capture-outbox.js";

/** The route the force-drain trigger is served at (full path `/api/diagnostics/capture-drain`). */
export const CAPTURE_DRAIN_TRIGGER_PATH = "/capture-drain" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const CAPTURE_DRAIN_TRIGGER_GROUP = "/api/diagnostics" as const;

/** The count triple the trigger returns (the exact contract the `capture drain` verb reads). */
export interface CaptureDrainSummaryBody {
	/** True when the pass ran (even a zero-count pass is `ok`). */
	readonly ok: boolean;
	/** Rows re-appended OK and removed from the outbox this pass. */
	readonly drained: number;
	/** Rows whose re-append failed this pass and stayed pending (attempts bumped + backoff pushed). */
	readonly retried: number;
	/** Rows moved to terminal `dead` this pass (hit `maxAttempts` OR exceeded `maxAgeMs`). */
	readonly deadLettered: number;
}

/** Options for {@link mountCaptureDrainApi}. */
export interface MountCaptureDrainOptions {
	/** The already-constructed durable capture outbox whose `drainDue` this route forces. */
	readonly outbox: CaptureOutbox;
}

/**
 * Attach the force-drain trigger onto the daemon's already-mounted, protected `/api/diagnostics`
 * group (b-AC-4). Registers `POST /api/diagnostics/capture-drain`, which forces ONE `drainDue` pass
 * and returns `{ ok, drained, retried, deadLettered }`. Call ONCE after `createDaemon(...)`. If the
 * group is not mounted the attach is a no-op. Fail-soft: the drain never throws, and an unexpected
 * fault degrades to a zero-count 200 rather than a 500.
 */
export function mountCaptureDrainApi(daemon: Daemon, options: MountCaptureDrainOptions): void {
	const group = daemon.group(CAPTURE_DRAIN_TRIGGER_GROUP);
	if (group === undefined) return;

	group.post(CAPTURE_DRAIN_TRIGGER_PATH, async (c: Context) => {
		try {
			const result = await options.outbox.drainDue();
			const out: CaptureDrainSummaryBody = {
				ok: true,
				drained: result.drained,
				retried: result.retried,
				deadLettered: result.deadLettered,
			};
			return c.json(out, 200);
		} catch {
			// drainDue is already fail-soft; this is the belt-and-suspenders floor so the operator
			// command can never see a 500 — an unexpected fault reads as "nothing drained this pass".
			const out: CaptureDrainSummaryBody = { ok: true, drained: 0, retried: 0, deadLettered: 0 };
			return c.json(out, 200);
		}
	});
}
