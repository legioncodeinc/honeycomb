/**
 * Daemon-side `/api/logs` API barrel — PRD-021d (d-AC-2).
 *
 * The public surface: {@link mountLogsApi} (the seam the daemon assembly calls once after
 * `createDaemon(...)` to attach the log reader + SSE follow stream onto the already-mounted
 * `/api/logs` route group), plus its options and the wire-shape constants. Mirrors the
 * `src/daemon/runtime/dashboard` barrel. See CONVENTIONS.md.
 */

export {
	DEFAULT_LOGS_LIMIT,
	DEFAULT_STREAM_KEEPALIVE_MS,
	DEFAULT_STREAM_POLL_MS,
	LOGS_GROUP,
	type LogsHistoryResponse,
	type LogsResponse,
	MAX_LOGS_LIMIT,
	mountLogsApi,
	type MountLogsOptions,
	resolveHistoryQuery,
	resolveLimit,
} from "./api.js";

// PRD-043a — the durable SQLite log store seam + retention/cursor helpers.
export {
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_MAX_AGE_DAYS,
	DEFAULT_MAX_ROWS,
	decodeCursor,
	encodeCursor,
	EVENT_LOG_TABLE,
	type HistoryCursor,
	type HistoryPage,
	type HistoryQuery,
	type LogStore,
	type LogStoreClock,
	LOG_DB_FILE_NAME,
	MAX_HISTORY_LIMIT,
	NULL_LOG_STORE,
	openLogStore,
	type OpenLogStoreOptions,
	REQUEST_LOG_TABLE,
	type RetentionConfig,
	systemLogStoreClock,
} from "./log-store.js";
