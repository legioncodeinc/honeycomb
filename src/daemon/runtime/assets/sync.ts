/**
 * PRD-033c — Asset sync engine + daemon API (Wave 2, IMPLEMENTED).
 *
 * ── WAVE 2 — `deeplake-dataset-worker-bee` OWNS this file ────────────────────
 * 033c implements the {@link AssetSyncApi} (publish/pull/tombstone) over the
 * `synced_assets` table and mounts the protected `/api/assets` daemon route. This
 * module is the daemon-side engine; the THIN-CLIENT side (`createLoopbackAssetSyncApi`
 * + `pullAndInstall`) lives under `src/daemon-client/assets/` and reaches this engine
 * ONLY over loopback HTTP, never DeepLake (D-6).
 *
 * ── Daemon-only DeepLake (D-6) ───────────────────────────────────────────────
 * THIS is the ONLY asset-sync code that touches DeepLake. Every method runs through
 * the injected {@link StorageQuery}:
 *
 *   - **publish (c-AC-1 / FR-1):** `appendVersionBumped` INSERTs a version-bumped
 *     `synced_assets` row carrying the verbatim `native` blob keyed `(asset_type,
 *     harness)`, the reserved `canonical`, the content hash, tier/style, the tenancy
 *     (org/workspace/author), and the device-set (Device tier). Append-only (D-5) —
 *     a publish is a fresh version, never an UPDATE. The version-bump key is the
 *     `honeycomb_id`, so each logical artifact's versions climb monotonically.
 *
 *   - **pull (FR-2 / FR-7):** consults the trusted-table list FIRST — when
 *     `synced_assets` is ABSENT it returns `{ assets: [], tableAbsent: true }` WITHOUT
 *     a SELECT (no relation-does-not-exist log on a fresh workspace). Otherwise it
 *     reads the highest-version row per `honeycomb_id` POLL-CONVERGENTLY through
 *     {@link readConverged} (DeepLake eventual consistency — never a single immediate
 *     read), applies the {@link audienceMatches} predicate (user/workspace/device-set),
 *     and returns the survivors INCLUDING tombstone rows so the caller can RETRACT a
 *     demoted artifact (a tombstone is data, not an omission).
 *
 *   - **tombstone (c-AC-5 / FR-6 / D-5):** `appendVersionBumped` a fresh row with
 *     `tombstone='true'` at the SAME lattice radius — a row, NEVER a DELETE. The next
 *     pull across that radius sees it and retracts the local copy.
 *
 * The shared CONTRACTS (`./contracts.ts`) — the publish/pull/tombstone shapes, the
 * `AssetAdapter` seam + `IDENTITY_ADAPTER`, and `audienceMatches` — are FULL and
 * FROZEN in Wave 1; this engine implements AGAINST them, it does not redefine them.
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 * The engine builds NO raw SQL by hand for writes: publish/tombstone go through
 * `appendVersionBumped` (which routes every value through the 002b guards). The pull
 * SELECT is assembled through `sqlIdent` + `sLiteral` only (every identifier guarded,
 * every value a literal) — `npm run audit:sql` proves no fragment hand-interpolates.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import {
	SYNCED_ASSETS_COLUMNS,
	SYNCED_ASSETS_TABLE,
	TOMBSTONE_FALSE,
	TOMBSTONE_TRUE,
} from "../../storage/catalog/synced-assets.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendVersionBumped, type RowValues, val } from "../../storage/writes.js";
import { type ColumnDef } from "../../storage/schema.js";
import { minVersion, readConverged } from "../../storage/converge.js";

import {
	type AssetScope,
	type AssetSyncApi,
	audienceMatches,
	type LatticeCell,
	type PublishRequest,
	type PublishResponse,
	type PulledAsset,
	type PullRequest,
	type PullResponse,
	type Style,
	type SyncedAssetType,
	type TombstoneRequest,
	type TombstoneResponse,
} from "./contracts.js";

/** The version column the `synced_assets` append-only writes bump (D-5). */
const VERSION_COLUMN = "version";
/** The logical-key column every version bump groups by (the rename-stable id). */
const KEY_COLUMN = "honeycomb_id";

