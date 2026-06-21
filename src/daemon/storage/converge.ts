/**
 * Read-your-writes convergence seam (PRD-028).
 *
 * DeepLake is eventually consistent: it flaps stale segments, so a read issued
 * immediately after a write can land on a segment that has not yet caught up and
 * UNDER-report — the just-written row is missing, a counter looks un-incremented,
 * a row-count is short — then a beat later it is there. Today every live itest
 * that does a write→read-back hand-rolls its own "poll until it shows up" loop;
 * each copy drifts its own budget and the duplication is a jscpd trap. This is the
 * SINGLE home of that convergence (mirroring `result.ts` / `heal.ts` as the one
 * home of their concern): the logic lives here once, and call sites + the itest
 * harness consume it.
 *
 * ── How it differs from the client's transient-retry (`client.ts`) ──────────
 * `StorageClient.query` ALREADY retries on TRANSPORT failures — a `connection_error`
 * / `timeout` / transient-5xx flap (the sibling fix in #50, `isTransientResult`).
 * That retry fires on a NON-OK result. `readConverged` is COMPLEMENTARY and
 * DIFFERENT: it polls on OK results until a freshness PREDICATE holds — the
 * stale-segment under-report case, where the read SUCCEEDS but returns data that is
 * not yet fresh. A transport failure short-circuits naturally: the predicate won't
 * hold against a non-ok result, so the budget governs and the last real
 * `QueryResult` is returned (fail-soft, never a throw).
 *
 * ── The contract (D-1 / D-2 / D-3) ─────────────────────────────────────────
 *   readConverged(client, sql, scope, predicate, opts?) → Promise<QueryResult>
 *
 * - OPT-IN per read (D-2). `query` stays the default; `readConverged` is the
 *   explicit choice a read-your-writes caller makes (store→recall, the live itests).
 *   Most reads tolerate slight staleness and never pay this cost.
 * - The caller supplies a `predicate: (result) => boolean` — "this result is fresh
 *   enough" (row present / version ≥ N / row count ≥ k). The predicate is DERIVED
 *   from the write's WATERMARK (id+version), not guessed: DeepLake exposes no
 *   read-after-write token at the transport, so the WRITE path supplies the cursor
 *   that makes the predicate exact (D-1).
 * - Bounded budget (D-3): poll `client.query` until `predicate(result)` holds OR
 *   the budget exhausts (max attempts, jittered backoff with a cap, max wall-clock),
 *   then return the LAST `QueryResult` either way. On exhaustion it returns the last
 *   real read (typically a smaller-than-expected `ok`) — it NEVER fabricates the
 *   awaited row and NEVER throws past the closed union. A stale read under-reports;
 *   it must not lie. The budget is env-overridable (`HONEYCOMB_READ_CONVERGE_*`),
 *   coerce-and-clamped like `dreaming/config.ts` so a fat-fingered env never throws.
 * - Injectable clock + sleep seam (default real `node:timers/promises`) so the unit
 *   tests are fast + deterministic: the fake settles instantly and the wall-clock
 *   bound is proven without real time passing.
 *
 * ── No secret in any trace (D-5) ────────────────────────────────────────────
 * The convergence trace (gated by `HONEYCOMB_TRACE_SQL`) summarizes the SQL and the
 * attempt count and redacts the org via the same `redactToken` discipline the client
 * uses; no token is EVER put into a trace line. The trace sink is injectable so a
 * test can record the lines and assert redaction purely, with no live backend.
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 * This seam adds NO raw SQL: it calls `client.query` with the SQL the caller already
 * built through the 002b guards. The watermark/predicate helpers are pure and never
 * interpolate — they read fields off a `StorageRow` and compare.
 */

import { setTimeout as delay } from "node:timers/promises";
import { redactToken } from "./config.js";
import type { QueryScope, StorageQuery } from "./client.js";
import { isOk, type QueryResult, type StorageRow } from "./result.js";

// ── Budget config (D-3): coerce-and-clamp, never throw ──────────────────────
//
// Mirrors `dreaming/config.ts`: the budget is a TUNING knob, so a fat-fingered env
// value falls back to its default or clamps to a floor — it never takes the daemon
// down. The defaults are the PRD's ~2s wall-clock / ~10 attempts.

