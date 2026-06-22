/**
 * The durable SQLite log store — PRD-043a (FR-1/FR-5/FR-6/FR-7, AC-1/AC-5/AC-6).
 *
 * The daemon's only log surface today is the in-memory ring buffer inside `RequestLogger`
 * (`logger.ts`): capped at 500 records and lost on every restart. This module is the ONE new
 * capability the Logs page lacks — PERSISTENCE — behind a narrow {@link LogStore} seam so the
 * driver (`node:sqlite`) never leaks into the logger or the `/api/logs` API, and a test can
 * inject a temp-dir / in-memory store.
 *
 * ── Driver: the built-in `node:sqlite` (DECISION, OQ-1) ───────────────────────
 *   We use the Node-bundled `node:sqlite` (`DatabaseSync`) — ZERO new dependency, no native
 *   build / ABI risk, no `ensure-tree-sitter`-style postinstall to heal across the Node matrix.
 *   It requires `--experimental-sqlite` on Node 22.x (the engines floor; landed in 22.5.0) and is
 *   flag-free on 24/25 where the flag is accepted as a harmless no-op. The flag is threaded into
 *   the daemon spawn (`src/cli/runtime.ts`) and the vitest worker `execArgv` (`vitest.config.ts`)
 *   so persistence is green on the 22.x AND 24.x CI legs + the Windows smoke (all 22.x).
 *
 * ── Fail-soft is the whole contract (FR-2 / AC-4) ─────────────────────────────
 *   `node:sqlite` being genuinely unavailable (an older Node WITHOUT the flag) or a write/open
 *   failing must NEVER throw into the request path. {@link openLogStore} catches and returns a
 *   {@link NULL_LOG_STORE} no-op (logging the failure ONCE), and every write is wrapped so a
 *   per-row failure degrades to the in-memory-only behaviour (logged once, never per request).
 *
 * ── Secret-free on disk (FR-7 / AC-6) ─────────────────────────────────────────
 *   The two tables are a 1:1 map of {@link RequestLogRecord} / {@link EventLogRecord}. NO column
 *   captures a header, bearer token, or request body — the table shape CANNOT hold a secret
 *   because no such field is ever passed in. Identifiers route through `sqlIdent` (the PRD-002b
 *   floor) and every VALUE is bound via a `node:sqlite` `?` parameter (never interpolated), so
 *   `audit:sql` stays green.
 *
 * ── Bounded store (FR-6 / AC-5) ───────────────────────────────────────────────
 *   Retention is bounded by a row cap (default 100k) AND an age cap (default 30 days), whichever
 *   hits first. Pruning is opportunistic on write (amortized — only every Nth append) plus a
 *   startup sweep, so the file can never grow without limit and the hot path stays cheap.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

import { sqlIdent } from "../../storage/sql.js";
import type { EventLogRecord, RequestLogRecord } from "../logger.js";

/** The daemon-local directory the store file lives under (mirrors the secrets `.daemon/` pattern). */
export const DAEMON_DIR_NAME = ".daemon" as const;
/** The SQLite database filename within {@link DAEMON_DIR_NAME}. ONE file, two tables (OQ-5). */
export const LOG_DB_FILE_NAME = "logs.db" as const;

/** The `request_log` table name — one row per {@link RequestLogRecord}. */
export const REQUEST_LOG_TABLE = "request_log" as const;
/** The `event_log` table name — one row per {@link EventLogRecord} (persisted; its UI deferred, OQ-4). */
export const EVENT_LOG_TABLE = "event_log" as const;

/** The default row cap before the oldest rows are pruned (OQ-2). */
export const DEFAULT_MAX_ROWS = 100_000;
/** The default age cap in days before older rows are pruned (OQ-2). */
export const DEFAULT_MAX_AGE_DAYS = 30;
/** Amortize the opportunistic on-write prune: only sweep every Nth append (OQ-3, no hot-path cost). */
export const PRUNE_EVERY_N_WRITES = 256;

