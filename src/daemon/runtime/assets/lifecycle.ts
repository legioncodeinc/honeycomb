/**
 * PRD-033b — Asset lifecycle: the tier × style transitions (Wave 3, FULL).
 *
 * ── What this module owns (b-AC-1..6 / FR-1..FR-8) ───────────────────────────
 * The lifecycle that moves an artifact through the 6-cell tier × style lattice
 * under explicit user control. Two operations:
 *
 *   1. {@link registerAsset} — record a NEW artifact at the `Local` tier with an
 *      explicit style + its `honeycomb_id` (FR-1 / b-AC-1). `Local` is UNMANAGED,
 *      so registration writes ONLY the local registry and NOTHING to DeepLake —
 *      no publish call is made. This is the entry point onto the lattice.
 *
 *   2. {@link transitionAsset} — move an artifact between cells (FR-2..FR-7 /
 *      b-AC-2..6). Every move is gated through {@link isLegalTransition} (an illegal
 *      endpoint is REFUSED). The tier delta drives the DeepLake side:
 *        - PROMOTE to `Device`/`Team`  → `deps.sync.publish` at the NEW tier's blast
 *          radius (Team → org + workspace; Device → author + device_set). FR-4.
 *        - DEMOTE (including a jump, e.g. `Team → Local`) → `deps.sync.tombstone`
 *          for EVERY wider tier the artifact is LEAVING, so no consuming audience is
 *          missed (FR-5). A `Team → Local` jump tombstones BOTH Team and Device.
 *        - to `Local`                  → publishes NOTHING (Local is unmanaged, FR-4).
 *      A pure style flip (no tier change) re-keys in the registry and publishes/
 *      tombstones nothing (style is orthogonal to reach — FR-3).
 *      The registry ALWAYS ends in EXACTLY ONE cell (b-AC-6).
 *
 * ── Daemon-only DeepLake (D-6 / FR-8) ────────────────────────────────────────
 * This module performs the DeepLake side ONLY through the injected
 * {@link AssetSyncApi} ({@link AssetLifecycleDeps.sync}). It never opens DeepLake
 * itself — the CLI binds the loopback `createLoopbackAssetSyncApi` (033c) here, and
 * a test binds a fake. The registry ({@link AssetLifecycleDeps.registry}) is the
 * LOCAL `.honeycomb/registry.json` store (pure FS, D-2) — local bookkeeping, not
 * team state. So this lifecycle is pure orchestration over two injected seams: it
 * holds no storage handle and builds no SQL.
 *
 * The IDENTITY decision (mint/stamp the `honeycomb_id`), the artifact READ, and the
 * content HASH are done by the CALLER (the CLI, which touches the filesystem) and
 * passed in — keeping this module a deterministic, FS-free orchestration over the
 * registry + sync seams.
 */

import { type SyncedAssetType } from "../../storage/catalog/synced-assets.js";
import {
	type AssetScope,
	type AssetSyncApi,
	type LatticeCell,
	type Tier,
} from "./contracts.js";
import { isLegalTransition, TIER_RANK, tierDirection } from "./lattice.js";
import { type AssetRegistryStore, type RegistryEntry } from "./registry.js";

/** The standard "PRD-033b/033c fills this" thrower (kept for any unfilled seam). */
export function notImplemented(what: string): never {
	throw new Error(`assets: ${what} is not implemented in Wave 1 (PRD-033b / 033c owns it — see CONVENTIONS.md)`);
}

/** The injectable seams the lifecycle (033b) runs against. Pinned for Wave 2/3. */
export interface AssetLifecycleDeps {
	/** The daemon publish/pull/tombstone API (033c implements; 033b calls). The ONLY DeepLake path (D-6). */
	readonly sync: AssetSyncApi;
	/** The `.honeycomb/registry.json` source of truth (local FS bookkeeping, D-2). */
	readonly registry: AssetRegistryStore;
}

/**
 * The inputs to register a NEW artifact (b-AC-1 / FR-1). The CALLER (the CLI) has
 * already resolved the artifact's stable `honeycombId` (mint + frontmatter stamp,
 * D-3), read its bytes, and computed its `contentHash` — this is the FS-free record
 * those values flow into. Registration always lands at the `Local` tier; only the
 * STYLE is the caller's choice.
 */
