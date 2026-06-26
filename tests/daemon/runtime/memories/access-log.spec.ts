/**
 * PRD-058e, the access-event log (`recordAccess` + cache maintenance + compaction) suite.
 *
 * Verification posture: a FAKE {@link StorageQuery} captures the statements recall emits + serves
 * controlled rows, so the append-only INSERT, the `memories` cache read-modify-write, the
 * fail-soft history read, and the compaction fold/delete are asserted deterministically with no
 * live DeepLake, no creds, no clock.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	compactAccessLog,
	readAccessHistory,
	recordAccess,
	type AccessLogDeps,
} from "../../../../src/daemon/runtime/memories/access-log.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-06-26T00:00:00.000Z");

/** A scripted fake storage: routes by statement shape, records every SQL it saw. */
function fakeStorage(handlers: {
	onInsertAccess?: (sql: string) => QueryResult;
	memoriesRead?: QueryResult;
	accessRead?: QueryResult;
	onUpdate?: (sql: string) => QueryResult;
	onDelete?: (sql: string) => QueryResult;
}): { storage: StorageQuery; sql: string[] } {
	const sql: string[] = [];
	const storage: StorageQuery = {
		async query(statement: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sql.push(statement);
			if (/^INSERT INTO "memory_access"/.test(statement)) return handlers.onInsertAccess?.(statement) ?? ok([], 0);
			if (/^SELECT .* FROM "memories"/.test(statement)) return handlers.memoriesRead ?? ok([], 0);
			if (/^SELECT .* FROM "memory_access"/.test(statement)) return handlers.accessRead ?? ok([], 0);
			if (/^UPDATE "memories"/.test(statement)) return handlers.onUpdate?.(statement) ?? ok([], 0);
			if (/^DELETE FROM "memory_access"/.test(statement)) return handlers.onDelete?.(statement) ?? ok([], 0);
			return ok([], 0);
		},
	};
	return { storage, sql };
}

const fixedDeps = (storage: StorageQuery): AccessLogDeps => ({
	storage,
	now: () => new Date(NOW),
	newId: () => "evt-1",
});

describe("PRD-058e recordAccess, append-only event + cache maintenance", () => {
	it("appends an append-only memory_access row with the event fields", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 3 }], 0) });
		const res = await recordAccess("mem-1", 1, "recall", fixedDeps(storage), SCOPE);
		expect(res.appended).toBe(true);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_access"'));
		expect(insert).toBeDefined();
		expect(insert).toContain("'mem-1'"); // memory_id literal.
		expect(insert).toContain("'recall'"); // kind literal.
		expect(insert).toContain("'evt-1'"); // injected id.
	});

	it("a `recall` event bumps access_count but does NOT advance last_reinforced_at", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 5 }], 0) });
		await recordAccess("mem-2", 1, "recall", fixedDeps(storage), SCOPE);
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toBeDefined();
		expect(update).toContain("access_count = 6"); // 5 + 1.
		expect(update).not.toContain("last_reinforced_at"); // recall does not reinforce.
	});

	it("a `reinforce` event advances last_reinforced_at to the event time", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 0 }], 0) });
		await recordAccess("mem-3", 1, "reinforce", fixedDeps(storage), SCOPE);
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toBeDefined();
		expect(update).toContain("access_count = 1");
		expect(update).toContain("last_reinforced_at = '2026-06-26T00:00:00.000Z'");
	});

	it("cache maintenance is FAIL-SOFT: a missing memories row → no UPDATE, event still appended", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([], 0) }); // no live row.
		const res = await recordAccess("ghost", 1, "reinforce", fixedDeps(storage), SCOPE);
		expect(res.appended).toBe(true); // the load-bearing event landed.
		expect(sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(false); // no cache write.
	});

	it("a failed INSERT reports appended:false but never throws", async () => {
		const { storage } = fakeStorage({
			onInsertAccess: () => ({ kind: "query_error", message: "boom" }),
			memoriesRead: ok([{ access_count: 0 }], 0),
		});
		const res = await recordAccess("mem-x", 1, "recall", fixedDeps(storage), SCOPE);
		expect(res.appended).toBe(false);
	});
});

describe("PRD-058e readAccessHistory, fail-soft, time-mapped", () => {
	it("maps rows to AccessEvent[], oldest-first, skipping unparseable timestamps", async () => {
		const rows: StorageRow[] = [
			{ at: new Date(NOW - 10 * MS_PER_DAY).toISOString(), usefulness: 1, kind: "create" },
			{ at: "garbage", usefulness: 1, kind: "recall" }, // skipped.
			{ at: new Date(NOW - 1 * MS_PER_DAY).toISOString(), usefulness: 0.5, kind: "reinforce" },
		];
		const { storage } = fakeStorage({ accessRead: ok(rows, 0) });
		const history = await readAccessHistory("mem-1", fixedDeps(storage), SCOPE);
		expect(history).toHaveLength(2);
		expect(history[0]!.usefulness).toBe(1);
		expect(history[1]!.usefulness).toBe(0.5);
	});

	it("a missing memory_access table (query error) → EMPTY history, never a throw", async () => {
		const { storage } = fakeStorage({ accessRead: { kind: "query_error", message: 'relation "memory_access" does not exist' } });
		const history = await readAccessHistory("mem-1", fixedDeps(storage), SCOPE);
		expect(history).toEqual([]);
	});
});

describe("PRD-058e compactAccessLog, keep last N, fold the rest", () => {
	it("≤ keepN events → nothing folded (no delete)", async () => {
		const rows: StorageRow[] = [
			{ id: "a", at: new Date(NOW - 2 * MS_PER_DAY).toISOString(), kind: "recall" },
			{ id: "b", at: new Date(NOW - 1 * MS_PER_DAY).toISOString(), kind: "reinforce" },
		];
		const { storage, sql } = fakeStorage({ accessRead: ok(rows, 0) });
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 32);
		expect(res.folded).toBe(0);
		expect(sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(false);
	});

	it("> keepN events → folds the oldest, accumulates the count, deletes the folded ids", async () => {
		// 5 events, keep 2 → fold the oldest 3.
		const rows: StorageRow[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			at: new Date(NOW - (5 - i) * MS_PER_DAY).toISOString(),
			kind: i === 1 ? "reinforce" : "recall",
		}));
		const { storage, sql } = fakeStorage({
			accessRead: ok(rows, 0),
			memoriesRead: ok([{ access_count: 10, last_reinforced_at: "" }], 0),
		});
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 2);
		expect(res.folded).toBe(3);
		// The cache is accumulated by the folded count BEFORE the delete (10 + 3 = 13).
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toContain("access_count = 13");
		// last_reinforced_at advances to the folded reinforce event (e1, the oldest-3 set).
		expect(update).toContain("last_reinforced_at = ");
		// The delete targets exactly the 3 folded ids.
		const del = sql.find((s) => s.startsWith('DELETE FROM "memory_access"'));
		expect(del).toContain("'e0'");
		expect(del).toContain("'e1'");
		expect(del).toContain("'e2'");
		expect(del).not.toContain("'e3'");
		expect(del).not.toContain("'e4'");
	});

	it("a read error → folded 0, never a throw (retry next run)", async () => {
		const { storage } = fakeStorage({ accessRead: { kind: "connection_error", message: "reset" } });
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 2);
		expect(res.folded).toBe(0);
	});
});
