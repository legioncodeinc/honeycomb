/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-033a — Asset-Sync Substrate · SHARED CONTRACTS (Wave 1)             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This module is the PINNED, STABLE seam Wave 2 builds against. PRD-033b
 * (lifecycle + CLI) and PRD-033c (sync engine + daemon API) both implement
 * AGAINST the shapes declared here; getting them right + stable now is the whole
 * point of the foundation. A Wave-2 Bee adds NO type here without a coordinated
 * change — these are the request/response shapes that cross the daemon boundary
 * and the adapter seam both halves depend on.
 *
 * What lives here (and ONLY here):
 *   1. The 6-cell tier × style lattice types ({@link Tier} / {@link Style} /
 *      {@link LatticeCell}) — the FR-7 state machine's vocabulary.
 *   2. The daemon publish / pull / tombstone REQUEST + RESPONSE shapes — the
 *      wire contract for `/api/assets` (PRD-033c mounts it; PRD-033b calls it).
 *   3. The {@link AssetAdapter} seam (`render` / `parse`) + the IDENTITY adapter
 *      (native → native, `parse(render(x)) === x`, a-AC-6 / c-AC-4).
 *   4. The {@link AudiencePredicate} signature — who a pulled row is FOR
 *      (user / workspace / device-set, tombstone-honoring).
 *
 * Daemon-only DeepLake (D-6): nothing here opens DeepLake. These are pure data
 * shapes + seams. The publish/pull engine (033c) and the lifecycle CLI (033b)
 * reach the `synced_assets` table ONLY through the daemon over port 3850; this
 * contracts module is import-safe from either side of that boundary.
 */

import { type SyncedAssetType } from "../../storage/catalog/synced-assets.js";

// Re-export the asset-type vocabulary so a Wave-2 Bee imports the lattice AND
// the asset kind from ONE place (the contracts seam), not two.
export { SYNCED_ASSET_TYPES, type SyncedAssetType } from "../../storage/catalog/synced-assets.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The tier × style lattice (FR-7 / a-AC-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The propagation TIER — how far an artifact syncs (FR-7):
 *   - `Local`  — UNMANAGED. Never synced to DeepLake at all (the substrate
 *                ignores it entirely).
 *   - `Device` — syncs only to the SAME user's other devices (keyed by author
 *                identity + the device set).
 *   - `Team`   — syncs to ALL authors in the same workspace.
 */
export const TIERS = Object.freeze(["Local", "Device", "Team"] as const);
export type Tier = (typeof TIERS)[number];

/**
 * The propagation STYLE — the keying axis, orthogonal to tier (FR-7):
 *   - `Repository` — keyed by project (the `projectKey` SHA-1 of the git remote;
 *                    absolute-path fallback for non-git). Project-local.
 *   - `User`       — global across every repo on the machine.
 */
export const STYLES = Object.freeze(["Repository", "User"] as const);
export type Style = (typeof STYLES)[number];

