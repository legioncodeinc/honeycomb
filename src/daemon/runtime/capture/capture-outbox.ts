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
 * ── Observability (a-AC-7 / b-AC-2 / c-AC-4) ─────────────────────────────────
 * `counts()` feeds the `/health` `captureOutbox { pending, retrying, deadLettered }` field, and the
 * drainer emits SECRET-FREE `capture.outbox.{enqueued,drained,retry,dead_lettered,shed}` events carrying
 * only counts / durations / attempt numbers — never message content, a token, query
 * text, an org, or a workspace string.
 *
 * ── Scale: caps + coalescing + back-pressure (PRD-079c) ──────────────────────
 * c-AC-1: a `maxRows` cap on the ACTIVE (`pending`) backlog — an enqueue over it SHEDS the oldest pending
 * rows oldest-first (`capture.outbox.shed { count }`, never a silent truncation); `dead` rows are terminal
 * and never counted or shed. c-AC-2: on drain the due rows are COALESCED by scope + column signature into
 * one `appendOnlyInsertMany` per group (a failed group backs off / dead-letters each member independently,
 * never lost). c-AC-3: `maxDrainPerInterval` is the SINGLE authoritative per-pass attempt cap (it unified
 * the old 079a `drainBatch`), so a huge backlog drains at a bounded rate and the rest stays due. All three
 * paths are fail-soft: a fault degrades to the pre-079c behavior and never breaks capture (c-AC-4).
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
/** The ACTIVE status a queued outbox row carries: it is due for (or between) drain attempts. */
export const CAPTURE_OUTBOX_PENDING = "pending" as const;
/**
 * PRD-079b (b-AC-1): the TERMINAL dead-letter status. A row that reaches `maxAttempts` failed
 * re-appends OR exceeds `maxAgeMs` in the outbox is moved here — the row is RETAINED (never deleted,
 * never re-leased: {@link SqliteCaptureOutbox.leaseDue} filters `status = pending`), so it stops
 * consuming write slots and stops growing the active backlog. Bounded growth, never a silent vanish.
 */
export const CAPTURE_OUTBOX_DEAD = "dead" as const;

/** How often the background drainer re-attempts due rows (unref'd interval). Off the hot path. */
export const DEFAULT_OUTBOX_DRAIN_INTERVAL_MS = 30_000;
/** Bounded exponential backoff BASE between drain attempts for one row (a-AC-3). */
export const DEFAULT_OUTBOX_BACKOFF_BASE_MS = 5_000;
/** Bounded exponential backoff CAP so a persistent degraded window can never hot-loop the write client (a-AC-3). */
export const DEFAULT_OUTBOX_BACKOFF_CAP_MS = 5 * 60 * 1_000;
/**
 * PRD-079c (c-AC-3): the AUTHORITATIVE per-pass attempt cap. One {@link SqliteCaptureOutbox.drainDue}
 * pass leases (and therefore attempts) at MOST this many rows, so a huge backlog drains at a bounded
 * rate rather than bursting the write client's `Semaphore(3)`; the remainder is left due for the next
 * pass. Default 200.
 */
export const DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL = 200;
/**
 * @deprecated PRD-079c UNIFIED the two overlapping per-pass lease caps into ONE. The 079a "drain batch"
 * (was 50) and this phase's back-pressure knob were the same concept — how many rows a single pass may
 * attempt — so {@link DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL} is now the single source of truth and this
 * alias points at it. Retained only so a pre-079c import does not break; prefer the max-drain constant.
 */
export const DEFAULT_OUTBOX_DRAIN_BATCH = DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL;
/**
 * PRD-079c (c-AC-1): the ACTIVE-backlog row-count cap. When an enqueue would push the `pending` backlog
 * over this, the OLDEST pending rows are shed oldest-first (a secret-free `capture.outbox.shed` event,
 * never a silent truncation). `dead` rows are terminal and do NOT count toward this cap. Default 10,000.
 */
export const DEFAULT_OUTBOX_MAX_ROWS = 10_000;

