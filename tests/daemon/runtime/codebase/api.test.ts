/**
 * PRD-014 daemon-assembly wiring — the `/api/graph/*` mount seam (`mountGraphApi`).
 *
 * The codebase-graph BUILD pipeline (014a discover/extract → 014b finalize → 014c push)
 * was built + unit-tested, but its QA explicitly deferred the daemon-assembly wiring, so
 * `honeycomb graph build` reached the daemon's `/api/graph` group and got the FR-2 501
 * scaffold — the tested worker was never invoked. This suite proves the wiring: after
 * `mountGraphApi` fires, `POST /api/graph/build` runs the worker END-TO-END (a real
 * discover → tree-sitter extract → snapshot → local persist → best-effort push) and
 * returns success — NOT a 501 — and a subsequent `GET /api/graph` reads the persisted
 * snapshot back as `built:true`.
 *
 * Verification posture (codebase CONVENTIONS §9/§10): in-process via
 * `daemon.app.request(...)`, no socket. The build runs over an INJECTED fixture repo
 * (`gitLsFiles` + `readFile` seams — no real git, no real filesystem walk) into a TEMP
 * `graphBaseDir` (never the real `~/.honeycomb`). The cloud push runs against a fake
 * `StorageQuery` so the daemon-only-storage path is exercised without a live DeepLake.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { mountGraphApi, snapshotToGraphView } from "../../../../src/daemon/runtime/codebase/api.js";
import { mountDashboardApi } from "../../../../src/daemon/runtime/dashboard/api.js";
import type { Snapshot, SnapshotIdentity } from "../../../../src/daemon/runtime/codebase/contracts.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult } from "../../../../src/daemon/storage/result.js";

// ── Fixtures ────────────────────────────────────────────────────────────────────

const IDENTITY: SnapshotIdentity = {
	org: "acme",
	workspace: "default",
	repo: "honeycomb",
	user: "u1",
	worktree: "/repo",
	commit: "commit-abc",
};

const SCOPE: QueryScope = { org: "acme", workspace: "default" };

/** A tiny two-file TS repo with a real cross-file call → real nodes + edges. */
const FIXTURE_FILES: Record<string, string> = {
	"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
	"src/b.ts": "export function b(){}\n",
};

/** Build deps that surface the fixture repo through the discovery + read seams (no real git/fs). */
function fixtureBuildDeps(baseDir: string) {
	return {
		gitLsFiles: () => Object.keys(FIXTURE_FILES).join("\0"),
		readFile: (abs: string) => {
			const key = Object.keys(FIXTURE_FILES).find((k) => abs.replace(/\\/g, "/").endsWith(k));
			if (key === undefined) throw new Error(`no fixture for ${abs}`);
			return FIXTURE_FILES[key];
		},
		cacheBaseDir: baseDir,
		noCache: true as const,
	};
}

/** A fake StorageQuery that answers every statement ok([]) — the push runs without a live backend. */
const fakeStorage: StorageQuery = {
	async query(): Promise<QueryResult> {
		return ok([], 1);
	},
};

/** A resolved local-mode config (so a request with no org falls back to the default scope). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** Build a local-mode daemon WITHOUT firing the graph mount (the 501-baseline daemon). */
function bareDaemon(): Daemon {
	return createDaemon({ config: cfg(), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
}

let baseDir: string;
beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), "hc-graph-api-"));
});
afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// ── The 501 baseline (the gap this wiring closes) ────────────────────────────────

describe("baseline: an UN-wired /api/graph build returns the FR-2 501 scaffold", () => {
	it("POST /api/graph/build is 501 until mountGraphApi fires", async () => {
		const daemon = bareDaemon();
		const res = await daemon.app.request("/api/graph/build", {
			method: "POST",
			headers: { "x-honeycomb-org": SCOPE.org },
			body: "{}",
		});
		// The route group is mounted+protected, but no handler is attached → the single 501.
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("not_implemented");
	});
});

// ── The wired path (the fix) ─────────────────────────────────────────────────────

