/**
 * The Sync page data + action API — PRD-042 (the daemon-side write surface, D-4).
 *
 * PRD-036's `fetchSkillSyncView` (`./api.ts`) gave the dashboard a read-only `installed ∪ synced`
 * union for SKILLS. PRD-042 turns the Sync page into a WRITE surface for BOTH skills and agents:
 *
 *   - {@link fetchAssetSyncView} — the union view-model the Sync page lists. It returns every skill
 *     AND agent from `installed ∪ synced`, each carrying an honest state (`local`/`pulled`/`shared`)
 *     PLUS the detail fields the page renders (provenance, scope, source harness, tier/style,
 *     version) and `authoredByMe` (so the page disables Demote when the user did not author it —
 *     parent OQ-4). It NEVER carries a secret: no `native` blob, no author EMAIL, no org GUID — the
 *     `author` field is the opaque substrate author token, surfaced ONLY as the `authoredByMe`
 *     boolean, never rendered (D-5).
 *
 *   - {@link createSyncActionApi} — the generic asset-action engine keyed by `asset_type`
 *     (`'skill' | 'agent'`, parent OQ b-OQ-1: ONE engine both halves use). promote = the existing
 *     `createAssetSyncApi.publish` (a version-bumped INSERT, never an UPDATE — PRD-033 D-5); demote =
 *     `.tombstone` (a `tombstone='true'` version-bump); pull = `.pull` + the install-target write;
 *     enable/disable = a LOCAL install-presence toggle (parent OQ-2 resolution — NO substrate
 *     schema change). Every confirm reads back POLL-CONVERGENTLY through {@link readConverged} over
 *     `buildCurrentAssetVersionSql` — NEVER a single immediate read (DeepLake serves stale segments).
 *
 * ── Daemon-only DeepLake (D-4 / D-6) ─────────────────────────────────────────
 * THIS is the only Sync-page code that touches DeepLake. The page is a thin client: it POSTs to the
 * `/api/diagnostics/sync/*` endpoints (mounted by `./sync-mount.ts`) and never opens DeepLake. The
 * engine runs every storage call through the injected {@link StorageQuery} with the SAME guarded SQL
 * discipline as the rest of the substrate (`createAssetSyncApi` owns the writes; the read-back SELECT
 * is `buildCurrentAssetVersionSql`, built through `sqlIdent`/`sLiteral`), so `audit:sql` stays clean.
 *
 * ── Promote defaults to Team/Repository (parent OQ-1) ────────────────────────
 * v1 promotes to the `Team × Repository` lattice cell — no full lattice picker. The engine accepts an
 * optional cell so a future advanced control can widen it, but the page sends none and the default
 * stands.
 */

import {
	SYNCED_ASSETS_TABLE,
	TOMBSTONE_TRUE,
	type SyncedAssetType,
	buildCurrentAssetVersionSql,
} from "../../storage/catalog/synced-assets.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { sqlIdent } from "../../storage/sql.js";
import { readConverged } from "../../storage/converge.js";
import {
	type AssetScope,
	type AssetSyncApi,
	type LatticeCell,
} from "../assets/contracts.js";
import { createAssetSyncApi, type AssetSyncEngineDeps } from "../assets/sync.js";
import { type LocalAssetInventory } from "../../../dashboard/contracts.js";
import { type AssetInstallTarget, createFsAssetInstallTarget } from "./asset-install-target.js";
import { scanInstalledAssets } from "./installed-assets.js";

// ─────────────────────────────────────────────────────────────────────────────
// The union view-model the Sync page lists (042a-AC-1 / 042b-AC-1 / AC-2).
// ─────────────────────────────────────────────────────────────────────────────

/** The honest sync state a row carries — `local` (disk only) / `pulled` / `shared` (substrate). */
export type AssetSyncState = "local" | "pulled" | "shared";

/**
 * One row of the Sync-page union view-model (042a-AC-1/AC-2, 042b-AC-1/AC-2). Carries the
 * PRESENTATION-SAFE detail fields the page renders — NEVER a secret. The `native` blob, the author
 * EMAIL, and the org GUID are deliberately ABSENT from this shape: `author` is the opaque substrate
 * author token surfaced only via {@link authoredByMe} (so Demote disables honestly when not the
 * author — parent OQ-4), never rendered.
 */