/** PRD-079b (b-AC-1): failed re-appends after which a row dead-letters (`pending → dead`). */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 10;
/** PRD-079b (b-AC-1): age in the outbox after which a row dead-letters on its next failed attempt (24h). */
export const DEFAULT_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** The kill-switch env flag (default ON) — mirrors the amplification-config opt-out posture. */
export const CAPTURE_OUTBOX_ENV = "HONEYCOMB_CAPTURE_OUTBOX" as const;
/** PRD-079b (b-AC-1): env override for the dead-letter attempt bound (`HONEYCOMB_CAPTURE_OUTBOX_MAX_ATTEMPTS`). */
export const CAPTURE_OUTBOX_MAX_ATTEMPTS_ENV = "HONEYCOMB_CAPTURE_OUTBOX_MAX_ATTEMPTS" as const;
/** PRD-079b (b-AC-1): env override for the dead-letter age bound in ms (`HONEYCOMB_CAPTURE_OUTBOX_MAX_AGE_MS`). */
export const CAPTURE_OUTBOX_MAX_AGE_MS_ENV = "HONEYCOMB_CAPTURE_OUTBOX_MAX_AGE_MS" as const;
/** PRD-079c (c-AC-1): env override for the active-backlog row cap (`HONEYCOMB_CAPTURE_OUTBOX_MAX_ROWS`). */
export const CAPTURE_OUTBOX_MAX_ROWS_ENV = "HONEYCOMB_CAPTURE_OUTBOX_MAX_ROWS" as const;
/** PRD-079c (c-AC-3): env override for the per-pass back-pressure cap (`HONEYCOMB_CAPTURE_OUTBOX_MAX_DRAIN_PER_INTERVAL`). */
export const CAPTURE_OUTBOX_MAX_DRAIN_PER_INTERVAL_ENV = "HONEYCOMB_CAPTURE_OUTBOX_MAX_DRAIN_PER_INTERVAL" as const;

/** The resolved dead-letter bounds — {@link resolveCaptureOutboxLimits}'s output, passed to {@link openCaptureOutbox}. */
export interface CaptureOutboxLimits {
	/** Failed re-appends after which a row dead-letters (min 1). */
	readonly maxAttempts: number;
	/** Age in the outbox (ms) after which a row dead-letters on its next failed attempt (min 1). */
	readonly maxAgeMs: number;
	/** PRD-079c (c-AC-1): active-backlog (`pending`) row cap; over it, oldest pending rows are shed (min 1). */
	readonly maxRows: number;
	/** PRD-079c (c-AC-3): per-pass back-pressure cap — rows one drain pass will lease/attempt (min 1). */
	readonly maxDrainPerInterval: number;
}

/**
 * Coerce-and-clamp one env int knob (the amplification-config posture, without pulling zod onto this
 * daemon-only file): a non-numeric value falls back to `fallback`; a sub-`min` value is clamped UP to
 * `min` (a `0`/negative bound would dead-letter or never-dead-letter nonsensically). A typo is tuning
 * noise, never a hard reject — the daemon never fails to boot because a bound was fat-fingered.
 */
function clampIntKnob(raw: unknown, fallback: number, min: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.trunc(n));
}

/**
 * Resolve the dead-letter bounds from the environment (b-AC-1), amplification-config style: documented
 * defaults ({@link DEFAULT_OUTBOX_MAX_ATTEMPTS} / {@link DEFAULT_OUTBOX_MAX_AGE_MS}), env-overridable via
 * `HONEYCOMB_CAPTURE_OUTBOX_MAX_ATTEMPTS` / `HONEYCOMB_CAPTURE_OUTBOX_MAX_AGE_MS`, coerce-and-clamp (a
 * non-numeric or sub-1 value falls back / clamps up, never throws). Called ONCE at the composition root
 * (assemble) and threaded into {@link openCaptureOutbox}, so a fan-out/hot-path module never reads env.
 */
export function resolveCaptureOutboxLimits(env: NodeJS.ProcessEnv = process.env): CaptureOutboxLimits {
	return {
		maxAttempts: clampIntKnob(env[CAPTURE_OUTBOX_MAX_ATTEMPTS_ENV], DEFAULT_OUTBOX_MAX_ATTEMPTS, 1),
		maxAgeMs: clampIntKnob(env[CAPTURE_OUTBOX_MAX_AGE_MS_ENV], DEFAULT_OUTBOX_MAX_AGE_MS, 1),
		// PRD-079c (c-AC-1 / c-AC-3): the scale bounds, same coerce-and-clamp posture (a typo is tuning
		// noise, never a boot failure) — the cap and the per-pass back-pressure knob.
		maxRows: clampIntKnob(env[CAPTURE_OUTBOX_MAX_ROWS_ENV], DEFAULT_OUTBOX_MAX_ROWS, 1),
		maxDrainPerInterval: clampIntKnob(
			env[CAPTURE_OUTBOX_MAX_DRAIN_PER_INTERVAL_ENV],
			DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL,
			1,
		),
	};
}

