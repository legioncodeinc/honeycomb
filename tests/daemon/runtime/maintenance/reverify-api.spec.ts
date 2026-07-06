/**
 * PRD-058c / PRD-058e — the reverify-scheduler TRIGGER route + the cadence math (L-W7).
 *
 * The route is mounted on a REAL local-mode daemon (so the `/api/diagnostics` group is open) and exercised
 * in-process via `daemon.app.request(...)`. A FAKE storage scripts which memories the scan returns +
 * whether the per-memory stale-ref diagnostic write succeeds, and a FAKE snapshot provider scripts the
 * graph oracle. The cases prove:
 *  - the route is registered (`POST /api/diagnostics/reverify`), returns 200, and the summary carries the
 *    scan + due counts (AC-55e.3).
 *  - a memory PAST its reverify interval is queued for re-check (surfaces in the `due` set + the
 *    diagnostic's scanned set); a memory INSIDE its interval is filtered out by the cadence check.
 *  - the fail-soft missing-graph path → `graphUnavailable`, nothing re-verified.
 *  - a cold memory (never verified) is unconditionally due.
 *  - `runReverifyPass` (the periodic-tick + route shared pass) returns the same shape directly.
 *  - the no-org 400 edge (fail-closed).
 */

import { describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { QueryResult } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { GraphNode, Snapshot } from "../../../../src/daemon/runtime/codebase/contracts.js";
import type { SnapshotProvider } from "../../../../src/daemon/runtime/maintenance/stale-ref-diagnostic.js";
import {
	mountReverifyApi,
	runReverifyPass,
	buildReverifyScanSql,
	selectDueForReverify,
	type MountReverifyOptions,
	type ReverifySummaryBody,
	type ReverifyCandidate,
} from "../../../../src/daemon/runtime/maintenance/reverify-api.js";

const NOW_MS = Date.parse("2026-07-05T00:00:00.000Z");
const DEFAULT_SCOPE: QueryScope = { org: "local", workspace: "default" };

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A candidate-batch-shape row the listing storage returns. */
interface MemoryRow {
	readonly id: string;
	readonly content: string;
	readonly verified_at: string | null;
	readonly last_reinforced_at: string | null;
}

/**
 * A storage fake: the `memories` candidate scan returns the scripted rows (matched on the verified_at
 * scan SQL); any other SELECT returns an empty ok; any write returns an empty ok. The scan SQL is matched
 * loosely (FROM "memories" + the verified_at threshold) so a contract change to the WHERE does not break
 * the fixture — the scan-shape is verified separately by `buildReverifyScanSql` below.
 */
function listingStorage(memories: ReadonlyArray<MemoryRow>): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			if (/FROM\s+"memories"/i.test(sql) && /verified_at/i.test(sql)) {
				return { kind: "ok", rows: memories.slice() as unknown as QueryResult["rows"], durationMs: 0 } as QueryResult;
			}
			if (/SELECT\s+1\b/i.test(sql)) return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
			return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
		},
	} as unknown as StorageQuery;
}

function symbolNode(sourceFile: string, name: string): GraphNode {
	return {
		id: `${sourceFile}#${name}`,
		kind: "symbol",
		name,
		sourceFile,
		language: "typescript",
		symbolKind: "function",
		exported: true,
		observation: { startLine: 1, endLine: 2 },
	};
}

function snapshotOf(nodes: readonly GraphNode[]): Snapshot {
	return {
		directed: true,
		multigraph: true,
		graph: {},
		nodes,
		links: [],
		observation: { generatedAt: new Date(NOW_MS).toISOString(), generatorVersion: "t", fileCount: 1, nodeCount: nodes.length, edgeCount: 0, parseErrorCount: 0 },
	};
}

function daemonWith(
	storage: StorageQuery,
	snapshots: SnapshotProvider,
	over: Partial<RuntimeConfig> = {},
	scope: QueryScope = DEFAULT_SCOPE,
	extra?: Partial<MountReverifyOptions>,
): Daemon {
	const daemon = createDaemon({ config: cfg(over), storage: storage as never, logger: createRequestLogger({ silent: true }) });
	mountReverifyApi(daemon, { storage, defaultScope: scope, snapshots, ...extra });
	return daemon;
}

async function postReverify(daemon: Daemon, body?: unknown): Promise<{ status: number; out: ReverifySummaryBody }> {
	const res = await daemon.app.request("/api/diagnostics/reverify", {
		method: "POST",
		...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
	});
	const out = (await res.json()) as ReverifySummaryBody;
	return { status: res.status, out };
}