/** Default max poll attempts before the budget gives up (~10, D-3). */
export const DEFAULT_CONVERGE_MAX_ATTEMPTS = 10;
/** Default total wall-clock budget across all attempts (~2s, D-3). */
export const DEFAULT_CONVERGE_MAX_WALL_CLOCK_MS = 2_000;
/** Default base backoff before the first re-poll (ms). Short — the flap is brief. */
export const DEFAULT_CONVERGE_BACKOFF_BASE_MS = 25;
/** Default backoff ceiling (ms): exponential growth is capped so the budget stays tight. */
export const DEFAULT_CONVERGE_BACKOFF_CAP_MS = 250;

/** The resolved, validated convergence budget every `readConverged` call honors. */
export interface ConvergeBudget {
	/** Hard cap on poll attempts (≥ 1). */
	readonly maxAttempts: number;
	/** Hard cap on total wall-clock across all attempts, in ms (≥ 0). */
	readonly maxWallClockMs: number;
	/** Base backoff before the first re-poll, in ms (≥ 0). */
	readonly backoffBaseMs: number;
	/** Backoff ceiling, in ms (≥ backoffBaseMs). */
	readonly backoffCapMs: number;
}

/** The frozen default budget (the PRD's ~2s / ~10 attempts). */
export const DEFAULT_CONVERGE_BUDGET: ConvergeBudget = Object.freeze({
	maxAttempts: DEFAULT_CONVERGE_MAX_ATTEMPTS,
	maxWallClockMs: DEFAULT_CONVERGE_MAX_WALL_CLOCK_MS,
	backoffBaseMs: DEFAULT_CONVERGE_BACKOFF_BASE_MS,
	backoffCapMs: DEFAULT_CONVERGE_BACKOFF_CAP_MS,
});

/** A partial budget override a caller may pass per-read (each field clamped). */
export interface ConvergeBudgetOverride {
	readonly maxAttempts?: number;
	readonly maxWallClockMs?: number;
	readonly backoffBaseMs?: number;
	readonly backoffCapMs?: number;
}

/**
 * Coerce one numeric knob: a non-finite value falls back to `def`, a value below
 * `min` clamps up to `min`, and the result is truncated to an integer. Pure;
 * mirrors `dreaming/config.ts`'s `ClampedInt` so a bad env is tuning noise, never a
 * config failure.
 */
function clampInt(raw: unknown, def: number, min: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return def;
	return Math.max(min, Math.trunc(n));
}

/**
 * The raw, un-validated budget shape a provider yields (env strings or undefined).
 * Validation is `resolveConvergeBudget`'s job — one boundary, not two.
 */
export interface RawConvergeBudget {
	readonly maxAttempts?: unknown;
	readonly maxWallClockMs?: unknown;
	readonly backoffBaseMs?: unknown;
	readonly backoffCapMs?: unknown;
}

/** The budget provider seam (mirrors the dreaming-config provider). */
export interface ConvergeBudgetProvider {
	/** Read the raw budget record; missing keys yield undefined. */
	read(): RawConvergeBudget;
}

/**
 * Default provider: reads `HONEYCOMB_READ_CONVERGE_*` from the environment.
 * Daemon-only code, so a direct env read is correct here (mirrors the dreaming env
 * provider). `HONEYCOMB_READ_CONVERGE_MS` is the headline wall-clock knob the PRD
 * names; the attempt/backoff knobs are also overridable for the live suite to tune
 * without a code change.
 */
export function envConvergeBudgetProvider(env: NodeJS.ProcessEnv = process.env): ConvergeBudgetProvider {
	return {
		read(): RawConvergeBudget {
			return {
				maxAttempts: env.HONEYCOMB_READ_CONVERGE_ATTEMPTS,
				maxWallClockMs: env.HONEYCOMB_READ_CONVERGE_MS,
				backoffBaseMs: env.HONEYCOMB_READ_CONVERGE_BACKOFF_BASE_MS,
				backoffCapMs: env.HONEYCOMB_READ_CONVERGE_BACKOFF_CAP_MS,
			};
		},
	};
}

/**
 * Resolve a raw record (env + optional per-call override, override winning
 * per-field) into a validated {@link ConvergeBudget}. Every knob is coerce-and-
 * clamped so resolution succeeds for nearly any input. The backoff ceiling is
 * additionally floored at the base so an inverted pair (cap < base) can never make
 * the backoff math nonsensical. Pure given its inputs.
 */
