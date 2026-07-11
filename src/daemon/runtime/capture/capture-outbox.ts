/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * The durable capture retry outbox — PRD-079a (a-AC-1 .. a-AC-7).
 *
 * ── Why this exists (the last uncovered write-path failure mode) ─────────────
 * Warm DeepLake appends are ~2s and payload-independent, but the hosted backend
 * FLAPS and HIBERNATES (`deeplake.woke`): during a degraded window a `sessions`
 * append can exceed the 10s per-statement bound and return `timeout`. Captures are
 * single-attempt on the hot path (PRD-077 B), so on that failure the batch was
 * DROPPED — the captured turns were silently lost (findings §1.4 / §5). This outbox
 * is the write-side twin of PRD-078's read-side index: on an append failure the
 * built `sessions` row is PERSISTED here instead of dropped, and a background drainer
 * re-appends it on the dedicated WRITE client once the backend recovers. Over a
 * degraded window + recovery the corpus ends up COMPLETE.
 *
 * ── Substrate (D-1): a dedicated table inside the SAME local-queue.db file ────
 * It reuses the PRD-066 `local-queue.db` open/migrate + home-anchored trusted-root
 * idioms (shared via the exported helpers in `local-job-queue.ts`) but is a DEDICATED
 * `capture_outbox` table — NOT the pipeline `local_jobs` queue, and NOT subject to its
 * job-payload secret guard (a captured `sessions` row legitimately carries conversation
 * content). Home-anchored on {@link honeycombStateDir} (via the injected `baseDir`), so
 * a queued capture survives a daemon restart and drains on the next boot regardless of
 * launch cwd (a-AC-4 / D-5).
 *
 * ── Idempotency (a-AC-6 / D-3) ───────────────────────────────────────────────
 * The row is stored under its ALREADY-BUILT deterministic `id` (the `makeRowId` value
 * carried in the row's `id` column). Enqueue is `INSERT OR IGNORE` on that PK, so a
 * re-enqueue of the same row never duplicates. A row is enqueued ONLY on a CONFIRMED
 * non-ok append (the row was not written); the rare client-timeout-that-actually-landed
 * duplicate is absorbed downstream by `source+id` dedup at read-time fusion.
 *
 * ── Fail-soft everywhere (a-AC-5 / D-4) ──────────────────────────────────────
 * An enqueue or drain fault (SQLite error, disk full, a corrupt persisted row) NEVER
 * breaks the capture path and NEVER surfaces to the hook — it is logged
 * (`capture.outbox.enqueue_failed` / `capture.outbox.drain_failed`) and, for a truly
 * un-persistable row, counted as dropped by the caller. The drainer runs on an unref'd
 * interval (so it never keeps the process alive) and re-appends on the dedicated write
 * `Semaphore(3)` (PRD-077 B2) so it never starves recall.
 *
 * ── Observability (a-AC-7) ───────────────────────────────────────────────────
 * `counts()` feeds the `/health` `captureOutbox { pending, retrying }` field, and the
 * drainer emits SECRET-FREE `capture.outbox.{enqueued,drained,retry}` events carrying
 * only counts / durations / attempt numbers — never message content, a token, query
 * text, an org, or a workspace string.
 */

import { mkdirSync } from "node:fs";

import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsertMany, type ColumnValue, type RowValues } from "../../storage/writes.js";
import {
	loadSqlite,
	localQueueDaemonDir,
	localQueueDatabasePath,
	numberField,
	type SqliteDatabase,
	stringField,
} from "../services/local-job-queue.js";
import { CAPTURE_WRITE_OPTS } from "./capture-handler.js";

/** The dedicated outbox table living beside `local_job` inside the SAME `local-queue.db` file (D-1). */
export const CAPTURE_OUTBOX_TABLE = "capture_outbox" as const;
/** The single status a queued outbox row carries in the MVP (079b adds `dead`). */
export const CAPTURE_OUTBOX_PENDING = "pending" as const;