export interface RegisterAssetInput {
	/** The rename-stable identity the caller resolved (minted + stamped, D-3). */
	readonly honeycombId: string;
	/** The artifact kind (`skill` directory | `agent` file). */
	readonly assetType: SyncedAssetType;
	/** The native harness this artifact targets (the `(assetType, harness)` key half). */
	readonly harness: string;
	/** The explicit style the user chose (`Repository` project-local | `User` global). */
	readonly style: LatticeCell["style"];
	/** The artifact's current content/merkle hash (recorded as the local hash). */
	readonly contentHash: string;
	/** The resolved tenancy + audience identity (org/workspace/author/deviceId). */
	readonly scope: AssetScope;
	/**
	 * The on-disk path the artifact was registered from (the agent FILE or the skill
	 * DIRECTORY). Recorded so a later PROMOTE re-reads the artifact's CURRENT bytes from
	 * it (F-3). Optional — omitted when the caller has no path to record.
	 */
	readonly sourcePath?: string;
}

/**
 * Register a NEW artifact at its initial `Local` cell (b-AC-1 / FR-1). Writes a
 * {@link RegistryEntry} at tier `Local` + the explicit style, recording the
 * `honeycombId`, the harness, the content hash (as `localHash`), and the tenancy.
 * Makes NO DeepLake write — `Local` is unmanaged, so `deps.sync.publish` is never
 * called (b-AC-1). Returns the written entry.
 *
 * Idempotent by id: re-registering a known `honeycombId` REPLACES its registry
 * entry (the store is keyed by id) — it never forks a second artifact (a-AC-3).
 */
export async function registerAsset(deps: AssetLifecycleDeps, input: RegisterAssetInput): Promise<RegistryEntry> {
	const entry: RegistryEntry = {
		assetType: input.assetType,
		harness: input.harness,
		// FR-1 / b-AC-1: a fresh registration is ALWAYS Local (unmanaged) — nothing to DeepLake.
		tier: "Local",
		style: input.style,
		// Version 0 is the unpublished baseline; the first PROMOTE publishes and records the
		// daemon-assigned version (FR-4). The registry version tracks the last published version.
		version: 0,
		honeycombId: input.honeycombId,
		// v1 RECORDS the three hashes (FR-6) but does not merge; on register, local IS the only
		// known hash (no sync yet → lastSynced/remote empty).
		lastSyncedHash: "",
		localHash: input.contentHash,
		remoteHash: "",
		author: input.scope.author,
		org: input.scope.org,
		workspace: input.scope.workspace,
		// Device-tier audience is empty until a Device promotion adds this machine (FR-7).
		deviceSet: [],
		// F-3: record the on-disk source so a later promote re-reads the CURRENT bytes. Only
		// set the key when the caller supplied a path (it is optional in the schema).
		...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
	};
	deps.registry.upsert(entry);
	// NO publish — Local is unmanaged (b-AC-1 / FR-7). The await keeps the async contract honest
	// (a future register could pre-warm), but nothing crosses the daemon boundary here.
	await Promise.resolve();
	return entry;
}

/** The inputs to transition an artifact to a new cell (b-AC-2..6 / FR-2..FR-7). */
export interface TransitionAssetInput {
	/** The artifact to move (resolved by the caller from frontmatter/registry, a-AC-3). */
	readonly honeycombId: string;
	/** The target tier, or `undefined` to keep the current tier (a pure style flip). */
	readonly toTier?: Tier;
	/** The target style, or `undefined` to keep the current style (a pure tier move). */
	readonly toStyle?: LatticeCell["style"];
	/** The resolved tenancy + audience identity for the publish/tombstone side (FR-6 / FR-7). */
	readonly scope: AssetScope;
	/**
	 * The current native blob + content hash — required to PUBLISH on a promotion (FR-4). The
	 * caller (CLI) read the artifact off disk; a demotion-only or style-only move ignores these.
	 */
	readonly native?: string;
	readonly contentHash?: string;
	/**
	 * The device set a `Device`-tier publish addresses (this machine added to the author's "my
	 * devices", a-AC-4). Defaults to the entry's recorded set with `scope.deviceId` ensured present.
	 */
	readonly deviceSet?: readonly string[];
}

