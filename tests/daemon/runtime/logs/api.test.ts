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
	type LogsResponse,
	MAX_LOGS_LIMIT,
	mountLogsApi,
	resolveLimit,
} from "../../../../src/daemon/runtime/logs/api.js";

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
