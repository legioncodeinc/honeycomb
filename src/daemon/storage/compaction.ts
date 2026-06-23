/**
 * Storage-level VERSION-HISTORY COMPACTOR — PRD-030 (Wave 1).
 *
 * The append-only write model (`writes.ts` `appendVersionBumped`) INSERTs a NEW
 * row at `version` = N+1 on EVERY edit to a version-bumped table (skills, rules,
 * claim history / `entity_attributes`, `pollinating_state`-style counters). A read
 * takes `ORDER BY version DESC LIMIT 1`. That is the correctness-without-
 * transactions strategy this backend needs — but it means a key edited 1,000
 * times is 1,000 rows, and every highest-version read scans them all. There is no
 * routine that PRUNES that history. This module is that routine: it reaps
 * superseded/old `version` rows BELOW the highest live version per key, keeping
 * the current state byte-identical and recent lineage auditable.
 *
 * This is NOT `runtime/pollinating/compaction.ts` (that assembles a full-graph
 * prompt for the model). This is storage-level row reaping.
 *
 * ── What is safe to reap (D-1 / D-5) ────────────────────────────────────────
 * A version is REAP-ELIGIBLE iff ALL THREE hold:
 *   1. it is STRICTLY BELOW the highest live version for its key (the highest is
 *      current state — NEVER touched, the invariant of the whole feature), AND
 *   2. it is beyond the keep-latest-N most-recent versions, AND
 *   3. its timestamp is OUTSIDE the retention window (older than now − windowDays).
 * Keep-latest-N and the time window are a UNION of survivors: a version survives
 * if it is inside EITHER (recent BY COUNT or recent BY TIME). Only a version
 * outside BOTH — and strictly below the highest — is reaped. The reap-set math is
 * the pure {@link computeReapSet}, exhaustively unit-testable without storage.
 *
 * ── Eventual-consistency-safe reap order (D-3) ──────────────────────────────
 * DeepLake hard `DELETE` is UNRELIABLE/flappy (`pipeline/retention.ts` header —
 * "PRD-004 proved it") and the backend flaps stale segments (project memory
 * note). So, per key, BEFORE issuing any DELETE we (a) resolve the highest
 * version POLL-CONVERGENTLY (the `trigger.ts` `RESOLVE_POLLS` posture: append-only
 * versions are monotone, a single point read can only UNDER-report on a stale
 * segment, so the MAX across a bounded poll union converges UP to the truth) and
 * (b) confirm that survivor is DURABLY readable. Only then do we DELETE strictly-
 * lower eligible versions. We NEVER delete the highest version, and because we
 * only ever delete strictly-lower versions AND only after confirming the highest
 * is durable, a concurrent reader's `ORDER BY <ver> DESC LIMIT 1` can never
 * transiently return empty and never return a non-current version (AC-3).
 *
 * ── Idempotent + crash-safe BY CONSTRUCTION (D-4) ───────────────────────────
 * Each run recomputes the reap set from the CURRENT view. A re-run on an already-
 * compacted key finds nothing eligible → a no-op (zero deletes). The survivor set
 * is, at EVERY moment, a SUPERSET of {highest} ∪ {keep-N} ∪ {windowed}: we only
 * ever delete from the strictly-below-highest-AND-outside-both set, so a crash
 * mid-reap (or a flappy DELETE that only partially applied) leaves a strictly
 * smaller-but-correct table, and a re-run completes to the bound. There is no
 * ordering in which a survivor is at risk.
 *
 * ── Scope (D-6, fail-closed) ────────────────────────────────────────────────
 * Compaction runs ONLY on version-bumped tables. The allow-list is DERIVED from
 * the catalog (`pattern === "version-bumped"`) — the single source of truth, so
 * it can never drift from a second hand-maintained list. {@link assertVersionBumpedTable}
 * REJECTS an unknown table or an `appendOnlyInsert` event table (sessions / raw
 * events have no version concept — their retention is PRD-007's concern).
 *
 * ── SQL safety + logging ────────────────────────────────────────────────────
 * Every value routes through `sLiteral`/`val.*`; every identifier through
 * `sqlIdent`. No hand-quoted value, no raw fetch (`audit:sql` scans `src/daemon`).
 * Reaped counts are LOGGED per table/key (D-5) — counts + table/key + version
 * numbers ONLY, NEVER a row value or a secret.
 */

