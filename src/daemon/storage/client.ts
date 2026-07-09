/**
 * DeepLake storage client (PRD-002a FR-1/3/4/5/6/7/8).
 *
 * The single DeepLake entry point in the whole system. It lives ONLY under
 * `src/daemon/` (a-AC-5): no harness, CLI, MCP, or daemon-client module imports
 * it, so only the daemon bundle carries the DeepLake path. Non-daemon code
 * reaches storage by calling the daemon on port 3850 (the daemon-client
 * surface), never by opening DeepLake itself.
 *
 * It routes every statement through a `DeepLakeTransport` (real HTTP in prod,
 * a fake in tests), so the Wave-2 layers (escaping 002b, healing 002c, write
 * patterns 002d, vector 002e) consume one `query` interface and are verified
 * against the fake without a live endpoint.
 *
 * Responsibilities owned here (NOT the transport):
 *   - org resolution: every query carries the resolved org header (FR-3). The
 *     `query` API forces the caller to pass a scope so an unscoped query on a
 *     tenant table cannot be issued by accident (a-AC-2).
 *   - timeout: an abortable race bounds every statement to
 *     HONEYCOMB_QUERY_TIMEOUT_MS and returns a timeout result, never a hang
 *     (FR-4 / a-AC-4).
 *   - tracing: gated by HONEYCOMB_TRACE_SQL, evaluated at call time so tests
 *     can flip it between calls (FR-6 / a-AC-6).
 *   - result union: maps transport outcomes onto {ok|query_error|
 *     connection_error|timeout}; downstream branches on `kind` (FR-7 / a-AC-7).
 *   - redaction: org/token never echoed in full in any log/error (FR-8).
 */

import { setTimeout as delay } from "node:timers/promises";
import { redactToken, type StorageConfig } from "./config.js";
import { type MeterSnapshot, QueryMeter, type QuerySource } from "./query-meter.js";
import { connectionError, isOk, ok, type QueryResult, queryError, timeoutResult } from "./result.js";
import { Semaphore } from "./semaphore.js";
import { type DeepLakeTransport, TransportError, type TransportRequest } from "./transport.js";

/**
 * The scope every query must carry (a-AC-2). Forcing the caller to pass an org
 * here is the API-level guarantee that no tenant query goes out unscoped: there
 * is no `query(sql)` overload that omits it. Workspace defaults to the config's
 * workspace but can be overridden per call.
 */
export interface QueryScope {
	/** Resolved org/workspace identity for this request. Required. */
	readonly org: string;
	/** Target workspace/partition. Defaults to the configured workspace. */
	readonly workspace?: string;
}

/** Options for a single query call. */
export interface QueryOptions {
	/** Override the per-statement timeout (ms) for this call only. */
	readonly timeoutMs?: number;
	/**
	 * PRD-077b (L-B2 / L-B8): an EXTERNAL caller deadline (an `AbortSignal.timeout(...)` a recall
	 * lane wraps its whole fan-out with). When it aborts, this statement is aborted daemon-side too
	 * — the in-flight `fetch` is cut and the Semaphore permit released — so a hung query frees its
	 * slot at the deadline instead of running to the 25-minute tail. ADDITIVE + optional: an un-set
	 * signal is byte-for-byte the pre-077b behaviour (only the per-statement timeout bounds the call).
	 */
	readonly signal?: AbortSignal;
	/**
	 * Attribution label for the query meter (PRD-062a). OPTIONAL — an un-set
	 * `source` is counted under `"other"` by the meter, so no existing call site
	 * has to change and an unlabeled query is visibly "unlabeled" until a later
	 * wave threads the right label. The meter only OBSERVES; passing a `source`
	 * never changes the query's behavior or its result.
	 */
	readonly source?: QuerySource;
}

/**
 * Trace a statement to stderr, gated at call time so a test can toggle
 * `config.traceSql` between calls (FR-6). The org is redacted (FR-8) and the
 * SQL is summarized so a trace line never dumps a multi-KB statement. No token
 * is ever in a trace line — the client never puts the token into a message.
 */
function traceSql(enabled: boolean, line: string): void {
	if (!enabled) return;
	process.stderr.write(`[deeplake-sql] ${line}\n`);
}

