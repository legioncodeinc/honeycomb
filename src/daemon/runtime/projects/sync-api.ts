/**
 * The registry → cache sync HTTP trigger seam — PRD-049d.
 *
 * The daemon endpoint that refreshes the LOCAL `~/.deeplake/projects.json` cache from the
 * workspace's `projects` registry (049a). It is the single named step the daemon assembly calls
 * AFTER `createDaemon(...)` to attach `POST /api/diagnostics/projects-sync` onto the ALREADY-MOUNTED,
 * protected `/api/diagnostics` group — mirroring `mountPollinateApi` (024) and `mountCompactApi`
 * (030). ZERO edits to `server.ts`: the `/api/diagnostics` group is scaffolded + `protect:true`, so
 * attaching via `daemon.group("/api/diagnostics")` inherits the same auth/RBAC the JSON dashboard
 * views enforce (open in `local`, gated in team/hybrid — D-4).
 *
 * ── It is the HTTP TRIGGER, never new sync logic ────────────────────────────
 * The handler reuses {@link syncRegistryToCache} (the fail-soft 049d sync): it resolves the request
 * scope (header org/workspace, or the daemon `defaultScope`), runs the registry read + cache write,
 * and returns a small JSON ack. The CLI (`honeycomb project list/status` after a refresh) and the
 * 049e dashboard switcher both call this so the thin-client resolver matches the workspace's real
 * projects offline. The mechanism (the read + the merge-preserving write) lives in
 * {@link syncRegistryToCache}; this is only the trigger.
 *
 * ── The ack shape (the contract the CLI/049e dashboard call) ────────────────
 *   `{ synced: true,  projectCount }`        — the registry was read + the cache refreshed.
 *   `{ synced: false, reason }`              — the registry could not be read (a redacted storage
 *                                              `kind`/message); the prior cache is left intact. A
 *                                              clean 200 ack, NEVER a 500 (fail-soft parity).
 * The ack carries NO token, secret, or header value (D-4) — only the decision + a short reason.
 *
 * ── Fail-soft, never 500 (D-4) ──────────────────────────────────────────────
 * A request with no resolvable tenancy fails closed at the edge (400), consistent with the sibling
 * diagnostics handlers. Any sync outcome — even a registry-read failure — is a clean ack, because
 * the cache it backs is itself fail-soft on read (a stale/missing cache resolves to the inbox).
 */

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import { getRequestIdentity } from "../middleware/permission.js";
import { syncRegistryToCache } from "./registry-sync.js";

/** The route the sync trigger is served at (full path `/api/diagnostics/projects-sync`). */
export const PROJECTS_SYNC_PATH = "/projects-sync" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const PROJECTS_SYNC_GROUP = "/api/diagnostics" as const;

/** Options for {@link mountProjectsSyncApi}. */
export interface MountProjectsSyncOptions {
	/** The live storage client the sync reads the `projects` registry through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's own tenancy partition the cache is synced for when the request carries no
	 * `x-honeycomb-org` header (the local-mode loopback posture, same as the sibling triggers).
	 */
	readonly defaultScope: QueryScope;
	/** Override the cache directory the sync writes (tests). Defaults to `~/.deeplake`. */
	readonly dir?: string;
}

/** The ack body the sync trigger returns (the exact contract the CLI / 049e dashboard read). */
export interface ProjectsSyncAck {
	/** True when the registry was read and the cache refreshed; false on a fail-soft skip. */
	readonly synced: boolean;
	/** The number of registry projects mirrored into the cache (present on success). */
	readonly projectCount?: number;
	/** A short machine reason (present on a fail-soft skip); carries no token/secret. */
	readonly reason?: string;
}

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * Resolve the per-request tenancy scope, falling back to the daemon's `defaultScope` when the
 * request carries no `x-honeycomb-org` header (the local-mode posture: a loopback CLI/dashboard call
 * need not stamp the org). Returns `null` ONLY when neither a header org NOR a default org is present
 * — fail-closed. Mirrors `resolveTriggerScope` in `pollinating/api.ts` (the shared idiom).
 *
 * ── Cross-tenant hardening (PRD-022 / PRD-049d) ──────────────────────────────
 * In team/hybrid the `/api/diagnostics` group is `protect:true`, so the permission middleware has
 * already AUTHENTICATED the request and stamped the VALIDATED {@link import("../auth/contracts.js").Identity}.
 * This handler reads + writes the LOCAL `projects.json` cache for the resolved org/workspace, so a
 * header that disagrees with the token's own org would let an authenticated caller for org A point
 * the sync at org B's tenancy. The hard org/workspace partition still rejects the forged org at the
 * DeepLake backend (the bearer token is bound to A's org), but — exactly as
 * {@link import("../scope.js").resolveScopeFromHeaders} does for the data handlers — we ALSO reject the
 * mismatch HERE, before the storage call: a forged `x-honeycomb-org` falls back to the daemon's own
 * `defaultScope` rather than being honored. In local mode no Identity is stamped, so the prior
 * pure-header loopback behaviour is unchanged.
 */
function resolveSyncScope(c: Context, defaultScope: QueryScope): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org !== undefined && org.length > 0) {
		// Cross-tenant guard: never honor a header org that disagrees with the validated token org.
		const identity = getRequestIdentity(c);
		if (identity === undefined || org === identity.org) {
			const workspace = c.req.header("x-honeycomb-workspace");
			return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
		}
	}
	return defaultScope.org.length > 0 ? defaultScope : null;
}

/**
 * Attach the registry → cache sync trigger onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (PRD-049d). Registers `POST /api/diagnostics/projects-sync`, which
 * resolves the request scope (header org/workspace or the daemon default — fail-closed) and runs the
 * fail-soft {@link syncRegistryToCache}. Call ONCE after `createDaemon(...)`. If the group is not
 * mounted (unknown daemon shape) the attach is a no-op. Always a clean 200/400 ack — never a 500.
 */
export function mountProjectsSyncApi(daemon: Daemon, options: MountProjectsSyncOptions): void {
	const group = daemon.group(PROJECTS_SYNC_GROUP);
	if (group === undefined) return;

	group.post(PROJECTS_SYNC_PATH, async (c) => {
		const scope = resolveSyncScope(c, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		const result = await syncRegistryToCache({
			storage: options.storage,
			scope,
			...(options.dir !== undefined ? { dir: options.dir } : {}),
		});
		const ack: ProjectsSyncAck = result.ok
			? { synced: true, projectCount: result.projectCount }
			: { synced: false, reason: result.reason };
		return c.json(ack, 200);
	});
}