describe("PRD-014 wiring: mountGraphApi turns the 501 into a real end-to-end build", () => {
	/** A daemon with the graph seam fired over the fixture repo + temp base dir. */
	function wiredDaemon(): Daemon {
		const daemon = bareDaemon();
		mountGraphApi(daemon, {
			storage: fakeStorage,
			defaultScope: SCOPE,
			workspaceDir: "/repo",
			graphBaseDir: baseDir,
			buildDeps: fixtureBuildDeps(baseDir),
			identity: IDENTITY,
		});
		return daemon;
	}

	it("POST /api/graph/build invokes the worker and returns success (NOT 501), with real counts", async () => {
		const daemon = wiredDaemon();
		const res = await daemon.app.request("/api/graph/build", {
			method: "POST",
			headers: { "x-honeycomb-org": SCOPE.org },
			body: "{}",
		});

		expect(res.status).toBe(200); // the 501 is gone.
		const body = (await res.json()) as {
			built?: boolean;
			nodeCount?: number;
			edgeCount?: number;
			snapshotSha256?: string;
			push?: string;
		};
		expect(body.built).toBe(true);
		// The two-file fixture produces real file+symbol nodes and a resolved cross-file call edge.
		expect(body.nodeCount).toBeGreaterThan(0);
		expect(body.edgeCount).toBeGreaterThan(0);
		expect(typeof body.snapshotSha256).toBe("string");
		expect(body.snapshotSha256?.length).toBeGreaterThan(0);
		// The push reached the daemon storage client (best-effort) — a real outcome, not a throw.
		expect(["inserted", "inserted-with-duplicate-race", "already-current"]).toContain(body.push);
	});

	it("the build PERSISTS a snapshot on disk (the authoritative local copy)", async () => {
		const daemon = wiredDaemon();
		await daemon.app.request("/api/graph/build", {
			method: "POST",
			headers: { "x-honeycomb-org": SCOPE.org },
			body: "{}",
		});
		const snapDir = join(baseDir, "snapshots");
		expect(existsSync(snapDir)).toBe(true);
		const files = readdirSync(snapDir).filter((f) => f.endsWith(".json"));
		expect(files.length).toBe(1);
		// Named by the commit (the identity carries `commit-abc`).
		expect(files[0]).toBe("commit-abc.json");
	});

	it("GET /api/graph reads the persisted snapshot back as built:true with the FULL nodes+edges view", async () => {
		const daemon = wiredDaemon();
		// Before a build → built:false with EMPTY arrays (no local snapshot yet) — the honest
		// empty state the canvas renders as the "run honeycomb graph build" prompt.
		const before = await daemon.app.request("/api/graph", { headers: { "x-honeycomb-org": SCOPE.org } });
		expect(before.status).toBe(200);
		const beforeBody = (await before.json()) as { built?: boolean; nodes?: unknown[]; edges?: unknown[] };
		expect(beforeBody.built).toBe(false);
		expect(beforeBody.nodes).toEqual([]);
		expect(beforeBody.edges).toEqual([]);

		// Build, then read it back.
		await daemon.app.request("/api/graph/build", {
			method: "POST",
			headers: { "x-honeycomb-org": SCOPE.org },
			body: "{}",
		});
		const after = await daemon.app.request("/api/graph", { headers: { "x-honeycomb-org": SCOPE.org } });
		expect(after.status).toBe(200);
		// The GET now returns the FULL dashboard GraphView (`{ built, nodes, edges }`), NOT a
		// counts-only body — this is what the dashboard `GraphCanvas` renders. The two-file fixture
		// has a real cross-file call, so EDGES are NON-EMPTY (the bug this fix closes was 0 edges).
		const body = (await after.json()) as {
			built?: boolean;
			nodes?: { id: string; label: string; kind: string }[];
			edges?: { from: string; to: string; kind: string }[];
		};
		expect(body.built).toBe(true);
		expect(Array.isArray(body.nodes)).toBe(true);
		expect(Array.isArray(body.edges)).toBe(true);
		expect(body.nodes?.length).toBeGreaterThan(0);
		// THE regression guard: edges flow through (mapped from the snapshot's node-link `links`).
		expect(body.edges?.length).toBeGreaterThan(0);
		// Each edge carries `from`/`to` (mapped from `source`/`target`) + a relation `kind`.
		const edge = body.edges?.[0];
		expect(typeof edge?.from).toBe("string");
		expect(edge?.from.length).toBeGreaterThan(0);
		expect(typeof edge?.to).toBe("string");
		expect(edge?.to.length).toBeGreaterThan(0);
		expect(typeof edge?.kind).toBe("string");
		// Each node carries `id` / `label` / `kind` (the dashboard GraphNode shape) — NO counts-only fields.
		const node = body.nodes?.[0];
		expect(typeof node?.id).toBe("string");
		expect(typeof node?.label).toBe("string");
		expect(typeof node?.kind).toBe("string");
		expect(body).not.toHaveProperty("nodeCount");
		expect(body).not.toHaveProperty("edgeCount");
	});
});

