/**
 * The Sync-page mount seam — PRD-042 (the daemon-side attach, mirroring `mountDashboardApi`).
 *
 * Attaches the Sync page's READ view-model + the WRITE action endpoints onto the daemon's
 * already-mounted, protected `/api/diagnostics` group (the dashboard view-model group) — ZERO
 * `server.ts` edits, inheriting the group's auth/RBAC + the local-mode scope fallback exactly like
 * {@link import("./api.js").mountDashboardApi} and {@link import("./harness-api.js").mountHarnessApi}:
 *
 *   - `GET  /api/diagnostics/assets`        → the `installed ∪ synced` union view-model (skills + agents).
 *   - `POST /api/diagnostics/sync/promote`  → publish a version-bumped row (→ `shared`, poll-convergent).
 *   - `POST /api/diagnostics/sync/pull`     → pull + install-target write (→ `pulled`).
 *   - `POST /api/diagnostics/sync/demote`   → tombstone version-bump (→ no longer live `shared`).
 *   - `POST /api/diagnostics/sync/enable`   → (re)install local presence on disk.
 *   - `POST /api/diagnostics/sync/disable`  → remove local presence on disk.
 *
 * ── Activity emission (042c c-OQ-2) ──────────────────────────────────────────
 * The action POSTs land on `/api/diagnostics/sync/*`, and the daemon's request-logging middleware
 * (`server.ts`) records EVERY request (method + path + status, no secret) into the `/api/logs` ring
 * buffer. So each promote/pull/demote naturally EMITS a `/api/logs` record at its seam — the activity
 * feed (042c) filters the ring buffer to `/sync/` paths. No parallel event store is added (D-6).
 *
 * ── Tenancy is authenticated, never body-asserted (parent SECURITY, mirrors `mountAssetsApi`) ──
 * Each action resolves its {@link AssetScope} through {@link resolveActionScope}: in team/hybrid the
 * VALIDATED {@link Identity}'s org/workspace/agentId win and a body org that disagrees is rejected
 * (fail-closed 400); in local mode the body + the daemon's `defaultScope` fallback apply (single
 * loopback tenant). A request with no resolvable org → 400. The view-model read resolves its
 * QueryScope the SAME way `mountDashboardApi` does (`resolveScopeOrLocalDefault`).
 *
 * ── No secret crosses the boundary (parent AC-7 / D-5) ───────────────────────
 * The view-model rows carry NO `native` blob, author EMAIL, or org GUID (see `sync-api.ts`). The
 * action responses carry only the action/kind/id/state/version — no token, no blob, no email. Every
 * new SQL the engine builds goes through `sqlIdent`/`sLiteral` (the substrate engine + the read-back
 * `buildCurrentAssetVersionSql`), so `audit:sql` stays clean.
 */

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { DeploymentMode } from "../config.js";
import { getRequestIdentity } from "../middleware/permission.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type { Daemon } from "../server.js";
import { type AssetScope, type AssetSyncApi } from "../assets/contracts.js";
import { type SyncedAssetType, SYNCED_ASSET_TYPES } from "../../storage/catalog/synced-assets.js";
import { type AssetInstallTarget } from "./asset-install-target.js";
import {
	type SyncActionApi,
	type SyncActionRequest,
	type SyncActionResult,
	createSyncActionApi,
	fetchAssetSyncView,
} from "./sync-api.js";

/** The route group the Sync page attaches to (already mounted + protected in `server.ts`). */
export const SYNC_GROUP = "/api/diagnostics" as const;

/** Options for {@link mountSyncApi}. */
export interface MountSyncOptions {
	/** The storage client the view + actions run through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope (the single local tenant). Backfills a request
	 * with no `x-honeycomb-org` header in `local` mode (mirrors `mountDashboardApi`). NEVER consulted
	 * outside local mode.
	 */
	readonly defaultScope?: QueryScope;
	/**
	 * The deployment mode. In team/hybrid the action tenancy is taken from the VALIDATED Identity,
	 * never the body (the cross-tenant guard). Defaults to `local` for a unit-constructed mount.
	 */
	readonly mode?: DeploymentMode;
	/**
	 * The action engine — defaults to the real {@link createSyncActionApi} over `{ storage }`. A test
	 * injects an engine bound to a throwaway substrate table + a temp-dir install target.
	 */
	readonly actionApi?: SyncActionApi;
	/** The substrate engine the default action API is built over (a live itest injects a throwaway target). */
	readonly substrateEngine?: AssetSyncApi;
	/** The install target the default action API writes through (a test injects a temp-dir target). */
	readonly installTarget?: AssetInstallTarget;
}

/** The 400 body a handler returns when the request carries no resolvable org (fail-closed). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** The 400 body for a malformed action body. */
function badBody(c: Context, reason: string): Response {
	return c.json({ error: "bad_request", reason }, 400);
}

/**
 * Attach the Sync view-model + action handlers onto the daemon's `/api/diagnostics` group. Call ONCE
 * after `createDaemon(...)`. A request with no resolvable tenancy 400s. If the group is not mounted
 * (unknown daemon shape) the attach is a no-op (mirrors `mountDashboardApi`).
 */
