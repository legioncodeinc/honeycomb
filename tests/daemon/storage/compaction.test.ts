/**
 * PRD-030 Wave 1 — storage-level version-history compactor (unit halves of
 * AC-2 / AC-4 / AC-5, plus the pure reap-set matrix, highest-never-reaped, and
 * the guarded-SQL floor).
 *
 * Strategy: a scriptable fake `StorageQuery` answers by inspecting the SQL —
 * `SELECT DISTINCT <key>` returns the key set; the per-version `SELECT version,
 * ts` returns the seeded rows for a key; the `DELETE ... IN (...)` records the
 * issued versions (and a "partial DELETE" mode can drop only some). An injected
 * clock makes the time-window deterministic. The compactor is exercised against
 * this fake with NO live backend (the binding-verification posture).
 *
 * The reap rule (D-1): a version is reaped iff it is STRICTLY BELOW the highest
 * AND beyond keep-latest-N AND outside the time window. Survivors are the UNION
 * (kept if inside EITHER N or the window). The highest is NEVER reaped.
 */

import { describe, expect, it } from "vitest";

import {
	type CompactionRetention,
	CompactionRefusedError,
	CompactionRetentionSchema,
	compactVersionHistory,
	computeReapSet,
	DEFAULT_KEEP_LATEST_N,
	DEFAULT_WINDOW_DAYS,
	isVersionBumpedTable,
	resolveCompactionConfig,
	type VersionRow,
} from "../../../src/daemon/storage/compaction.js";
import type { QueryScope, QueryOptions } from "../../../src/daemon/storage/client.js";
import type { HealTarget } from "../../../src/daemon/storage/heal.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../src/daemon/storage/result.js";

const SCOPE: QueryScope = { org: "o1", workspace: "ws1" };

/** Resolve a retention policy with explicit knobs (clamped via the real schema). */
function retention(overrides: Partial<CompactionRetention> = {}): CompactionRetention {
	return CompactionRetentionSchema.parse({
		keepLatestN: DEFAULT_KEEP_LATEST_N,
		windowDays: DEFAULT_WINDOW_DAYS,
		timestampColumn: "updated_at",
		versionColumn: "version",
		...overrides,
	});
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed "now" so the time window is deterministic. */
const NOW_MS = Date.parse("2026-06-21T00:00:00.000Z");
/** ISO timestamp `daysAgo` days before NOW. */
function daysAgo(days: number): string {
	return new Date(NOW_MS - days * DAY_MS).toISOString();
}

// ── A scriptable fake StorageQuery ──────────────────────────────────────────

interface SeedKey {
	readonly key: string;
	readonly rows: VersionRow[];
}

interface FakeOpts {
	/** When true, the DELETE drops only the FIRST eligible version (partial reap). */
	readonly partialDelete?: boolean;
	/** When set, the DELETE returns a query_error (a flappy DELETE that no-opped). */
	readonly deleteFails?: boolean;
}

/** A fake that holds per-key version rows and mutates them on DELETE. */
class FakeStorage {
	readonly sqls: string[] = [];
	readonly deletes: { key: string; versions: number[] }[] = [];
	private readonly keys: Map<string, VersionRow[]>;
	private readonly opts: FakeOpts;

	constructor(seed: SeedKey[], opts: FakeOpts = {}) {
		this.keys = new Map(seed.map((s) => [s.key, [...s.rows]]));
		this.opts = opts;
	}

	rowsFor(key: string): VersionRow[] {
		return this.keys.get(key) ?? [];
	}

	async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
		this.sqls.push(sql);

		// DISTINCT key discovery.
		if (/SELECT DISTINCT/.test(sql)) {
			const rows: StorageRow[] = Array.from(this.keys.keys()).map((k) => ({ skill_id: k }));
			return ok(rows, 1);
		}

		// The survivor-durable confirm: SELECT version ... ORDER BY version DESC LIMIT 1.
		if (/LIMIT 1/.test(sql)) {
			const key = this.keyOf(sql);
			const rows = this.rowsFor(key);
			const highest = rows.reduce((m, r) => (r.version > m ? r.version : m), 0);
			return ok(highest > 0 ? [{ version: highest }] : [], 1);
		}

		// The per-version (version, updated_at) read (ORDER BY version DESC, no LIMIT).
		if (/SELECT version, updated_at/.test(sql)) {
			const key = this.keyOf(sql);
			const rows = [...this.rowsFor(key)].sort((a, b) => b.version - a.version);
			return ok(rows.map((r) => ({ version: r.version, updated_at: r.ts })), 1);
		}

		// DELETE ... IN (...).
		if (/^DELETE FROM/.test(sql)) {
			return this.applyDelete(sql);
		}

		return ok([], 1);
	}

	private keyOf(sql: string): string {
		// Extract the single-quoted key literal from `... = '<key>' ...`, correctly
		// handling doubled single-quotes (the `sLiteral` escaping): `''` inside the
		// literal is one literal quote, and the terminating quote is the first `'`
		// NOT followed by another `'`. We then un-double to recover the raw key, so a
		// key value that itself contains quotes round-trips through the fake.
		const m = /=\s*'((?:[^']|'')*)'/.exec(sql);
		return m ? m[1].replace(/''/g, "'") : "";
	}

	private applyDelete(sql: string): QueryResult {
		const key = this.keyOf(sql);
		const inList = /IN\s*\(([^)]*)\)/.exec(sql);
		const versions = inList ? inList[1].split(",").map((s) => Number(s.trim())) : [];
		if (this.opts.deleteFails) {
			return queryError("flappy delete", 500);
		}
		const toDelete = this.opts.partialDelete ? versions.slice(0, 1) : versions;
		this.deletes.push({ key, versions: toDelete });
		const remaining = this.rowsFor(key).filter((r) => !toDelete.includes(r.version));
		this.keys.set(key, remaining);
		return ok([], 1);
	}
}