// ── The snapshot → GraphView mapper (the Cause-A fix, unit-level) ─────────────────

/** A minimal NetworkX node-link snapshot with `n` links — edges live under `links`, NOT `edges`. */
function snapshotWith(links: { source: string; target: string; relation: string }[]): Snapshot {
	return {
		directed: true,
		multigraph: true,
		graph: { repo: "honeycomb", commit: "c1" },
		nodes: [
			{ id: "src/a.ts", kind: "file", name: "a.ts", sourceFile: "src/a.ts", language: "typescript", observation: { startLine: 1, endLine: 1 } },
			{ id: "src/b.ts", kind: "file", name: "", sourceFile: "src/b.ts", language: "typescript", observation: { startLine: 1, endLine: 1 } },
		],
		links: links.map((l, i) => ({
			source: l.source,
			target: l.target,
			relation: l.relation as Snapshot["links"][number]["relation"],
			confidence: "EXTRACTED",
			id: `e${i}`,
		})),
		observation: {
			generatedAt: "2026-06-23T00:00:00Z",
			generatorVersion: "test",
			fileCount: 2,
			nodeCount: 2,
			edgeCount: links.length,
			parseErrorCount: 0,
		},
	};
}

describe("snapshotToGraphView maps the node-link snapshot into the dashboard GraphView", () => {
	it("maps `links` (NOT a non-existent `edges` key) → NON-EMPTY edges with from/to from source/target", () => {
		const view = snapshotToGraphView(
			snapshotWith([{ source: "src/a.ts", target: "src/b.ts", relation: "imports" }]),
		);
		expect(view.built).toBe(true);
		// THE Cause-A regression: edges flow from the snapshot's `links` (`source`/`target`).
		expect(view.edges).toHaveLength(1);
		expect(view.edges[0]).toEqual({ from: "src/a.ts", to: "src/b.ts", kind: "imports" });
	});

	it("a snapshot with ZERO links → empty edges (nodes still map)", () => {
		const view = snapshotToGraphView(snapshotWith([]));
		expect(view.built).toBe(true);
		expect(view.edges).toEqual([]);
		// Nodes always map from `nodes` — `label` falls back to `id` when the node has no name.
		expect(view.nodes).toHaveLength(2);
		expect(view.nodes[0]).toEqual({ id: "src/a.ts", label: "a.ts", kind: "file" });
		expect(view.nodes[1]).toEqual({ id: "src/b.ts", label: "src/b.ts", kind: "file" });
	});

	it("under the cap → ships the whole graph with meta.truncated=false (the graph memory cap)", () => {
		const view = snapshotToGraphView(snapshotWith([{ source: "src/a.ts", target: "src/b.ts", relation: "imports" }]));
		expect(view.meta).toEqual({ totalNodes: 2, totalEdges: 1, shownNodes: 2, shownEdges: 1, truncated: false });
	});
});