/** The outcome of a {@link transitionAsset} — what moved + what crossed the daemon (for the CLI to render + assert). */
export interface TransitionResult {
	/** The cell the artifact STARTED in. */
	readonly from: LatticeCell;
	/** The cell the artifact ENDED in (the registry now reflects exactly this — b-AC-6). */
	readonly to: LatticeCell;
	/** The tier direction classification (`promote` widens, `demote` narrows, `none` = style-only). */
	readonly direction: "promote" | "demote" | "none";
	/** True when a {@link AssetSyncApi.publish} crossed the daemon (a promotion to Device/Team — FR-4). */
	readonly published: boolean;
	/** The tiers a demotion tombstoned (every WIDER tier left behind — FR-5). Empty on a promotion/style-only move. */
	readonly tombstonedTiers: readonly Tier[];
	/** The registry entry as it now stands (ends in exactly one cell — b-AC-6). */
	readonly entry: RegistryEntry;
}

/** Raised when a transition is rejected — an unknown artifact or an illegal endpoint. */
export class TransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TransitionError";
	}
}

/**
 * Transition an artifact between cells (b-AC-2..6 / FR-2..FR-7).
 *
 * Resolves the current cell from the registry, computes the target cell (target tier
 * and/or style, each defaulting to the current value), and GATES the move through
 * {@link isLegalTransition} — an illegal endpoint throws {@link TransitionError}
 * (b-AC-6: illegal transitions rejected). Then the tier delta drives DeepLake:
 *
 *   - PROMOTE to `Device`/`Team` → {@link AssetSyncApi.publish} at the NEW tier's
 *     radius (FR-4). The published `cell` carries the target tier + style; the scope
 *     is `{org, workspace}` for Team and `{author, deviceSet}` for Device (FR-6/FR-7).
 *   - DEMOTE (incl. a jump) → {@link AssetSyncApi.tombstone} for EVERY WIDER tier the
 *     artifact is LEAVING (FR-5). A `Team → Local` jump tombstones BOTH `Team` and
 *     `Device` — so a consumer at either radius retracts on its next pull. A demotion
 *     ending above `Local` (e.g. `Team → Device`) tombstones only the tiers strictly
 *     wider than the target (here: `Team`).
 *   - to `Local`, or a pure STYLE flip → no publish (Local is unmanaged; style is
 *     orthogonal to reach — FR-3/FR-4).
 *
 * Finally the registry is updated so the artifact ends in EXACTLY ONE cell (b-AC-6),
 * carrying the new tier/style, the device set, and (on a publish) the daemon-assigned
 * version + the published hashes.
 *
 * @throws {TransitionError} when the artifact is unknown or the endpoint is illegal.
 */