const TARGET: HealTarget = { table: "skills", columns: [] };

/** Seed a single key `s1` with versions 1..n, each stamped `tsByVersion`. */
function seedVersions(n: number, tsByVersion: (v: number) => string): SeedKey {
	const rows: VersionRow[] = [];
	for (let v = 1; v <= n; v++) rows.push({ version: v, ts: tsByVersion(v) });
	return { key: "s1", rows };
}

// ════════════════════════════════════════════════════════════════════════════
// computeReapSet — the pure retention matrix (AC-2 core)
// ════════════════════════════════════════════════════════════════════════════

describe("computeReapSet (pure D-1 retention rule)", () => {
	it("the highest version is NEVER eligible (current-state invariant)", () => {
		const rows: VersionRow[] = [1, 2, 3, 4, 5].map((v) => ({ version: v, ts: daysAgo(365) }));
		const reap = computeReapSet(rows, 5, retention({ keepLatestN: 1, windowDays: 0 }), NOW_MS);
		expect(reap).not.toContain(5); // highest never reaped
		expect(reap.every((v) => v < 5)).toBe(true);
	});

	it("keep-latest-N survive even when outside the time window", () => {
		// 10 versions, all ancient. keepN=3, window off → keep {10 (highest), 9, 8, 7}.
		const rows = Array.from({ length: 10 }, (_, i) => ({ version: i + 1, ts: daysAgo(365) }));
		const reap = computeReapSet(rows, 10, retention({ keepLatestN: 3, windowDays: 0 }), NOW_MS);
		// Highest (10) + the 3 most-recent below it (9,8,7) survive; 1..6 reaped.
		expect(reap).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("inside-window versions survive even when beyond keep-latest-N", () => {
		// 10 versions; 1..3 are 60 days old, 4..10 are 5 days old. keepN=1, window=30d.
		const rows = Array.from({ length: 10 }, (_, i) => ({
			version: i + 1,
			ts: i + 1 <= 3 ? daysAgo(60) : daysAgo(5),
		}));
		const reap = computeReapSet(rows, 10, retention({ keepLatestN: 1, windowDays: 30 }), NOW_MS);
		// Highest=10 kept; 9 kept by N=1; 4..8 kept by window (5d < 30d); 1..3 reaped (60d, beyond N).
		expect(reap).toEqual([1, 2, 3]);
	});

	it("union: reap only versions outside BOTH keep-N AND the window", () => {
		// keepN=2, window=30d. v1,v2 old(60d); v3 old(60d); v4..v6 fresh(5d). highest=6.
		const rows: VersionRow[] = [
			{ version: 1, ts: daysAgo(60) },
			{ version: 2, ts: daysAgo(60) },
			{ version: 3, ts: daysAgo(60) },
			{ version: 4, ts: daysAgo(5) },
			{ version: 5, ts: daysAgo(5) },
			{ version: 6, ts: daysAgo(5) },
		];
		const reap = computeReapSet(rows, 6, retention({ keepLatestN: 2, windowDays: 30 }), NOW_MS);
		// 6 highest; 5,4 kept by N AND window; 3,2,1 old + beyond N → reaped.
		expect(reap).toEqual([1, 2, 3]);
	});

	it("empty/unparseable timestamp is treated as OUTSIDE the window (reapable once beyond N)", () => {
		const rows: VersionRow[] = [
			{ version: 1, ts: "" },
			{ version: 2, ts: "not-a-date" },
			{ version: 3, ts: daysAgo(1) },
			{ version: 4, ts: daysAgo(1) },
		];
		const reap = computeReapSet(rows, 4, retention({ keepLatestN: 1, windowDays: 30 }), NOW_MS);
		// highest=4; 3 kept by N; 2,1 have no usable time → outside window + beyond N → reaped.
		expect(reap).toEqual([1, 2]);
	});

	it("a single-version key (only the highest) reaps nothing", () => {
		const reap = computeReapSet([{ version: 1, ts: daysAgo(365) }], 1, retention({ keepLatestN: 1 }), NOW_MS);
		expect(reap).toEqual([]);
	});

	it("windowDays=0 disables the time window; keep-latest-N is the sole survivor rule", () => {
		const rows = Array.from({ length: 6 }, (_, i) => ({ version: i + 1, ts: daysAgo(0) })); // all "now"
		const reap = computeReapSet(rows, 6, retention({ keepLatestN: 2, windowDays: 0 }), NOW_MS);
		// Even though every row is fresh, window=0 → only highest(6)+keepN(5,4) survive.
		expect(reap).toEqual([1, 2, 3]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Config boundary
// ════════════════════════════════════════════════════════════════════════════

describe("resolveCompactionConfig (zod coerce-and-clamp)", () => {
	it("defaults: keepLatestN=5, windowDays=30, updated_at, version", () => {
		const cfg = resolveCompactionConfig({ read: () => ({}) });
		expect(cfg.keepLatestN).toBe(5);
		expect(cfg.windowDays).toBe(30);
		expect(cfg.timestampColumn).toBe("updated_at");
		expect(cfg.versionColumn).toBe("version");
	});

	it("clamps a fat-fingered knob rather than throwing (keepLatestN floor 1, windowDays floor 0)", () => {
		const cfg = resolveCompactionConfig({
			read: () => ({ keepLatestN: "0", windowDays: "-9", timestampColumn: "created_at" }),
		});
		expect(cfg.keepLatestN).toBe(1); // clamped up to the floor
		expect(cfg.windowDays).toBe(0); // clamped up to 0
		expect(cfg.timestampColumn).toBe("created_at");
	});

	it("a non-numeric knob falls back to its default; a bad column name falls back too", () => {
		const cfg = resolveCompactionConfig({
			read: () => ({ keepLatestN: "abc", versionColumn: "1; DROP TABLE x" }),
		});
		expect(cfg.keepLatestN).toBe(5); // default
		expect(cfg.versionColumn).toBe("version"); // bad identifier → default (never reaches sqlIdent)
	});
});

// ════════════════════════════════════════════════════════════════════════════
// D-6 fail-closed allow-list
// ════════════════════════════════════════════════════════════════════════════

describe("version-bumped allow-list (D-6, fail-closed)", () => {
	it("accepts a version-bumped table (skills) and rejects an append-only event table (sessions)", () => {
		expect(isVersionBumpedTable("skills")).toBe(true);
		expect(isVersionBumpedTable("rules")).toBe(true);
		expect(isVersionBumpedTable("dreaming_state")).toBe(true);
		expect(isVersionBumpedTable("sessions")).toBe(false); // append-only → not compactable
	});

	it("rejects an unknown table (fail-closed)", () => {
		expect(isVersionBumpedTable("not_a_real_table")).toBe(false);
	});

	it("REJECTS catalog-version-bumped tables that are NOT on the compaction allow-list", () => {
		// These tables ARE `pattern: "version-bumped"` in the catalog, but reaping their
		// history is catastrophic: `memory_jobs` carries in-flight job state, `api_keys`
		// carries credential REVOCATION lineage, and the `sources` document tables are
		// source-of-truth retention. The guard must require allow-list membership, not just
		// the version-bumped pattern — otherwise a future caller could reap any of these.
		expect(isVersionBumpedTable("memory_jobs")).toBe(false);
		expect(isVersionBumpedTable("api_keys")).toBe(false);
		expect(isVersionBumpedTable("memory_artifacts")).toBe(false);
		expect(isVersionBumpedTable("document_memories")).toBe(false);
		expect(isVersionBumpedTable("document_chunk")).toBe(false);
	});

	it("compactVersionHistory REFUSES a non-version-bumped table before touching a row", async () => {
		const fake = new FakeStorage([]);
		await expect(
			compactVersionHistory(fake, { table: "sessions", columns: [] }, SCOPE, {
				keyColumn: "path",
				retention: retention(),
			}),
		).rejects.toBeInstanceOf(CompactionRefusedError);
		expect(fake.sqls).toHaveLength(0); // never issued a single statement
	});

	it("compactVersionHistory REFUSES a version-bumped-but-not-allow-listed table (memory_jobs) before touching a row", async () => {
		const fake = new FakeStorage([]);
		await expect(
			compactVersionHistory(fake, { table: "memory_jobs", columns: [] }, SCOPE, {
				keyColumn: "id",
				retention: retention(),
			}),
		).rejects.toBeInstanceOf(CompactionRefusedError);
		expect(fake.sqls).toHaveLength(0); // never issued a single statement
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AC-2 — retention window honored (seeded recent+old mix)
// ════════════════════════════════════════════════════════════════════════════

describe("AC-2 retention window honored (end-to-end against the fake)", () => {
	it("reaps only old-and-beyond-N; keeps current + recent + windowed", async () => {
		// 8 versions. v1..v4 are 90 days old; v5..v8 are 2 days old. keepN=2, window=30d.
		const seed = seedVersions(8, (v) => (v <= 4 ? daysAgo(90) : daysAgo(2)));
		const fake = new FakeStorage([seed]);
		const summary = await compactVersionHistory(fake, TARGET, SCOPE, {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 2, windowDays: 30 }),
			clock: { now: () => NOW_MS },
		});
		// highest=8 kept; 7,6 kept by N; 5 kept by window (2d); 4,3,2,1 (90d, beyond N) reaped.
		expect(summary.rowsReaped).toBe(4);
		expect(summary.keysCompacted).toBe(1);
		expect(fake.deletes[0]?.versions).toEqual([1, 2, 3, 4]);
		// Survivors after compaction.
		const surviving = fake.rowsFor("s1").map((r) => r.version).sort((a, b) => a - b);
		expect(surviving).toEqual([5, 6, 7, 8]);
		expect(surviving).toContain(8); // current state intact
	});
});

// ════════════════════════════════════════════════════════════════════════════
// highest-version-never-reaped (assert the issued SQL)
// ════════════════════════════════════════════════════════════════════════════

describe("highest version is sacred (the DELETE never includes it)", () => {
	it("the issued DELETE IN-list never contains the highest version", async () => {
		const seed = seedVersions(6, () => daysAgo(365)); // all ancient → maximal reaping
		const fake = new FakeStorage([seed]);
		await compactVersionHistory(fake, TARGET, SCOPE, {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 1, windowDays: 0 }),
			clock: { now: () => NOW_MS },
		});
		const del = fake.sqls.find((s) => /^DELETE FROM/.test(s));
		expect(del).toBeDefined();
		// The highest version is 6; it must NOT appear in the IN-list.
		const inList = /IN\s*\(([^)]*)\)/.exec(del as string)?.[1] ?? "";
		const versions = inList.split(",").map((s) => Number(s.trim()));
		expect(versions).not.toContain(6);
		expect(Math.max(...versions)).toBeLessThan(6);
		expect(fake.rowsFor("s1").map((r) => r.version)).toContain(6); // survivor present
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AC-4 — idempotent (two runs: run 1 deletes, run 2 zero)
// ════════════════════════════════════════════════════════════════════════════

describe("AC-4 idempotent", () => {
	it("two runs in a row: run 1 reaps, run 2 is a zero-delete no-op; highest unchanged", async () => {
		const seed = seedVersions(10, (v) => (v <= 7 ? daysAgo(120) : daysAgo(1)));
		const fake = new FakeStorage([seed]);
		const opts = {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 2, windowDays: 30 }),
			clock: { now: () => NOW_MS },
		};
		const run1 = await compactVersionHistory(fake, TARGET, SCOPE, opts);
		expect(run1.rowsReaped).toBeGreaterThan(0);
		const highestAfter1 = Math.max(...fake.rowsFor("s1").map((r) => r.version));

		const deletesBefore = fake.deletes.length;
		const run2 = await compactVersionHistory(fake, TARGET, SCOPE, opts);
		expect(run2.rowsReaped).toBe(0); // recompute from current view → nothing eligible
		expect(run2.keysCompacted).toBe(0);
		expect(fake.deletes.length).toBe(deletesBefore); // no DELETE issued on run 2
		expect(Math.max(...fake.rowsFor("s1").map((r) => r.version))).toBe(highestAfter1); // highest byte-stable
		expect(highestAfter1).toBe(10);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AC-5 — crash-safe (partial DELETE → re-run completes; survivor never at risk)
// ════════════════════════════════════════════════════════════════════════════

describe("AC-5 crash-safe (simulated partial reap)", () => {
	it("a partial DELETE leaves highest + window intact; a re-run completes to the bound", async () => {
		const seed = seedVersions(8, (v) => (v <= 5 ? daysAgo(200) : daysAgo(1)));
		// partialDelete: the first DELETE drops only ONE eligible version (a crash mid-reap).
		const fake = new FakeStorage([seed], { partialDelete: true });
		const opts = {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 2, windowDays: 30 }),
			clock: { now: () => NOW_MS },
		};
		await compactVersionHistory(fake, TARGET, SCOPE, opts);
		// After the partial run: only v1 was actually removed; v2,v3 still linger.
		const afterPartial = fake.rowsFor("s1").map((r) => r.version).sort((a, b) => a - b);
		expect(afterPartial).toContain(8); // highest never at risk
		expect(afterPartial).toContain(6); // window survivor never at risk
		expect(afterPartial).toContain(7); // keep-N survivor never at risk
		expect(afterPartial.length).toBeLessThan(8); // something was reaped

		// Re-run (now NOT partial) completes to the bound.
		const fake2NotPartial = Object.assign(fake, {}); // same fake, but flip partial off
		(fake2NotPartial as unknown as { opts: FakeOpts }).opts = { partialDelete: false };
		const rerun = await compactVersionHistory(fake, TARGET, SCOPE, opts);
		const final = fake.rowsFor("s1").map((r) => r.version).sort((a, b) => a - b);
		// Final survivor set = highest(8) ∪ keepN(7,6 — but 6,7 within window too) ∪ windowed(6,7,8).
		expect(final).toContain(8);
		expect(final).toContain(7);
		expect(final).toContain(6);
		// The eligible-old versions (1..5, beyond N + outside window) are gone.
		expect(final.every((v) => v >= 6)).toBe(true);
		expect(rerun.rowsReaped).toBeGreaterThanOrEqual(0);
	});

	it("if the survivor cannot be confirmed durable, the key is SKIPPED (never reaped)", async () => {
		// A fake whose LIMIT-1 confirm always returns empty → survivor not durable.
		const seed = seedVersions(6, () => daysAgo(365));
		const base = new FakeStorage([seed]);
		const guarded = {
			sqls: base.sqls,
			async query(sql: string, scope: QueryScope, o?: QueryOptions): Promise<QueryResult> {
				if (/LIMIT 1/.test(sql)) return ok([], 1); // survivor confirm always fails
				return base.query(sql, scope, o);
			},
		};
		const summary = await compactVersionHistory(guarded, TARGET, SCOPE, {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 1, windowDays: 0 }),
			clock: { now: () => NOW_MS },
		});
		expect(summary.keysSkipped).toBe(1);
		expect(summary.rowsReaped).toBe(0);
		expect(base.deletes).toHaveLength(0); // never issued a DELETE
		expect(base.rowsFor("s1").length).toBe(6); // nothing reaped — all intact
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Guarded SQL floor (sqlIdent / sLiteral, no raw interpolation)
// ════════════════════════════════════════════════════════════════════════════

describe("guarded SQL (the DELETE/SELECT route through the guards)", () => {
	it("a malicious key value is escaped in the DELETE (single-quote doubled, no injection)", async () => {
		const evilKey = "s1'; DROP TABLE skills; --";
		const seed: SeedKey = {
			key: evilKey,
			rows: [1, 2, 3].map((v) => ({ version: v, ts: daysAgo(365) })),
		};
		// FakeStorage keys off the DISTINCT result; we seed the evil key directly.
		const fake = new FakeStorage([seed]);
		await compactVersionHistory(fake, TARGET, SCOPE, {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 1, windowDays: 0 }),
			clock: { now: () => NOW_MS },
		});
		const del = fake.sqls.find((s) => /^DELETE FROM/.test(s)) as string;
		expect(del).toBeDefined();
		// The embedded quote is doubled (sLiteral), so the literal stays one inert
		// string and no second statement is produced. Assert the payload appears in
		// its DOUBLED form `''; DROP` (escaped) and NOT in a single-quote `'; DROP`
		// form that would close the string early. We strip the doubled pairs first:
		// after stripping `''`, a stray closing `'` before `DROP` would be the
		// injection — and there must be none.
		expect(del).toContain("''; DROP TABLE skills; --"); // doubled → inert literal
		const withoutDoubledPairs = del.replace(/''/g, "");
		expect(withoutDoubledPairs).not.toMatch(/'\s*;\s*DROP/); // no early-closing quote survives
	});

	it("a non-identifier key column throws (sqlIdent) before any statement is issued", async () => {
		const fake = new FakeStorage([seedVersions(3, () => daysAgo(365))]);
		await expect(
			compactVersionHistory(fake, TARGET, SCOPE, {
				keyColumn: "skill_id; DROP",
				retention: retention(),
				clock: { now: () => NOW_MS },
			}),
		).rejects.toThrow(/Invalid SQL identifier/);
		expect(fake.sqls).toHaveLength(0);
	});

	it("the DELETE uses a quoted table identifier and an IN-list of numeric scalars only", async () => {
		const fake = new FakeStorage([seedVersions(5, () => daysAgo(365))]);
		await compactVersionHistory(fake, TARGET, SCOPE, {
			keyColumn: "skill_id",
			retention: retention({ keepLatestN: 1, windowDays: 0 }),
			clock: { now: () => NOW_MS },
		});
		const del = fake.sqls.find((s) => /^DELETE FROM/.test(s)) as string;
		expect(del).toMatch(/^DELETE FROM "skills" WHERE skill_id = '[^']*' AND version IN \(/);
		const inList = /IN\s*\(([^)]*)\)/.exec(del)?.[1] ?? "";
		// Every element is a bare integer — no quotes, no sub-select, no function call.
		expect(inList.split(",").every((p) => /^\s*\d+\s*$/.test(p))).toBe(true);
	});
});
