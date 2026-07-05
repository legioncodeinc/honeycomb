/**
 * PRD-049d — the daemon registry → local-cache sync (fail-soft).
 *
 * `syncRegistryToCache` reads the workspace's `projects` registry through the injected StorageQuery
 * seam and refreshes the local `~/.deeplake/projects.json` cache the thin-client resolver reads. The
 * load-bearing properties: it MERGES (preserves the local folder→project bindings a `project bind`
 * wrote while replacing the registry `projects[]` copy), and it is FAIL-SOFT (a non-ok storage
 * result writes nothing and leaves the prior cache intact — never a throw).
 *
 * Verification posture: a temp `~/.deeplake` cache dir + a fake StorageQuery returning scripted
 * closed-union results. No real DeepLake, no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { connectionError, ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { syncRegistryToCache } from "../../../../src/daemon/runtime/projects/registry-sync.js";
import {
	bindFolderToProject,
	loadProjectsCache,
	saveProjectsCache,
} from "../../../../src/hooks/shared/index.js";

const SCOPE: QueryScope = { org: "acme", workspace: "backend" };

/** A StorageQuery that returns one scripted result and records the SQL it was asked. */
function fakeStorage(result: QueryResult): { storage: StorageQuery; sql: string[] } {
	const sql: string[] = [];
	const storage: StorageQuery = {
		async query(q: string): Promise<QueryResult> {
			sql.push(q);
			return result;
		},
	};
	return { storage, sql };
}

/** One registry row (the DeepLake column shape — `bound_paths` is a JSON-array string). */
function registryRow(over: Partial<StorageRow> = {}): StorageRow {
	return {
		project_id: "api",
		name: "API",
		remote_signal: "github.com/acme/api",
		bound_paths: "[]",
		is_reserved: 0,
		org_id: "acme",
		workspace_id: "backend",
		created_at: "",
		updated_at: "",
		...over,
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-regsync-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("syncRegistryToCache refreshes the projects[] half from the registry", () => {
	it("writes a cache whose projects mirror the registry rows", async () => {
		const { storage } = fakeStorage(
			ok([registryRow(), registryRow({ project_id: "web", name: "Web", remote_signal: "github.com/acme/web" })], 1),
		);
		const result = await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.projectCount).toBe(2);

		const cache = loadProjectsCache(dir);
		expect(cache.org).toBe("acme");
		expect(cache.workspace).toBe("backend");
		expect(cache.projects.map((p) => p.projectId).sort()).toEqual(["api", "web"]);
		const api = cache.projects.find((p) => p.projectId === "api");
		expect(api?.remoteSignal).toBe("github.com/acme/api");
	});

	it("parses bound_paths from its JSON-array string", async () => {
		const bound = resolve(dir, "work", "api");
		const { storage } = fakeStorage(ok([registryRow({ bound_paths: JSON.stringify([bound]) })], 1));
		await syncRegistryToCache({ storage, scope: SCOPE, dir });
		const cache = loadProjectsCache(dir);
		expect(cache.projects[0]?.boundPaths).toEqual([bound]);
	});

	it("tolerates a malformed bound_paths string (fail-soft to [])", async () => {
		const { storage } = fakeStorage(ok([registryRow({ bound_paths: "{not json" })], 1));
		const result = await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(result.ok).toBe(true);
		expect(loadProjectsCache(dir).projects[0]?.boundPaths).toEqual([]);
	});
});

describe("the merge preserves local bindings (49d-AC-2 round-trip survives a sync)", () => {
	it("keeps a folder binding a `project bind` wrote while refreshing projects[]", async () => {
		const cwd = join(dir, "work", "api");
		// A developer just bound this folder (the local bindings half).
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });

		// A concurrent registry sync refreshes the projects[] copy.
		const { storage } = fakeStorage(ok([registryRow({ project_id: "api" })], 1));
		await syncRegistryToCache({ storage, scope: SCOPE, dir });

		const cache = loadProjectsCache(dir);
		// The binding SURVIVES the sync — the round-trip is not un-bound by a registry refresh.
		expect(cache.bindings.some((b) => b.projectId === "api")).toBe(true);
	});
});

