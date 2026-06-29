/**
 * Durable job queue service — PRD-004b (IMPLEMENTED over the 004a seam).
 *
 * The DeepLake-backed `memory_jobs` queue: enqueue → lease → complete / fail →
 * dead, with bounded retries, exponential backoff, a stale-lease reaper, and
 * restart survival. It runs in-process, daemon-owned (D-4), and is started /
 * stopped by the 004a bootstrap via the {@link DaemonService} lifecycle. This
 * module fills the BODY only; it does NOT edit `server.ts`, `index.ts`, or
 * `services/types.ts` (see `../CONVENTIONS.md` §004b).
 *
 * ── How it reaches storage (CONVENTIONS §1) ─────────────────────────────────
 * The service does not open DeepLake. It receives the injected `StorageQuery`
 * (`storage.query(sql, scope)`) + the resolved `QueryScope`, runs every
 * statement through that client, and branches on the result `kind` via `isOk`.
 * The `memory_jobs` table is created + healed lazily by the PRD-002d write
 * primitives' `withHeal` wrapper — never a hand-rolled `CREATE`/`ALTER` (b-AC-6 /
 * FR-6). Every value routes through `sLiteral` / `eLiteral` (via `renderValue`)
 * and every identifier through `sqlIdent` (SQL-safety floor, PRD-002b) — no value
 * is hand-quoted.
 *
 * ── Append-only version-bumped, NOT in-place UPDATE (FR-6 / PRD-002d) ────────
 * Every job state transition (enqueue, lease, complete, fail, reap-reclaim, dead)
 * APPENDs a new row carrying the same `id` (the logical job key) with `version` =
 * N+1 and the new `status`/lease fields. A job's CURRENT state is its
 * HIGHEST-`version` row. The queue NEVER issues a true `UPDATE` against
 * `memory_jobs`.
 *
 * Why — the determinism the whole queue rests on. Independent live testing proved
 * this backend serves a SCAN (and even a by-id point read of a REWRITTEN row) from
 * segments of differing freshness that alternate non-monotonically and
 * INDEFINITELY (verified: a full-table count flapped between a partial and a full
 * segment forever, never settling; a by-id read of an UPDATEd row returned its
 * pre-write snapshot on some polls). So the old `update-or-insert` design's
 * status-filtered reaper / lease scans flapped, and its post-UPDATE ownership
 * re-read could read stale forever. Append-only fixes this at the root: versions
 * only ever INCREASE and a higher version is never fictitious, so resolving a job
 * by `MAX(version)` across a small bounded UNION of point-read polls CONVERGES
 * MONOTONICALLY to the job's true current state — whichever segment any single
 * poll lands on, it can only lower-bound the truth, and the union lifts it to the
 * real highest version. Discovery scans (lease candidates, reaper) likewise UNION
 * the ids they observe across polls (a scan may MISS an id on a stale segment but
 * never invents one), then resolve each candidate's CURRENT state via the
 * converging per-id read before acting. No `sleep` is used as the mechanism — the
 * convergence is what makes it deterministic; the natural network round-trip
 * between polls supplies the only spacing.
 *
 * ── Ownership confirm (b-AC-1) ──────────────────────────────────────────────
 * Leasing APPENDs a `leased` row at version N+1, then RESOLVES the job's current
 * (highest-version) row and proceeds only when it reads back THIS owner on a
 * `leased` row. Because the just-appended row IS the highest version, the
 * converging resolve confirms it; a losing racer's later/earlier append leaves a
 * DIFFERENT owner at the highest version and fails the confirm honestly.
 *
 * ── Backoff / lease / retry defaults (D-3) ──────────────────────────────────
 * max_attempts 5; backoff base 1s doubling, cap 5min; lease 5min. All
 * configurable via {@link JobQueueConfig}.
 *
 * ── Storage-unavailable posture (PRD-004b impl-note) ────────────────────────
 * A `connection_error` / `timeout` during leasing PAUSES leasing (returns
 * `null`) rather than marking jobs failed — a connectivity blip is never a job
 * failure. Only an explicit `fail()` advances a job's attempt counter.
 */

import {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_BACKOFF_CAP_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_MAX_ATTEMPTS,
	healTargetFor,
	JOB_DEAD,
	JOB_DONE,
	JOB_FAILED,
	JOB_LEASED,
	JOB_QUEUED,
	MEMORY_JOBS_TABLE,
} from "../../storage/catalog/index.js";
import { type HealTarget, withHeal } from "../../storage/heal.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { QuerySource } from "../../storage/query-meter.js";
import { buildInsert, type RowValues, val } from "../../storage/writes.js";
import type { DaemonService } from "./types.js";

/** A job handed to the queue. */
export interface JobInput {
	/** The job kind (routes it to a handler). */
	readonly kind: string;
	/** Opaque JSON payload for the handler. */
	readonly payload: Record<string, unknown>;
}