/** The hard ceiling on a `/api/logs/history` page (mirrors `MAX_LOGS_LIMIT` in `api.ts`). */
export const MAX_HISTORY_LIMIT = 1000;
/** The default page size when no `?limit=` is given. */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * A stable, opaque pagination cursor (FR-5). Encodes the last-seen row's `id`; the next page asks
 * for rows with a SMALLER id (newest-first → older window), so paging never duplicates or gaps.
 */
export interface HistoryCursor {
	/** The rowid to page strictly BEFORE (exclusive). */
	readonly beforeId: number;
}

/** A validated, parsed `/api/logs/history` query (the fixed filter set — FR-4). */
export interface HistoryQuery {
	/** Lower time bound (inclusive), ISO-8601, or undefined. */
	readonly since?: string;
	/** Upper time bound (inclusive), ISO-8601, or undefined. */
	readonly until?: string;
	/** Exact status (e.g. `404`) or a status class (`2xx`/`4xx`/`5xx`), or undefined. */
	readonly status?: { readonly kind: "exact"; readonly code: number } | { readonly kind: "class"; readonly hundreds: number };
	/** Path filter — exact or prefix match, or undefined. */
	readonly path?: string;
	/** Org filter (exact), or undefined. */
	readonly org?: string;
	/** Clamped page size in `[1, MAX_HISTORY_LIMIT]`. */
	readonly limit: number;
	/** The pagination cursor (page strictly before this id), or undefined for the newest page. */
	readonly cursor?: HistoryCursor;
}

/** A page of `request_log` rows (newest first) plus the cursor for the next older page. */
export interface HistoryPage {
	/** The `RequestLogRecord`s for this page, newest first. */
	readonly records: readonly RequestLogRecord[];
	/** The cursor to fetch the next (older) page, or `null` when this is the last page. */
	readonly nextCursor: string | null;
}

/**
 * The narrow durable-store seam the logger + the history API depend on. The driver hides behind
 * this so neither the logger nor the API ever imports `node:sqlite`, and a test injects a temp-dir
 * or fully in-memory store. EVERY method is fail-soft — a backing-store error never throws out.
 */
export interface LogStore {
	/** Append one request record (FR-2). Fail-soft: a write error is swallowed (logged once). */
	appendRequest(record: RequestLogRecord): void;
	/** Append one event record (FR-2). Fail-soft. */
	appendEvent(record: EventLogRecord): void;
	/** Query a page of persisted request records (FR-3/FR-4/FR-5), newest first. */
	queryRequests(query: HistoryQuery): HistoryPage;
	/** Whether this store actually persists (false for the {@link NULL_LOG_STORE} no-op). */
	readonly persistent: boolean;
	/** Close the backing handle (idempotent, never throws). */
	close(): void;
}

/**
 * The no-op store the logger falls back to when persistence is unavailable (AC-4). It keeps the
 * daemon on the in-memory ring buffer + stderr behaviour with ZERO writes and an always-empty
 * history page — never a throw. `persistent:false` lets a caller report "history unavailable".
 */
export const NULL_LOG_STORE: LogStore = Object.freeze({
	persistent: false,
	appendRequest(): void {},
	appendEvent(): void {},
	queryRequests(): HistoryPage {
		return { records: [], nextCursor: null };
	},
	close(): void {},
});

/** Retention bounds for the store (FR-6). Both caps apply; whichever is hit first prunes. */
export interface RetentionConfig {
	/** Maximum rows retained per table before the oldest are pruned. Default {@link DEFAULT_MAX_ROWS}. */
	readonly maxRows?: number;
	/** Maximum age in days before older rows are pruned. Default {@link DEFAULT_MAX_AGE_DAYS}. */
	readonly maxAgeDays?: number;
}

/** An injectable clock so retention's age cutoff is deterministic in tests. */
export interface LogStoreClock {
	/** The current epoch milliseconds. */
	now(): number;
}

/** The default wall-clock implementation. */
export const systemLogStoreClock: LogStoreClock = { now: () => Date.now() };

