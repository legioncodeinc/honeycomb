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
import { connectionError, isOk, ok, type QueryResult, queryError, timeoutResult } from "./result.js";
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

// ── Bounded read-only transient-retry layer ────────────────────────────────
//
// The transport (transport.ts) issues ONE request and does NOT retry — its
// JSDoc says "the daemon adds a Semaphore/retry layer on top". This is that
// retry layer. The DeepLake backend flaps under load (stale segments, transient
// 5xx, connection resets — the documented eventual-consistency posture), and a
// single flap on a READ would otherwise surface straight to the caller and red a
// test. We retry, but ONLY where it is provably safe:
//
//   1. READS ONLY. A write retried on a transient failure risks a duplicate
//      append (the wire is at-least-once: the backend may have applied the write
//      before the socket dropped). Writes are made resilient elsewhere — heal +
//      the job-queue backoff + the append-only / highest-version-per-id
//      convergence — so this layer NEVER retries a write.
//
//   2. TRANSIENT FAILURES ONLY. A `connection_error` / `timeout`, or a
//      `query_error` whose HTTP status is a transient code (429/500/502/503/504),
//      is a backend flap worth a re-read. A `query_error` that is a SCHEMA/CLIENT
//      fault (missing-table 42P01, missing-column, syntax, permission, any other
//      4xx) passes through UNCHANGED on the first try — heal.ts classifies on
//      those and MUST see them immediately (the anti-mask rule). Retrying them
//      only burns Activeloop balance and masks the real fault.
//
// The fake transport in tests settles on attempt 1 (it returns an ok / a
// non-transient error), so the retry path is a LIVE-ONLY cost and the existing
// classification + "no retry" tests are unaffected.

/** HTTP statuses that mark a `query_error` as a transient backend flap. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Total attempts for a retryable read (1 original + up to 3 retries). */
const READ_RETRY_ATTEMPTS = 4;

/** Base backoff before the first retry (ms). Short — the flap is brief. */
const READ_RETRY_BASE_MS = 50;

/** Backoff ceiling (ms). Exponential growth is capped here so the budget stays tight. */
const READ_RETRY_MAX_MS = 1_000;

/** A sleep seam so a test can inject a no-op clock and stay fast + deterministic. */
export type SleepFn = (ms: number) => Promise<void>;

/** Default sleep: the real timer. Tests inject a fake so backoff costs nothing. */
const realSleep: SleepFn = (ms) => delay(ms);

/**
 * Is this statement a READ (safe to retry on a transient flap) as opposed to a
 * data-modifying statement (NEVER retried at this layer)?
 *
 * Conservative by construction: only a statement whose first significant keyword
 * is `SELECT` or `WITH` is a candidate, and a `WITH` is downgraded to a write if
 * it contains ANY top-level data-modifying keyword (a `WITH ... INSERT` /
 * data-modifying CTE). Anything we cannot positively prove is a read — an empty
 * string, an `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE`/`DROP`/`MERGE`, or an
 * unrecognized shape — is treated as a write (no retry). When in doubt, do not
 * retry: a missed retry only costs one extra live flap; a wrong retry risks a
 * duplicate append.
 */
export function isReadStatement(sql: string): boolean {
	const normalized = stripLeadingNoise(sql).toUpperCase();
	if (normalized.startsWith("SELECT")) return true;
	if (normalized.startsWith("WITH")) {
		// A CTE is a read UNLESS it drives a data-modifying statement. Be
		// conservative: any data-modifying keyword anywhere in the statement
		// (matched on a word boundary so it is the keyword, not a substring of an
		// identifier) demotes it to a write.
		return !/\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|CREATE|DROP|TRUNCATE)\b/.test(normalized);
	}
	return false;
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
	const exp = Math.min(READ_RETRY_BASE_MS * 2 ** (attempt - 1), READ_RETRY_MAX_MS);
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
	constructor(
		private readonly transport: DeepLakeTransport,
		private readonly config: StorageConfig,
		private readonly sleep: SleepFn = realSleep,
	) {}

	/** The endpoint the client is bound to (for diagnostics; no secrets). */
	get endpoint(): string {
		return this.config.endpoint;
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
	 * READS get a bounded transient-retry on top (see the helpers above): a
	 * `SELECT`/`WITH` that fails with a transient flap (connection/timeout/5xx) is
	 * re-issued up to {@link READ_RETRY_ATTEMPTS} times with jittered backoff,
	 * since the DeepLake backend flaps stale segments under load. A WRITE is NEVER
	 * retried here (a retried append risks a duplicate — at-least-once), and a
	 * NON-transient `query_error` (missing-table/column, syntax, permission) is
	 * returned UNCHANGED on the first attempt so heal still classifies it
	 * immediately (the anti-mask rule). The retry is invisible to callers: they
	 * still get one final `QueryResult` — a success after a retry, or the last
	 * failure if every attempt flapped. The retry BUDGET is separate from the
	 * per-statement timeout: each attempt gets its own fresh timeout/abort.
	 */
	async query(sql: string, scope: QueryScope, opts: QueryOptions = {}): Promise<QueryResult> {
		// Only a provable read is retry-eligible. Everything else runs exactly once.
		if (!isReadStatement(sql)) return this.attemptOnce(sql, scope, opts);

		let last: QueryResult | undefined;
		for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt++) {
			const result = await this.attemptOnce(sql, scope, opts);
			// Success, or a deterministic (non-transient) failure → final answer now.
			// A non-transient query_error (42P01 / syntax / permission) MUST surface
			// on attempt 1 so heal sees it — never retried.
			if (isOk(result) || !isTransientResult(result)) return result;
			last = result;
			// Transient flap: back off (jittered) and re-read, unless that was the
			// last attempt — in which case we fall through and return `last`.
			if (attempt < READ_RETRY_ATTEMPTS) await this.sleep(backoffMs(attempt));
		}
		// Every attempt flapped transiently; surface the last failure, no loop.
		return last as QueryResult;
	}

	/**
	 * Issue ONE statement: the org scope, the per-statement timeout/abort race,
	 * the trace lines, and the result-union mapping. This is the unit the read
	 * retry loop above re-invokes; each call gets its OWN timer/AbortController so
	 * a retry is bounded by a fresh per-statement timeout, not the previous one.
	 */
	private async attemptOnce(sql: string, scope: QueryScope, opts: QueryOptions = {}): Promise<QueryResult> {
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
