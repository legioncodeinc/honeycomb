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
 * The durable CONTROLLED-WRITE outbox — PRD-080a (a-AC-1 .. a-AC-7) + PRD-080b (b-AC-1 .. b-AC-3).
 *
 * ── Why this exists (BUG-04b: distilled memories lost to a degraded window) ──
 * The `memory_controlled_write` stage commits a distilled fact in two DeepLake steps — a dedup probe
 * then a version-bumped INSERT (`controlled-writes.ts`). During a hosted-backend degraded/flapping
 * window (5xx / 429 / timeout / connection reset) either step returns a non-ok result; the stage
 * CORRECTLY throws on a genuine failure (the safety invariant — never an unguarded duplicate insert),
 * but that throw failed the job, which retried 5× and was then DROPPED — the distilled memory gone
 * (measured live: 101 dropped jobs). This outbox is the write-side twin of PRD-079's capture outbox,
 * for the memory-formation commit: on a TRANSIENT commit failure the RESOLVED write is PERSISTED here
 * (instead of thrown-and-dropped) and a background drainer re-executes the commit on the dedicated
 * WRITE client once the backend recovers. Over a degraded window + recovery `memoryCount` ends COMPLETE.
 *
 * ── Substrate (D-1): a sibling table inside the SAME local-queue.db file ─────
 * A dedicated `memory_outbox` table beside `capture_outbox` in the home-anchored `local-queue.db`,
 * reusing the PRD-066 open/migrate + trusted-root helpers (`local-job-queue.ts`) — NOT a reuse of
 * `capture_outbox` (a capture row is a `sessions` append; a controlled write is a version-bumped
 * `memories` commit WITH a dedup gate — different replay logic). Home-anchored on {@link honeycombStateDir}
 * (via the injected `baseDir`), so a queued write survives a daemon restart and drains on the next boot.
 *
 * ── Store the resolved write, replay the COMMIT — not the decision (D-3) ─────
 * A row persists `{ action, keyId, row_json (RowValues), org, workspace }`. The drainer rebuilds the
 * {@link ResolvedControlledWrite} and re-executes {@link commitControlledWrite} — the SAME durable
 * commit the live stage runs (dedup-probe-then-append for an ADD; version-bump for UPDATE/DELETE). So
 * replay is IDEMPOTENT for free (D-4): an ADD a prior attempt already landed is `deduped` (the
 * `content_hash` guarantees no duplicate `memories` row); the extraction/decision is NEVER re-run.
 *
 * ── Fail-soft everywhere (a-AC-6) ────────────────────────────────────────────
 * An enqueue or drain fault (SQLite error, disk full, a corrupt persisted row) NEVER breaks the
 * pipeline stage and NEVER surfaces as an unhandled rejection — it is logged secret-free
 * (`memory.outbox.enqueue_failed` / `drain_failed`) and counted. The drainer runs on an unref'd
 * interval (so it never keeps the process alive). On an enqueue fault the STAGE falls back to the
 * pre-080 throw (the write is not silently lost-and-forgotten) — see `deferOrThrow` in controlled-writes.
 *
 * ── Dead-letter + recovery kick (PRD-080b) ───────────────────────────────────
 * b-AC-1: a row that reaches `maxAttempts` (default 10) failed re-commits OR exceeds `maxAgeMs`
 * (default 24h, both env-overridable via `HONEYCOMB_MEMORY_OUTBOX_MAX_ATTEMPTS`/`_MAX_AGE_MS` resolved at
 * the composition root by {@link resolveMemoryOutboxLimits}) moves to terminal `dead` — RETAINED, never
 * re-leased ({@link SqliteMemoryOutbox.leaseDue} filters `status = pending`), so a permanently-failing
 * write stops consuming write slots and stops growing the active backlog (bounded growth, never a silent
 * vanish). b-AC-3: {@link SqliteMemoryOutbox.kick} fires an IMMEDIATE single-flighted drain on the
 * "backend recovered" signal — a SUCCESSFUL pipeline `memories` commit (controlled-writes) and/or a
 * `deeplake.woke` transition (assemble hibernation resume) — so a degraded-window backlog clears promptly
 * instead of waiting for the 30s interval. Both mirror the capture outbox's `dead`/`kick` twin exactly.
 *
 * ── Observability (a-AC-7 / b-AC-2) — secret-free by construction ─────────────
 * `counts()` feeds the `/health` `memoryOutbox { pending, retrying, deadLettered }` field, and the drainer
 * emits `memory.outbox.{enqueued,drained,retry,dead_lettered}` events carrying ONLY counts / durations /
 * attempt numbers / ageMs — NEVER memory content, a `content_hash`, query text, an org, or a workspace
 * string (PR #293's redaction lesson: a DeepLake error body can echo the hash, so the drainer surfaces no
 * error text at all).
 */

import { mkdirSync } from "node:fs";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { sqlIdent } from "../../storage/sql.js";
import type { RowValues } from "../../storage/writes.js";
import { clampIntKnob, type OutboxClock, OutboxRowValuesSchema, realOutboxClock } from "../capture/capture-outbox.js";
import {
	loadSqlite,
	localQueueDaemonDir,
	localQueueDatabasePath,
	numberField,
	type SqliteDatabase,
	stringField,
} from "../services/local-job-queue.js";
import {
	commitControlledWrite,
	commitControlledWriteMany,
	type ControlledWriteCommitManyResult,
	memoryRowContentHash,
	type ResolvedControlledWrite,
	type ResolvedWriteAction,
} from "./controlled-writes.js";

/** The dedicated outbox table living beside `capture_outbox` inside the SAME `local-queue.db` file (D-1). */
export const MEMORY_OUTBOX_TABLE = "memory_outbox" as const;
/** The ACTIVE status a queued outbox row carries: it is due for (or between) drain attempts. */
export const MEMORY_OUTBOX_PENDING = "pending" as const;
/**
 * PRD-080b (b-AC-1): the TERMINAL dead-letter status. A row that reaches `maxAttempts` failed
 * re-commits OR exceeds `maxAgeMs` in the outbox is moved here — the row is RETAINED (never deleted,
 * never re-leased: {@link SqliteMemoryOutbox.leaseDue} filters `status = pending`), so it stops
 * consuming write slots and stops growing the active backlog. Bounded growth, never a silent vanish.
 * (Mirrors `capture_outbox`'s `dead` status exactly — the write-side twin.)
 */