/** A leased job a worker is processing. */
export interface LeasedJob {
	/** The job's durable id. */
	readonly id: string;
	/** The job kind. */
	readonly kind: string;
	/** The payload to process. */
	readonly payload: Record<string, unknown>;
	/** Current attempt number (1-based: the run this lease represents). */
	readonly attempt: number;
}

/**
 * The durable job queue (PRD-004b). Extends {@link DaemonService} so the
 * bootstrap starts/stops it uniformly. Methods are async because they round-trip
 * DeepLake.
 */
export interface JobQueueService extends DaemonService {
	/** Enqueue a job for durable, retried background processing; returns its id. */
	enqueue(job: JobInput): Promise<string>;
	/**
	 * Lease the next runnable job, or `null` when nothing is leasable.
	 *
	 * `kinds` is an OPTIONAL kind filter: when supplied, only a job whose `type`
	 * column is in `kinds` is leasable — every other queued/failed job is left
	 * untouched. Omitting it (the default) leases ANY kind, so existing callers are
	 * byte-identical. The filter exists so a kind-specialized worker (e.g. the
	 * pollinating worker) NEVER leases — and then `fail()`s — a foreign kind it cannot
	 * run, which would otherwise walk a legit `summary`/`skillify` job to dead.
	 */
	lease(kinds?: readonly string[]): Promise<LeasedJob | null>;
	/** Mark a leased job complete (`status='done'`). `leaseAttempt` fences local queues against stale workers. */
	complete(id: string, leaseAttempt?: number): Promise<void>;
	/** Mark a leased job failed; the queue applies backoff / dead semantics. `leaseAttempt` fences local queues against stale workers. */
	fail(id: string, reason: string, leaseAttempt?: number): Promise<void>;
}

/** A minimal structured-log sink the queue can report lifecycle events to. */
export interface JobQueueLogger {
	/** Record a structured event (e.g. `reaper.reclaimed`, `job.dead`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** Tuning knobs (D-3). All optional; each falls back to the documented default. */
export interface JobQueueConfig {
	/** Bounded retries before a job → `dead`. Default 5. */
	readonly maxAttempts?: number;
	/** Exponential-backoff base in ms (doubles per attempt). Default 1000. */
	readonly backoffBaseMs?: number;
	/** Exponential-backoff cap in ms. Default 300_000 (5min). */
	readonly backoffCapMs?: number;
	/** Lease duration in ms. Default 300_000 (5min). */
	readonly leaseMs?: number;
	/** Reaper sweep interval in ms. Default = leaseMs (sweep about once per lease). */
	readonly reaperIntervalMs?: number;
	/** Retention window for `done` jobs in ms before purge. Default 86_400_000 (24h). */
	readonly doneRetentionMs?: number;
	/** Retention window for `dead` jobs in ms (kept longer). Default 604_800_000 (7d). */
	readonly deadRetentionMs?: number;
	/** Unique owner id this queue instance stamps on leases. Default a generated id. */
	readonly owner?: string;
	/**
	 * The physical table name to read/write/heal. Defaults to the catalog's
	 * canonical `memory_jobs` (the production name). It exists so an isolated
	 * deployment — or the opt-in LIVE integration smoke — can point the queue at a
	 * throwaway, namespaced table it is free to DROP, WITHOUT touching a real
	 * daemon's shared `memory_jobs`. The COLUMNS are always the catalog's
	 * single-sourced `MEMORY_JOBS_COLUMNS`; only the name is parameterized, and it
	 * is validated through `sqlIdent` like every identifier.
	 */
	readonly tableName?: string;
}

/** The injected clock + scheduler, so tests drive time with fake timers. */
export interface JobQueueClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
	/** Schedule a repeating callback; returns a handle for {@link clearTimer}. */
	readonly setTimer: (cb: () => void, ms: number) => unknown;
	/** Cancel a handle returned by {@link setTimer}. */
	readonly clearTimer: (handle: unknown) => void;
}

/** Construction deps (CONVENTIONS §1). */
export interface JobQueueDeps {
	/** Run queries through this — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition for queue rows. */
	readonly scope: QueryScope;
	/** Optional structured-log sink. */
	readonly logger?: JobQueueLogger;
	/** Optional tuning (D-3 defaults otherwise). */
	readonly config?: JobQueueConfig;
	/** Optional injected clock/scheduler (real timers otherwise). */
	readonly clock?: JobQueueClock;
}

/** The real, fully-resolved config the service runs against. */
interface ResolvedConfig {
	readonly maxAttempts: number;
	readonly backoffBaseMs: number;
	readonly backoffCapMs: number;
	readonly leaseMs: number;
	readonly reaperIntervalMs: number;
	readonly doneRetentionMs: number;
	readonly deadRetentionMs: number;
	readonly owner: string;
	readonly tableName: string;
}

