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

import { redactToken, type StorageConfig } from "./config.js";
import { connectionError, ok, type QueryResult, queryError, timeoutResult } from "./result.js";
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

/**
 * The storage client. Construct via `createStorageClient` so config is
 * validated first (fail-closed). Holds the single shared transport handle
 * (FR-5) and the validated config.
 */
export class StorageClient {
	constructor(
		private readonly transport: DeepLakeTransport,
		private readonly config: StorageConfig,
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
	 */
	async query(sql: string, scope: QueryScope, opts: QueryOptions = {}): Promise<QueryResult> {
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