export async function transitionAsset(deps: AssetLifecycleDeps, input: TransitionAssetInput): Promise<TransitionResult> {
	const current = deps.registry.read().find((e) => e.honeycombId === input.honeycombId);
	if (current === undefined) {
		throw new TransitionError(`unknown artifact '${input.honeycombId}' (register it before changing its tier/style)`);
	}

	const from: LatticeCell = { tier: current.tier, style: current.style };
	const to: LatticeCell = {
		tier: input.toTier ?? current.tier,
		style: input.toStyle ?? current.style,
	};

	// b-AC-6: gate through the single transition authority; an illegal endpoint is REFUSED.
	if (!isLegalTransition(from, to)) {
		throw new TransitionError(`illegal transition ${from.tier}/${from.style} → ${to.tier}/${to.style}`);
	}

	const direction = tierDirection(from.tier, to.tier);

	// The device set a Device-tier publish/tombstone addresses: the caller's set (or the entry's),
	// with THIS machine's deviceId ensured present (a-AC-4). Empty for non-Device reach.
	const deviceSet = ensureDeviceId(input.deviceSet ?? current.deviceSet, input.scope.deviceId);

	let published = false;
	let publishedVersion = current.version;
	let remoteHash = current.remoteHash;
	let lastSyncedHash = current.lastSyncedHash;
	const tombstonedTiers: Tier[] = [];

	if (direction === "promote" && to.tier !== "Local") {
		// FR-4: a promotion to Device/Team publishes at the NEW radius. The publish carries the
		// target cell; the scope/deviceSet bound the audience (Team → org+workspace; Device →
		// author+deviceSet). The native blob + hash come from the caller (the CLI read the file).
		const contentHash = input.contentHash ?? current.localHash;
		const res = await deps.sync.publish({
			honeycombId: current.honeycombId,
			assetType: current.assetType,
			harness: current.harness,
			native: input.native ?? "",
			canonical: input.native ?? "",
			contentHash,
			cell: to,
			scope: input.scope,
			deviceSet: to.tier === "Device" ? deviceSet : [],
		});
		published = res.published;
		publishedVersion = res.version;
		remoteHash = contentHash;
		lastSyncedHash = contentHash;
	} else if (direction === "demote") {
		// FR-5: a demotion tombstones EVERY WIDER tier the artifact is LEAVING, so no consuming
		// audience is missed. "Wider" = strictly higher rung than the TARGET tier. A Team → Local
		// jump leaves Team (rank 2) and Device (rank 1) → tombstone both. A Team → Device demotion
		// leaves only Team. Each tombstone is written at the SAME radius the artifact occupied at
		// that tier, so the retraction reaches exactly the audience that received it.
		for (const tier of widerTiersLeft(from.tier, to.tier)) {
			await deps.sync.tombstone({
				honeycombId: current.honeycombId,
				assetType: current.assetType,
				harness: current.harness,
				cell: { tier, style: current.style },
				scope: input.scope,
				// A Device-tier tombstone must reach the device set the original Device row addressed.
				deviceSet: tier === "Device" ? deviceSet : [],
			});
			tombstonedTiers.push(tier);
		}
	}
	// to `Local` (the inverse of promote into Local is handled by the demote branch above), a
	// same-tier move, or a pure style flip: nothing crosses the daemon (style is orthogonal, FR-3).

	// b-AC-6: persist the SINGLE resulting cell. A promotion records the daemon-assigned version +
	// the published hashes; a demotion keeps the version (append-only — the tombstone is a new
	// remote row, but the registry tracks the artifact's last-known published version) and the
	// device set narrows only when it leaves Device entirely.
	const entry: RegistryEntry = {
		...current,
		tier: to.tier,
		style: to.style,
		version: publishedVersion,
		localHash: input.contentHash ?? current.localHash,
		remoteHash,
		lastSyncedHash,
		// Keep the device set while still at/above Device reach; clear it when the artifact lands at Local.
		deviceSet: to.tier === "Local" ? [] : [...deviceSet],
	};
	deps.registry.upsert(entry);

	return { from, to, direction, published, tombstonedTiers, entry };
}

/**
 * The tiers strictly WIDER than `target` that `origin` was at-or-above — i.e. every
 * tier a demotion `origin → target` is LEAVING (FR-5). Returned widest-first so a
 * `Team → Local` jump yields `[Team, Device]`. A non-demotion (or a target at/above
 * origin) yields the empty set.
 */
function widerTiersLeft(origin: Tier, target: Tier): readonly Tier[] {
	const originRank = TIER_RANK[origin];
	const targetRank = TIER_RANK[target];
	if (targetRank >= originRank) return [];
	const leaving: Tier[] = [];
	// Walk the managed (non-Local) tiers from the origin DOWN to (but not including) the target.
	for (const tier of ["Team", "Device"] as const) {
		const rank = TIER_RANK[tier];
		if (rank <= originRank && rank > targetRank) leaving.push(tier);
	}
	return leaving;
}

/** Ensure `deviceId` is present in the set (dedup, order-stable) — the "my devices" membership (a-AC-4). */
function ensureDeviceId(set: readonly string[], deviceId: string): readonly string[] {
	if (deviceId === "" || set.includes(deviceId)) return [...set];
	return [...set, deviceId];
}
