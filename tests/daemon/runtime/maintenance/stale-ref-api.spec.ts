/**
 * PRD-058c — the stale-reference diagnostic TRIGGER route + the poll-to-convergence snapshot provider.
 *
 * The route is mounted on a REAL local-mode daemon (so the `/api/diagnostics` group is open) and exercised
 * in-process via `daemon.app.request(...)`. Covers: posture default/override, the fail-soft missing-graph
 * path, the no-org 400, and the {@link localSnapshotProvider} convergence loop (AC-58c.3.3 — a transient
 * stale segment does not persist a `stale` verdict; the provider polls until two reads agree).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { QueryResult } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { GraphNode, Snapshot, SnapshotIdentity } from "../../../../src/daemon/runtime/codebase/contracts.js";
import {
	localSnapshotProvider,
	mountStaleRefApi,
	type StaleRefSummaryBody,
} from "../../../../src/daemon/runtime/maintenance/stale-ref-api.js";
import type { SnapshotProvider } from "../../../../src/daemon/runtime/maintenance/stale-ref-diagnostic.js";

const NOW = Date.parse("2026-06-26T00:00:00.000Z");
const DEFAULT_SCOPE: QueryScope = { org: "local", workspace: "default" };

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A storage fake: the `memories` list SELECT returns one row; writes return ok. */
function listingStorage(memory: { id: string; content: string }): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			if (/FROM\s+"memories"/i.test(sql) && /SELECT/i.test(sql) && !/information_schema/i.test(sql) && !/WHERE\s+"id"/i.test(sql)) {
				// The list read: return one memory row.
				return { kind: "ok", rows: [{ id: memory.id, content: memory.content }], durationMs: 0 } as QueryResult;
			}
			if (/SELECT/i.test(sql)) return { kind: "ok", rows: [{ id: memory.id }], durationMs: 0 } as QueryResult;
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
		observation: { generatedAt: new Date(NOW).toISOString(), generatorVersion: "t", fileCount: 1, nodeCount: nodes.length, edgeCount: 0, parseErrorCount: 0 },
	};
}

function daemonWith(storage: StorageQuery, snapshots: SnapshotProvider, over: Partial<RuntimeConfig> = {}, scope: QueryScope = DEFAULT_SCOPE): Daemon {
	const daemon = createDaemon({ config: cfg(over), storage: storage as never, logger: createRequestLogger({ silent: true }) });
	mountStaleRefApi(daemon, { storage, defaultScope: scope, snapshots });
	return daemon;
}

async function postStaleRefs(daemon: Daemon, body?: unknown): Promise<{ status: number; out: StaleRefSummaryBody }> {
	const res = await daemon.app.request("/api/diagnostics/stale-refs", {
		method: "POST",
		...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
	});
	const out = (await res.json()) as StaleRefSummaryBody;
	return { status: res.status, out };
}

describe("PRD-058c stale-ref trigger route", () => {
	it("runs the diagnostic over the scanned memories and returns a 200 summary (observe default)", async () => {
		const storage = listingStorage({ id: "m1", content: "the call src/a.ts#gone is dead" });
		const snapshots: SnapshotProvider = { load: async () => snapshotOf([symbolNode("src/a.ts", "keep")]) };
		const daemon = daemonWith(storage, snapshots);

		const { status, out } = await postStaleRefs(daemon);
		expect(status).toBe(200);
		expect(out.ok).toBe(true);
		expect(out.posture).toBe("observe");
		expect(out.scanned).toBe(1);
		expect(out.results[0]).toMatchObject({ id: "m1", refStatus: "stale" });
	});

	it("honors an execute posture in the body", async () => {
		const storage = listingStorage({ id: "m1", content: "src/a.ts#gone" });
		const daemon = daemonWith(storage, { load: async () => snapshotOf([symbolNode("src/a.ts", "keep")]) });
		const { out } = await postStaleRefs(daemon, { posture: "execute" });
		expect(out.posture).toBe("execute");
	});

	it("fail-soft: a missing graph oracle → graphUnavailable, nothing flagged stale", async () => {
		const storage = listingStorage({ id: "m1", content: "src/a.ts#gone" });
		const daemon = daemonWith(storage, { load: async () => null });
		const { out } = await postStaleRefs(daemon);
		expect(out.graphUnavailable).toBe(true);
		expect(out.results.every((r) => r.refStatus === "unknown")).toBe(true);
	});

	it("a team-mode daemon with no default org fails closed at the edge (never 200)", async () => {
		const storage = listingStorage({ id: "m1", content: "x" });
		const daemon = createDaemon({ config: cfg({ mode: "team" }), storage: storage as never, logger: createRequestLogger({ silent: true }) });
		mountStaleRefApi(daemon, { storage, defaultScope: { org: "" }, snapshots: { load: async () => null } });
		const res = await daemon.app.request("/api/diagnostics/stale-refs", { method: "POST" });
		// The protected group's auth gate (401) or the handler's no-org guard (400) — either way fail-closed.
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});
});

describe("PRD-058c localSnapshotProvider — poll-to-convergence (58c.3.3)", () => {
	const identity: SnapshotIdentity = { org: "o", workspace: "w", repo: "r", user: "u", worktree: "wt", commit: "c" };
	const resolveIdentity = (): SnapshotIdentity => identity;
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** Write a snapshot JSON into `<baseDir>/snapshots/<name>.json` and return the baseDir. */
	function seedSnapshot(snapshot: Snapshot, name = "c"): string {
		const baseDir = mkdtempSync(join(tmpdir(), "stale-ref-snap-"));
		dirs.push(baseDir);
		const snapDir = join(baseDir, "snapshots");
		mkdirSync(snapDir, { recursive: true });
		writeFileSync(join(snapDir, `${name}.json`), JSON.stringify(snapshot), "utf8");
		return baseDir;
	}

	it("a converged on-disk snapshot is returned and the poll loop runs (delay invoked)", async () => {
		const converged = snapshotOf([symbolNode("src/a.ts", "doThing")]);
		const baseDir = seedSnapshot(converged);
		const delay = vi.fn(async () => {});
		const provider = localSnapshotProvider("/ws", resolveIdentity, { delay, baseDir: () => baseDir });
		const out = await provider.load({ org: "o" });
		expect(out).not.toBeNull();
		expect(out!.nodes.some((n) => n.name === "doThing")).toBe(true);
		// The convergence loop polled at least once (the two reads agree → converged).
		expect(delay).toHaveBeenCalled();
	});

	it("no build yet (no snapshots dir) → null, the fail-soft signal, no poll", async () => {
		const delay = vi.fn(async () => {});
		const provider = localSnapshotProvider("/ws", resolveIdentity, { delay, baseDir: () => join(tmpdir(), "definitely-missing-xyz") });
		const out = await provider.load({ org: "o" });
		expect(out).toBeNull(); // no snapshots dir → null.
		expect(delay).not.toHaveBeenCalled(); // a null first read short-circuits (nothing to converge).
	});
});
