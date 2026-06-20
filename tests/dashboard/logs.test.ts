/**
 * PRD-021d live-log follow-client + panel suite — FR-6 / d-AC-4.
 *
 * `followLogs` tails the daemon's `/api/logs/stream` SSE endpoint and yields each structured
 * {@link LogRecord} as it lands (the `honeycomb logs --follow` tail + the dashboard live-log
 * panel). `buildLiveLogPanel` renders a snapshot of recent records as a dashboard `ViewBlock`.
 * This proves: the client parses multi-frame SSE into records, tolerates keepalive comments,
 * throws on a non-ok response (daemon-down), and the panel renders rows + the empty-state.
 *
 * Driven through a fake streaming `fetch` (a canned `ReadableStream` of SSE bytes) — no live
 * daemon. The client is a THIN CLIENT: it only reads the daemon endpoint, never DeepLake.
 */

import { describe, expect, it } from "vitest";

import {
	buildLiveLogPanel,
	type FollowLogsOptions,
	followLogs,
	formatLogLine,
	LIVE_LOG_EMPTY,
	type LogRecord,
	openDashboard,
	parseLogFrame,
	type StreamFetchLike,
} from "../../src/dashboard/index.js";

function rec(i: number): LogRecord {
	return {
		time: `2026-06-19T00:00:0${i}.000Z`,
		method: "POST",
		path: `/api/hooks/capture/${i}`,
		status: 200,
		durationMs: 5,
		mode: "local",
		org: "o",
	};
}

/** Encode records as SSE `event: log` frames (plus an interleaved keepalive comment). */
function sseBytes(records: LogRecord[]): Uint8Array {
	const enc = new TextEncoder();
	let text = ": keepalive\n\n";
	for (const r of records) text += `event: log\ndata: ${JSON.stringify(r)}\n\n`;
	return enc.encode(text);
}

/** A fake streaming fetch returning a one-chunk ReadableStream of the given SSE bytes. */
function fakeStreamFetch(records: LogRecord[], ok = true): StreamFetchLike {
	return async () => ({
		ok,
		status: ok ? 200 : 503,
		body: ok
			? new ReadableStream<Uint8Array>({
					start(controller): void {
						controller.enqueue(sseBytes(records));
						controller.close();
					},
				})
			: null,
	});
}

async function collect(opts: FollowLogsOptions): Promise<LogRecord[]> {
	const out: LogRecord[] = [];
	for await (const r of followLogs(opts)) out.push(r);
	return out;
}

describe("PRD-021d followLogs tails the /api/logs SSE stream", () => {
	it("d-AC-4: yields each log record from the SSE frames, skipping keepalive comments", async () => {
		const records = await collect({ fetch: fakeStreamFetch([rec(0), rec(1), rec(2)]) });
		expect(records).toHaveLength(3);
		expect(records.map((r) => r.path)).toEqual([
			"/api/hooks/capture/0",
			"/api/hooks/capture/1",
			"/api/hooks/capture/2",
		]);
	});

	it("d-AC-4: throws on a non-ok response so the verb can surface the daemon-down state", async () => {
		await expect(collect({ fetch: fakeStreamFetch([], false) })).rejects.toThrow(/503/);
	});

	it("parseLogFrame returns null for a keepalive / malformed frame", () => {
		expect(parseLogFrame(": keepalive")).toBeNull();
		expect(parseLogFrame("data: not-json")).toBeNull();
		expect(parseLogFrame(`event: log\ndata: ${JSON.stringify(rec(5))}`)?.path).toBe("/api/hooks/capture/5");
	});

	it("formatLogLine renders a one-line record with no secret", () => {
		const line = formatLogLine(rec(0));
		expect(line).toContain("POST");
		expect(line).toContain("/api/hooks/capture/0");
		expect(line).not.toMatch(/token|bearer|authorization/i);
	});
});

describe("PRD-021d buildLiveLogPanel renders the dashboard live-log panel", () => {
	it("d-AC-4: renders one row per record", () => {
		const panel = buildLiveLogPanel([rec(0), rec(1)]);
		expect(panel.kind).toBe("live-log");
		expect(panel.rows).toHaveLength(2);
	});

	it("renders the waiting empty-state (not an error) when no events have streamed", () => {
		const panel = buildLiveLogPanel([]);
		expect(panel.rows).toEqual([LIVE_LOG_EMPTY]);
	});
});

describe("PRD-021d openDashboard resolves the viewable host URL the dashboard verb opens", () => {
	it("d-AC-3: returns the /dashboard URL + the probed connectivity", async () => {
		const result = await openDashboard({
			source: {
				async probe() {
					return { reachable: true, url: "http://127.0.0.1:3850" };
				},
				async fetchAll() {
					return {
						kpis: { memoryCount: 0, sessionCount: 0, estimatedSavings: 0 },
						sessions: { sessions: [] },
						settings: { orgId: "", orgName: "", workspace: "", settings: {} },
						graph: { built: false, nodes: [], edges: [] },
						rules: { rules: [] },
						skillSync: { skills: [] },
					};
				},
			},
		});
		expect(result.url).toBe("http://127.0.0.1:3850/dashboard");
		expect(result.connectivity.reachable).toBe(true);
	});

	it("d-AC-5: surfaces the daemon-down connectivity so the verb warns before opening", async () => {
		const result = await openDashboard({
			source: {
				async probe() {
					return { reachable: false, url: "http://127.0.0.1:3850", retry: true, detail: "down" };
				},
				async fetchAll() {
					throw new Error("should not be called while down");
				},
			},
		});
		expect(result.connectivity.reachable).toBe(false);
		expect(result.url).toContain("/dashboard");
	});
});
