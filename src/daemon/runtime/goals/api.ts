/**
 * The `/api/goals` API — PRD-022c (c-AC-1 / FR-1 / FR-7 / FR-8).
 *
 * Goals are the PRD-003d `goals` table: one row per logical `key`, written UPDATE-or-
 * INSERT-by-key. `honeycomb goal add` + the MCP `honeycomb_goal_add` tool POST here; a
 * `GET /api/goals` read returns the scoped tenant's goals (c-AC-1). Re-adding the same key
 * UPDATES in place — never a duplicate.
 *
 * ── Where it mounts ──────────────────────────────────────────────────────────
 * `/api/goals` is a PROTECTED group already scaffolded in `server.ts` (ROUTE_GROUPS:
 * `protect: true`, `session: false`). Attaching via `daemon.group("/api/goals")` inherits
 * the auth/RBAC middleware with ZERO re-wiring and requires NO `x-honeycomb-session` (it
 * is not a session group). No edit to `server.ts`.
 *
 * ── Wiring-only (D-1) ────────────────────────────────────────────────────────
 * This file adds NO business logic and NO schema — it resolves the route group and mounts
 * the shared {@link mountKeyedGroup} engine bound to the `goals` table + its catalog
 * {@link HealTarget}. The upsert + read + Zod + tenancy all live in `keyed-engine.ts`
 * (shared with `kpis/api.ts` to avoid duplication).
 */

import type { Daemon } from "../server.js";
import {
	type KeyedApiOptions,
	keyedHealTarget,
	mountKeyedGroup,
} from "../product/keyed-engine.js";

/** The route group the goals API attaches to (already mounted + protected in `server.ts`). */
export const GOALS_GROUP = "/api/goals" as const;

/** The 003d table the goals API reads/writes. */
export const GOALS_TABLE = "goals" as const;

/**
 * Mount the `/api/goals` GET + POST handlers (c-AC-1 / FR-1). Call ONCE after
 * `createDaemon(...)` / from the assembly (022d). Resolves `daemon.group("/api/goals")`
 * and delegates to the shared keyed engine bound to the `goals` table. If the group is not
 * mounted (unknown daemon shape) the mount is a no-op (mirrors `mountDashboardApi`).
 *
 * Signature mirrors `mountDashboardApi(daemon, { storage })` so the composition root fires
 * it the same way as the other data-API seams (022d a-AC-2).
 */
export function mountGoalsApi(daemon: Daemon, options: KeyedApiOptions): void {
	const group = daemon.group(GOALS_GROUP);
	if (group === undefined) return;
	// Thread the daemon's deployment mode so the keyed engine can apply the local-mode
	// default-scope fallback (PRD-022). An explicit `options.mode` (tests) wins.
	mountKeyedGroup(group, GOALS_TABLE, keyedHealTarget(GOALS_TABLE), {
		...options,
		mode: options.mode ?? daemon.config.mode,
	});
}
