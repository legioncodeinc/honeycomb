/**
 * HiveDoctor's OWN package version, single-sourced (PRD-064f / PRD-064 OD-6).
 *
 * The version is build-injected via esbuild `define` (`__HIVEDOCTOR_VERSION__`),
 * mirroring the parent package's `__HONEYCOMB_VERSION__` discipline. The `typeof`
 * guard means an un-bundled dev/test build falls through to the env fallback and
 * finally a stable sentinel, so `tsc --noEmit` stays clean and the CLI still runs
 * without a bundle present.
 *
 * Why a constant and not a `package.json` read at runtime: the can't-crash runtime
 * is Node built-ins only and must never depend on a relative `package.json` being
 * present beside the bundle. The single source of truth remains `package.json`; the
 * later-wave `sync-versions` + esbuild `define` propagate it here. NOTHING in this
 * package hardcodes a version string anywhere else - every reader imports
 * {@link HIVEDOCTOR_VERSION}.
 */

/** The HiveDoctor package version, build-injected with safe env/sentinel fallbacks. */
export const HIVEDOCTOR_VERSION: string =
	typeof __HIVEDOCTOR_VERSION__ === "string" && __HIVEDOCTOR_VERSION__.length > 0
		? __HIVEDOCTOR_VERSION__
		: (process.env["HIVEDOCTOR_VERSION"] ?? "0.0.0-dev");

/** The npm package name of HiveDoctor itself (the ONLY thing `self-update` ever installs). */
export const HIVEDOCTOR_PACKAGE = "@legioncodeinc/hivedoctor" as const;
