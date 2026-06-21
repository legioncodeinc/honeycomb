/**
 * The daemon `/api/assets` API — PRD-033c (FR-1 / FR-2 / FR-6 / FR-8).
 *
 * ── The surface (the ONLY DeepLake access for the substrate, D-6) ────────────
 * This module mounts the publish/pull/tombstone wire contract (`./contracts.ts`).
 * The handlers are the SOLE path to the `synced_assets` table — the thin-client side
 * (`createLoopbackAssetSyncApi` + `pullAndInstall`) reaches them over loopback HTTP
 * and never opens DeepLake (D-6). Three routes, mirroring the secrets/settings mounts:
 *
 *   - `POST /api/assets/publish`    → append a version-bumped row (c-AC-1 / FR-1);
 *   - `POST /api/assets/pull`       → select newer audience-matched rows (FR-2 / FR-7);
 *   - `POST /api/assets/tombstone`  → append a `tombstone='true'` row (c-AC-5 / FR-6).
 *
 * ── Where it mounts ──────────────────────────────────────────────────────────
 * `/api/assets` is a PROTECTED group (server.ts ROUTE_GROUPS: `protect: true`,
 * `session: false`). Attaching via `daemon.group("/api/assets")` inherits the PRD-011
 * auth/RBAC middleware with ZERO re-wiring — exactly the `/api/secrets` + `/api/settings`
 * pattern. The route group MUST be declared in `server.ts` (this PRD adds it); if the
 * group is not mounted the mount is a no-op (mirrors `mountSettingsApi`).
 *
 * ── Scope resolution (tenancy + audience) ────────────────────────────────────
 * Each request body carries its OWN {@link AssetScope} (org/workspace/author/deviceId)
 * — the lifecycle (033b) and the thin client build it from the resolved credential +
 * device identity. The handler reads it from the body. A `defaultScope` (the daemon's
 * local tenant, threaded at assembly) backfills a missing org/workspace in `local` mode
 * so a loopback thin client that carries no tenancy still resolves the single tenant —
 * mirroring the data-API mounts. A request with no resolvable org → 400 (fail-closed).
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 * This module builds NO SQL — it parses + validates the request and delegates to the
 * {@link AssetSyncApi} engine (`./sync.ts`), which owns the guarded storage path.
 */

import type { Context, Hono } from "hono";

import type { QueryScope } from "../../storage/client.js";
import type { DeploymentMode } from "../config.js";
import { getRequestIdentity } from "../middleware/permission.js";
import type { Daemon } from "../server.js";
import {
	type AssetScope,
	type AssetSyncApi,
	type LatticeCell,
	type PublishRequest,
	type PullRequest,
	type Style,
	type SyncedAssetType,
	SYNCED_ASSET_TYPES,
	type TombstoneRequest,
	TIERS,
	STYLES,
} from "./contracts.js";
import { type AssetSyncEngineDeps, createAssetSyncApi } from "./sync.js";

/** The route group the assets API attaches to (declared + protected in `server.ts`). */
export const ASSETS_GROUP = "/api/assets" as const;

/** Construction deps for the assets API. Everything injected for testability. */
export interface AssetsApiDeps {
	/**
	 * The asset-sync engine the handlers delegate to (the ONLY DeepLake path, D-6).
	 * Production builds it from `{ storage }` (the live client + the catalog table); a
	 * live itest injects an engine bound to a throwaway `ci_assets_<run>` target. When
	 * an `engine` is supplied it wins; otherwise it is built from {@link AssetsApiDeps.sync}.
	 */
	readonly engine?: AssetSyncApi;
	/** The engine build deps (storage + optional throwaway target + trusted-table probe). */
	readonly sync?: AssetSyncEngineDeps;
	/**
	 * The daemon's resolved default tenancy scope (the single local tenant). Backfills a
	 * request whose body omits org/workspace in `local` mode (mirrors the data-API mounts).
	 */
	readonly defaultScope?: QueryScope;
	/**
	 * The daemon's deployment mode (PRD-033 SECURITY remediation). In `team`/`hybrid` the
	 * request's tenancy (org/workspace/author) is taken from the VALIDATED {@link Identity}
	 * the permission middleware stamped, NEVER from the request body — a body-forged
	 * `org`/`author` can therefore never partition storage to (or address the Device audience
	 * of) a tenant the caller's token does not bind to. In `local` mode no Identity is stamped
	 * (loopback single-user), so the body + {@link AssetsApiDeps.defaultScope} fallback applies,
	 * exactly the data-API posture. Defaults to `local` for a unit-constructed mount (the prior
	 * body-trust behaviour is preserved ONLY where there is provably one local tenant).
	 */
	readonly mode?: DeploymentMode;
}

