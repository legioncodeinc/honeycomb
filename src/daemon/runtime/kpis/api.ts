/**
 * The `/api/kpis` API — PRD-022c (c-AC-2 / FR-2 / FR-7 / FR-8).
 *
 * KPIs are the PRD-003d `kpis` table: one row per logical `key`, written UPDATE-or-
 * INSERT-by-key. `honeycomb kpi add` + the MCP `honeycomb_kpi_add` tool POST here; a
 * `GET /api/kpis` read returns the scoped tenant's KPIs. THE c-AC-2 INVARIANT: re-adding
 * the SAME key UPDATES the existing KPI in place rather than inserting a duplicate — the
 * `updateOrInsertByKey` write primitive (SELECT-by-key → UPDATE if present, else INSERT)
 * guarantees one row per key.
 *
 * ── Where it mounts ──────────────────────────────────────────────────────────
 * `/api/kpis` is a PROTECTED group already scaffolded in `server.ts` (`protect: true`,
 * `session: false`). Attaching via `daemon.group("/api/kpis")` inherits auth/RBAC with
 * ZERO re-wiring and requires NO `x-honeycomb-session`. No edit to `server.ts`.
 *
 * ── Wiring-only (D-1) ────────────────────────────────────────────────────────
 * No new business logic and no schema — this mounts the SAME shared {@link mountKeyedGroup}
 * engine `goals/api.ts` mounts, bound to the `kpis` table instead. Goals and KPIs are the
 * identical 003d shape (`GOAL_KPI_COLUMNS_BASE`), so the one engine serves both.
 */

import type { Daemon } from "../server.js";
import {
	type KeyedApiOptions,
	keyedHealTarget,
	mountKeyedGroup,
} from "../product/keyed-engine.js";

/** The route group the KPIs API attaches to (already mounted + protected in `server.ts`). */
export const KPIS_GROUP = "/api/kpis" as const;

/** The 003d table the KPIs API reads/writes. */
export const KPIS_TABLE = "kpis" as const;

/**
 * Mount the `/api/kpis` GET + POST handlers (c-AC-2 / FR-2). Call ONCE after
 * `createDaemon(...)` / from the assembly (022d). Resolves `daemon.group("/api/kpis")` and
 * delegates to the shared keyed engine bound to the `kpis` table — so a re-add of an
 * existing key UPDATES, never duplicates (c-AC-2). No-op if the group is not mounted.
 *
 * Signature mirrors `mountGoalsApi` / `mountDashboardApi` so the composition root fires it
 * the same way (022d a-AC-2).
 */
export function mountKpisApi(daemon: Daemon, options: KeyedApiOptions): void {
	const group = daemon.group(KPIS_GROUP);
	if (group === undefined) return;
	// Thread the daemon's deployment mode so the keyed engine can apply the local-mode
	// default-scope fallback (PRD-022). An explicit `options.mode` (tests) wins.
	mountKeyedGroup(group, KPIS_TABLE, keyedHealTarget(KPIS_TABLE), {
		...options,
		mode: options.mode ?? daemon.config.mode,
	});
}