/** The outbox backlog snapshot surfaced on `/health` (a-AC-7 / b-AC-2). Carries counts only — no secret. */
export interface CaptureOutboxCounts {
	/** ACTIVE rows still queued for a durable re-append (`status = pending`); EXCLUDES terminal `dead`. */
	readonly pending: number;
	/** The active subset that has already failed at least one drain attempt (`attempts > 0`, `status = pending`). */
	readonly retrying: number;
	/** PRD-079b (b-AC-2): TERMINAL dead-lettered rows (`status = dead`) — retained, not re-leased, not active. */
	readonly deadLettered: number;
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
	/** Rows whose re-append failed this pass and stayed pending (attempts bumped + `next_attempt_at` pushed out). */
	readonly retried: number;
	/** PRD-079b (b-AC-1): rows moved to terminal `dead` this pass (hit `maxAttempts` OR exceeded `maxAgeMs`). */
	readonly deadLettered: number;
}

/** The NARROW surface the capture handler needs: persist failed rows + kick a recovery drain, never throw (a-AC-5). */
export interface CaptureOutboxSink {
	/**
	 * Persist each `{ row, scope }` under its existing deterministic id (`INSERT OR IGNORE`, a-AC-6).
	 * FAIL-SOFT: never throws — a SQLite/disk fault is caught, logged (`capture.outbox.enqueue_failed`),
	 * and reported as `dropped` so the caller keeps the drop metric honest.
	 */
	enqueue(rows: readonly RowValues[], scope: QueryScope): CaptureOutboxEnqueueResult;
	/**
	 * PRD-079b (b-AC-3): the RECOVERY-TRIGGERED drain kick. A SUCCESSFUL capture append is the
	 * "backend recovered" signal — the capture handler calls this to drain the backlog IMMEDIATELY
	 * instead of waiting for the 30s interval. Single-flighted against the existing drain guard (a
	 * kick while a drain is in flight is a no-op) and FULLY FAIL-SOFT (never throws, never blocks the
	 * capture ack). OPTIONAL on the sink so a pre-079b test stub need not implement it.
	 */
	kick?(): void;
}

