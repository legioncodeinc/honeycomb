/**
 * The per-family state movers (PRD-072b) plugged into 072a's migration bootstrap.
 *
 * Each honeycomb-owned state family moves from `~/.honeycomb/` to `~/.apiary/honeycomb/` (the
 * fleet-shared `device.json` moves to the fleet root `~/.apiary/`). The move primitives live in
 * `move.ts` (shared with the telemetry store's open-time retry): copy-then-atomic-rename, additive,
 * never deleting a legacy file that did not verifiably land at the new path, and never self-marking
 * a family complete just because a store minted a fresh file at the destination (the
 * migrated-vs-minted distinction, QA Critical 2b). The regenerable graph CACHE (`graphs/`) is
 * deliberately NOT copied — it rebuilds lazily at the new path (matching the snapshot cache's
 * self-healing posture); the user-edited `graph-ignore.json` IS moved. Transient claim files under
 * `claims/` are left behind (they expire by design).
 *
 * The secrets machine key is the most delicate: a fresh key at the new path silently orphans every
 * `.secrets/` blob, so its mover is BYTE-VERIFYING (reads both files back and compares) and, on any
 * mismatch, treats the move as failed and leaves the legacy key authoritative (AC-7 / AC-072b.1.3).
 */

import { join } from "node:path";

import { MACHINE_KEY_FILE_NAME } from "../secrets/contracts.js";
import { FLEET_TELEMETRY_DB_FILE_NAME, FLEET_TELEMETRY_DIR_NAME } from "../telemetry/fleet-store.js";
import type { FamilyOutcome, StateFamilyMover } from "./migrate.js";
import { moveDir, moveFile, moveSqliteWithSiblings } from "./move.js";

/** The asset-registry / pulled-skills single JSON file name (mirrors `assets/registry.ts`). */
const ASSET_REGISTRY_FILE = "registry.json" as const;
/** The user-edited codebase-graph ignore set file name (mirrors `codebase/discovery.ts`). */
const GRAPH_IGNORE_FILE = "graph-ignore.json" as const;
/** The notifications state ledger file name (mirrors `notifications/state.ts`). */
const NOTIFICATIONS_STATE_FILE = "notifications-state.json" as const;
/** The shared device-id record file name (mirrors `assets/device.ts`). */
const DEVICE_FILE = "device.json" as const;
/** The skillify state root path segments under the honeycomb dir (mirrors `skillify/watermark.ts`). */
const SKILLIFY_STATE_SEGMENTS = ["state", "skillify"] as const;
/** POSIX file mode for the byte-preserved machine key (owner read/write only). */
const MACHINE_KEY_MODE = 0o600;

/** The resolved directories a family set is built against (the caller resolves these once). */
export interface StateMigrationDirs {
	/** The new per-product honeycomb state dir (`~/.apiary/honeycomb/`). */
	readonly honeycombDir: string;
	/** The legacy honeycomb dir (`~/.honeycomb/`) files migrate from. */
	readonly legacyDir: string;
	/** The fleet root (`~/.apiary/`) the shared `device.json` lands at. */
	readonly fleetRoot: string;
}

/**
 * Build the ordered set of per-family movers (PRD-072b). Ordering matters: the machine key and asset
 * registry migrate before any store that would lazily recreate them, and the telemetry SQLite
 * migrates before `fleet-store.ts` opens it (072a runs the whole bootstrap before stores init).
 */
export function buildStateFamilyMovers(dirs: StateMigrationDirs): StateFamilyMover[] {
	const { honeycombDir, legacyDir, fleetRoot } = dirs;
	return [
		{
			family: "machine-key",
			run: (): FamilyOutcome =>
				moveFile(join(legacyDir, MACHINE_KEY_FILE_NAME), join(honeycombDir, MACHINE_KEY_FILE_NAME), {
					fileMode: MACHINE_KEY_MODE,
					verifyBytes: true,
				}),
		},
		{
			family: "asset-registry",
			run: (): FamilyOutcome => moveFile(join(legacyDir, ASSET_REGISTRY_FILE), join(honeycombDir, ASSET_REGISTRY_FILE)),
		},
		{
			family: "telemetry-sqlite",
			run: (): FamilyOutcome =>
				moveSqliteWithSiblings(
					join(legacyDir, FLEET_TELEMETRY_DIR_NAME, FLEET_TELEMETRY_DB_FILE_NAME),
					join(honeycombDir, FLEET_TELEMETRY_DIR_NAME, FLEET_TELEMETRY_DB_FILE_NAME),
				),
		},
		{
			family: "skillify-state",
			run: (): FamilyOutcome =>
				moveDir(join(legacyDir, ...SKILLIFY_STATE_SEGMENTS), join(honeycombDir, ...SKILLIFY_STATE_SEGMENTS)),
		},
		{
			family: "graph-ignore",
			run: (): FamilyOutcome => moveFile(join(legacyDir, GRAPH_IGNORE_FILE), join(honeycombDir, GRAPH_IGNORE_FILE)),
		},
		{
			family: "notifications-state",
			run: (): FamilyOutcome =>
				moveFile(join(legacyDir, NOTIFICATIONS_STATE_FILE), join(honeycombDir, NOTIFICATIONS_STATE_FILE)),
		},
		{
			family: "device-json",
			run: (): FamilyOutcome => moveFile(join(legacyDir, DEVICE_FILE), join(fleetRoot, DEVICE_FILE)),
		},
	];
}
