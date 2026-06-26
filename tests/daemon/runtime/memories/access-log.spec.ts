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

	it("> keepN events → folds the oldest (watermark + reinforce advance, NO count change) then deletes the folded ids", async () => {
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
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		// SINGLE-OWNER (round-3 #1): compaction does NOT touch access_count — it is incremented only at
		// append. Re-adding the fold count here would DOUBLE-COUNT every aged-out event.
		expect(update).not.toContain("access_count");
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

		// Run 2: the delete failed, so the same rows are STILL present, but the watermark CURSOR is now (e2At, e2).
		// The horizon (e0,e1,e2) is all at-or-before the cursor → NOTHING is re-folded (no double count).
		const run2 = fakeStorage({
			memoriesRead: ok([{ access_count: 13, access_compacted_at: e2At, access_compacted_id: "e2" }], 0), // (at,id) cursor persisted from run 1.
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

	// ── CRITICAL (round-2 #1): an UNREADABLE watermark ABORTS, it must NOT re-fold from the start ──
	it("a watermark READ ERROR aborts (folded 0, NO cache write, NO delete), never re-folds already-folded rows", async () => {
		// 5 events, keep 2 → the horizon (e0,e1,e2) was already folded on a prior run, but the watermark
		// read now FAILS (a transient query error). Collapsing that error into "no watermark" would re-fold
		// the whole horizon and DOUBLE-COUNT. The read-error must abort: no count change, no destructive delete.
		const rows: StorageRow[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			at: new Date(NOW - (5 - i) * MS_PER_DAY).toISOString(),
			kind: "recall",
		}));
		const { storage, sql } = fakeStorage({
			// The `memories` SELECT (the watermark read) FAILS, distinct from a genuinely-absent watermark.
			memoriesRead: { kind: "query_error", message: "watermark-read-boom" },
			accessRead: ok(rows, 0),
		});
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 2);
		expect(res.folded).toBe(0); // aborted: nothing folded this run.
		// No count-advancing cache UPDATE and no destructive DELETE on an unreadable watermark.
		expect(sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(false);
		expect(sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(false);
	});

	// ── CRITICAL (round-2 #2): same-timestamp siblings are NOT lost across a partial-failure re-run ──
	it("same-`at` rows: a partial run folds a SUBSET; the re-run folds the remaining same-`at` sibling (no loss)", async () => {
		// THREE events share ONE identical `at`; keep 1 → the horizon is the OLDEST 2 (in (at,id) order: e1,e2).
		// Run 1 persisted a cursor at (sharedAt, e1): it folded e1 but (simulating a position-sensitive partial
		// fold) the sibling e2 at the SAME `at` is still NOT folded. An `at`-ONLY cursor would treat e2 as
		// already folded (sharedAt === watermark) and DELETE it WITHOUT counting it → a silent loss. The
		// (at,id) cursor compares e2 STRICTLY AFTER (sharedAt, e1), so e2 is folded on the re-run.
		const sharedAt = new Date(NOW - 1 * MS_PER_DAY).toISOString();
		const rows: StorageRow[] = [
			{ id: "e1", at: sharedAt, kind: "recall" },
			{ id: "e2", at: sharedAt, kind: "recall" },
			{ id: "e3", at: new Date(NOW).toISOString(), kind: "recall" }, // newest, kept (keepN=1).
		];
		const { storage, sql } = fakeStorage({
			// Cursor persisted from a prior run that folded only e1: (sharedAt, "e1").
			memoriesRead: ok([{ access_count: 1, access_compacted_at: sharedAt, access_compacted_id: "e1" }], 0),
			accessRead: ok(rows, 0),
		});
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 1);
		// e2 (the same-`at` sibling strictly after the cursor) IS folded, never silently dropped.
		expect(res.folded).toBe(1);
		const update = sql.find((s) => s.startsWith('UPDATE "memories"'));
		// Single-owner: compaction advances the watermark/reinforcement, never access_count.
		expect(update).not.toContain("access_count");
		// The cursor advances to (sharedAt, e2): the id half disambiguates the same-`at` sibling.
		expect(update).toContain("access_compacted_id = CASE WHEN");
		const del = sql.find((s) => s.startsWith('DELETE FROM "memory_access"'));
		expect(del).toContain("'e2'"); // the folded sibling is then deleted.
	});

	it("a legacy at-only watermark (empty id) does NOT re-fold same-`at` rows (no double count on migration)", async () => {
		// A pre-companion-column watermark stored only `access_compacted_at` (id absent → ""). A same-`at`
		// horizon row must be treated as at-or-before that legacy cursor (already folded) so migrating off an
		// at-only watermark never double-counts. Three same-`at` rows, keep 1, legacy cursor at sharedAt (id "").
		const sharedAt = new Date(NOW - 1 * MS_PER_DAY).toISOString();
		const rows: StorageRow[] = [
			{ id: "e1", at: sharedAt, kind: "recall" },
			{ id: "e2", at: sharedAt, kind: "recall" },
			{ id: "e3", at: new Date(NOW).toISOString(), kind: "recall" },
		];
		const { storage, sql } = fakeStorage({
			memoriesRead: ok([{ access_count: 2, access_compacted_at: sharedAt, access_compacted_id: "" }], 0), // legacy: no id.
			accessRead: ok(rows, 0),
		});
		const res = await compactAccessLog("mem-1", fixedDeps(storage), SCOPE, 1);
		expect(res.folded).toBe(0); // both same-`at` horizon rows are at-or-before the legacy cursor → no re-fold.
		expect(sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(false);
		// It still re-issues the idempotent DELETE so the (already-folded) rows converge.
		expect(sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(true);
	});

	// ── CRITICAL (round-3 #2): a MISSING memories row ABORTS — no delete without persisting the watermark ──
	it("a MISSING memories row aborts compaction (folded 0, NO cache write, NO delete) — events are never lost", async () => {
		// The horizon would fold, but the memories row is ABSENT (the watermark read returns 0 rows). The
		// cache UPDATE would match 0 rows (a silent no-op), so the watermark never persists — yet a delete
		// would still fire and LOSE the raw events. Distinguishing "missing row" from "never compacted"
		// (both were `rows.length === 0` before) is what makes the abort possible.
		const rows: StorageRow[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			at: new Date(NOW - (5 - i) * MS_PER_DAY).toISOString(),
			kind: "recall",
		}));
		const { storage, sql } = fakeStorage({
			memoriesRead: ok([], 0), // the memories row is ABSENT (not just an empty watermark).
			accessRead: ok(rows, 0),
		});
		const res = await compactAccessLog("mem-gone", fixedDeps(storage), SCOPE, 2);
		expect(res.folded).toBe(0); // aborted: nothing folded.
		// No watermark/cache UPDATE and — critically — NO destructive DELETE when there is no row to persist to.
		expect(sql.some((s) => s.startsWith('UPDATE "memories"'))).toBe(false);
		expect(sql.some((s) => s.startsWith('DELETE FROM "memory_access"'))).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The single-owner INVARIANT (round-3 #1): an access is counted EXACTLY ONCE end to end. We append N
// events (each `recordAccess` bumps `access_count` by 1), then compact (folds the oldest, prunes raw rows).
// The persisted `access_count` must equal N BOTH before and after compaction — a folded event contributes
// once (no inflation) and is never dropped (no loss). A STATEFUL fake applies the emitted SQL to a real
// `access_count` cell + raw-row set so the count is computed through the actual append→fold→read path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("PRD-058e access_count is counted EXACTLY ONCE across compaction (round-3 #1 invariant)", () => {
	/** A stateful fake: a single memories row (`access_count` + watermark cells) and the raw `memory_access` set. */
	function statefulStorage(initial: { rows: StorageRow[] }): {
		storage: StorageQuery;
		state: { accessCount: number; compactedAt: string; compactedId: string; rows: StorageRow[] };
	} {
		const state = { accessCount: 0, compactedAt: "", compactedId: "", rows: [...initial.rows] };
		const storage: StorageQuery = {
			async query(statement: string): Promise<QueryResult> {
				// Append: the raw event row is populated FROM the actual INSERT (never a manual pre-seed), so
				// the invariant fails if recordAccess ever drops the append-only event while still bumping
				// access_count via its separate UPDATE (the cross-step contract this test guards).
				if (/^INSERT INTO "memory_access"/.test(statement)) {
					const m = /\(([^)]+)\) VALUES \((.+)\)$/.exec(statement);
					if (m) {
						const cols = m[1]!.split(/,\s*/).map((c) => c.trim());
						const vals = m[2]!.split(/,\s*/).map((v) => v.trim().replace(/^'([\s\S]*)'$/, "$1"));
						const row: StorageRow = {};
						cols.forEach((c, i) => {
							row[c] = vals[i] ?? "";
						});
						state.rows.push(row);
					}
					return ok([], 0);
				}
				// The watermark/count read over "memories": return the live cell (a present row).
				if (/^SELECT .* FROM "memories"/.test(statement)) {
					return ok([{ access_count: state.accessCount, access_compacted_at: state.compactedAt, access_compacted_id: state.compactedId, last_reinforced_at: "" }], 0);
				}
				// The ordered raw-event read for compaction: serve the current raw set (oldest-first).
				if (/^SELECT .* FROM "memory_access"/.test(statement)) {
					return ok([...state.rows].sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id))), 0);
				}
				if (/^UPDATE "memories"/.test(statement)) {
					// Apply a relative access_count increment iff the statement carries one (append path only).
					const m = /access_count = COALESCE\(access_count, 0\) \+ (\d+)/.exec(statement);
					if (m) state.accessCount += Number(m[1]);
					// Apply the watermark advance (compaction path) so a re-run resumes after it.
					const wAt = /access_compacted_at = CASE WHEN[\s\S]*?THEN '([^']+)'/.exec(statement);
					if (wAt) state.compactedAt = wAt[1]!;
					const wId = /access_compacted_id = CASE WHEN[\s\S]*?THEN '([^']+)'/.exec(statement);
					if (wId) state.compactedId = wId[1]!;
					return ok([], 1);
				}
				if (/^DELETE FROM "memory_access"/.test(statement)) {
					// Prune the folded ids from the raw set (the IN-list of id literals).
					const ids = [...statement.matchAll(/'([^']+)'/g)].map((x) => x[1]);
					state.rows = state.rows.filter((r) => !ids.includes(String(r.id)));
					return ok([], 0);
				}
				return ok([], 0);
			},
		};
		return { storage, state };
	}

	it("append N=5 (count→5), compact keep 2 (fold 3) → access_count stays 5; raw set pruned to 2; re-compact is a no-op", async () => {
		const { storage, state } = statefulStorage({ rows: [] });
		// Append N=5 events at distinct times; each recordAccess bumps access_count by exactly 1.
		const N = 5;
		for (let i = 0; i < N; i++) {
			const at = new Date(NOW - (N - i) * MS_PER_DAY);
			// The raw row is populated by the fake's INSERT handler from the real append, not pre-seeded.
			await recordAccess(`mem-1`, 1, "recall", { storage, now: () => at, newId: () => `e${i}` }, SCOPE);
		}
		// INVARIANT before compaction: every append counted once.
		expect(state.accessCount).toBe(N);
		const rawBefore = state.rows.length;
		expect(rawBefore).toBe(N);

		// Compact: keep 2, fold the oldest 3, prune their raw rows.
		const r1 = await compactAccessLog("mem-1", { storage, now: () => new Date(NOW), newId: () => "x" }, SCOPE, 2);
		expect(r1.folded).toBe(3);
		// INVARIANT after compaction: the count is UNCHANGED (no double-count from folding, no loss).
		expect(state.accessCount).toBe(N);
		// The raw log was pruned to the keep horizon (the folded events live on only in access_count).
		expect(state.rows.length).toBe(2);

		// A re-compaction over the now-pruned log changes nothing (≤ keepN) — still exactly N.
		const r2 = await compactAccessLog("mem-1", { storage, now: () => new Date(NOW), newId: () => "x" }, SCOPE, 2);
		expect(r2.folded).toBe(0);
		expect(state.accessCount).toBe(N);
	});
});