/** How often the background drainer re-attempts due rows (unref'd interval). Off the hot path. */
export const DEFAULT_OUTBOX_DRAIN_INTERVAL_MS = 30_000;
/** Bounded exponential backoff BASE between drain attempts for one row (a-AC-3). */
export const DEFAULT_OUTBOX_BACKOFF_BASE_MS = 5_000;
/** Bounded exponential backoff CAP so a persistent degraded window can never hot-loop the write client (a-AC-3). */
export const DEFAULT_OUTBOX_BACKOFF_CAP_MS = 5 * 60 * 1_000;
/** Max rows leased per drain pass so one tick can never issue an unbounded burst of appends. */
export const DEFAULT_OUTBOX_DRAIN_BATCH = 50;

/** The kill-switch env flag (default ON) — mirrors the amplification-config opt-out posture. */
export const CAPTURE_OUTBOX_ENV = "HONEYCOMB_CAPTURE_OUTBOX" as const;

/** The outbox backlog snapshot surfaced on `/health` (a-AC-7). Carries counts only — no secret. */
export interface CaptureOutboxCounts {
	/** Total rows still queued for a durable re-append (the whole backlog). */
	readonly pending: number;
	/** The subset that has already failed at least one drain attempt (`attempts > 0`). */
	readonly retrying: number;
}

/** Outcome of an {@link CaptureOutboxSink.enqueue} — never throws; reports what became durable vs truly lost. */
export interface CaptureOutboxEnqueueResult {
	/** Rows now durably persisted (including idempotent no-ops on a re-enqueue of the same id). */
	readonly enqueued: number;
	/** Rows that could NOT be persisted (no id / a SQLite fault) — truly lost, the caller counts them dropped. */
	readonly dropped: number;
}

/** Outcome of one {@link CaptureOutbox.drainDue} pass — counts only. */
export interface CaptureOutboxDrainResult {
	/** Rows re-appended OK and deleted from the outbox this pass. */
	readonly drained: number;
	/** Rows whose re-append failed this pass (attempts bumped + `next_attempt_at` pushed out). */
	readonly retried: number;
}

/** The NARROW surface the capture handler needs: persist failed rows, never throw (a-AC-5). */
export interface CaptureOutboxSink {
	/**
	 * Persist each `{ row, scope }` under its existing deterministic id (`INSERT OR IGNORE`, a-AC-6).
	 * FAIL-SOFT: never throws — a SQLite/disk fault is caught, logged (`capture.outbox.enqueue_failed`),
	 * and reported as `dropped` so the caller keeps the drop metric honest.
	 */
	enqueue(rows: readonly RowValues[], scope: QueryScope): CaptureOutboxEnqueueResult;
}

/** The full outbox: the enqueue sink + the background drainer + its lifecycle. */
export interface CaptureOutbox extends CaptureOutboxSink {
	/** The `{ pending, retrying }` backlog snapshot for `/health` (a-AC-7). */
	counts(): CaptureOutboxCounts;
	/**
	 * Run ONE drain pass: lease due rows (`next_attempt_at <= now`, skipping not-yet-due rows — a-AC-3),
	 * re-append each on the injected WRITE client; on OK delete the row, on non-ok bump `attempts` and
	 * push `next_attempt_at` by the bounded backoff. FAIL-SOFT: never throws.
	 */
	drainDue(): Promise<CaptureOutboxDrainResult>;
	/** Arm the unref'd drain interval (idempotent). */
	start(): void;
	/** Cancel the drain interval (idempotent). */
	stop(): void;
	/** Stop the drainer + close the SQLite handle (idempotent, never throws). */
	close(): void;
}

/** A clock + cancelable-timer seam so a test drives the drain interval with no real sleep (mirrors `BufferClock`). */
export interface OutboxClock {
	/** Current epoch ms. Defaults to `Date.now`. */
	now(): number;
	/** Schedule a repeating `fn` every `ms`; returns a handle to cancel. Defaults to an unref'd `setInterval`. */
	setInterval(fn: () => void, ms: number): unknown;
	/** Cancel a previously scheduled interval. Defaults to `clearInterval`. */
	clearInterval(handle: unknown): void;
}

