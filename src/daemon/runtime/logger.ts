/**
 * Structured per-request logging seam (PRD-004a FR-7).
 *
 * Emits one structured record per request, shaped so `/api/logs` and the
 * diagnostics report (later modules) consume it without re-deriving fields. The
 * seam is an interface plus a default stderr JSON-lines sink and an in-memory
 * ring buffer, so a later `/api/logs` handler reads the buffer and a test asserts
 * on captured records without parsing stderr.
 *
 * Logging is to stderr (never stdout) so a caller piping the daemon's stdout —
 * or any tool parsing JSON from stdout — never sees log noise mixed into its
 * data pipe (the same posture esbuild.config.mjs uses for its build banner).
 *
 * No secrets are logged: the request logger records method, path, status,
 * duration, mode, and the resolved tenancy scope — never headers, the bearer
 * token, or a request body. Auth tokens never reach this module.
 */

/** One structured request-log record. */
export interface RequestLogRecord {
	/** ISO-8601 timestamp of when the request completed. */
	readonly time: string;
	/** HTTP method. */
	readonly method: string;
	/** Request path (no query string, to avoid logging incidental secrets). */
	readonly path: string;
	/** Response status code. */
	readonly status: number;
	/** Wall-clock handler duration in milliseconds. */
	readonly durationMs: number;
	/** Deployment mode the request ran under (`local` | `team` | `hybrid`). */
	readonly mode: string;
	/** Resolved org for the request, when one was scoped (never a token). */
	readonly org?: string;
	/** Resolved workspace for the request, when one was scoped. */
	readonly workspace?: string;
}

/** The logging seam every request passes through (FR-7). */
export interface RequestLogger {
	/** Record one completed request. */
	log(record: RequestLogRecord): void;
	/** Return the most-recent records (newest last). For `/api/logs` + tests. */
	recent(limit?: number): RequestLogRecord[];
}

/** How many records the in-memory ring buffer retains by default. */
export const DEFAULT_LOG_BUFFER_SIZE = 500;

/**
 * The default request logger: writes each record as one JSON line to stderr AND
 * retains the last `bufferSize` records in a ring buffer for `/api/logs`. A
 * `silent` option suppresses the stderr write (used in tests so the suite output
 * stays clean) while still buffering, so log assertions don't depend on stderr.
 */
export function createRequestLogger(
	options: { bufferSize?: number; silent?: boolean } = {},
): RequestLogger {
	const bufferSize = options.bufferSize ?? DEFAULT_LOG_BUFFER_SIZE;
	const silent = options.silent ?? false;
	const buffer: RequestLogRecord[] = [];

	return {
		log(record: RequestLogRecord): void {
			buffer.push(record);
			if (buffer.length > bufferSize) buffer.shift();
			if (!silent) {
				process.stderr.write(`${JSON.stringify({ kind: "request", ...record })}\n`);
			}
		},
		recent(limit?: number): RequestLogRecord[] {
			if (limit === undefined || limit >= buffer.length) return [...buffer];
			return buffer.slice(buffer.length - limit);
		},
	};
}
