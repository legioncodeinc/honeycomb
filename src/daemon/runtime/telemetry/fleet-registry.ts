/**
 * doctor static registry writer — PRD-071 (Contract A: registry entry extension, ADR-0002
 * `service-registration-static-registry-plus-runtime-sqlite`).
 *
 * doctor reads `~/.honeycomb/doctor.daemons.json` (`{ "daemons": [...] }`) as the static
 * declaration of "who should exist" plus where each service's runtime telemetry SQLite lives.
 * Honeycomb writes NOTHING to this file today; this module is the honeycomb-side writer, called
 * from `src/commands/install.ts`'s install flow (AC-1 / AC-071a.1).
 *
 * ── Mirrors hive's reference writer exactly (read-tolerant, replace-by-name, atomic) ──────
 * The idempotent-upsert + atomic-write shape mirrors `hive/src/install/registry.ts`'s
 * `registerHiveWithDoctor`: the file is read tolerantly (a missing file, or one that fails
 * to parse as `{ daemons: [...] }`, degrades to an empty daemon list rather than throwing), the
 * honeycomb entry is replaced by name (`findIndex`) rather than duplicated on a re-install
 * (AC-071a.1.2), and the write is atomic (temp file + rename) so a crash mid-write never leaves a
 * truncated registry that the next read would treat as empty.
 *
 * ── `pidPath` / `telemetryDbPath` are RESOLVED ABSOLUTE paths (ADR-0003 Resolved decision 4) ────
 * Per the fleet ADR's Resolved decision 4 (2026-07-04), the entry carries the writer's own resolved
 * absolute `pidPath` / `telemetryDbPath` (from {@link honeycombRegistryPidPath} /
 * {@link honeycombRegistryTelemetryDbPath}), NEVER a `~`-literal: a `~`-literal is expanded by the
 * READER under the reader's home, which diverges from the writer's resolved root the moment
 * `APIARY_HOME` / XDG overrides apply. The advertised strings are the SAME paths `fleet-store.ts`
 * ({@link import("./fleet-store.js").fleetTelemetryDbPath}) and the runtime dir actually open/write,
 * so the advertised string and the on-disk file never disagree (AC-072c.2.1 coherence). Doctor still
 * expands legacy `~`-literals from old writers on its own read side during the window.
 *
 * ── Registry file location (ADR-0003 window contract) ──────────────────────────────────────────
 * The entry is written to `~/.apiary/registry.json` when the fleet ROOT directory exists, else to
 * the legacy `~/.honeycomb/doctor.daemons.json` ({@link resolveRegistryWritePath}); never both.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DAEMON_HOST, DAEMON_PORT } from "../../../shared/constants.js";
import {
	type FleetRootOptions,
	fleetRootFile,
	honeycombStateDir,
	legacyHoneycombDir,
	resolveFleetRoot,
} from "../../../shared/fleet-root.js";
import { FLEET_SERVICE_NAME, fleetTelemetryDbPath } from "./fleet-store.js";

/** The fleet-root registry file name doctor owns/reads (`~/.apiary/registry.json`). */
export const FLEET_REGISTRY_FILE_NAME = "registry.json" as const;
/** The legacy registry file name (`~/.honeycomb/doctor.daemons.json`) during the compatibility window. */
export const LEGACY_REGISTRY_FILE_NAME = "doctor.daemons.json" as const;
/** The daemon pid filename honeycomb advertises (matches the runtime dir's `daemon.pid`). */
const DAEMON_PID_FILE_NAME = "daemon.pid" as const;

/**
 * Resolve the registry path per the fleet ADR-0003 compatibility window contract (RESOLVED
 * 2026-07-04): write to `~/.apiary/registry.json` when the fleet ROOT directory exists, otherwise
 * to the legacy `~/.honeycomb/doctor.daemons.json`. Deterministic, no cross-product coordination,
 * NEVER both (doctor's reader merges new-wins-per-name; legacy-only entries merge additively).
 */
export function doctorRegistryPath(homeDir: string = homedir()): string {
	return resolveRegistryWritePath({ home: homeDir });
}

/** The fleet-root registry path (`~/.apiary/registry.json`). */
export function fleetRegistryPath(options: FleetRootOptions = {}): string {
	return fleetRootFile(FLEET_REGISTRY_FILE_NAME, options);
}

/** The legacy registry path (`~/.honeycomb/doctor.daemons.json`). */
export function legacyRegistryPath(home: string = homedir()): string {
	return join(legacyHoneycombDir(home), LEGACY_REGISTRY_FILE_NAME);
}

/**
 * The registry write target for THIS moment in the window: the fleet-root `registry.json` when the
 * fleet root directory exists, else the legacy file. Never dual-writes.
 */
