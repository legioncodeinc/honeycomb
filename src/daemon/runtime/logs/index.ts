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
	type LogsResponse,
	MAX_LOGS_LIMIT,
	mountLogsApi,
	type MountLogsOptions,
	resolveLimit,
} from "./api.js";