export const MEMORY_OUTBOX_DEAD = "dead" as const;

/** How often the background drainer re-attempts due rows (unref'd interval). Off the hot path. */
export const DEFAULT_MEMORY_OUTBOX_DRAIN_INTERVAL_MS = 30_000;
/** Bounded exponential backoff BASE between drain attempts for one row (a-AC-4). */
export const DEFAULT_MEMORY_OUTBOX_BACKOFF_BASE_MS = 5_000;
/** Bounded exponential backoff CAP so a persistent degraded window can never hot-loop the write client (a-AC-4). */
export const DEFAULT_MEMORY_OUTBOX_BACKOFF_CAP_MS = 5 * 60 * 1_000;
/**
 * PRD-080c (c-AC-3): the AUTHORITATIVE per-pass attempt cap. One {@link SqliteMemoryOutbox.drainDue} pass
 * leases (and therefore attempts) at MOST this many rows, so a huge backlog drains at a bounded rate rather
 * than bursting the write client's `Semaphore(3)`; the remainder is left due for the next pass. Default 200.
 */
export const DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL = 200;
/**
 * @deprecated PRD-080c UNIFIED the per-pass lease cap under ONE authoritative name. The 080a "max drain
 * per pass" and this phase's back-pressure knob are the same concept — how many rows a single pass may
 * attempt — so {@link DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL} is now the single source of truth and
 * this alias points at it. Retained only so a pre-080c import does not break; prefer the interval constant.
 */
export const DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_PASS = DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL;
/**
 * PRD-080c (c-AC-1): the ACTIVE-backlog row-count cap. When an enqueue would push the `pending` backlog
 * over this, the OLDEST pending rows are shed oldest-first (a secret-free `memory.outbox.shed` event, never
 * a silent truncation). `dead` rows are terminal and do NOT count toward this cap. Default 10,000.
 */
export const DEFAULT_MEMORY_OUTBOX_MAX_ROWS = 10_000;

/** PRD-080b (b-AC-1): failed re-commits after which a row dead-letters (`pending → dead`). */
export const DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS = 10;
/** PRD-080b (b-AC-1): age in the outbox after which a row dead-letters on its next failed attempt (24h). */
export const DEFAULT_MEMORY_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** The kill-switch env flag (default ON) — mirrors `HONEYCOMB_CAPTURE_OUTBOX`'s opt-out posture. */
export const MEMORY_OUTBOX_ENV = "HONEYCOMB_MEMORY_OUTBOX" as const;
/** PRD-080b (b-AC-1): env override for the dead-letter attempt bound (`HONEYCOMB_MEMORY_OUTBOX_MAX_ATTEMPTS`). */
export const MEMORY_OUTBOX_MAX_ATTEMPTS_ENV = "HONEYCOMB_MEMORY_OUTBOX_MAX_ATTEMPTS" as const;
/** PRD-080b (b-AC-1): env override for the dead-letter age bound in ms (`HONEYCOMB_MEMORY_OUTBOX_MAX_AGE_MS`). */
export const MEMORY_OUTBOX_MAX_AGE_MS_ENV = "HONEYCOMB_MEMORY_OUTBOX_MAX_AGE_MS" as const;
/** PRD-080c (c-AC-1): env override for the active-backlog row cap (`HONEYCOMB_MEMORY_OUTBOX_MAX_ROWS`). */
export const MEMORY_OUTBOX_MAX_ROWS_ENV = "HONEYCOMB_MEMORY_OUTBOX_MAX_ROWS" as const;
/** PRD-080c (c-AC-3): env override for the per-pass back-pressure cap (`HONEYCOMB_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL`). */
export const MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL_ENV = "HONEYCOMB_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL" as const;

/** The resolved dead-letter bounds — {@link resolveMemoryOutboxLimits}'s output, passed to {@link openMemoryOutbox}. */
export interface MemoryOutboxLimits {
	/** Failed re-commits after which a row dead-letters (min 1). */
	readonly maxAttempts: number;
	/** Age in the outbox (ms) after which a row dead-letters on its next failed attempt (min 1). */
	readonly maxAgeMs: number;
	/** PRD-080c (c-AC-1): active-backlog (`pending`) row cap; over it, oldest pending rows are shed (min 1). */
	readonly maxRows: number;
	/** PRD-080c (c-AC-3): per-pass back-pressure cap — rows one drain pass will lease/attempt (min 1). */
	readonly maxDrainPerInterval: number;
}

/**
 * Resolve the dead-letter bounds from the environment (b-AC-1), mirroring
 * {@link import("../capture/capture-outbox.js").resolveCaptureOutboxLimits}: documented defaults
 * ({@link DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS} / {@link DEFAULT_MEMORY_OUTBOX_MAX_AGE_MS}), env-overridable
 * via `HONEYCOMB_MEMORY_OUTBOX_MAX_ATTEMPTS` / `HONEYCOMB_MEMORY_OUTBOX_MAX_AGE_MS`, coerce-and-clamp via
 * the SHARED {@link clampIntKnob} (a non-numeric or sub-1 value falls back / clamps up, never throws).
 * Called ONCE at the composition root (assemble) and threaded into {@link openMemoryOutbox}, so a
 * hot-path module never reads env.
 */
export function resolveMemoryOutboxLimits(env: NodeJS.ProcessEnv = process.env): MemoryOutboxLimits {
	return {
		maxAttempts: clampIntKnob(env[MEMORY_OUTBOX_MAX_ATTEMPTS_ENV], DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS, 1),
		maxAgeMs: clampIntKnob(env[MEMORY_OUTBOX_MAX_AGE_MS_ENV], DEFAULT_MEMORY_OUTBOX_MAX_AGE_MS, 1),
		// PRD-080c (c-AC-1 / c-AC-3): the scale bounds, same coerce-and-clamp posture (a typo is tuning
		// noise, never a boot failure) — the active-backlog cap and the per-pass back-pressure knob.
		maxRows: clampIntKnob(env[MEMORY_OUTBOX_MAX_ROWS_ENV], DEFAULT_MEMORY_OUTBOX_MAX_ROWS, 1),
		maxDrainPerInterval: clampIntKnob(
			env[MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL_ENV],
			DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL,
			1,
		),
	};
}