export function mountSyncApi(daemon: Daemon, options: MountSyncOptions): void {
	const group = daemon.group(SYNC_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const defaultScope = options.defaultScope;
	const mode: DeploymentMode = options.mode ?? daemon.config.mode;
	const actionApi: SyncActionApi =
		options.actionApi ?? createSyncActionApi({ storage, engine: options.substrateEngine, installTarget: options.installTarget });

	const resolveQueryScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, defaultScope);

	// ── GET /api/diagnostics/assets — the union view-model (skills + agents). ──
	group.get("/assets", async (c) => {
		const scope = resolveQueryScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		// The viewer's author token (for `authoredByMe`) is the validated Identity's agentId in
		// team/hybrid, else the local default scope's workspace-author convention (the single tenant).
		const viewerAuthor = resolveViewerAuthor(c, defaultScope, mode);
		return c.json(await fetchAssetSyncView(storage, scope, viewerAuthor));
	});

	// ── The five action endpoints (keyed by asset_type in the body). ──
	const action = (
		kind: keyof SyncActionApi,
	): ((c: Context) => Promise<Response>) => {
		return async (c: Context): Promise<Response> => {
			const body = await readJson(c);
			if (body === null) return badBody(c, `${kind} body must be JSON`);
			const req = parseActionRequest(c, body, defaultScope, mode);
			if (req === null) return badBody(c, `${kind} body is missing required fields or its tenancy is not authorized`);
			const res: SyncActionResult = await actionApi[kind](req);
			return c.json(res);
		};
	};

	group.post("/sync/promote", action("promote"));
	group.post("/sync/pull", action("pull"));
	group.post("/sync/demote", action("demote"));
	group.post("/sync/enable", action("enable"));
	group.post("/sync/disable", action("disable"));
}

/**
 * Resolve the {@link AssetScope} an action runs under — AUTHENTICATED, never body-asserted (mirrors
 * `mountAssetsApi`'s `resolveScope`). team/hybrid: the validated Identity's org/workspace/agentId
 * win; a body org that disagrees with the token → `null` (400). local: the body + `defaultScope`
 * fallback (single tenant).
 */
function resolveActionScope(
	c: Context,
	raw: unknown,
	defaultScope: QueryScope | undefined,
	mode: DeploymentMode,
): AssetScope | null {
	const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const bodyOrg = pickString(obj.org);
	const deviceId = pickString(obj.deviceId) ?? "";

	const identity = getRequestIdentity(c);
	if (identity !== undefined) {
		if (bodyOrg !== undefined && bodyOrg !== identity.org) return null;
		return { org: identity.org, workspace: identity.workspace, author: identity.agentId, deviceId };
	}

	const org = bodyOrg ?? defaultScope?.org ?? "";
	if (org === "") return null;
	const workspace = pickString(obj.workspace) ?? defaultScope?.workspace ?? "default";
	const author = pickString(obj.author) ?? "";
	return { org, workspace, author, deviceId };
}

/**
 * Resolve the viewer's author token for the `authoredByMe` flag on the read view. In team/hybrid the
 * validated Identity's agentId is authoritative; in local mode there is one tenant, so the author is
 * the (loopback) caller — the local default has no distinct author, so we return `""` (no row reads
 * as authored-by-someone-else-only in local; the page enables Demote for local-mode single-user).
 * This is presentation-only — it never partitions storage.
 */
function resolveViewerAuthor(c: Context, defaultScope: QueryScope | undefined, mode: DeploymentMode): string {
	const identity = getRequestIdentity(c);
	if (identity !== undefined) return identity.agentId;
	// Local mode: a single loopback user. Returning `""` makes only rows with an empty author read as
	// "mine"; to keep the dogfood Demote usable for the local author, treat the default workspace as
	// the local author token when present (mirrors how the local CLI resolves its author identity).
	return defaultScope?.workspace ?? "";
}

/**
 * Parse a {@link SyncActionRequest} from a body, or `null` when a required field is missing/invalid.
 * `assetType` MUST be a valid `SyncedAssetType` and `name` non-empty; the scope resolves
 * authenticated. The `native`/`honeycombId`/`harness`/`contentHash` are optional (promote sends
 * `native`; pull/demote send `honeycombId`).
 */
function parseActionRequest(
	c: Context,
	body: Record<string, unknown>,
	defaultScope: QueryScope | undefined,
	mode: DeploymentMode,
): SyncActionRequest | null {
	const assetType = pickAssetType(body.assetType);
	const name = pickString(body.name);
	const scope = resolveActionScope(c, body.scope, defaultScope, mode);
	if (assetType === null || name === undefined || scope === null) return null;
	return {
		assetType,
		name,
		native: pickString(body.native),
		honeycombId: pickString(body.honeycombId),
		harness: pickString(body.harness),
		contentHash: pickString(body.contentHash),
		scope,
	};
}

/** Read + JSON-parse a POST body, or `null` on a non-JSON / unparseable body. */
async function readJson(c: Context): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await c.req.json();
		if (typeof body !== "object" || body === null) return null;
		return body as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** A non-empty string value, or `undefined`. */
function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A valid {@link SyncedAssetType}, or `null`. */
function pickAssetType(value: unknown): SyncedAssetType | null {
	return typeof value === "string" && (SYNCED_ASSET_TYPES as readonly string[]).includes(value)
		? (value as SyncedAssetType)
		: null;
}
