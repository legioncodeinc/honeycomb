/**
 * PRD-043a — the durable SQLite log store suite (AC-1 / AC-2 / AC-5 / AC-6, FR-1..FR-7).
 *
 * Proves the store seam end to end against a TEMP-DIR / in-memory `node:sqlite` database (never
 * the real workspace):
 *   AC-1  survives a simulated restart (write → close → re-open the SAME logs.db → read back).
 *   AC-2  filters (since/until/status-class/path-prefix/org) + pagination (older window, no dup/gap).
 *   AC-5  retention prunes the oldest rows past the row + age bound.
 *   AC-6  the schema carries ONLY the record fields — no header/token/body column.
 *   FR-2  fail-soft: a closed/unavailable store degrades to the no-op, never throws.
 *
 * Runs under `--experimental-sqlite` (threaded via vitest `poolOptions.forks.execArgv`), so the
 * 22.x CI leg loads `node:sqlite`; on 24/25 the flag is a harmless no-op.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventLogRecord, RequestLogRecord } from "../../../../src/daemon/runtime/logger.js";
import { resolveHistoryQuery } from "../../../../src/daemon/runtime/logs/api.js";
import {
	DAEMON_DIR_NAME,
	decodeCursor,
	encodeCursor,
	LOG_DB_FILE_NAME,
	NULL_LOG_STORE,
	openLogStore,
	REQUEST_LOG_TABLE,
} from "../../../../src/daemon/runtime/logs/log-store.js";

/** A request record with a distinct path + status, for ordering / filter assertions. */
function rec(i: number, overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
	return {
		time: `2026-06-20T00:00:${String(i).padStart(2, "0")}.000Z`,
		method: "POST",
		path: `/api/memories/recall/${i}`,
		status: 200,
		durationMs: 5 + i,
		mode: "local",
		org: "fake-org",
		workspace: "default",
		...overrides,
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-logstore-"));
});

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort temp cleanup
	}
});

describe("PRD-043a openLogStore persists to disk", () => {
	it("AC-1: records written before a restart are queryable after re-opening the same logs.db", () => {
		const clock = { now: () => Date.parse("2026-06-21T00:00:00.000Z") };
		// Write three records, then CLOSE (simulating the daemon stopping).
		const first = openLogStore({ baseDir: dir, clock });
		expect(first.persistent).toBe(true);
		for (let i = 0; i < 3; i++) first.appendRequest(rec(i));
		first.close();

		// A FRESH store opens the SAME on-disk file (the daemon restarting) and reads the records back.
		const second = openLogStore({ baseDir: dir, clock });
		const page = second.queryRequests(resolveHistoryQuery({}));
		expect(page.records).toHaveLength(3);
		// Newest first.
		expect(page.records[0]?.path).toBe("/api/memories/recall/2");
		expect(page.records[2]?.path).toBe("/api/memories/recall/0");
		second.close();
	});

	it("AC-6: the request_log schema carries ONLY the record fields — no header/token/body column", () => {
		const store = openLogStore({ baseDir: dir });
		store.appendRequest(rec(0));
		const page = store.queryRequests(resolveHistoryQuery({}));
		const record = page.records[0] as Record<string, unknown>;
		// EXACTLY the RequestLogRecord fields, nothing else — no `authorization`/`token`/`body`/`header`.
		expect(Object.keys(record).sort()).toEqual(
			["durationMs", "method", "mode", "org", "path", "status", "time", "workspace"].sort(),
		);
		const serialized = JSON.stringify(page.records);
		expect(serialized).not.toMatch(/authorization/i);
		expect(serialized).not.toMatch(/bearer/i);
		expect(serialized).not.toMatch(/\btoken\b/i);
		store.close();
	});

	it("the db file lands under .daemon/logs.db (mirrors the secrets .daemon pattern)", () => {
		const store = openLogStore({ baseDir: dir });
		store.appendRequest(rec(0));
		store.close();
		// The file exists at the documented path.
		const { existsSync } = require("node:fs") as typeof import("node:fs");
		expect(existsSync(join(dir, DAEMON_DIR_NAME, LOG_DB_FILE_NAME))).toBe(true);
	});
});