/** Resolve the public config into concrete numbers, applying D-3 defaults. */
function resolveConfig(config: JobQueueConfig | undefined, ownerFallback: string): ResolvedConfig {
	const leaseMs = config?.leaseMs ?? DEFAULT_LEASE_MS;
	return {
		maxAttempts: config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		backoffBaseMs: config?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
		backoffCapMs: config?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS,
		leaseMs,
		reaperIntervalMs: config?.reaperIntervalMs ?? leaseMs,
		doneRetentionMs: config?.doneRetentionMs ?? 24 * 60 * 60 * 1_000,
		deadRetentionMs: config?.deadRetentionMs ?? 7 * 24 * 60 * 60 * 1_000,
		owner: config?.owner ?? ownerFallback,
		tableName: config?.tableName ?? MEMORY_JOBS_TABLE,
	};
}

/**
 * How many times a per-id current-state resolve re-reads the highest-version row
 * before taking the UNION of MAX(version) it observed (see
 * {@link DeepLakeJobQueueService.resolveCurrent}). This backend serves the read
 * from segments of differing freshness, so a single read can return a STALE lower
 * version; because versions are append-only and monotone, the MAX across a few
 * polls converges UP to the true current version (a poll can only under-report,
 * never over-report). On the deterministic fake the first poll is already the
 * truth, so the union settles immediately — this is a live-only cost.
 */
const RESOLVE_POLLS = 8;

/**
 * How many times the discovery scan (lease candidates / reaper) is polled, unioning
 * the ids it observes (see {@link DeepLakeJobQueueService.discoverIds}). A scan over
 * the append-only table can MISS an id on a stale segment but never invents one, so
 * a small union recovers the full id set. Short-circuits once a non-empty set stops
 * growing, so the fake and a quiet live table finish in one round trip.
 */
const DISCOVER_POLLS = 8;

/**
 * How many distinct candidates a single {@link DeepLakeJobQueueService.lease} call
 * will try before giving up. After discovery + per-id resolution a candidate can
 * still race another leaser; the ownership confirm rejects the loser and the loop
 * excludes it and tries the next genuinely-leasable job. Bounded so it can never
 * spin forever.
 */
const LEASE_CANDIDATE_TRIES = 8;

/**
 * PRD-062b L-X (062a labeling, poll-path half): the `source` labels every physical
 * read on the two poll paths carries through `StorageClient.query`'s options, so the
 * 062a query meter attributes the idle-poll baseline correctly:
 *
 *   - `poll-lease`  — every read the LEASE path issues (discovery scan + per-id
 *     current-state resolves, which is where the UNION-scan amplification lives).
 *   - `poll-reaper` — every read the stale-lease REAPER sweep issues.
 *
 * The retention purge (`purgeRetained`) is NOT a poll-loop read; it keeps the meter
 * default (`other`) so the idle-baseline number is exactly the two poll sources.
 */
const SOURCE_LEASE: QuerySource = "poll-lease";
const SOURCE_REAPER: QuerySource = "poll-reaper";

/** The default clock: real `Date.now` + `setInterval`/`clearInterval`. */
function defaultClock(): JobQueueClock {
	return {
		now: () => Date.now(),
		setTimer: (cb, ms) => setInterval(cb, ms),
		clearTimer: (handle) => {
			if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
		},
	};
}

/**
 * Compute the exponential-backoff delay for the NEXT run after `attempts`
 * failures (b-AC-4 / D-3): `base * 2^(attempts-1)`, capped. `attempts` is the
 * post-increment run count, so the first failure (attempts=1) waits `base`, the
 * second waits `base*2`, etc., never exceeding `cap`. Pure and deterministic.
 */
export function backoffDelayMs(attempts: number, baseMs: number, capMs: number): number {
	const exponent = Math.max(0, attempts - 1);
	// 2^exponent can overflow for large exponents; clamp via the cap directly.
	const raw = baseMs * 2 ** Math.min(exponent, 30);
	return Math.min(raw, capMs);
}

/** Read a JSONB/text payload column back into a plain object, defensively. */
function parsePayload(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string" && raw.length > 0) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// A non-JSON payload string is surfaced under a `_raw` key rather than
			// dropped — never a swallowed loss (no empty catch).
			return { _raw: raw };
		}
	}
	return {};
}

