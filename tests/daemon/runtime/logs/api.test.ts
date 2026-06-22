/**
 * PRD-021d daemon-side `/api/logs` suite — the `mountLogsApi` attach step (d-AC-2).
 *
 * `mountLogsApi` is the single named seam the daemon assembly calls after `createDaemon(...)`
 * to wire the log reader + SSE follow stream onto the already-mounted `/api/logs` route group.
 * This suite proves: BEFORE the attach the group answers the 501 scaffold; AFTER the attach
 * `GET /api/logs` returns the ring-buffer records (bounded by `?limit=`), `GET /api/logs/stream`
 * backfills + tails as SSE, and the payload carries NO secret (the records are the logger's
 * `RequestLogRecord`s verbatim — never a token/header/body).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger, type RequestLogRecord } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	DEFAULT_LOGS_LIMIT,
	type LogsHistoryResponse,
	type LogsResponse,
	MAX_LOGS_LIMIT,
	mountLogsApi,
	resolveHistoryQuery,
	resolveLimit,
} from "../../../../src/daemon/runtime/logs/api.js";
import {
	DEFAULT_HISTORY_LIMIT,
	MAX_HISTORY_LIMIT,
	openLogStore,
} from "../../../../src/daemon/runtime/logs/log-store.js";

const ORG = "fake-org";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG };
}

/** A log record with a distinct path, for ordering + dedup assertions. */
function rec(i: number, overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
	return {
		time: `2026-06-19T00:00:0${i}.000Z`,
		method: "POST",
		path: `/api/hooks/capture/${i}`,
		status: 200,
		durationMs: 5 + i,
		mode: "local",
		org: ORG,
		...overrides,
	};
}

/** Build a daemon with a silent ring-buffer logger seeded with `count` records. */
function makeDaemon(count: number, bufferSize = 500) {
	const logger = createRequestLogger({ silent: true, bufferSize });
	for (let i = 0; i < count; i++) logger.log(rec(i));
	const daemon = createDaemon({ config: cfg(), logger });
	return { daemon, logger };
}

describe("PRD-021d resolveLimit clamps the page size", () => {
	it("defaults a missing/garbage limit to DEFAULT_LOGS_LIMIT", () => {
		expect(resolveLimit(undefined)).toBe(DEFAULT_LOGS_LIMIT);
		expect(resolveLimit("")).toBe(DEFAULT_LOGS_LIMIT);
		expect(resolveLimit("not-a-number")).toBe(DEFAULT_LOGS_LIMIT);
		expect(resolveLimit("-5")).toBe(DEFAULT_LOGS_LIMIT);
	});

	it("clamps an over-large limit to MAX_LOGS_LIMIT", () => {
		expect(resolveLimit("999999")).toBe(MAX_LOGS_LIMIT);
		expect(resolveLimit("25")).toBe(25);
	});
});