export function resolveConvergeBudget(
	provider: ConvergeBudgetProvider = envConvergeBudgetProvider(),
	override: ConvergeBudgetOverride = {},
): ConvergeBudget {
	const raw = provider.read();
	const pick = (o: unknown, r: unknown): unknown => (o !== undefined ? o : r);
	const maxAttempts = clampInt(pick(override.maxAttempts, raw.maxAttempts), DEFAULT_CONVERGE_MAX_ATTEMPTS, 1);
	const maxWallClockMs = clampInt(pick(override.maxWallClockMs, raw.maxWallClockMs), DEFAULT_CONVERGE_MAX_WALL_CLOCK_MS, 0);
	const backoffBaseMs = clampInt(pick(override.backoffBaseMs, raw.backoffBaseMs), DEFAULT_CONVERGE_BACKOFF_BASE_MS, 0);
	const backoffCapMs = clampInt(pick(override.backoffCapMs, raw.backoffCapMs), DEFAULT_CONVERGE_BACKOFF_CAP_MS, backoffBaseMs);
	return { maxAttempts, maxWallClockMs, backoffBaseMs, backoffCapMs };
}

// ── Clock + sleep + trace seams (injectable for fast, deterministic tests) ───

/** A sleep seam: a test injects a no-op so the bounded backoff costs zero wall-clock. */
export type SleepFn = (ms: number) => Promise<void>;

/** A clock seam: a test injects a fake `now` so the wall-clock bound is deterministic. */
export interface ConvergeClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/**
 * A trace sink seam (D-5). A test injects a recording sink and asserts the lines
 * carry no token and no full org (redaction proof). The default writes to stderr,
 * exactly like the client's `traceSql`.
 */
export type ConvergeTraceSink = (line: string) => void;

/** Default sleep: the real timer. */
const realSleep: SleepFn = (ms) => delay(ms);

/** Default clock: real `Date.now`. */
const realClock: ConvergeClock = { now: () => Date.now() };

/** Default trace sink: stderr, namespaced like the client's `[deeplake-sql]` lines. */
const stderrTraceSink: ConvergeTraceSink = (line) => {
	process.stderr.write(`[deeplake-converge] ${line}\n`);
};