/**
 * Resolve the {@link QueryScope} a publish/pull/tombstone runs the storage call
 * under, from the request's {@link AssetScope}. The org partitions the storage
 * backend; the workspace is the Team boundary. (The author + device-set are the
 * Device-audience boundary — applied by the {@link audienceMatches} predicate over
 * the rows read, NOT as a storage partition, because a Device-tier row lives in the
 * same org/workspace partition as its author's other rows.)
 */
function scopeOf(scope: AssetScope): QueryScope {
	return { org: scope.org, workspace: scope.workspace };
}

/**
 * The deps a {@link createAssetSyncApi} engine runs against. `storage` is the live
 * DeepLake client (the daemon's only one, D-6). `target` is the `synced_assets`
 * {@link HealTarget} — injectable so a live itest binds a throwaway `ci_assets_<run>`
 * table from the SAME ColumnDef array (lazy-create + heal), never the shared table.
 * `trustedTables` lets the pull skip its SELECT when the table is absent (FR-7); when
 * omitted the pull proceeds (fail-open — a transient list failure never disables pulls).
 */
export interface AssetSyncEngineDeps {
	/** The live storage client — the ONLY DeepLake path (D-6). */
	readonly storage: StorageQuery;
	/** The `synced_assets` heal target. Defaults to the catalog table; a live itest overrides it. */
	readonly target?: HealTarget;
	/** The trusted-table probe (FR-7) — when `synced_assets` is absent the pull skips the SELECT. */
	readonly trustedTables?: TrustedTableProbe;
}

/**
 * The trusted-table probe the pull consults BEFORE its SELECT (FR-7). On a fresh
 * workspace the `synced_assets` table may not exist; rather than dispatch a SELECT
 * the backend answers with `relation "synced_assets" does not exist`, the pull asks
 * for the known-table set and, if the table is absent, returns `tableAbsent:true`. A
 * `null` answer means "could not determine" → the pull proceeds (fail-open).
 */
export interface TrustedTableProbe {
	/** The known table set, or `null` when it could not be resolved. */
	tables(): Promise<readonly string[] | null>;
}

/** The default `synced_assets` heal target, built from the catalog ColumnDef array. */
export function defaultAssetTarget(): HealTarget {
	return { table: SYNCED_ASSETS_TABLE, columns: SYNCED_ASSETS_COLUMNS as unknown as ColumnDef[] };
}

/**
 * Build the production {@link AssetSyncApi} over the daemon's storage client
 * (PRD-033c). Every method is daemon-only DeepLake (D-6): publish/tombstone append a
 * version-bumped row; pull reads the highest version per id, applies the audience
 * predicate, and returns survivors (tombstones included). A live itest injects a
 * throwaway `target` + a `trustedTables` probe; production passes just `{ storage }`.
 */
