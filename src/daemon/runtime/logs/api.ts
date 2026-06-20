/**
 * The `/api/logs` handler attach seam — PRD-021d (d-AC-2, daemon side).
 *
 * The request logger (`logger.ts`) already keeps a ring buffer of structured
 * {@link RequestLogRecord}s, but nothing read it: the `/api/logs` route group is
 * SCAFFOLDED + protected in `server.ts` (it answers the 501 fallback until a handler
 * lands). This module is the single named step the daemon assembly calls AFTER
 * `createDaemon(...)` to wire the log reader onto that already-mounted group —
 * mirroring `mountDashboardApi` (020b) and `attachHooksHandlers` (019b). ZERO
 * `server.ts` edits: `daemon.group("/api/logs")` inherits the auth/RBAC middleware.
 *
 * It exposes two reads off the same ring buffer:
 *   - `GET /api/logs`              — a JSON snapshot of recent records (newest last),
 *                                     bounded by `?limit=` (the `honeycomb logs`
 *                                     one-shot + the dashboard live-log panel's
 *                                     initial paint).
 *   - `GET /api/logs/stream`       — a Server-Sent-Events stream that backfills the
 *                                     recent records then emits each NEW record as it
 *                                     lands (the `honeycomb logs --follow` tail + the
 *                                     dashboard live-log panel — d-AC-4). SSE is the
 *                                     ring-buffer-friendly choice: one long-lived GET,
 *                                     no websocket upgrade, the daemon pushes lines.
 *
 * ── No secrets in the payload (verified) ─────────────────────────────────────
 *   The records this serves are exactly what `RequestLogger.log` recorded: method,
 *   path (NO query string), status, duration, mode, and the resolved org/workspace.
 *   The logger NEVER records a header, a bearer token, or a request body (see
 *   `logger.ts`), so this handler cannot leak one — it only ever returns
 *   {@link RequestLogRecord}s verbatim. This seam adds NO new field to the payload.
 *
 * ── Deferred assembly (D-1 / D-7) ────────────────────────────────────────────
 *   The production daemon assembly (021a `assembleDaemon`) owns the logger and calls
 *   `mountLogsApi(daemon, { logger: daemon.logger })` once, alongside the other
 *   mount/attach seams. It is constructed-and-tested here against an in-memory logger
 *   (`tests/daemon/runtime/logs/api.test.ts` drives `app.request(...)`); importing the
 *   daemon does not auto-invoke it.
 */

import { streamSSE } from "hono/streaming";

import type { RequestLogger, RequestLogRecord } from "../logger.js";
import type { Daemon } from "../server.js";

/** The route group the logs API attaches to (already mounted + protected in `server.ts`). */
export const LOGS_GROUP = "/api/logs" as const;

/** The default number of records `GET /api/logs` returns when no `?limit=` is given. */
export const DEFAULT_LOGS_LIMIT = 100;

/** The hard ceiling on `?limit=` so a caller can never ask for an unbounded page. */
export const MAX_LOGS_LIMIT = 1000;

/** How often the SSE stream polls the ring buffer for new records (ms). */
export const DEFAULT_STREAM_POLL_MS = 500;

/** How often the SSE stream emits a keepalive comment so a proxy never idles it out (ms). */
export const DEFAULT_STREAM_KEEPALIVE_MS = 15_000;

/** Options for {@link mountLogsApi}. */
export interface MountLogsOptions {
	/** The request logger whose ring buffer the handlers read (d-AC-2 / FR-2). */
	readonly logger: RequestLogger;
	/**
	 * The SSE poll interval (ms). Defaults to {@link DEFAULT_STREAM_POLL_MS}. Injected so a
	 * test drives the stream fast without sleeping for the production interval.
	 */
	readonly streamPollMs?: number;
	/** The SSE keepalive interval (ms). Defaults to {@link DEFAULT_STREAM_KEEPALIVE_MS}. */
	readonly streamKeepaliveMs?: number;
}

/** The JSON envelope `GET /api/logs` returns: the records plus the total buffered. */
export interface LogsResponse {
	/** The recent records, newest LAST (the same order the buffer keeps). */
	readonly records: readonly RequestLogRecord[];
	/** How many records were returned (the page size). */
	readonly count: number;
}

/**
 * Parse and clamp the `?limit=` query param to `[1, MAX_LOGS_LIMIT]`, falling back to
 * {@link DEFAULT_LOGS_LIMIT} for a missing/garbage value. A caller can never request an
 * unbounded or negative page.
 */
