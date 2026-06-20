/**
 * The live capture-event log follow-client + dashboard live-log panel — PRD-021d (FR-6 / d-AC-4).
 *
 * d-AC-4 asks for a live log that streams capture events as the AI works, exposed two ways:
 *   - {@link followLogs} — a THIN CLIENT that tails the daemon's `/api/logs/stream` SSE
 *     endpoint, yielding each structured log record as it lands. The `honeycomb logs --follow`
 *     verb (021b) calls this and prints each record; the dashboard live-log panel calls it and
 *     appends each record to the panel slot.
 *   - {@link buildLiveLogPanel} — a pure {@link ViewBlock} builder rendering a snapshot of recent
 *     records as a dashboard panel (the initial paint before the stream attaches).
 *
 * ── Thin client (D-2) ────────────────────────────────────────────────────────
 *   This lives under `src/dashboard` (a NON_DAEMON_ROOT): it reaches the daemon ONLY over HTTP
 *   (the injected `fetch` seam), never opening DeepLake. It reads the daemon's `/api/logs` +
 *   `/api/logs/stream` endpoints, which the daemon-side `mountLogsApi` serves from the request-
 *   logger ring buffer. The records carry NO secret (the logger omits tokens/headers/bodies).
 *
 * ── SSE parsing ──────────────────────────────────────────────────────────────
 *   The stream is Server-Sent-Events: `data: <json>` lines, blank-line-delimited events, and
 *   `:` comment keepalives. {@link followLogs} parses the byte stream incrementally and yields one
 *   {@link LogRecord} per `event: log` frame, so a follower sees turns in real time.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../shared/constants.js";
import type { ViewBlock } from "./views.js";

/**
 * One structured log record the daemon streams (the wire shape of the request logger's
 * `RequestLogRecord`). Defined here so the thin client stays decoupled from `src/daemon`
 * (the daemon owns the wire contract it emits; this mirrors it). Carries NO secret.
 */
export interface LogRecord {
	/** ISO-8601 timestamp of when the request completed. */
	readonly time: string;
	/** HTTP method. */
	readonly method: string;
	/** Request path (no query string). */
	readonly path: string;
	/** Response status code. */
	readonly status: number;
	/** Wall-clock handler duration in milliseconds. */
	readonly durationMs: number;
	/** Deployment mode the request ran under. */
	readonly mode: string;
	/** Resolved org for the request, when scoped. */
	readonly org?: string;
	/** Resolved workspace for the request, when scoped. */
	readonly workspace?: string;
}

/** The minimal streaming `fetch` shape the follow-client needs (the global `fetch` satisfies it). */
export type StreamFetchLike = (
	input: string,
	init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	readonly body: ReadableStream<Uint8Array> | null;
}>;

/** Options for {@link followLogs}. Defaults to the loopback 3850 daemon + the global `fetch`. */
export interface FollowLogsOptions {
	/** The daemon host. Defaults to the shared loopback constant. */
	readonly host?: string;
	/** The daemon port. Defaults to 3850. */
	readonly port?: number;
	/** The streaming HTTP transport. Defaults to the global `fetch`. Injected for tests. */
	readonly fetch?: StreamFetchLike;
	/** Backfill window: how many recent records the stream replays on attach. */
	readonly backfill?: number;
	/** An abort signal so a caller (Ctrl-C on `logs --follow`) stops the tail. */
	readonly signal?: AbortSignal;
	/** Tenancy headers forwarded to the daemon, when known. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** The daemon base URL the follow-client tails (loopback 3850 by default). */
function logsBaseUrl(options: FollowLogsOptions): string {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	return `http://${host}:${port}`;
}

/**
 * Tail the daemon's `/api/logs/stream` SSE endpoint, yielding each {@link LogRecord} as it
 * lands (FR-6 / d-AC-4). The `honeycomb logs --follow` verb (021b) iterates this and prints
 * each record; the dashboard live-log panel iterates it and appends each to the slot. The
 * async generator ends when the daemon closes the stream or the caller aborts via
 * `options.signal`. A non-ok response throws (the verb surfaces the daemon-down state). The
 * client opens NO DeepLake — it only reads the daemon endpoint (D-2).
 */
export async function* followLogs(options: FollowLogsOptions = {}): AsyncGenerator<LogRecord, void, void> {
	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as StreamFetchLike);
	const base = logsBaseUrl(options);
	const query = options.backfill !== undefined ? `?limit=${encodeURIComponent(String(options.backfill))}` : "";
	const url = `${base}/api/logs/stream${query}`;
	const headers = { accept: "text/event-stream", ...(options.headers ?? {}) };

	const res = await fetchImpl(url, {
		method: "GET",
		headers,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	});
	if (!res.ok) throw new Error(`daemon responded ${res.status} for ${url}`);
	if (res.body === null) return;

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE events are blank-line-delimited. Split off each complete event and parse it.
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const record = parseLogFrame(frame);
				if (record !== null) yield record;
				sep = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Parse one SSE frame into a {@link LogRecord}, or `null` for a non-data frame (a keepalive
 * comment, or a malformed/non-log event). Concatenates the `data:` lines of the frame and
 * JSON-parses them, tolerating a frame that carries no record.
 */
export function parseLogFrame(frame: string): LogRecord | null {
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) continue; // keepalive comment
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return null;
	try {
		const parsed = JSON.parse(dataLines.join("\n")) as unknown;
		return isLogRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Narrow an unknown parsed value to a {@link LogRecord} (the daemon's wire shape). */
function isLogRecord(value: unknown): value is LogRecord {
	if (value === null || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return typeof r.time === "string" && typeof r.method === "string" && typeof r.path === "string";
}

/** Format one log record into a single dashboard/CLI line (no secret — the record carries none). */
export function formatLogLine(record: LogRecord): string {
	const scope = record.org !== undefined ? ` ${record.org}` : "";
	return `${record.time} ${record.method} ${record.path} ${record.status} ${record.durationMs}ms${scope}`;
}

/** The empty-state copy the live-log panel shows before any event has streamed. */
export const LIVE_LOG_EMPTY = "Waiting for capture events..." as const;

/**
 * Build the dashboard live-log panel (FR-6 / d-AC-4) — a pure {@link ViewBlock} rendering a
 * snapshot of recent log records as panel rows (the initial paint before {@link followLogs}
 * attaches and streams new lines into the slot). An empty list renders the waiting copy, NOT
 * an error. STABLE shape: `kind: "live-log"` so a host (HTML page / webview) targets it.
 */
export function buildLiveLogPanel(records: readonly LogRecord[]): ViewBlock {
	if (records.length === 0) {
		return { kind: "live-log", title: "Live log", rows: [LIVE_LOG_EMPTY] };
	}
	return { kind: "live-log", title: "Live log", rows: records.map(formatLogLine), data: records };
}
