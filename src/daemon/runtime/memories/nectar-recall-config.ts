/**
 * The operator-tunable `nectar_rrf_multiplier` (PRD-013a, decision #17 as amended).
 *
 * `ARM_CLASS_WEIGHT` (`recall.ts`) is a per-`RecallKind` constant shared by every distilled
 * arm — there is no per-`RecallSource` seam in it. This module supplies the per-SOURCE
 * multiplier that scales ONLY the `hive_graph_versions` fusion contribution, so an operator
 * who finds Nectar file-description hits crowding out session memory can dial them down
 * (or up) without retuning the shared class weight.
 *
 * Contract (decision #17 as amended):
 *   - Config surface: `~/.honeycomb/nectar.json`, key `recall.nectar_rrf_multiplier` (a number).
 *   - Read cadence: ONCE per daemon boot (with the other config reads). A change takes effect on
 *     the next daemon restart — mirroring the registry hot-add posture (decision #19). No file
 *     watch, no per-request read.
 *   - FAIL-SOFT: a missing file, malformed JSON, a missing/absent key, or a non-numeric value
 *     all resolve to {@link DEFAULT_NECTAR_RRF_MULTIPLIER} (`1.0`) — NEVER a throw on the recall
 *     hot path.
 *   - Clamp: the value is clamped to `[0, 10]`, so a negative or absurd value clamps rather than
 *     inverts or explodes the fusion.
 *   - Observability: the resolved multiplier is logged ONCE at boot when it differs from `1.0`
 *     ({@link resolveNectarRrfMultiplierAtBoot}), so a surprising recall mix is diagnosable from
 *     the boot log alone.
 *
 * These functions are pure (except the single guarded `readFileSync`) and dependency-free beyond
 * the Node runtime — no new runtime dependency (PRD-013 hard constraint).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { legacyHoneycombDir, preferExistingPath, resolveFleetRoot } from "../../../shared/fleet-root.js";

/** The equal-weighting default (decision #17): a file-description hit is as actionable as a session-trace hit. */
export const DEFAULT_NECTAR_RRF_MULTIPLIER = 1.0;
/** The lower clamp bound: a negative value clamps to `0` (never inverts the fusion). */
export const MIN_NECTAR_RRF_MULTIPLIER = 0;
/** The upper clamp bound: an absurd value clamps to `10` (never explodes the fusion). */
export const MAX_NECTAR_RRF_MULTIPLIER = 10;

/** The legacy config directory the multiplier was read from (`~/.honeycomb`). */
export const NECTAR_CONFIG_DIR_NAME = ".honeycomb";
/** The fleet-root product subdirectory nectar owns its config under (`~/.apiary/nectar`). */
export const NECTAR_PRODUCT_DIR_NAME = "nectar";
/** The config file the multiplier is read from (`nectar.json`). */
export const NECTAR_CONFIG_FILE_NAME = "nectar.json";

/**
 * The structured event name emitted ONCE at boot when the resolved multiplier is non-default.
 * A fixed, greppable identifier so a surprising recall mix is diagnosable from the boot log.
 */
export const NECTAR_RRF_MULTIPLIER_BOOT_EVENT = "recall.nectar_rrf_multiplier";

/**
 * Clamp an arbitrary value into a usable multiplier. FAIL-SOFT: a non-number or a non-finite
 * value (NaN/Infinity — a garbage/absent key) resolves to {@link DEFAULT_NECTAR_RRF_MULTIPLIER};
 * a finite number is clamped to `[0, 10]`. Pure, never throws.
 */
export function clampNectarRrfMultiplier(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_NECTAR_RRF_MULTIPLIER;
	return Math.min(MAX_NECTAR_RRF_MULTIPLIER, Math.max(MIN_NECTAR_RRF_MULTIPLIER, value));
}

