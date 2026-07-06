/**
 * PRD-058e — the access-log compaction TRIGGER route + the periodic-tick shared pass (L-W8).
 *
 * The route is mounted on a REAL local-mode daemon (so the `/api/diagnostics` group is open) and exercised
 * in-process via `daemon.app.request(...)`. A FAKE storage scripts which DISTINCT memory ids the scan
 * returns + how the per-memory `compactAccessLog` read replies, so each test proves the wiring + the
 * summary contract WITHOUT touching the real `memory_access` table or a live DeepLake.
 *
 * The cases prove:
 *  - the route is registered (`POST /api/diagnostics/compact-access-log`), returns 200, the summary
 *    carries the scan + folded counts.
 *  - `compactAccessLog` IS invoked once per scanned memory id (the raw events fold into `access_count` +
 *    the watermark cursor advance is the side effect the fold drives).
 *  - a per-memory compaction error is fail-soft: the memory is reported `errored: true`, the pass continues.
 *  - `runCompactAccessLogPass` (the route + tick shared pass) returns the same shape directly.
 *  - the no-org 400 edge (fail-closed).
 *  - the DISTINCT-memory-id SQL is guarded (identifiers via sqlIdent).
 */

import { describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { QueryResult } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import {
	buildDistinctMemoryIdsSql,
	mountCompactAccessLogApi,
	runCompactAccessLogPass,
	type CompactAccessLogSummaryBody,
} from "../../../../src/daemon/runtime/maintenance/compact-access-log-api.js";

const DEFAULT_SCOPE: QueryScope = { org: "local", workspace: "default" };

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/**
 * A recording storage fake. The DISTINCT scan returns the scripted memory ids; EVERY other read (the
 * per-memory compaction reads) returns the scripted rows; every write returns an empty ok. The
 * `compactionReads` counter proves `compactAccessLog` is invoked once per scanned memory.
 */
function recordingStorage(memoryIds: string[], perMemoryRows: ReadonlyArray<{ id: string; at: string; kind: string }> = []): {
	storage: StorageQuery;
	compactionReads: string[];
} {
	const compactionReads: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string): Promise<QueryResult> {
			// The DISTINCT memory_id scan: return the scripted ids. Identified by `SELECT DISTINCT memory_id`
			// (the column is the validated unquoted form — sqlIdent returns it bare).
			if (/SELECT\s+DISTINCT\s+memory_id\s+AS\s+memory_id/i.test(sql)) {
				return { kind: "ok", rows: memoryIds.map((id) => ({ memory_id: id })), durationMs: 0 } as QueryResult;
			}
			// The per-memory compaction read: identified by `WHERE memory_id = '<id>'` over memory_access
			// (the column is the validated unquoted form — sqlIdent returns it bare). Record the per-memory
			// id to prove the fold IS invoked once per scanned memory.
			const m = /FROM\s+"memory_access"\s+WHERE\s+memory_id\s*=\s*'([^']+)'/i.exec(sql);
			if (m !== null) {
				compactionReads.push(m[1]);
				return { kind: "ok", rows: perMemoryRows.slice() as unknown as QueryResult["rows"], durationMs: 0 } as QueryResult;
			}
			if (/SELECT\s+1\b/i.test(sql)) return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
			return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
		},
	};
	return { storage, compactionReads };
}

function daemonWith(storage: StorageQuery, over: Partial<RuntimeConfig> = {}, scope: QueryScope = DEFAULT_SCOPE): Daemon {
	const daemon = createDaemon({ config: cfg(over), storage: storage as never, logger: createRequestLogger({ silent: true }) });
	mountCompactAccessLogApi(daemon, { storage, defaultScope: scope });
	return daemon;
}

async function postCompactAccessLog(daemon: Daemon, body?: unknown): Promise<{ status: number; out: CompactAccessLogSummaryBody }> {
	const res = await daemon.app.request("/api/diagnostics/compact-access-log", {
		method: "POST",
		...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
	});
	const out = (await res.json()) as CompactAccessLogSummaryBody;
	return { status: res.status, out };
}