/** Coerce a row's BIGINT column to a finite number (0 when absent/garbage). */
function rowNumber(row: StorageRow, column: string): number {
	const raw = row[column];
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/** Coerce a row's TEXT column to a string ("" when absent). */
function rowText(row: StorageRow, column: string): string {
	const raw = row[column];
	return typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
}

/**
 * The current (highest-version) state of one job, resolved from the append-only
 * `memory_jobs` rows. The full row is carried so callers (lease/fail/reaper) read
 * whichever columns they need without a second round trip.
 */
interface JobState {
	readonly id: string;
	readonly type: string;
	readonly payload: Record<string, unknown>;
	readonly status: string;
	readonly leaseOwner: string;
	readonly leaseExpiresAt: string;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly nextRunAt: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly version: number;
}

/** Project a storage row into a {@link JobState}. */
function toJobState(row: StorageRow): JobState {
	return {
		id: rowText(row, "id"),
		type: rowText(row, "type"),
		payload: parsePayload(row.payload),
		status: rowText(row, "status"),
		leaseOwner: rowText(row, "lease_owner"),
		leaseExpiresAt: rowText(row, "lease_expires_at"),
		attempts: rowNumber(row, "attempts"),
		maxAttempts: rowNumber(row, "max_attempts"),
		nextRunAt: rowText(row, "next_run_at"),
		createdAt: rowText(row, "created_at"),
		updatedAt: rowText(row, "updated_at"),
		version: rowNumber(row, "version"),
	};
}

/** Every column a current-state resolve reads back (the full job row). */
const STATE_COLUMNS = [
	"id",
	"type",
	"payload",
	"status",
	"lease_owner",
	"lease_expires_at",
	"attempts",
	"max_attempts",
	"next_run_at",
	"created_at",
	"updated_at",
	"version",
] as const;

/**
 * The DeepLake-backed durable job queue. Construct via {@link createJobQueueService}.
 */
class DeepLakeJobQueueService implements JobQueueService {
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly logger?: JobQueueLogger;
	private readonly cfg: ResolvedConfig;
	private readonly clock: JobQueueClock;
	private readonly target: HealTarget;
	private reaperHandle: unknown;
	/**
	 * Re-entrancy guard for the reaper. A single sweep over a large append-only table
	 * resolves every job id sequentially and can take many seconds; the reaper runs on a
	 * `setInterval`, so without this guard a slow sweep would stack under the interval and
	 * stampede the backend with overlapping scans. A sweep already in flight makes the next
	 * tick a no-op.
	 */
	private reaping = false;
	private idSeq = 0;

	constructor(deps: JobQueueDeps) {
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.logger = deps.logger;
		this.clock = deps.clock ?? defaultClock();
		this.cfg = resolveConfig(deps.config, this.generateOwner());
		// Heal target = the REAL catalog columns (single-sourced) under the configured
		// table name (defaults to the canonical `memory_jobs`). Borrowing the catalog
		// columns and swapping only the name mirrors the live smoke's `ciHealTarget`.
		this.target = { table: this.cfg.tableName, columns: healTargetFor(MEMORY_JOBS_TABLE).columns };
	}

	/** A reasonably-unique owner id for this queue instance's leases. */
	private generateOwner(): string {
		return `owner-${this.clock.now()}-${Math.floor(Math.random() * 1_000_000)}`;
	}

	/** A monotonic, instance-unique job id stamped at enqueue. */
	private nextJobId(): string {
		this.idSeq += 1;
		return `job-${this.clock.now()}-${this.idSeq}-${Math.floor(Math.random() * 1_000_000)}`;
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	private tbl(): string {
		return sqlIdent(this.cfg.tableName);
	}

	/**
	 * Enqueue a queued job (b-AC-6 / FR-6). APPENDs the job's version-1 row. The
	 * first write to a non-existent `memory_jobs` table heals
	 * (CREATE-from-ColumnDef) and retries once via the `withHeal` path. Returns the
	 * new job id.
	 */
	async enqueue(job: JobInput): Promise<string> {
		const id = this.nextJobId();
		const now = this.nowIso();
		const ok = await this.append(id, 1, [
			["id", val.str(id)],
			["type", val.str(job.kind)],
			["payload", val.text(JSON.stringify(job.payload ?? {}))],
			["status", val.str(JOB_QUEUED)],
			["lease_owner", val.str("")],
			["lease_expires_at", val.str("")],
			["attempts", val.num(0)],
			["max_attempts", val.num(this.cfg.maxAttempts)],
			["next_run_at", val.str(now)],
			["last_error", val.str("")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);
		if (!ok) this.logger?.event("job.enqueue.failed", { id, kind: job.kind });
		return id;
	}

	/**
	 * Lease the oldest runnable job (b-AC-1 / FR-2). Discovers candidate ids whose
	 * CURRENT (highest-version) row is `queued` (or backoff-ready `failed`) and whose
	 * `next_run_at` has passed, picks the oldest, APPENDs a `leased` row at version
	 * N+1, then RESOLVES the job's current state to CONFIRM this owner won. Returns
	 * the job only on confirmed ownership; otherwise `null`.
	 *
	 * The loop tolerates a racing leaser: a failed confirm EXCLUDES that id and
	 * re-selects the next candidate, up to {@link LEASE_CANDIDATE_TRIES} times. A
	 * storage `connection_error`/`timeout` PAUSES leasing (returns `null`) — a
	 * connectivity blip is never a job failure (impl-note).
	 */
	async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
		const owner = this.cfg.owner;
		const tried = new Set<string>();

		for (let attempt = 0; attempt < LEASE_CANDIDATE_TRIES; attempt++) {
			const candidate = await this.selectLeasable(tried, kinds);
			if (candidate === null) return null; // nothing leasable (after exclusions).
			tried.add(candidate.id);

			const now = this.clock.now();
			const expiresAt = new Date(now + this.cfg.leaseMs).toISOString();
			const nowIso = new Date(now).toISOString();

			// APPEND a leased row at version N+1 carrying the job's identity + the new
			// lease fields. attempts is carried forward unchanged (a lease is not a
			// failure); the run this lease represents is candidate.attempts + 1.
			const wrote = await this.append(candidate.id, candidate.version + 1, [
				["id", val.str(candidate.id)],
				["type", val.str(candidate.type)],
				["payload", val.text(JSON.stringify(candidate.payload ?? {}))],
				["status", val.str(JOB_LEASED)],
				["lease_owner", val.str(owner)],
				["lease_expires_at", val.str(expiresAt)],
				["attempts", val.num(candidate.attempts)],
				["max_attempts", val.num(candidate.maxAttempts)],
				["next_run_at", val.str(candidate.nextRunAt)],
				["last_error", val.str("")],
				["created_at", val.str(candidate.createdAt)],
				["updated_at", val.str(nowIso)],
			]);
			if (!wrote) return null; // connectivity/blip → pause leasing, not fail.

			// Confirm ownership (b-AC-1): resolve the job's CURRENT (highest-version)
			// state. The just-appended leased row is the highest version, so the
			// converging resolve reads back THIS owner on a `leased` row when we won. A
			// racer who appended a competing version leaves a DIFFERENT owner at the
			// highest version → confirm fails → exclude + try the next candidate.
			const current = await this.resolveCurrent(candidate.id, SOURCE_LEASE);
			if (current !== null && current.leaseOwner === owner && current.status === JOB_LEASED) {
				return {
					id: candidate.id,
					kind: candidate.type,
					payload: candidate.payload,
					attempt: candidate.attempts + 1,
				};
			}
		}
		return null;
	}

	/**
	 * Select the oldest leasable job (current row `queued`, or `failed` whose
	 * `next_run_at` has passed), skipping any id in `exclude`. Resolves CANDIDATES
	 * via {@link discoverIds} (highest-version-per-id), filters to the leasable ones,
	 * and returns the oldest by `next_run_at` then `created_at`.
	 *
	 * When `kinds` is supplied, a candidate is leasable ONLY when its `type` is in
	 * that set — a foreign-kind job is never selected, so it stays queued for its own
	 * worker rather than being leased and failed here. Undefined `kinds` leases any
	 * kind (the default, behaviour-preserving for existing callers).
	 */
	private async selectLeasable(
		exclude: ReadonlySet<string>,
		kinds?: readonly string[],
	): Promise<JobState | null> {
		const nowIso = this.nowIso();
		const states = await this.discoverIds(SOURCE_LEASE);
		const leasable = states.filter(
			(s) =>
				!exclude.has(s.id) &&
				(kinds === undefined || kinds.includes(s.type)) &&
				(s.status === JOB_QUEUED || s.status === JOB_FAILED) &&
				s.nextRunAt !== "" &&
				s.nextRunAt <= nowIso,
		);
		if (leasable.length === 0) return null;
		leasable.sort((a, b) =>
			a.nextRunAt < b.nextRunAt ? -1 : a.nextRunAt > b.nextRunAt ? 1 : a.createdAt.localeCompare(b.createdAt),
		);
		return leasable[0];
	}

	/**
	 * Discover every job's CURRENT (highest-version) state. Polls a bare
	 * `SELECT DISTINCT id` scan up to {@link DISCOVER_POLLS} times, UNIONing the ids
	 * it observes (a scan over the append-only table can miss an id on a stale
	 * segment but never invents one), short-circuiting once a non-empty id set stops
	 * growing. Then resolves each id's current state via {@link resolveCurrent}. The
	 * `__ensure__` sentinel row (see {@link ensureTable}) is filtered out.
	 */
	private async discoverIds(source?: QuerySource): Promise<JobState[]> {
		const ids = new Set<string>();
		let lastSize = -1;
		for (let poll = 0; poll < DISCOVER_POLLS; poll++) {
			const sql = `SELECT DISTINCT ${sqlIdent("id")} FROM "${this.tbl()}"`;
			// PRD-062b: tag the discovery scan with the poll-path `source` so the 062a
			// meter attributes the idle-poll baseline (`source` is meter-only; it never
			// changes the query result).
			const res = await this.storage.query(sql, this.scope, source !== undefined ? { source } : {});
			if (isOk(res)) {
				for (const row of res.rows as StorageRow[]) {
					const id = rowText(row, "id");
					if (id !== "" && id !== "__ensure__") ids.add(id);
				}
			}
			if (ids.size > 0 && ids.size === lastSize) break;
			lastSize = ids.size;
		}

		const states: JobState[] = [];
		for (const id of ids) {
			const state = await this.resolveCurrent(id, source);
			if (state !== null) states.push(state);
		}
		return states;
	}

	/**
	 * Resolve one job's CURRENT (highest-version) state, robust to this backend's
	 * segment-freshness flap. Re-reads the by-id `ORDER BY version DESC LIMIT 1` row
	 * up to {@link RESOLVE_POLLS} times and keeps the row with the MAX `version`
	 * observed. Because versions are append-only and monotone, a single read can only
	 * UNDER-report (land on a stale segment missing the newest append) — never
	 * over-report — so the union converges UP to the true current version. `null`
	 * when the id has no row at all. Short-circuits once a max-version row is seen
	 * twice (the fake is decisive on the first read).
	 */
	private async resolveCurrent(id: string, source?: QuerySource): Promise<JobState | null> {
		let best: JobState | null = null;
		let seenBestTwice = false;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const row = await this.latestById(id, source);
			if (row !== null) {
				const state = toJobState(row);
				if (best === null || state.version > best.version) {
					best = state;
					seenBestTwice = false;
				} else if (state.version === best.version) {
					if (seenBestTwice) break; // stable: same max seen 3x → converged.
					seenBestTwice = true;
				}
			}
		}
		return best;
	}

	/** One highest-version by-id read of the full job row, or `null` when absent. */
	private async latestById(id: string, source?: QuerySource): Promise<StorageRow | null> {
		const cols = STATE_COLUMNS.map((c) => sqlIdent(c)).join(", ");
		const sql =
			`SELECT ${cols} FROM "${this.tbl()}" ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} ` +
			`ORDER BY ${sqlIdent("version")} DESC LIMIT 1`;
		// PRD-062b: carry the poll-path `source` (lease/reaper) onto each per-id resolve
		// read — these are the bulk of the UNION-scan amplification the meter must see.
		const res = await this.storage.query(sql, this.scope, source !== undefined ? { source } : {});
		if (isOk(res) && res.rows.length > 0) return res.rows[0] as StorageRow;
		return null;
	}

	/**
	 * APPEND one new version row for `id` (heal-aware). The single write primitive
	 * for every transition: it stamps `version` = `version` and INSERTs the supplied
	 * columns, never an in-place UPDATE. Returns whether the write succeeded.
	 */
	private async append(id: string, version: number, row: RowValues): Promise<boolean> {
		const full: RowValues = [...row, ["version", val.num(version)] as const];
		const sql = buildInsert(this.tbl(), full);
		const res = await withHeal(this.storage, this.target, this.scope, () => this.storage.query(sql, this.scope));
		if (!isOk(res)) {
			this.logger?.event("job.append.failed", { id, version });
			return false;
		}
		return true;
	}

	/** Mark a leased job complete (`status='done'`, FR-3). Appends a `done` version. */
	async complete(id: string): Promise<void> {
		const current = await this.resolveCurrent(id);
		if (current === null) {
			this.logger?.event("job.complete.unknown", { id });
			return;
		}
		const now = this.nowIso();
		const ok = await this.append(id, current.version + 1, [
			["id", val.str(id)],
			["type", val.str(current.type)],
			["payload", val.text(JSON.stringify(current.payload ?? {}))],
			["status", val.str(JOB_DONE)],
			["lease_owner", val.str("")],
			["lease_expires_at", val.str("")],
			["attempts", val.num(current.attempts)],
			["max_attempts", val.num(current.maxAttempts)],
			["next_run_at", val.str(current.nextRunAt)],
			["last_error", val.str("")],
			["created_at", val.str(current.createdAt)],
			["updated_at", val.str(now)],
		]);
		if (!ok) this.logger?.event("job.complete.failed", { id });
	}

	/**
	 * Fail a leased job (b-AC-2 / b-AC-4 / FR-3 / FR-4). Appends a new version that
	 * increments `attempts`, records `last_error`, and EITHER:
	 *   - re-queues to `failed` with `next_run_at` = now + exponential backoff when
	 *     attempts remain (b-AC-4), OR
	 *   - transitions to `dead` (never leased again) at `max_attempts` (b-AC-2).
	 */
	async fail(id: string, reason: string): Promise<void> {
		const current = await this.resolveCurrent(id);
		if (current === null) {
			this.logger?.event("job.fail.unknown", { id });
			return;
		}
		const attempts = current.attempts + 1;
		const maxAttempts = current.maxAttempts > 0 ? current.maxAttempts : this.cfg.maxAttempts;
		const now = this.clock.now();
		const nowIso = new Date(now).toISOString();

		const dead = attempts >= maxAttempts;
		const nextRunAt = dead
			? nowIso
			: new Date(now + backoffDelayMs(attempts, this.cfg.backoffBaseMs, this.cfg.backoffCapMs)).toISOString();

		const ok = await this.append(id, current.version + 1, [
			["id", val.str(id)],
			["type", val.str(current.type)],
			["payload", val.text(JSON.stringify(current.payload ?? {}))],
			["status", val.str(dead ? JOB_DEAD : JOB_FAILED)],
			["lease_owner", val.str("")],
			["lease_expires_at", val.str("")],
			["attempts", val.num(attempts)],
			["max_attempts", val.num(maxAttempts)],
			["next_run_at", val.str(nextRunAt)],
			["last_error", val.text(reason)],
			["created_at", val.str(current.createdAt)],
			["updated_at", val.str(nowIso)],
		]);
		if (!ok) {
			this.logger?.event("job.fail.write_failed", { id });
			return;
		}
		this.logger?.event(dead ? "job.dead" : "job.failed", { id, attempts, maxAttempts });
	}

	/**
	 * Reap stale leases (b-AC-3 / b-AC-5 / FR-5): find jobs whose CURRENT
	 * (highest-version) row is `leased` with an expired `lease_expires_at`, and
	 * APPEND a fresh `queued` version returning them to leasable (within their retry
	 * bounds — `attempts` is left intact so a reaped lease does NOT consume an
	 * attempt). Returns the number of jobs reclaimed.
	 *
	 * Determinism: discovery + per-id resolution run through the same converging
	 * highest-version reads as leasing, so the reaper's view of "which jobs are
	 * currently leased-and-expired" is the job's true current state — not a flapping
	 * status index over stale versions. The reclaim itself is an append (a new
	 * highest version), so a subsequent lease sees the `queued` state by the same
	 * convergence.
	 */
	async reapExpiredLeases(): Promise<number> {
		const nowIso = this.nowIso();
		const states = await this.discoverIds(SOURCE_REAPER);
		const expired = states.filter(
			(s) => s.status === JOB_LEASED && s.leaseExpiresAt !== "" && s.leaseExpiresAt <= nowIso,
		);
		if (expired.length === 0) return 0;

		let reclaimed = 0;
		for (const s of expired) {
			const ok = await this.append(s.id, s.version + 1, [
				["id", val.str(s.id)],
				["type", val.str(s.type)],
				["payload", val.text(JSON.stringify(s.payload ?? {}))],
				["status", val.str(JOB_QUEUED)],
				["lease_owner", val.str("")],
				["lease_expires_at", val.str("")],
				["attempts", val.num(s.attempts)],
				["max_attempts", val.num(s.maxAttempts)],
				["next_run_at", val.str(this.nowIso())],
				["last_error", val.str("")],
				["created_at", val.str(s.createdAt)],
				["updated_at", val.str(this.nowIso())],
			]);
			if (ok) reclaimed += 1;
		}
		if (reclaimed > 0) this.logger?.event("reaper.reclaimed", { count: reclaimed });
		return reclaimed;
	}

	/**
	 * Purge aged-out jobs (b-AC-7): delete the rows of jobs whose CURRENT state is
	 * `done` older than the completion window while RETAINING `dead` jobs longer.
	 * Resolves each job's current state first (so a stale lower-version `done` row is
	 * never mistaken for the current state), then DELETEs ALL rows for the qualifying
	 * id. The retention module (later) calls this on its own cadence; the sweep is a
	 * method so it is independently testable.
	 */
	async purgeRetained(): Promise<{ doneDeleted: boolean; deadDeleted: boolean }> {
		const now = this.clock.now();
		const doneCutoff = new Date(now - this.cfg.doneRetentionMs).toISOString();
		const deadCutoff = new Date(now - this.cfg.deadRetentionMs).toISOString();

		const states = await this.discoverIds();
		let doneDeleted = true;
		let deadDeleted = true;
		for (const s of states) {
			// The current row's `updated_at` is when the job entered its terminal state;
			// it is what the cutoff is measured against.
			if (s.status === JOB_DONE && s.updatedAt !== "" && s.updatedAt <= doneCutoff) {
				const res = await this.deleteAllForId(s.id);
				doneDeleted = doneDeleted && isOk(res);
			} else if (s.status === JOB_DEAD && s.updatedAt !== "" && s.updatedAt <= deadCutoff) {
				const res = await this.deleteAllForId(s.id);
				deadDeleted = deadDeleted && isOk(res);
			}
		}
		return { doneDeleted, deadDeleted };
	}

	/** DELETE every appended row for a job id (used by retention purge). */
	private async deleteAllForId(id: string): Promise<QueryResult> {
		const sql = `DELETE FROM "${this.tbl()}" WHERE ${sqlIdent("id")} = ${sLiteral(id)}`;
		return this.storage.query(sql, this.scope);
	}

	/**
	 * Start the queue (b-AC-5 / FR-8): ensure `memory_jobs` exists, reap any leases
	 * dangling from a prior process, and start the reaper timer.
	 */
	async start(): Promise<void> {
		await this.ensureTable();
		// Do NOT block daemon readiness on the initial reap. `reapExpiredLeases()` resolves
		// EVERY job's current version sequentially (`discoverIds()` walks the whole id set),
		// so its cost scales with the TOTAL number of jobs ever recorded in the append-only
		// table (done jobs included), not with the number of stale leases. On a large live
		// table that is many minutes of sequential round-trips. Because the daemon binds its
		// socket only AFTER `startServices()` resolves, awaiting the reap here wedged boot
		// ("process holds the lock but is not answering /health"). Mirror the embed supervisor
		// (server.ts): warm in the BACKGROUND, never block readiness. Schedule the steady-state
		// reaper, then kick ONE immediate sweep (not awaited) so a fresh process still reclaims
		// dangling leases promptly. Both go through `reapSweep()`, which is guarded so the
		// per-sweep cost can never overlap/stampede the backend.
		this.reaperHandle = this.clock.setTimer(() => {
			void this.reapSweep();
		}, this.cfg.reaperIntervalMs);
		void this.reapSweep();
	}

	/**
	 * One reaper sweep, guarded against overlap (FR-5). A sweep already in flight makes
	 * this a no-op so a slow scan over a large table cannot stack under the reaper interval
	 * or the boot-time immediate kick. Errors are swallowed to a structured event — a reaper
	 * failure must never crash the daemon (the next tick retries).
	 */
	private async reapSweep(): Promise<void> {
		if (this.reaping) return;
		this.reaping = true;
		try {
			await this.reapExpiredLeases();
		} catch (err: unknown) {
			this.logger?.event("reaper.sweep.failed", {
				reason: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.reaping = false;
		}
	}

	/** Stop the queue: clear the reaper timer. Idempotent. */
	stop(): void {
		if (this.reaperHandle !== undefined) {
			this.clock.clearTimer(this.reaperHandle);
			this.reaperHandle = undefined;
		}
	}

	/**
	 * Ensure `memory_jobs` exists by APPENDing a benign sentinel row through the
	 * heal-aware write path. A SELECT cannot heal (the heal engine only heals on a
	 * failed WRITE), so we issue a heal-aware INSERT of a `__ensure__` sentinel: on a
	 * missing-table failure the `withHeal` wrapper CREATEs the table from the
	 * ColumnDef array, then the INSERT lands. The sentinel id is filtered out of
	 * every discovery scan, so it never surfaces as a job.
	 */
	private async ensureTable(): Promise<void> {
		await this.append("__ensure__", 1, [
			["id", val.str("__ensure__")],
			["type", val.str("")],
			["payload", val.text("{}")],
			["status", val.str(JOB_DONE)],
			["lease_owner", val.str("")],
			["lease_expires_at", val.str("")],
			["attempts", val.num(0)],
			["max_attempts", val.num(this.cfg.maxAttempts)],
			["next_run_at", val.str("")],
			["last_error", val.str("")],
			["created_at", val.str(this.nowIso())],
			["updated_at", val.str(this.nowIso())],
		]);
	}
}

/**
 * Build the real DeepLake-backed job queue (PRD-004b). The 004a bootstrap default
 * is {@link noopJobQueueService}; a test (or the daemon, once wired) constructs
 * this with the storage client + scope and passes it to
 * `createDaemon({ services: { queue } })`.
 */
export function createJobQueueService(deps: JobQueueDeps): JobQueueService {
	return new DeepLakeJobQueueService(deps);
}

/**
 * The no-op stub queue the 004a bootstrap injects by default. Enqueue returns a
 * synthetic id, lease always returns `null`, complete/fail and start/stop are
 * no-ops. Retained so the bootstrap default still compiles and runs inertly.
 */
export const noopJobQueueService: JobQueueService = {
	async enqueue(): Promise<string> {
		return "noop-job";
	},
	async lease(_kinds?: readonly string[]): Promise<LeasedJob | null> {
		return null;
	},
	async complete(): Promise<void> {
		/* no-op stub */
	},
	async fail(): Promise<void> {
		/* no-op stub */
	},
	start(): void {
		/* no-op stub */
	},
	stop(): void {
		/* no-op stub */
	},
};
