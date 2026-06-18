/**
 * The notifications backend API — PRD-020d (daemon side, FR-3).
 *
 * The 020d notifications pipeline is a THIN CLIENT: it fetches backend notifications THROUGH THE
 * DAEMON (FR-3), never opening DeepLake. This module is the daemon-side counterpart — the single
 * named step the daemon assembly calls AFTER `createDaemon(...)` to attach the backend
 * notification handler onto the already-mounted `/api/diagnostics` route group (the daemon holds
 * the authenticated connection to the DeepLake cloud). Mirrors `attachHooksHandlers` (019b);
 * ZERO `server.ts` edits.
 *
 * Storage-correct (lives under `src/daemon/`): the handler reads the org's pending notifications
 * through the injected {@link StorageQuery}, with EVERY interpolated value escaped via the pure
 * `sql.ts` guards (`sqlStr`/`sqlIdent` — the injection floor). The 020d `BackendNotificationSource`
 * (the thin-client seam) GETs here; this is where the actual store read happens. The handler is
 * FAIL-SOFT on the wire: a non-`ok` query yields an EMPTY notifications list (never a 5xx), so a
 * transient store hiccup never blocks a session — the pipeline's ~1.5s timeout + swallow is the
 * second line of defense (FR-2 / d-AC-3).
 *
 * Deferred assembly: the production daemon assembly that owns the live storage client calls
 * {@link mountNotificationsApi} once.
 */

import type { Context } from "hono";

import { sqlIdent, sqlStr } from "../../storage/sql.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk } from "../../storage/result.js";
import type { Daemon } from "../server.js";

/** The route group the backend notifications API attaches to (already mounted, protected). */
export const NOTIFICATIONS_GROUP = "/api/diagnostics" as const;
/** The notifications sub-path under the group (`GET /api/diagnostics/notifications`). */
export const NOTIFICATIONS_PATH = "/notifications" as const;

/**
 * The wire shape the daemon serves to the 020d pipeline's `BackendNotificationSource` (FR-1 /
 * FR-3). Structurally the 020d `Notification` — defined here so the daemon side stays decoupled
 * from `src/notifications` (the daemon owns the wire contract it emits). The pipeline maps these
 * verbatim into its candidate set.
 */
export interface BackendNotification {
	/** The notification id. */
	readonly id: string;
	/** Persistent (show-once) or transient (re-emit while cause persists). */
	readonly kind: "persistent" | "transient";
	/** The banner text. */
	readonly text: string;
	/** Higher wins the primary-banner pick. */
	readonly priority: number;
	/** The persistent show-once dedup key (persistent only). */
	readonly dedupKey?: string;
}

/** Options for {@link mountNotificationsApi}. */
export interface MountNotificationsOptions {
	/** The storage client the backend notification read runs through (FR-3, never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The catalog table holding backend notifications. Defaults to `notifications`. Injected so a
	 * test points the read at a throwaway table and the production assembly names the real one;
	 * the value is guarded with `sqlIdent` either way.
	 */
	readonly table?: string;
	/** Optional per-request scope resolver (default: the `x-honeycomb-*` header reader). */
	readonly scope?: NotificationScopeResolver;
}

/** Resolve a {@link QueryScope} from the request, or `null` when the request carries no org. */
export interface NotificationScopeResolver {
	resolve(c: Context): QueryScope | null;
}

/** The default header-based scope resolver (mirrors the rest of the daemon's tenancy reader). */
export const headerScopeResolver: NotificationScopeResolver = {
	resolve(c: Context): QueryScope | null {
		const org = c.req.header("x-honeycomb-org");
		if (org === undefined || org.length === 0) return null;
		const workspace = c.req.header("x-honeycomb-workspace");
		const ws = workspace !== undefined && workspace.length > 0 ? workspace : "default";
		return { org, workspace: ws };
	},
};

/** Map one storage row to a {@link BackendNotification}, or `null` when the row is unusable. */
function rowToNotification(row: Record<string, unknown>): BackendNotification | null {
	const id = typeof row.id === "string" ? row.id : undefined;
	const text = typeof row.text === "string" ? row.text : undefined;
	if (id === undefined || text === undefined) return null;
	const kind = row.kind === "transient" ? "transient" : "persistent";
	const priority = typeof row.priority === "number" ? row.priority : Number(row.priority ?? 0) || 0;
	const dedupKey = typeof row.dedup_key === "string" ? row.dedup_key : undefined;
	return {
		id,
		kind,
		text,
		priority,
		...(dedupKey !== undefined ? { dedupKey } : {}),
	};
}

/**
 * Read the org's pending backend notifications through the storage client (FR-3). The scope's org
 * is escaped with `sqlStr` and the table name with `sqlIdent` (the injection floor). FAIL-SOFT: a
 * non-`ok` result (query error / connection / timeout) yields an EMPTY list, never a throw — the
 * endpoint answers 200 with `[]` so the session is never blocked.
 */
async function readPending(
	storage: StorageQuery,
	table: string,
	scope: QueryScope,
): Promise<readonly BackendNotification[]> {
	const sql =
		`SELECT id, kind, text, priority, dedup_key FROM ${sqlIdent(table)} ` +
		`WHERE org = ${sqlStr(scope.org)} AND status = ${sqlStr("pending")} ` +
		`ORDER BY priority DESC`;
	const result = await storage.query(sql, scope);
	if (!isOk(result)) return [];
	const out: BackendNotification[] = [];
	for (const row of result.rows) {
		const n = rowToNotification(row);
		if (n !== null) out.push(n);
	}
	return out;
}

/**
 * Attach the backend notifications handler onto the daemon's already-mounted `/api/diagnostics`
 * group (FR-3). Registers `GET /api/diagnostics/notifications` → reads the org's pending
 * notifications through `options.storage` and returns the 020d `Notification[]` wire shape. Call
 * ONCE after `createDaemon(...)`. Storage-correct: the read runs through the injected client with
 * guarded SQL; no route is registered when the group is not mounted (defensive against a partial
 * assembly).
 */
export function mountNotificationsApi(daemon: Daemon, options: MountNotificationsOptions): void {
	const group = daemon.group(NOTIFICATIONS_GROUP);
	if (group === undefined) return; // the diagnostics group is not mounted — nothing to attach to.

	const table = options.table ?? "notifications";
	const scopeResolver = options.scope ?? headerScopeResolver;

	// GET /api/diagnostics/notifications — the org's pending backend notifications (FR-3). Path is
	// RELATIVE to the group base, which the bootstrap already protected with auth/RBAC.
	group.get(NOTIFICATIONS_PATH, async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) {
			return c.json({ error: "bad_request", reason: "request carries no resolvable org scope" }, 400);
		}
		const notifications = await readPending(options.storage, table, scope);
		return c.json({ notifications });
	});
}
