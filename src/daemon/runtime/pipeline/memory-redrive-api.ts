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
 * The operator RE-DRIVE trigger seam — PRD-080b (b-AC-4).
 *
 * A daemon route that runs ONE {@link runMemoryRedrive} pass — re-driving every TERMINAL
 * `memory_controlled_write` job back through the controlled-write path — and returns the counts. The
 * `honeycomb memory redrive` CLI verb POSTs here. It is the SAME `runMemoryRedrive` seam wired at the
 * composition root; the route reuses it over the daemon HTTP surface rather than a second code path.
 *
 * ── It is the HTTP TRIGGER, never new re-drive logic (the dispatcher thesis) ──
 *   The handler holds NO read/commit/dedup logic and issues NO SQL. It calls the injected `redrive`
 *   closure (which OWNS the terminal-job read, the single-sourced controlled-write re-run, and the
 *   fail-soft floor) exactly once and renders the result. The route is the wiring; the closure is the work.
 *
 * ── Attaches onto the already-mounted, protected `/api/diagnostics` group (NO server.ts edit) ──
 *   Mirrors {@link import("../capture/capture-drain-api.js").mountCaptureDrainApi}: the composition root
 *   calls `mountMemoryRedriveApi(daemon, { redrive })` ONCE after `createDaemon(...)`, attaching
 *   `POST /api/diagnostics/memory-redrive` onto the `/api/diagnostics` group (session-agnostic,
 *   `protect: true` — open in `local` mode, gated in team/hybrid). If the group is not scaffolded the
 *   attach is a no-op.
 *
 * ── Fail-soft, never 500 (the maintenance posture) ───────────────────────────
 *   `runMemoryRedrive` is itself fail-soft (it swallows every read/re-run fault and returns the counts
 *   accumulated so far), so this route can only ever return a 200 with an honest count pair. A
 *   belt-and-suspenders try/catch degrades even an unexpected throw to `{ redriven: 0, skipped: 0 }` — the
 *   operator command NEVER surfaces a crash.
 */

import type { Context } from "hono";

import type { Daemon } from "../server.js";
import type { MemoryRedriveResult } from "./memory-redrive.js";

/** The route the re-drive trigger is served at (full path `/api/diagnostics/memory-redrive`). */
export const MEMORY_REDRIVE_TRIGGER_PATH = "/memory-redrive" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const MEMORY_REDRIVE_TRIGGER_GROUP = "/api/diagnostics" as const;

/** The count pair the trigger returns (the exact contract the `memory redrive` verb reads). */
export interface MemoryRedriveSummaryBody {
	/** True when the pass ran (even a zero-count pass is `ok`). */
	readonly ok: boolean;
	/** Facts recovered — re-committed / deduped / durably deferred to the outbox. */
	readonly redriven: number;
	/** Facts NOT recovered — unparseable / gate-skipped / genuine-failure. */
	readonly skipped: number;
}

/** Options for {@link mountMemoryRedriveApi}. */
export interface MountMemoryRedriveOptions {
	/** The composition-root re-drive closure (reads terminal jobs + re-runs the controlled-write path). */
	readonly redrive: () => Promise<MemoryRedriveResult>;
}

/**
 * Attach the re-drive trigger onto the daemon's already-mounted, protected `/api/diagnostics` group
 * (b-AC-4). Registers `POST /api/diagnostics/memory-redrive`, which runs ONE re-drive pass and returns
 * `{ ok, redriven, skipped }`. Call ONCE after `createDaemon(...)`. If the group is not mounted the attach
 * is a no-op. Fail-soft: the re-drive never throws, and an unexpected fault degrades to a zero-count 200
 * rather than a 500.
 */
export function mountMemoryRedriveApi(daemon: Daemon, options: MountMemoryRedriveOptions): void {
	const group = daemon.group(MEMORY_REDRIVE_TRIGGER_GROUP);
	if (group === undefined) return;

	group.post(MEMORY_REDRIVE_TRIGGER_PATH, async (c: Context) => {
		try {
			const result = await options.redrive();
			const out: MemoryRedriveSummaryBody = { ok: true, redriven: result.redriven, skipped: result.skipped };
			return c.json(out, 200);
		} catch {
			// runMemoryRedrive is already fail-soft; this is the belt-and-suspenders floor so the operator
			// command can never see a 500 — an unexpected fault reads as "nothing re-driven this pass".
			const out: MemoryRedriveSummaryBody = { ok: true, redriven: 0, skipped: 0 };
			return c.json(out, 200);
		}
	});
}