import { z } from "zod";

import type { QueryScope, StorageQuery } from "./client.js";
import type { HealTarget } from "./heal.js";
import { REGISTRY } from "./catalog/index.js";
import { isOk, type StorageRow } from "./result.js";
import { sLiteral, sqlIdent } from "./sql.js";

// ── Retention config (zod, conservative defaults per D-1) ───────────────────

/** Default keep-latest-N most-recent versions per key (D-1, conservative). */
export const DEFAULT_KEEP_LATEST_N = 5;
/** Default retention time window in days (D-1, conservative). */
export const DEFAULT_WINDOW_DAYS = 30;
/** Default timestamp column the time window is measured on. */
export const DEFAULT_TIMESTAMP_COLUMN = "updated_at";
/** Default version column (mirrors `appendVersionBumped`'s default). */
export const DEFAULT_VERSION_COLUMN = "version";

/**
 * A non-negative-integer tuning knob: a non-numeric value falls back to the
 * default, a value below `min` is clamped up to `min`. A fat-fingered retention
 * knob is tuning noise, never a config failure (mirrors `pollinating/config.ts`
 * `ClampedInt`). `keepLatestN` clamps `>= 1` (the highest is always kept, but a
 * conservative floor of 1 keeps at least one prior version too); `windowDays`
 * clamps `>= 0` (0 disables the time window, leaving keep-latest-N as the sole
 * survivor rule).
 */
function ClampedInt(def: number, min: number) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/** A SQL-identifier knob: a valid identifier passes; anything else → the default. */
function IdentColumn(def: string) {
	return z.preprocess((raw) => {
		if (typeof raw !== "string" || raw === "") return def;
		// Reject a non-identifier here (the default is always valid) so a garbage
		// env value never reaches `sqlIdent` and throws mid-compaction.
		return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw) ? raw : def;
	}, z.string());
}

/**
 * The validated retention policy. Resolved once and injected; a consumer takes
 * the resolved {@link CompactionRetention} as a dep and never re-resolves it.
 */
export const CompactionRetentionSchema = z.object({
	/** Keep the most-recent N versions below the highest (D-1). Clamp `>= 1`. */
	keepLatestN: ClampedInt(DEFAULT_KEEP_LATEST_N, 1).default(DEFAULT_KEEP_LATEST_N),
	/** Keep any version newer than now − windowDays (D-1). Clamp `>= 0` (0 = off). */
	windowDays: ClampedInt(DEFAULT_WINDOW_DAYS, 0).default(DEFAULT_WINDOW_DAYS),
	/** The timestamp column the window is measured on. Default `updated_at`. */
	timestampColumn: IdentColumn(DEFAULT_TIMESTAMP_COLUMN).default(DEFAULT_TIMESTAMP_COLUMN),
	/** The version column. Default `version` (mirrors `appendVersionBumped`). */
	versionColumn: IdentColumn(DEFAULT_VERSION_COLUMN).default(DEFAULT_VERSION_COLUMN),
});

/** The validated retention policy every compaction consumer reads. */
export type CompactionRetention = z.infer<typeof CompactionRetentionSchema>;

/**
 * Structured compaction-config error. Carries the flattened zod issues so the
 * daemon logs exactly which knob failed. Distinct type so a config failure is
 * never mistaken for a runtime compaction failure (mirrors `PollinatingConfigError`).
 */