export interface AssetSyncRow {
	/** The asset kind (`skill` directory | `agent` file) — the symmetry key (042b). */
	readonly assetType: SyncedAssetType;
	/** The logical asset name (the disk name; the union key). */
	readonly name: string;
	/** Short description from the asset's frontmatter (`""` when unknown). */
	readonly description: string;
	/** The honest sync state: `local` (disk-only) / `pulled` / `shared` (substrate). */
	readonly state: AssetSyncState;
	/** The scope (`repository`/`user`/`team`…) — presentation-safe. */
	readonly scope: string;
	/** The source harness(es) the asset is installed in / published from (e.g. `claude-code`). */
	readonly sourceHarness: string;
	/** The substrate tier (`Local`/`Device`/`Team`) when shared, else `""`. */
	readonly tier: string;
	/** The substrate style (`Repository`/`User`) when shared, else `""`. */
	readonly style: string;
	/** The current substrate version, or 0 when local-only. */
	readonly version: number;
	/** The rename-stable substrate id when shared/pulled (a `hc_<hex>` token), else `""`. */
	readonly honeycombId: string;
	/**
	 * True iff the CURRENT viewer authored this substrate row — the page enables Demote ONLY for the
	 * author (parent OQ-4: disable, never attempt-and-fail). Derived from the row's opaque `author`
	 * token vs the request scope's author; the token itself is NEVER carried out (D-5).
	 */
	readonly authoredByMe: boolean;
}

/** The Sync-page view-model: skills + agents, deduped, each with state + detail (042a/042b). */
export interface AssetSyncView {
	/** Every skill from `installed ∪ synced`, deduped by name (a-AC-1, no double-count). */
	readonly skills: readonly AssetSyncRow[];
	/** Every agent from `installed ∪ synced`, deduped by name (b-AC-1, no double-count). */
	readonly agents: readonly AssetSyncRow[];
}

/** Normalize a name to its union key (case-insensitive, trimmed) — the 036b collision key. */
function normalizeKey(name: string): string {
	return name.trim().toLowerCase();
}

/** Run a SELECT through storage, returning rows or `[]` on any non-ok result (fail-soft). */
async function selectRows(storage: StorageQuery, sql: string, scope: QueryScope): Promise<StorageRow[]> {
	const result = await storage.query(sql, scope);
	return isOk(result) ? result.rows : [];
}

/** Coerce a row cell to a string (DeepLake hands back non-string scalars). */
function strOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return String(value);
}

