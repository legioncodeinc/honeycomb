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

	it("a `recall` event bumps access_count ATOMICALLY but does NOT advance last_reinforced_at", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 5 }], 0) });
		await recordAccess("mem-2", 1, "recall", fixedDeps(storage), SCOPE);
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toBeDefined();
		// Atomic relative increment (concurrency-safe), NOT a read-then-write to a computed constant.
		expect(update).toContain("access_count = COALESCE(access_count, 0) + 1");
		expect(update).not.toContain("last_reinforced_at"); // recall does not reinforce.
	});

	it("a `reinforce` event advances last_reinforced_at to the event time (CASE MAX, atomic)", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 0 }], 0) });
		await recordAccess("mem-3", 1, "reinforce", fixedDeps(storage), SCOPE);
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toBeDefined();
		expect(update).toContain("access_count = COALESCE(access_count, 0) + 1");
		// Advanced via a CASE MAX so a concurrent later reinforcement is never clobbered by an older one.
		expect(update).toContain("last_reinforced_at = CASE WHEN");
		expect(update).toContain("'2026-06-26T00:00:00.000Z'");
	});

	it("writes the memory's AGENT scope onto the row AND confines the cache bump to that agent (PRD-058e D-2)", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 0 }], 0) });
		await recordAccess("mem-s", 1, "recall", fixedDeps(storage), SCOPE, { agentId: "agent-7", visibility: "private" });
		// The append-only event carries the real agent scope, never the schema defaults.
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_access"'));
		expect(insert).toContain("'agent-7'");
		expect(insert).toContain("'private'");
		// The cache UPDATE is scoped to the SAME agent row (no cross-agent bump).
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toContain("agent_id = 'agent-7'");
		expect(update).toContain("visibility = 'private'");
	});

	it("an absent agent scope falls back to the schema defaults on the row + the cache predicate", async () => {
		const { storage, sql } = fakeStorage({ memoriesRead: ok([{ access_count: 0 }], 0) });
		await recordAccess("mem-d", 1, "recall", fixedDeps(storage), SCOPE);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_access"'));
		expect(insert).toContain("'default'");
		expect(insert).toContain("'global'");
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toContain("agent_id = 'default'");
		expect(update).toContain("visibility = 'global'");
	});

	it("a failed INSERT reports appended:false, never throws, AND issues NO cache UPDATE (no drift past the log)", async () => {
		const { storage, sql } = fakeStorage({
			onInsertAccess: () => ({ kind: "query_error", message: "boom" }),
			memoriesRead: ok([{ access_count: 0 }], 0),
		});
		const res = await recordAccess("mem-x", 1, "recall", fixedDeps(storage), SCOPE);
		expect(res.appended).toBe(false);
		// The denormalized cache must NOT advance when the append-only event did not land (the invariant
		// CodeRabbit flagged: maintainMemoryCache only runs after a successful append).
		expect(sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(false);
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

	it("> keepN events → folds the oldest atomically (count +=, watermark advances) then deletes the folded ids", async () => {
		// 5 events, keep 2 → fold the oldest 3.
		const rows: StorageRow[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			at: new Date(NOW - (5 - i) * MS_PER_DAY).toISOString(),
			kind: i === 1 ? "reinforce" : "recall",
		}));
		const { storage, sql } = fakeStorage({
			// No watermark yet (cold) — every horizon event is newer than an absent watermark.
			memoriesRead: ok([{ access_count: 10, last_reinforced_at: "", access_compacted_at: "" }], 0),
			accessRead: ok(rows, 0),
		});
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 2);
		expect(res.folded).toBe(3);
		// The cache is accumulated atomically (relative +=) BEFORE the delete, NOT a read-then-write constant.
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		expect(update).toContain("access_count = COALESCE(access_count, 0) + 3");
		// last_reinforced_at advances to the folded reinforce event (e1, in the oldest-3 set).
		expect(update).toContain("last_reinforced_at = CASE WHEN");
		// The compaction watermark advances to the newest folded `at` (e2, the 3rd-oldest) in the SAME write.
		expect(update).toContain("access_compacted_at = CASE WHEN");
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

	// ── CRITICAL: idempotency across a partial failure (no double count, no loss) ──
	it("cache-write succeeds + delete FAILS → a re-run does NOT re-fold (no double count)", async () => {
		// 5 events, keep 2 → fold the oldest 3 (e0,e1,e2). Newest folded `at` = e2's stamp.
		const rows: StorageRow[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			at: new Date(NOW - (5 - i) * MS_PER_DAY).toISOString(),
			kind: "recall",
		}));
		const e2At = String(rows[2]!.at);

		// Run 1: cold watermark, the DELETE fails. The cache write (count + watermark) lands.
		const run1 = fakeStorage({
			memoriesRead: ok([{ access_count: 10, access_compacted_at: "" }], 0),
			accessRead: ok(rows, 0),
			onDelete: () => ({ kind: "query_error", message: "delete-boom" }), // delete fails AFTER the fold.
		});
		const r1 = await compactAccessLog("mem-1", fixedDeps(run1.storage), SCOPE, 2);
		expect(r1.folded).toBe(3); // counted once.
		expect(run1.sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(true); // the fold landed.
		expect(run1.sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(true); // delete attempted.

		// Run 2: the delete failed, so the same rows are STILL present — but the watermark is now at e2.
		// The horizon (e0,e1,e2) is all at-or-before the watermark → NOTHING is re-folded (no double count).
		const run2 = fakeStorage({
			memoriesRead: ok([{ access_count: 13, access_compacted_at: e2At }], 0), // watermark persisted from run 1.
			accessRead: ok(rows, 0), // delete never landed → rows unchanged.
		});
		const r2 = await compactAccessLog("mem-1", fixedDeps(run2.storage), SCOPE, 2);
		expect(r2.folded).toBe(0); // no re-fold → no double count.
		// It re-issues the idempotent DELETE so the log still converges.
		expect(run2.sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(true);
		// And it issues NO count-advancing cache UPDATE on the re-run.
		expect(run2.sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(false);
	});

	it("cache-write FAILS → folded 0, NO delete (rows preserved for a clean retry; no loss)", async () => {
		const rows: StorageRow[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			at: new Date(NOW - (5 - i) * MS_PER_DAY).toISOString(),
			kind: "recall",
		}));
		const { storage, sql } = fakeStorage({
			memoriesRead: ok([{ access_count: 10, access_compacted_at: "" }], 0),
			accessRead: ok(rows, 0),
			onUpdate: () => ({ kind: "query_error", message: "cache-boom" }), // the fold cache write fails.
		});
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 2);
		expect(res.folded).toBe(0); // not counted.
		// The raw rows must NOT be deleted when the fold did not land — otherwise the events are LOST.
		expect(sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(false);
	});
});
