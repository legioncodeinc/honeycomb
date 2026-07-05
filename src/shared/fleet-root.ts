/**
 * The ONE fleet-root resolution helper (fleet ADR-0003 / PRD-072a) — Tier 1 shared.
 *
 * ADR-0003 introduces a brand-neutral, home-anchored fleet root `~/.apiary/` and splits
 * per-product runtime state (`~/.apiary/honeycomb/`) from the fleet-shared coordination surface
 * (`~/.apiary/registry.json`, `~/.apiary/device.json`, `~/.apiary/install-id`). Every product in
 * the fleet resolves the root through the SAME precedence chain so a path decision here agrees with
 * doctor, nectar, and hive (each mirrors this chain, never imports it across the repo boundary).
 *
 * ── The canonical resolveFleetRoot chain (ADR "Resolved decisions", confirmed 2026-07-04) ──────
 *   1. `APIARY_HOME` env set and non-blank              -> that value
 *      (the installer's `--home=` pin is delivered as `APIARY_HOME` in the service environment;
 *      there is NO config.json recording step — the daemon reads only env at boot, PRD-072a/072d)
 *   2. platform is linux AND `XDG_STATE_HOME` set+non-blank -> join(XDG_STATE_HOME, "apiary")
 *   3. otherwise                                        -> join(home, ".apiary")
 *
 * There is NO `~/.local/state/apiary` default: XDG is honored only when explicitly set. The chain
 * is purely environmental and deterministic — it is anchored on `os.homedir()` and NEVER
 * `process.cwd()`, so the state root cannot inherit a service manager's working directory (the
 * `System32` / `/` footgun is structurally impossible for state).
 *
 * ── Single source of truth (AC-072a.1.4) ────────────────────────────────────────────────────────
 * No other module re-declares the `.apiary` literal or the precedence chain; every target imports
 * these helpers downward (Tier 1), mirroring the `src/shared/constants.ts` discipline.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

import { PRODUCT_SLUG } from "./constants.js";

/** The env var that pins the fleet root (the installer's `--home=` choice is delivered as this). */
export const APIARY_HOME_ENV = "APIARY_HOME" as const;
/** The home-anchored default fleet-root directory name (`~/.apiary`). */
export const APIARY_ROOT_DIR_NAME = ".apiary" as const;
/** The XDG state-home env var honored on Linux ONLY when explicitly set. */
export const XDG_STATE_HOME_ENV = "XDG_STATE_HOME" as const;
/** The fleet subdirectory placed under `$XDG_STATE_HOME` when that variable applies. */
export const APIARY_XDG_SUBDIR = "apiary" as const;
/** The legacy shared fleet directory (`~/.honeycomb`) every product read/wrote before ADR-0003. */
export const LEGACY_FLEET_DIR_NAME = ".honeycomb" as const;

/** The seams the resolver reads so a test drives every precedence step deterministically. */
export interface FleetRootOptions {
	/** The environment to read `APIARY_HOME` / `XDG_STATE_HOME` from. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform (the XDG leg is linux-only). Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
	/** The home dir the default root anchors on. Defaults to `os.homedir()`. NEVER `process.cwd()`. */
	readonly home?: string;
}

/** True when an env value is present and not blank (whitespace-only counts as blank). */
function isSet(value: string | undefined): value is string {
	return value !== undefined && value.trim() !== "";
}

/**
 * True when an env-provided root is an ABSOLUTE path in either dialect. A relative value is ignored
 * (falls through the chain): honoring it would re-anchor every state path on `process.cwd()`, which
 * is exactly the service-manager `System32` / `/` footgun this chain exists to close. The XDG Base
 * Directory spec likewise requires implementations to ignore relative `XDG_*` values.
 * `win32.isAbsolute` is a strict superset of `posix.isAbsolute` (it accepts `/x`, `\x`, and `C:\x`
 * while rejecting `apiary`, `./x`, and drive-relative `C:x`), so ONE dialect-agnostic check covers
 * every host without coupling the guard to the `platform` seam (which only steers the XDG leg).
 */
function isAbsoluteRoot(value: string): boolean {
	return win32.isAbsolute(value);
}

/**
 * Resolve the fleet root through the canonical ADR-0003 chain (AC-072a.1.1 / .1.2 / .1.3). Anchored
 * on `os.homedir()`, never `process.cwd()`. `APIARY_HOME` wins; else `$XDG_STATE_HOME/apiary` on
 * Linux when that variable is explicitly set; else `<home>/.apiary`. Env values are honored only
 * when ABSOLUTE: a relative value falls through the chain so state can never anchor on cwd.
 */
export function resolveFleetRoot(options: FleetRootOptions = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();

	// Trim surrounding whitespace defensively: a service manager can pin a polluted value (e.g. a
	// Windows scheduled task whose `set VAR=value && ...` captured the space before `&&`). An untrimmed
	// trailing space here yields a DIVERGENT `<root> /honeycomb` state dir that doctor's registry can
	// never find — so trim before both the absolute-path check and the return.
	const apiaryHome = env[APIARY_HOME_ENV]?.trim();
	if (isSet(apiaryHome) && isAbsoluteRoot(apiaryHome)) return apiaryHome;

	if (platform === "linux") {
		const xdgStateHome = env[XDG_STATE_HOME_ENV]?.trim();
		if (isSet(xdgStateHome) && isAbsoluteRoot(xdgStateHome)) return join(xdgStateHome, APIARY_XDG_SUBDIR);
	}

	return join(home, APIARY_ROOT_DIR_NAME);
}

/**
 * The honeycomb per-product state directory — `<fleetRoot>/honeycomb/` (pid, lock, config,
 * telemetry, machine key, caches). The product segment is the shared {@link PRODUCT_SLUG} so the
 * `.apiary` literal lives in exactly one place.
 */
export function honeycombStateDir(options: FleetRootOptions = {}): string {
	return join(resolveFleetRoot(options), PRODUCT_SLUG);
}

/** Join a fleet-SHARED file name at the fleet root itself (registry.json, device.json, install-id). */
export function fleetRootFile(name: string, options: FleetRootOptions = {}): string {
	return join(resolveFleetRoot(options), name);
}

/**
 * The legacy honeycomb directory (`~/.honeycomb`) readers fall back to during the compatibility
 * window. Home-anchored, independent of the fleet-root chain. Removed only when the fleet-wide
 * migration window closes (ADR revisit trigger; tracked in the superproject execution ledger).
 */
export function legacyHoneycombDir(home: string = homedir()): string {
	return join(home, LEGACY_FLEET_DIR_NAME);
}

/**
 * New-first, legacy-second path selection for the compatibility window: return `newPath` when it
 * exists, else `legacyPath` when THAT exists, else `newPath` (the creation target). This is the
 * read-side of "migrate to the new root, but never lose continuity if a family has not migrated yet
 * or its mover failed" (PRD-072 migration contract, AC-3).
 */
export function preferExistingPath(newPath: string, legacyPath: string): string {
	if (existsSync(newPath)) return newPath;
	if (existsSync(legacyPath)) return legacyPath;
	return newPath;
}
