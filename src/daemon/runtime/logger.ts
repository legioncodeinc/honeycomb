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

/**
 * One structured SUBSYSTEM-EVENT record (PRD-029). Distinct from a per-request record:
 * it captures a named daemon-state event (e.g. a recall that ran degraded) — the subsystem
 * NAME + a small bag of coarse fields, NEVER a query, token, header, org GUID, or secret.
 * The `fields` are scrubbed by the CALLER to subsystem state only (D-5).
 */
export interface EventLogRecord {
	/** ISO-8601 timestamp of when the event was recorded. */
	readonly time: string;
	/** The structured event name (e.g. `recall.degraded`). A fixed, greppable identifier. */
	readonly event: string;
	/** Coarse, secret-free fields describing the event (subsystem state only). */
	readonly fields: Readonly<Record<string, unknown>>;
}

/** The logging seam every request passes through (FR-7) + the PRD-029 event sink. */
export interface RequestLogger {
	/** Record one completed request. */
	log(record: RequestLogRecord): void;
	/** Return the most-recent request records (newest last). For `/api/logs` + tests. */
	recent(limit?: number): RequestLogRecord[];
	/**
	 * Record one structured SUBSYSTEM-EVENT (PRD-029 / AC-4). Pushes an {@link EventLogRecord}
	 * into a SEPARATE ring buffer — additive, so the existing `/api/logs` request snapshot
	 * (`recent`) is untouched. The caller supplies only subsystem-state fields (NO secret, D-5).
	 */
	event(name: string, fields?: Readonly<Record<string, unknown>>): void;
	/** Return the most-recent subsystem-event records (newest last). For tests + diagnostics. */
	recentEvents(limit?: number): EventLogRecord[];
}

/** How many records the in-memory ring buffer retains by default. */
export const DEFAULT_LOG_BUFFER_SIZE = 500;

/**
 * The durable write-through seam the logger tees each record into IN ADDITION to the in-memory
 * ring buffer + stderr (PRD-043a FR-2). It is the narrow `appendRequest`/`appendEvent` subset of
 * the SQLite {@link import("./logs/log-store.js").LogStore} — declared HERE (not imported) so the
 * logger stays driver-free and pure: when no store is injected, the logger behaves EXACTLY as
 * before (the PRD-021d/029 suites pass unchanged — AC-3). Both methods are fail-soft by contract
 * (a store error is swallowed inside the store, never thrown into the request path — AC-4).
 */
export interface LogWriteThrough {
	/** Persist one completed request record (in addition to the ring buffer). Fail-soft. */
	appendRequest(record: RequestLogRecord): void;
	/** Persist one subsystem-event record (in addition to the ring buffer). Fail-soft. */
	appendEvent(record: EventLogRecord): void;
}

/**
 * The default request logger: writes each record as one JSON line to stderr AND
 * retains the last `bufferSize` records in a ring buffer for `/api/logs`. A
 * `silent` option suppresses the stderr write (used in tests so the suite output
 * stays clean) while still buffering, so log assertions don't depend on stderr.
 *
 * PRD-043a (FR-2): an OPTIONAL `store` write-through seam tees each record into the durable
 * SQLite store too. When ABSENT (the default — every existing call site + the PRD-021d/029 unit
 * suites), the logger is the pure ring-buffer-and-stderr logger it always was (AC-3). The store's
 * own writes are fail-soft, so a persistence failure NEVER changes the snapshot/stream behaviour.
 */
export function createRequestLogger(
	options: { bufferSize?: number; silent?: boolean; store?: LogWriteThrough } = {},
): RequestLogger {
	const bufferSize = options.bufferSize ?? DEFAULT_LOG_BUFFER_SIZE;
	const silent = options.silent ?? false;
	const store = options.store;
	const buffer: RequestLogRecord[] = [];
	// PRD-029: a SEPARATE ring buffer for structured subsystem events, so the per-request
	// snapshot (`recent` / `/api/logs`) is unchanged and the two never crowd each other out.
	const events: EventLogRecord[] = [];

	return {
		log(record: RequestLogRecord): void {
			buffer.push(record);
			if (buffer.length > bufferSize) buffer.shift();
			if (!silent) {
				process.stderr.write(`${JSON.stringify({ kind: "request", ...record })}\n`);
			}
			// PRD-043a FR-2: write through to the durable store (fail-soft inside the store).
			store?.appendRequest(record);
		},
		recent(limit?: number): RequestLogRecord[] {
			if (limit === undefined || limit >= buffer.length) return [...buffer];
			return buffer.slice(buffer.length - limit);
		},
		event(name: string, fields: Readonly<Record<string, unknown>> = {}): void {
			const record: EventLogRecord = { time: new Date().toISOString(), event: name, fields };
			events.push(record);
			if (events.length > bufferSize) events.shift();
			if (!silent) {
				// One JSON line to stderr, tagged `event` (vs `request`) so a log reader
				// distinguishes them. The fields are caller-scrubbed to subsystem state (D-5).
				process.stderr.write(`${JSON.stringify({ kind: "event", ...record })}\n`);
			}
			// PRD-043a FR-2: write through to the durable store (fail-soft inside the store).
			store?.appendEvent(record);
		},
		recentEvents(limit?: number): EventLogRecord[] {
			if (limit === undefined || limit >= events.length) return [...events];
			return events.slice(events.length - limit);
		},
	};
}
