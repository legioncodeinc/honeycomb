/**
 * The protected per-subsystem health-detail surface — PRD-029 Wave 1 (AC-3 / D-2).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mountDiagnosticsHealthApi(daemon, { healthDetail })` is the single named step the
 * composition root calls AFTER `createDaemon(...)` to attach `GET /api/diagnostics/health`
 * onto the ALREADY-MOUNTED, protected `/api/diagnostics` group — mirroring `mountDreamApi`
 * (`dreaming/api.ts`) and `mountLogsApi` (`logs/api.ts`). ZERO edits to `server.ts`: the
 * `/api/diagnostics` group is scaffolded + `protect:true`, so attaching via
 * `daemon.group("/api/diagnostics")` inherits the SAME auth/RBAC the JSON dashboard views
 * enforce — open in `local`, GATED in team/hybrid.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Why this exists (D-2 / AC-3) ─────────────────────────────────────────────
 * The PUBLIC `/health` is mode-gated: in team/hybrid it returns the COARSE bit only, so an
 * unauthenticated remote learns up/down but NOT the internal subsystem topology. The full
 * per-subsystem `reasons` (storage / embeddings / schema) still need a home for a team/hybrid
 * operator — so they live HERE, behind the protected diagnostics group. In team/hybrid a
 * caller must be authenticated + authorized (the group's middleware) to read the detail; in
 * `local` the group is open by design (single-user loopback), so the local operator reads it
 * freely — the same detail `local` `/health` already inlines.
 *
 * ── A clean read of cached state — NO new probe (D-4) ────────────────────────
 * The handler returns the FULL {@link HealthDetail} (status + reasons) from the injected
 * thunk, which reads the SAME cached health bit + assembly-known embed state the coarse
 * probe maintains. No `SELECT 1`, no embed round-trip, no I/O — a synchronous read of
 * already-computed state.
 *
 * ── No secret (D-5) ──────────────────────────────────────────────────────────
 * The body is the {@link HealthDetail} verbatim — a closed set of subsystem-name + state
 * string literals. There is no token, org GUID, header value, or URL in any field by
 * construction (see `health.ts`).
 */

import type { Daemon } from "./server.js";
import type { HealthDetail } from "./health.js";

/** The route the protected health detail is served at (full path `/api/diagnostics/health`). */
export const DIAGNOSTICS_HEALTH_PATH = "/health" as const;

/** The already-mounted, protected route group the detail attaches to (no `server.ts` edit). */
export const DIAGNOSTICS_HEALTH_GROUP = "/api/diagnostics" as const;

/** Options for {@link mountDiagnosticsHealthApi}. */
export interface MountDiagnosticsHealthOptions {
	/**
	 * The structured-detail thunk (PRD-029). Returns the FULL {@link HealthDetail} (status +
	 * per-subsystem `reasons`) read from the daemon's cached health bit + the assembly-known
	 * embed state — the SAME thunk `server.ts` mode-gates for the public `/health`. Here it is
	 * served WITH `reasons` regardless of mode, because the route is already behind the
	 * protected diagnostics group (gated in team/hybrid, open in local).
	 */
	readonly healthDetail: () => HealthDetail;
}

/**
 * Attach `GET /api/diagnostics/health` onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (AC-3). The handler returns the FULL {@link HealthDetail}
 * (status + reasons) — a synchronous read of cached state, no probe (D-4). Call ONCE
 * after `createDaemon(...)`. If the group is not mounted (unknown daemon shape) the
 * attach is a no-op (the route stays the 501 scaffold), mirroring `mountDreamApi`.
 */
export function mountDiagnosticsHealthApi(daemon: Daemon, options: MountDiagnosticsHealthOptions): void {
	const group = daemon.group(DIAGNOSTICS_HEALTH_GROUP);
	if (group === undefined) return;

	group.get(DIAGNOSTICS_HEALTH_PATH, (c) => {
		// The FULL detail (with reasons) — the group's auth/RBAC already gated this in
		// team/hybrid, so exposing the subsystem topology here is not a leak. No probe: the
		// thunk reads the cached bit + assembly-known embed state synchronously.
		return c.json(options.healthDetail());
	});
}
