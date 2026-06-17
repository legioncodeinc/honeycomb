/**
 * Permission middleware (PRD-004a FR-3 / FR-8 / a-AC-4 / a-AC-5 / a-AC-6).
 *
 * Mounted per route group by the server bootstrap so any handler a later module
 * attaches to a scaffolded group inherits enforcement WITHOUT re-wiring auth
 * (a-AC-6). The middleware is the seam; the auth POLICY (what a role may do) is
 * out of scope for 004a and lives behind a pluggable {@link PermissionCheck}.
 *
 * Mode behaviour (FR-3):
 *   - `local`         → open. The handler runs without a permission check (a-AC-5).
 *   - `team`/`hybrid` → enforce. The check runs BEFORE the handler; on deny the
 *                       middleware short-circuits with 403 and the handler never
 *                       runs (a-AC-4). Default posture is DEFAULT-DENY: with no
 *                       real policy wired, an unknown role is rejected, never
 *                       waved through.
 *
 * `/health` and `/api/status` mount NO permission middleware at all (FR-3), so
 * this middleware is never on their path.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { DeploymentMode } from "../config.js";

/**
 * The pluggable policy seam. Given the request's resolved auth context, return
 * whether it is permitted. 004a ships a default-deny stub; the real auth module
 * (out of scope here) replaces it without touching this middleware. Sync or
 * async so a real policy can hit storage.
 */
export type PermissionCheck = (ctx: PermissionContext) => boolean | Promise<boolean>;

/** The minimal auth context the permission check sees. No token is exposed. */
export interface PermissionContext {
	/** The role asserted by the request, if any (resolved from auth — stub: header). */
	readonly role?: string;
	/** The resolved org, if any. */
	readonly org?: string;
	/** The resolved workspace, if any. */
	readonly workspace?: string;
	/** The agent scope asserted by the request, if any. */
	readonly agent?: string;
	/** The route group label this check guards (for policy + diagnostics). */
	readonly group: string;
}

/**
 * Resolve the {@link PermissionContext} from the request. 004a reads it from
 * headers as a stand-in for the real auth module: `x-honeycomb-role`,
 * `x-honeycomb-org`, `x-honeycomb-workspace`, `x-honeycomb-agent`. The real auth
 * module swaps this resolver; the middleware shape does not change. The bearer
 * token is intentionally NOT read or stored here — token verification is the
 * auth module's job, not this seam's.
 */
function resolvePermissionContext(c: Context, group: string): PermissionContext {
	const header = (name: string): string | undefined => {
		const v = c.req.header(name);
		return v !== undefined && v.length > 0 ? v : undefined;
	};
	return {
		role: header("x-honeycomb-role"),
		org: header("x-honeycomb-org"),
		workspace: header("x-honeycomb-workspace"),
		agent: header("x-honeycomb-agent"),
		group,
	};
}

/**
 * The default-deny permission check (the 004a stub). In the absence of the real
 * auth policy, no role is recognized, so every `team`/`hybrid` request to a
 * protected group is denied. This is the fail-closed posture: a missing policy
 * must never default to allow. The real auth module supplies a check that
 * recognizes roles and scopes (out of scope for 004a).
 */
export const defaultDenyPermissionCheck: PermissionCheck = () => false;

/**
 * Build the permission middleware for one route group. Closes over the mode
 * accessor and the pluggable check. The mode is read at request time (via a
 * thunk), so a single mounted middleware respects a mode resolved per the
 * running daemon — and tests can construct daemons in different modes against
 * the same middleware factory.
 *
 * @param group the route-group label (e.g. `/api/memories`) this guards.
 * @param getMode returns the daemon's current deployment mode.
 * @param check the pluggable policy (default: default-deny).
 */
export function permissionMiddleware(
	group: string,
	getMode: () => DeploymentMode,
	check: PermissionCheck = defaultDenyPermissionCheck,
): MiddlewareHandler {
	return async (c: Context, next: Next): Promise<void | Response> => {
		const mode = getMode();
		// local mode: open. The handler runs with no permission check (a-AC-5).
		if (mode === "local") {
			await next();
			return;
		}
		// team / hybrid: enforce BEFORE the handler (a-AC-4).
		const permitted = await check(resolvePermissionContext(c, group));
		if (!permitted) {
			// Short-circuit: returning a Response here means `next()` is never
			// called, so the downstream handler does not run (a-AC-4 / d-AC-7
			// fail-closed-before-handler posture relied on by 004d).
			return c.json(
				{ error: "forbidden", reason: "permission denied", group },
				403,
			);
		}
		await next();
	};
}
