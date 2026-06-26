/**
 * PRD-059d — the import-enumeration filter on GET /api/diagnostics/scope/projects (d-AC-1).
 *
 * The 059d "Import project from cloud" list is the workspace's registry projects that have NO local
 * binding on THIS device (created elsewhere, not yet attached here). The scope/projects read now tags
 * each project `boundLocally` and accepts `?unbound=1` to return only the importable set. The ACTIVE
 * Projects page (059c) uses the full list / `boundLocally:true`; the import list uses `?unbound=1`.
 *
 * Verification posture mirrors `scope-enumeration-api.test.ts`: a REAL `local`-mode daemon exercised
 * in-process; a fake StorageQuery feeds the registry sync; a temp `~/.deeplake` seeded with a local
 * binding distinguishes active from importable. NO network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { DeeplakeAuthClient } from "../../../../src/daemon/runtime/auth/index.js";
import {
	type ScopeProjectsBody,
	mountScopeEnumerationApi,
} from "../../../../src/daemon/runtime/projects/scope-enumeration-api.js";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

const DEFAULT_SCOPE: QueryScope = { org: "acme", workspace: "backend" };

function fakeStorage(result: QueryResult): StorageQuery {
	return { async query(): Promise<QueryResult> { return result; } };
}

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

function fakeAuthClient(): DeeplakeAuthClient {
	return {
		apiUrl: "https://api.deeplake.test",
		async getMe() {
			return { id: "u1", name: "User" };
		},
		async listOrgs() {
			return [];
		},
		async listWorkspaces() {
			return [];
		},
		async reMint() {
			return "t";
		},
		async requestDeviceCode() {
			throw new Error("not used");
		},
		async pollDeviceToken() {
			throw new Error("not used");
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-import-"));
	// Seed a cache: a LOCAL binding for `api` only; `web` is registry-only (importable on this device).
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({
			schemaVersion: 1,
			org: "acme",
			workspace: "backend",
			bindings: [{ path: "/work/api", projectId: "api" }],
			projects: [],
		}),
		"utf8",
	);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function daemonWith(storage: StorageQuery): Daemon {
	const daemon = createDaemon({
		config: cfg(),
		storage: storage as never,
		logger: createRequestLogger({ silent: true }),
	});
	mountScopeEnumerationApi(daemon, {
		storage,
		defaultScope: DEFAULT_SCOPE,
		credentialsDir: dir,
		projectsDir: dir,
		env: {},
		authClientFactory: () => fakeAuthClient(),
	});
	return daemon;
}

describe("PRD-059d scope/projects import filter (d-AC-1)", () => {
	it("tags each project boundLocally (active vs importable)", async () => {
		// The registry has both `api` (locally bound) and `web` (registry-only on this device).
		const storage = fakeStorage(ok([registryRow({ project_id: "api", name: "API" }), registryRow({ project_id: "web", name: "Web", remote_signal: "github.com/acme/web" })], 2));
		const daemon = daemonWith(storage);
		const res = await daemon.app.request("/api/diagnostics/scope/projects");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ScopeProjectsBody;
		const byId = new Map(body.projects.map((p) => [p.projectId, p]));
		expect(byId.get("api")?.boundLocally).toBe(true); // has a local binding → active.
		expect(byId.get("web")?.boundLocally).toBe(false); // registry-only → importable.
	});

	it("?unbound=1 returns ONLY the importable (no-local-binding) projects", async () => {
		const storage = fakeStorage(ok([registryRow({ project_id: "api", name: "API" }), registryRow({ project_id: "web", name: "Web", remote_signal: "github.com/acme/web" })], 2));
		const daemon = daemonWith(storage);
		const res = await daemon.app.request("/api/diagnostics/scope/projects?unbound=1");
		const body = (await res.json()) as ScopeProjectsBody;
		expect(body.projects.map((p) => p.projectId)).toEqual(["web"]); // only the importable one.
	});
});
