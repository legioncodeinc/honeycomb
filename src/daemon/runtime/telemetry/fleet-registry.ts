/**
 * hivedoctor static registry writer — PRD-071 (Contract A: registry entry extension, ADR-0002
 * `service-registration-static-registry-plus-runtime-sqlite`).
 *
 * hivedoctor reads `~/.honeycomb/hivedoctor.daemons.json` (`{ "daemons": [...] }`) as the static
 * declaration of "who should exist" plus where each service's runtime telemetry SQLite lives.
 * Honeycomb writes NOTHING to this file today; this module is the honeycomb-side writer, called
 * from `src/commands/install.ts`'s install flow (AC-1 / AC-071a.1).
 *
 * ── Mirrors the-hive's reference writer exactly (read-tolerant, replace-by-name, atomic) ──────
 * The idempotent-upsert + atomic-write shape mirrors `the-hive/src/install/registry.ts`'s
 * `registerThehiveWithHivedoctor`: the file is read tolerantly (a missing file, or one that fails
 * to parse as `{ daemons: [...] }`, degrades to an empty daemon list rather than throwing), the
 * honeycomb entry is replaced by name (`findIndex`) rather than duplicated on a re-install
 * (AC-071a.1.2), and the write is atomic (temp file + rename) so a crash mid-write never leaves a
 * truncated registry that the next read would treat as empty.
 *
 * ── `pidPath` / `telemetryDbPath` stay literal `~`-prefixed strings ────────────────────────────
 * Per the pinned Contract-A shape, both `pidPath` and `telemetryDbPath` are written as literal
 * `~/...`-prefixed strings (never pre-expanded here) — the same convention the-hive's own
 * `pidPath` uses. hivedoctor expands `~` on its own read side; the REAL absolute path this
 * honeycomb process actually opens is resolved independently by `fleet-store.ts`
 * ({@link import("./fleet-store.js").fleetTelemetryDbPath}), which must always resolve to the same
 * on-disk file this string names.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DAEMON_HOST, DAEMON_PORT } from "../../../shared/constants.js";
import { FLEET_SERVICE_NAME } from "./fleet-store.js";

/** The static registry file hivedoctor reads (`~/.honeycomb/hivedoctor.daemons.json`). */
export function hivedoctorRegistryPath(homeDir: string = homedir()): string {
	return join(homeDir, ".honeycomb", "hivedoctor.daemons.json");
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
/** The literal (un-expanded) pid-file path convention, matching `src/cli/runtime.ts`'s `daemon.pid`. */
export const HONEYCOMB_REGISTRY_PID_PATH = "~/.honeycomb/daemon.pid" as const;
export const HONEYCOMB_REGISTRY_PROBE_INTERVAL_MS = 30_000 as const;
export const HONEYCOMB_REGISTRY_STARTUP_GRACE_MS = 60_000 as const;
export const HONEYCOMB_REGISTRY_RESTART_GIVE_UP_THRESHOLD = 3 as const;
export const HONEYCOMB_REGISTRY_RESTART_COOLDOWN_MS = 5_000 as const;
/** The literal (un-expanded) telemetry DB path convention (Contract B's file, Contract A's pointer). */
export const HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH = "~/.honeycomb/telemetry/honeycomb.sqlite" as const;

/** The injectable filesystem seam (mirrors the-hive's `RegistryFs`) — a test injects an in-memory fake. */
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
	/** Override the home dir the registry lives under (tests point this at a temp HOME). */
	readonly homeDir?: string;
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

/** One entry in the hivedoctor static registry (ADR-0002). Additional fields are tolerated (`Record`). */
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
export function buildHoneycombRegistryEntry(bind?: RegistryBind): RegistryDaemonEntry {
	return {
		name: HONEYCOMB_REGISTRY_NAME,
		healthUrl: honeycombRegistryHealthUrl(bind),
		pidPath: HONEYCOMB_REGISTRY_PID_PATH,
		probeIntervalMs: HONEYCOMB_REGISTRY_PROBE_INTERVAL_MS,
		startupGraceMs: HONEYCOMB_REGISTRY_STARTUP_GRACE_MS,
		restartGiveUpThreshold: HONEYCOMB_REGISTRY_RESTART_GIVE_UP_THRESHOLD,
		restartCooldownMs: HONEYCOMB_REGISTRY_RESTART_COOLDOWN_MS,
		telemetryDbPath: HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH,
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
 * write as-is (see the concurrency note on {@link registerHoneycombWithHivedoctor}).
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
 * Upsert honeycomb's entry into hivedoctor's static registry (AC-1 / AC-071a.1). Idempotent: a
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
export function registerHoneycombWithHivedoctor(options: RegistryUpsertOptions = {}): RegistryUpsertResult {
	const registryPath = options.registryPath ?? hivedoctorRegistryPath(options.homeDir ?? homedir());
	const fs = options.fs ?? createNodeRegistryFs();
	const honeycombEntry = buildHoneycombRegistryEntry(options.bind);

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