/** Summarize SQL to one short line (mirrors `client.ts`'s `summarizeSql`). */
function summarizeSql(sql: string, maxLen = 220): string {
	const compact = sql.replace(/\s+/g, " ").trim();
	return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Per-call options for {@link readConverged}. All optional; sensible defaults. */
export interface ReadConvergedOptions {
	/**
	 * Override the resolved budget per-call. Each field is clamped through
	 * {@link resolveConvergeBudget}; omitted fields fall back to env then default.
	 * The live suite uses this (and the env knobs) to tune without a code change.
	 */
	readonly budget?: ConvergeBudgetOverride;
	/** Inject the budget provider (tests). Defaults to the env provider. */
	readonly budgetProvider?: ConvergeBudgetProvider;
	/** Inject the backoff clock-sleep (tests). Defaults to the real timer. */
	readonly sleep?: SleepFn;
	/** Inject the wall-clock clock (tests). Defaults to real `Date.now`. */
	readonly clock?: ConvergeClock;
	/**
	 * Force-enable the convergence trace. When omitted the trace follows
	 * `HONEYCOMB_TRACE_SQL` (the same gate the client honors). Tests pass `true`
	 * with a recording sink to assert redaction.
	 */
	readonly trace?: boolean;
	/** Inject the trace sink (tests). Defaults to stderr. */
	readonly traceSink?: ConvergeTraceSink;
	/** Per-statement query options forwarded to each `client.query` poll. */
	readonly queryTimeoutMs?: number;
}

/**
 * Compute the jittered backoff for a given (1-based) attempt, capped at the
 * ceiling. Full jitter over `[0, exp]` de-correlates concurrent pollers so a fleet
 * of workers doesn't re-stampede the backend in lockstep — the same posture as the
 * client's read-retry backoff.
 */
function backoffFor(attempt: number, budget: ConvergeBudget): number {
	const exp = Math.min(budget.backoffBaseMs * 2 ** (attempt - 1), budget.backoffCapMs);
	return Math.floor(Math.random() * exp);
}

/**
 * Poll a read until it converges on freshly-written data, or the bounded budget
 * exhausts — the read-your-writes seam (D-1 / D-2 / D-3).
 *
 * Issues `client.query(sql, scope)` and tests the supplied `predicate` against the
 * result. If the predicate holds, returns that result immediately (the converged
 * read). Otherwise it backs off (jittered, capped) and re-polls, until EITHER the
 * attempt cap is hit OR the next backoff would breach the wall-clock budget — at
 * which point it returns the LAST `QueryResult` it actually observed.
 *
 * Guarantees (the load-bearing invariants):
 *   - NEVER throws past the closed union: a transport failure is a `QueryResult`
 *     kind (the client maps it), the predicate simply won't hold against it, and the
 *     budget governs → the last real non-ok result is returned (fail-soft, D-3).
 *   - NEVER invents a row: the returned result is always one the client produced.
 *     On exhaustion the caller gets the real (possibly under-reporting) last read and
 *     branches on `kind` / row contents — the seam does not fabricate the awaited row.
 *   - ALWAYS bounded: at most `maxAttempts` polls and never sleeps past
 *     `maxWallClockMs`; with the fake clock a test proves it returns within the bound
 *     and never hangs.
 *
 * The trace (D-5) is gated by `opts.trace ?? HONEYCOMB_TRACE_SQL`, summarizes the
 * SQL + attempt count, and redacts the org via `redactToken` — no token ever.
 */
export async function readConverged(
	client: StorageQuery,
	sql: string,
	scope: QueryScope,
	predicate: (result: QueryResult) => boolean,
	opts: ReadConvergedOptions = {},
): Promise<QueryResult> {
	const budget = resolveConvergeBudget(opts.budgetProvider ?? envConvergeBudgetProvider(), opts.budget ?? {});
	const sleep = opts.sleep ?? realSleep;
	const clock = opts.clock ?? realClock;
	// Trace gate: an explicit `opts.trace` wins; otherwise follow `HONEYCOMB_TRACE_SQL`
	// (the same env gate the client's `traceSql` honors). No token ever in a line.
	const traceEnabled = opts.trace !== undefined ? opts.trace : process.env.HONEYCOMB_TRACE_SQL === "1";
	const sink = opts.traceSink ?? stderrTraceSink;
	const summary = summarizeSql(sql);
	const queryOpts = opts.queryTimeoutMs !== undefined ? { timeoutMs: opts.queryTimeoutMs } : undefined;

	const trace = (line: string): void => {
		if (traceEnabled) sink(line);
	};

	// Mark the deadline once, off the injected clock, so the wall-clock bound is
	// deterministic under a fake clock and honest under the real one.
	const startedAt = clock.now();
	const deadline = startedAt + budget.maxWallClockMs;

	trace(`start org=${redactToken(scope.org)} max=${budget.maxAttempts} budgetMs=${budget.maxWallClockMs} :: ${summary}`);

	let last: QueryResult | undefined;
	for (let attempt = 1; attempt <= budget.maxAttempts; attempt++) {
		const result = await client.query(sql, scope, queryOpts);
		last = result;

		if (predicate(result)) {
			trace(`converged attempt=${attempt}/${budget.maxAttempts} kind=${result.kind} :: ${summary}`);
			return result;
		}

		// Not fresh yet. Stop if this was the last allowed attempt, or if backing
		// off would breach the wall-clock budget — in either case return `last`.
		if (attempt >= budget.maxAttempts) break;
		const wait = backoffFor(attempt, budget);
		if (clock.now() + wait > deadline) {
			trace(`budget-exhausted-walltime attempt=${attempt}/${budget.maxAttempts} kind=${result.kind} :: ${summary}`);
			return result;
		}
		await sleep(wait);
	}

	// Every attempt observed a not-fresh result; surface the last real read. The
	// `last` is always defined here (the loop runs ≥ 1 time since maxAttempts ≥ 1).
	const finalResult = last as QueryResult;
	trace(`budget-exhausted-attempts kind=${finalResult.kind} :: ${summary}`);
	return finalResult;
}

// ── Watermark API (D-1) ─────────────────────────────────────────────────────
//
// The WRITE path emits a watermark (id + optional version); the READ path derives
// its predicate from that watermark, so "fresh enough" is EXACT, not a fuzzy wait.
// DeepLake gives no transport read-after-write token, so this id+version cursor IS
// the freshness signal.

/**
 * The read-after-write watermark a controlled write emits: the id of the row just
 * written, plus (for a version-bumped table) the version it was written at. A read
 * has caught up when a row with this id is present AND (if `version` is set) its
 * version is ≥ this watermark's version.
 */
export interface ReadWatermark {
	/** The id (or logical-key value) of the just-written row. */
	readonly id: string;
	/** The version the row was written at, for a version-bumped table. Optional. */
	readonly version?: number;
}

/**
 * Build a {@link ReadWatermark} from the pieces a caller already holds after a
 * write. `appendVersionBumped` returns `{ result, version }` and the caller passed
 * the key — so the watermark is assembled from the key value + the returned version
 * with no change to the write's return shape (additive, per the PRD). For an
 * unversioned write (e.g. `updateOrInsertByKey`) omit `version`.
 */
export function watermarkOf(keyValue: string, version?: number): ReadWatermark {
	return version === undefined ? { id: keyValue } : { id: keyValue, version };
}

/** Options for {@link watermarkPredicate}: which columns carry the id and version. */
export interface WatermarkPredicateOptions {
	/** The column the watermark id is matched against. Defaults to `"id"`. */
	readonly idColumn?: string;
	/** The column the watermark version is compared against. Defaults to `"version"`. */
	readonly versionColumn?: string;
}

/** Coerce a row cell to a finite number (NaN-safe), or `undefined` when absent/garbage. */
function rowNumberOrUndefined(row: StorageRow, column: string): number | undefined {
	const raw = row[column];
	if (raw === undefined || raw === null) return undefined;
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/** Compare a row cell to a string watermark id (string-coerced, so `'7'` matches `7`). */
function rowMatchesId(row: StorageRow, idColumn: string, id: string): boolean {
	const raw = row[idColumn];
	if (raw === undefined || raw === null) return false;
	return typeof raw === "string" ? raw === id : String(raw) === id;
}

/**
 * Derive a freshness predicate from a write's {@link ReadWatermark} (D-1). The
 * returned predicate answers "this result has caught up to the write": a row whose
 * `idColumn === wm.id` is present AND — when `wm.version` is set — that row's
 * `versionColumn` is ≥ `wm.version` (monotone, since versions are append-only and
 * only ever climb). A non-ok result is never fresh (the predicate returns false),
 * so a transport failure naturally lets the budget govern (fail-soft).
 *
 * When several rows share the id (a version-bumped table returns one per version),
 * the predicate is satisfied if ANY row meets the version floor — the highest
 * version having landed is exactly the read-your-writes signal.
 */
export function watermarkPredicate(
	wm: ReadWatermark,
	opts: WatermarkPredicateOptions = {},
): (result: QueryResult) => boolean {
	const idColumn = opts.idColumn ?? "id";
	const versionColumn = opts.versionColumn ?? "version";
	return (result: QueryResult): boolean => {
		if (!isOk(result)) return false;
		return result.rows.some((row) => {
			if (!rowMatchesId(row, idColumn, wm.id)) return false;
			if (wm.version === undefined) return true;
			const v = rowNumberOrUndefined(row, versionColumn);
			return v !== undefined && v >= wm.version;
		});
	};
}

// ── Common predicate builders ───────────────────────────────────────────────

/**
 * "A row whose `idColumn === id` is present." The simplest read-your-writes check
 * for an unversioned write. A non-ok result is never fresh.
 */
export function rowPresent(idColumn: string, id: string): (result: QueryResult) => boolean {
	return (result: QueryResult): boolean => {
		if (!isOk(result)) return false;
		return result.rows.some((row) => rowMatchesId(row, idColumn, id));
	};
}

/**
 * "At least `k` rows are present." For a read that should converge on a known
 * row-count (a counter, a fan-out write). `k ≤ 0` is satisfied by any ok result
 * (including zero rows); a non-ok result is never fresh.
 */
export function minRowCount(k: number): (result: QueryResult) => boolean {
	const floor = Math.max(0, Math.trunc(Number.isFinite(k) ? k : 0));
	return (result: QueryResult): boolean => isOk(result) && result.rows.length >= floor;
}

/**
 * "Some row's `versionColumn` is ≥ `n`." For a version-bumped table read that must
 * see at least version `n` (the append-only monotone signal). A non-ok result is
 * never fresh.
 */
export function minVersion(versionColumn: string, n: number): (result: QueryResult) => boolean {
	return (result: QueryResult): boolean => {
		if (!isOk(result)) return false;
		return result.rows.some((row) => {
			const v = rowNumberOrUndefined(row, versionColumn);
			return v !== undefined && v >= n;
		});
	};
}
