/**
 * Daemon-local durable job queue for PRD-066a.
 *
 * This queue is intentionally local-only. It uses the built-in `node:sqlite`
 * driver under `.daemon/local-queue.db` and never imports or calls the DeepLake
 * storage client. Shared memory/vector work still belongs to DeepLake; this
 * module only schedules per-device work.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { sqlIdent } from "../../storage/sql.js";
import type { JobQueueStats } from "./job-queue.js";
import type { DaemonService } from "./types.js";

export const LOCAL_QUEUE_DAEMON_DIR_NAME = ".daemon" as const;
export const LOCAL_QUEUE_DB_FILE_NAME = "local-queue.db" as const;
export const LOCAL_JOB_TABLE = "local_job" as const;
const LOCAL_JOB_COLUMNS = Object.freeze([
	"id",
	"kind",
	"payload_json",
	"status",
	"priority",
	"attempts",
	"max_attempts",
	"run_after",
	"lease_owner",
	"leased_until",
	"created_at",
	"updated_at",
	"completed_at",
	"last_error_class",
] as const);
const LOCAL_JOB_SELECT_COLUMNS = LOCAL_JOB_COLUMNS.map((column) => sqlIdent(column)).join(", ");

export const LOCAL_JOB_QUEUED = "queued" as const;
export const LOCAL_JOB_RETRYING = "retrying" as const;
export const LOCAL_JOB_LEASED = "leased" as const;
export const LOCAL_JOB_DONE = "done" as const;
export const LOCAL_JOB_FAILED = "failed" as const;

export type LocalJobStatus =
	| typeof LOCAL_JOB_QUEUED
	| typeof LOCAL_JOB_RETRYING
	| typeof LOCAL_JOB_LEASED
	| typeof LOCAL_JOB_DONE
	| typeof LOCAL_JOB_FAILED;

export interface LocalJobInput {
	readonly kind: string;
	readonly payload: Record<string, unknown>;
	readonly priority?: number;
	readonly runAfter?: string;
	readonly maxAttempts?: number;
}

export interface LocalLeasedJob {
	readonly id: string;
	readonly kind: string;
	readonly payload: Record<string, unknown>;
	readonly attempt: number;
}

export interface LocalQueueCounts {
	readonly byStatus: Readonly<Record<LocalJobStatus, number>>;
	readonly byKind: Readonly<Record<string, number>>;
}

/** A mutable per-kind accumulator used while building the {@link JobQueueStats} snapshot. */
interface MutableJobKindStats {
	kind: string;
	queued: number;
	leased: number;
	done: number;
	failed: number;
	dead: number;
	total: number;
}

export interface LocalJobQueueService extends DaemonService {
	readonly persistent: boolean;
	enqueue(job: LocalJobInput): Promise<string>;
	lease(kinds?: readonly string[]): Promise<LocalLeasedJob | null>;
	complete(id: string, leaseAttempt?: number): Promise<void>;
	fail(id: string, reason: string, leaseAttempt?: number): Promise<void>;
	reclaimExpiredLeases(): Promise<number>;
	pruneCompleted(): Promise<number>;
	counts(): Promise<LocalQueueCounts>;
	/**
	 * The CURRENT-status snapshot in the SHARED {@link JobQueueStats} shape (job-observability), so the
	 * hybrid router can merge this local queue with the DeepLake shared queue behind one endpoint. Unlike
	 * {@link counts} (which reports `byStatus` and `byKind` SEPARATELY, never cross-partitioned), this
	 * runs a real `GROUP BY kind, status` so each kind carries its own per-status breakdown — the faithful
	 * mapping, never fabricated. Local statuses map onto the shared buckets: `queued`→queued,
	 * `retrying`→failed (awaiting backoff retry), `leased`→leased, `done`→done, `failed`→dead (terminal,
	 * retries exhausted).
	 */
	stats(): Promise<JobQueueStats>;
	close(): void;
}

export interface LocalJobQueueClock {
	now(): number;
}