// ── The memory-aware cap (the graph memory cap): a large snapshot ships BOUNDED, not whole ─────
describe("snapshotToGraphView bounds a large snapshot (the graph memory cap — the memory fix)", () => {
	/** A snapshot of `n` file nodes; `linkedPairs` consecutive pairs get an `imports` link (so some have degree). */
	function bigSnapshot(n: number, linkedPairs: number): Snapshot {
		const nodes = Array.from({ length: n }, (_, i) => ({
			id: `src/f${i}.ts`,
			kind: "file" as const,
			name: `f${i}.ts`,
			sourceFile: `src/f${i}.ts`,
			language: "typescript" as const,
			observation: { startLine: 1, endLine: 1 },
		}));
		const links = Array.from({ length: linkedPairs }, (_, i) => ({
			source: `src/f${i}.ts`,
			target: `src/f${i + 1}.ts`,
			relation: "imports" as const,
			confidence: "EXTRACTED" as const,
			id: `e${i}`,
		}));
		return {
			directed: true,
			multigraph: true,
			graph: { repo: "honeycomb", commit: "c1" },
			nodes,
			links,
			observation: { generatedAt: "2026-06-23T00:00:00Z", generatorVersion: "test", fileCount: n, nodeCount: n, edgeCount: links.length, parseErrorCount: 0 },
		};
	}

	it("caps the shipped node count to `limit` and reports the full-vs-shown counts honestly", () => {
		// 5000 nodes, 100 connected → with a tiny limit of 50 the view ships at most 50 nodes, never 5000.
		const view = snapshotToGraphView(bigSnapshot(5000, 100), 50);
		expect(view.nodes.length).toBe(50);
		expect(view.meta?.truncated).toBe(true);
		expect(view.meta?.totalNodes).toBe(5000);
		expect(view.meta?.shownNodes).toBe(50);
		// Every shipped edge connects two SHIPPED nodes (no dangling endpoint).
		const ids = new Set(view.nodes.map((n) => n.id));
		for (const e of view.edges) {
			expect(ids.has(e.from)).toBe(true);
			expect(ids.has(e.to)).toBe(true);
		}
	});

	it("keeps the CONNECTED core under the cap — the most-linked nodes survive, isolated ones drop", () => {
		// 200 nodes but only the first ~21 participate in the 20 import links; cap to 30.
		const view = snapshotToGraphView(bigSnapshot(200, 20), 30);
		expect(view.nodes.length).toBe(30);
		// The connected nodes (f0..f20) rank above the 179 isolated ones, so edges survive the cap.
		expect(view.edges.length).toBeGreaterThan(0);
	});
});

// ── The route-collision is GONE: exactly ONE GET /api/graph after BOTH mounts fire ──

describe("route-collision resolution: a SINGLE GET /api/graph handler serves the full view", () => {
	it("with BOTH mountDashboardApi AND mountGraphApi fired, GET /api/graph returns the full nodes+edges view (not counts-only / not built:false flap)", async () => {
		const daemon = bareDaemon();
		// Fire the dashboard seam FIRST (its old graph handler would have shadowed the real one)…
		mountDashboardApi(daemon, { storage: fakeStorage, defaultScope: SCOPE });
		// …then the graph seam, the SINGLE owner of GET /api/graph.
		mountGraphApi(daemon, {
			storage: fakeStorage,
			defaultScope: SCOPE,
			workspaceDir: "/repo",
			graphBaseDir: baseDir,
			buildDeps: fixtureBuildDeps(baseDir),
			identity: IDENTITY,
		});

		// Build so there is a local snapshot to serve.
		await daemon.app.request("/api/graph/build", {
			method: "POST",
			headers: { "x-honeycomb-org": SCOPE.org },
			body: "{}",
		});

		const res = await daemon.app.request("/api/graph", { headers: { "x-honeycomb-org": SCOPE.org } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { built?: boolean; nodes?: unknown[]; edges?: unknown[] };
		// The ONE handler that answers is the codebase-graph FULL-view handler: it carries the
		// nodes AND edges arrays (the dashboard's counts-only / DeepLake-read flap is gone).
		expect(body.built).toBe(true);
		expect(Array.isArray(body.nodes)).toBe(true);
		expect(Array.isArray(body.edges)).toBe(true);
		expect(body.edges?.length).toBeGreaterThan(0);
	});
});