/** One of the 6 lattice cells an artifact resolves to (a-AC-5). */
export interface LatticeCell {
	readonly tier: Tier;
	readonly style: Style;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The daemon publish / pull / tombstone wire contract.
//    PRD-033c MOUNTS these at the protected `/api/assets` daemon route; PRD-033b
//    CALLS them through the loopback daemon client. The shapes are the contract.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tenancy + audience scope every publish/pull/tombstone request carries.
 * `org` + `workspace` bound the `Team` radius; `author` + `deviceSet` bound the
 * `Device` radius. The daemon applies `org`/`workspace` as a storage partition
 * filter AND honors the audience predicate over the rows it reads.
 */
export interface AssetScope {
	/** Resolved org for the request (the storage partition + Team boundary). */
	readonly org: string;
	/** Resolved workspace (the Team audience boundary). */
	readonly workspace: string;
	/** The acting author identity (the Device audience boundary). */
	readonly author: string;
	/** The acting device's stable `device_id` (the Device audience membership test). */
	readonly deviceId: string;
}

// ── publish ──────────────────────────────────────────────────────────────────

/**
 * Publish ONE artifact version (PRD-033c c-AC-1). The daemon INSERTs a
 * version-bumped `synced_assets` row carrying the verbatim `native` blob keyed
 * `(assetType, harness)`, the reserved `canonical` blob, the `contentHash`, the
 * tier/style placement, the tenancy, and the `deviceSet` (for `Device` tier).
 *
 * `Local`-tier artifacts are NEVER published (a-AC-1 / FR-7) — the lifecycle
 * (033b) refuses to call publish for a `Local` cell, so a publish request always
 * carries a `Device` or `Team` tier.
 */
export interface PublishRequest {
	/** The rename-stable identity of the artifact being published. */
	readonly honeycombId: string;
	/** The artifact kind (`skill` directory | `agent` file). */
	readonly assetType: SyncedAssetType;
	/** The native harness this blob targets (the `(assetType, harness)` key half). */
	readonly harness: string;
	/** The verbatim native artifact blob (written to `native` unchanged). */
	readonly native: string;
	/** The reserved canonical blob (v1: the identity adapter's `render` output; default `""`). */
	readonly canonical: string;
	/** The artifact's content/merkle hash (change detection). */
	readonly contentHash: string;
	/** The lattice cell this version is published at (tier is `Device` or `Team`). */
	readonly cell: LatticeCell;
	/** The tenancy + audience scope. */
	readonly scope: AssetScope;
	/** The device-set the `Device`-tier audience is keyed by (empty for `Team`). */
	readonly deviceSet: readonly string[];
}

/** The result of a {@link PublishRequest} (c-AC-1). */
export interface PublishResponse {
	/** The honeycomb_id the row was written under (echoed for the caller's registry). */
	readonly honeycombId: string;
	/** The version the new row was written at (N+1 over the prior highest). */
	readonly version: number;
	/** True when the row landed (the version-bumped INSERT succeeded). */
	readonly published: boolean;
}

// ── pull ─────────────────────────────────────────────────────────────────────

/**
 * Pull the artifact versions this caller's audience should receive (PRD-033c
 * c-AC-* / FR-7). The daemon reads the highest-version row per `honeycomb_id`,
 * applies the {@link AudiencePredicate} (user / workspace / device-set), and
 * returns the survivors — INCLUDING tombstone rows, so the caller can RETRACT a
 * demoted artifact (a tombstone is data, not an omission). The pull is
 * idempotent + fail-soft (c-AC-6): an absent table or a slow read yields an
 * empty result within budget, never a thrown error that blocks session start.
 */
export interface PullRequest {
	/** The tenancy + audience scope the pull selects for. */
	readonly scope: AssetScope;
	/** Restrict to a single style (project-local vs global), or undefined for both. */
	readonly style?: Style;
}

/** One artifact version returned by a pull — the daemon's view of a `synced_assets` row. */
export interface PulledAsset {
	readonly honeycombId: string;
	readonly assetType: SyncedAssetType;
	readonly harness: string;
	/** The verbatim native blob to install (empty on a tombstone row). */
	readonly native: string;
	/** The reserved canonical blob (v1: identity adapter output). */
	readonly canonical: string;
	readonly contentHash: string;
	readonly version: number;
	/** True when this is a retraction row — the caller backs up + removes the local copy (D-4). */
	readonly tombstone: boolean;
	readonly cell: LatticeCell;
	/** The device-set the row was published to (for the Device-audience test). */
	readonly deviceSet: readonly string[];
	/** The publishing author (the Device-audience boundary). */
	readonly author: string;
	/** The owning org (the Team-audience boundary). */
	readonly org: string;
	/** The owning workspace (the Team-audience boundary). */
	readonly workspace: string;
}

/** The result of a {@link PullRequest} (c-AC-6). */
export interface PullResponse {
	/** The highest-version rows whose audience matches the caller (tombstones included). */
	readonly assets: readonly PulledAsset[];
	/** True when the SELECT was skipped because `synced_assets` was absent (fail-soft no-op). */
	readonly tableAbsent: boolean;
}

// ── tombstone ────────────────────────────────────────────────────────────────

/**
 * Write a retraction (PRD-033c c-AC-5 / D-5). A tombstone is a fresh
 * version-bumped row with `tombstone='true'` at the SAME lattice radius the
 * artifact previously occupied — NEVER a DELETE. The next pull across that
 * radius sees the tombstone row and retracts the local copy (`.bak` then remove,
 * D-4). The lifecycle (033b) writes one tombstone per WIDER tier a demotion
 * leaves behind.
 */
export interface TombstoneRequest {
	readonly honeycombId: string;
	readonly assetType: SyncedAssetType;
	readonly harness: string;
	/** The lattice cell the tombstone is written at (the radius being retracted). */
	readonly cell: LatticeCell;
	readonly scope: AssetScope;
	/** The device-set the original Device-tier row addressed (so the tombstone reaches it). */
	readonly deviceSet: readonly string[];
}

/** The result of a {@link TombstoneRequest} (c-AC-5). */
export interface TombstoneResponse {
	readonly honeycombId: string;
	/** The version the tombstone row was written at. */
	readonly version: number;
	readonly tombstoned: boolean;
}

/**
 * The daemon-side asset sync API the lifecycle CLI (033b) and the engine (033c)
 * agree on. PRD-033c IMPLEMENTS this (mounting `/api/assets`); PRD-033b CALLS it
 * through a loopback client that satisfies this same interface. Declaring it
 * here keeps both halves honest against ONE shape.
 */
export interface AssetSyncApi {
	publish(req: PublishRequest): Promise<PublishResponse>;
	pull(req: PullRequest): Promise<PullResponse>;
	tombstone(req: TombstoneRequest): Promise<TombstoneResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The AssetAdapter seam + the IDENTITY adapter (a-AC-6 / c-AC-4 / D-7).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The render/parse seam that turns a native harness artifact into the reserved
 * `canonical` form and back (D-7). v1 ships ONLY the identity adapter
 * ({@link IDENTITY_ADAPTER}); the `canonical` column + this interface exist so
 * cross-harness render is ADDITIVE later — a future adapter renders one
 * harness's canonical into another's native with NO schema change and NO re-sync.
 *
 * The invariant every adapter MUST satisfy (c-AC-4): `parse(render(x)) === x`.
 * The native artifact round-trips through the canonical form losslessly.
 */
export interface AssetAdapter {
	/** A stable adapter id (e.g. `"identity"`). */
	readonly id: string;
	/** Render a native artifact into its canonical form. */
	render(native: string): string;
	/** Parse a canonical form back into the native artifact. */
	parse(canonical: string): string;
}

/**
 * The v1 IDENTITY adapter (a-AC-6 / c-AC-4 / D-7). Native IS canonical:
 * `render` and `parse` are the identity function, so `parse(render(x)) === x`
 * trivially holds for any input. Storing the canonical blob now (= the native
 * blob) means a real cross-harness adapter is a later, additive drop-in with no
 * schema change and no re-sync.
 */
export const IDENTITY_ADAPTER: AssetAdapter = Object.freeze({
	id: "identity",
	render: (native: string): string => native,
	parse: (canonical: string): string => canonical,
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The audience-selection predicate (FR-7, tombstone-honoring).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The audience context a pull resolves a row against: WHO is asking. Derived
 * from the {@link AssetScope} the pull carries.
 */
export interface AudienceContext {
	readonly org: string;
	readonly workspace: string;
	readonly author: string;
	readonly deviceId: string;
}

/**
 * Decide whether a pulled row is FOR this audience (FR-7). The predicate is the
 * single rule the pull (033c) applies over each highest-version row:
 *
 *   - `Local`  → never (a Local row never reaches DeepLake, so it never appears,
 *                but the predicate returns false defensively).
 *   - `Device` → the row's `author` matches the caller's author AND the caller's
 *                `deviceId` is in the row's `deviceSet`.
 *   - `Team`   → the row's `org` + `workspace` match the caller's (any author).
 *
 * A tombstone row passes the SAME audience test — it must reach exactly the
 * audience that received the artifact, so the retraction lands across the right
 * radius (D-5 / c-AC-5).
 */
export type AudiencePredicate = (asset: PulledAsset, ctx: AudienceContext) => boolean;

/**
 * The canonical audience predicate (FR-7). Pure: given a row + the asking
 * audience, it answers "this row is for you" by the tier rule above. Shared so
 * 033c's pull and 033b's lifecycle reason about reach IDENTICALLY (no second,
 * drifting copy of the rule).
 */
export const audienceMatches: AudiencePredicate = (asset, ctx) => {
	switch (asset.cell.tier) {
		case "Local":
			return false;
		case "Device":
			return asset.author === ctx.author && asset.deviceSet.includes(ctx.deviceId);
		case "Team":
			return asset.org === ctx.org && asset.workspace === ctx.workspace;
	}
};