/** The full outbox: the enqueue sink + the background drainer + its lifecycle. */
export interface CaptureOutbox extends CaptureOutboxSink {
	/** The `{ pending, retrying, deadLettered }` backlog snapshot for `/health` (a-AC-7 / b-AC-2). */
	counts(): CaptureOutboxCounts;
	/**
	 * Run ONE drain pass: lease due rows (`next_attempt_at <= now`, skipping not-yet-due rows — a-AC-3),
	 * re-append each on the injected WRITE client; on OK delete the row, on non-ok bump `attempts` and
	 * push `next_attempt_at` by the bounded backoff, UNLESS the row hit `maxAttempts` OR exceeded
	 * `maxAgeMs` — then move it to terminal `dead` (b-AC-1). FAIL-SOFT: never throws.
	 */
	drainDue(): Promise<CaptureOutboxDrainResult>;
	/** PRD-079b (b-AC-3): fire an immediate single-flighted drain (recovery kick). Fail-soft, never throws. */
	kick(): void;
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
	/**
	 * PRD-079c (c-AC-3): the per-pass back-pressure cap — the max rows one drain pass leases/attempts
	 * (default {@link DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL}, clamped ≥ 1). This UNIFIES the old 079a
	 * `drainBatch` (the per-pass lease LIMIT) with the back-pressure knob into ONE authoritative cap, so
	 * a huge backlog drains at a bounded rate and the remainder stays due for the next pass.
	 */
	readonly maxDrainPerInterval?: number;
	/**
	 * PRD-079c (c-AC-1): the ACTIVE-backlog (`pending`) row cap (default {@link DEFAULT_OUTBOX_MAX_ROWS},
	 * clamped ≥ 1). When an enqueue pushes `pending` over this, the oldest pending rows are shed
	 * oldest-first with a secret-free `capture.outbox.shed` event; `dead` rows never count toward it.
	 * Resolved at the composition root via {@link resolveCaptureOutboxLimits}.
	 */
	readonly maxRows?: number;
	/**
	 * PRD-079b (b-AC-1): failed re-appends after which a row dead-letters (default
	 * {@link DEFAULT_OUTBOX_MAX_ATTEMPTS}, clamped ≥ 1). Resolved at the composition root via
	 * {@link resolveCaptureOutboxLimits} (env `HONEYCOMB_CAPTURE_OUTBOX_MAX_ATTEMPTS`).
	 */
	readonly maxAttempts?: number;
	/**
	 * PRD-079b (b-AC-1): age in the outbox (ms) after which a row dead-letters on its next failed attempt
	 * (default {@link DEFAULT_OUTBOX_MAX_AGE_MS}, clamped ≥ 1). Resolved at the composition root via
	 * {@link resolveCaptureOutboxLimits} (env `HONEYCOMB_CAPTURE_OUTBOX_MAX_AGE_MS`).
	 */
	readonly maxAgeMs?: number;
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
		return { pending: 0, retrying: 0, deadLettered: 0 };
	},
	async drainDue(): Promise<CaptureOutboxDrainResult> {
		return { drained: 0, retried: 0, deadLettered: 0 };
	},
	kick(): void {},
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
	private readonly maxDrainPerInterval: number;
	private readonly maxAttempts: number;
	private readonly maxAgeMs: number;
	private readonly maxRows: number;

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
		// PRD-079c (c-AC-3): the unified per-pass back-pressure cap (was `drainBatch`), clamped ≥ 1.
		this.maxDrainPerInterval = Math.max(
			1,
			Math.trunc(options.maxDrainPerInterval ?? DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL),
		);
		// PRD-079b (b-AC-1): the dead-letter bounds (clamped ≥ 1 belt-and-suspenders even though the
		// composition-root resolver already clamped; a direct-construction test may pass a raw value).
		this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS));
		this.maxAgeMs = Math.max(1, Math.trunc(options.maxAgeMs ?? DEFAULT_OUTBOX_MAX_AGE_MS));
		// PRD-079c (c-AC-1): the active-backlog row cap, clamped ≥ 1.
		this.maxRows = Math.max(1, Math.trunc(options.maxRows ?? DEFAULT_OUTBOX_MAX_ROWS));
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
		// PRD-079c (c-AC-1): enforce the active-backlog cap AFTER persisting the new rows, so the
		// just-enqueued (newest) rows are retained and the OLDEST pending rows are shed to stay ≤ maxRows.
		// Fully isolated + fail-soft: a shed fault degrades to the pre-079c behavior (no shed) and never
		// touches the enqueue accounting the caller relies on (c-AC-4).
		if (enqueued > 0) this.shedToCap();
		return { enqueued, dropped };
	}

	/**
	 * PRD-079c (c-AC-1): shed the OLDEST `pending` rows (oldest-first by `created_at`, then `id`) whenever
	 * the ACTIVE backlog exceeds {@link maxRows}, emitting a secret-free `capture.outbox.shed { count }`
	 * event — never a silent truncation. `dead` rows are terminal and EXCLUDED from the cap (the
	 * `status = pending` filter), so a dead-letter backlog neither counts nor is shed by this path.
	 * FAIL-SOFT: a SQLite fault degrades to a no-op (the pre-079c behavior) and never surfaces (c-AC-4).
	 */
	private shedToCap(): void {
		try {
			const tbl = sqlIdent(CAPTURE_OUTBOX_TABLE);
			const countRow = this.db
				.prepare(`SELECT COUNT(*) AS ${sqlIdent("n")} FROM ${tbl} WHERE ${sqlIdent("status")} = ?`)
				.all(CAPTURE_OUTBOX_PENDING)[0];
			const pending = countRow === undefined ? 0 : numberField(countRow, "n");
			const overflow = pending - this.maxRows;
			if (overflow <= 0) return;
			// Delete the oldest `overflow` pending rows in ONE targeted statement (the due-index covers the
			// ordering). A subquery bounds the shed to exactly the pending overflow — dead rows are untouched.
			const shed = this.db
				.prepare(
					`DELETE FROM ${tbl} WHERE ${sqlIdent("id")} IN (` +
						`SELECT ${sqlIdent("id")} FROM ${tbl} WHERE ${sqlIdent("status")} = ? ` +
						`ORDER BY ${sqlIdent("created_at")} ASC, ${sqlIdent("id")} ASC LIMIT ?)`,
				)
				.run(CAPTURE_OUTBOX_PENDING, overflow);
			const count = changeCount(shed);
			if (count > 0) this.logger?.event("capture.outbox.shed", { count });
		} catch (err: unknown) {
			// A shed fault must never break capture: leave the backlog as-is for a later enqueue to re-shed.
			this.logger?.event("capture.outbox.shed_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	counts(): CaptureOutboxCounts {
		if (this.closed) return { pending: 0, retrying: 0, deadLettered: 0 };
		try {
			// PRD-079b (b-AC-2): partition in ONE pass. `pending`/`retrying` count ACTIVE rows
			// (`status = pending`) only; `deadLettered` counts terminal `dead` rows — a `dead` row is
			// NEVER active, so the two never overlap. Conditional SUMs so the partition is a single scan.
			const rows = this.db
				.prepare(
					`SELECT ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("status")} = ? THEN 1 ELSE 0 END), 0) AS ${sqlIdent("pending")}, ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("status")} = ? AND ${sqlIdent("attempts")} > 0 THEN 1 ELSE 0 END), 0) AS ${sqlIdent("retrying")}, ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("status")} = ? THEN 1 ELSE 0 END), 0) AS ${sqlIdent("dead")} ` +
						`FROM ${sqlIdent(CAPTURE_OUTBOX_TABLE)}`,
				)
				.all(CAPTURE_OUTBOX_PENDING, CAPTURE_OUTBOX_PENDING, CAPTURE_OUTBOX_DEAD);
			const row = rows[0];
			if (row === undefined) return { pending: 0, retrying: 0, deadLettered: 0 };
			return {
				pending: numberField(row, "pending"),
				retrying: numberField(row, "retrying"),
				deadLettered: numberField(row, "dead"),
			};
		} catch {
			// counts() is a read-only observability call; a fault must never propagate to `/health`.
			return { pending: 0, retrying: 0, deadLettered: 0 };
		}
	}

	async drainDue(): Promise<CaptureOutboxDrainResult> {
		// Single-flight: the timer, the recovery kick, and an explicit call must never lease the same
		// rows concurrently. A kick or timer tick while a pass is in flight is a no-op (b-AC-3).
		if (this.closed || this.draining) return { drained: 0, retried: 0, deadLettered: 0 };
		this.draining = true;
		const startMs = this.clock.now();
		let drained = 0;
		let retried = 0;
		let deadLettered = 0;
		try {
			const due = this.leaseDue(this.nowIso());
			// PRD-079c (c-AC-2): COALESCE the due rows into groups that share BOTH a scope AND an identical
			// column signature, then re-append each group with ONE `appendOnlyInsertMany` — mirroring the
			// flush batcher so a recovery drains in few write ops. Heterogeneous shapes (e.g. assistant
			// turns carrying `usage` columns vs user turns) land in SEPARATE groups so `buildInsertMany`'s
			// same-columns assertion never rejects a batch. A corrupt row is dropped up front (never grouped).
			const groups = this.groupDue(due);
			for (const group of groups) {
				const rows = group.members.map((m) => m.row);
				const ok = await this.reappendMany(group.scope, rows);
				if (ok) {
					// Whole-group success: delete EVERY member (drained += group size). No row is double-counted.
					for (const member of group.members) {
						this.deleteRow(member.lease.id);
						drained += 1;
					}
				} else {
					// PRD-079c (c-AC-2): a group append failure fails EACH member INDEPENDENTLY, exactly as the
					// 079a/079b per-row path did — attempts+1 + pushBackoff, with the SAME per-member dead-letter
					// check (maxAttempts / maxAgeMs). No row is lost; a member hitting a bound dead-letters while
					// its siblings back off.
					for (const member of group.members) {
						if (this.deadLetter(member.lease)) {
							deadLettered += 1;
						} else {
							const attempt = member.lease.attempts + 1;
							this.pushBackoff(member.lease.id, attempt);
							retried += 1;
							// Secret-free: attempt number only — no content, org, or workspace string (a-AC-7).
							this.logger?.event("capture.outbox.retry", { attempt });
						}
					}
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
		return { drained, retried, deadLettered };
	}

	/**
	 * PRD-079b (b-AC-3): fire an IMMEDIATE drain, single-flighted through the existing `draining`
	 * guard (a kick while a pass is in flight is a no-op; a kick otherwise runs exactly one pass). The
	 * recovery signal — a SUCCESSFUL capture append — reaches here so a recovered backend drains its
	 * backlog promptly instead of waiting for the 30s interval. FULLY FAIL-SOFT: the drain promise has
	 * no external awaiter, so a rejection here would become an unhandled rejection and (Node ≥15) kill
	 * the daemon; `drainDue` already swallows every fault, but the `.catch` is the belt-and-suspenders
	 * floor. A kick after `close()` (or while draining) is a silent no-op. Never throws.
	 */
	kick(): void {
		if (this.closed || this.draining) return;
		void this.drainDue().catch(() => {});
	}

	/**
	 * PRD-079b (b-AC-1): move a FAILED-this-pass row to terminal `dead` when it hit `maxAttempts` OR
	 * exceeded `maxAgeMs` in the outbox, and emit the secret-free `capture.outbox.dead_lettered` event
	 * (b-AC-2: attempt / ageMs / count only — never content, token, org, or workspace). Returns `true`
	 * when the row was dead-lettered (so the caller counts it), `false` to fall through to the normal
	 * backoff retry. FAIL-SOFT: a SQLite fault on the terminal UPDATE degrades to a no-op — the row
	 * stays pending for a later pass rather than escaping to the pass-level catch (b-AC-5).
	 */
	private deadLetter(lease: OutboxLease): boolean {
		const attempt = lease.attempts + 1;
		const createdMs = Date.parse(lease.createdAt);
		const ageMs = Number.isFinite(createdMs) ? this.clock.now() - createdMs : 0;
		const overAttempts = attempt >= this.maxAttempts;
		const overAge = ageMs >= this.maxAgeMs;
		if (!overAttempts && !overAge) return false;
		try {
			this.markDead(lease.id, attempt);
		} catch (err: unknown) {
			// A terminal-UPDATE fault must never abort the pass: leave the row pending for a later attempt.
			this.logger?.event("capture.outbox.drain_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
		this.logger?.event("capture.outbox.dead_lettered", { attempt, ageMs: Math.max(0, ageMs), count: 1 });
		return true;
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

	/**
	 * PRD-079c (c-AC-2): coalesce the leased due rows into groups keyed by scope + column signature. A
	 * corrupt persisted row (fails schema re-parse) can never be replayed, so it is DELETED here and
	 * excluded from every group (never poisons a batch). Each surviving group carries members sharing the
	 * SAME scope AND the SAME ordered column names, so one {@link reappendMany} lands them in one append
	 * and `buildInsertMany`'s same-columns assertion always holds. Rows preserve their lease (attempts +
	 * createdAt) so a failed group backs off / dead-letters each member independently.
	 */
	private groupDue(due: readonly OutboxLease[]): OutboxGroup[] {
		const groups = new Map<string, OutboxGroup>();
		for (const lease of due) {
			const row = this.parseRow(lease.rowJson);
			if (row === null) {
				// A corrupt persisted row can never be replayed — remove it so it does not poison the pass.
				this.deleteRow(lease.id);
				this.logger?.event("capture.outbox.drain_failed", { reason: "corrupt_row" });
				continue;
			}
			const scope: QueryScope =
				lease.workspace.length > 0 ? { org: lease.org, workspace: lease.workspace } : { org: lease.org };
			const key = groupKey(lease.org, lease.workspace, row);
			const existing = groups.get(key);
			if (existing === undefined) {
				groups.set(key, { scope, members: [{ lease, row }] });
			} else {
				existing.members.push({ lease, row });
			}
		}
		return [...groups.values()];
	}

	/**
	 * Re-append a coalesced GROUP of same-scope/same-shape rows on the WRITE client with the SAME
	 * single-attempt capture opts, in ONE multi-row append (c-AC-2). A THROW from the append (not just a
	 * non-ok result) is caught and reported as `false` so the group becomes a NORMAL failed attempt in
	 * {@link drainDue} (each member: attempts+1 + pushBackoff + `retry`, or dead-letter) — never an escape
	 * to the pass-level catch, which would skip the members' backoff and let the next pass re-lease them
	 * immediately and hot-loop the write client (a-AC-3 / D-4).
	 */
	private async reappendMany(scope: QueryScope, rows: readonly RowValues[]): Promise<boolean> {
		try {
			const result = await appendOnlyInsertMany(this.storage, this.sessionsTarget, scope, rows, CAPTURE_WRITE_OPTS);
			return isOk(result);
		} catch {
			return false;
		}
	}

	/**
	 * Lease the due ACTIVE rows (`status = pending AND next_attempt_at <= now`), oldest-first, bounded
	 * to {@link maxDrainPerInterval} — PRD-079c (c-AC-3): the SINGLE authoritative per-pass attempt cap
	 * (it replaced the 079a `drainBatch`), so a huge backlog attempts at most this many rows and the rest
	 * stay due for the next pass. Skips future rows (a-AC-3) AND terminal `dead` rows (the status filter,
	 * so a dead-lettered row is NEVER re-leased — b-AC-1). `created_at` is carried so the drainer can
	 * compute the row's age for the `maxAgeMs` dead-letter check ({@link deadLetter}).
	 */
	private leaseDue(nowIso: string): OutboxLease[] {
		const rows = this.db
			.prepare(
				`SELECT ${sqlIdent("id")}, ${sqlIdent("org")}, ${sqlIdent("workspace")}, ${sqlIdent("row_json")}, ` +
					`${sqlIdent("attempts")}, ${sqlIdent("created_at")} FROM ${sqlIdent(CAPTURE_OUTBOX_TABLE)} ` +
					`WHERE ${sqlIdent("status")} = ? AND ${sqlIdent("next_attempt_at")} <= ? ` +
					`ORDER BY ${sqlIdent("next_attempt_at")} ASC, ${sqlIdent("created_at")} ASC LIMIT ?`,
			)
			.all(CAPTURE_OUTBOX_PENDING, nowIso, this.maxDrainPerInterval);
		return rows.map((row) => ({
			id: stringField(row, "id"),
			org: stringField(row, "org"),
			workspace: stringField(row, "workspace"),
			rowJson: stringField(row, "row_json"),
			attempts: numberField(row, "attempts"),
			createdAt: stringField(row, "created_at"),
		}));
	}

	private deleteRow(id: string): void {
		this.db.prepare(`DELETE FROM ${sqlIdent(CAPTURE_OUTBOX_TABLE)} WHERE ${sqlIdent("id")} = ?`).run(id);
	}

	/**
	 * PRD-079b (b-AC-1): move a row to terminal `dead` (retained, never deleted). The row keeps its
	 * final `attempts` so a forensic read sees how many re-appends it survived, and {@link leaseDue}'s
	 * `status = pending` filter guarantees it is never leased again.
	 */
	private markDead(id: string, attempt: number): void {
		this.db
			.prepare(
				`UPDATE ${sqlIdent(CAPTURE_OUTBOX_TABLE)} SET ${sqlIdent("attempts")} = ?, ` +
					`${sqlIdent("status")} = ? WHERE ${sqlIdent("id")} = ?`,
			)
			.run(attempt, CAPTURE_OUTBOX_DEAD, id);
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
	/** ISO `created_at`, so the drainer can compute the row's age for the `maxAgeMs` dead-letter check (b-AC-1). */
	readonly createdAt: string;
}

/** PRD-079c (c-AC-2): one leased row paired with its parsed {@link RowValues}, a member of a coalesced group. */
interface OutboxGroupMember {
	readonly lease: OutboxLease;
	readonly row: RowValues;
}

/** PRD-079c (c-AC-2): a coalesced drain group — same scope + same column signature, appended in ONE statement. */
interface OutboxGroup {
	readonly scope: QueryScope;
	readonly members: OutboxGroupMember[];
}

/**
 * PRD-079c (c-AC-2): the coalescing key — scope (org + workspace) AND the ordered column-name signature of
 * the row. Two rows share a key ONLY when they can be safely fused into one multi-row `appendOnlyInsertMany`
 * (same scope, identical columns in identical order), so `buildInsertMany`'s same-columns assertion never
 * rejects a group. A NUL separator (unprintable) cannot appear in an org/workspace slug or a
 * `sessions` column name, so the join is unambiguous — no two distinct triples collide, none splits.
 */
function groupKey(org: string, workspace: string, row: RowValues): string {
	const signature = row.map(([name]) => name).join("\u0000");
	return `${org}\u0000${workspace}\u0000${signature}`;
}

/** Normalize a SQLite `run()` change count (`number | bigint`) into a plain number (c-AC-1 shed count). */
function changeCount(result: { readonly changes: number | bigint }): number {
	return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
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