function summarizeSql(sql: string, maxLen = 220): string {
	const compact = sql.replace(/\s+/g, " ").trim();
	return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

// ── Bounded transient-retry layer (reads + IDEMPOTENT writes) ───────────────
//
// The transport (transport.ts) issues ONE request and does NOT retry — its
// JSDoc says "the daemon adds a Semaphore/retry layer on top". This is that
// retry layer. The DeepLake backend flaps under load (stale segments, transient
// 5xx like the 502/query_error storm, connection resets — the documented
// eventual-consistency posture), and a single flap would otherwise surface
// straight to the caller and red a test. We retry, but ONLY where it is provably
// safe — retryability is classified by STATEMENT (the {@link statementRetryability}
// idempotency tag), never guessed:
//
//   1. READS (`SELECT` / read-only `WITH`) — always safe to re-issue: a re-read
//      has no side effect.
//
//   2. IDEMPOTENT WRITES (`DELETE`, and `UPDATE` with a deterministic absolute
//      SET) — safe to re-issue. The wire is at-least-once (an ambiguous 502 may
//      have landed the write before the socket dropped), but re-running an
//      idempotent write CONVERGES to the same final state: a `DELETE … WHERE`
//      re-applied leaves the same rows gone (the compaction reap, retention
//      purge, job-queue dequeue), and a deterministic-key `UPDATE … SET col =
//      <value>` (the keyed `/api/kpis` upsert, a revoke `SET revoked = 1`, an
//      embed attach) re-applied lands the byte-identical row. Re-running cannot
//      create a duplicate or a divergent row, so a transient flap on one of these
//      is retried with the SAME bounded backoff the read path uses.
//
//   3. NON-IDEMPOTENT WRITES (`INSERT`, and anything we cannot positively prove
//      idempotent) — NEVER retried here. An `INSERT` has no unique-key / ON
//      CONFLICT guard on this backend, so a blind retry after an ambiguous 502
//      risks a DUPLICATE row — exactly the version-bumped-append failure mode
//      (two rows at the same logical version inflate counts and can break a
//      "one row" assertion). The version-bumped append (`appendVersionBumped`)
//      reads MAX(version) then INSERTs N+1; that read-then-insert is inherently
//      non-idempotent under a blind retry, so it stays SINGLE-ATTEMPT at this
//      layer (option (a) of the hardening plan). Its resilience comes from the
//      job-level auto-retry + the de-dup-by-highest-version reads every consumer
//      already performs — NEVER from a storage-layer retry that could double-
//      insert a version.
//
//   In ALL cases, a TRANSIENT failure is the only thing retried. A
//   `connection_error` / `timeout`, or a `query_error` whose HTTP status is a
//   transient code (429/500/502/503/504, the 502/query_error storm class), is a
//   backend flap. A `query_error` that is a real SQL/logic fault (missing-table
//   42P01, missing-column, syntax, permission, any other 4xx, or an opaque no-
//   status rejection) passes through UNCHANGED on the first try — heal.ts
//   classifies on those and MUST see them immediately (the anti-mask rule), and a
//   deterministic SQL error must fail fast, never be retried.
//
// The fake transport in tests settles on attempt 1 (it returns an ok / a
// non-transient error), so the retry path is a LIVE-ONLY cost and the existing
// classification tests are unaffected.

// ── Bounded in-flight concurrency cap (Semaphore(5)) ────────────────────────
//
// The transport (transport.ts) issues one request with NO concurrency control —
// its JSDoc says "the daemon adds a Semaphore/retry layer on top". This file owns
// BOTH halves: the transient-retry layer below AND the Semaphore that bounds how
// many transport requests are in flight AT ONCE. PRD-062 (and transport.ts:66-72)
// call for a `Semaphore(5)`: without it, a burst of dashboard reads + recall arms +
// grader batches fans out unbounded concurrent DeepLake queries and multiplies
// gateway latency (the 40-80s diagnostics stalls). The cap is the amplification
// ceiling — at most {@link MAX_CONCURRENT_QUERIES} statements reach the backend
// concurrently; the rest wait FIFO for a permit.
//
// SEMANTICS — the permit is held PER ATTEMPT, not per logical query. A permit is
// acquired around each {@link StorageClient.attemptOnce} (the actual transport
// round-trip) and released the instant that attempt settles — so the backoff SLEEP
// between a flapped attempt and its retry does NOT hold a permit. This is the
// faithful reading of "bound in-flight queries": the cap counts real concurrent
// wire requests, and a retrying query yields its slot to another during backoff
// rather than squatting on it. Reads AND writes (safe + unsafe) go through the cap.

/** The maximum number of transport requests in flight at once (PRD-062 Semaphore(5)). */
export const MAX_CONCURRENT_QUERIES = 5;

/** HTTP statuses that mark a `query_error` as a transient backend flap. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Total attempts for a retryable statement (1 original + up to 3 retries). */
const RETRY_ATTEMPTS = 4;

/** Base backoff before the first retry (ms). Short — the flap is brief. */
const RETRY_BASE_MS = 50;

/** Backoff ceiling (ms). Exponential growth is capped here so the budget stays tight. */
const RETRY_MAX_MS = 1_000;

/** A sleep seam so a test can inject a no-op clock and stay fast + deterministic. */
export type SleepFn = (ms: number) => Promise<void>;

/** Default sleep: the real timer. Tests inject a fake so backoff costs nothing. */
const realSleep: SleepFn = (ms) => delay(ms);

/**
 * How a statement may be retried under a transient flap. Classified by the
 * statement SHAPE — never guessed — so a retry decision is auditable:
 *
 *   - `"read"`           — a `SELECT` / read-only `WITH`. No side effect; always
 *                          safe to re-issue.
 *   - `"idempotent-write"` — a `DELETE`, or a deterministic-absolute-SET `UPDATE`.
 *                          Re-running converges to the same final state, so it is
 *                          safe to re-issue on a transient flap (the keyed upsert,
 *                          the compaction reap, a revoke).
 *   - `"unsafe-write"`   — an `INSERT`, or ANY statement we cannot positively
 *                          prove is one of the above (an empty string, a `MERGE`,
 *                          a `CREATE`/`ALTER`/`DROP`, a relative-mutation UPDATE,
 *                          an unrecognized shape). NEVER retried — a re-issue could
 *                          duplicate or diverge a row.
 */
export type StatementRetryability = "read" | "idempotent-write" | "unsafe-write";

/**
 * Classify a statement's retryability by its SHAPE (the idempotency tag the retry
 * loop branches on). Conservative by construction — the default for anything not
 * positively proven safe is `"unsafe-write"`:
 *
 *   - `SELECT` → `"read"`.
 *   - `WITH …` → `"read"` UNLESS it contains a data-modifying keyword anywhere
 *     (a data-modifying CTE), in which case it is `"unsafe-write"` (we never try
 *     to prove a CTE's embedded write is idempotent — too subtle; fail safe).
 *   - `DELETE …` → `"idempotent-write"`. A `DELETE … WHERE` re-applied leaves the
 *     same rows gone; re-running after an ambiguous 502 converges, never duplicates.
 *   - `UPDATE …` → `"idempotent-write"` ONLY when the SET is a deterministic
 *     ABSOLUTE assignment (`SET col = <value>, …`). A RELATIVE mutation
 *     (`SET col = col + 1`, a `||` concat) is NOT idempotent — re-running would
 *     double the effect — so it is demoted to `"unsafe-write"`. {@link isAbsoluteUpdate}
 *     proves the absolute shape; anything it cannot prove fails safe.
 *   - everything else (`INSERT`, `MERGE`/`UPSERT`, `CREATE`/`ALTER`/`DROP`/
 *     `TRUNCATE`, empty, unrecognized) → `"unsafe-write"`.
 *
 * When in doubt, do not retry: a missed retry costs one extra live flap; a wrong
 * retry risks a duplicate/divergent row.
 */
export function statementRetryability(sql: string): StatementRetryability {
	const normalized = stripLeadingNoise(sql).toUpperCase();
	if (normalized.startsWith("SELECT")) return "read";
	if (normalized.startsWith("WITH")) {
		// A CTE is a read UNLESS it drives a data-modifying statement. Any
		// data-modifying keyword anywhere (word-boundary matched so it is the
		// keyword, not an identifier substring) demotes it — and we never try to
		// prove a CTE write idempotent, so a data-modifying CTE is always unsafe.
		const modifies = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|CREATE|DROP|TRUNCATE)\b/.test(normalized);
		return modifies ? "unsafe-write" : "read";
	}
	if (normalized.startsWith("DELETE")) return "idempotent-write";
	if (normalized.startsWith("UPDATE")) return isAbsoluteUpdate(normalized) ? "idempotent-write" : "unsafe-write";
	// INSERT, MERGE/UPSERT, CREATE/ALTER/DROP/TRUNCATE, empty, unrecognized — never retried.
	return "unsafe-write";
}