/** Construction options for {@link openLogStore}. */
export interface OpenLogStoreOptions {
	/**
	 * The base directory the `.daemon/logs.db` file lives under (`$HONEYCOMB_WORKSPACE`). A test
	 * passes a temp dir so the real workspace is never touched. MUTUALLY EXCLUSIVE with `memory`.
	 */
	readonly baseDir?: string;
	/** Open a fully in-memory database (`:memory:`) — used by unit tests that never touch disk. */
	readonly memory?: boolean;
	/** Retention bounds. Defaults to the row + age caps above. */
	readonly retention?: RetentionConfig;
	/** The clock for the retention age cutoff. Defaults to the wall clock. */
	readonly clock?: LogStoreClock;
	/**
	 * A one-time failure sink (FR-2 — surface the open failure ONCE, never per request). Defaults to
	 * a single stderr write. A test injects a recorder to assert it fired exactly once.
	 */
	readonly onceFailure?: (message: string) => void;
}

/**
 * The minimal `node:sqlite` `DatabaseSync` surface this module uses. Declared structurally so the
 * module type-checks WITHOUT a hard top-level `import("node:sqlite")` (the import is dynamic +
 * guarded so an older Node without the flag degrades to {@link NULL_LOG_STORE} rather than crashing).
 */
interface SqliteStatement {
	run(...params: unknown[]): { changes: number | bigint };
	all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/**
 * Open (or create) the durable log store under `baseDir/.daemon/logs.db` (FR-1), creating the two
 * append-only tables + indexes if absent (idempotent). FAIL-SOFT (AC-4): if `node:sqlite` is
 * unavailable (an older Node without `--experimental-sqlite`) or the open/migrate fails, this logs
 * the failure ONCE and returns {@link NULL_LOG_STORE} so the daemon keeps the in-memory behaviour
 * — it NEVER throws. The actual `node:sqlite` import is dynamic + guarded for the same reason.
 */
export function openLogStore(options: OpenLogStoreOptions = {}): LogStore {
	const onceFailure = options.onceFailure ?? defaultOnceFailure();
	let db: SqliteDatabase;
	try {
		db = createDatabase(options);
		migrate(db);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		// Surfaced ONCE (FR-2 / AC-4): persistence is unavailable; the daemon stays on the ring buffer.
		onceFailure(`honeycomb: log persistence unavailable (non-fatal), staying in-memory: ${reason}`);
		return NULL_LOG_STORE;
	}
	return new SqliteLogStore(db, options.retention ?? {}, options.clock ?? systemLogStoreClock, onceFailure);
}

/** A stderr-once failure sink: writes the first failure only, then goes quiet (no per-request spam). */
function defaultOnceFailure(): (message: string) => void {
	let fired = false;
	return (message: string): void => {
		if (fired) return;
		fired = true;
		process.stderr.write(`${message}\n`);
	};
}

/**
 * Construct the `node:sqlite` `DatabaseSync` handle. The import is DYNAMIC (`require("node:sqlite")`
 * via `createRequire`) so an older Node without the module / flag throws HERE and is caught by
 * {@link openLogStore}'s fail-soft guard, never at module load. A disk store ensures `.daemon/`
 * exists first (mirrors the secrets store's `.daemon/` discipline).
 */
function createDatabase(options: OpenLogStoreOptions): SqliteDatabase {
	// Dynamic require keeps `node:sqlite` off the module's top-level imports, so a Node that lacks
	// it fails softly inside the guarded open path rather than crashing the whole daemon bundle.
	const sqlite = loadSqlite();
	if (options.memory === true) {
		return new sqlite.DatabaseSync(":memory:") as SqliteDatabase;
	}
	const baseDir = options.baseDir ?? process.cwd();
	const dir = join(baseDir, DAEMON_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	return new sqlite.DatabaseSync(join(dir, LOG_DB_FILE_NAME)) as SqliteDatabase;
}

/** The `node:sqlite` module shape this code uses. */
interface SqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

/**
 * Load `node:sqlite` via a dynamic `require` so it is NOT a top-level import (keeps a flag-less /
 * older Node from crashing the bundle at load — the open path catches the throw). Uses
 * `module.createRequire` so it works under ESM (`import.meta.url`).
 */
function loadSqlite(): SqliteModule {
	const req = createRequire(import.meta.url);
	return req("node:sqlite") as SqliteModule;
}

/**
 * Create the two append-only tables + the filter-backing indexes if absent (idempotent / additive,
 * FR-1). Identifiers route through `sqlIdent` (the PRD-002b floor); there is NO interpolated VALUE
 * in any DDL — only validated identifiers — so `audit:sql` stays green. The column set is a 1:1
 * map of the record types: NO header/token/body column exists (FR-7 / AC-6).
 */
function migrate(db: SqliteDatabase): void {
	const reqTbl = sqlIdent(REQUEST_LOG_TABLE);
	const evtTbl = sqlIdent(EVENT_LOG_TABLE);
	// `request_log` — 1:1 with RequestLogRecord (id is the autoincrement rowid + pagination cursor).
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${reqTbl} (` +
			`${sqlIdent("id")} INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`${sqlIdent("time")} TEXT NOT NULL, ` +
			`${sqlIdent("method")} TEXT NOT NULL, ` +
			`${sqlIdent("path")} TEXT NOT NULL, ` +
			`${sqlIdent("status")} INTEGER NOT NULL, ` +
			`${sqlIdent("duration_ms")} REAL NOT NULL, ` +
			`${sqlIdent("mode")} TEXT NOT NULL, ` +
			`${sqlIdent("org")} TEXT, ` +
			`${sqlIdent("workspace")} TEXT)`,
	);
	db.exec(`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_request_log_time")} ON ${reqTbl} (${sqlIdent("time")})`);
	db.exec(`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_request_log_status")} ON ${reqTbl} (${sqlIdent("status")})`);
	db.exec(`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_request_log_path")} ON ${reqTbl} (${sqlIdent("path")})`);
	// `event_log` — 1:1 with EventLogRecord. `fields` is the caller-scrubbed coarse JSON bag (D-5);
	// it is serialized JSON of subsystem state only, NEVER a secret (the caller scrubs it).
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${evtTbl} (` +
			`${sqlIdent("id")} INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`${sqlIdent("time")} TEXT NOT NULL, ` +
			`${sqlIdent("event")} TEXT NOT NULL, ` +
			`${sqlIdent("fields")} TEXT NOT NULL)`,
	);
	db.exec(`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_event_log_time")} ON ${evtTbl} (${sqlIdent("time")})`);
}

/** Map a status filter to a half-open `[lo, hi)` integer range for a class, or an exact pair. */
function statusRange(status: HistoryQuery["status"]): { readonly lo: number; readonly hi: number } | null {
	if (status === undefined) return null;
	if (status.kind === "exact") return { lo: status.code, hi: status.code + 1 };
	const lo = status.hundreds * 100;
	return { lo, hi: lo + 100 };
}

/**
 * The real `node:sqlite`-backed store. Holds the prepared statements; every write/read is wrapped
 * so a backing-store error is swallowed (logged ONCE) and degrades to in-memory-only / an empty
 * page — never a throw into the request path (FR-2 / AC-4).
 */
class SqliteLogStore implements LogStore {
	readonly persistent = true;
	private readonly maxRows: number;
	private readonly maxAgeMs: number;
	private writesSincePrune = 0;
	private closed = false;

	constructor(
		private readonly db: SqliteDatabase,
		retention: RetentionConfig,
		private readonly clock: LogStoreClock,
		private readonly onceFailure: (message: string) => void,
	) {
		this.maxRows = retention.maxRows ?? DEFAULT_MAX_ROWS;
		const maxAgeDays = retention.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
		this.maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
		// Startup sweep (FR-6 / OQ-3): prune any rows already past the bound on open.
		this.prune();
	}

	appendRequest(record: RequestLogRecord): void {
		if (this.closed) return;
		try {
			const tbl = sqlIdent(REQUEST_LOG_TABLE);
			// Every VALUE is bound via a `?` parameter (never interpolated) — the secret-free record
			// fields only; identifiers via sqlIdent. audit:sql stays green.
			this.db
				.prepare(
					`INSERT INTO ${tbl} (` +
						`${sqlIdent("time")}, ${sqlIdent("method")}, ${sqlIdent("path")}, ${sqlIdent("status")}, ` +
						`${sqlIdent("duration_ms")}, ${sqlIdent("mode")}, ${sqlIdent("org")}, ${sqlIdent("workspace")}) ` +
						`VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					record.time,
					record.method,
					record.path,
					record.status,
					record.durationMs,
					record.mode,
					record.org ?? null,
					record.workspace ?? null,
				);
			this.afterWrite();
		} catch (err: unknown) {
			this.failOnce("request append", err);
		}
	}

	appendEvent(record: EventLogRecord): void {
		if (this.closed) return;
		try {
			const tbl = sqlIdent(EVENT_LOG_TABLE);
			this.db
				.prepare(`INSERT INTO ${tbl} (${sqlIdent("time")}, ${sqlIdent("event")}, ${sqlIdent("fields")}) VALUES (?, ?, ?)`)
				.run(record.time, record.event, safeJson(record.fields));
			this.afterWrite();
		} catch (err: unknown) {
			this.failOnce("event append", err);
		}
	}

	queryRequests(query: HistoryQuery): HistoryPage {
		if (this.closed) return { records: [], nextCursor: null };
		try {
			return this.runHistoryQuery(query);
		} catch (err: unknown) {
			this.failOnce("history read", err);
			return { records: [], nextCursor: null };
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} catch {
			// Closing an already-closed/errored handle must never throw out of shutdown.
		}
	}

	/** Build + run the filtered, paginated, newest-first history SELECT (FR-3/FR-4/FR-5). */
	private runHistoryQuery(query: HistoryQuery): HistoryPage {
		const tbl = sqlIdent(REQUEST_LOG_TABLE);
		const timeCol = sqlIdent("time");
		const statusCol = sqlIdent("status");
		const pathCol = sqlIdent("path");
		const orgCol = sqlIdent("org");
		const idCol = sqlIdent("id");

		// Build the WHERE conjuncts as `<ident> <op> ?` clauses; every VALUE rides a bound `?`
		// parameter (the `params` array), never an interpolated literal — audit:sql safe.
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (query.since !== undefined) {
			clauses.push(`${timeCol} >= ?`);
			params.push(query.since);
		}
		if (query.until !== undefined) {
			clauses.push(`${timeCol} <= ?`);
			params.push(query.until);
		}
		const range = statusRange(query.status);
		if (range !== null) {
			clauses.push(`${statusCol} >= ? AND ${statusCol} < ?`);
			params.push(range.lo, range.hi);
		}
		if (query.path !== undefined) {
			// Prefix match: `path = ?` is the common exact case AND a prefix when the caller wants it.
			// We use a LIKE prefix bound as a parameter (the `%` is appended to the BOUND value, not
			// to SQL text) so a `/api/memories` filter also matches `/api/memories/recall`. The
			// `ESCAPE '\'` clause makes `escapeLikePrefix`'s backslash-escaping live, so a literal
			// `_`/`%` in the caller's path filters that exact character instead of acting as a wildcard.
			clauses.push(`${pathCol} LIKE ? ESCAPE '\\'`);
			params.push(`${escapeLikePrefix(query.path)}%`);
		}
		if (query.org !== undefined) {
			clauses.push(`${orgCol} = ?`);
			params.push(query.org);
		}
		if (query.cursor !== undefined) {
			clauses.push(`${idCol} < ?`);
			params.push(query.cursor.beforeId);
		}

		// `whereClause` is assembled ENTIRELY from `<sqlIdent> <op> ?` fragments — every VALUE rides a
		// bound `?` parameter in `params`, never an interpolated literal. The name's `Clause` suffix
		// marks it a pre-built safe fragment for the `audit:sql` gate (it carries no raw value).
		const conjunctionSql = clauses.join(" AND ");
		const whereClause = clauses.length > 0 ? ` WHERE ${conjunctionSql}` : "";
		// Fetch one extra row to know whether an older page exists (the cursor sentinel).
		const fetchLimit = query.limit + 1;
		params.push(fetchLimit);
		// Newest first by id (the autoincrement rowid is monotonic with insertion = time order).
		const selectSql = `SELECT * FROM ${tbl}${whereClause} ORDER BY ${idCol} DESC LIMIT ?`;
		const rows = this.db.prepare(selectSql).all(...params);

		const hasMore = rows.length > query.limit;
		const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
		const records = pageRows.map(rowToRequestRecord);
		const lastRow = pageRows[pageRows.length - 1];
		const nextCursor =
			hasMore && lastRow !== undefined ? encodeCursor({ beforeId: Number(lastRow.id) }) : null;
		return { records, nextCursor };
	}

	/** After each write, amortized opportunistic prune (every Nth append) — no per-write cost. */
	private afterWrite(): void {
		this.writesSincePrune++;
		if (this.writesSincePrune >= PRUNE_EVERY_N_WRITES) {
			this.writesSincePrune = 0;
			this.prune();
		}
	}

	/**
	 * Prune both tables back within the row + age bounds (FR-6 / AC-5): delete rows older than the
	 * age cutoff, then trim the oldest rows beyond the row cap. Fail-soft — a prune error is logged
	 * once and never throws. Every VALUE is bound; identifiers via sqlIdent.
	 */
	private prune(): void {
		try {
			const cutoffIso = new Date(this.clock.now() - this.maxAgeMs).toISOString();
			for (const table of [REQUEST_LOG_TABLE, EVENT_LOG_TABLE]) {
				const tbl = sqlIdent(table);
				const timeCol = sqlIdent("time");
				const idCol = sqlIdent("id");
				// Age cap: drop everything strictly older than the cutoff.
				this.db.prepare(`DELETE FROM ${tbl} WHERE ${timeCol} < ?`).run(cutoffIso);
				// Row cap: keep the newest `maxRows` by id; delete the rest.
				this.db
					.prepare(
						`DELETE FROM ${tbl} WHERE ${idCol} <= ` +
							`(SELECT ${idCol} FROM ${tbl} ORDER BY ${idCol} DESC LIMIT 1 OFFSET ?)`,
					)
					.run(this.maxRows);
			}
		} catch (err: unknown) {
			this.failOnce("prune", err);
		}
	}

	/** Surface a backing-store failure ONCE (never per request); subsequent failures stay quiet. */
	private failOnce(op: string, err: unknown): void {
		const reason = err instanceof Error ? err.message : String(err);
		this.onceFailure(`honeycomb: log store ${op} failed (non-fatal), staying in-memory: ${reason}`);
	}
}

/** Map a `request_log` row back to the {@link RequestLogRecord} shape the API serves. */
function rowToRequestRecord(row: Record<string, unknown>): RequestLogRecord {
	const record: { -readonly [K in keyof RequestLogRecord]: RequestLogRecord[K] } = {
		time: String(row.time ?? ""),
		method: String(row.method ?? ""),
		path: String(row.path ?? ""),
		status: Number(row.status ?? 0),
		durationMs: Number(row.duration_ms ?? 0),
		mode: String(row.mode ?? ""),
	};
	if (row.org !== null && row.org !== undefined) record.org = String(row.org);
	if (row.workspace !== null && row.workspace !== undefined) record.workspace = String(row.workspace);
	return record;
}

/** Serialize an event's coarse `fields` bag to JSON, degrading a non-serializable value to `{}`. */
function safeJson(fields: Readonly<Record<string, unknown>>): string {
	try {
		return JSON.stringify(fields);
	} catch {
		return "{}";
	}
}

/** Escape a LIKE prefix's wildcard chars so a literal `%`/`_` in the path is not a wildcard. */
function escapeLikePrefix(value: string): string {
	// The bound parameter carries the value verbatim; we only neutralize LIKE wildcards in it so the
	// caller's `/api/foo_bar` filters that literal underscore, not "any character".
	return value.replace(/[\\%_]/g, "\\$&");
}

/** Encode a {@link HistoryCursor} to an opaque base64url token. */
export function encodeCursor(cursor: HistoryCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode an opaque cursor token, or `undefined` on any malformed/garbage value (fail-safe). */
export function decodeCursor(token: string | undefined): HistoryCursor | undefined {
	if (token === undefined || token === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const id = (parsed as { beforeId?: unknown }).beforeId;
			if (typeof id === "number" && Number.isInteger(id) && id > 0) return { beforeId: id };
		}
		return undefined;
	} catch {
		return undefined;
	}
}