/** The real-clock implementation (production default) — the interval is unref'd so it never keeps the loop alive. */
export const realOutboxClock: OutboxClock = {
	now: () => Date.now(),
	setInterval: (fn, ms) => {
		const t = setInterval(fn, ms);
		if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
		return t;
	},
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Tuning for the drainer's bounded exponential backoff (a-AC-3). Both optional; each falls back to its default. */
export interface CaptureOutboxBackoff {
	/** First-retry delay in ms (default {@link DEFAULT_OUTBOX_BACKOFF_BASE_MS}). */
	readonly baseMs?: number;
	/** Backoff ceiling in ms (default {@link DEFAULT_OUTBOX_BACKOFF_CAP_MS}). */
	readonly capMs?: number;
}

/** Construction options for {@link openCaptureOutbox}. Everything is injected for testability. */
export interface OpenCaptureOutboxOptions {
	/**
	 * The dedicated WRITE `StorageQuery` the drainer re-appends on (PRD-077 B2 `Semaphore(3)`), so a
	 * backlog drain never consumes a read slot and starves recall.
	 */
	readonly storage: StorageQuery;
	/** The `{ table: "sessions", columns }` heal target the re-append runs through (catalog `healTargetFor`). */
	readonly sessionsTarget: HealTarget;
	/** The home-anchored base dir ({@link honeycombStateDir} in production); the db lives at `<baseDir>/.daemon/local-queue.db`. */
	readonly baseDir?: string;
	/** Open an in-memory db (tests) instead of the on-disk file. */
	readonly memory?: boolean;
	/** Injected clock/timer seam (tests). Defaults to {@link realOutboxClock}. */
	readonly clock?: OutboxClock;
	/** Secret-free structured-log sink for the `capture.outbox.*` events. */
	readonly logger?: OutboxLogger;
	/** Drain interval in ms (default {@link DEFAULT_OUTBOX_DRAIN_INTERVAL_MS}). */
	readonly drainIntervalMs?: number;
	/** Bounded exponential backoff tuning (a-AC-3). */
	readonly backoff?: CaptureOutboxBackoff;
	/** Max rows leased per drain pass (default {@link DEFAULT_OUTBOX_DRAIN_BATCH}). */
	readonly drainBatch?: number;
}

/** A minimal structured-log sink (matches the capture handler's / request logger's `event` shape). */
export interface OutboxLogger {
	/** Record a SECRET-FREE structured event (e.g. `capture.outbox.drained`). */
	event(name: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** The `ColumnValue` shape as persisted in `row_json` — validated on read since the file is a boundary (a-AC-5). */
const ColumnValueSchema = z.union([
	z.object({ kind: z.literal("text"), value: z.string() }),
	z.object({ kind: z.literal("literal"), value: z.string() }),
	z.object({ kind: z.literal("number"), value: z.number() }),
	z.object({ kind: z.literal("raw"), value: z.string() }),
]);
/** A persisted `sessions` row: the ordered `[column, value]` tuples the append primitive replays. */
const RowValuesSchema = z.array(z.tuple([z.string(), ColumnValueSchema]));

/**
 * Open (or create) the capture outbox over the `capture_outbox` table in the home-anchored
 * `local-queue.db`. FAIL-SOFT at construction: any open/migrate failure degrades to the
 * {@link NULL_CAPTURE_OUTBOX} no-op so a broken SQLite substrate NEVER breaks capture — the
 * degraded-window rows are dropped-as-before (never a throw at the composition root).
 */
export function openCaptureOutbox(options: OpenCaptureOutboxOptions): CaptureOutbox {
	try {
		const db = openOutboxDatabase(options);
		migrate(db);
		return new SqliteCaptureOutbox(db, options);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		options.logger?.event("capture.outbox.open_failed", { reason });
		return NULL_CAPTURE_OUTBOX;
	}
}

/** The inert outbox used when the substrate cannot open — capture stays fail-soft (drops as pre-079a). */
export const NULL_CAPTURE_OUTBOX: CaptureOutbox = Object.freeze({
	enqueue(rows: readonly RowValues[]): CaptureOutboxEnqueueResult {
		// No durable store → nothing is persisted; every row is a confirmed drop (the caller counts it).
		return { enqueued: 0, dropped: rows.length };
	},
	counts(): CaptureOutboxCounts {
		return { pending: 0, retrying: 0 };
	},
	async drainDue(): Promise<CaptureOutboxDrainResult> {
		return { drained: 0, retried: 0 };
	},
	start(): void {},
	stop(): void {},
	close(): void {},
});

function openOutboxDatabase(options: OpenCaptureOutboxOptions): SqliteDatabase {
	const sqlite = loadSqlite();
	if (options.memory === true) return new sqlite.DatabaseSync(":memory:");
	// Reuse the local-queue trusted-root guard + path resolution (D-1): the outbox rides the SAME
	// home-anchored `.daemon/local-queue.db` file, so it inherits the exact durability + traversal
	// safety the pipeline queue already proved.
	const dir = localQueueDaemonDir(options.baseDir);
	const dbPath = localQueueDatabasePath(dir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return new sqlite.DatabaseSync(dbPath);
}

function migrate(db: SqliteDatabase): void {
	const tbl = sqlIdent(CAPTURE_OUTBOX_TABLE);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${tbl} (` +
			`${sqlIdent("id")} TEXT PRIMARY KEY, ` +
			`${sqlIdent("org")} TEXT NOT NULL, ` +
			`${sqlIdent("workspace")} TEXT NOT NULL, ` +
			`${sqlIdent("row_json")} TEXT NOT NULL, ` +
			`${sqlIdent("attempts")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("next_attempt_at")} TEXT NOT NULL, ` +
			`${sqlIdent("created_at")} TEXT NOT NULL, ` +
			`${sqlIdent("status")} TEXT NOT NULL)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_capture_outbox_due")} ON ${tbl} (` +
			`${sqlIdent("status")}, ${sqlIdent("next_attempt_at")})`,
	);
}

class SqliteCaptureOutbox implements CaptureOutbox {
	private readonly db: SqliteDatabase;
	private readonly storage: StorageQuery;
	private readonly sessionsTarget: HealTarget;
	private readonly clock: OutboxClock;
	private readonly logger: OutboxLogger | undefined;
	private readonly drainIntervalMs: number;
	private readonly backoffBaseMs: number;
	private readonly backoffCapMs: number;
	private readonly drainBatch: number;

	private timer: unknown = null;
	private draining = false;
	private closed = false;

	constructor(db: SqliteDatabase, options: OpenCaptureOutboxOptions) {
		this.db = db;
		this.storage = options.storage;
		this.sessionsTarget = options.sessionsTarget;
		this.clock = options.clock ?? realOutboxClock;
		this.logger = options.logger;
		this.drainIntervalMs = Math.max(1, options.drainIntervalMs ?? DEFAULT_OUTBOX_DRAIN_INTERVAL_MS);
		this.backoffBaseMs = Math.max(1, options.backoff?.baseMs ?? DEFAULT_OUTBOX_BACKOFF_BASE_MS);
		this.backoffCapMs = Math.max(this.backoffBaseMs, options.backoff?.capMs ?? DEFAULT_OUTBOX_BACKOFF_CAP_MS);
		this.drainBatch = Math.max(1, options.drainBatch ?? DEFAULT_OUTBOX_DRAIN_BATCH);
	}

	enqueue(rows: readonly RowValues[], scope: QueryScope): CaptureOutboxEnqueueResult {
		if (this.closed || rows.length === 0) return { enqueued: 0, dropped: this.closed ? rows.length : 0 };
		let enqueued = 0;
		let dropped = 0;
		const nowIso = this.nowIso();
		try {
			const stmt = this.db.prepare(
				`INSERT OR IGNORE INTO ${sqlIdent(CAPTURE_OUTBOX_TABLE)} (` +
					`${sqlIdent("id")}, ${sqlIdent("org")}, ${sqlIdent("workspace")}, ${sqlIdent("row_json")}, ` +
					`${sqlIdent("attempts")}, ${sqlIdent("next_attempt_at")}, ${sqlIdent("created_at")}, ` +
					`${sqlIdent("status")}) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
			);
			for (const row of rows) {
				const id = rowId(row);
				if (id === null) {
					// A row with no `id` column can never be idempotently replayed — count it as a real drop.
					dropped += 1;
					continue;
				}
				// The row is enqueued due-NOW: the next drain pass attempts it (the backend was just failing,
				// so an immediate retry is throttled naturally by the drain interval, then by backoff on retry).
				stmt.run(id, scope.org, scope.workspace ?? "", JSON.stringify(row), nowIso, nowIso, CAPTURE_OUTBOX_PENDING);
				enqueued += 1;
			}
		} catch (err: unknown) {
			// Fail-soft (a-AC-5): a SQLite/disk fault must NEVER break capture. The rows we had not yet
			// persisted this call are the confirmed loss; log the fault (secret-free) and count them.
			const remaining = rows.length - enqueued - dropped;
			dropped += Math.max(0, remaining);
			enqueued = Math.min(enqueued, rows.length);
			this.logger?.event("capture.outbox.enqueue_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
			return { enqueued, dropped };
		}
		if (enqueued > 0) this.logger?.event("capture.outbox.enqueued", { count: enqueued });
		return { enqueued, dropped };
	}

	counts(): CaptureOutboxCounts {
		if (this.closed) return { pending: 0, retrying: 0 };
		try {
			const rows = this.db
				.prepare(
					`SELECT COUNT(*) AS ${sqlIdent("pending")}, ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("attempts")} > 0 THEN 1 ELSE 0 END), 0) AS ${sqlIdent("retrying")} ` +
						`FROM ${sqlIdent(CAPTURE_OUTBOX_TABLE)} WHERE ${sqlIdent("status")} = ?`,
				)
				.all(CAPTURE_OUTBOX_PENDING);
			const row = rows[0];
			if (row === undefined) return { pending: 0, retrying: 0 };
			return { pending: numberField(row, "pending"), retrying: numberField(row, "retrying") };
		} catch {
			// counts() is a read-only observability call; a fault must never propagate to `/health`.
			return { pending: 0, retrying: 0 };
		}
	}

	async drainDue(): Promise<CaptureOutboxDrainResult> {
		// Single-flight: the timer and an explicit call must never lease the same rows concurrently.
		if (this.closed || this.draining) return { drained: 0, retried: 0 };
		this.draining = true;
		const startMs = this.clock.now();
		let drained = 0;
		let retried = 0;
		try {
			const due = this.leaseDue(this.nowIso());
			for (const lease of due) {
				const parsed = this.parseRow(lease.rowJson);
				if (parsed === null) {
					// A corrupt persisted row can never be replayed — remove it so it does not poison the pass.
					this.deleteRow(lease.id);
					this.logger?.event("capture.outbox.drain_failed", { reason: "corrupt_row" });
					continue;
				}
				const scope: QueryScope =
					lease.workspace.length > 0 ? { org: lease.org, workspace: lease.workspace } : { org: lease.org };
				const ok = await this.reappend(scope, parsed);
				if (ok) {
					this.deleteRow(lease.id);
					drained += 1;
				} else {
					const attempt = lease.attempts + 1;
					this.pushBackoff(lease.id, attempt);
					retried += 1;
					// Secret-free: attempt number only — no content, org, or workspace string (a-AC-7).
					this.logger?.event("capture.outbox.retry", { attempt });
				}
			}
		} catch (err: unknown) {
			// Fail-soft: a drain fault never surfaces. Rows stay queued for the next pass.
			this.logger?.event("capture.outbox.drain_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.draining = false;
		}
		if (drained > 0) {
			this.logger?.event("capture.outbox.drained", { count: drained, durationMs: this.clock.now() - startMs });
		}
		return { drained, retried };
	}

	start(): void {
		if (this.closed || this.timer !== null) return;
		this.timer = this.clock.setInterval(() => {
			// The interval has NO external awaiter, so a rejection here would become an UNHANDLED promise
			// rejection and (Node ≥15) kill the daemon. drainDue already swallows every fault, but route
			// belt-and-suspenders so the timer path is ALWAYS fail-soft.
			void this.drainDue().catch(() => {});
		}, this.drainIntervalMs);
	}

	stop(): void {
		if (this.timer !== null) {
			this.clock.clearInterval(this.timer);
			this.timer = null;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stop();
		try {
			this.db.close();
		} catch {
			// Shutdown must not throw.
		}
	}

	/** Re-append one persisted row on the WRITE client with the SAME single-attempt capture opts. */
	private async reappend(scope: QueryScope, row: RowValues): Promise<boolean> {
		const result = await appendOnlyInsertMany(this.storage, this.sessionsTarget, scope, [row], CAPTURE_WRITE_OPTS);
		return isOk(result);
	}

	/** Lease the due rows (`next_attempt_at <= now`), oldest-first, bounded to {@link drainBatch}. Skips future rows (a-AC-3). */
	private leaseDue(nowIso: string): OutboxLease[] {
		const rows = this.db
			.prepare(
				`SELECT ${sqlIdent("id")}, ${sqlIdent("org")}, ${sqlIdent("workspace")}, ${sqlIdent("row_json")}, ` +
					`${sqlIdent("attempts")} FROM ${sqlIdent(CAPTURE_OUTBOX_TABLE)} ` +
					`WHERE ${sqlIdent("status")} = ? AND ${sqlIdent("next_attempt_at")} <= ? ` +
					`ORDER BY ${sqlIdent("next_attempt_at")} ASC, ${sqlIdent("created_at")} ASC LIMIT ?`,
			)
			.all(CAPTURE_OUTBOX_PENDING, nowIso, this.drainBatch);
		return rows.map((row) => ({
			id: stringField(row, "id"),
			org: stringField(row, "org"),
			workspace: stringField(row, "workspace"),
			rowJson: stringField(row, "row_json"),
			attempts: numberField(row, "attempts"),
		}));
	}

	private deleteRow(id: string): void {
		this.db.prepare(`DELETE FROM ${sqlIdent(CAPTURE_OUTBOX_TABLE)} WHERE ${sqlIdent("id")} = ?`).run(id);
	}

	/** Bump `attempts` and push `next_attempt_at` out by the bounded exponential backoff (a-AC-3). */
	private pushBackoff(id: string, attempt: number): void {
		const nextAt = new Date(this.clock.now() + this.backoff(attempt)).toISOString();
		this.db
			.prepare(
				`UPDATE ${sqlIdent(CAPTURE_OUTBOX_TABLE)} SET ${sqlIdent("attempts")} = ?, ` +
					`${sqlIdent("next_attempt_at")} = ? WHERE ${sqlIdent("id")} = ?`,
			)
			.run(attempt, nextAt, id);
	}

	/** `min(base * 2^(attempt-1), cap)` — the documented bounded exponential backoff. */
	private backoff(attempt: number): number {
		const exp = Math.max(0, attempt - 1);
		return Math.min(this.backoffBaseMs * 2 ** exp, this.backoffCapMs);
	}

	/** Parse + validate a persisted `row_json` back into {@link RowValues}; `null` on any corruption (a-AC-5). */
	private parseRow(rowJson: string): RowValues | null {
		try {
			const parsed = RowValuesSchema.parse(JSON.parse(rowJson) as unknown);
			return parsed as unknown as RowValues;
		} catch {
			return null;
		}
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}
}

/** One leased outbox row (the columns the drainer needs). */
interface OutboxLease {
	readonly id: string;
	readonly org: string;
	readonly workspace: string;
	readonly rowJson: string;
	readonly attempts: number;
}

/**
 * Extract the deterministic row id from an already-built `sessions` row (the `id` column's literal
 * value). Returns `null` when the row carries no usable id (never expected — `buildRow` always adds
 * one — but guarded so a malformed row is a countable drop, never a throw).
 */
function rowId(row: RowValues): string | null {
	for (const [name, value] of row) {
		if (name !== "id") continue;
		return columnStringValue(value);
	}
	return null;
}

/** Read a string id out of a `ColumnValue` (the `id` column is always a `literal`/`text` string). */
function columnStringValue(value: ColumnValue): string | null {
	if (value.kind === "literal" || value.kind === "text" || value.kind === "raw") {
		return value.value.length > 0 ? value.value : null;
	}
	return null;
}