/**
 * Mount the `/api/assets` handlers onto a route group (FR-1 / FR-2 / FR-6). Call AFTER
 * `createDaemon` with `daemon.group("/api/assets")` so the handlers inherit the
 * already-mounted auth/RBAC middleware. The three routes register relative to the base.
 *
 * ── Tenancy is authenticated, not body-asserted (PRD-033 SECURITY) ───────────
 * Each handler resolves the request {@link AssetScope} through {@link resolveScope}, which in
 * team/hybrid mode OVERRIDES the body-supplied org/workspace/author with the VALIDATED
 * {@link Identity}'s own org/workspace/agentId (mirrors `resolveScopeFromHeaders`'s
 * cross-tenant guard). A request whose body org disagrees with the token is fail-closed (400).
 */
export function mountAssetsGroup(group: Hono, deps: AssetsApiDeps): void {
	const engine = deps.engine ?? buildEngine(deps);
	const defaultScope = deps.defaultScope;
	const mode: DeploymentMode = deps.mode ?? "local";

	// POST /api/assets/publish — append a version-bumped row (c-AC-1 / FR-1).
	group.post("/publish", async (c) => {
		const body = await readJson(c);
		if (body === null) return badBody(c, "publish body must be JSON");
		const req = parsePublish(c, body, defaultScope, mode);
		if (req === null) return badBody(c, "publish body is missing required fields or its tenancy is not authorized");
		const res = await engine.publish(req);
		return c.json(res);
	});

	// POST /api/assets/pull — select newer audience-matched rows (FR-2 / FR-7).
	group.post("/pull", async (c) => {
		const body = await readJson(c);
		if (body === null) return badBody(c, "pull body must be JSON");
		const req = parsePull(c, body, defaultScope, mode);
		if (req === null) return badBody(c, "pull body is missing a resolvable / authorized scope");
		const res = await engine.pull(req);
		return c.json(res);
	});

	// POST /api/assets/tombstone — append a `tombstone='true'` row (c-AC-5 / FR-6).
	group.post("/tombstone", async (c) => {
		const body = await readJson(c);
		if (body === null) return badBody(c, "tombstone body must be JSON");
		const req = parseTombstone(c, body, defaultScope, mode);
		if (req === null) return badBody(c, "tombstone body is missing required fields or its tenancy is not authorized");
		const res = await engine.tombstone(req);
		return c.json(res);
	});
}

/**
 * Resolve `/api/assets` and mount the handlers (the assembly seam). Mirrors
 * `mountSettingsApi(daemon, deps)`: resolves the protected group and delegates. A no-op
 * when the group is not mounted (unknown daemon shape).
 */
export function mountAssetsApi(daemon: Daemon, deps: AssetsApiDeps): void {
	const group = daemon.group(ASSETS_GROUP);
	if (group === undefined) return;
	mountAssetsGroup(group, deps);
}