export function resolveRegistryWritePath(options: FleetRootOptions = {}): string {
	return existsSync(resolveFleetRoot(options)) ? fleetRegistryPath(options) : legacyRegistryPath(options.home);
}

/** honeycomb's registry identity — reused from the fleet store so the two never drift. */
export const HONEYCOMB_REGISTRY_NAME = FLEET_SERVICE_NAME;

/**
 * The resolved daemon bind a caller can thread in (host/port from the daemon's resolved runtime
 * config) so the advertised `/health` URL matches where the daemon ACTUALLY listens, not just the
 * shared defaults. When absent, the default `DAEMON_HOST:DAEMON_PORT` constants apply.
 */
export interface RegistryBind {
	readonly host: string;
	readonly port: number;
}

/** Build honeycomb's `/health` URL from a resolved bind, defaulting to the shared constants. */
export function honeycombRegistryHealthUrl(bind?: RegistryBind): string {
	return `http://${bind?.host ?? DAEMON_HOST}:${bind?.port ?? DAEMON_PORT}/health`;
}

/** honeycomb's DEFAULT `/health` endpoint, built from the SAME shared constants the daemon binds (no drift). */
export const HONEYCOMB_REGISTRY_HEALTH_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/health` as const;
export const HONEYCOMB_REGISTRY_PROBE_INTERVAL_MS = 30_000 as const;
export const HONEYCOMB_REGISTRY_STARTUP_GRACE_MS = 60_000 as const;
export const HONEYCOMB_REGISTRY_RESTART_GIVE_UP_THRESHOLD = 3 as const;
export const HONEYCOMB_REGISTRY_RESTART_COOLDOWN_MS = 5_000 as const;

/**
 * The RESOLVED ABSOLUTE pid path honeycomb advertises (fleet ADR Resolved decision 4, 2026-07-04):
 * `<resolveFleetRoot>/honeycomb/daemon.pid`, NEVER a `~`-literal. A `~`-literal is expanded by the
 * READER under the reader's home, which diverges from the writer's resolved root the moment
 * `APIARY_HOME` / XDG overrides apply; an absolute path derived from the writer's own resolver stays
 * true. It is the SAME path the runtime dir writes (AC-072c.2.1 coherence).
 */
export function honeycombRegistryPidPath(options: FleetRootOptions = {}): string {
	return join(honeycombStateDir(options), DAEMON_PID_FILE_NAME);
}

/** The RESOLVED ABSOLUTE telemetry DB path honeycomb advertises (SAME file `fleet-store.ts` opens). */
export function honeycombRegistryTelemetryDbPath(options: FleetRootOptions = {}): string {
	return fleetTelemetryDbPath(options);
}

/** The injectable filesystem seam (mirrors hive's `RegistryFs`) — a test injects an in-memory fake. */
export interface RegistryFs {
	readFile(path: string): string;
	mkdirp(path: string): void;
	writeFile(path: string, content: string): void;
	rename(from: string, to: string): void;
	removeFile(path: string): void;
}

export interface RegistryUpsertOptions {
	/** Override the full registry file path. Wins over `homeDir` when both are given. */
	readonly registryPath?: string;
	/** Override the home dir the registry + advertised paths resolve under (tests point at a temp HOME). */
	readonly homeDir?: string;
	/** Override the env the fleet root resolves from (tests, for hermetic path resolution). */
	readonly env?: NodeJS.ProcessEnv;
	/** Override the platform the fleet root resolves from (tests). */
	readonly platform?: NodeJS.Platform;
	readonly fs?: RegistryFs;
	/**
	 * The resolved daemon bind (host/port) the entry's `healthUrl` should advertise. Callers that
	 * know the resolved runtime config thread it here; omitted, the shared defaults apply.
	 */
	readonly bind?: RegistryBind;
}

export interface RegistryUpsertResult {
	readonly registryPath: string;
	readonly updatedExistingEntry: boolean;
}

/** One entry in the doctor static registry (ADR-0002). Additional fields are tolerated (`Record`). */
export type RegistryDaemonEntry = Record<string, unknown> & {
	readonly name: string;
	readonly healthUrl: string;
	readonly pidPath: string;
	readonly probeIntervalMs: number;
	readonly startupGraceMs: number;
	readonly restartGiveUpThreshold: number;
	readonly restartCooldownMs: number;
	readonly telemetryDbPath: string;
};

interface ParsedRegistryDocument {
	readonly root: Record<string, unknown>;
	readonly daemons: Array<Record<string, unknown>>;
}

export function createNodeRegistryFs(): RegistryFs {
	return {
		readFile(path: string): string {
			return readFileSync(path, "utf8");
		},
		mkdirp(path: string): void {
			mkdirSync(path, { recursive: true });
		},
		writeFile(path: string, content: string): void {
			writeFileSync(path, content, "utf8");
		},
		rename(from: string, to: string): void {
			renameSync(from, to);
		},
		removeFile(path: string): void {
			rmSync(path, { force: true });
		},
	};
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	return null;
}

function parseRegistryDocument(raw: string): ParsedRegistryDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { root: {}, daemons: [] };
	}

	const root = asObject(parsed);
	if (root === null) return { root: {}, daemons: [] };

	const rawDaemons = root.daemons;
	const daemons = Array.isArray(rawDaemons)
		? rawDaemons.map((entry) => asObject(entry)).filter((entry): entry is Record<string, unknown> => entry !== null)
		: [];

	return { root, daemons };
}

/**
 * Build honeycomb's registry entry from the pinned Contract-A constants (AC-1). A resolved `bind`
 * makes the advertised `healthUrl` follow a non-default daemon bind; absent, the defaults apply.
 */
export function buildHoneycombRegistryEntry(
	bind?: RegistryBind,
	pathOptions: FleetRootOptions = {},
): RegistryDaemonEntry {
	return {
		name: HONEYCOMB_REGISTRY_NAME,
		healthUrl: honeycombRegistryHealthUrl(bind),
		pidPath: honeycombRegistryPidPath(pathOptions),
		probeIntervalMs: HONEYCOMB_REGISTRY_PROBE_INTERVAL_MS,
		startupGraceMs: HONEYCOMB_REGISTRY_STARTUP_GRACE_MS,
		restartGiveUpThreshold: HONEYCOMB_REGISTRY_RESTART_GIVE_UP_THRESHOLD,
		restartCooldownMs: HONEYCOMB_REGISTRY_RESTART_COOLDOWN_MS,
		telemetryDbPath: honeycombRegistryTelemetryDbPath(pathOptions),
	};
}

function readRegistryDocument(path: string, fs: RegistryFs): ParsedRegistryDocument {
	try {
		return parseRegistryDocument(fs.readFile(path));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { root: {}, daemons: [] };
		throw error;
	}
}

function nextTempPath(registryPath: string): string {
	return `${registryPath}.tmp-${process.pid}-${Date.now()}`;
}

/**
 * How many read-merge-write-verify rounds the upsert attempts before accepting the last atomic
 * write as-is (see the concurrency note on {@link registerHoneycombWithDoctor}).
 */
const REGISTRY_UPSERT_MAX_ATTEMPTS = 5;

/** True when `entry` still carries every field/value of honeycomb's own entry (survived a race). */
function entryMatches(entry: Record<string, unknown>, wanted: RegistryDaemonEntry): boolean {
	for (const [key, value] of Object.entries(wanted)) {
		if (entry[key] !== value) return false;
	}
	return true;
}

/** One atomic read-merge-write round. Returns whether an existing honeycomb entry was replaced. */
function writeMergedRegistry(
	registryPath: string,
	fs: RegistryFs,
	honeycombEntry: RegistryDaemonEntry,
): { updatedExistingEntry: boolean } {
	const parsed = readRegistryDocument(registryPath, fs);
	const nextDaemons = [...parsed.daemons];
	const index = nextDaemons.findIndex((entry) => entry.name === HONEYCOMB_REGISTRY_NAME);
	if (index >= 0) {
		nextDaemons[index] = { ...nextDaemons[index], ...honeycombEntry };
	} else {
		nextDaemons.push(honeycombEntry);
	}

	const nextRoot: Record<string, unknown> = { ...parsed.root, daemons: nextDaemons };
	const serialized = `${JSON.stringify(nextRoot, null, 2)}\n`;
	const tempPath = nextTempPath(registryPath);

	fs.mkdirp(dirname(registryPath));
	fs.writeFile(tempPath, serialized);
	try {
		fs.rename(tempPath, registryPath);
	} catch (error) {
		fs.removeFile(tempPath);
		throw error;
	}
	return { updatedExistingEntry: index >= 0 };
}

/**
 * Upsert honeycomb's entry into doctor's static registry (AC-1 / AC-071a.1). Idempotent: a
 * re-install REPLACES the existing `name === "honeycomb"` entry in place (never duplicates it,
 * AC-071a.1.2) while every other daemon's entry is preserved untouched. The write is atomic
 * (temp file + rename), and a missing / malformed pre-existing file degrades to an empty daemon
 * list rather than throwing (fail-tolerant read). Callers (install.ts) wrap this fail-soft — a
 * registry write failure must never abort the install (071a technical considerations).
 *
 * ── Concurrency: an optimistic re-read-and-verify loop, not a lock ────────────────────────────
 * The temp-file rename makes each WRITE atomic, but two installers running at once can both read
 * the same old document and the later rename would silently drop the other daemon's entry
 * (last-writer-wins). Each round therefore RE-READS the file after its own rename and verifies
 * honeycomb's entry survived; when a concurrent writer's rename landed in between and dropped it,
 * the loop re-merges into THAT writer's document and writes again (dependency-free, no lockfile).
 * Because every product's writer only replaces its OWN entry by name and preserves the rest, the
 * loop converges. After {@link REGISTRY_UPSERT_MAX_ATTEMPTS} rounds the last atomic write is
 * accepted as-is rather than failing: this runs on the install path, where a residual
 * last-writer-wins under pathological contention is preferable to failing the install (071a
 * technical considerations: fail-soft).
 */
export function registerHoneycombWithDoctor(options: RegistryUpsertOptions = {}): RegistryUpsertResult {
	const pathOptions: FleetRootOptions = {
		...(options.homeDir !== undefined ? { home: options.homeDir } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.platform !== undefined ? { platform: options.platform } : {}),
	};
	// Window contract: write to `~/.apiary/registry.json` when the fleet root exists, else the legacy
	// file (never both). The advertised pid/telemetry paths are the RESOLVED ABSOLUTE paths from the
	// SAME resolvers the daemon writes through (ADR Resolved decision 4), so what doctor reads and
	// what honeycomb writes never disagree.
	const registryPath = options.registryPath ?? resolveRegistryWritePath(pathOptions);
	const fs = options.fs ?? createNodeRegistryFs();
	const honeycombEntry = buildHoneycombRegistryEntry(options.bind, pathOptions);

	let updatedExistingEntry = false;
	for (let attempt = 0; attempt < REGISTRY_UPSERT_MAX_ATTEMPTS; attempt++) {
		const round = writeMergedRegistry(registryPath, fs, honeycombEntry);
		// The FIRST round's read reflects the pre-upsert state; that is the honest answer to
		// "did an entry already exist" regardless of how many verify rounds follow.
		if (attempt === 0) updatedExistingEntry = round.updatedExistingEntry;

		const after = readRegistryDocument(registryPath, fs);
		const mine = after.daemons.find((entry) => entry.name === HONEYCOMB_REGISTRY_NAME);
		if (mine !== undefined && entryMatches(mine, honeycombEntry)) break;
	}

	return {
		registryPath,
		updatedExistingEntry,
	};
}

/** The outcome of {@link unregisterHoneycombFromDoctor} — whether an entry was removed + where. */
export interface RegistryDeleteResult {
	/** True iff a `name === "honeycomb"` entry existed and was removed from at least one file. */
	readonly removed: boolean;
	/** The registry file(s) actually rewritten to drop the entry. */
	readonly registryPaths: readonly string[];
}

/**
 * Delete honeycomb's entry from doctor's static registry (PRD-003b b-AC-3) — the delete counterpart
 * to {@link registerHoneycombWithDoctor}. Removes the `name === "honeycomb"` entry by name from
 * WHICHEVER registry file(s) carry it: both the fleet-root `~/.apiary/registry.json` AND the legacy
 * `~/.honeycomb/doctor.daemons.json` are checked, since the compat window can leave the entry in
 * either. Every OTHER daemon's entry and every unknown top-level key is preserved verbatim; the write
 * is atomic (temp file + rename). A missing / malformed / entry-less file is a friendly no-op (never a
 * throw, never a created file). Callers (the uninstall verb) run this best-effort.
 */
export function unregisterHoneycombFromDoctor(options: RegistryUpsertOptions = {}): RegistryDeleteResult {
	const pathOptions: FleetRootOptions = {
		...(options.homeDir !== undefined ? { home: options.homeDir } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.platform !== undefined ? { platform: options.platform } : {}),
	};
	const fs = options.fs ?? createNodeRegistryFs();
	// An explicit `registryPath` targets exactly that file; otherwise check BOTH window locations.
	const candidatePaths =
		options.registryPath !== undefined
			? [options.registryPath]
			: [fleetRegistryPath(pathOptions), legacyRegistryPath(pathOptions.home)];

	let removed = false;
	const registryPaths: string[] = [];
	for (const path of candidatePaths) {
		const parsed = readRegistryDocument(path, fs);
		const index = parsed.daemons.findIndex((entry) => entry.name === HONEYCOMB_REGISTRY_NAME);
		if (index < 0) continue;
		const nextDaemons = parsed.daemons.filter((entry) => entry.name !== HONEYCOMB_REGISTRY_NAME);
		const nextRoot: Record<string, unknown> = { ...parsed.root, daemons: nextDaemons };
		const serialized = `${JSON.stringify(nextRoot, null, 2)}\n`;
		const tempPath = nextTempPath(path);
		fs.mkdirp(dirname(path));
		fs.writeFile(tempPath, serialized);
		try {
			fs.rename(tempPath, path);
		} catch (error) {
			fs.removeFile(tempPath);
			throw error;
		}
		removed = true;
		registryPaths.push(path);
	}
	return { removed, registryPaths };
}