describe("PRD-058e L-W8 — compact-access-log trigger route", () => {
	it("is registered and returns 200 with the scan + folded counts", async () => {
		// Two distinct memory ids; per-memory rows under the keep horizon (default 32) → folded: 0 each.
		const { storage } = recordingStorage(["m1", "m2"], []);
		const daemon = daemonWith(storage);

		const { status, out } = await postCompactAccessLog(daemon);
		expect(status).toBe(200);
		expect(out.ok).toBe(true);
		expect(out.scanned).toBe(2);
		expect(out.totalFolded).toBe(0);
		expect(out.results.map((r) => r.memoryId)).toEqual(["m1", "m2"]);
	});

	it("invokes compactAccessLog once per scanned memory id (the fold IS the side effect)", async () => {
		// Per-memory rows OVER the keep horizon (33 rows > keep=32) → a compaction fold is attempted. The
		// exact fold math + watermark cursor advance is owned by `compactAccessLog` (verified in its own
		// unit suite); here we prove the WIRING: the per-memory read IS fired once per scanned id. The
		// fold count itself floors to 0 in this fixture because the watermark + memories-row reads the
		// `compactAccessLog` logic does are not scripted here (an honest `folded: 0`, NOT an error).
		const rows = Array.from({ length: 33 }, (_, i) => ({ id: `e${i}`, at: `2026-07-04T00:00:0${i % 10}.000Z`, kind: "recall" }));
		const { storage, compactionReads } = recordingStorage(["m1", "m2", "m3"], rows);
		const daemon = daemonWith(storage);

		const { out } = await postCompactAccessLog(daemon);
		expect(out.scanned).toBe(3);
		// Each scanned memory id triggered exactly one per-memory compaction read (the WIRING under test).
		expect(compactionReads).toEqual(["m1", "m2", "m3"]);
		// Each result is reported without error (the fold was attempted; the count is compactAccessLog's).
		expect(out.results.every((r) => !r.errored)).toBe(true);
	});

	it("fail-soft: a per-memory error is reported, never a 500", async () => {
		// A storage that throws on the per-memory read for `m2` (the second scanned id).
		const throwsStorage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				if (/SELECT\s+DISTINCT\s+memory_id\s+AS\s+memory_id/i.test(sql)) {
					return { kind: "ok", rows: [{ memory_id: "m1" }, { memory_id: "m2" }], durationMs: 0 } as QueryResult;
				}
				if (/FROM\s+"memory_access"\s+WHERE\s+memory_id\s*=\s*'m2'/i.test(sql)) {
					throw new Error("simulated flap");
				}
				return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
			},
		} as unknown as StorageQuery;
		const daemon = daemonWith(throwsStorage);

		const { status, out } = await postCompactAccessLog(daemon);
		expect(status).toBe(200);
		const m2Result = out.results.find((r) => r.memoryId === "m2");
		expect(m2Result?.errored).toBe(true);
		expect(m2Result?.folded).toBe(0);
		// m1 is intact (the per-memory error did NOT abort the pass).
		const m1Result = out.results.find((r) => r.memoryId === "m1");
		expect(m1Result?.errored).toBe(false);
	});

	it("the no-org edge fails closed at the edge (never 200)", async () => {
		const { storage } = recordingStorage([]);
		const daemon = createDaemon({ config: cfg({ mode: "team" }), storage: storage as never, logger: createRequestLogger({ silent: true }) });
		mountCompactAccessLogApi(daemon, { storage, defaultScope: { org: "" } });
		const res = await daemon.app.request("/api/diagnostics/compact-access-log", { method: "POST" });
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});
});

describe("PRD-058e L-W8 — runCompactAccessLogPass (the route + tick shared pass)", () => {
	it("returns the same summary shape the route returns (pure-of-HTTP)", async () => {
		const { storage } = recordingStorage(["m1"], []);
		const out = await runCompactAccessLogPass(DEFAULT_SCOPE, { storage, defaultScope: DEFAULT_SCOPE });
		expect(out.ok).toBe(true);
		expect(out.scanned).toBe(1);
	});

	it("fail-soft: a missing memory_access table (scan read error) → empty summary, ok", async () => {
		// A storage whose DISTINCT scan throws (the missing-table case).
		const throwsStorage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				if (/SELECT\s+DISTINCT\s+memory_id\s+AS\s+memory_id/i.test(sql)) throw new Error("missing table");
				return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
			},
		} as unknown as StorageQuery;
		const out = await runCompactAccessLogPass(DEFAULT_SCOPE, { storage: throwsStorage, defaultScope: DEFAULT_SCOPE });
		expect(out.ok).toBe(true);
		expect(out.scanned).toBe(0);
		expect(out.results).toEqual([]);
	});
});

describe("PRD-058e L-W8 — buildDistinctMemoryIdsSql", () => {
	it("guards identifiers (the table name is quoted; the column routes through sqlIdent)", () => {
		const sql = buildDistinctMemoryIdsSql(200);
		// The table name is double-quoted (FROM "<table>"); the column is the validated unquoted
		// form (the safe-identifier contract — sqlIdent rejects anything outside [a-zA-Z_][a-zA-Z0-9_]*).
		expect(sql).toContain('FROM "memory_access"');
		expect(sql).toContain("memory_id");
		expect(sql).toContain("LIMIT 200");
	});
});
