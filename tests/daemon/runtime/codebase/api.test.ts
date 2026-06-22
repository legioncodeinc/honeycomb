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
import { mountGraphApi } from "../../../../src/daemon/runtime/codebase/api.js";
import type { SnapshotIdentity } from "../../../../src/daemon/runtime/codebase/contracts.js";
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

	it("GET /api/graph reads the persisted snapshot back as built:true with real nodes/edges", async () => {
		const daemon = wiredDaemon();
		// Before a build → built:false (no local snapshot yet).
		const before = await daemon.app.request("/api/graph", { headers: { "x-honeycomb-org": SCOPE.org } });
		expect(before.status).toBe(200);
		expect((await before.json() as { built?: boolean }).built).toBe(false);

		// Build, then read it back.
		await daemon.app.request("/api/graph/build", {
			method: "POST",
			headers: { "x-honeycomb-org": SCOPE.org },
			body: "{}",
		});
		const after = await daemon.app.request("/api/graph", { headers: { "x-honeycomb-org": SCOPE.org } });
		expect(after.status).toBe(200);
		const body = (await after.json()) as { built?: boolean; nodeCount?: number; edgeCount?: number; commit?: string };
		expect(body.built).toBe(true);
		expect(body.nodeCount).toBeGreaterThan(0);
		expect(body.edgeCount).toBeGreaterThan(0);
		expect(body.commit).toBe("commit-abc");
	});
});
