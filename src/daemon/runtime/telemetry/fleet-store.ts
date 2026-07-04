/**
 * The fleet telemetry SQLite store — PRD-071 (Contract B: `~/.honeycomb/telemetry/honeycomb.sqlite`).
 *
 * doctor's static registry (`fleet-registry.ts`) points at this file; doctor polls it
 * READ-ONLY per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. This module is
 * the ONE writer. It reuses the same built-in `node:sqlite` mechanism honeycomb's local job queue
 * already runs on (`services/local-job-queue.ts`) — no new dependency — and opens WAL mode (AC-9)
 * so doctor's read-only open never contends with honeycomb's own writes.
 *
 * ── Schema (pinned, AC-1..AC-10) ───────────────────────────────────────────────
 *   `service_status` / `service_metrics` — single-row (`id = 1`), latest-wins UPSERT, never
 *   appended (AC-071b.1.2). `service_logs` — append-only but rotated: after each insert, rows
 *   beyond {@link FLEET_LOG_MAX_ROWS} are deleted oldest-first (AC-8 / AC-071c.2).
 *
 * ── Fail-soft is the whole contract (AC-7) ─────────────────────────────────────
 * `node:sqlite` being unavailable, or a write/open failing, must NEVER throw into the daemon boot
 * or memory-pipeline path. {@link openFleetTelemetryStore} catches and returns the
 * {@link NULL_FLEET_TELEMETRY_STORE} no-op (logging the failure ONCE); every write method on the
 * real store is wrapped the same way (logged once, never per call).
 *
 * ── No secret, by construction (AC-10) ─────────────────────────────────────────
 * `service_status` and `service_metrics` hold only enum/numeric/timestamp columns — there is no
 * free-text field a secret could hide in. `service_logs.message` is free text and is redacted by
 * the caller (`redact.ts`) BEFORE it reaches {@link FleetTelemetryStore.appendLog}.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { type FleetRootOptions, honeycombStateDir, legacyHoneycombDir } from "../../../shared/fleet-root.js";
import { moveSqliteWithSiblings } from "../state-migration/move.js";
import { sqlIdent } from "../../storage/sql.js";

/** The telemetry subdirectory the database lives under (`~/.apiary/honeycomb/telemetry/`). */
export const FLEET_TELEMETRY_DIR_NAME = "telemetry" as const;
/** The SQLite database filename (Contract B: `~/.apiary/honeycomb/telemetry/honeycomb.sqlite`). */
export const FLEET_TELEMETRY_DB_FILE_NAME = "honeycomb.sqlite" as const;
/** honeycomb's identity in the `service_status` row and the doctor registry entry. */
export const FLEET_SERVICE_NAME = "honeycomb" as const;
/** The `service_logs` row cap (AC-8): oldest rows beyond this are rotated out on write. */
export const FLEET_LOG_MAX_ROWS = 5_000;

export const SERVICE_STATUS_TABLE = "service_status" as const;
export const SERVICE_METRICS_TABLE = "service_metrics" as const;
export const SERVICE_LOGS_TABLE = "service_logs" as const;

/** The closed verbosity set `service_logs.level` is constrained to (Contract B `CHECK`). */
export type FleetLogLevel = "error" | "warn" | "info" | "debug";
const FLEET_LOG_LEVELS: readonly FleetLogLevel[] = ["error", "warn", "info", "debug"];