export function createAssetSyncApi(deps: AssetSyncEngineDeps): AssetSyncApi {
	const storage = deps.storage;
	const target = deps.target ?? defaultAssetTarget();
	const trustedTables = deps.trustedTables;

	return {
		/**
		 * Publish ONE artifact version (c-AC-1 / FR-1). Appends a version-bumped row
		 * keyed by `honeycomb_id` carrying the native blob keyed `(asset_type, harness)`,
		 * the reserved canonical, the content hash, the tier/style cell, the tenancy, and
		 * the device-set. Append-only (D-5) — never an UPDATE. The lifecycle (033b) refuses
		 * to call publish for a `Local` cell, so a request always carries Device/Team.
		 */
		async publish(req: PublishRequest): Promise<PublishResponse> {
			const scope = scopeOf(req.scope);
			const { result, version } = await appendVersionBumped(storage, target, scope, {
				keyColumn: KEY_COLUMN,
				keyValue: req.honeycombId,
				versionColumn: VERSION_COLUMN,
				row: assetRow({
					honeycombId: req.honeycombId,
					assetType: req.assetType,
					harness: req.harness,
					native: req.native,
					canonical: req.canonical,
					contentHash: req.contentHash,
					tombstone: TOMBSTONE_FALSE,
					cell: req.cell,
					scope: req.scope,
					deviceSet: req.deviceSet,
				}),
			});
			return { honeycombId: req.honeycombId, version, published: isOk(result) };
		},

		/**
		 * Pull the artifact versions this caller's audience should receive (FR-2 / FR-7).
		 * Trusted-table early-exit FIRST (table absent → `{ assets: [], tableAbsent: true }`,
		 * no SELECT). Otherwise reads the highest-version row per `honeycomb_id`
		 * POLL-CONVERGENTLY (DeepLake eventual consistency — never a single immediate read),
		 * applies the audience predicate, and returns survivors (tombstones included).
		 */
		async pull(req: PullRequest): Promise<PullResponse> {
			if (await tableAbsent(trustedTables, target.table)) {
				return { assets: [], tableAbsent: true };
			}

			const scope = scopeOf(req.scope);
			const sql = buildPullSql(target.table, req.style);
			// Poll-convergent read: the backend flaps stale segments, so a single read can
			// UNDER-report a version. `minVersion(version, 1)` is the freshness floor — any
			// ok result with at least one versioned row is "real data observed"; the budget
			// governs and the LAST read is returned (fail-soft, never a throw).
			const result = await readConverged(storage, sql, scope, minVersion(VERSION_COLUMN, 1));

			if (!isOk(result)) {
				// A non-ok read (transport flap that never converged, or a genuine error the
				// trusted-table probe did not pre-empt) is fail-soft: an empty pull within
				// budget, never a thrown error that blocks session start (FR-7).
				return { assets: [], tableAbsent: false };
			}

			const ctx = {
				org: req.scope.org,
				workspace: req.scope.workspace,
				author: req.scope.author,
				deviceId: req.scope.deviceId,
			};
			// Reduce to the highest version per honeycomb_id, then keep only the rows whose
			// audience matches the caller (tombstones pass the SAME test, so a retraction
			// reaches exactly the audience that received the artifact — D-5 / c-AC-5).
			const highest = highestPerId(result.rows);
			const assets = highest.filter((a) => audienceMatches(a, ctx));
			return { assets, tableAbsent: false };
		},

		/**
		 * Write a retraction (c-AC-5 / D-5). Appends a fresh version-bumped row with
		 * `tombstone='true'` at the SAME lattice radius the artifact occupied — NEVER a
		 * DELETE. The next pull across that radius sees the tombstone and retracts the local
		 * copy (`.bak` then remove, D-4). The native/canonical blobs are empty on a tombstone
		 * row (there is nothing to install); the audience columns carry so the retraction lands.
		 */
		async tombstone(req: TombstoneRequest): Promise<TombstoneResponse> {
			const scope = scopeOf(req.scope);
			const { result, version } = await appendVersionBumped(storage, target, scope, {
				keyColumn: KEY_COLUMN,
				keyValue: req.honeycombId,
				versionColumn: VERSION_COLUMN,
				row: assetRow({
					honeycombId: req.honeycombId,
					assetType: req.assetType,
					harness: req.harness,
					native: "",
					canonical: "",
					contentHash: "",
					tombstone: TOMBSTONE_TRUE,
					cell: req.cell,
					scope: req.scope,
					deviceSet: req.deviceSet,
				}),
			});
			return { honeycombId: req.honeycombId, version, tombstoned: isOk(result) };
		},
	};
}

/** The shape `assetRow` packs into a version-bumped INSERT (publish + tombstone share it). */
interface AssetRowInput {
	readonly honeycombId: string;
	readonly assetType: SyncedAssetType;
	readonly harness: string;
	readonly native: string;
	readonly canonical: string;
	readonly contentHash: string;
	readonly tombstone: typeof TOMBSTONE_TRUE | typeof TOMBSTONE_FALSE;
	readonly cell: LatticeCell;
	readonly scope: AssetScope;
	readonly deviceSet: readonly string[];
}

/**
 * Build the column→value list for a `synced_assets` version-bumped INSERT. Every blob
 * column (`native`/`canonical`/`content_hash`) goes through `val.text` (escape-safe
 * `E'...'`, the verbatim-bytes path); every id/enum/tenancy through `val.str`. The
 * `version` column is appended by `appendVersionBumped`. The `device_set` is stored as
 * a JSON array string (the audience membership the pull's predicate reads back).
 */