export const systemLocalJobQueueClock: LocalJobQueueClock = { now: () => Date.now() };

export interface LocalJobQueueConfig {
	readonly owner?: string;
	readonly leaseMs?: number;
	readonly maxAttempts?: number;
	readonly backoffBaseMs?: number;
	readonly backoffCapMs?: number;
	readonly completedRetentionMs?: number;
}

export interface OpenLocalJobQueueOptions {
	readonly baseDir?: string;
	readonly memory?: boolean;
	readonly openExistingOnly?: boolean;
	readonly config?: LocalJobQueueConfig;
	readonly clock?: LocalJobQueueClock;
	readonly onceFailure?: (message: string) => void;
}

interface ResolvedLocalJobQueueConfig {
	readonly owner: string;
	readonly leaseMs: number;
	readonly maxAttempts: number;
	readonly backoffBaseMs: number;
	readonly backoffCapMs: number;
	readonly completedRetentionMs: number;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 5 * 60 * 1000;
const DEFAULT_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const OPEN_EXISTING_MISSING_MESSAGE = "local job queue database does not exist";

const LocalJobInputSchema = z.object({
	kind: z.string().trim().min(1),
	payload: z.record(z.string(), z.unknown()),
	priority: z.number().int().optional(),
	runAfter: z.string().datetime({ offset: true }).optional(),
	maxAttempts: z.number().int().min(1).max(100).optional(),
});

const SECRET_KEY_TERMS = new Set([
	"apikey",
	"authorization",
	"bearer",
	"cookie",
	"credential",
	"password",
	"secret",
	"session",
	"token",
]);

interface SqliteStatement {
	run(...params: unknown[]): { changes: number | bigint };
	all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

export const NULL_LOCAL_JOB_QUEUE: LocalJobQueueService = Object.freeze({
	persistent: false,
	async enqueue(): Promise<string> {
		throw new Error("local job queue unavailable");
	},
	async lease(): Promise<LocalLeasedJob | null> {
		return null;
	},
	async complete(): Promise<void> {},
	async fail(): Promise<void> {},
	async reclaimExpiredLeases(): Promise<number> {
		return 0;
	},
	async pruneCompleted(): Promise<number> {
		return 0;
	},
	async counts(): Promise<LocalQueueCounts> {
		return emptyCounts();
	},
	async stats(): Promise<JobQueueStats> {
		return { byKind: [], total: 0 };
	},
	async start(): Promise<void> {},
	async stop(): Promise<void> {},
	close(): void {},
});

export function openLocalJobQueue(options: OpenLocalJobQueueOptions = {}): LocalJobQueueService {
	const onceFailure = options.onceFailure ?? defaultOnceFailure();
	try {
		const db = createDatabase(options);
		if (options.openExistingOnly !== true) migrate(db);
		return new SqliteLocalJobQueue(
			db,
			resolveConfig(options.config),
			options.clock ?? systemLocalJobQueueClock,
			onceFailure,
		);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		if (options.openExistingOnly === true && reason === OPEN_EXISTING_MISSING_MESSAGE) return NULL_LOCAL_JOB_QUEUE;
		onceFailure(`honeycomb: local job queue unavailable (non-fatal): ${reason}`);
		return NULL_LOCAL_JOB_QUEUE;
	}
}

function resolveConfig(config: LocalJobQueueConfig | undefined): ResolvedLocalJobQueueConfig {
	return {
		owner: config?.owner ?? `local-${process.pid}`,
		leaseMs: config?.leaseMs ?? DEFAULT_LEASE_MS,
		maxAttempts: config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		backoffBaseMs: config?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
		backoffCapMs: config?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS,
		completedRetentionMs: config?.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS,
	};
}

function defaultOnceFailure(): (message: string) => void {
	let fired = false;
	return (message: string): void => {
		if (fired) return;
		fired = true;
		process.stderr.write(`${message}\n`);
	};
}

function createDatabase(options: OpenLocalJobQueueOptions): SqliteDatabase {
	const sqlite = loadSqlite();
	if (options.memory === true) return new sqlite.DatabaseSync(":memory:") as SqliteDatabase;
	const dir = localQueueDaemonDir(options.baseDir);
	const dbPath = localQueueDatabasePath(dir);
	if (options.openExistingOnly === true && !existsSync(dbPath)) {
		throw new Error(OPEN_EXISTING_MISSING_MESSAGE);
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return new sqlite.DatabaseSync(dbPath) as SqliteDatabase;
}

function localQueueDatabasePath(daemonDir: string): string {
	const dbPath = resolve(daemonDir, LOCAL_QUEUE_DB_FILE_NAME);
	if (relative(daemonDir, dbPath) !== LOCAL_QUEUE_DB_FILE_NAME) {
		throw new Error("local job queue database path must stay inside the daemon directory");
	}
	return dbPath;
}

function localQueueDaemonDir(baseDir: string | undefined): string {
	const resolvedBaseDir = resolveLocalQueueBaseDir(baseDir);
	const daemonDir = resolve(resolvedBaseDir, LOCAL_QUEUE_DAEMON_DIR_NAME);
	const relativeDaemonDir = relative(resolvedBaseDir, daemonDir);
	if (relativeDaemonDir.startsWith("..") || relativeDaemonDir === "" || relativeDaemonDir.includes(`..${sep}`)) {
		throw new Error("local job queue directory must stay inside the configured baseDir");
	}
	return daemonDir;
}

function resolveLocalQueueBaseDir(baseDir: string | undefined): string {
	const rawBaseDir = baseDir ?? process.cwd();
	if (rawBaseDir.includes("\0")) throw new Error("local job queue baseDir contains an invalid character");
	if (baseDir !== undefined && !isAbsolute(baseDir)) {
		const resolvedRelative = resolve(process.cwd(), baseDir);
		const relativeToCwd = relative(process.cwd(), resolvedRelative);
		if (relativeToCwd.startsWith("..") || relativeToCwd === "..") {
			throw new Error("relative local job queue baseDir must stay inside the current working directory");
		}
		return assertTrustedLocalQueueBaseDir(resolvedRelative);
	}
	return assertTrustedLocalQueueBaseDir(resolve(rawBaseDir));
}

function assertTrustedLocalQueueBaseDir(candidate: string): string {
	const allowedRoots = trustedLocalQueueRoots();
	if (!allowedRoots.some((root) => isPathInside(candidate, root))) {
		throw new Error("local job queue baseDir must be inside a trusted runtime directory");
	}
	return candidate;
}

function trustedLocalQueueRoots(): readonly string[] {
	const roots = [process.cwd(), homedir(), tmpdir()];
	const workspace = process.env.HONEYCOMB_WORKSPACE;
	if (workspace !== undefined && workspace.length > 0) roots.push(workspace);
	return roots.map((root) => resolve(root));
}

function isPathInside(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}

function loadSqlite(): SqliteModule {
	const req = createRequire(import.meta.url);
	return req("node:sqlite") as SqliteModule;
}

function migrate(db: SqliteDatabase): void {
	const tbl = sqlIdent(LOCAL_JOB_TABLE);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${tbl} (` +
			`${sqlIdent("id")} TEXT PRIMARY KEY, ` +
			`${sqlIdent("kind")} TEXT NOT NULL, ` +
			`${sqlIdent("payload_json")} TEXT NOT NULL, ` +
			`${sqlIdent("status")} TEXT NOT NULL, ` +
			`${sqlIdent("priority")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("attempts")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("max_attempts")} INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS}, ` +
			`${sqlIdent("run_after")} TEXT NOT NULL, ` +
			`${sqlIdent("lease_owner")} TEXT, ` +
			`${sqlIdent("leased_until")} TEXT, ` +
			`${sqlIdent("created_at")} TEXT NOT NULL, ` +
			`${sqlIdent("updated_at")} TEXT NOT NULL, ` +
			`${sqlIdent("completed_at")} TEXT, ` +
			`${sqlIdent("last_error_class")} TEXT)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_local_job_runnable")} ON ${tbl} (` +
			`${sqlIdent("status")}, ${sqlIdent("run_after")}, ${sqlIdent("priority")}, ${sqlIdent("created_at")})`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_local_job_lease")} ON ${tbl} (` +
			`${sqlIdent("lease_owner")}, ${sqlIdent("leased_until")})`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_local_job_kind_status")} ON ${tbl} (` +
			`${sqlIdent("kind")}, ${sqlIdent("status")})`,
	);
	db.exec(`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_local_job_completed")} ON ${tbl} (${sqlIdent("completed_at")})`);
}

class SqliteLocalJobQueue implements LocalJobQueueService {
	readonly persistent = true;
	private closed = false;