/** Build the engine from the sync deps, defaulting to a no-storage guard that 400s nothing. */
function buildEngine(deps: AssetsApiDeps): AssetSyncApi {
	if (deps.sync === undefined) {
		throw new Error("mountAssetsApi: either `engine` or `sync` (with a storage client) is required");
	}
	return createAssetSyncApi(deps.sync);
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

/** The 400 for a malformed body. */
function badBody(c: Context, reason: string): Response {
	return c.json({ error: "bad_request", reason }, 400);
}

/**
 * Resolve the {@link AssetScope} a publish/pull/tombstone runs under — AUTHENTICATED, never
 * body-asserted (PRD-033 SECURITY remediation; headline tenancy-isolation fix).
 *
 * ── The cross-tenant guard (mirrors `resolveScopeFromHeaders`) ────────────────
 * `/api/assets` is a `protect:true` group: in team/hybrid the permission middleware has
 * already AUTHENTICATED the request and stamped the VALIDATED {@link Identity} (its `org`,
 * `workspace`, and `agentId` come from the token claim, NEVER a header or body). The storage
 * layer partitions the `synced_assets` read/write by `scope.org`, and the Device audience is
 * keyed by `scope.author` — so a body-supplied `org`/`workspace`/`author` is a cross-tenant
 * forge primitive (publish into / pull from / tombstone another org; address another author's
 * device audience). When a validated Identity is present we therefore IGNORE the body's
 * org/workspace/author and use the Identity's own — and reject a body `org` that DISAGREES
 * with the token (fail-closed `null` → 400), exactly the data-API hardening.
 *
 * ── Local mode (single-user loopback) ────────────────────────────────────────
 * In `local` mode no Identity is stamped (the middleware is open by design — one tenant). The
 * body + `defaultScope` fallback applies: `org` backfills from the daemon's own configured
 * tenant, and the body `author`/`deviceId` (the device identity the loopback CLI resolved) are
 * trusted because there is exactly one local user. This preserves the dogfood path unchanged.
 *
 * `deviceId` (the acting device's membership test) always rides from the body — it is the
 * caller's OWN device id, not a tenancy boundary the token binds (the audience predicate still
 * requires the author to match, so a device id alone widens nothing).
 */
function resolveScope(
	c: Context,
	raw: unknown,
	defaultScope: QueryScope | undefined,
	mode: DeploymentMode,
): AssetScope | null {
	const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const bodyOrg = pickString(obj.org);
	const deviceId = pickString(obj.deviceId) ?? "";

	// team/hybrid: the authenticated Identity is the ONLY tenancy authority.
	const identity = getRequestIdentity(c);
	if (identity !== undefined) {
		// A body org that disagrees with the token's own org is a cross-tenant forge → fail closed.
		if (bodyOrg !== undefined && bodyOrg !== identity.org) return null;
		return {
			org: identity.org,
			workspace: identity.workspace,
			// The Device-audience boundary is the authenticated actor, never a body claim.
			author: identity.agentId,
			deviceId,
		};
	}

	// local mode (no Identity): the body + daemon defaultScope fallback (single local tenant).
	const org = bodyOrg ?? defaultScope?.org ?? "";
	if (org === "") return null;
	const workspace = pickString(obj.workspace) ?? defaultScope?.workspace ?? "default";
	const author = pickString(obj.author) ?? "";
	return { org, workspace, author, deviceId };
}

/** Parse a {@link PublishRequest} from a body, or `null` when a required field is missing/invalid. */
function parsePublish(c: Context, body: Record<string, unknown>, defaultScope: QueryScope | undefined, mode: DeploymentMode): PublishRequest | null {
	const honeycombId = pickString(body.honeycombId);
	const assetType = pickAssetType(body.assetType);
	const harness = pickString(body.harness);
	const cell = pickCell(body.cell);
	const scope = resolveScope(c, body.scope, defaultScope, mode);
	if (honeycombId === undefined || assetType === null || harness === undefined || cell === null || scope === null) {
		return null;
	}
	// A Local-tier publish is a lifecycle error (Local never reaches DeepLake — FR-7). Reject
	// it at the boundary so a mis-driven call fails loud rather than writing an unreachable row.
	if (cell.tier === "Local") return null;
	return {
		honeycombId,
		assetType,
		harness,
		native: pickString(body.native) ?? "",
		canonical: pickString(body.canonical) ?? "",
		contentHash: pickString(body.contentHash) ?? "",
		cell,
		scope,
		deviceSet: pickStringArray(body.deviceSet),
	};
}

/** Parse a {@link PullRequest} from a body, or `null` when no scope is resolvable. */
function parsePull(c: Context, body: Record<string, unknown>, defaultScope: QueryScope | undefined, mode: DeploymentMode): PullRequest | null {
	const scope = resolveScope(c, body.scope, defaultScope, mode);
	if (scope === null) return null;
	const style = pickStyle(body.style);
	return style === null ? { scope } : { scope, style };
}

/** Parse a {@link TombstoneRequest} from a body, or `null` when a required field is missing/invalid. */
function parseTombstone(c: Context, body: Record<string, unknown>, defaultScope: QueryScope | undefined, mode: DeploymentMode): TombstoneRequest | null {
	const honeycombId = pickString(body.honeycombId);
	const assetType = pickAssetType(body.assetType);
	const harness = pickString(body.harness);
	const cell = pickCell(body.cell);
	const scope = resolveScope(c, body.scope, defaultScope, mode);
	if (honeycombId === undefined || assetType === null || harness === undefined || cell === null || scope === null) {
		return null;
	}
	return { honeycombId, assetType, harness, cell, scope, deviceSet: pickStringArray(body.deviceSet) };
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

/** A valid {@link Style} (`Repository`/`User`), or `null` for an absent/invalid value. */
function pickStyle(value: unknown): Style | null {
	return typeof value === "string" && (STYLES as readonly string[]).includes(value) ? (value as Style) : null;
}

/** A valid {@link LatticeCell} (tier + style both valid), or `null`. */
function pickCell(value: unknown): LatticeCell | null {
	if (typeof value !== "object" || value === null) return null;
	const obj = value as Record<string, unknown>;
	const tier = obj.tier;
	const style = obj.style;
	if (typeof tier !== "string" || !(TIERS as readonly string[]).includes(tier)) return null;
	if (typeof style !== "string" || !(STYLES as readonly string[]).includes(style)) return null;
	return { tier: tier as LatticeCell["tier"], style: style as Style };
}

/** A string array (every non-string entry dropped), or empty. */
function pickStringArray(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}
