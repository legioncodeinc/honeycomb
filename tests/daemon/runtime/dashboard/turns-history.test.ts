/**
 * PRD-043c — the browsable TURNS history read (the additive `fetchSessionsView` paging).
 *
 * Proves the daemon-side turns read for the Logs page's Turns section:
 *   AC-3   the read targets the `sessions` table BY NAME via `sqlIdent("sessions")` (035a D-3 —
 *          the table is not renamed; the page labels it "Turns").
 *   FR-3   ADDITIVE paging: with no options the legacy newest-50 panel view is returned (backward
 *          compatible); with options it pages on a `(creation_date, id)` cursor + a `nextCursor`.
 *   D-4    METADATA ONLY: the read projects id/project/creation_date/path — never a transcript /
 *          body / JSONB column (the SELECT carries no body column).
 *   OQ-1   DeepLake eventual consistency — the paged read makes NO single-immediate-read assumption;
 *          a fail-soft non-ok result degrades to an empty page (the caller polls until convergence).
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	decodeSessionsCursor,
	DEFAULT_SESSIONS_LIMIT,
	encodeSessionsCursor,
	fetchSessionsView,
	MAX_SESSIONS_LIMIT,
	resolveSessionsLimit,
} from "../../../../src/daemon/runtime/dashboard/api.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "default" };

/** A fake StorageQuery that records the SQL it saw and returns canned rows (or a forced error). */
function fakeStorage(rows: StorageRow[] | "error"): { storage: StorageQuery; seen: string[] } {
	const seen: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string): Promise<QueryResult> {
			seen.push(sql);
			if (rows === "error") return { kind: "query_error", message: "forced", status: 500 };
			return { kind: "ok", rows, durationMs: 1 };
		},
	};
	return { storage, seen };
}

/** A canned `sessions` row (id/project/creation_date/path — metadata only, no body/JSONB). */
function turn(id: string, creationDate: string, project = "/repo/honeycomb"): StorageRow {
	return { id, project, creation_date: creationDate, path: `/sessions/${id}` } as unknown as StorageRow;
}

describe("PRD-043c resolveSessionsLimit clamps the browsable page size", () => {
	it("defaults a missing/garbage value and clamps to [1, MAX]", () => {
		expect(resolveSessionsLimit(undefined)).toBe(DEFAULT_SESSIONS_LIMIT);
		expect(resolveSessionsLimit("garbage")).toBe(DEFAULT_SESSIONS_LIMIT);
		expect(resolveSessionsLimit("-3")).toBe(DEFAULT_SESSIONS_LIMIT);
		expect(resolveSessionsLimit("25")).toBe(25);
		expect(resolveSessionsLimit("99999")).toBe(MAX_SESSIONS_LIMIT);
	});
});

describe("PRD-043c fetchSessionsView (additive paging)", () => {
	it("AC-3: the read targets the `sessions` table by name and projects metadata only", async () => {
		const { storage, seen } = fakeStorage([turn("t1", "2026-06-22T09:00:00.000Z")]);
		await fetchSessionsView(storage, SCOPE);
		const sql = seen[0] ?? "";
		// sqlIdent("sessions") keeps the table name verbatim (035a D-3) — newest-first.
		expect(sql).toMatch(/FROM\s+"sessions"/i);
		expect(sql).toMatch(/ORDER BY\s+creation_date DESC/i);
		// METADATA ONLY — no transcript/body/JSONB column in the projection (D-4 / AC-5).
		expect(sql).not.toMatch(/jsonb/i);
		expect(sql).not.toMatch(/\bbody\b/i);
		expect(sql).not.toMatch(/\btranscript\b/i);
	});

	it("backward-compatible: with no options, returns the legacy newest-page shape", async () => {
		const { storage } = fakeStorage([turn("t1", "2026-06-22T09:00:00.000Z"), turn("t2", "2026-06-22T08:00:00.000Z")]);
		const view = await fetchSessionsView(storage, SCOPE);
		expect(view.sessions).toHaveLength(2);
		expect(view.sessions[0]?.sessionId).toBe("t1");
		// The placeholder eventCount stays 0 (OQ-3 — a real count defers to a coordinated PRD-035 change).
		expect(view.sessions[0]?.eventCount).toBe(0);
		expect(view.sessions[0]?.status).toBe("captured");
	});

	it("FR-3: pages on a (creation_date, id) cursor — a full page yields a nextCursor", async () => {
		// limit 2, but 3 rows returned → hasMore → a nextCursor encoding the 2nd row.
		const { storage, seen } = fakeStorage([
			turn("t3", "2026-06-22T09:00:03.000Z"),
			turn("t2", "2026-06-22T09:00:02.000Z"),
			turn("t1", "2026-06-22T09:00:01.000Z"),
		]);
		const page = await fetchSessionsView(storage, SCOPE, { limit: 2 });
		// The page is the first `limit` rows; the extra row signals more.
		expect(page.sessions.map((s) => s.sessionId)).toEqual(["t3", "t2"]);
		expect(page.nextCursor).not.toBeNull();
		// The cursor decodes to the last returned row's (creation_date, id).
		const cursor = decodeSessionsCursor(page.nextCursor ?? undefined);
		expect(cursor).toEqual({ creationDate: "2026-06-22T09:00:02.000Z", id: "t2" });

		// A subsequent paged read carries a cursor predicate (page strictly OLDER).
		const before = { creationDate: "2026-06-22T09:00:02.000Z", id: "t2" };
		await fetchSessionsView(storage, SCOPE, { limit: 2, before });
		const pagedSql = seen[seen.length - 1] ?? "";
		expect(pagedSql).toMatch(/WHERE\s+\(creation_date </i);
	});

	it("the last page (no extra row) yields a null nextCursor", async () => {
		const { storage } = fakeStorage([turn("t1", "2026-06-22T09:00:01.000Z")]);
		const page = await fetchSessionsView(storage, SCOPE, { limit: 50 });
		expect(page.nextCursor).toBeNull();
	});

	it("OQ-1 (eventual consistency): a non-ok storage result fails soft to an empty page (no throw)", async () => {
		const { storage } = fakeStorage("error");
		const page = await fetchSessionsView(storage, SCOPE, { limit: 50 });
		expect(page.sessions).toHaveLength(0);
		expect(page.nextCursor).toBeNull();
	});
});

describe("PRD-043c sessions cursor codec", () => {
	it("round-trips a (creation_date, id) cursor and rejects garbage", () => {
		const token = encodeSessionsCursor({ creationDate: "2026-06-22T09:00:00.000Z", id: "t1" });
		expect(decodeSessionsCursor(token)).toEqual({ creationDate: "2026-06-22T09:00:00.000Z", id: "t1" });
		expect(decodeSessionsCursor(undefined)).toBeUndefined();
		expect(decodeSessionsCursor("")).toBeUndefined();
		expect(decodeSessionsCursor("garbage$$$")).toBeUndefined();
		expect(decodeSessionsCursor(Buffer.from('{"x":1}', "utf8").toString("base64url"))).toBeUndefined();
	});
});