	constructor(
		private readonly db: SqliteDatabase,
		private readonly config: ResolvedLocalJobQueueConfig,
		private readonly clock: LocalJobQueueClock,
		private readonly onceFailure: (message: string) => void,
	) {}

	async start(): Promise<void> {}

	async stop(): Promise<void> {
		this.close();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} catch {
			// Shutdown must not throw.
		}
	}

	async enqueue(job: LocalJobInput): Promise<string> {
		this.assertOpen();
		const parsed = LocalJobInputSchema.parse(job);
		assertPayloadSecretFree(parsed.payload);
		const now = this.nowIso();
		const id = crypto.randomUUID();
		const tbl = sqlIdent(LOCAL_JOB_TABLE);
		this.db
			.prepare(
				`INSERT INTO ${tbl} (` +
					`${sqlIdent("id")}, ${sqlIdent("kind")}, ${sqlIdent("payload_json")}, ${sqlIdent("status")}, ` +
					`${sqlIdent("priority")}, ${sqlIdent("attempts")}, ${sqlIdent("max_attempts")}, ${sqlIdent("run_after")}, ` +
					`${sqlIdent("created_at")}, ${sqlIdent("updated_at")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				parsed.kind,
				JSON.stringify(parsed.payload),
				LOCAL_JOB_QUEUED,
				parsed.priority ?? 0,
				0,
				parsed.maxAttempts ?? this.config.maxAttempts,
				parsed.runAfter === undefined ? now : new Date(parsed.runAfter).toISOString(),
				now,
				now,
			);
		return id;
	}

	async lease(kinds?: readonly string[]): Promise<LocalLeasedJob | null> {
		this.assertOpen();
		const now = this.nowIso();
		const leasedUntil = new Date(this.clock.now() + this.config.leaseMs).toISOString();
		try {
			this.beginImmediate();
			const row = this.nextRunnable(now, kinds);
			if (row === null) {
				this.commit();
				return null;
			}
			const attempts = numberField(row, "attempts") + 1;
			this.db
				.prepare(
					`UPDATE ${sqlIdent(LOCAL_JOB_TABLE)} SET ` +
						`${sqlIdent("status")} = ?, ${sqlIdent("attempts")} = ?, ${sqlIdent("lease_owner")} = ?, ` +
						`${sqlIdent("leased_until")} = ?, ${sqlIdent("updated_at")} = ? WHERE ${sqlIdent("id")} = ?`,
				)
				.run(LOCAL_JOB_LEASED, attempts, this.config.owner, leasedUntil, now, stringField(row, "id"));
			this.commit();
			return {
				id: stringField(row, "id"),
				kind: stringField(row, "kind"),
				payload: parsePayload(stringField(row, "payload_json")),
				attempt: attempts,
			};
		} catch (err: unknown) {
			this.rollbackQuietly();
			this.failOnce("lease", err);
			return null;
		}
	}

	async complete(id: string, leaseAttempt?: number): Promise<void> {
		this.assertOpen();
		const now = this.nowIso();
		const leaseFilter =
			leaseAttempt === undefined ? "" : ` AND ${sqlIdent("status")} = ? AND ${sqlIdent("attempts")} = ?`;
		this.db
			.prepare(
				`UPDATE ${sqlIdent(LOCAL_JOB_TABLE)} SET ` +
					`${sqlIdent("status")} = ?, ${sqlIdent("lease_owner")} = NULL, ${sqlIdent("leased_until")} = NULL, ` +
					`${sqlIdent("completed_at")} = ?, ${sqlIdent("updated_at")} = ? WHERE ${sqlIdent("id")} = ?${leaseFilter}`,
			)
			.run(LOCAL_JOB_DONE, now, now, id, ...(leaseAttempt === undefined ? [] : [LOCAL_JOB_LEASED, leaseAttempt]));
	}

	async fail(id: string, reason: string, leaseAttempt?: number): Promise<void> {
		this.assertOpen();
		const row = leaseAttempt === undefined ? this.getById(id) : this.getActiveLease(id, leaseAttempt);
		if (row === null) return;
		const attempts = numberField(row, "attempts");
		const maxAttempts = numberField(row, "max_attempts");
		const exhausted = attempts >= maxAttempts;
		const nowMs = this.clock.now();
		const now = new Date(nowMs).toISOString();
		const status: LocalJobStatus = exhausted ? LOCAL_JOB_FAILED : LOCAL_JOB_RETRYING;
		const runAfter = exhausted ? now : new Date(nowMs + retryDelay(attempts, this.config)).toISOString();
		this.db
			.prepare(
				`UPDATE ${sqlIdent(LOCAL_JOB_TABLE)} SET ` +
					`${sqlIdent("status")} = ?, ${sqlIdent("run_after")} = ?, ${sqlIdent("lease_owner")} = NULL, ` +
					`${sqlIdent("leased_until")} = NULL, ${sqlIdent("updated_at")} = ?, ${sqlIdent("last_error_class")} = ? ` +
					`WHERE ${sqlIdent("id")} = ?` +
					(leaseAttempt === undefined ? "" : ` AND ${sqlIdent("status")} = ? AND ${sqlIdent("attempts")} = ?`),
			)
			.run(
				status,
				runAfter,
				now,
				normalizeReason(reason),
				id,
				...(leaseAttempt === undefined ? [] : [LOCAL_JOB_LEASED, leaseAttempt]),
			);
	}

	async reclaimExpiredLeases(): Promise<number> {
		this.assertOpen();
		const now = this.nowIso();
		const result = this.db
			.prepare(
				`UPDATE ${sqlIdent(LOCAL_JOB_TABLE)} SET ` +
					`${sqlIdent("status")} = ?, ${sqlIdent("lease_owner")} = NULL, ${sqlIdent("leased_until")} = NULL, ` +
					`${sqlIdent("updated_at")} = ? WHERE ${sqlIdent("status")} = ? AND ${sqlIdent("leased_until")} <= ?`,
			)
			.run(LOCAL_JOB_RETRYING, now, LOCAL_JOB_LEASED, now);
		return changeCount(result);
	}

	async pruneCompleted(): Promise<number> {
		this.assertOpen();
		const cutoff = new Date(this.clock.now() - this.config.completedRetentionMs).toISOString();
		const result = this.db
			.prepare(
				`DELETE FROM ${sqlIdent(LOCAL_JOB_TABLE)} WHERE ${sqlIdent("status")} = ? AND ${sqlIdent("completed_at")} IS NOT NULL ` +
					`AND ${sqlIdent("completed_at")} < ?`,
			)
			.run(LOCAL_JOB_DONE, cutoff);
		return changeCount(result);
	}

	async counts(): Promise<LocalQueueCounts> {
		this.assertOpen();
		const byStatus = emptyCounts().byStatus as Record<LocalJobStatus, number>;
		const statusRows = this.db
			.prepare(
				`SELECT ${sqlIdent("status")} AS ${sqlIdent("status")}, COUNT(*) AS ${sqlIdent("count")} ` +
					`FROM ${sqlIdent(LOCAL_JOB_TABLE)} GROUP BY ${sqlIdent("status")}`,
			)
			.all();
		for (const row of statusRows) {
			const status = stringField(row, "status");
			if (isLocalJobStatus(status)) byStatus[status] = numberField(row, "count");
		}
		const byKind: Record<string, number> = {};
		const kindRows = this.db
			.prepare(
				`SELECT ${sqlIdent("kind")} AS ${sqlIdent("kind")}, COUNT(*) AS ${sqlIdent("count")} ` +
					`FROM ${sqlIdent(LOCAL_JOB_TABLE)} GROUP BY ${sqlIdent("kind")}`,
			)
			.all();
		for (const row of kindRows) byKind[stringField(row, "kind")] = numberField(row, "count");
		return { byStatus, byKind };
	}

	async stats(): Promise<JobQueueStats> {
		this.assertOpen();
		const rows = this.db
			.prepare(
				`SELECT ${sqlIdent("kind")} AS ${sqlIdent("kind")}, ${sqlIdent("status")} AS ${sqlIdent("status")}, ` +
					`COUNT(*) AS ${sqlIdent("count")} FROM ${sqlIdent(LOCAL_JOB_TABLE)} ` +
					`GROUP BY ${sqlIdent("kind")}, ${sqlIdent("status")}`,
			)
			.all();
		const byKind = new Map<string, MutableJobKindStats>();
		let total = 0;
		for (const row of rows) {
			const kind = stringField(row, "kind");
			const status = stringField(row, "status");
			const count = numberField(row, "count");
			let entry = byKind.get(kind);
			if (entry === undefined) {
				entry = { kind, queued: 0, leased: 0, done: 0, failed: 0, dead: 0, total: 0 };
				byKind.set(kind, entry);
			}
			entry.total += count;
			total += count;
			// Map local statuses onto the shared JobQueueStats buckets (faithful, never fabricated):
			//   queued→queued, retrying→failed (awaiting backoff), leased→leased, done→done,
			//   failed→dead (terminal, retries exhausted).
			if (status === LOCAL_JOB_QUEUED) entry.queued += count;
			else if (status === LOCAL_JOB_RETRYING) entry.failed += count;
			else if (status === LOCAL_JOB_LEASED) entry.leased += count;
			else if (status === LOCAL_JOB_DONE) entry.done += count;
			else if (status === LOCAL_JOB_FAILED) entry.dead += count;
		}
		const list = [...byKind.values()].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));
		return { byKind: list, total };
	}

	private nextRunnable(now: string, kinds?: readonly string[]): Record<string, unknown> | null {
		const kindFilter = kinds === undefined ? "" : ` AND ${sqlIdent("kind")} IN (${kinds.map(() => "?").join(", ")})`;
		if (kinds !== undefined && kinds.length === 0) return null;
		const rows = this.db
			.prepare(
				`SELECT ${LOCAL_JOB_SELECT_COLUMNS} FROM ${sqlIdent(LOCAL_JOB_TABLE)} WHERE (` +
					`(${sqlIdent("status")} IN (?, ?) AND ${sqlIdent("run_after")} <= ?) OR ` +
					`(${sqlIdent("status")} = ? AND ${sqlIdent("leased_until")} <= ?))` +
					kindFilter +
					` ORDER BY ${sqlIdent("priority")} DESC, ${sqlIdent("created_at")} ASC LIMIT 1`,
			)
			.all(LOCAL_JOB_QUEUED, LOCAL_JOB_RETRYING, now, LOCAL_JOB_LEASED, now, ...(kinds ?? []));
		return rows[0] ?? null;
	}

	private getById(id: string): Record<string, unknown> | null {
		const rows = this.db
			.prepare(
				`SELECT ${LOCAL_JOB_SELECT_COLUMNS} FROM ${sqlIdent(LOCAL_JOB_TABLE)} WHERE ${sqlIdent("id")} = ? LIMIT 1`,
			)
			.all(id);
		return rows[0] ?? null;
	}

	private getActiveLease(id: string, leaseAttempt: number | undefined): Record<string, unknown> | null {
		const attemptFilter = leaseAttempt === undefined ? "" : ` AND ${sqlIdent("attempts")} = ?`;
		const rows = this.db
			.prepare(
				`SELECT ${LOCAL_JOB_SELECT_COLUMNS} FROM ${sqlIdent(LOCAL_JOB_TABLE)} WHERE ${sqlIdent("id")} = ? ` +
					`AND ${sqlIdent("status")} = ?${attemptFilter} LIMIT 1`,
			)
			.all(id, LOCAL_JOB_LEASED, ...(leaseAttempt === undefined ? [] : [leaseAttempt]));
		return rows[0] ?? null;
	}

	private beginImmediate(): void {
		this.db.exec("BEGIN IMMEDIATE");
	}

	private commit(): void {
		this.db.exec("COMMIT");
	}

	private rollbackQuietly(): void {
		try {
			this.db.exec("ROLLBACK");
		} catch {
			// no transaction to roll back
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("local job queue is closed");
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	private failOnce(operation: string, err: unknown): void {
		const reason = err instanceof Error ? err.message : String(err);
		this.onceFailure(`honeycomb: local job queue ${operation} failed (non-fatal): ${reason}`);
	}
}

function retryDelay(attempts: number, config: ResolvedLocalJobQueueConfig): number {
	const exp = Math.max(0, attempts - 1);
	return Math.min(config.backoffBaseMs * 2 ** exp, config.backoffCapMs);
}

function normalizeReason(reason: string): string {
	return reason.trim().slice(0, 120) || "unknown";
}

function parsePayload(json: string): Record<string, unknown> {
	const parsed = JSON.parse(json) as unknown;
	if (!isRecord(parsed)) throw new Error("stored local job payload is not an object");
	return parsed;
}

function assertPayloadSecretFree(payload: Record<string, unknown>): void {
	const unsafePath = findSecretLikeKey(payload);
	if (unsafePath !== null) throw new Error(`local job payload may not contain secret-like field: ${unsafePath}`);
}

function findSecretLikeKey(value: unknown, path = "payload"): string | null {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const nested = findSecretLikeKey(value[i], `${path}[${i}]`);
			if (nested !== null) return nested;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	for (const [key, nestedValue] of Object.entries(value)) {
		const nextPath = `${path}.${key}`;
		if (isSecretLikeKey(key)) return nextPath;
		const nested = findSecretLikeKey(nestedValue, nextPath);
		if (nested !== null) return nested;
	}
	return null;
}

function isSecretLikeKey(key: string): boolean {
	const normalized = key.replace(/[_-]/g, "").toLowerCase();
	if (SECRET_KEY_TERMS.has(normalized)) return true;
	if (normalized.endsWith("token") || normalized.endsWith("password") || normalized.endsWith("secret")) return true;
	if (normalized.endsWith("apikey") || normalized.endsWith("credential") || normalized.endsWith("cookie")) return true;
	if (normalized === "sessioncookie" || normalized === "sessiontoken") return true;
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, field: string): string {
	const value = row[field];
	if (typeof value !== "string") throw new Error(`expected string field ${field}`);
	return value;
}

function numberField(row: Record<string, unknown>, field: string): number {
	const value = row[field];
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	throw new Error(`expected number field ${field}`);
}

function changeCount(result: { readonly changes: number | bigint }): number {
	return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}

function isLocalJobStatus(status: string): status is LocalJobStatus {
	return (
		status === LOCAL_JOB_QUEUED ||
		status === LOCAL_JOB_RETRYING ||
		status === LOCAL_JOB_LEASED ||
		status === LOCAL_JOB_DONE ||
		status === LOCAL_JOB_FAILED
	);
}

function emptyCounts(): LocalQueueCounts {
	return {
		byStatus: {
			[LOCAL_JOB_QUEUED]: 0,
			[LOCAL_JOB_RETRYING]: 0,
			[LOCAL_JOB_LEASED]: 0,
			[LOCAL_JOB_DONE]: 0,
			[LOCAL_JOB_FAILED]: 0,
		},
		byKind: {},
	};
}
