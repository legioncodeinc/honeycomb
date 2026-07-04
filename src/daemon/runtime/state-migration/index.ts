/**
 * State-migration barrel (PRD-072a/072b). Exposes the engine, the movers, and the one convenience
 * entry the composition root calls at assembly.
 */

import { honeycombStateDir, legacyHoneycombDir, resolveFleetRoot } from "../../../shared/fleet-root.js";
import { buildStateFamilyMovers } from "./families.js";
import { type MigrationFs, type MigrationReport, runStateMigration } from "./migrate.js";

export {
	type FamilyOutcome,
	type MigrationFs,
	type MigrationReport,
	MIGRATION_MARKER_FILE,
	nodeMigrationFs,
	type RunFamilyResult,
	runStateMigration,
	type StateFamilyMover,
} from "./migrate.js";
export { buildStateFamilyMovers, type StateMigrationDirs } from "./families.js";

/** Options for {@link runHoneycombStateMigration} (all seams injectable for tests). */
export interface HoneycombStateMigrationOptions {
	/** The env used to resolve the fleet root. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform used to resolve the fleet root. Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
	/** The home dir the roots anchor on. Defaults to `os.homedir()`. */
	readonly home?: string;
	/** The marker fs seam. Defaults to the real `node:fs`. */
	readonly fs?: MigrationFs;
	/** The marker clock. Defaults to the wall clock. */
	readonly now?: () => string;
	/** A one-line log sink (best-effort). Defaults to a no-op. */
	readonly onLog?: (message: string) => void;
}

/**
 * Resolve the fleet dirs from the ADR-0003 chain and run every honeycomb state-family mover once
 * (PRD-072). Fail-soft: always returns a report, never throws into the daemon boot path. The caller
 * runs this BEFORE any state-family store initializes so a store never mints fresh state at the new
 * path and orphans the legacy data.
 */
export function runHoneycombStateMigration(options: HoneycombStateMigrationOptions = {}): MigrationReport {
	const rootOptions = {
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.platform !== undefined ? { platform: options.platform } : {}),
		...(options.home !== undefined ? { home: options.home } : {}),
	};
	const honeycombDir = honeycombStateDir(rootOptions);
	const legacyDir = legacyHoneycombDir(options.home);
	const fleetRoot = resolveFleetRoot(rootOptions);
	const movers = buildStateFamilyMovers({ honeycombDir, legacyDir, fleetRoot });
	return runStateMigration({
		stateDir: honeycombDir,
		movers,
		...(options.fs !== undefined ? { fs: options.fs } : {}),
		...(options.now !== undefined ? { now: options.now } : {}),
		...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
	});
}