describe("PRD-021d mountLogsApi wires the /api/logs ring-buffer reads", () => {
	it("BEFORE attach: /api/logs answers the 501 scaffold", async () => {
		const { daemon } = makeDaemon(3);
		const res = await daemon.app.request("/api/logs", { headers: headers() });
		expect(res.status).toBe(501);
	});

	it("d-AC-2: AFTER attach: GET /api/logs returns the ring-buffer records (newest last)", async () => {
		const { daemon, logger } = makeDaemon(3);
		mountLogsApi(daemon, { logger });
		const res = await daemon.app.request("/api/logs", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as LogsResponse;
		expect(json.count).toBe(3);
		expect(json.records).toHaveLength(3);
		// Newest last (the buffer keeps insertion order).
		expect(json.records[2]?.path).toBe("/api/hooks/capture/2");
	});

	it("d-AC-2: ?limit= bounds the page to the most-recent N", async () => {
		const { daemon, logger } = makeDaemon(10);
		mountLogsApi(daemon, { logger });
		const res = await daemon.app.request("/api/logs?limit=3", { headers: headers() });
		const json = (await res.json()) as LogsResponse;
		expect(json.count).toBe(3);
		// The most-recent three (7,8,9), newest last.
		expect(json.records.map((r) => r.path)).toEqual([
			"/api/hooks/capture/7",
			"/api/hooks/capture/8",
			"/api/hooks/capture/9",
		]);
	});

	it("d-AC-2 (no-secret): the payload carries only RequestLogRecord fields, never a token/header/body", async () => {
		const { daemon, logger } = makeDaemon(1);
		mountLogsApi(daemon, { logger });
		const res = await daemon.app.request("/api/logs", { headers: headers() });
		const body = await res.text();
		// The logger records method/path/status/duration/mode/org/workspace — and nothing else.
		// A token-shaped or header-shaped key must never appear in the serialized payload.
		expect(body).not.toMatch(/authorization/i);
		expect(body).not.toMatch(/bearer/i);
		expect(body).not.toMatch(/token/i);
		const json = (await daemon.app.request("/api/logs", { headers: headers() }).then((r) => r.json())) as LogsResponse;
		const record = json.records[0] as Record<string, unknown>;
		expect(Object.keys(record).sort()).toEqual(
			["durationMs", "method", "mode", "org", "path", "status", "time"].sort(),
		);
	});

	it("d-AC-4: GET /api/logs/stream backfills the recent records as SSE log frames then ends on abort", async () => {
		const { daemon, logger } = makeDaemon(2);
		// Drive the stream fast so the test does not wait the production poll interval, and let
		// the loop exit on the abort signal after the backfill is flushed.
		mountLogsApi(daemon, { logger, streamPollMs: 10, streamKeepaliveMs: 100_000 });
		const controller = new AbortController();
		const res = await daemon.app.request("/api/logs/stream?limit=10", {
			headers: headers(),
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		// Read until both backfilled frames have arrived (each is flushed by its own
		// writeSSE, so they can land in separate stream chunks), then abort the tail.
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		for (let i = 0; i < 10 && !text.includes("/api/hooks/capture/1"); i++) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) text += decoder.decode(value, { stream: true });
		}
		controller.abort();
		try {
			await reader.cancel();
		} catch {
			// cancel after abort can reject; the assertion below is what matters.
		}

		expect(text).toContain("event: log");
		expect(text).toContain("/api/hooks/capture/0");
		expect(text).toContain("/api/hooks/capture/1");
	});
});

describe("PRD-043a resolveHistoryQuery parses + clamps the filter set", () => {
	it("clamps ?limit= to [1, MAX_HISTORY_LIMIT] and defaults a missing/garbage value", () => {
		expect(resolveHistoryQuery({}).limit).toBe(DEFAULT_HISTORY_LIMIT);
		expect(resolveHistoryQuery({ limit: "garbage" }).limit).toBe(DEFAULT_HISTORY_LIMIT);
		expect(resolveHistoryQuery({ limit: "-5" }).limit).toBe(DEFAULT_HISTORY_LIMIT);
		expect(resolveHistoryQuery({ limit: "25" }).limit).toBe(25);
		expect(resolveHistoryQuery({ limit: "999999" }).limit).toBe(MAX_HISTORY_LIMIT);
	});

	it("parses status as an exact code or a class, ignoring garbage", () => {
		expect(resolveHistoryQuery({ status: "404" }).status).toEqual({ kind: "exact", code: 404 });
		expect(resolveHistoryQuery({ status: "5xx" }).status).toEqual({ kind: "class", hundreds: 5 });
		expect(resolveHistoryQuery({ status: "2XX" }).status).toEqual({ kind: "class", hundreds: 2 });
		expect(resolveHistoryQuery({ status: "nonsense" }).status).toBeUndefined();
		expect(resolveHistoryQuery({ status: "999" }).status).toBeUndefined();
	});

	it("ignores a non-ISO since/until and keeps a valid one", () => {
		expect(resolveHistoryQuery({ since: "not-a-date" }).since).toBeUndefined();
		expect(resolveHistoryQuery({ since: "2026-06-20T00:00:00.000Z" }).since).toBe("2026-06-20T00:00:00.000Z");
	});

	it("ignores empty path/org and a malformed cursor", () => {
		expect(resolveHistoryQuery({ path: "" }).path).toBeUndefined();
		expect(resolveHistoryQuery({ org: "" }).org).toBeUndefined();
		expect(resolveHistoryQuery({ cursor: "garbage$$$" }).cursor).toBeUndefined();
	});
});

describe("PRD-043a GET /api/logs/history (FR-3)", () => {
	it("AC-2: returns the persisted records (newest first), filterable + paginated", async () => {
		const { daemon, logger } = makeDaemon(0);
		const store = openLogStore({ memory: true });
		// Write through the logger so the records land in BOTH the ring buffer and the store.
		const loggerWithStore = createRequestLogger({ silent: true, store });
		for (let i = 0; i < 5; i++) loggerWithStore.log(rec(i, { path: `/api/x/${i}`, status: i < 3 ? 200 : 500 }));
		mountLogsApi(daemon, { logger, store });

		const res = await daemon.app.request("/api/logs/history", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as LogsHistoryResponse;
		expect(json.persistent).toBe(true);
		expect(json.records).toHaveLength(5);
		// Newest first.
		expect(json.records[0]?.path).toBe("/api/x/4");

		// Filter by 5xx class.
		const fivexx = (await daemon.app
			.request("/api/logs/history?status=5xx", { headers: headers() })
			.then((r) => r.json())) as LogsHistoryResponse;
		expect(fivexx.records).toHaveLength(2);
		expect(fivexx.records.every((r) => r.status >= 500)).toBe(true);
		store.close();
	});

	it("AC-3: write-through does NOT change the /api/logs snapshot (it still reads the ring buffer)", async () => {
		// The daemon's ring-buffer logger AND a separate store; mountLogsApi reads the ring buffer for
		// `/api/logs` and the store for `/api/logs/history`. The two are independent surfaces (D-3).
		// (The daemon's request-logging middleware tees EACH HTTP request through this same logger —
		// into both the ring buffer and the store — so the seeded records are the FIRST three, with
		// later HTTP requests appended after; we assert on the seeded prefix, not a brittle exact count.)
		const store = openLogStore({ memory: true });
		const logger = createRequestLogger({ silent: true, store });
		for (let i = 0; i < 3; i++) logger.log(rec(i));
		const daemon = createDaemon({ config: cfg(), logger });
		mountLogsApi(daemon, { logger, store });

		// `/api/logs` still serves the ring buffer (newest LAST), unchanged shape — the snapshot read
		// happens DURING the request, before that request is logged, so it sees exactly the 3 seeded.
		const snap = (await daemon.app.request("/api/logs", { headers: headers() }).then((r) => r.json())) as LogsResponse;
		expect(snap.count).toBe(3);
		expect(snap.records.map((r) => r.path)).toEqual([
			"/api/hooks/capture/0",
			"/api/hooks/capture/1",
			"/api/hooks/capture/2",
		]); // newest LAST (ring buffer order), shape unchanged by the write-through
		// The snapshot record carries EXACTLY the RequestLogRecord keys (write-through added no field).
		const snapRecord = snap.records[0] as Record<string, unknown>;
		expect(Object.keys(snapRecord).sort()).toEqual(
			["durationMs", "method", "mode", "org", "path", "status", "time"].sort(),
		);

		// `/api/logs/history` serves the store (newest FIRST). The 3 seeded records are the OLDEST
		// in the store; the `/api/logs` GET above was teed in after, so it leads — assert the seeded
		// prefix is present in newest-first order rather than a brittle exact count.
		const hist = (await daemon.app
			.request("/api/logs/history", { headers: headers() })
			.then((r) => r.json())) as LogsHistoryResponse;
		const histPaths = hist.records.map((r) => r.path);
		// The three seeded capture records are present, newest-of-them first within the seeded set.
		expect(histPaths).toContain("/api/hooks/capture/0");
		expect(histPaths).toContain("/api/hooks/capture/2");
		expect(histPaths.indexOf("/api/hooks/capture/2")).toBeLessThan(histPaths.indexOf("/api/hooks/capture/0"));
		store.close();
	});

	it("AC-4: with no store injected, history returns an empty page (persistent:false), never a 404", async () => {
		const { daemon, logger } = makeDaemon(3);
		mountLogsApi(daemon, { logger }); // no store → the NULL no-op
		const res = await daemon.app.request("/api/logs/history", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as LogsHistoryResponse;
		expect(json.persistent).toBe(false);
		expect(json.records).toHaveLength(0);
	});

	it("AC-6 (no-secret): history records carry only RequestLogRecord fields", async () => {
		const store = openLogStore({ memory: true });
		const logger = createRequestLogger({ silent: true, store });
		logger.log(rec(0));
		const daemon = createDaemon({ config: cfg(), logger });
		mountLogsApi(daemon, { logger, store });
		const body = await daemon.app.request("/api/logs/history", { headers: headers() }).then((r) => r.text());
		expect(body).not.toMatch(/authorization/i);
		expect(body).not.toMatch(/bearer/i);
		store.close();
	});
});
