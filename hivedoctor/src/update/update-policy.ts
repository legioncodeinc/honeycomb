/**
 * The auto-update gate decision (PRD-064e AC-064e.1 / .2 / .4).
 *
 * This is the PURE decision function the engine consults before touching npm. Given the
 * installed version, npm `@latest`, the blessed-channel result, and the opt-out/pin
 * inputs, it returns either a `{ update: true, toVersion }` go or a `{ update: false,
 * reason }` no-go. It performs NO I/O -- the engine fetches latest + blessed and passes
 * them in -- so the gate logic is exhaustively unit-testable without any seam.
 *
 * The gate (in order):
 *   1. Opt-out / pin   -> no update (AC-064e.4: `--no-auto-update`, env, or a pin).
 *   2. Blessed failed  -> no update (FAIL-CLOSED: unreachable/unparseable channel).
 *   3. latest unknown  -> no update (registry read failed this tick).
 *   4. latest is NOT blessed (latest !== blessed)        -> no update (AC-064e.2).
 *   5. blessed is NOT strictly newer than installed       -> no update (already current).
 *   6. minVersion floor: installed below the floor        -> no update (not eligible).
 *   else                                                  -> UPDATE to the blessed version.
 *
 * The version targeted for install is ALWAYS the blessed version, never raw `@latest`:
 * even when `latest === blessed` the engine installs the exact blessed string so the
 * install is pinned to the audited bits (PRD-064e: "npm i -g <blessed>").
 */

import type { BlessedFetchResult } from "./blessed-channel.js";
import { isSameVersion, isStrictlyNewer } from "./version.js";

/** The opt-out + pin inputs the caller resolves from flags / env / state.json. */
export interface UpdateOptOut {
	/**
	 * True when auto-update is disabled entirely (`--no-auto-update`, an env toggle, or
	 * the operator's choice persisted in state). The caller resolves the precedence; the
	 * gate only needs the boolean (AC-064e.4).
	 */
	readonly autoUpdateDisabled: boolean;
	/**
	 * An optional pinned version. When set, forward updates are disabled: the daemon stays
	 * on the pin regardless of what is blessed (AC-064e.4, "a pinned version that disables
	 * forward updates"). The pin's exact string is not compared here -- its mere presence
	 * disables forward motion.
	 */
	readonly pinnedVersion?: string;
}

/** The inputs to {@link decideUpdate}. All already-resolved values; no I/O. */
export interface UpdateDecisionInput {
	/** The currently-installed primary version (from the injected installed-version reader). */
	readonly installedVersion: string;
	/** npm `@latest`, or null when the registry read failed this tick. */
	readonly latestVersion: string | null;
	/** The blessed-channel result (fail-closed; a failure means stay put). */
	readonly blessed: BlessedFetchResult;
	/** Opt-out + pin inputs (AC-064e.4). */
	readonly optOut: UpdateOptOut;
}

/** Why the gate declined to update (each maps to an AC). */
export type NoUpdateReason =
	| "opted_out" // AC-064e.4: auto-update disabled
	| "pinned" // AC-064e.4: a pin disables forward updates
	| "installed_unknown" // the installed-package read failed this tick (no rollback target)
	| "blessed_unavailable" // AC-064e.2 (fail-closed half): channel unreachable/unparseable
	| "latest_unknown" // registry read failed this tick
	| "latest_not_blessed" // AC-064e.2: @latest is newer but not blessed
	| "already_current" // blessed is not strictly newer than installed
	| "below_min_version" // installed is below the blessed manifest's minVersion floor
	;

/** The gate decision: a go (with the exact version to install) or a no-go (with a reason). */
export type UpdateDecision =
	| { readonly update: true; readonly toVersion: string }
	| { readonly update: false; readonly reason: NoUpdateReason };

/**
 * Decide whether to auto-update. Pure: no I/O, no seams, fully unit-testable. Returns the
 * exact BLESSED version to install on a go (never raw `@latest`).
 */
export function decideUpdate(input: UpdateDecisionInput): UpdateDecision {
	// 1. Opt-out / pin first -- these short-circuit before any version reasoning (AC-064e.4).
	if (input.optOut.autoUpdateDisabled) return { update: false, reason: "opted_out" };
	if (input.optOut.pinnedVersion !== undefined && input.optOut.pinnedVersion.trim().length > 0) {
		return { update: false, reason: "pinned" };
	}

	// 2. Fail-closed: a blessed channel we could not read means stay on current (AC-064e.2).
	if (!input.blessed.ok) return { update: false, reason: "blessed_unavailable" };
	const blessedVersion = input.blessed.manifest.version;

	// 3. Registry read failed this tick: nothing to compare against.
	if (input.latestVersion === null) return { update: false, reason: "latest_unknown" };

	// 4. The gate: @latest must EQUAL the blessed version. Newer-but-not-blessed holds
	//    (AC-064e.2): a fresh publish that has not been blessed for rollout is ignored.
	if (!isSameVersion(input.latestVersion, blessedVersion)) {
		return { update: false, reason: "latest_not_blessed" };
	}

	// 5. The blessed version must be strictly newer than what is installed, else no-op.
	if (!isStrictlyNewer(blessedVersion, input.installedVersion)) {
		return { update: false, reason: "already_current" };
	}

	// 6. Optional floor: an install older than the manifest's minVersion is not eligible to
	//    forward-update (e.g. a breaking migration must be done manually).
	const minVersion = input.blessed.manifest.minVersion;
	if (minVersion !== undefined && isStrictlyNewer(minVersion, input.installedVersion)) {
		return { update: false, reason: "below_min_version" };
	}

	return { update: true, toVersion: blessedVersion };
}