describe("fail-soft: a non-ok storage result leaves the prior cache intact", () => {
	it("a query_error writes nothing and returns ok:false", async () => {
		// Seed a prior cache that must NOT be clobbered.
		const cwd = join(dir, "work", "api");
		bindFolderToProject({ cwd, projectId: "api", org: "acme", workspace: "backend", dir });
		const before = loadProjectsCache(dir);

		const { storage } = fakeStorage(queryError("table projects does not exist", 404));
		const result = await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("query_error");

		// The prior cache is untouched (capture never dropped).
		expect(loadProjectsCache(dir)).toEqual(before);
	});

	it("a connection_error is fail-soft too (no throw, prior cache intact)", async () => {
		saveProjectsCache(
			{ schemaVersion: 1, org: "acme", workspace: "backend", bindings: [], projects: [] },
			dir,
		);
		const before = loadProjectsCache(dir);
		const { storage } = fakeStorage(connectionError("ECONNREFUSED"));
		const result = await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(result.ok).toBe(false);
		expect(loadProjectsCache(dir)).toEqual(before);
	});
});

/**
 * A routed fake: the registry LIST read (`SELECT * FROM "projects"`) returns `listRows`; every OTHER
 * statement (the upsert probe SELECT + its INSERT/UPDATE) is answered by `upsert()` so a test can make
 * the heal write succeed or flap. Records all SQL for assertions.
 */
function routedStorage(listRows: StorageRow[], upsert: () => QueryResult = () => ok([], 0)): {
	storage: StorageQuery;
	sql: string[];
} {
	const sql: string[] = [];
	const storage: StorageQuery = {
		async query(q: string): Promise<QueryResult> {
			sql.push(q);
			if (/SELECT \* FROM "projects"/.test(q)) return ok(listRows, 1);
			return upsert();
		},
	};
	return { storage, sql };
}

describe("PRD-062 FIX 1: local-only projects are MERGED, not clobbered, and healed into the registry", () => {
	it("reg-AC-6: a local-only project survives a sync and its heal upsert is attempted", async () => {
		// Seed a prior cache with a project that exists ONLY locally (absent from the registry read).
		saveProjectsCache(
			{
				schemaVersion: 1,
				org: "acme",
				workspace: "backend",
				bindings: [],
				projects: [{ projectId: "local-x", name: "Local X", remoteSignal: "", boundPaths: [resolve(dir, "work", "x")] }],
			},
			dir,
		);
		// The registry read returns a DIFFERENT project (api); local-x must NOT be clobbered.
		const { storage, sql } = routedStorage([registryRow({ project_id: "api" })]);
		const result = await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(result.ok).toBe(true);

		const cache = loadProjectsCache(dir);
		expect(cache.projects.map((p) => p.projectId).sort()).toEqual(["api", "local-x"]); // merged, not clobbered.
		// The heal path attempted to upsert the local-only project into the registry.
		expect(sql.some((s) => /INSERT INTO "projects"/.test(s) && s.includes("'local-x'"))).toBe(true);
	});

	it("reg-AC-7: a flapped registry write leaves the project local-only and heals on the NEXT sync", async () => {
		saveProjectsCache(
			{
				schemaVersion: 1,
				org: "acme",
				workspace: "backend",
				bindings: [],
				projects: [{ projectId: "local-x", name: "Local X", remoteSignal: "", boundPaths: [] }],
			},
			dir,
		);
		let upsertFails = true;
		const { storage, sql } = routedStorage([], () => (upsertFails ? queryError("flap", 500) : ok([], 0)));

		// First sync: the heal upsert FLAPS, but the project must remain visible locally (not dropped).
		await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(loadProjectsCache(dir).projects.some((p) => p.projectId === "local-x")).toBe(true);

		// Next sync: the write now succeeds → the project heals into the registry.
		upsertFails = false;
		sql.length = 0;
		await syncRegistryToCache({ storage, scope: SCOPE, dir });
		expect(loadProjectsCache(dir).projects.some((p) => p.projectId === "local-x")).toBe(true);
		expect(sql.some((s) => /INSERT INTO "projects"/.test(s) && s.includes("'local-x'"))).toBe(true);
	});
});

describe("tenancy guard: a foreign-tenancy prior cache's bindings are dropped on sync", () => {
	it("does not carry another workspace's bindings into the synced cache", async () => {
		// Prior cache belongs to a DIFFERENT workspace.
		saveProjectsCache(
			{
				schemaVersion: 1,
				org: "acme",
				workspace: "OTHER",
				bindings: [{ path: resolve(dir, "other"), projectId: "other-proj" }],
				projects: [],
			},
			dir,
		);
		const { storage } = fakeStorage(ok([registryRow()], 1));
		await syncRegistryToCache({ storage, scope: SCOPE, dir });
		const cache = loadProjectsCache(dir);
		expect(cache.workspace).toBe("backend");
		expect(cache.bindings.some((b) => b.projectId === "other-proj")).toBe(false);
	});
});