/** The outbox backlog snapshot surfaced on `/health` (a-AC-7 / b-AC-2). Carries counts only — no secret. */
export interface MemoryOutboxCounts {
	/** ACTIVE rows still queued for a durable re-commit (`status = pending`); EXCLUDES terminal `dead`. */
	readonly pending: number;
	/** The active subset that has already failed at least one drain attempt (`attempts > 0`, `status = pending`). */
	readonly retrying: number;
	/** PRD-080b (b-AC-2): TERMINAL dead-lettered rows (`status = dead`) — retained, not re-leased, not active. */
	readonly deadLettered: number;
}

/** Outcome of an {@link MemoryOutboxSink.enqueue} — never throws; reports what became durable vs truly lost. */
export interface MemoryOutboxEnqueueResult {
	/** The write is now durably persisted (1), including an idempotent no-op on a re-enqueue of the same id. */
	readonly enqueued: number;
	/** The write could NOT be persisted (a SQLite fault) — the caller falls back to the pre-080 throw (a-AC-6). */
	readonly dropped: number;
}

/** Outcome of one {@link MemoryOutbox.drainDue} pass — counts only. */
export interface MemoryOutboxDrainResult {
	/** Rows re-committed OK (or deduped) and deleted from the outbox this pass. */
	readonly drained: number;
	/** Rows whose re-commit failed this pass and stayed pending (attempts bumped + `next_attempt_at` pushed out). */
	readonly retried: number;
	/** PRD-080b (b-AC-1): rows moved to terminal `dead` this pass (hit `maxAttempts` OR exceeded `maxAgeMs`). */
	readonly deadLettered: number;
}

/** The NARROW surface the controlled-write stage needs: persist a transient-failed resolved write + kick a recovery drain, never throw. */
export interface MemoryOutboxSink {
	/**
	 * Persist one resolved controlled write under its deterministic memory id (`INSERT OR IGNORE`, so a
	 * re-enqueue of the same id never duplicates — a-AC-3). FAIL-SOFT: never throws — a SQLite/disk fault
	 * is caught, logged (`memory.outbox.enqueue_failed`), and reported as `dropped` so the caller falls
	 * back to the pre-080 throw (a-AC-6).
	 */
	enqueue(write: ResolvedControlledWrite): MemoryOutboxEnqueueResult;
	/**
	 * PRD-080b (b-AC-3): the RECOVERY-TRIGGERED drain kick. A SUCCESSFUL pipeline `memories` commit is the
	 * "backend recovered" signal — the controlled-write stage calls this to drain the backlog IMMEDIATELY
	 * instead of waiting for the 30s interval. Single-flighted against the existing drain guard (a kick
	 * while a drain is in flight is a no-op) and FULLY FAIL-SOFT (never throws, never blocks the stage).
	 * OPTIONAL on the sink so a pre-080b test stub need not implement it (mirrors `CaptureOutboxSink.kick`).
	 */
	kick?(): void;
}

/** The full outbox: the enqueue sink + the background drainer + its lifecycle. */
export interface MemoryOutbox extends MemoryOutboxSink {
	/** The `{ pending, retrying, deadLettered }` backlog snapshot for `/health` (a-AC-7 / b-AC-2). */
	counts(): MemoryOutboxCounts;
	/**
	 * Run ONE drain pass: lease due rows (`next_attempt_at <= now`, skipping not-yet-due rows — a-AC-4),
	 * re-execute {@link commitControlledWrite} on the injected WRITE client; on commit (or dedup) delete
	 * the row, else bump `attempts` and push `next_attempt_at` by the bounded backoff, UNLESS the row hit
	 * `maxAttempts` OR exceeded `maxAgeMs` — then move it to terminal `dead` (b-AC-1). FAIL-SOFT: never throws.
	 */
	drainDue(): Promise<MemoryOutboxDrainResult>;
	/** PRD-080b (b-AC-3): fire an immediate single-flighted drain (recovery kick). Fail-soft, never throws. */
	kick(): void;
	/** Arm the unref'd drain interval (idempotent). */
	start(): void;
	/** Cancel the drain interval (idempotent). */
	stop(): void;
	/** Stop the drainer + close the SQLite handle (idempotent, never throws). */
	close(): void;
}

/** Tuning for the drainer's bounded exponential backoff (a-AC-4). Both optional; each falls back to its default. */
export interface MemoryOutboxBackoff {
	/** First-retry delay in ms (default {@link DEFAULT_MEMORY_OUTBOX_BACKOFF_BASE_MS}). */
	readonly baseMs?: number;
	/** Backoff ceiling in ms (default {@link DEFAULT_MEMORY_OUTBOX_BACKOFF_CAP_MS}). */
	readonly capMs?: number;
}

