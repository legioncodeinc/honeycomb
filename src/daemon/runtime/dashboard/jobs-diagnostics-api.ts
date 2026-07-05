/**
 * The durable-job-queue observability read — `GET /api/diagnostics/jobs` (job-observability).
 *
 * A CURRENT-status breakdown of the durable `memory_jobs` queue by kind + status, so an operator
 * can see a stuck or backlogged queue in ONE query instead of guessing. (Context: 400+
 * `memory_extraction` jobs sat `queued` and completely invisible — no endpoint, no logging. This is
 * the endpoint that makes that answerable.)
 *
 * ── Attaches to the already-mounted, protected group (no `server.ts` edit) ───────────────────
 *   Like {@link mountPollinateApi} and {@link mountLocalQueueDiagnosticsApi}, this registers onto the
 *   ALREADY-MOUNTED, `protect:true` `/api/diagnostics` group via `daemon.group("/api/diagnostics")`,
 *   so it inherits the same operator-only auth/RBAC the dashboard's JSON views enforce (open in
 *   `local`, gated in team/hybrid). No extra auth wiring. If the group is not mounted (an unknown
 *   daemon shape) the attach is a no-op.
 *
 * ── Read-only + fail-soft (NEVER a 500) ─────────────────────────────────────────────────────
 *   The handler awaits `queue.stats()` — a pure read that leases/mutates nothing — and returns the
 *   `{ byKind, total }` snapshot at 200. If `stats()` throws (a connectivity blip, an unavailable
 *   queue) the handler degrades to a clean `{ byKind: [], total: 0, error: "unavailable" }` at 200,
 *   never a 500: an observability endpoint must not itself become a failure the operator has to
 *   debug. The snapshot carries NO secret — only kind names + integer counts.
 */

import type { Daemon } from "../server.js";
import type { JobKindStats, JobQueueService } from "../services/job-queue.js";

/** The already-mounted, protected route group the jobs read attaches to (no `server.ts` edit). */
export const JOBS_DIAGNOSTICS_GROUP = "/api/diagnostics" as const;

/** The route the jobs snapshot is served at (full path `/api/diagnostics/jobs`). */
export const JOBS_DIAGNOSTICS_PATH = "/jobs" as const;

/** Options for {@link mountJobsDiagnosticsApi}. */
export interface MountJobsDiagnosticsOptions {
	/** The daemon's own durable job queue (`daemon.services.queue`) whose CURRENT-status snapshot to read. */
	readonly queue: JobQueueService;
}

/** The body shape the jobs read returns (the `{ byKind, total }` snapshot, plus a fail-soft `error`). */
export interface JobsDiagnosticsBody {
	/** Per-kind current-status breakdown (empty on the fail-soft path). */
	readonly byKind: readonly JobKindStats[];
	/** Total current jobs across all kinds (0 on the fail-soft path). */
	readonly total: number;
	/** Present ONLY on the fail-soft path: the snapshot was unavailable this read. */
	readonly error?: "unavailable";
}

/**
 * Attach the durable-queue observability read onto the daemon's already-mounted, protected
 * `/api/diagnostics` group. Registers `GET /api/diagnostics/jobs`, which returns the queue's
 * CURRENT-status breakdown by kind + status. Call ONCE after `createDaemon(...)`. If the group is
 * not mounted the attach is a no-op. Fail-soft: a `stats()` throw returns a clean empty snapshot at
 * 200, never a 500.
 */
export function mountJobsDiagnosticsApi(daemon: Daemon, options: MountJobsDiagnosticsOptions): void {
	const group = daemon.group(JOBS_DIAGNOSTICS_GROUP);
	if (group === undefined) return;

	group.get(JOBS_DIAGNOSTICS_PATH, async (c) => {
		try {
			const { byKind, total } = await options.queue.stats();
			return c.json({ byKind, total } satisfies JobsDiagnosticsBody, 200);
		} catch {
			// Fail-soft: an observability read must never surface as a 500. A queue/connectivity
			// failure degrades to a clean empty snapshot the operator can distinguish by `error`.
			return c.json({ byKind: [], total: 0, error: "unavailable" } satisfies JobsDiagnosticsBody, 200);
		}
	});
}
