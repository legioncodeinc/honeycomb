/**
 * PRD-059c — per-project counts aggregate (c-AC-1 STATE / c-AC-2 inbox size).
 *
 * Unit-level coverage of `readProjectCounts`: it issues ONE grouped aggregate over `memories` and
 * ONE over `sessions` (two round-trips, never N per-project COUNTs), folds the empty-string
 * `project_id` bucket onto `__unsorted__` (c-AC-2), and is FAIL-SOFT — a non-`ok` storage result
 * zeroes that dimension rather than throwing, so a flaky backend never fatals the read. A fake
 * `StorageQuery` returns scripted rows keyed off the statement verb (memories vs sessions), with NO
 * live network.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { connectionError, ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/daemon/storage/catalog/index.js";
import { readProjectCounts } from "../../../../src/daemon/runtime/projects/project-counts.js";

const SCOPE: QueryScope = { org: "acme", workspace: "backend" };

/**
 * A fake storage that routes each statement to a per-table scripted result: a `FROM "memories"`
 * statement gets `memories`, a `FROM "sessions"` statement gets `sessions`. It also records the SQL
 * issued so a test can assert exactly two round-trips (one grouped read per table).
 */
function fakeStorage(scripted: {
	memories?: QueryResult;
	sessions?: QueryResult;
	calls?: string[];
}): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			scripted.calls?.push(sql);
			if (/FROM\s+"memories"/i.test(sql)) return scripted.memories ?? ok([], 0);
			if (/FROM\s+"sessions"/i.test(sql)) return scripted.sessions ?? ok([], 0);
			return ok([], 0);
		},
	};
}

function countRow(projectId: string, n: number, last = ""): StorageRow {
	return { project_id: projectId, n, last_capture: last };
}

describe("PRD-059c readProjectCounts", () => {
	it("returns per-project memory + session counts from the two grouped aggregates", async () => {
		const calls: string[] = [];
		const storage = fakeStorage({
			memories: ok([countRow("api", 5, "2026-06-01T00:00:00Z"), countRow("web", 2)], 2),
			sessions: ok([countRow("api", 9, "2026-06-10T00:00:00Z")], 1),
			calls,
		});
		const counts = await readProjectCounts(storage, SCOPE);

		expect(counts.complete).toBe(true);
		expect(counts.byProjectId.get("api")).toEqual({
			memoryCount: 5,
			sessionCount: 9,
			lastCapture: "2026-06-10T00:00:00Z", // the later of the two timestamps.
		});
		expect(counts.byProjectId.get("web")).toEqual({ memoryCount: 2, sessionCount: 0, lastCapture: null });
		// Exactly TWO round-trips — one grouped aggregate per table, never N per-project COUNTs.
		expect(calls).toHaveLength(2);
		expect(calls.some((s) => /GROUP BY/i.test(s))).toBe(true);
	});

	it("c-AC-2: folds the empty-string project_id bucket onto __unsorted__ (summed with an explicit inbox bucket)", async () => {
		const storage = fakeStorage({
			// One row left '' (unresolved) AND one already stamped __unsorted__ — both belong to the inbox.
			memories: ok([countRow("", 3), countRow(UNSORTED_PROJECT_ID, 4)], 2),
			sessions: ok([countRow("", 7)], 1),
		});
		const counts = await readProjectCounts(storage, SCOPE);
		const inbox = counts.byProjectId.get(UNSORTED_PROJECT_ID);
		expect(inbox?.memoryCount).toBe(7); // 3 ('') + 4 (__unsorted__) summed.
		expect(inbox?.sessionCount).toBe(7);
		// The '' key is never surfaced directly — it is always folded onto the reserved inbox id.
		expect(counts.byProjectId.has("")).toBe(false);
	});

	it("fail-soft: a memories-aggregate storage error zeroes memoryCount but still serves sessionCount (no throw)", async () => {
		const storage = fakeStorage({
			memories: connectionError("backend flap"), // the memories aggregate fails soft.
			sessions: ok([countRow("api", 9)], 1),
		});
		const counts = await readProjectCounts(storage, SCOPE);
		expect(counts.complete).toBe(false); // one dimension failed.
		expect(counts.byProjectId.get("api")).toEqual({ memoryCount: 0, sessionCount: 9, lastCapture: null });
	});

	it("fail-soft: BOTH aggregates failing yields an empty map and complete:false, never a throw", async () => {
		const storage = fakeStorage({
			memories: connectionError("down"),
			sessions: connectionError("down"),
		});
		const counts = await readProjectCounts(storage, SCOPE);
		expect(counts.complete).toBe(false);
		expect(counts.byProjectId.size).toBe(0);
	});

	it("parses a string-typed count (the backend may return count(*) as text)", async () => {
		const storage = fakeStorage({
			memories: ok([{ project_id: "api", n: "12", last_capture: "" }], 1),
			sessions: ok([], 0),
		});
		const counts = await readProjectCounts(storage, SCOPE);
		expect(counts.byProjectId.get("api")?.memoryCount).toBe(12);
	});
});