/** A minimal structured-log sink (matches the pipeline logger's `event` shape). Secret-free events only. */
export interface MemoryOutboxLogger {
	/** Record a SECRET-FREE structured event (e.g. `memory.outbox.drained`). */
	event(name: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Construction options for {@link openMemoryOutbox}. Everything is injected for testability. */
export interface OpenMemoryOutboxOptions {
	/**
	 * The dedicated WRITE `StorageQuery` the drainer re-commits on (PRD-077 B2 `Semaphore(3)`), so a
	 * backlog drain never consumes a read slot and starves recall.
	 */
	readonly storage: StorageQuery;
	/** The home-anchored base dir ({@link honeycombStateDir} in production); the db lives at `<baseDir>/.daemon/local-queue.db`. */
	readonly baseDir?: string;
	/** Open an in-memory db (tests) instead of the on-disk file. */
	readonly memory?: boolean;
	/** Injected clock/timer seam (tests). Defaults to {@link realOutboxClock}. */
	readonly clock?: OutboxClock;
	/** Secret-free structured-log sink for the `memory.outbox.*` events. */
	readonly logger?: MemoryOutboxLogger;
	/**
	 * W-1: fired once per DRAIN-RECOVERED commit (`inserted`/`version_bumped`/`deduped`) with the memory's
	 * `id` + action, so a memory recovered from a degraded window feeds the SAME `MemoryFormationTracker`
	 * `committedSinceBoot` signal the live stage feeds (BUG-04's Verify criteria). Wired at the composition
	 * root to `memoryFormation.record`. Called fail-soft ({@link SqliteMemoryOutbox.recordCommitted} wraps
	 * it), so a tracker throw NEVER breaks the drain. Absent in unit stubs → a no-op.
	 */
	readonly onCommitted?: (memoryId: string, action: string) => void;
	/** Drain interval in ms (default {@link DEFAULT_MEMORY_OUTBOX_DRAIN_INTERVAL_MS}). */
	readonly drainIntervalMs?: number;
	/** Bounded exponential backoff tuning (a-AC-4). */
	readonly backoff?: MemoryOutboxBackoff;
	/**
	 * PRD-080c (c-AC-3): the per-pass back-pressure cap — the max rows one drain pass leases/attempts
	 * (default {@link DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL}, clamped ≥ 1). This is the SINGLE
	 * authoritative per-pass lease cap (it unified the 080a "max drain per pass"), so a huge backlog drains
	 * at a bounded rate and the remainder stays due for the next pass. Resolved at the composition root via
	 * {@link resolveMemoryOutboxLimits}.
	 */
	readonly maxDrainPerInterval?: number;
	/**
	 * PRD-080c (c-AC-1): the ACTIVE-backlog (`pending`) row cap (default {@link DEFAULT_MEMORY_OUTBOX_MAX_ROWS},
	 * clamped ≥ 1). When an enqueue pushes `pending` over this, the oldest pending rows are shed oldest-first
	 * with a secret-free `memory.outbox.shed` event; `dead` rows never count toward it. Resolved at the
	 * composition root via {@link resolveMemoryOutboxLimits}.
	 */
	readonly maxRows?: number;
	/**
	 * PRD-080b (b-AC-1): failed re-commits after which a row dead-letters (default
	 * {@link DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS}, clamped ≥ 1). Resolved at the composition root via
	 * {@link resolveMemoryOutboxLimits} (env `HONEYCOMB_MEMORY_OUTBOX_MAX_ATTEMPTS`).
	 */
	readonly maxAttempts?: number;
	/**
	 * PRD-080b (b-AC-1): age in the outbox (ms) after which a row dead-letters on its next failed attempt
	 * (default {@link DEFAULT_MEMORY_OUTBOX_MAX_AGE_MS}, clamped ≥ 1). Resolved at the composition root via
	 * {@link resolveMemoryOutboxLimits} (env `HONEYCOMB_MEMORY_OUTBOX_MAX_AGE_MS`).
	 */
	readonly maxAgeMs?: number;
}

/** The persisted action set — a corrupt/unknown `action` column excludes the row from replay (a-AC-5). */
const RESOLVED_ACTIONS: ReadonlySet<string> = new Set<ResolvedWriteAction>(["add", "update", "delete"]);

/**
 * Open (or create) the memory outbox over the `memory_outbox` table in the home-anchored
 * `local-queue.db`. FAIL-SOFT at construction: any open/migrate failure degrades to the
 * {@link NULL_MEMORY_OUTBOX} no-op so a broken SQLite substrate NEVER breaks the pipeline — a transient
 * commit failure then falls back to the pre-080 throw (never a construction-time crash at the root).
 */
export function openMemoryOutbox(options: OpenMemoryOutboxOptions): MemoryOutbox {
	try {
		const db = openOutboxDatabase(options);
		migrate(db);
		return new SqliteMemoryOutbox(db, options);
	} catch (err: unknown) {
		options.logger?.event("memory.outbox.open_failed", { reason: err instanceof Error ? err.message : String(err) });
		return NULL_MEMORY_OUTBOX;
	}
}

/** The inert outbox used when the substrate cannot open — the stage stays fail-soft (throws as pre-080). */
export const NULL_MEMORY_OUTBOX: MemoryOutbox = Object.freeze({
	enqueue(): MemoryOutboxEnqueueResult {
		// No durable store → nothing persisted; the caller falls back to the pre-080 throw.
		return { enqueued: 0, dropped: 1 };
	},
	counts(): MemoryOutboxCounts {
		return { pending: 0, retrying: 0, deadLettered: 0 };
	},
	async drainDue(): Promise<MemoryOutboxDrainResult> {
		return { drained: 0, retried: 0, deadLettered: 0 };
	},
	kick(): void {},
	start(): void {},
	stop(): void {},
	close(): void {},
});

function openOutboxDatabase(options: OpenMemoryOutboxOptions): SqliteDatabase {
	const sqlite = loadSqlite();
	if (options.memory === true) return new sqlite.DatabaseSync(":memory:");
	// Reuse the local-queue trusted-root guard + path resolution (D-1): the outbox rides the SAME
	// home-anchored `.daemon/local-queue.db` file, so it inherits the exact durability + traversal safety.
	const dir = localQueueDaemonDir(options.baseDir);
	const dbPath = localQueueDatabasePath(dir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return new sqlite.DatabaseSync(dbPath);
}

function migrate(db: SqliteDatabase): void {
	const tbl = sqlIdent(MEMORY_OUTBOX_TABLE);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${tbl} (` +
			`${sqlIdent("id")} TEXT PRIMARY KEY, ` +
			`${sqlIdent("org")} TEXT NOT NULL, ` +
			`${sqlIdent("workspace")} TEXT NOT NULL, ` +
			`${sqlIdent("action")} TEXT NOT NULL, ` +
			`${sqlIdent("row_json")} TEXT NOT NULL, ` +
			`${sqlIdent("attempts")} INTEGER NOT NULL DEFAULT 0, ` +
			`${sqlIdent("next_attempt_at")} TEXT NOT NULL, ` +
			`${sqlIdent("created_at")} TEXT NOT NULL, ` +
			`${sqlIdent("status")} TEXT NOT NULL)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS ${sqlIdent("idx_memory_outbox_due")} ON ${tbl} (` +
			`${sqlIdent("status")}, ${sqlIdent("next_attempt_at")})`,
	);
}

class SqliteMemoryOutbox implements MemoryOutbox {
	private readonly db: SqliteDatabase;
	private readonly storage: StorageQuery;
	private readonly clock: OutboxClock;
	private readonly logger: MemoryOutboxLogger | undefined;
	private readonly onCommitted: ((memoryId: string, action: string) => void) | undefined;
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

	constructor(db: SqliteDatabase, options: OpenMemoryOutboxOptions) {
		this.db = db;
		this.storage = options.storage;
		this.clock = options.clock ?? realOutboxClock;
		this.logger = options.logger;
		this.onCommitted = options.onCommitted;
		this.drainIntervalMs = Math.max(1, options.drainIntervalMs ?? DEFAULT_MEMORY_OUTBOX_DRAIN_INTERVAL_MS);
		this.backoffBaseMs = Math.max(1, options.backoff?.baseMs ?? DEFAULT_MEMORY_OUTBOX_BACKOFF_BASE_MS);
		this.backoffCapMs = Math.max(this.backoffBaseMs, options.backoff?.capMs ?? DEFAULT_MEMORY_OUTBOX_BACKOFF_CAP_MS);
		// PRD-080c (c-AC-3): the unified per-pass back-pressure cap (was `maxDrainPerPass`), clamped ≥ 1.
		this.maxDrainPerInterval = Math.max(
			1,
			Math.trunc(options.maxDrainPerInterval ?? DEFAULT_MEMORY_OUTBOX_MAX_DRAIN_PER_INTERVAL),
		);
		// PRD-080b (b-AC-1): the dead-letter bounds (clamped ≥ 1 belt-and-suspenders even though the
		// composition-root resolver already clamped; a direct-construction test may pass a raw value).
		this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS));
		this.maxAgeMs = Math.max(1, Math.trunc(options.maxAgeMs ?? DEFAULT_MEMORY_OUTBOX_MAX_AGE_MS));
		// PRD-080c (c-AC-1): the active-backlog row cap, clamped ≥ 1.
		this.maxRows = Math.max(1, Math.trunc(options.maxRows ?? DEFAULT_MEMORY_OUTBOX_MAX_ROWS));
	}

	enqueue(write: ResolvedControlledWrite): MemoryOutboxEnqueueResult {
		if (this.closed) return { enqueued: 0, dropped: 1 };
		const id = write.keyId;
		if (id.length === 0) return { enqueued: 0, dropped: 1 }; // no id → cannot idempotently replay.
		const nowIso = this.nowIso();
		try {
			this.db
				.prepare(
					`INSERT OR IGNORE INTO ${sqlIdent(MEMORY_OUTBOX_TABLE)} (` +
						`${sqlIdent("id")}, ${sqlIdent("org")}, ${sqlIdent("workspace")}, ${sqlIdent("action")}, ` +
						`${sqlIdent("row_json")}, ${sqlIdent("attempts")}, ${sqlIdent("next_attempt_at")}, ` +
						`${sqlIdent("created_at")}, ${sqlIdent("status")}) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
				)
				.run(
					id,
					write.scope.org,
					write.scope.workspace ?? "",
					write.action,
					JSON.stringify(write.row),
					nowIso,
					nowIso,
					MEMORY_OUTBOX_PENDING,
				);
		} catch (err: unknown) {
			// Fail-soft (a-AC-6): a SQLite/disk fault must NEVER break the stage. Log secret-free + report
			// the write as dropped so the caller falls back to the pre-080 throw.
			this.logger?.event("memory.outbox.enqueue_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
			return { enqueued: 0, dropped: 1 };
		}
		this.logger?.event("memory.outbox.enqueued", { count: 1 });
		// PRD-080c (c-AC-1): enforce the active-backlog cap AFTER persisting the new row, so the
		// just-enqueued (newest) row is retained and the OLDEST pending rows are shed to stay ≤ maxRows.
		// Fully isolated + fail-soft: a shed fault degrades to the pre-080c behavior (no shed) and never
		// touches the enqueue accounting the caller relies on (c-AC-4).
		this.shedToCap();
		return { enqueued: 1, dropped: 0 };
	}

	/**
	 * PRD-080c (c-AC-1): shed the OLDEST `pending` rows (oldest-first by `created_at`, then `id`) whenever
	 * the ACTIVE backlog exceeds {@link maxRows}, emitting a secret-free `memory.outbox.shed { count }` event
	 * — never a silent truncation. `dead` rows are terminal and EXCLUDED from the cap (the `status = pending`
	 * filter), so a dead-letter backlog neither counts nor is shed by this path. FAIL-SOFT: a SQLite fault
	 * degrades to a no-op (the pre-080c behavior) and never surfaces (c-AC-4).
	 */
	private shedToCap(): void {
		try {
			const tbl = sqlIdent(MEMORY_OUTBOX_TABLE);
			const countRow = this.db
				.prepare(`SELECT COUNT(*) AS ${sqlIdent("n")} FROM ${tbl} WHERE ${sqlIdent("status")} = ?`)
				.all(MEMORY_OUTBOX_PENDING)[0];
			const pending = countRow === undefined ? 0 : numberField(countRow, "n");
			const overflow = pending - this.maxRows;
			if (overflow <= 0) return;
			// Delete the oldest `overflow` pending rows in ONE targeted statement. A subquery bounds the shed
			// to exactly the pending overflow (oldest-first) — terminal `dead` rows are untouched.
			const shed = this.db
				.prepare(
					`DELETE FROM ${tbl} WHERE ${sqlIdent("id")} IN (` +
						`SELECT ${sqlIdent("id")} FROM ${tbl} WHERE ${sqlIdent("status")} = ? ` +
						`ORDER BY ${sqlIdent("created_at")} ASC, ${sqlIdent("id")} ASC LIMIT ?)`,
				)
				.run(MEMORY_OUTBOX_PENDING, overflow);
			const count = changeCount(shed);
			if (count > 0) this.logger?.event("memory.outbox.shed", { count });
		} catch (err: unknown) {
			// A shed fault must never break the pipeline: leave the backlog as-is for a later enqueue to re-shed.
			this.logger?.event("memory.outbox.shed_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	counts(): MemoryOutboxCounts {
		if (this.closed) return { pending: 0, retrying: 0, deadLettered: 0 };
		try {
			// PRD-080b (b-AC-2): partition in ONE pass. `pending`/`retrying` count ACTIVE rows
			// (`status = pending`) only; `deadLettered` counts terminal `dead` rows — a `dead` row is
			// NEVER active, so the two never overlap. Conditional SUMs so the partition is a single scan.
			const rows = this.db
				.prepare(
					`SELECT ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("status")} = ? THEN 1 ELSE 0 END), 0) AS ${sqlIdent("pending")}, ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("status")} = ? AND ${sqlIdent("attempts")} > 0 THEN 1 ELSE 0 END), 0) AS ${sqlIdent("retrying")}, ` +
						`COALESCE(SUM(CASE WHEN ${sqlIdent("status")} = ? THEN 1 ELSE 0 END), 0) AS ${sqlIdent("dead")} ` +
						`FROM ${sqlIdent(MEMORY_OUTBOX_TABLE)}`,
				)
				.all(MEMORY_OUTBOX_PENDING, MEMORY_OUTBOX_PENDING, MEMORY_OUTBOX_DEAD);
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

	async drainDue(): Promise<MemoryOutboxDrainResult> {
		// Single-flight: the timer, the recovery kick, and an explicit call must never lease the same
		// rows concurrently. A kick or timer tick while a pass is in flight is a no-op (b-AC-3).
		if (this.closed || this.draining) return { drained: 0, retried: 0, deadLettered: 0 };
		this.draining = true;
		const startMs = this.clock.now();
		const tally: DrainTally = { drained: 0, retried: 0, deadLettered: 0 };
		try {
			// PRD-080c (c-AC-2): COALESCE the due rows into groups that share scope + action + column
			// signature. A group of ≥2 DISTINCT-hash ADD rows drains through ONE batched dedup probe + ONE
			// multi-row version-bumped append ({@link commitControlledWriteMany}) — PRESERVING the
			// content_hash dedup (no duplicate `memories` row). Everything else (a singleton, an UPDATE/DELETE
			// version-bump — non-idempotent + per-key MAX, so NOT safe to coalesce — or an in-group
			// duplicate-hash ADD) stays on the per-row dedup-probe-then-append path. Either way a failed group
			// backs off / dead-letters EACH member INDEPENDENTLY (no write lost or double-committed).
			for (const group of this.groupDue(this.leaseDue(this.nowIso()))) {
				if (isCoalescibleAddGroup(group)) {
					await this.drainAddGroup(group, tally);
				} else {
					for (const member of group.members) await this.drainOne(group.scope, member, tally);
				}
			}
		} catch (err: unknown) {
			// Fail-soft: a drain fault never surfaces. Rows stay queued for the next pass.
			this.logger?.event("memory.outbox.drain_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.draining = false;
		}
		if (tally.drained > 0) {
			this.logger?.event("memory.outbox.drained", { count: tally.drained, durationMs: this.clock.now() - startMs });
		}
		return { drained: tally.drained, retried: tally.retried, deadLettered: tally.deadLettered };
	}

	/**
	 * PRD-080c (c-AC-2): drain a COALESCED group of same-scope, distinct-hash ADD rows in ONE batched dedup
	 * probe + ONE multi-row append via {@link commitControlledWriteMany}. Each returned committed member
	 * (LANDED or already-present dedup hit — idempotent, NO duplicate) is deleted + counted `drained` AND
	 * recorded to the memory-formation tracker (W-1) with its honest action; each `failed` keyId backs off /
	 * dead-letters INDEPENDENTLY via {@link settleFailure}, exactly as the per-row path would. FAIL-SOFT:
	 * `commitControlledWriteMany` never throws by contract, but a throw is caught and treated as a whole-group
	 * failed attempt (every member backs off) — never a pass abort.
	 */
	private async drainAddGroup(group: OutboxGroup, tally: DrainTally): Promise<void> {
		const writes = group.members.map((m) => toResolved(group.scope, m));
		let result: ControlledWriteCommitManyResult;
		try {
			result = await commitControlledWriteMany(this.storage, writes);
		} catch {
			result = { committed: [], failed: writes.map((w) => w.keyId) };
		}
		const leaseById = new Map(group.members.map((m) => [m.lease.id, m.lease] as const));
		for (const member of result.committed) {
			this.deleteRow(member.keyId);
			tally.drained += 1;
			// W-1: a drain-recovered commit counts toward `committedSinceBoot`, per committed/deduped member.
			this.recordCommitted(member.keyId, member.action);
		}
		for (const id of result.failed) {
			const lease = leaseById.get(id);
			if (lease !== undefined) this.settleFailure(lease, tally);
		}
	}

	/**
	 * Re-execute ONE member's commit on the WRITE client via {@link commitControlledWrite} (the SAME durable
	 * commit the live stage runs — D-3). On a LANDED / already-present (`deduped`, idempotent — a-AC-3)
	 * outcome the row is deleted + counted `drained` AND recorded to the memory-formation tracker (W-1) with
	 * its honest commit action; any non-committing outcome (transient/genuine) or a THROW (a rejecting
	 * transport, caught here) backs the row off / dead-letters it via {@link settleFailure} — never a pass
	 * abort, never a hot-loop of the write client.
	 */
	private async drainOne(scope: QueryScope, member: OutboxGroupMember, tally: DrainTally): Promise<void> {
		let committedAction: string | null = null;
		try {
			const commit = await commitControlledWrite(this.storage, toResolved(scope, member));
			if (commit.status === "inserted" || commit.status === "version_bumped" || commit.status === "deduped") {
				committedAction = commit.status;
			}
		} catch {
			committedAction = null; // a throwing commit is a normal failed attempt (back it off), never a pass abort.
		}
		if (committedAction !== null) {
			this.deleteRow(member.lease.id);
			tally.drained += 1;
			// W-1: a drain-recovered commit counts toward `committedSinceBoot`, with its honest action.
			this.recordCommitted(member.lease.id, committedAction);
		} else {
			this.settleFailure(member.lease, tally);
		}
	}

	/**
	 * W-1: feed the injected memory-formation `onCommitted` hook so a memory RECOVERED by the drainer from a
	 * degraded window counts toward the SAME `committedSinceBoot` signal the live stage feeds — BUG-04's
	 * Verify criteria ("the counter climbs THROUGH the window"). FAIL-SOFT: a hook throw must NEVER break the
	 * drain (the write is already durable + deleted), so it is caught + logged secret-free (the `memoryId` is
	 * an opaque id, exactly what the live stage's tracker records — never content/hash/org/workspace).
	 */
	private recordCommitted(memoryId: string, action: string): void {
		if (this.onCommitted === undefined) return;
		try {
			this.onCommitted(memoryId, action);
		} catch (err: unknown) {
			this.logger?.event("memory.outbox.record_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Settle a FAILED-this-pass row (shared by the per-row {@link drainOne} and the coalesced
	 * {@link drainAddGroup} — c-AC-2's per-member independence): dead-letter it when it hit `maxAttempts` OR
	 * exceeded `maxAgeMs` (b-AC-1), else bump `attempts` + push `next_attempt_at` by the bounded backoff and
	 * emit the secret-free `memory.outbox.retry { attempt }` (a-AC-7).
	 */
	private settleFailure(lease: OutboxLease, tally: DrainTally): void {
		if (this.deadLetter(lease)) {
			tally.deadLettered += 1;
			return;
		}
		const attempt = lease.attempts + 1;
		this.pushBackoff(lease.id, attempt);
		tally.retried += 1;
		// Secret-free: attempt number only — no content, hash, org, or workspace (a-AC-7).
		this.logger?.event("memory.outbox.retry", { attempt });
	}

	/**
	 * PRD-080c (c-AC-2): coalesce the leased due rows into groups keyed by scope + action + column signature.
	 * A corrupt persisted row (fails schema re-parse) or an unknown-action row can never be replayed, so it
	 * is DELETED here and excluded from every group (never poisons the pass). Each surviving member carries
	 * its parsed row + its `content_hash` (for the ADD-coalesce eligibility + the batched dedup key), so a
	 * failed group backs off / dead-letters each member independently.
	 */
	private groupDue(due: readonly OutboxLease[]): OutboxGroup[] {
		const groups = new Map<string, OutboxGroup>();
		for (const lease of due) {
			const row = this.parseRow(lease.rowJson);
			if (row === null || !RESOLVED_ACTIONS.has(lease.action)) {
				// A corrupt / unknown-action persisted row can never be replayed — remove it so it never
				// poisons the pass, and count it as neither drained nor retried (mirrors the capture coalescer).
				this.deleteRow(lease.id);
				this.logger?.event("memory.outbox.drain_failed", { reason: "corrupt_row" });
				continue;
			}
			const scope: QueryScope =
				lease.workspace.length > 0 ? { org: lease.org, workspace: lease.workspace } : { org: lease.org };
			const member: OutboxGroupMember = { lease, row, hash: memoryRowContentHash(row) };
			const key = groupKey(lease.org, lease.workspace, lease.action, row);
			const existing = groups.get(key);
			if (existing === undefined) {
				groups.set(key, { action: lease.action as ResolvedWriteAction, scope, members: [member] });
			} else {
				existing.members.push(member);
			}
		}
		return [...groups.values()];
	}

	/**
	 * PRD-080b (b-AC-3): fire an IMMEDIATE drain, single-flighted through the existing `draining`
	 * guard (a kick while a pass is in flight is a no-op; a kick otherwise runs exactly one pass). The
	 * recovery signal — a SUCCESSFUL pipeline `memories` commit — reaches here so a recovered backend
	 * drains its backlog promptly instead of waiting for the 30s interval. FULLY FAIL-SOFT: the drain
	 * promise has no external awaiter, so a rejection here would become an unhandled rejection and (Node
	 * ≥15) kill the daemon; `drainDue` already swallows every fault, but the `.catch` is the
	 * belt-and-suspenders floor. A kick after `close()` (or while draining) is a silent no-op. Never throws.
	 */
	kick(): void {
		if (this.closed || this.draining) return;
		void this.drainDue().catch((err: unknown) => this.onDrainRejection(err));
	}

	/**
	 * The belt-and-suspenders floor for the un-awaited kick/timer drains: `drainDue` already swallows every
	 * EXPECTED fault, so a rejection reaching here is UNEXPECTED — LOG it (secret-free: message only, never
	 * content/scope) rather than an empty catch, so observability is retained while a Node ≥15 daemon-killing
	 * unhandled rejection is still prevented.
	 */
	private onDrainRejection(err: unknown): void {
		this.logger?.event("memory.outbox.drain_rejected", {
			reason: err instanceof Error ? err.message : String(err),
		});
	}

	/**
	 * PRD-080b (b-AC-1): move a FAILED-this-pass row to terminal `dead` when it hit `maxAttempts` OR
	 * exceeded `maxAgeMs` in the outbox, and emit the secret-free `memory.outbox.dead_lettered` event
	 * (b-AC-2: attempt / ageMs / count only — never content, hash, org, or workspace). Returns `true`
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
			this.logger?.event("memory.outbox.drain_failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
		this.logger?.event("memory.outbox.dead_lettered", { attempt, ageMs: Math.max(0, ageMs), count: 1 });
		return true;
	}

	start(): void {
		if (this.closed || this.timer !== null) return;
		this.timer = this.clock.setInterval(() => {
			// The interval has NO external awaiter, so a rejection here would become an UNHANDLED promise
			// rejection and (Node ≥15) kill the daemon. drainDue already swallows every fault, but route
			// belt-and-suspenders (log, don't empty-catch) so the timer path is ALWAYS fail-soft + observable.
			void this.drainDue().catch((err: unknown) => this.onDrainRejection(err));
		}, this.drainIntervalMs);
	}

	stop(): void {
		if (this.timer === null) return;
		this.clock.clearInterval(this.timer);
		this.timer = null;
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
	 * Lease the due ACTIVE rows (`status = pending AND next_attempt_at <= now`), oldest-first, bounded to
	 * {@link maxDrainPerInterval} — PRD-080c (c-AC-3): the SINGLE authoritative per-pass attempt cap, so a
	 * huge backlog attempts at most this many rows and the rest stay due for the next pass. Skips future rows
	 * (a-AC-4) AND terminal `dead` rows (the status filter, so a dead-lettered row is NEVER re-leased — b-AC-1). The
	 * `action` + `row_json` are carried so the drainer rebuilds the resolved write for replay; `created_at`
	 * is carried so the drainer can compute the row's age for the `maxAgeMs` dead-letter check.
	 */
	private leaseDue(nowIso: string): OutboxLease[] {
		const rows = this.db
			.prepare(
				`SELECT ${sqlIdent("id")}, ${sqlIdent("org")}, ${sqlIdent("workspace")}, ${sqlIdent("action")}, ` +
					`${sqlIdent("row_json")}, ${sqlIdent("attempts")}, ${sqlIdent("created_at")} FROM ${sqlIdent(MEMORY_OUTBOX_TABLE)} ` +
					`WHERE ${sqlIdent("status")} = ? AND ${sqlIdent("next_attempt_at")} <= ? ` +
					`ORDER BY ${sqlIdent("next_attempt_at")} ASC, ${sqlIdent("created_at")} ASC LIMIT ?`,
			)
			.all(MEMORY_OUTBOX_PENDING, nowIso, this.maxDrainPerInterval);
		return rows.map((row) => ({
			id: stringField(row, "id"),
			org: stringField(row, "org"),
			workspace: stringField(row, "workspace"),
			action: stringField(row, "action"),
			rowJson: stringField(row, "row_json"),
			attempts: numberField(row, "attempts"),
			createdAt: stringField(row, "created_at"),
		}));
	}

	private deleteRow(id: string): void {
		this.db.prepare(`DELETE FROM ${sqlIdent(MEMORY_OUTBOX_TABLE)} WHERE ${sqlIdent("id")} = ?`).run(id);
	}

	/**
	 * PRD-080b (b-AC-1): move a row to terminal `dead` (retained, never deleted). The row keeps its
	 * final `attempts` so a forensic read sees how many re-commits it survived, and {@link leaseDue}'s
	 * `status = pending` filter guarantees it is never leased again.
	 */
	private markDead(id: string, attempt: number): void {
		this.db
			.prepare(
				`UPDATE ${sqlIdent(MEMORY_OUTBOX_TABLE)} SET ${sqlIdent("attempts")} = ?, ` +
					`${sqlIdent("status")} = ? WHERE ${sqlIdent("id")} = ?`,
			)
			.run(attempt, MEMORY_OUTBOX_DEAD, id);
	}

	/** Bump `attempts` and push `next_attempt_at` out by the bounded exponential backoff (a-AC-4). */
	private pushBackoff(id: string, attempt: number): void {
		const nextAt = new Date(this.clock.now() + this.backoffDelay(attempt)).toISOString();
		this.db
			.prepare(
				`UPDATE ${sqlIdent(MEMORY_OUTBOX_TABLE)} SET ${sqlIdent("attempts")} = ?, ` +
					`${sqlIdent("next_attempt_at")} = ? WHERE ${sqlIdent("id")} = ?`,
			)
			.run(attempt, nextAt, id);
	}

	/** `min(base * 2^(attempt-1), cap)` — the documented bounded exponential backoff. */
	private backoffDelay(attempt: number): number {
		return Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempt - 1), this.backoffCapMs);
	}

	/** Parse + validate a persisted `row_json` back into {@link RowValues}; `null` on any corruption (a-AC-5). */
	private parseRow(rowJson: string): RowValues | null {
		try {
			return OutboxRowValuesSchema.parse(JSON.parse(rowJson) as unknown) as unknown as RowValues;
		} catch {
			return null;
		}
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}
}

/** One leased outbox row (the columns the drainer needs to rebuild the resolved write). */
interface OutboxLease {
	readonly id: string;
	readonly org: string;
	readonly workspace: string;
	readonly action: string;
	readonly rowJson: string;
	readonly attempts: number;
	/** ISO `created_at`, so the drainer can compute the row's age for the `maxAgeMs` dead-letter check (b-AC-1). */
	readonly createdAt: string;
}

/** The mutable per-pass counters {@link SqliteMemoryOutbox.drainDue} accumulates across groups (c-AC-2). */
interface DrainTally {
	drained: number;
	retried: number;
	deadLettered: number;
}

/**
 * PRD-080c (c-AC-2): one leased row paired with its parsed {@link RowValues} + its `content_hash`, a member
 * of a coalesced group. The `hash` drives both the ADD-coalesce eligibility ({@link isCoalescibleAddGroup})
 * and the batched dedup key ({@link commitControlledWriteMany}); it is `null` only for a (never-expected)
 * hash-less row, which forces that group onto the per-row path.
 */
interface OutboxGroupMember {
	readonly lease: OutboxLease;
	readonly row: RowValues;
	readonly hash: string | null;
}

/** PRD-080c (c-AC-2): a coalesced drain group — same scope + same action + same column signature. */
interface OutboxGroup {
	readonly action: ResolvedWriteAction;
	readonly scope: QueryScope;
	readonly members: OutboxGroupMember[];
}

/**
 * PRD-080c (c-AC-2): is this group SAFE to drain as ONE batched dedup probe + ONE multi-row append? Only an
 * ADD group of ≥2 members whose `content_hash`es are ALL present AND DISTINCT qualifies — coalescing
 * PRESERVES the dedup guarantee only when every row carries a dedup key and no two rows in the batch share
 * one (an in-group duplicate hash would slip a second copy past the DB-side probe, so it stays per-row where
 * the sequential dedup-probe-then-append catches the sibling). A singleton, an UPDATE/DELETE (a
 * non-idempotent per-key version-bump — never coalesced), or a hash-less/duplicate-hash ADD is NOT
 * coalescible and drains per-row.
 */
function isCoalescibleAddGroup(group: OutboxGroup): boolean {
	if (group.action !== "add" || group.members.length < 2) return false;
	const seen = new Set<string>();
	for (const member of group.members) {
		if (member.hash === null || seen.has(member.hash)) return false;
		seen.add(member.hash);
	}
	return true;
}

/** Rebuild the {@link ResolvedControlledWrite} the drainer replays from a group's scope + a parsed member. */
function toResolved(scope: QueryScope, member: OutboxGroupMember): ResolvedControlledWrite {
	return { action: member.lease.action as ResolvedWriteAction, keyId: member.lease.id, row: member.row, scope };
}

/**
 * PRD-080c (c-AC-2): the coalescing key — scope (org + workspace) + the resolved ACTION + the ordered
 * column-name signature of the row. Two rows share a key ONLY when they can be safely fused into one
 * multi-row append (same scope, same action, identical columns in identical order), so `buildInsertMany`'s
 * same-columns assertion never rejects a group AND an ADD is never coalesced with a version-bumped
 * UPDATE/DELETE (which share a column signature but differ in commit logic). A NUL separator (unprintable)
 * cannot appear in an org/workspace slug, an action enum, or a `memories` column name, so the join is
 * unambiguous — no two distinct tuples collide, none splits.
 */
function groupKey(org: string, workspace: string, action: string, row: RowValues): string {
	// A NUL separator (unprintable, built at runtime so the SOURCE stays pure ASCII) cannot appear in an
	// org/workspace slug, an action enum, or a `memories` column name — so the join is unambiguous: no two
	// distinct (org, workspace, action, column-signature) tuples collide, and none splits.
	const sep = String.fromCharCode(0);
	const signature = row.map(([name]) => name).join(sep);
	return [org, workspace, action, signature].join(sep);
}

/** Normalize a SQLite `run()` change count (`number | bigint`) into a plain number (c-AC-1 shed count). */
function changeCount(result: { readonly changes: number | bigint }): number {
	return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}