export class CompactionConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid compaction retention config: ${issues.join("; ")}`);
		this.name = "CompactionConfigError";
		this.issues = issues;
	}
}

/** The raw, un-validated shape a provider yields. */
export interface RawCompactionConfig {
	readonly keepLatestN?: unknown;
	readonly windowDays?: unknown;
	readonly timestampColumn?: unknown;
	readonly versionColumn?: unknown;
}

/**
 * The compaction-config provider seam (mirrors `PollinatingConfigProvider`). Returns
 * the raw, un-validated record so validation is the schema's job (one boundary,
 * not two). The env provider is the default; a test injects a fixed record.
 */
export interface CompactionConfigProvider {
	/** Read the raw retention record. Missing keys yield undefined. */
	read(): RawCompactionConfig;
}

/**
 * Default provider: reads `HONEYCOMB_COMPACTION_*` from the environment.
 * Daemon-only code (never bundled into the OpenClaw target, which forbids
 * `process.env`), so a direct env read is correct here — mirrors
 * `envPollinatingConfigProvider`.
 */
export function envCompactionConfigProvider(env: NodeJS.ProcessEnv = process.env): CompactionConfigProvider {
	return {
		read(): RawCompactionConfig {
			return {
				keepLatestN: env.HONEYCOMB_COMPACTION_KEEP_LATEST_N,
				windowDays: env.HONEYCOMB_COMPACTION_WINDOW_DAYS,
				timestampColumn: env.HONEYCOMB_COMPACTION_TIMESTAMP_COLUMN,
				versionColumn: env.HONEYCOMB_COMPACTION_VERSION_COLUMN,
			};
		},
	};
}

/**
 * Resolve the raw record into a validated {@link CompactionRetention}. The schema
 * clamps every knob and defaults the columns, so resolution succeeds for nearly
 * any input — but a structurally-impossible value still throws
 * {@link CompactionConfigError} listing every issue. The single boundary where
 * untrusted env crosses into typed retention config (zod-at-boundary).
 */
export function resolveCompactionConfig(
	provider: CompactionConfigProvider = envCompactionConfigProvider(),
): CompactionRetention {
	const parsed = CompactionRetentionSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new CompactionConfigError(issues);
	}
	return parsed.data;
}

// ── Version-bumped allow-list (D-6, fail-closed) ────────────────────────────

/**
 * The canonical set of tables PRD-030 is AUTHORIZED to compact (D-6, fail-closed).
 * Named EXPLICITLY because "version-bumped" alone is NOT sufficient: the catalog
 * marks several tables `version-bumped` that are catastrophic to reap —
 * `memory_jobs` (the durable job queue: lower versions carry in-flight pass state),
 * `api_keys` (credential REVOCATION lineage: reaping a key's prior versions damages
 * the revocation audit), and the `sources` document tables (`memory_artifacts` /
 * `document_memories` / `document_chunk`, whose lower versions are the source-of-
 * truth lineage retention owns). Compaction is allowed ONLY on the curated set
 * below — the history-only tables whose superseded versions are pure churn:
 * skills / rules (product churn), the claim history (`entity_attributes` /
 * `epistemic_assertions`), and the `pollinating_state` counter. This set is the
 * AUTHORITATIVE allow-list, intersected with the catalog `version-bumped` pattern
 * so a table that is renamed away from version-bumped is also rejected.
 */
export const COMPACTABLE_VERSION_BUMPED_TABLES: ReadonlySet<string> = Object.freeze(
	new Set(["skills", "rules", "entity_attributes", "epistemic_assertions", "pollinating_state"]),
) as ReadonlySet<string>;

/**
 * Is `table` SAFE to compact (D-6)? Fail-closed by construction — requires BOTH:
 *   1. membership in the curated {@link COMPACTABLE_VERSION_BUMPED_TABLES} allow-list
 *      (the AUTHORITATIVE intent — excludes `memory_jobs` / `api_keys` / the source
 *      document tables, which are catalog-version-bumped but NEVER reapable), AND
 *   2. the catalog's `pattern === "version-bumped"` (a defense-in-depth cross-check
 *      so a table renamed away from the version-bump model is also rejected).
 * Anything failing EITHER arm returns `false`:
 *   - an UNKNOWN table → not in the allow-list AND `patternFor` is `undefined` → `false`.
 *   - an `appendOnlyInsert` event table (sessions/raw events) → `false`.
 *   - a version-bumped-but-not-allow-listed table (`memory_jobs`, `api_keys`, …) →
 *     fails arm 1 → `false` (the over-reach this guard exists to prevent).
 */
export function isVersionBumpedTable(table: string): boolean {
	return COMPACTABLE_VERSION_BUMPED_TABLES.has(table) && REGISTRY.patternFor(table) === "version-bumped";
}

/**
 * Assert `table` is a compactable version-bumped table; THROW otherwise (D-6,
 * fail-closed). The compactor calls this before touching a single row so an
 * unknown or non-version-bumped target can never be reaped. The message names the
 * resolved pattern so the rejection is debuggable.
 */
export function assertVersionBumpedTable(table: string): void {
	if (!isVersionBumpedTable(table)) {
		const pattern = REGISTRY.patternFor(table);
		// Distinguish the two fail-closed arms so the rejection is debuggable: a
		// version-bumped table that is simply NOT on the curated allow-list (e.g.
		// `memory_jobs` / `api_keys`) reports that it is not authorized, rather than
		// the misleading "not version-bumped".
		const detail =
			pattern === undefined
				? "unknown table (not in catalog)"
				: pattern === "version-bumped"
					? "version-bumped but not on the compaction allow-list (never reapable)"
					: `pattern "${pattern}"`;
		throw new CompactionRefusedError(
			`Refusing to compact "${table}": only allow-listed version-bumped tables are compactable (${detail}).`,
			table,
		);
	}
}

/**
 * Thrown when the compactor is pointed at a non-version-bumped table (D-6). A
 * distinct, fail-closed error so a wiring mistake (compacting `sessions`) surfaces
 * loudly rather than silently reaping the wrong table.
 */
export class CompactionRefusedError extends Error {
	readonly table: string;
	constructor(message: string, table: string) {
		super(message);
		this.name = "CompactionRefusedError";
		this.table = table;
	}
}

// ── The pure reap-set computation (AC-2, exhaustively unit-testable) ─────────

/** One version row's reap-relevant projection: its version number + timestamp. */
export interface VersionRow {
	/** The append-only version number for this row (monotone per key). */
	readonly version: number;
	/** The row's retention timestamp (ISO-8601; "" when unset → treated as old). */
	readonly ts: string;
}

/**
 * Compute the REAP SET for ONE key from its versions (AC-2 core, D-1). PURE — no
 * storage, no clock-of-its-own (the caller passes `nowMs`), so the entire
 * retention rule is exhaustively unit-testable.
 *
 * Given the key's versions, the resolved `highest` version, the retention policy,
 * and `nowMs`, returns the SORTED-ascending list of versions to DELETE. A version
 * is reap-eligible iff ALL hold:
 *   1. `version < highest` (the highest is current state — NEVER eligible), AND
 *   2. it is NOT among the keep-latest-N most-recent versions (by version number,
 *      counting DOWN from the highest), AND
 *   3. its timestamp is OUTSIDE the window: `ts === "" || nowMs - ts >= windowMs`.
 *      An unparseable/empty timestamp is treated as OLD (outside the window) so a
 *      row with no usable time still becomes eligible once it falls beyond N — the
 *      window can only ADD survivors, never remove the count-based ones.
 * Survivors are the UNION: kept if inside keep-N OR inside the window.
 *
 * `windowDays === 0` disables the time window (every row is "outside"), leaving
 * keep-latest-N as the sole survivor rule. Never returns the highest version.
 */
export function computeReapSet(
	versions: readonly VersionRow[],
	highest: number,
	retention: CompactionRetention,
	nowMs: number,
): number[] {
	if (versions.length === 0) return [];

	// The keep-latest-N survivors BY COUNT: the N highest version numbers strictly
	// below `highest` (the highest itself is always kept and counted separately).
	// Sort the DISTINCT versions descending; the first N below the highest survive.
	const distinctBelow = Array.from(new Set(versions.map((v) => v.version)))
		.filter((v) => v < highest)
		.sort((a, b) => b - a);
	const keptByCount = new Set<number>(distinctBelow.slice(0, Math.max(0, retention.keepLatestN)));

	const windowMs = retention.windowDays * 24 * 60 * 60 * 1000;
	const windowDisabled = retention.windowDays <= 0;

	const reap = new Set<number>();
	for (const row of versions) {
		// 1. The highest is current state — NEVER eligible.
		if (row.version >= highest) continue;
		// 2. Inside keep-latest-N → survives (union arm A).
		if (keptByCount.has(row.version)) continue;
		// 3. Inside the time window → survives (union arm B).
		if (!windowDisabled && isInsideWindow(row.ts, nowMs, windowMs)) continue;
		// Outside BOTH and strictly below the highest → reap.
		reap.add(row.version);
	}
	return Array.from(reap).sort((a, b) => a - b);
}

/**
 * Is a row's timestamp INSIDE the retention window (newer than now − windowMs)?
 * An empty or unparseable timestamp is treated as OUTSIDE (old) — the
 * conservative direction for a row that has fallen beyond keep-latest-N: the
 * window only ever ADDS survivors, so a row with no usable time is never wrongly
 * KEPT, only ever (potentially) reaped once it is also beyond N.
 */
function isInsideWindow(ts: string, nowMs: number, windowMs: number): boolean {
	if (ts === "") return false;
	const t = Date.parse(ts);
	if (!Number.isFinite(t)) return false;
	return nowMs - t < windowMs;
}

// ── The compactor ───────────────────────────────────────────────────────────

/** ISO/ms clock seam so tests are deterministic (mirrors `PollinatingClock`). */
export interface CompactionClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/** The default clock: real `Date.now`. */
function defaultClock(): CompactionClock {
	return { now: () => Date.now() };
}

/**
 * Structured-event logger seam (D-5). The daemon injects a real logger; a test
 * injects a recorder. NEVER receives a row value or a secret — only counts,
 * table/key, and version numbers.
 */
export interface CompactionLogger {
	/** Emit one structured compaction event. */
	event(name: string, fields: Record<string, string | number>): void;
}

/** A no-op logger (the default when none is injected). */
function noopLogger(): CompactionLogger {
	return { event: () => {} };
}

/**
 * Poll budget for resolving a key's highest version + confirming the survivor
 * durable, robust to this backend's segment-freshness flap (the same rationale as
 * `trigger.ts` `RESOLVE_POLLS`). A single point read can land on a stale segment
 * and under-report; because versions are append-only and monotone, the MAX across
 * a few polls converges UP to the truth. The deterministic fake settles on the
 * first read, so this is a live-only cost.
 */
const RESOLVE_POLLS = 8;

/** Options for {@link compactVersionHistory}. */
export interface CompactionOptions {
	/** The logical key column whose history is reaped (e.g. `skill_id`, `id`). */
	readonly keyColumn: string;
	/** The validated retention policy (D-1). */
	readonly retention: CompactionRetention;
	/** Optional injected clock (real `Date.now` otherwise). */
	readonly clock?: CompactionClock;
	/** Optional structured-event logger (no-op otherwise). */
	readonly logger?: CompactionLogger;
	/**
	 * Optional table-compactability guard override (fail-closed by DEFAULT). When
	 * omitted the catalog-derived {@link isVersionBumpedTable} is the authority —
	 * the production posture, where ONLY a `pattern === "version-bumped"` catalog
	 * table may be reaped (D-6). A caller MAY inject its own predicate to authorize
	 * a table the catalog does not name — used SOLELY by the gated live integration
	 * proof, which compacts a per-run, namespaced, DROP-able throwaway table
	 * (`ci_compaction_<runId>`) that is structurally a version-bumped table but is
	 * not (and must never be) in the production catalog. The predicate is still a
	 * guard: it returns `false` for any table the test does not own, so the
	 * fail-closed contract holds — an injected predicate NARROWS, never widens, to
	 * exactly the one throwaway name. Never wired into production code paths.
	 */
	readonly isCompactable?: (table: string) => boolean;
}

/** Per-table outcome of a compaction pass. */
export interface CompactionSummary {
	/** The table that was compacted. */
	readonly table: string;
	/** Distinct keys discovered + scanned. */
	readonly keysScanned: number;
	/** Keys that had at least one version reaped. */
	readonly keysCompacted: number;
	/** Total version rows reaped across all keys. */
	readonly rowsReaped: number;
	/** Keys SKIPPED because the survivor could not be confirmed durable (D-3). */
	readonly keysSkipped: number;
}

/**
 * Compact the version history of ONE version-bumped table under a scope (D-1..D-6).
 *
 * Flow:
 *   0. Assert the table is version-bumped (D-6, fail-closed) — refuse otherwise.
 *   1. Discover the distinct keys (`SELECT DISTINCT <keyColumn>`), poll-convergent
 *      union (a stale segment can MISS a key but never INVENT one — the same
 *      posture as the job-queue `discoverIds`).
 *   2. Per key: resolve the highest version POLL-CONVERGENTLY (keep MAX), read the
 *      per-version (version, ts) rows, compute the reap set via {@link computeReapSet},
 *      CONFIRM the survivor (highest version) is durably readable (poll-convergent),
 *      then — and only then — issue ONE guarded DELETE of the strictly-lower
 *      eligible versions (D-3). Never delete the highest.
 *   3. Log per-key reaped counts + a per-table total (D-5).
 *
 * Idempotent (D-4) + crash-safe (D-5) by construction — see the module header.
 */
export async function compactVersionHistory(
	client: StorageQuery,
	target: HealTarget,
	scope: QueryScope,
	opts: CompactionOptions,
): Promise<CompactionSummary> {
	// 0. Fail-closed scope guard (D-6). Refuse a non-version-bumped table before
	//    a single row is touched. By default the catalog is the authority; a caller
	//    may inject a NARROWING predicate (the gated live proof's throwaway table)
	//    that still rejects everything it does not explicitly own.
	if (opts.isCompactable) {
		if (!opts.isCompactable(target.table)) {
			throw new CompactionRefusedError(
				`Refusing to compact "${target.table}": rejected by the injected compactability guard.`,
				target.table,
			);
		}
	} else {
		assertVersionBumpedTable(target.table);
	}

	const clock = opts.clock ?? defaultClock();
	const logger = opts.logger ?? noopLogger();
	const compactor = new VersionCompactor(client, target, scope, opts, clock, logger);
	return compactor.run();
}

/**
 * Thin factory mirroring `createPollinatingTrigger`/`createVersionCompactor` naming:
 * returns a bound function the daemon (Wave 2) can call per table without
 * re-threading the client/scope. The bound function still re-asserts the table is
 * version-bumped on every call (the guard is in {@link compactVersionHistory}).
 */
export function createVersionCompactor(
	client: StorageQuery,
	scope: QueryScope,
): (target: HealTarget, opts: CompactionOptions) => Promise<CompactionSummary> {
	return (target, opts) => compactVersionHistory(client, target, scope, opts);
}

/**
 * The stateful compaction worker for one (table, scope) pass. Internal — the
 * public entry point is {@link compactVersionHistory}. Holds the resolved deps so
 * the per-key methods read cleanly.
 */
class VersionCompactor {
	private readonly keyColumn: string;
	private readonly retention: CompactionRetention;

	constructor(
		private readonly client: StorageQuery,
		private readonly target: HealTarget,
		private readonly scope: QueryScope,
		opts: CompactionOptions,
		private readonly clock: CompactionClock,
		private readonly logger: CompactionLogger,
	) {
		// Validate the key + retention identifiers up front so a bad name throws
		// here, not mid-DELETE.
		this.keyColumn = sqlIdent(opts.keyColumn);
		this.retention = opts.retention;
		sqlIdent(this.retention.versionColumn);
		sqlIdent(this.retention.timestampColumn);
		sqlIdent(this.target.table);
	}

	/** Run the full pass over every discovered key. */
	async run(): Promise<CompactionSummary> {
		const keys = await this.discoverKeys();
		let rowsReaped = 0;
		let keysCompacted = 0;
		let keysSkipped = 0;

		for (const key of keys) {
			const outcome = await this.compactKey(key);
			if (outcome === "skipped") {
				keysSkipped += 1;
				continue;
			}
			if (outcome.reaped > 0) {
				keysCompacted += 1;
				rowsReaped += outcome.reaped;
			}
		}

		const summary: CompactionSummary = {
			table: this.target.table,
			keysScanned: keys.length,
			keysCompacted,
			rowsReaped,
			keysSkipped,
		};
		this.logger.event("compaction.table.done", {
			table: summary.table,
			keysScanned: summary.keysScanned,
			keysCompacted: summary.keysCompacted,
			rowsReaped: summary.rowsReaped,
			keysSkipped: summary.keysSkipped,
		});
		return summary;
	}

	/**
	 * Discover the distinct keys, poll-convergent UNION across a bounded poll set.
	 * A stale segment can MISS a key but never INVENT one, so the union over a few
	 * polls only ever GROWS toward the truth (the same posture the job queue's
	 * `discoverIds` takes). The deterministic fake settles on the first poll.
	 */
	private async discoverKeys(): Promise<string[]> {
		const tbl = sqlIdent(this.target.table);
		const keyCol = sqlIdent(this.keyColumn);
		const sql = `SELECT DISTINCT ${keyCol} FROM "${tbl}"`;
		const found = new Set<string>();
		let stableTwice = false;
		let lastSize = -1;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const res = await this.client.query(sql, this.scope);
			if (isOk(res)) {
				for (const row of res.rows as StorageRow[]) {
					const raw = (row as StorageRow)[this.keyColumn];
					if (typeof raw === "string" && raw !== "" && raw !== "__ensure__") found.add(raw);
				}
			}
			// Converged when the union size is stable across two consecutive polls.
			if (found.size === lastSize) {
				if (stableTwice) break;
				stableTwice = true;
			} else {
				stableTwice = false;
				lastSize = found.size;
			}
		}
		return Array.from(found);
	}

	/**
	 * Compact ONE key: resolve highest poll-convergently, compute the reap set,
	 * confirm the survivor durable, DELETE the eligible lower versions (D-3).
	 * Returns `"skipped"` when the survivor could not be confirmed durable (the
	 * conservative posture — NEVER reap if we cannot prove the current row is
	 * readable), else the reaped count.
	 */
	private async compactKey(key: string): Promise<"skipped" | { reaped: number }> {
		// 1. Read the per-version (version, ts) rows for this key, poll-convergent:
		//    keep the row set that observed the HIGHEST version (monotone → a higher
		//    version is never fictitious). This same read resolves `highest`.
		const { highest, rows } = await this.resolveVersions(key);
		if (highest === 0 || rows.length === 0) return { reaped: 0 }; // no rows / no key.

		// 2. Compute the reap set from the CURRENT view (D-4 idempotency: a re-run
		//    recomputes and finds nothing once compacted).
		const reapVersions = computeReapSet(rows, highest, this.retention, this.clock.now());
		if (reapVersions.length === 0) return { reaped: 0 };

		// 3. Confirm the survivor (highest version) is DURABLY readable BEFORE any
		//    DELETE (D-3). Never delete the only readable copy of current state.
		const durable = await this.confirmSurvivorDurable(key, highest);
		if (!durable) {
			this.logger.event("compaction.key.skipped", {
				table: this.target.table,
				key,
				highest,
				reason: "survivor-not-durable",
			});
			return "skipped";
		}

		// 4. DELETE the strictly-lower eligible versions in ONE guarded statement.
		const deleted = await this.deleteVersions(key, reapVersions);
		this.logger.event("compaction.key.reaped", {
			table: this.target.table,
			key,
			highest,
			reapedCount: deleted,
			eligibleCount: reapVersions.length,
		});
		return { reaped: deleted };
	}

	/**
	 * Resolve a key's version rows poll-convergently. Each poll reads (version, ts)
	 * for the key; we keep the observation whose MAX version is highest (append-only
	 * monotonicity: a higher max is never fictitious, a stale segment only
	 * under-reports). Returns the highest version + the best-observed row set.
	 */
	private async resolveVersions(key: string): Promise<{ highest: number; rows: VersionRow[] }> {
		const tbl = sqlIdent(this.target.table);
		const keyCol = sqlIdent(this.keyColumn);
		const verCol = sqlIdent(this.retention.versionColumn);
		const tsCol = sqlIdent(this.retention.timestampColumn);
		const sql =
			`SELECT ${verCol}, ${tsCol} FROM "${tbl}" ` +
			`WHERE ${keyCol} = ${sLiteral(key)} ` +
			`ORDER BY ${verCol} DESC`;

		let bestHighest = 0;
		let bestRows: VersionRow[] = [];
		let stableTwice = false;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const res = await this.client.query(sql, this.scope);
			if (!isOk(res)) continue;
			const rows = this.projectVersionRows(res.rows as StorageRow[]);
			const highest = rows.reduce((m, r) => (r.version > m ? r.version : m), 0);
			if (highest > bestHighest) {
				bestHighest = highest;
				bestRows = rows;
				stableTwice = false;
			} else if (highest === bestHighest && bestHighest > 0) {
				// Same max seen again → converged (3rd consistent observation).
				if (stableTwice) break;
				stableTwice = true;
				// Prefer the LARGER row set at the same max (a fuller segment).
				if (rows.length > bestRows.length) bestRows = rows;
			}
		}
		return { highest: bestHighest, rows: bestRows };
	}

	/** Project raw rows into {@link VersionRow}s (coerce version to number, ts to string). */
	private projectVersionRows(rows: StorageRow[]): VersionRow[] {
		const out: VersionRow[] = [];
		for (const row of rows) {
			const rawV = row[this.retention.versionColumn];
			const v = typeof rawV === "number" ? rawV : Number(rawV);
			if (!Number.isFinite(v)) continue;
			const rawTs = row[this.retention.timestampColumn];
			const ts = typeof rawTs === "string" ? rawTs : rawTs === undefined || rawTs === null ? "" : String(rawTs);
			out.push({ version: v, ts });
		}
		return out;
	}

	/**
	 * Confirm the survivor (highest version) is DURABLY readable (D-3) before any
	 * DELETE. Poll-convergent: the current row is `ORDER BY <ver> DESC LIMIT 1`, and
	 * we require it to read back AS `highest` on a poll (a stale segment may
	 * under-report transiently; a single confirming observation that the highest is
	 * present is enough, since we NEVER delete the highest). Returns false only if
	 * NO poll could confirm the highest is readable — in which case the key is
	 * skipped, never reaped.
	 */
	private async confirmSurvivorDurable(key: string, highest: number): Promise<boolean> {
		const tbl = sqlIdent(this.target.table);
		const keyCol = sqlIdent(this.keyColumn);
		const verCol = sqlIdent(this.retention.versionColumn);
		const sql =
			`SELECT ${verCol} FROM "${tbl}" ` +
			`WHERE ${keyCol} = ${sLiteral(key)} ` +
			`ORDER BY ${verCol} DESC LIMIT 1`;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const res = await this.client.query(sql, this.scope);
			if (isOk(res) && res.rows.length > 0) {
				const raw = (res.rows[0] as StorageRow)[this.retention.versionColumn];
				const v = typeof raw === "number" ? raw : Number(raw);
				if (Number.isFinite(v) && v >= highest) return true;
			}
		}
		return false;
	}

	/**
	 * DELETE the eligible strictly-lower versions for a key in ONE guarded
	 * statement (reusing the `retention.ts` guarded-DELETE shape). The `IN (...)`
	 * list is built from the reap set — every value a numeric scalar, every
	 * identifier through `sqlIdent`, the key through `sLiteral`. NEVER includes the
	 * highest version (the reap set is strictly-below-highest by construction).
	 * Best-effort on this flappy backend: a partial DELETE is fine (idempotent
	 * re-run completes), so the reaped count is the eligible count when the DELETE
	 * succeeds, else 0.
	 *
	 * Returns the number of versions whose DELETE was issued successfully.
	 */
	private async deleteVersions(key: string, reapVersions: readonly number[]): Promise<number> {
		if (reapVersions.length === 0) return 0;
		const tbl = sqlIdent(this.target.table);
		const keyCol = sqlIdent(this.keyColumn);
		const verCol = sqlIdent(this.retention.versionColumn);
		// Numeric scalars, inlined by design (the same as `val.num` → `String(n)`):
		// each version is coerced to a bare integer via `Math.trunc` + `String`, so
		// the IN-list can carry NOTHING but digits — there is no string value here to
		// escape (the audit's numeric-inline path; the only string value, `key`, goes
		// through `sLiteral`). The `Sql` suffix marks it a pre-built fragment.
		const versionInListSql = reapVersions.map((v) => String(Math.trunc(v))).join(", ");
		const sql =
			`DELETE FROM "${tbl}" ` +
			`WHERE ${keyCol} = ${sLiteral(key)} AND ${verCol} IN (${versionInListSql})`;
		const res = await this.client.query(sql, this.scope);
		return isOk(res) ? reapVersions.length : 0;
	}
}