describe("PRD-058e L-W7 — reverify trigger route + cadence", () => {
	it("is registered and returns 200 with the scan + due counts", async () => {
		// A memory verified 1 year ago — well past any bounded reverify interval → due.
		const storage = listingStorage([
			{ id: "m1", content: "src/a.ts#gone is dead", verified_at: "2025-07-05T00:00:00.000Z", last_reinforced_at: "2025-07-05T00:00:00.000Z" },
		]);
		const snapshots: SnapshotProvider = { load: async () => snapshotOf([symbolNode("src/a.ts", "keep")]) };
		const daemon = daemonWith(storage, snapshots, {}, DEFAULT_SCOPE, { now: () => NOW_MS });

		const { status, out } = await postReverify(daemon);
		expect(status).toBe(200);
		expect(out.ok).toBe(true);
		expect(out.scanned).toBe(1);
		expect(out.due).toBe(1);
	});

	it("a memory INSIDE its reverify interval is filtered out of the due set", async () => {
		// Verified 1 hour ago, reinforced 1 hour ago → very hot, well inside the min interval (default 24h).
		const recent = new Date(NOW_MS - 60 * 60 * 1_000).toISOString();
		const storage = listingStorage([
			{ id: "m-fresh", content: "src/a.ts#keep", verified_at: recent, last_reinforced_at: recent },
		]);
		const snapshots: SnapshotProvider = { load: async () => snapshotOf([symbolNode("src/a.ts", "keep")]) };
		const daemon = daemonWith(storage, snapshots, {}, DEFAULT_SCOPE, { now: () => NOW_MS });

		const { status, out } = await postReverify(daemon);
		expect(status).toBe(200);
		expect(out.scanned).toBe(1);
		// The cadence check filters it OUT — a hot memory is not due for reverify.
		expect(out.due).toBe(0);
	});

	it("a memory NEVER verified (verified_at NULL) is unconditionally due", async () => {
		const storage = listingStorage([
			{ id: "m-never", content: "src/a.ts#keep", verified_at: null, last_reinforced_at: null },
		]);
		const snapshots: SnapshotProvider = { load: async () => snapshotOf([symbolNode("src/a.ts", "keep")]) };
		const daemon = daemonWith(storage, snapshots, {}, DEFAULT_SCOPE, { now: () => NOW_MS });

		const { status, out } = await postReverify(daemon);
		expect(status).toBe(200);
		expect(out.scanned).toBe(1);
		expect(out.due).toBe(1);
	});

	it("fail-soft: a missing graph oracle → graphUnavailable, nothing re-verified", async () => {
		const storage = listingStorage([
			{ id: "m1", content: "src/a.ts#gone", verified_at: null, last_reinforced_at: null },
		]);
		const daemon = daemonWith(storage, { load: async () => null }, {}, DEFAULT_SCOPE, { now: () => NOW_MS });
		const { out } = await postReverify(daemon);
		expect(out.graphUnavailable).toBe(true);
		// Diagnostic posture: nothing flagged stale when the oracle is missing.
		expect(out.results.every((r) => r.refStatus === "unknown")).toBe(true);
	});

	it("the no-org edge fails closed at the edge (never 200)", async () => {
		const storage = listingStorage([]);
		// A team-mode daemon with NO default org → fail-closed.
		const daemon = createDaemon({ config: cfg({ mode: "team" }), storage: storage as never, logger: createRequestLogger({ silent: true }) });
		mountReverifyApi(daemon, { storage, defaultScope: { org: "" }, snapshots: { load: async () => null } });
		const res = await daemon.app.request("/api/diagnostics/reverify", { method: "POST" });
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});
});

describe("PRD-058e L-W7 — runReverifyPass (the route + tick shared pass)", () => {
	it("returns the same summary shape the route returns (pure-of-HTTP)", async () => {
		const storage = listingStorage([
			{ id: "m1", content: "src/a.ts#gone", verified_at: null, last_reinforced_at: null },
		]);
		const snapshots: SnapshotProvider = { load: async () => snapshotOf([symbolNode("src/a.ts", "keep")]) };
		const out = await runReverifyPass(DEFAULT_SCOPE, { storage, defaultScope: DEFAULT_SCOPE, snapshots, now: () => NOW_MS });
		expect(out.ok).toBe(true);
		expect(out.scanned).toBe(1);
		expect(out.due).toBe(1);
	});
});

describe("PRD-058e L-W7 — pure helpers", () => {
	it("buildReverifyScanSql guards identifiers + interpolates only the threshold literal", () => {
		const sql = buildReverifyScanSql("2025-01-01T00:00:00.000Z", 500);
		// Identifier guard: the table name is double-quoted (FROM "<table>"); column identifiers
		// route through sqlIdent (validated unquoted form — the safe-identifier contract).
		expect(sql).toContain('FROM "memories"');
		expect(sql).toContain("verified_at");
		// The threshold is a single-quoted literal; LIMIT is an integer.
		expect(sql).toContain("'2025-01-01T00:00:00.000Z'");
		expect(sql).toContain("LIMIT 500");
		// The never-checked case is in the WHERE (verified_at IS NULL OR ...).
		expect(sql).toContain("verified_at IS NULL");
	});

	it("selectDueForReverify: a never-checked memory is due; a freshly-checked hot memory is not", () => {
		const recent = new Date(NOW_MS - 60 * 60 * 1_000).toISOString();
		const candidates: ReverifyCandidate[] = [
			{ id: "m-never", content: "x", verifiedAt: null, lastReinforcedAt: null },
			{ id: "m-fresh", content: "y", verifiedAt: recent, lastReinforcedAt: recent },
		];
		const due = selectDueForReverify(candidates, NOW_MS, { minIntervalMs: 24 * 60 * 60 * 1_000, maxIntervalMs: 90 * 24 * 60 * 60 * 1_000 });
		expect(due.map((c) => c.id)).toEqual(["m-never"]);
	});
});