/** Coerce a row cell to a finite number (0 on garbage). */
function numOf(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Build the substrate read for the Sync view (a-AC-1 / a-AC-2): EVERY `synced_assets` row for the
 * scope. The engine reduces to the highest-version row per `honeycomb_id` in memory (so a republish
 * never double-counts) and derives state/tier/style/version/authoredByMe from it. Identifiers go
 * through `sqlIdent`; there is no caller value (the org/workspace partition rides the scope), so the
 * statement is static + injection-free.
 */
function buildSyncedAssetsSql(): string {
	// Re-use the catalog's table name; SELECT * is reduced in memory (highestPerId pattern). The
	// identifier goes through `sqlIdent` (the sanctioned guard every other builder uses, e.g.
	// `buildCurrentAssetVersionSql` / `buildPullSql`) so this stays consistent + regression-proof
	// if the table name ever becomes config-driven — never a bare interpolation.
	const tbl = sqlIdent(SYNCED_ASSETS_TABLE);
	return `SELECT * FROM "${tbl}"`;
}

/** A reduced current-version substrate row (the highest version per honeycomb_id). */
interface CurrentSubstrateRow {
	readonly honeycombId: string;
	readonly assetType: SyncedAssetType;
	readonly name: string;
	readonly harness: string;
	readonly tier: string;
	readonly style: string;
	readonly version: number;
	readonly tombstone: boolean;
	readonly author: string;
}

/**
 * Reduce raw `synced_assets` rows to the HIGHEST-version row per `honeycomb_id` (the a-AC-6 reader
 * convention) — a republish or tombstone climbs the version, so the current state is the max-version
 * row. The substrate row carries no human `name` for the union, so the name rides the FRONTMATTER
 * we do not read here; instead the union keys substrate rows by their `honeycomb_id` and merges the
 * DISK name in (the disk scan is the human-name source). The `name` here is best-effort from the
 * row's own columns and is overwritten by the disk name on a union match.
 */
function reduceCurrent(rows: readonly StorageRow[]): Map<string, CurrentSubstrateRow> {
	const best = new Map<string, CurrentSubstrateRow>();
	for (const r of rows) {
		const honeycombId = strOf(r.honeycomb_id);
		if (honeycombId === "") continue;
		const version = numOf(r.version);
		const prior = best.get(honeycombId);
		if (prior !== undefined && prior.version >= version) continue;
		best.set(honeycombId, {
			honeycombId,
			assetType: strOf(r.asset_type) === "agent" ? "agent" : "skill",
			name: strOf(r.name),
			harness: strOf(r.harness),
			tier: strOf(r.tier),
			style: strOf(r.style),
			version,
			tombstone: strOf(r.tombstone) === TOMBSTONE_TRUE,
			author: strOf(r.author),
		});
	}
	return best;
}

/**
 * Fetch the Sync-page union view-model (042a-AC-1/AC-2 + 042b-AC-1/AC-2). MERGES the on-disk
 * inventory (the 036a scanner, in-process — D-4) with the `synced_assets` substrate's
 * current-version rows. For each asset kind:
 *
 *   1. Reduce the substrate rows to the highest version per `honeycomb_id`. A live (non-tombstone)
 *      shared row contributes a `shared` entry keyed by its disk name (the substrate carries the
 *      name only via frontmatter, so the union keys substrate rows by name when present, else by id).
 *   2. Fold in the disk inventory: a name NOT in the substrate becomes a `local` row; a name already
 *      present is UPGRADED to carry the disk description/scope/harness while keeping the substrate
 *      state (no double-count — a-AC-1 / b-AC-1).
 *
 * `viewerAuthor` is the current scope's author token (resolved daemon-side); a substrate row whose
 * `author` matches it is `authoredByMe: true` so the page enables Demote (parent OQ-4). It is NEVER
 * rendered. Fail-soft: a discovery error degrades to the substrate-only view; a storage error to the
 * disk-only view — the page never 500s.
 *
 * `scan` is injectable (defaults to {@link scanInstalledAssets}) so a daemon-side test drives the
 * union deterministically without walking the real cwd.
 */
export async function fetchAssetSyncView(
	storage: StorageQuery,
	scope: QueryScope,
	viewerAuthor: string,
	scan: () => Promise<LocalAssetInventory> = scanInstalledAssets,
): Promise<AssetSyncView> {
	const [substrateRows, inventory] = await Promise.all([
		selectRows(storage, buildSyncedAssetsSql(), scope),
		scan().catch((): LocalAssetInventory => ({ skills: [], agents: [] })),
	]);

	const current = reduceCurrent(substrateRows);
	return {
		skills: unionFor("skill", current, inventory.skills, viewerAuthor),
		agents: unionFor("agent", current, inventory.agents, viewerAuthor),
	};
}

/** The disk-asset shape the union folds in (a subset of the 036a `DiscoveredAsset`). */
interface DiskAsset {
	readonly name: string;
	readonly description: string;
	readonly scope: string;
	readonly sourceHarnesses: readonly string[];
}

/**
 * Build the union list for ONE asset kind (a-AC-1 / b-AC-1). Substrate (current, non-tombstone) rows
 * of this `assetType` seed the map keyed by normalized name; the disk inventory then fills in
 * descriptions/harness for matched names and adds `local` rows for unmatched ones. A tombstoned
 * substrate row that has no live disk presence is OMITTED (it is no longer live `shared`).
 */
function unionFor(
	assetType: SyncedAssetType,
	current: Map<string, CurrentSubstrateRow>,
	disk: readonly DiskAsset[],
	viewerAuthor: string,
): AssetSyncRow[] {
	const merged = new Map<string, AssetSyncRow>();

	// 1. Seed from the substrate's current rows of this kind. A tombstoned row is NOT live `shared`
	//    — skip it (the demote took effect on the converged read). The substrate row's name comes
	//    from its own `name` column when present; an empty name falls back to the honeycomb_id so the
	//    row still lists (the disk scan upgrades the name on a match).
	for (const row of current.values()) {
		if (row.assetType !== assetType || row.tombstone) continue;
		const displayName = row.name !== "" ? row.name : row.honeycombId;
		const key = normalizeKey(displayName);
		if (key === "") continue;
		merged.set(key, {
			assetType,
			name: displayName,
			description: "",
			state: "shared",
			scope: "team",
			sourceHarness: row.harness,
			tier: row.tier,
			style: row.style,
			version: row.version,
			honeycombId: row.honeycombId,
			authoredByMe: row.author !== "" && row.author === viewerAuthor,
		});
	}

	// 2. Fold in the disk inventory. A name already in the substrate is UPGRADED (carry the disk
	//    description/scope/harness, keep the substrate state). A name only on disk is a `local` row.
	for (const asset of disk) {
		const key = normalizeKey(asset.name);
		if (key === "") continue;
		const existing = merged.get(key);
		const sourceHarness = asset.sourceHarnesses.join(", ");
		if (existing !== undefined) {
			merged.set(key, {
				...existing,
				name: asset.name,
				description: asset.description,
				sourceHarness: existing.sourceHarness !== "" ? existing.sourceHarness : sourceHarness,
			});
			continue;
		}
		merged.set(key, {
			assetType,
			name: asset.name,
			description: asset.description,
			state: "local",
			scope: asset.scope,
			sourceHarness,
			tier: "",
			style: "",
			version: 0,
			honeycombId: "",
			authoredByMe: false,
		});
	}

	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─────────────────────────────────────────────────────────────────────────────
// The generic asset-action engine (042a-G3/G4, 042b-G3/G4 — keyed by asset_type).
// ─────────────────────────────────────────────────────────────────────────────

/** The default promote lattice cell (parent OQ-1: Team/Repository, no full lattice picker in v1). */
export const DEFAULT_PROMOTE_CELL: LatticeCell = Object.freeze({ tier: "Team", style: "Repository" });

/** A single sync action the engine dispatches (the wire `action` discriminator). */
export type SyncActionKind = "promote" | "pull" | "demote" | "enable" | "disable";

/** A common action request the page POSTs — keyed by `assetType` + `name` (the symmetry key). */
export interface SyncActionRequest {
	/** The asset kind (`skill` | `agent`) — both halves use ONE engine (b-OQ-1). */
	readonly assetType: SyncedAssetType;
	/** The logical asset name (the disk name; the page sends what the union row carries). */
	readonly name: string;
	/** The native artifact body to publish (promote only; the page sends the on-disk content). */
	readonly native?: string;
	/** The rename-stable substrate id (pull/demote target it; promote mints when absent). */
	readonly honeycombId?: string;
	/** The source harness the action targets (defaults to `claude-code`). */
	readonly harness?: string;
	/** The content hash for change detection (promote). */
	readonly contentHash?: string;
	/** The tenancy + audience scope (resolved daemon-side; the page never forges it). */
	readonly scope: AssetScope;
}

/** The result of a sync action — the converged state the page reflects (no optimistic flip). */
export interface SyncActionResult {
	/** True when the action's persisted effect was confirmed on a poll-convergent read-back. */
	readonly ok: boolean;
	/** The action that ran (echoed). */
	readonly action: SyncActionKind;
	/** The asset kind (echoed for the symmetric tests). */
	readonly assetType: SyncedAssetType;
	/** The substrate id the action wrote/targeted (`""` for a local-only enable/disable). */
	readonly honeycombId: string;
	/** The CONVERGED state after the action (`shared`/`pulled`/`local`), or `""` when not applicable. */
	readonly state: AssetSyncState | "";
	/** The converged substrate version (0 for local-only actions). */
	readonly version: number;
}

/** Construction deps for {@link createSyncActionApi}. Everything injectable for tests. */
export interface SyncActionApiDeps {
	/** The live storage client — the ONLY DeepLake path (D-4 / D-6). */
	readonly storage: StorageQuery;
	/**
	 * The substrate engine (publish/pull/tombstone). Defaults to the real `createAssetSyncApi`
	 * over `{ storage }`; a live itest injects an engine bound to a throwaway table. When supplied
	 * it wins; otherwise it is built from {@link SyncActionApiDeps.engineDeps}.
	 */
	readonly engine?: AssetSyncApi;
	/** The engine build deps (a live itest passes a throwaway `target`). */
	readonly engineDeps?: AssetSyncEngineDeps;
	/**
	 * The install-target the pull/enable/disable actions write/remove the on-disk artifact through.
	 * Defaults to the real filesystem target; a test injects a temp-dir-rooted target so no real
	 * `.claude/` is touched.
	 */
	readonly installTarget?: AssetInstallTarget;
}

/**
 * The Sync-page action engine (the generic asset-action surface, keyed by `asset_type`). Both the
 * skills view (042a) and the agents view (042b) call THIS — one engine, not a fork (b-OQ-1). Every
 * action confirms its persisted effect POLL-CONVERGENTLY (D-3) — never an optimistic flip.
 */
export interface SyncActionApi {
	/** Promote a local asset to the team (publish a version-bumped row; convergent read-back → `shared`). */
	promote(req: SyncActionRequest): Promise<SyncActionResult>;
	/** Pull a shared asset (substrate pull → install-target write; converged → `pulled`). */
	pull(req: SyncActionRequest): Promise<SyncActionResult>;
	/** Demote a shared asset (tombstone version-bump; converged → no longer live `shared`). */
	demote(req: SyncActionRequest): Promise<SyncActionResult>;
	/** Enable a local install (re-install presence on disk). */
	enable(req: SyncActionRequest): Promise<SyncActionResult>;
	/** Disable a local install (remove the on-disk presence — NO substrate change). */
	disable(req: SyncActionRequest): Promise<SyncActionResult>;
}

/** Resolve the {@link QueryScope} for a poll-convergent read-back from the request scope. */
function scopeOf(scope: AssetScope): QueryScope {
	return { org: scope.org, workspace: scope.workspace };
}

/**
 * Poll-convergent read-back of a substrate id's current version (D-3 — NEVER a single immediate
 * read; DeepLake serves stale segments). Reads `buildCurrentAssetVersionSql` until the highest
 * version is ≥ `floorVersion`, then maps the converged row to its current state + version. Returns
 * `{ live, version }`: `live` is true when the current row is a NON-tombstone (i.e. still `shared`).
 */
async function readBackCurrent(
	storage: StorageQuery,
	scope: QueryScope,
	honeycombId: string,
	floorVersion: number,
): Promise<{ live: boolean; version: number }> {
	const sql = buildCurrentAssetVersionSql(honeycombId);
	const result = await readConverged(storage, sql, scope, (r) => {
		if (!isOk(r)) return false;
		// Converged when SOME row for this id has version ≥ floor (the append-only monotone signal).
		return r.rows.some((row) => numOf(row.version) >= floorVersion);
	});
	if (!isOk(result) || result.rows.length === 0) return { live: false, version: 0 };
	// The current state is the highest-version row (the SELECT already ORDER BY version DESC LIMIT 1,
	// but a stale segment can return an older row, so reduce defensively).
	let best: StorageRow | undefined;
	let bestV = -1;
	for (const row of result.rows) {
		const v = numOf(row.version);
		if (v > bestV) {
			bestV = v;
			best = row;
		}
	}
	if (best === undefined) return { live: false, version: 0 };
	return { live: strOf(best.tombstone) !== TOMBSTONE_TRUE, version: bestV };
}

/**
 * Author-only gate for demote (PRD-042 OQ-4 daemon-side enforcement). Reads the CURRENT
 * (highest-version) substrate row for `honeycombId` and returns true ONLY when its `author` column
 * equals the caller's resolved author. Fail-CLOSED: a missing row, an empty author on either side,
 * or a non-ok read all return false, so a tombstone is never written on an unconfirmed authorship.
 * Uses the same guarded `buildCurrentAssetVersionSql` (identifier via `sqlIdent`, id via `sLiteral`)
 * the read-back uses — no new SQL surface, `audit:sql` stays clean.
 */
async function authoredByCaller(
	storage: StorageQuery,
	scope: QueryScope,
	honeycombId: string,
	caller: string,
): Promise<boolean> {
	if (caller === "") return false;
	const rows = await selectRows(storage, buildCurrentAssetVersionSql(honeycombId), scope);
	if (rows.length === 0) return false;
	// Reduce to the highest-version row defensively (a stale segment can return an older row).
	let bestAuthor = "";
	let bestV = -1;
	for (const row of rows) {
		const v = numOf(row.version);
		if (v > bestV) {
			bestV = v;
			bestAuthor = strOf(row.author);
		}
	}
	return bestAuthor !== "" && bestAuthor === caller;
}

/**
 * Read the CURRENT (highest-version) substrate `native` blob for a `honeycombId` (the a-AC-6 enable
 * re-install source). Reuses the SAME guarded `buildCurrentAssetVersionSql` read the rest of the
 * engine uses (identifier via `sqlIdent`, id via `sLiteral` — `audit:sql` stays clean, no new SQL
 * surface). Returns `null` when there is no row, the current row is a tombstone (a retracted asset
 * has nothing to re-install), or the blob is empty — so enable fails soft ("nothing to enable")
 * rather than writing an empty native. The blob is read here ONLY to hand to the install-target
 * write; it is NEVER returned to the page (D-5: no native rides the action result).
 */
async function readCurrentNative(
	storage: StorageQuery,
	scope: QueryScope,
	honeycombId: string,
): Promise<string | null> {
	if (honeycombId === "") return null;
	const rows = await selectRows(storage, buildCurrentAssetVersionSql(honeycombId), scope);
	if (rows.length === 0) return null;
	// Reduce to the highest-version row defensively (a stale segment can return an older row).
	let best: StorageRow | undefined;
	let bestV = -1;
	for (const row of rows) {
		const v = numOf(row.version);
		if (v > bestV) {
			bestV = v;
			best = row;
		}
	}
	if (best === undefined) return null;
	// A tombstoned current row is a retracted asset — there is nothing live to re-install.
	if (strOf(best.tombstone) === TOMBSTONE_TRUE) return null;
	const native = strOf(best.native);
	return native !== "" ? native : null;
}

/**
 * Build the production {@link SyncActionApi}. promote/demote delegate to the substrate engine's
 * append-only publish/tombstone (version-bumped, never an UPDATE — D-5) and confirm on a
 * poll-convergent read-back; pull drives the substrate pull then writes the native artifact through
 * the install-target; enable/disable toggle the LOCAL on-disk presence ONLY (parent OQ-2 — no
 * substrate change).
 */
export function createSyncActionApi(deps: SyncActionApiDeps): SyncActionApi {
	const storage = deps.storage;
	const engine = deps.engine ?? createAssetSyncApi(resolveEngineDeps(deps));
	const installTarget = deps.installTarget ?? createFsAssetInstallTarget();

	return {
		async promote(req: SyncActionRequest): Promise<SyncActionResult> {
			const honeycombId = req.honeycombId !== undefined && req.honeycombId !== "" ? req.honeycombId : `hc_${hashName(req.name)}`;
			const harness = req.harness ?? "claude-code";
			// The native blob: the page sends it for an explicit promote, but the thin client need not
			// ship the bytes — the daemon reads the on-disk artifact via the install-target when absent.
			// So a promote works from just `{ assetType, name }` (the union row the page already holds).
			const native = req.native ?? (await installTarget.read(req.assetType, "project", req.name)) ?? "";
			// Append a version-bumped row through the REAL publish path (never an UPDATE — D-5).
			const res = await engine.publish({
				honeycombId,
				assetType: req.assetType,
				harness,
				native,
				canonical: native,
				contentHash: req.contentHash ?? "",
				cell: DEFAULT_PROMOTE_CELL,
				scope: req.scope,
				deviceSet: [],
			});
			// Poll-convergent read-back: confirm the new version landed as a LIVE (non-tombstone) row.
			const back = await readBackCurrent(storage, scopeOf(req.scope), honeycombId, res.version);
			const ok = res.published && back.live && back.version >= res.version;
			return { ok, action: "promote", assetType: req.assetType, honeycombId, state: ok ? "shared" : "", version: back.version };
		},

		async pull(req: SyncActionRequest): Promise<SyncActionResult> {
			// Pull the caller's audience-matched rows (poll-convergent inside the engine), then install
			// the NON-tombstone row that matches this asset by name/id onto the harness target.
			const res = await engine.pull({ scope: req.scope });
			const wantId = req.honeycombId ?? "";
			const match = res.assets.find(
				(a) => a.assetType === req.assetType && !a.tombstone && (wantId === "" || a.honeycombId === wantId),
			);
			if (match === undefined) {
				return { ok: false, action: "pull", assetType: req.assetType, honeycombId: wantId, state: "", version: 0 };
			}
			const path = await installTarget.write(req.assetType, "project", req.name, match.native);
			const ok = path !== null;
			return { ok, action: "pull", assetType: req.assetType, honeycombId: match.honeycombId, state: ok ? "pulled" : "", version: match.version };
		},

		async demote(req: SyncActionRequest): Promise<SyncActionResult> {
			const honeycombId = req.honeycombId ?? "";
			if (honeycombId === "") {
				return { ok: false, action: "demote", assetType: req.assetType, honeycombId, state: "", version: 0 };
			}
			// AUTHZ (PRD-042 OQ-4 / a-OQ-3, daemon-side enforcement): demote is the author's right.
			// The page DISABLES the control for non-authors (`authoredByMe`), but the disabled UI is
			// not a security control — a crafted POST to `/sync/demote` would otherwise let any
			// workspace member tombstone (retract for the whole Team) an artifact they did not author.
			// Confirm authorship against the CURRENT substrate row before writing the tombstone;
			// refuse fail-closed when the caller is not the author (no tombstone is written).
			if (!(await authoredByCaller(storage, scopeOf(req.scope), honeycombId, req.scope.author))) {
				return { ok: false, action: "demote", assetType: req.assetType, honeycombId, state: "", version: 0 };
			}
			const harness = req.harness ?? "claude-code";
			// Write a fresh version with tombstone='true' (a row, never a DELETE — D-5).
			const res = await engine.tombstone({
				honeycombId,
				assetType: req.assetType,
				harness,
				cell: DEFAULT_PROMOTE_CELL,
				scope: req.scope,
				deviceSet: [],
			});
			// Poll-convergent read-back: confirm the tombstone version is current (no longer live `shared`).
			const back = await readBackCurrent(storage, scopeOf(req.scope), honeycombId, res.version);
			const ok = res.tombstoned && !back.live && back.version >= res.version;
			return { ok, action: "demote", assetType: req.assetType, honeycombId, state: ok ? "local" : "", version: back.version };
		},

		async enable(req: SyncActionRequest): Promise<SyncActionResult> {
			// Enable = (re)install the on-disk presence from the substrate's CURRENT version (a-AC-6,
			// parent OQ-2 — a LOCAL install toggle, no substrate write). The native body comes from the
			// current `synced_assets` version (the SAME `buildCurrentAssetVersionSql` read the engine
			// uses), written through the SAME path-sanitized install-target the pull/security fix hardened
			// — never a NEW write path. An explicit non-empty `req.native` (rare; the thin client omits it)
			// wins; otherwise we read the substrate. Fail SOFT when there is no current version / it is a
			// tombstone / the blob is empty — an honest "nothing to enable" (ok:false), NEVER an empty native.
			const honeycombId = req.honeycombId ?? "";
			const explicit = req.native !== undefined && req.native !== "" ? req.native : null;
			const native = explicit ?? (await readCurrentNative(storage, scopeOf(req.scope), honeycombId));
			if (native === null) {
				// Nothing live to re-install (no current substrate version, a tombstone, or an empty blob).
				return { ok: false, action: "enable", assetType: req.assetType, honeycombId, state: "", version: 0 };
			}
			const path = await installTarget.write(req.assetType, "project", req.name, native);
			const ok = path !== null;
			return { ok, action: "enable", assetType: req.assetType, honeycombId, state: ok ? "pulled" : "", version: 0 };
		},

		async disable(req: SyncActionRequest): Promise<SyncActionResult> {
			// Disable = remove the local install (present-but-inactive on disk → absent). No substrate change.
			const removed = await installTarget.remove(req.assetType, "project", req.name);
			return { ok: removed, action: "disable", assetType: req.assetType, honeycombId: req.honeycombId ?? "", state: "", version: 0 };
		},
	};
}

/** Resolve the substrate-engine deps, defaulting `target` to the catalog table. */
function resolveEngineDeps(deps: SyncActionApiDeps): AssetSyncEngineDeps {
	if (deps.engineDeps !== undefined) return deps.engineDeps;
	return { storage: deps.storage };
}

/**
 * Derive a stable `hc_<32hex>` id from a name for a promote that carries no substrate id yet (the
 * asset has no frontmatter id). A deterministic 32-hex digest of the name keeps the id a single safe
 * token (`isHoneycombId`-shaped) and stable across re-promotes of the same name, so a republish bumps
 * the SAME logical row's version rather than forking a new artifact. Not cryptographic — identity
 * only (a real frontmatter id, when present, always wins because the page sends it).
 */
function hashName(name: string): string {
	// FNV-1a over the name, expanded to 32 hex chars by mixing four rotated passes. Deterministic,
	// dependency-free, and confined to `[0-9a-f]` so the result satisfies `isHoneycombId`.
	let acc = "";
	let h = 0x811c9dc5;
	for (let pass = 0; pass < 4; pass++) {
		for (let i = 0; i < name.length; i++) {
			h ^= name.charCodeAt(i) + pass;
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		acc += (h >>> 0).toString(16).padStart(8, "0");
	}
	return acc.slice(0, 32);
}