describe("PRD-043a history filters + pagination (AC-2)", () => {
	it("filters by status class (5xx), path prefix, and org", () => {
		const store = openLogStore({ memory: true });
		store.appendRequest(rec(0, { status: 200, path: "/api/memories/recall" }));
		store.appendRequest(rec(1, { status: 404, path: "/api/memories/x" }));
		store.appendRequest(rec(2, { status: 500, path: "/api/memories/recall", org: "other-org" }));
		store.appendRequest(rec(3, { status: 503, path: "/api/graph" }));

		// 5xx class → the 500 + 503.
		const fivexx = store.queryRequests(resolveHistoryQuery({ status: "5xx" }));
		expect(fivexx.records.map((r) => r.status).sort()).toEqual([500, 503]);

		// path prefix → /api/memories/* (recall + x), not /api/graph.
		const mem = store.queryRequests(resolveHistoryQuery({ path: "/api/memories" }));
		expect(mem.records).toHaveLength(3);
		expect(mem.records.every((r) => r.path.startsWith("/api/memories"))).toBe(true);

		// org filter → only the other-org row.
		const otherOrg = store.queryRequests(resolveHistoryQuery({ org: "other-org" }));
		expect(otherOrg.records).toHaveLength(1);
		expect(otherOrg.records[0]?.status).toBe(500);
		store.close();
	});

	it("treats a literal `_` in the path filter as a character, not a LIKE wildcard (ESCAPE clause)", () => {
		// W-1 regression: without `ESCAPE '\'` the bound `\_` stays a wildcard and `/api/memories_`
		// over-matches `/api/memories/recall`. The filter must prefix-match the literal underscore only.
		const store = openLogStore({ memory: true });
		store.appendRequest(rec(0, { path: "/api/memories_export" }));
		store.appendRequest(rec(1, { path: "/api/memories/recall" }));
		store.appendRequest(rec(2, { path: "/api/memoriesZexport" }));

		const underscore = store.queryRequests(resolveHistoryQuery({ path: "/api/memories_" }));
		expect(underscore.records.map((r) => r.path)).toEqual(["/api/memories_export"]);
		store.close();
	});

	it("filters by exact status and time range", () => {
		const store = openLogStore({ memory: true });
		store.appendRequest(rec(1, { status: 404 }));
		store.appendRequest(rec(2, { status: 200 }));
		store.appendRequest(rec(3, { status: 404 }));

		const notFound = store.queryRequests(resolveHistoryQuery({ status: "404" }));
		expect(notFound.records).toHaveLength(2);
		expect(notFound.records.every((r) => r.status === 404)).toBe(true);

		// since/until window: only record #2 (time …:02Z).
		const windowed = store.queryRequests(
			resolveHistoryQuery({ since: "2026-06-20T00:00:02.000Z", until: "2026-06-20T00:00:02.999Z" }),
		);
		expect(windowed.records).toHaveLength(1);
		expect(windowed.records[0]?.status).toBe(200);
		store.close();
	});

	it("AC-2: pagination returns the next OLDER window with no duplicates or gaps", () => {
		const store = openLogStore({ memory: true });
		for (let i = 0; i < 10; i++) store.appendRequest(rec(i));

		// Page 1: the newest 4 (records 9,8,7,6).
		const page1 = store.queryRequests(resolveHistoryQuery({ limit: "4" }));
		expect(page1.records.map((r) => r.path)).toEqual([
			"/api/memories/recall/9",
			"/api/memories/recall/8",
			"/api/memories/recall/7",
			"/api/memories/recall/6",
		]);
		expect(page1.nextCursor).not.toBeNull();

		// Page 2: the NEXT older window (5,4,3,2) — no overlap with page 1, no gap.
		const page2 = store.queryRequests(resolveHistoryQuery({ limit: "4", cursor: page1.nextCursor ?? undefined }));
		expect(page2.records.map((r) => r.path)).toEqual([
			"/api/memories/recall/5",
			"/api/memories/recall/4",
			"/api/memories/recall/3",
			"/api/memories/recall/2",
		]);

		// Page 3: the last two (1,0); no further cursor.
		const page3 = store.queryRequests(resolveHistoryQuery({ limit: "4", cursor: page2.nextCursor ?? undefined }));
		expect(page3.records.map((r) => r.path)).toEqual(["/api/memories/recall/1", "/api/memories/recall/0"]);
		expect(page3.nextCursor).toBeNull();

		// No id appears on two pages (no duplicate across boundaries).
		const allPaths = [...page1.records, ...page2.records, ...page3.records].map((r) => r.path);
		expect(new Set(allPaths).size).toBe(10);
		store.close();
	});

	it("an unfiltered call returns the newest page", () => {
		const store = openLogStore({ memory: true });
		for (let i = 0; i < 3; i++) store.appendRequest(rec(i));
		const page = store.queryRequests(resolveHistoryQuery({}));
		expect(page.records[0]?.path).toBe("/api/memories/recall/2");
		store.close();
	});
});