/**
 * Is an UPPER-CASED `UPDATE` statement a deterministic ABSOLUTE assignment (safe
 * to re-issue) rather than a RELATIVE mutation (a re-issue would double-apply)?
 *
 * An absolute SET overwrites each column with a fixed expression that does not
 * read the column's own prior value, so re-running lands the byte-identical row.
 * A RELATIVE mutation reads the column to compute the new value (`col = col + 1`,
 * `col = col - 1`, `col = col || 'x'`), so a second apply diverges. We prove the
 * absolute shape by SCANNING the SET-list: for each `<col> = <expr>` assignment,
 * the right-hand expression must NOT reference the assigned column. Conservative —
 * if we cannot cleanly parse the SET list, we report `false` (treat as unsafe).
 *
 * The SET list is everything between `SET` and the first `WHERE` (or end of
 * statement). Assignments split on top-level commas; a comma inside parentheses
 * (a function-call arg list) is not a separator.
 */
export function isAbsoluteUpdate(upperSql: string): boolean {
	const setIdx = upperSql.indexOf(" SET ");
	if (setIdx === -1) return false;
	const afterSet = upperSql.slice(setIdx + 5);
	const whereIdx = afterSet.search(/\bWHERE\b/);
	const setList = whereIdx === -1 ? afterSet : afterSet.slice(0, whereIdx);

	for (const assignment of splitTopLevel(setList)) {
		const eq = assignment.indexOf("=");
		if (eq === -1) return false; // not a recognizable assignment → fail safe.
		const col = assignment.slice(0, eq).trim().replace(/^"|"$/g, "").trim();
		const expr = assignment.slice(eq + 1);
		if (col === "") return false;
		// A RELATIVE mutation references the assigned column on the right-hand side
		// (`col = col + 1`). Match the bare column name on a word boundary in the
		// expression; if present, the assignment reads its own prior value → unsafe.
		// First STRIP single-quoted string literals from the expression: a column name
		// appearing INSIDE a literal value (`SET note = 'note text'`) is data, never a
		// self-reference, so it must not falsely demote an absolute assignment to unsafe.
		// Quotes are already doubled by the SQL-escape floor, so a `''` pair inside a
		// literal is consumed as part of that literal by the non-greedy scan.
		const exprNoLiterals = expr.replace(/'(?:[^']|'')*'/g, "");
		const colPattern = new RegExp(`\\b${escapeRegExp(col)}\\b`);
		if (colPattern.test(exprNoLiterals.replace(/"/g, ""))) return false;
	}
	return true;
}

/** Split a SET list on TOP-LEVEL commas (commas inside `(...)` are not separators). */
function splitTopLevel(setList: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of setList) {
		if (ch === "(") depth++;
		else if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") parts.push(current);
	return parts;
}

/** Escape a string for safe interpolation into a `RegExp` body. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this statement a READ (safe to retry on a transient flap)? Retained as the
 * public predicate for callers that only need the read/not-read distinction; it
 * is the `"read"` arm of {@link statementRetryability}. The retry loop itself uses
 * the richer three-way tag so it can ALSO retry an idempotent write.
 */
export function isReadStatement(sql: string): boolean {
	return statementRetryability(sql) === "read";
}

/**
 * Strip leading whitespace plus leading SQL comments (`-- line` and `/* block *​/`)
 * so the first significant keyword can be read. Only LEADING noise is removed —
 * we never rewrite the body, just look past a preamble to the verb.
 */
function stripLeadingNoise(sql: string): string {
	let s = sql;
	let changed = true;
	while (changed) {
		changed = false;
		const trimmed = s.replace(/^\s+/, "");
		if (trimmed !== s) {
			s = trimmed;
			changed = true;
		}
		if (s.startsWith("--")) {
			const nl = s.indexOf("\n");
			s = nl === -1 ? "" : s.slice(nl + 1);
			changed = true;
		} else if (s.startsWith("/*")) {
			const end = s.indexOf("*/");
			s = end === -1 ? "" : s.slice(end + 2);
			changed = true;
		}
	}
	return s;
}

/**
 * Is this non-ok result a TRANSIENT backend flap (worth a re-read) rather than a
 * deterministic statement rejection? Mirrors `heal.ts`'s `isTransientResult`,
 * widened to the transient HTTP set (429/500/502/503/504):
 *
 *   - `connection_error` / `timeout` → transient (socket drop / slow flap).
 *   - `query_error` with a transient HTTP status → transient (backend faulted
 *     mid-request — the stale-segment / transient-5xx flap).
 *   - `query_error` with any OTHER status (42P01 missing-table, a 400 syntax, a
 *     401/403 permission) or NO status → NON-transient: a genuine rejection that
 *     heal/other logic must see immediately and that retrying would only mask.
 */
export function isTransientResult(result: QueryResult): boolean {
	if (result.kind === "connection_error" || result.kind === "timeout") return true;
	if (result.kind === "query_error") return result.status !== undefined && TRANSIENT_STATUSES.has(result.status);
	return false;
}

/** Exponential backoff with jitter, capped at the ceiling. `attempt` is 1-based. */
function backoffMs(attempt: number): number {
	const exp = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
	// Full jitter over [0, exp] de-correlates concurrent retriers so a fleet of
	// workers doesn't re-stampede the backend in lockstep.
	return Math.floor(Math.random() * exp);
}

/**
 * The storage client. Construct via `createStorageClient` so config is
 * validated first (fail-closed). Holds the single shared transport handle
 * (FR-5) and the validated config.
 */
export class StorageClient {
	/**
	 * @param sleep injectable backoff clock for the read-retry layer. Defaults to
	 * the real timer; a test injects a no-op so the bounded backoff costs zero
	 * wall-clock time and the retry count stays deterministic.
	 */
	/** Per-source DeepLake query meter (PRD-062a). Always present; default mode is in-memory + log only. */
	private readonly meter: QueryMeter;

	/**
	 * The in-flight concurrency cap (PRD-062 Semaphore(5)). Bounds how many transport
	 * requests reach the backend AT ONCE — every attempt acquires a permit and releases
	 * it the instant it settles (see {@link attemptOnce}). One per client, so the cap is
	 * daemon-wide (the daemon holds a single shared client).
	 */
	private readonly querySemaphore: Semaphore;

	/**
	 * @param sleep injectable backoff clock for the read-retry layer. Defaults to
	 * the real timer; a test injects a no-op so the bounded backoff costs zero
	 * wall-clock time and the retry count stays deterministic.
	 * @param meter injectable query meter (PRD-062a). Defaults to a fresh in-memory
	 * {@link QueryMeter}; the daemon may inject a shared one so diagnostics and a
	 * later persistence path observe the SAME counts. The meter is a pure observer:
	 * supplying it never changes any query's behavior or result.
	 * @param maxConcurrency the in-flight query cap (PRD-062). Defaults to
	 * {@link MAX_CONCURRENT_QUERIES}; a test may inject a smaller value to assert the
	 * cap deterministically. Clamped to `>= 1` by {@link Semaphore}.
	 */
	constructor(
		private readonly transport: DeepLakeTransport,
		private readonly config: StorageConfig,
		private readonly sleep: SleepFn = realSleep,
		meter: QueryMeter = new QueryMeter(),
		maxConcurrency: number = MAX_CONCURRENT_QUERIES,
	) {
		this.meter = meter;
		this.querySemaphore = new Semaphore(maxConcurrency);
	}

	/** The endpoint the client is bound to (for diagnostics; no secrets). */
	get endpoint(): string {
		return this.config.endpoint;
	}

	/**
	 * Snapshot the per-source query counts (PRD-062a, AC-62a.1.3). The diagnostic
	 * surface and the idle-baseline harness read the meter through here without
	 * touching the live counter, so a snapshot is stable even as traffic continues.
	 */
	meterSnapshot(): MeterSnapshot {
		return this.meter.snapshot();
	}

	/** Render the current per-source counts as one structured log line (PRD-062a). */
	meterLogLine(): string {
		return this.meter.formatLogLine();
	}

	/**
	 * Liveness check (a-AC-1): "connects" against the fake transport means a
	 * trivial statement succeeds. Returns a typed result so a caller branches on
	 * `kind` rather than catching. Real DeepLake has no ping, so this is a
	 * `SELECT 1` round-trip through the same path every other query takes.
	 */
	async connect(scope: QueryScope): Promise<QueryResult> {
		return this.query("SELECT 1", scope);
	}

	/**
	 * Run one statement under the resolved org scope, bounded by the timeout,
	 * and return the closed result union. Never throws for an expected failure
	 * (connection/query/timeout) — those are result kinds. The only throws are
	 * programmer errors (e.g. a missing scope, which TypeScript already
	 * prevents).
	 *
	 * READS and IDEMPOTENT WRITES get a bounded transient-retry on top (see the
	 * helpers above): a `SELECT`/read-only `WITH`, a `DELETE`, or a deterministic-
	 * absolute-SET `UPDATE` that fails with a transient flap (connection/timeout/
	 * 5xx — the 502/query_error storm class) is re-issued up to
	 * {@link RETRY_ATTEMPTS} times with jittered backoff, since the DeepLake backend
	 * flaps stale segments under load and re-running one of these CONVERGES (a read
	 * has no effect; an idempotent write lands the same final state). An
	 * `INSERT`/non-idempotent write is NEVER retried here (a retried append risks a
	 * duplicate — at-least-once), and a NON-transient `query_error` (missing-table/
	 * column, syntax, permission) is returned UNCHANGED on the first attempt so heal
	 * still classifies it immediately (the anti-mask rule). The retry is invisible
	 * to callers: they still get one final `QueryResult` — a success after a retry,
	 * or the last failure if every attempt flapped. The retry BUDGET is separate
	 * from the per-statement timeout: each attempt gets its own fresh timeout/abort.
	 */
	async query(sql: string, scope: QueryScope, opts: QueryOptions = {}): Promise<QueryResult> {
		// Classify by statement shape. Only a read or a PROVABLY-idempotent write is
		// retry-eligible; an INSERT / unsafe-write runs exactly once (no duplicate risk).
		const retryability = statementRetryability(sql);

		// Meter ONE logical operation per `query()` call (PRD-062a) — BEFORE the
		// retry loop so a transient-flap retry never double-counts. Read vs write is
		// the same statement-shape tag the retry layer uses: a `"read"` is a SELECT /
		// read-only WITH; everything else (INSERT/UPDATE/DELETE/DDL/CTE-write) is a
		// write. The increment is in-memory only and adds NO DeepLake query, so this
		// is a pure observation that cannot change the result the caller gets back.
		this.meter.record(opts.source, retryability !== "read");

		// An INSERT / unsafe-write runs exactly once (no duplicate risk).
		if (retryability === "unsafe-write") return this.attemptOnce(sql, scope, opts);

		let last: QueryResult | undefined;
		for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
			const result = await this.attemptOnce(sql, scope, opts);
			// Success, or a deterministic (non-transient) failure → final answer now.
			// A non-transient query_error (42P01 / syntax / permission) MUST surface
			// on attempt 1 so heal sees it — never retried.
			if (isOk(result) || !isTransientResult(result)) return result;
			last = result;
			// PRD-077b (L-B2 / L-B8): once the caller's external deadline has fired, stop retrying — a
			// re-issue would just abort again on the aborted signal. Surface the transient result now so
			// the arm degrades to [] immediately at the deadline (no pointless backoff tail).
			if (opts.signal?.aborted === true) return result;
			// Transient flap: back off (jittered) and re-issue, unless that was the
			// last attempt — in which case we fall through and return `last`.
			if (attempt < RETRY_ATTEMPTS) await this.sleep(backoffMs(attempt));
		}
		// Every attempt flapped transiently; surface the last failure, no loop.
		return last as QueryResult;
	}

	/**
	 * Issue ONE statement UNDER THE CONCURRENCY CAP: acquire a Semaphore permit, run
	 * the org scope + per-statement timeout/abort race + trace + result-union mapping,
	 * then ALWAYS release the permit (even on throw — `Semaphore.run`'s `finally`). This
	 * is the unit the read retry loop above re-invokes; each call gets its OWN
	 * timer/AbortController so a retry is bounded by a fresh per-statement timeout, not
	 * the previous one. The permit is acquired PER ATTEMPT (not per logical query), so
	 * the backoff sleep between a flapped attempt and its retry does not hold a slot —
	 * the cap counts only real in-flight transport requests (PRD-062).
	 *
	 * The timeout timer starts AFTER the permit is acquired: time parked waiting for a
	 * free slot is not charged against the per-statement timeout (only the actual wire
	 * round-trip is), so a busy cap never spuriously times a fast query out.
	 */
	private attemptOnce(sql: string, scope: QueryScope, opts: QueryOptions = {}): Promise<QueryResult> {
		return this.querySemaphore.run(() => this.runAttempt(sql, scope, opts));
	}

	/**
	 * The actual single-statement round-trip (the body {@link attemptOnce} runs while
	 * holding a permit). Never throws for an expected failure — those are result kinds.
	 */
	private async runAttempt(sql: string, scope: QueryScope, opts: QueryOptions = {}): Promise<QueryResult> {
		const workspace = scope.workspace ?? this.config.workspace;
		const timeoutMs = opts.timeoutMs ?? this.config.queryTimeoutMs;
		const trace = this.config.traceSql;
		const summary = summarizeSql(sql);
		traceSql(trace, `start org=${redactToken(scope.org)} ws=${workspace} :: ${summary}`);

		const startedAt = Date.now();
		const controller = new AbortController();
		// Abortable race: the timeout aborts the in-flight request so a slow
		// query returns a timeout result instead of stalling the worker (FR-4).
		// timeoutMs === 0 means abort on the next tick — never "no timeout".
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		// Mark whether WE aborted (timeout) vs the transport failing on its own,
		// so a transport that reports a generic abort is still classified as a
		// timeout when our timer fired.
		let timedOut = false;
		const onAbort = (): void => {
			timedOut = true;
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });

		// PRD-077b (L-B2 / L-B8): fold the caller's external deadline into this statement's abort. When
		// the lane's deadline signal fires, abort the in-flight request daemon-side (classified as a
		// timeout via `onAbort`), so a hung query frees its Semaphore permit at the deadline. An already-
		// aborted signal aborts on the next tick — never a stalled worker.
		const external = opts.signal;
		const onExternalAbort = (): void => controller.abort();
		if (external !== undefined) {
			if (external.aborted) controller.abort();
			else external.addEventListener("abort", onExternalAbort, { once: true });
		}

		const req: TransportRequest = {
			sql,
			org: scope.org,
			workspace,
			signal: controller.signal,
		};

		try {
			const rows = await this.transport.query(req);
			const durationMs = Date.now() - startedAt;
			traceSql(trace, `ok (${durationMs}ms, rows=${rows.length}) :: ${summary}`);
			return ok(rows, durationMs);
		} catch (e: unknown) {
			return this.classify(e, timedOut, timeoutMs, trace, summary);
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			if (external !== undefined) external.removeEventListener("abort", onExternalAbort);
		}
	}

	/**
	 * Map a thrown transport failure onto the result union. A timeout (either we
	 * aborted, or the transport tagged it `timeout`) wins over the other kinds.
	 * Messages are kept free of the token (the client never interpolates the
	 * token into SQL or errors), and the org is not echoed here.
	 */
	private classify(e: unknown, timedOut: boolean, timeoutMs: number, trace: boolean, summary: string): QueryResult {
		if (e instanceof TransportError) {
			if (e.kind === "timeout" || timedOut) {
				traceSql(trace, `timeout (${timeoutMs}ms) :: ${summary}`);
				return timeoutResult(timeoutMs);
			}
			if (e.kind === "connection") {
				traceSql(trace, `connection_error :: ${e.message} :: ${summary}`);
				return connectionError(e.message);
			}
			traceSql(trace, `query_error :: ${e.message} :: ${summary}`);
			return queryError(e.message, e.status);
		}
		// A non-TransportError escaping the transport. If our timer fired, treat
		// it as a timeout; otherwise surface it as a connection error rather than
		// re-throwing an untyped error past the closed-union boundary (FR-7).
		if (timedOut) {
			traceSql(trace, `timeout (${timeoutMs}ms) :: ${summary}`);
			return timeoutResult(timeoutMs);
		}
		const message = e instanceof Error ? e.message : String(e);
		traceSql(trace, `connection_error :: ${message} :: ${summary}`);
		return connectionError(message);
	}
}

/**
 * The query interface Wave-2 layers depend on (heal/write/vector call this,
 * not the class directly, so the contract is named and stable). Structurally
 * satisfied by `StorageClient`.
 */
export interface StorageQuery {
	query(sql: string, scope: QueryScope, opts?: QueryOptions): Promise<QueryResult>;
}
