/**
 * Opt-out precedence resolution (PRD-064e AC-064e.4, PRD-064 OD-5).
 *
 * The watch loop, the auto-update poll loop, and the `status` command all need ONE
 * answer to "is auto-update disabled, and is there a version pin?" computed from three
 * sources with a defined precedence. Centralizing it here means the composition root and
 * the CLI agree on exactly one resolution, and a test can pin every branch.
 *
 * Precedence (highest wins), per OD-5 + AC-064e.4:
 *   1. CLI flag `--no-auto-update`           - the operator's explicit, in-the-moment choice.
 *   2. Env `HONEYCOMB_NO_AUTO_UPDATE=1`      - an install/service-level toggle.
 *   3. state.json `autoUpdateDisabled: true` - the persisted dashboard toggle (OD-5).
 *      (Wave-0 state.json has no such field yet; it is read defensively so a later wave
 *      can add it without touching this resolver.)
 *
 * A pin (a version HiveDoctor must stay on) also disables forward auto-update; its source
 * is the same env/state layering. A pin present at ANY layer disables forward motion
 * (AC-064e.4 "a pinned version that disables forward updates").
 *
 * Pure: takes the three already-read inputs and returns the resolved booleans + the pin.
 * No I/O, never throws. Built-ins only.
 */

/** The three already-read inputs the resolver layers. */
export interface OptOutInputs {
	/** True when `--no-auto-update` was passed on the CLI. */
	readonly cliNoAutoUpdate: boolean;
	/** The process env (read for `HONEYCOMB_NO_AUTO_UPDATE` and `HONEYCOMB_PIN_VERSION`). */
	readonly env: NodeJS.ProcessEnv;
	/**
	 * The persisted dashboard toggle, when a later wave records it in state.json. Read
	 * defensively by the caller; undefined/absent means "not disabled by state".
	 */
	readonly stateAutoUpdateDisabled?: boolean;
	/** A pin persisted in state.json, when present. */
	readonly statePinnedVersion?: string;
}

/** The resolved opt-out + pin the poll loop and CLI consume. */
export interface ResolvedOptOut {
	/** True when auto-update must not run (any source disabled it, or a pin is present). */
	readonly autoUpdateDisabled: boolean;
	/** The pinned version, when any source supplied one (disables forward updates). */
	readonly pinnedVersion?: string;
	/** Which layer made the decision (for `status` to explain the opt-out honestly). */
	readonly source: "cli" | "env" | "state" | "pin" | "none";
}

/** The env var that toggles auto-update off at the install/service layer. */
export const ENV_NO_AUTO_UPDATE = "HONEYCOMB_NO_AUTO_UPDATE" as const;

/** The env var that pins the primary daemon to a fixed version (disables forward updates). */
export const ENV_PIN_VERSION = "HONEYCOMB_PIN_VERSION" as const;

/** True iff an env value reads as an explicit "on" toggle (`1`, `true`, `yes`). */
function envTruthy(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const v = raw.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/** Trim a non-empty pin string, or undefined when absent/empty. */
function cleanPin(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const v = raw.trim();
	return v.length > 0 ? v : undefined;
}

/**
 * Resolve the opt-out + pin from the three layers in precedence order. A pin at any layer
 * (env or state) implies `autoUpdateDisabled: true` because a pin disables forward motion.
 */
export function resolveOptOut(inputs: OptOutInputs): ResolvedOptOut {
	// A pin from any source disables forward updates regardless of the toggles.
	const pin = cleanPin(inputs.env[ENV_PIN_VERSION]) ?? cleanPin(inputs.statePinnedVersion);

	// 1. CLI flag - the explicit in-the-moment choice wins.
	if (inputs.cliNoAutoUpdate) {
		return pin !== undefined
			? { autoUpdateDisabled: true, pinnedVersion: pin, source: "cli" }
			: { autoUpdateDisabled: true, source: "cli" };
	}

	// 2. Env toggle.
	if (envTruthy(inputs.env[ENV_NO_AUTO_UPDATE])) {
		return pin !== undefined
			? { autoUpdateDisabled: true, pinnedVersion: pin, source: "env" }
			: { autoUpdateDisabled: true, source: "env" };
	}

	// 3. Persisted dashboard toggle.
	if (inputs.stateAutoUpdateDisabled === true) {
		return pin !== undefined
			? { autoUpdateDisabled: true, pinnedVersion: pin, source: "state" }
			: { autoUpdateDisabled: true, source: "state" };
	}

	// 4. A pin alone (no toggle) still disables forward motion.
	if (pin !== undefined) {
		return { autoUpdateDisabled: true, pinnedVersion: pin, source: "pin" };
	}

	// Nothing disabled it.
	return { autoUpdateDisabled: false, source: "none" };
}
