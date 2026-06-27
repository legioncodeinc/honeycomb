/**
 * The `--no-hivedoctor` install-time opt-out guard (PRD-064b, OD-5 / parent AC-10).
 *
 * `--no-hivedoctor` is the ONLY install-time switch. When it is passed (as a flag) OR set
 * via the env equivalent (`HONEYCOMB_NO_HIVEDOCTOR=1`), the bootstrap installer must NOT
 * install the `@legioncodeinc/hivedoctor` package and must NOT register its OS service - so
 * NO HiveDoctor process ever runs (parent AC-10).
 *
 * This pure decision lives here so it is the single source of truth the two shell installers
 * (`scripts/install/install.sh`, `install.ps1`) mirror, and so it is unit-testable without a
 * shell. The shell scripts implement EXACTLY this contract: skip the bootstrap when the flag
 * or the env opt-out is present. Finer toggles (telemetry off, auto-update off, observe-only)
 * live in the dashboard, never as install flags (OD-5).
 *
 * Built-ins only; pure function.
 */

/** The single install-time opt-out flag (OD-5). */
export const NO_HIVEDOCTOR_FLAG = "--no-hivedoctor" as const;

/** The env equivalent the shell installers also honor. */
export const NO_HIVEDOCTOR_ENV = "HONEYCOMB_NO_HIVEDOCTOR" as const;

/** Inputs to the guard: the install argv tail + the process env. */
export interface InstallGuardInput {
	/** The argv passed to the installer (e.g. `["--ref", "mario", "--no-hivedoctor"]`). */
	readonly argv: readonly string[];
	/** The process env (the `HONEYCOMB_NO_HIVEDOCTOR` opt-out is read here). */
	readonly env: NodeJS.ProcessEnv;
}

/**
 * Decide whether the HiveDoctor bootstrap (npm install + `hivedoctor install-service`) should
 * run. Returns `false` when the user opted out via the flag or the env equivalent; `true`
 * (the default) otherwise. The env value is treated as opt-out when it is "1" or "true"
 * (case-insensitive), matching the daemon's other env-boolean conventions.
 */
export function shouldBootstrapHiveDoctor(input: InstallGuardInput): boolean {
	// Flag form: `--no-hivedoctor` anywhere in the argv.
	if (input.argv.includes(NO_HIVEDOCTOR_FLAG)) return false;

	// Env form: HONEYCOMB_NO_HIVEDOCTOR=1 / true (case-insensitive).
	const raw = input.env[NO_HIVEDOCTOR_ENV];
	if (raw !== undefined) {
		const v = raw.trim().toLowerCase();
		if (v === "1" || v === "true") return false;
	}

	return true;
}