function assetRow(input: AssetRowInput): RowValues {
	return [
		["honeycomb_id", val.str(input.honeycombId)],
		["asset_type", val.str(input.assetType)],
		["harness", val.str(input.harness)],
		["native", val.text(input.native)],
		["canonical", val.text(input.canonical)],
		["content_hash", val.text(input.contentHash)],
		["tombstone", val.str(input.tombstone)],
		["tier", val.str(input.cell.tier)],
		["style", val.str(input.cell.style)],
		["org", val.str(input.scope.org)],
		["workspace", val.str(input.scope.workspace)],
		["author", val.str(input.scope.author)],
		["device_set", val.str(JSON.stringify([...input.deviceSet]))],
		["created_at", val.str(new Date().toISOString())],
	];
}

/**
 * Build the pull SELECT (FR-2). Reads EVERY column for EVERY row (the engine reduces
 * to highest-version-per-id in memory, then audience-filters), optionally narrowed to a
 * single `style`. Identifiers go through `sqlIdent`; the only value (`style`) goes
 * through `sLiteral` — there is no other caller value, so the statement is injection-free.
 * The org/workspace partition is applied storage-side by the client's scope, not here.
 */
export function buildPullSql(table: string, style?: Style): string {
	const tbl = sqlIdent(table);
	const base = `SELECT * FROM "${tbl}"`;
	if (style === undefined) return base;
	return `${base} WHERE ${sqlIdent("style")} = ${sLiteral(style)}`;
}

/**
 * Reduce raw `synced_assets` rows to the HIGHEST-version row per `honeycomb_id`
 * (a-AC-6 reader convention). The append-only log holds every version; the current
 * state of a logical artifact is its max-version row (a `tombstone='true'` retraction
 * when that is the latest). A poll-convergent read can return rows from differing
 * segments, so we keep the max version observed per id rather than trusting order.
 */
export function highestPerId(rows: readonly StorageRow[]): PulledAsset[] {
	const best = new Map<string, PulledAsset>();
	for (const row of rows) {
		const asset = rowToPulledAsset(row);
		if (asset === null) continue;
		const prior = best.get(asset.honeycombId);
		if (prior === undefined || asset.version >= prior.version) best.set(asset.honeycombId, asset);
	}
	return [...best.values()];
}

/** Map a `synced_assets` row to a {@link PulledAsset}, or `null` when the id is missing. */
function rowToPulledAsset(row: StorageRow): PulledAsset | null {
	const honeycombId = stringOf(row.honeycomb_id);
	if (honeycombId === "") return null;
	const v = typeof row.version === "number" ? row.version : Number(row.version);
	return {
		honeycombId,
		assetType: stringOf(row.asset_type) === "agent" ? "agent" : "skill",
		harness: stringOf(row.harness),
		native: stringOf(row.native),
		canonical: stringOf(row.canonical),
		contentHash: stringOf(row.content_hash),
		version: Number.isFinite(v) ? v : 0,
		tombstone: stringOf(row.tombstone) === TOMBSTONE_TRUE,
		cell: { tier: tierOf(row.tier), style: styleOf(row.style) },
		deviceSet: parseDeviceSet(row.device_set),
		author: stringOf(row.author),
		org: stringOf(row.org),
		workspace: stringOf(row.workspace),
	};
}

/** Coerce a row cell to a string (DeepLake may hand back a non-string scalar). */
function stringOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return String(value);
}

/** Coerce a stored tier string to a {@link LatticeCell} tier (defaulting to `Local`). */
function tierOf(value: unknown): LatticeCell["tier"] {
	const s = stringOf(value);
	return s === "Device" || s === "Team" ? s : "Local";
}

/** Coerce a stored style string to a {@link Style} (defaulting to `Repository`). */
function styleOf(value: unknown): Style {
	return stringOf(value) === "User" ? "User" : "Repository";
}

/**
 * Parse the stored `device_set` JSON array string into a string list (the Device
 * audience membership). A malformed/absent value yields an empty set — a Device-tier
 * row with no readable device set simply matches no device (fail-closed), never throws.
 */
function parseDeviceSet(value: unknown): readonly string[] {
	const raw = stringOf(value);
	if (raw === "") return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

/**
 * True when the trusted-table probe reports a known-table set that does NOT include
 * the asset table (FR-7). A `null`/absent probe is fail-OPEN (proceed) so a transient
 * list failure never silently disables pulls forever.
 */
async function tableAbsent(probe: TrustedTableProbe | undefined, table: string): Promise<boolean> {
	if (probe === undefined) return false;
	const tables = await probe.tables();
	if (tables === null) return false;
	return !tables.includes(table);
}