export function resolveLimit(raw: string | undefined): number {
	if (raw === undefined || raw.length === 0) return DEFAULT_LOGS_LIMIT;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOGS_LIMIT;
	return Math.min(n, MAX_LOGS_LIMIT);
}

/**
 * Attach the `/api/logs` read handlers onto the daemon's already-mounted `/api/logs`
 * route group (d-AC-2 / FR-2). Registers the JSON snapshot (`GET /`) and the SSE follow
 * stream (`GET /stream`), both reading the injected logger's ring buffer. Call ONCE after
 * `createDaemon(...)`. If the group is not mounted (unknown daemon shape) the attach is a
 * no-op (the route stays the 501 scaffold), mirroring `mountDashboardApi`.
 */
export function mountLogsApi(daemon: Daemon, options: MountLogsOptions): void {
	const logs = daemon.group(LOGS_GROUP);
	if (logs === undefined) return;

	const logger = options.logger;
	const pollMs = options.streamPollMs ?? DEFAULT_STREAM_POLL_MS;
	const keepaliveMs = options.streamKeepaliveMs ?? DEFAULT_STREAM_KEEPALIVE_MS;

	// ── GET /api/logs — the JSON snapshot (newest last), bounded by ?limit=. The
	// records are RequestLogRecords verbatim: no token, no header, no body (logger.ts).
	logs.get("/", (c) => {
		const limit = resolveLimit(c.req.query("limit"));
		const records = logger.recent(limit);
		const body: LogsResponse = { records, count: records.length };
		return c.json(body);
	});

	// ── GET /api/logs/stream — the SSE follow tail (d-AC-4). Backfill the recent
	// records, then poll the ring buffer and push each NEW record as it lands. The
	// logger only exposes recent(limit), so we track how many records we have already
	// emitted by re-reading the tail and slicing past the high-water mark.
	logs.get("/stream", (c) => {
		const backfill = resolveLimit(c.req.query("limit"));
		return streamSSE(c, async (stream) => {
			// 1. Backfill: send the recent buffered records so a fresh follower sees
			//    context immediately (answers the open question — yes, backfill on attach).
			let lastSeen = await emitNew(stream, logger, backfill, NO_RECORDS_YET);

			// 2. Tail: poll on the interval, emitting any record newer than lastSeen.
			//    A keepalive comment is interleaved so an idle stream never gets reaped
			//    by a proxy. The loop ends when the client aborts (stream.aborted).
			let sinceKeepalive = 0;
			while (!stream.aborted) {
				await stream.sleep(pollMs);
				if (stream.aborted) break;
				lastSeen = await emitNew(stream, logger, MAX_LOGS_LIMIT, lastSeen);
				sinceKeepalive += pollMs;
				if (sinceKeepalive >= keepaliveMs) {
					sinceKeepalive = 0;
					// An SSE comment line keeps the connection warm without being an event.
					await stream.writeln(": keepalive");
				}
			}
		});
	});
}

/** Sentinel meaning "no record has been emitted yet" for the stream high-water mark. */
const NO_RECORDS_YET = "";

/**
 * Emit every record newer than `lastSeenKey` to the SSE stream and return the new
 * high-water key (the last emitted record's identity). Records are identified by their
 * `time` + `path` + `status` composite, which is stable and monotonically appended by
 * the ring buffer; this avoids emitting a record twice across polls. The records carry
 * no secret (logger.ts), so each SSE `data:` line is safe to push verbatim.
 */
async function emitNew(
	stream: { writeSSE(message: { data: string; event?: string }): Promise<void> },
	logger: RequestLogger,
	limit: number,
	lastSeenKey: string,
): Promise<string> {
	const records = logger.recent(limit);
	if (records.length === 0) return lastSeenKey;

	// Find the index just past the last-seen record. When the high-water key is no
	// longer in the (bounded) buffer, fall back to emitting the whole window — the
	// buffer rotated faster than we polled, so those are all "new" to this follower.
	let startIndex = 0;
	if (lastSeenKey !== NO_RECORDS_YET) {
		const seenAt = records.findIndex((r) => recordKey(r) === lastSeenKey);
		startIndex = seenAt === -1 ? 0 : seenAt + 1;
	}

	let newKey = lastSeenKey;
	for (let i = startIndex; i < records.length; i++) {
		const record = records[i];
		if (record === undefined) continue;
		await stream.writeSSE({ event: "log", data: JSON.stringify(record) });
		newKey = recordKey(record);
	}
	return newKey;
}

/** A stable per-record identity for de-duping across stream polls (no secret in it). */
function recordKey(record: RequestLogRecord): string {
	return `${record.time}|${record.method}|${record.path}|${record.status}`;
}