/** True when `value` is one of the four admissible log levels. */
export function isFleetLogLevel(value: string): value is FleetLogLevel {
	return (FLEET_LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * The absolute path to the pinned Contract-B database under the resolved honeycomb state dir
 * (`~/.apiary/honeycomb/telemetry/honeycomb.sqlite`, PRD-072b). The fleet-root seams (home/env/
 * platform) are injectable so a test resolves a deterministic temp path.
 */
export function fleetTelemetryDbPath(options: FleetRootOptions = {}): string {
	return join(honeycombStateDir(options), FLEET_TELEMETRY_DIR_NAME, FLEET_TELEMETRY_DB_FILE_NAME);
}

/** The legacy Contract-B database path (`~/.honeycomb/telemetry/honeycomb.sqlite`) for the window. */
export function legacyFleetTelemetryDbPath(home?: string): string {
	return join(legacyHoneycombDir(home), FLEET_TELEMETRY_DIR_NAME, FLEET_TELEMETRY_DB_FILE_NAME);
}

/**
 * Resolve the database path the store should actually OPEN (PRD-072b legacy fallback, QA Critical
 * 2a). The trap this closes: if the migration mover failed (for example the legacy `.sqlite` was
 * still locked by a lingering old daemon), a naive open would mint a FRESH EMPTY database at the new
 * path, permanently defeating the retry (the destination then "exists") and stranding the install's
 * telemetry history. So before any open:
 *   1. the new path exists           → open it (the normal steady state);
 *   2. no legacy database remains    → open the new path (a genuinely fresh install mints here);
 *   3. an unmigrated legacy database exists → RETRY the move right now (no handle is held yet);
 *      on success open the new path, on failure open the LEGACY path (fallback read/write — never
 *      mint fresh over unmigrated history). The next boot's mover retries the move again.
 */
export function resolveTelemetryDbPathForOpen(options: FleetRootOptions = {}): string {
	const newPath = fleetTelemetryDbPath(options);
	if (existsSync(newPath)) return newPath;
	const legacyPath = legacyFleetTelemetryDbPath(options.home);
	if (!existsSync(legacyPath)) return newPath;
	// The move primitive reports an outcome and never throws; the guard is defense in depth so even
	// an unexpected filesystem error resolves to the documented legacy fallback, never a throw that
	// would degrade the whole store to the inert null fallback.
	try {
		return moveSqliteWithSiblings(legacyPath, newPath) === "migrated" ? newPath : legacyPath;
	} catch {
		return legacyPath;
	}
}

/** The `service_status` upsert input (AC-071a.2, AC-071a.3). */
export interface FleetServiceStatusInput {
	readonly name: string;
	readonly bindingTime: string;
	readonly lastSeen: string;
	readonly health: string;
	/** Whether the DeepLake storage client is currently reachable, when known. */
	readonly deeplakeConnected?: boolean;
	/** ISO timestamp of the last observed DeepLake reachability, when known. */
	readonly deeplakeLastComm?: string;
}

/** The `service_metrics` upsert input (AC-071b.1, AC-071b.3). */
export interface FleetServiceMetricsInput {
	readonly actionsTaken: number;
	readonly filesProcessed: number;
	readonly memoriesCreated: number;
	readonly updatedAt: string;
}

/** A read-back of the single `service_status` row, or `null` when absent. */
export interface FleetServiceStatusRow {
	readonly name: string;
	readonly bindingTime: string;
	readonly lastSeen: string;
	readonly health: string;
	readonly deeplakeConnected: boolean | null;
	readonly deeplakeLastComm: string | null;
}

/** A read-back of the single `service_metrics` row, or `null` when absent. */
export interface FleetServiceMetricsRow {
	readonly actionsTaken: number;
	readonly filesProcessed: number;
	readonly memoriesCreated: number;
	readonly updatedAt: string;
}

/** A read-back of one `service_logs` row (newest first from {@link FleetTelemetryStore.readRecentLogs}). */
export interface FleetServiceLogRow {
	readonly ts: string;
	readonly level: FleetLogLevel;
	readonly message: string;
}

/**
 * The narrow seam the check-in / metrics / log-tap modules write through. The driver hides behind
 * this so no other module imports `node:sqlite` directly, and a test injects an in-memory store.
 * EVERY write is fail-soft (AC-7) — a backing-store error never throws out.
 */
export interface FleetTelemetryStore {
	/** Whether this store actually persists (`false` for the {@link NULL_FLEET_TELEMETRY_STORE} no-op). */
	readonly persistent: boolean;
	/** Upsert the single `service_status` row (never an append). Fail-soft. */
	upsertStatus(input: FleetServiceStatusInput): void;
	/** Upsert the single `service_metrics` row (never an append). Fail-soft. */
	upsertMetrics(input: FleetServiceMetricsInput): void;
	/** Append one `service_logs` row, then rotate oldest rows beyond {@link FLEET_LOG_MAX_ROWS}. Fail-soft. */
	appendLog(level: FleetLogLevel, message: string): void;
	/** Read the current `service_status` row, or `null` when absent / on error. */
	readStatus(): FleetServiceStatusRow | null;
	/** Read the current `service_metrics` row, or `null` when absent / on error. */
	readMetrics(): FleetServiceMetricsRow | null;
	/** Read the most recent `service_logs` rows, newest first. */
	readRecentLogs(limit?: number): FleetServiceLogRow[];
	/** Close the backing handle (idempotent, never throws). */
	close(): void;
}

/**
 * The no-op store the daemon falls back to when persistence is unavailable (AC-7). Every write is
 * a silent no-op; every read reports empty/absent — never a throw.
 */
export const NULL_FLEET_TELEMETRY_STORE: FleetTelemetryStore = Object.freeze({
	persistent: false,
	upsertStatus(): void {},
	upsertMetrics(): void {},
	appendLog(): void {},
	readStatus(): FleetServiceStatusRow | null {
		return null;
	},
	readMetrics(): FleetServiceMetricsRow | null {
		return null;
	},
	readRecentLogs(): FleetServiceLogRow[] {
		return [];
	},
	close(): void {},
});

/** Construction options for {@link openFleetTelemetryStore}. */
export interface OpenFleetTelemetryStoreOptions {
	/** Override the home dir the telemetry db resolves under (tests). Maps to the fleet-root `home`. */
	readonly homeDir?: string;
	/** Override the env the fleet root resolves from (tests, for hermetic path resolution). */
	readonly env?: NodeJS.ProcessEnv;
	/** Override the platform the fleet root resolves from (tests). */
	readonly platform?: NodeJS.Platform;
	/** Open a fully in-memory database (`:memory:`) — used by unit tests that never touch disk. */
	readonly memory?: boolean;
	/** The `service_logs` row cap. Defaults to {@link FLEET_LOG_MAX_ROWS}. */
	readonly maxLogRows?: number;
	/** A one-time failure sink (surfaced ONCE, never per write). Defaults to a single stderr write. */
	readonly onceFailure?: (message: string) => void;
}

/** The minimal `node:sqlite` `DatabaseSync` surface this module uses (structural, no hard import). */
interface SqliteStatement {
	run(...params: unknown[]): { changes: number | bigint };
	all(...params: unknown[]): Array<Record<string, unknown>>;
	get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}
interface SqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

/**
 * Open (or create) the fleet telemetry store under the pinned Contract-B path, creating the three
 * tables + the log-timestamp index if absent (idempotent), and enabling WAL mode (AC-9). FAIL-SOFT
 * (AC-7): a `node:sqlite`-unavailable Node, or an open/migrate failure, logs the failure ONCE and
 * returns {@link NULL_FLEET_TELEMETRY_STORE} — it NEVER throws.
 */
export function openFleetTelemetryStore(options: OpenFleetTelemetryStoreOptions = {}): FleetTelemetryStore {
	const onceFailure = options.onceFailure ?? defaultOnceFailure();
	let db: SqliteDatabase | undefined;
	try {
		db = createDatabase(options);
		migrate(db);
	} catch (err: unknown) {
		// If createDatabase succeeded but migrate threw, close the handle so the fail-soft
		// fallback never leaks it (or leaves the file locked for a later retry/cleanup).
		try {
			db?.close();
		} catch {
			// The fail-soft fallback must stay non-throwing.
		}
		const reason = err instanceof Error ? err.message : String(err);
		onceFailure(`honeycomb: fleet telemetry store unavailable (non-fatal): ${reason}`);
		return NULL_FLEET_TELEMETRY_STORE;
	}
	return new SqliteFleetTelemetryStore(db, options.maxLogRows ?? FLEET_LOG_MAX_ROWS, onceFailure);
}

function defaultOnceFailure(): (message: string) => void {
	let fired = false;
	return (message: string): void => {
		if (fired) return;
		fired = true;
		process.stderr.write(`${message}\n`);
	};
}

function createDatabase(options: OpenFleetTelemetryStoreOptions): SqliteDatabase {
	const sqlite = loadSqlite();
	if (options.memory === true) return new sqlite.DatabaseSync(":memory:") as SqliteDatabase;
	// PRD-072b: never mint a fresh database while an unmigrated legacy one remains (see
	// resolveTelemetryDbPathForOpen) — retry the move here, else fall back to the legacy file.
	const dbPath = resolveTelemetryDbPathForOpen({
		...(options.homeDir !== undefined ? { home: options.homeDir } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.platform !== undefined ? { platform: options.platform } : {}),
	});
	const dir = join(dbPath, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	return new sqlite.DatabaseSync(dbPath) as SqliteDatabase;
}

function loadSqlite(): SqliteModule {
	const req = createRequire(import.meta.url);
	return req("node:sqlite") as SqliteModule;
}

/** Create the three Contract-B tables + index if absent, and enable WAL mode (AC-9). */
function migrate(db: SqliteDatabase): void {
	// WAL mode: doctor's read-only poll must never block on (or block) honeycomb's own writes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 2000");

	const statusTbl = sqlIdent(SERVICE_STATUS_TABLE);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${statusTbl} (` +
			`${sqlIdent("id")} INTEGER PRIMARY KEY CHECK (${sqlIdent("id")} = 1), ` +
			`${sqlIdent("name")} TEXT NOT NULL, ` +
			`${sqlIdent("binding_time")} TEXT NOT NULL, ` +
			`${sqlIdent("last_seen")} TEXT NOT NULL, ` +
			`${sqlIdent("health")} TEXT NOT NULL, ` +
			`${sqlIdent("deeplake_connected")} INTEGER, ` +
			`${sqlIdent("deeplake_last_comm")} TEXT)`,
	);

	const metricsTbl = sqlIdent(SERVICE_METRICS_TABLE);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${metricsTbl} (` +
			`${sqlIdent("id")} INTEGER PRIMARY KEY CHECK (${sqlIdent("id")} = 1), ` +
			`${sqlIdent("actions_taken")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("files_processed")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("memories_created")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("updated_at")} TEXT NOT NULL)`,
	);

	const logsTbl = sqlIdent(SERVICE_LOGS_TABLE);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${logsTbl} (` +
			`${sqlIdent("id")} INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`${sqlIdent("ts")} TEXT NOT NULL, ` +
			`${sqlIdent("level")} TEXT NOT NULL CHECK (${sqlIdent("level")} IN ('error', 'warn', 'info', 'debug')), ` +
			`${sqlIdent("message")} TEXT NOT NULL)`,
	);
	db.exec(`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_service_logs_ts")} ON ${logsTbl} (${sqlIdent("ts")} DESC)`);
}

/**
 * The real `node:sqlite`-backed store. Every write/read is wrapped so a backing-store error is
 * swallowed (logged ONCE) and degrades to a no-op / empty read — never a throw (AC-7).
 */
class SqliteFleetTelemetryStore implements FleetTelemetryStore {
	readonly persistent = true;
	private closed = false;

	constructor(
		private readonly db: SqliteDatabase,
		private readonly maxLogRows: number,
		private readonly onceFailure: (message: string) => void,
	) {}

	upsertStatus(input: FleetServiceStatusInput): void {
		if (this.closed) return;
		try {
			const tbl = sqlIdent(SERVICE_STATUS_TABLE);
			this.db
				.prepare(
					`INSERT INTO ${tbl} (` +
						`${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("binding_time")}, ${sqlIdent("last_seen")}, ` +
						`${sqlIdent("health")}, ${sqlIdent("deeplake_connected")}, ${sqlIdent("deeplake_last_comm")}) ` +
						`VALUES (1, ?, ?, ?, ?, ?, ?) ` +
						`ON CONFLICT(${sqlIdent("id")}) DO UPDATE SET ` +
						`${sqlIdent("name")} = excluded.${sqlIdent("name")}, ` +
						`${sqlIdent("binding_time")} = excluded.${sqlIdent("binding_time")}, ` +
						`${sqlIdent("last_seen")} = excluded.${sqlIdent("last_seen")}, ` +
						`${sqlIdent("health")} = excluded.${sqlIdent("health")}, ` +
						`${sqlIdent("deeplake_connected")} = excluded.${sqlIdent("deeplake_connected")}, ` +
						`${sqlIdent("deeplake_last_comm")} = excluded.${sqlIdent("deeplake_last_comm")}`,
				)
				.run(
					input.name,
					input.bindingTime,
					input.lastSeen,
					input.health,
					input.deeplakeConnected === undefined ? null : input.deeplakeConnected ? 1 : 0,
					input.deeplakeLastComm ?? null,
				);
		} catch (err: unknown) {
			this.failOnce("status upsert", err);
		}
	}

	upsertMetrics(input: FleetServiceMetricsInput): void {
		if (this.closed) return;
		try {
			const tbl = sqlIdent(SERVICE_METRICS_TABLE);
			this.db
				.prepare(
					`INSERT INTO ${tbl} (` +
						`${sqlIdent("id")}, ${sqlIdent("actions_taken")}, ${sqlIdent("files_processed")}, ` +
						`${sqlIdent("memories_created")}, ${sqlIdent("updated_at")}) ` +
						`VALUES (1, ?, ?, ?, ?) ` +
						`ON CONFLICT(${sqlIdent("id")}) DO UPDATE SET ` +
						`${sqlIdent("actions_taken")} = excluded.${sqlIdent("actions_taken")}, ` +
						`${sqlIdent("files_processed")} = excluded.${sqlIdent("files_processed")}, ` +
						`${sqlIdent("memories_created")} = excluded.${sqlIdent("memories_created")}, ` +
						`${sqlIdent("updated_at")} = excluded.${sqlIdent("updated_at")}`,
				)
				.run(input.actionsTaken, input.filesProcessed, input.memoriesCreated, input.updatedAt);
		} catch (err: unknown) {
			this.failOnce("metrics upsert", err);
		}
	}

	appendLog(level: FleetLogLevel, message: string): void {
		if (this.closed) return;
		try {
			const tbl = sqlIdent(SERVICE_LOGS_TABLE);
			this.db
				.prepare(
					`INSERT INTO ${tbl} (${sqlIdent("ts")}, ${sqlIdent("level")}, ${sqlIdent("message")}) VALUES (?, ?, ?)`,
				)
				.run(new Date().toISOString(), level, message);
			this.rotate();
		} catch (err: unknown) {
			this.failOnce("log append", err);
		}
	}

	readStatus(): FleetServiceStatusRow | null {
		if (this.closed) return null;
		try {
			const tbl = sqlIdent(SERVICE_STATUS_TABLE);
			const row = this.db.prepare(`SELECT * FROM ${tbl} WHERE ${sqlIdent("id")} = 1`).get();
			if (row === undefined) return null;
			return {
				name: String(row.name ?? ""),
				bindingTime: String(row.binding_time ?? ""),
				lastSeen: String(row.last_seen ?? ""),
				health: String(row.health ?? ""),
				deeplakeConnected:
					row.deeplake_connected === null || row.deeplake_connected === undefined
						? null
						: Number(row.deeplake_connected) === 1,
				deeplakeLastComm:
					row.deeplake_last_comm === null || row.deeplake_last_comm === undefined
						? null
						: String(row.deeplake_last_comm),
			};
		} catch (err: unknown) {
			this.failOnce("status read", err);
			return null;
		}
	}

	readMetrics(): FleetServiceMetricsRow | null {
		if (this.closed) return null;
		try {
			const tbl = sqlIdent(SERVICE_METRICS_TABLE);
			const row = this.db.prepare(`SELECT * FROM ${tbl} WHERE ${sqlIdent("id")} = 1`).get();
			if (row === undefined) return null;
			return {
				actionsTaken: Number(row.actions_taken ?? 0),
				filesProcessed: Number(row.files_processed ?? 0),
				memoriesCreated: Number(row.memories_created ?? 0),
				updatedAt: String(row.updated_at ?? ""),
			};
		} catch (err: unknown) {
			this.failOnce("metrics read", err);
			return null;
		}
	}

	readRecentLogs(limit = 100): FleetServiceLogRow[] {
		if (this.closed) return [];
		try {
			const tbl = sqlIdent(SERVICE_LOGS_TABLE);
			const idCol = sqlIdent("id");
			const rows = this.db.prepare(`SELECT * FROM ${tbl} ORDER BY ${idCol} DESC LIMIT ?`).all(limit);
			return rows.map((row) => ({
				ts: String(row.ts ?? ""),
				level: isFleetLogLevel(String(row.level ?? "")) ? (row.level as FleetLogLevel) : "info",
				message: String(row.message ?? ""),
			}));
		} catch (err: unknown) {
			this.failOnce("log read", err);
			return [];
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} catch {
			// Shutdown must never throw.
		}
	}

	/**
	 * Rotate `service_logs` back within {@link maxLogRows} (AC-8) — delete the oldest rows beyond the
	 * cap. `OFFSET maxLogRows` finds the id of the first row PAST the newest `maxLogRows`, in DESC
	 * order; deleting everything `<=` that id leaves exactly the newest `maxLogRows` rows.
	 */
	private rotate(): void {
		const tbl = sqlIdent(SERVICE_LOGS_TABLE);
		const idCol = sqlIdent("id");
		this.db
			.prepare(
				`DELETE FROM ${tbl} WHERE ${idCol} <= ` +
					`(SELECT ${idCol} FROM ${tbl} ORDER BY ${idCol} DESC LIMIT 1 OFFSET ?)`,
			)
			.run(this.maxLogRows);
	}

	private failOnce(op: string, err: unknown): void {
		const reason = err instanceof Error ? err.message : String(err);
		this.onceFailure(`honeycomb: fleet telemetry ${op} failed (non-fatal): ${reason}`);
	}
}
