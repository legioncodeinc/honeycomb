/**
 * Closed result shapes for the DeepLake storage client (PRD-002a FR-7 / a-AC-7).
 *
 * Every storage call returns a discriminated union over `kind` rather than
 * throwing an untyped error. Downstream adapter layers (escaping PRD-002b,
 * healing PRD-002c, write-patterns PRD-002d, vector PRD-002e) branch on `kind`
 * and never wrap a storage call in a bare try/catch hunting for a thrown shape.
 *
 * The four kinds are deliberately distinct so a caller can tell a wire/network
 * failure (`connection_error`) apart from the server rejecting a statement
 * (`query_error`) apart from the statement running too long (`timeout`). That
 * distinction is load-bearing for heal classification in Wave 2: a
 * missing-table error is a `query_error` to inspect, a dropped socket is a
 * `connection_error` to surface, and neither should be confused with a timeout.
 *
 * This module is the SINGLE home of the result union and its constructors so
 * the shape is defined once (jscpd discipline) and every layer imports it
 * rather than re-declaring a parallel shape that could drift.
 */

/** One row of a DeepLake result, keyed by column name. */
export type StorageRow = Record<string, unknown>;

/** A successful query: zero or more rows. */
export interface QueryOk {
	readonly kind: "ok";
	readonly rows: StorageRow[];
	/** Wall-clock duration of the call in milliseconds, for tracing/metrics. */
	readonly durationMs: number;
}

/**
 * The server accepted the request but rejected the statement (e.g. a missing
 * table, a missing column, a 402 out-of-credits, a syntax error). `status` is
 * the HTTP status when one was returned; `message` is already redacted.
 */
export interface QueryError {
	readonly kind: "query_error";
	readonly message: string;
	/** HTTP status from the endpoint, when the failure carried one. */
	readonly status?: number;
}

/**
 * The request never produced a server response: DNS failure, TCP reset,
 * refused connection, TLS failure, etc. Distinct from `query_error` so a
 * caller can retry/surface connectivity problems without treating them as a
 * rejected statement.
 */
export interface ConnectionError {
	readonly kind: "connection_error";
	readonly message: string;
}

/**
 * The statement exceeded `HONEYCOMB_QUERY_TIMEOUT_MS` and was aborted. The
 * worker is freed rather than blocked indefinitely (FR-4 / a-AC-4).
 */
export interface QueryTimeout {
	readonly kind: "timeout";
	readonly message: string;
	/** The timeout budget that was exceeded, in milliseconds. */
	readonly timeoutMs: number;
}

/** The closed result union every storage call returns. */
export type QueryResult = QueryOk | QueryError | ConnectionError | QueryTimeout;

/** Construct a success result. */
export function ok(rows: StorageRow[], durationMs: number): QueryOk {
	return { kind: "ok", rows, durationMs };
}

/** Construct a query-error result (server rejected the statement). */
export function queryError(message: string, status?: number): QueryError {
	return status === undefined ? { kind: "query_error", message } : { kind: "query_error", message, status };
}

/** Construct a connection-error result (no server response). */
export function connectionError(message: string): ConnectionError {
	return { kind: "connection_error", message };
}

/** Construct a timeout result. */
export function timeoutResult(timeoutMs: number): QueryTimeout {
	return { kind: "timeout", message: `Query exceeded ${timeoutMs}ms timeout`, timeoutMs };
}

/** Narrowing helper: did the call succeed? Lets callers write `if (isOk(r))`. */
export function isOk(result: QueryResult): result is QueryOk {
	return result.kind === "ok";
}