/**
 * Where to read the config from. A test either pins a single `dir` (read only there), or drives the
 * new-first/legacy-second precedence via the injectable fleet-root seams (`home`/`env`/`platform`).
 */
export interface NectarConfigLocation {
	/** Pin a single config directory (tests). When set, ONLY this dir is read (no precedence). */
	readonly dir?: string;
	/** The home the fleet root + legacy dir anchor on (precedence path). Defaults to `os.homedir()`. */
	readonly home?: string;
	/** The env the fleet root resolves from (precedence path). Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform the fleet root resolves from (precedence path). Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
}

/**
 * Read + resolve `recall.nectar_rrf_multiplier` from `~/.honeycomb/nectar.json`, FAIL-SOFT to
 * {@link DEFAULT_NECTAR_RRF_MULTIPLIER}. Every failure mode — missing file, malformed JSON, a
 * non-object top level, an absent `recall` block, a missing/non-numeric key — resolves to the
 * default; a finite value is clamped to `[0, 10]`. NEVER throws (the recall config read must not
 * be able to crash the daemon boot).
 */
export function readNectarRrfMultiplier(loc: NectarConfigLocation = {}): number {
	// PRD-072b.4: nectar owns this file under the fleet root (`~/.apiary/nectar/nectar.json`) after its
	// parallel migration; read new-first, then the legacy `~/.honeycomb/nectar.json`. An injected dir
	// (tests) reads only that dir. Honeycomb does NOT move this file (nectar owns it).
	const rootOptions = {
		...(loc.env !== undefined ? { env: loc.env } : {}),
		...(loc.platform !== undefined ? { platform: loc.platform } : {}),
		...(loc.home !== undefined ? { home: loc.home } : {}),
	};
	const path =
		loc.dir !== undefined
			? join(loc.dir, NECTAR_CONFIG_FILE_NAME)
			: preferExistingPath(
					join(resolveFleetRoot(rootOptions), NECTAR_PRODUCT_DIR_NAME, NECTAR_CONFIG_FILE_NAME),
					join(legacyHoneycombDir(loc.home), NECTAR_CONFIG_FILE_NAME),
				);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return DEFAULT_NECTAR_RRF_MULTIPLIER; // missing/unreadable file → default.
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_NECTAR_RRF_MULTIPLIER; // malformed JSON → default.
	}
	if (parsed === null || typeof parsed !== "object") return DEFAULT_NECTAR_RRF_MULTIPLIER;
	const recall = (parsed as { recall?: unknown }).recall;
	if (recall === null || typeof recall !== "object") return DEFAULT_NECTAR_RRF_MULTIPLIER;
	return clampNectarRrfMultiplier((recall as { nectar_rrf_multiplier?: unknown }).nectar_rrf_multiplier);
}

/** The narrow boot-log surface — the `event` subset of {@link import("../logger.js").RequestLogger}. */
export interface NectarBootLogger {
	event(name: string, fields?: Readonly<Record<string, unknown>>): void;
}

/**
 * Resolve the multiplier ONCE at daemon boot and log it ONCE when it is non-default. Reads
 * `~/.honeycomb/nectar.json` via {@link readNectarRrfMultiplier} (fail-soft), and — only when the
 * resolved value differs from {@link DEFAULT_NECTAR_RRF_MULTIPLIER} and a logger is present —
 * emits one {@link NECTAR_RRF_MULTIPLIER_BOOT_EVENT}. Returns the resolved (clamped) value the
 * composition root threads into the recall mount. Never throws.
 */
export function resolveNectarRrfMultiplierAtBoot(logger?: NectarBootLogger, loc: NectarConfigLocation = {}): number {
	const multiplier = readNectarRrfMultiplier(loc);
	if (multiplier !== DEFAULT_NECTAR_RRF_MULTIPLIER && logger !== undefined) {
		logger.event(NECTAR_RRF_MULTIPLIER_BOOT_EVENT, { multiplier });
	}
	return multiplier;
}