describe("PRD-043a retention (AC-5)", () => {
	it("AC-5: writing past the row cap prunes the oldest, enforced exactly by the startup sweep", () => {
		// Write 50 rows past a tiny row cap, close, then re-open: the unconditional startup prune
		// (FR-6 / OQ-3) enforces the cap deterministically — newest `maxRows` kept, oldest dropped.
		const w = openLogStore({ baseDir: dir, retention: { maxRows: 5, maxAgeDays: 365_000 } });
		for (let i = 0; i < 50; i++) w.appendRequest(rec(i % 60, { path: `/p/${i}` }));
		w.close();

		const r = openLogStore({ baseDir: dir, retention: { maxRows: 5, maxAgeDays: 365_000 } });
		const page = r.queryRequests(resolveHistoryQuery({ limit: "1000" }));
		// Exactly the cap, and the retained rows are the NEWEST (highest /p/<i>).
		expect(page.records.length).toBe(5);
		expect(page.records[0]?.path).toBe("/p/49");
		expect(page.records.map((x) => x.path)).toEqual(["/p/49", "/p/48", "/p/47", "/p/46", "/p/45"]);
		r.close();
		// This is the only retention case that does 50 individual disk-backed node:sqlite writes
		// (each its own fsync) plus a close-checkpoint and a reopen-sweep. That real I/O fits well
		// under the 5s default locally, but a contended Windows CI runner can exceed it — the prune
		// LOGIC is already proven by the in-memory + age-sweep siblings, so the only thing the
		// default timeout catches here is runner slowness. Give this disk-bound case headroom.
	}, 30_000);

	it("the amortized on-write prune keeps the store bounded over many writes", () => {
		// The opportunistic prune fires every PRUNE_EVERY_N_WRITES (256) appends, so after a large
		// burst the row count stays bounded (cap + at most one cadence window), never unbounded.
		const store = openLogStore({ memory: true, retention: { maxRows: 5, maxAgeDays: 365_000 } });
		for (let i = 0; i < 600; i++) store.appendRequest(rec(i % 60, { path: `/p/${i}` }));
		const page = store.queryRequests(resolveHistoryQuery({ limit: "1000" }));
		// Bounded by cap + the un-pruned tail since the last cadence sweep (< 256), never the full 600.
		expect(page.records.length).toBeLessThan(256);
		store.close();
	});

	it("AC-5 (disk): a startup sweep drops age-expired rows when a fresh daemon re-opens", () => {
		// Write an old + a fresh row under a 1-day age cap, close, then re-open with a clock advanced
		// past the old row's age so the STARTUP sweep prunes it (proves the restart-time retention).
		const writeClock = { now: () => Date.parse("2026-06-20T00:00:00.000Z") };
		const w = openLogStore({ baseDir: dir, retention: { maxAgeDays: 1 }, clock: writeClock });
		w.appendRequest(rec(0, { time: "2026-06-18T00:00:00.000Z", path: "/old" }));
		w.appendRequest(rec(1, { time: "2026-06-20T00:00:00.000Z", path: "/fresh" }));
		w.close();

		// Re-open: the startup sweep uses the (same) clock; /old is > 1 day before now → pruned.
		const r = openLogStore({ baseDir: dir, retention: { maxAgeDays: 1 }, clock: writeClock });
		const page = r.queryRequests(resolveHistoryQuery({ limit: "1000" }));
		expect(page.records.map((x) => x.path)).toEqual(["/fresh"]);
		r.close();
	});
});

describe("PRD-043a fail-soft (AC-4 / FR-2)", () => {
	it("the NULL no-op store never persists and returns an empty page", () => {
		expect(NULL_LOG_STORE.persistent).toBe(false);
		NULL_LOG_STORE.appendRequest(rec(0));
		NULL_LOG_STORE.appendEvent({ time: "t", event: "e", fields: {} } satisfies EventLogRecord);
		expect(NULL_LOG_STORE.queryRequests(resolveHistoryQuery({})).records).toHaveLength(0);
		NULL_LOG_STORE.close();
	});

	it("a closed store degrades to a no-op without throwing", () => {
		const store = openLogStore({ memory: true });
		store.appendRequest(rec(0));
		store.close();
		// Post-close writes + reads are swallowed (no throw into the request path).
		expect(() => store.appendRequest(rec(1))).not.toThrow();
		expect(store.queryRequests(resolveHistoryQuery({})).records).toHaveLength(0);
	});

	it("openLogStore surfaces an unavailable driver ONCE and returns the no-op", () => {
		// Simulate `node:sqlite` being unavailable by pointing the open at a path that cannot be a
		// directory — the mkdir/open throws and the fail-soft guard degrades to NULL_LOG_STORE. We
		// assert the failure sink fired exactly once.
		const fires: string[] = [];
		// A baseDir whose parent is a FILE forces mkdirSync to throw (ENOTDIR), exercising the guard.
		const filePath = join(dir, "not-a-dir.txt");
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(filePath, "x");
		const store = openLogStore({ baseDir: filePath, onceFailure: (m) => fires.push(m) });
		expect(store.persistent).toBe(false);
		expect(fires).toHaveLength(1);
		expect(fires[0]).toContain("non-fatal");
	});
});

describe("PRD-043a cursor codec", () => {
	it("round-trips a cursor and rejects garbage", () => {
		const token = encodeCursor({ beforeId: 42 });
		expect(decodeCursor(token)).toEqual({ beforeId: 42 });
		expect(decodeCursor(undefined)).toBeUndefined();
		expect(decodeCursor("")).toBeUndefined();
		expect(decodeCursor("not-base64-$$$")).toBeUndefined();
		// A well-formed base64 of a non-cursor object → undefined (fail-safe).
		expect(decodeCursor(Buffer.from('{"x":1}', "utf8").toString("base64url"))).toBeUndefined();
	});
});

describe("PRD-043a request_log table name is sqlIdent-guarded", () => {
	it("uses the documented table name", () => {
		expect(REQUEST_LOG_TABLE).toBe("request_log");
	});
});
