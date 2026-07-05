/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-062 FIX 3 — GET /api/diagnostics/scope/projects is now TTL-cached, and a bind INVALIDATES it.
 *
 *   cache-AC-3: the SECOND read is served from cache — no new registry-sync SELECT, no new counts
 *               SELECTs (the previously-uncached, ~80s-per-mount read now skips the Deeplake round-trips).
 *   cache-AC-4: a bind through the SHARED cache invalidates it, so the next read re-syncs and the
 *               freshly-bound project appears immediately (not after the TTL lapses).
 *
 * Verification posture: a REAL daemon in local mode with BOTH the scope-enumeration read and the
 * onboarding bind mounted over ONE shared ProjectsViewCache, a recording fake storage that counts the
 * registry-list + counts SELECTs. No live DeepLake, no network.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { ProjectsViewCache } from "../../../../src/daemon/runtime/projects/projects-view-cache.js";
import type { ProjectCountsMap } from "../../../../src/daemon/runtime/projects/project-counts.js";
import { mountScopeEnumerationApi, type ScopeProjectsBody } from "../../../../src/daemon/runtime/projects/scope-enumeration-api.js";
import { mountOnboardingApi } from "../../../../src/daemon/runtime/projects/onboarding-api.js";

const DEFAULT_SCOPE: QueryScope = { org: "acme", workspace: "backend" };

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
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

/** A storage that counts the registry-list read + the two counts aggregates (the Deeplake cost of a read). */
function countingStorage(): { storage: StorageQuery; counts: { list: number; mem: number; sess: number } } {
	const counts = { list: 0, mem: 0, sess: 0 };
	const storage: StorageQuery = {
		async query(q: string): Promise<QueryResult> {
			if (/SELECT \* FROM "projects"/.test(q)) {
				counts.list += 1;
				return ok([registryRow()], 1);
			}
			if (/FROM\s+"memories"/i.test(q)) {
				counts.mem += 1;
				return ok([], 0);
			}
			if (/FROM\s+"sessions"/i.test(q)) {
				counts.sess += 1;
				return ok([], 0);
			}
			return ok([], 0); // the upsert probe / INSERT on bind.
		},
	};
	return { storage, counts };
}

let cacheDir: string;
let bindFolder: string;
beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "hc-scopecache-"));
	bindFolder = mkdtempSync(join(tmpdir(), "hc-scopecache-folder-"));
});
afterEach(() => {
	for (const d of [cacheDir, bindFolder]) rmSync(d, { recursive: true, force: true });
});

function buildDaemon(storage: StorageQuery, sharedCache: ProjectsViewCache<ProjectCountsMap>): Daemon {
	const daemon = createDaemon({
		config: cfg(),
		storage: storage as never,
		logger: createRequestLogger({ silent: true }),
	});
	mountScopeEnumerationApi(daemon, {
		storage,
		defaultScope: DEFAULT_SCOPE,
		credentialsDir: cacheDir,
		projectsDir: cacheDir,
		env: {},
		projectsViewCache: sharedCache,
	});
	mountOnboardingApi(daemon, {
		org: "acme",
		workspace: "backend",
		projectsDir: cacheDir,
		browseRoot: bindFolder,
		storage,
		projectsViewCache: sharedCache,
	});
	return daemon;
}

describe("PRD-062 FIX 3: scope/projects TTL cache + invalidation-on-bind", () => {
	it("cache-AC-3: the second read is a cache HIT (no new registry-sync / counts SELECTs)", async () => {
		const { storage, counts } = countingStorage();
		const daemon = buildDaemon(storage, new ProjectsViewCache<ProjectCountsMap>(10_000));

		const first = await daemon.app.request("/api/diagnostics/scope/projects");
		expect(first.status).toBe(200);
		expect(counts).toEqual({ list: 1, mem: 1, sess: 1 }); // cold read ran sync (1) + counts (2).

		const second = await daemon.app.request("/api/diagnostics/scope/projects");
		expect(second.status).toBe(200);
		expect(counts).toEqual({ list: 1, mem: 1, sess: 1 }); // UNCHANGED → served from cache.
	});

	it("cache-AC-4: a bind invalidates the cache so the next read re-syncs and shows the project", async () => {
		const { storage, counts } = countingStorage();
		const shared = new ProjectsViewCache<ProjectCountsMap>(10_000);
		const daemon = buildDaemon(storage, shared);

		await daemon.app.request("/api/diagnostics/scope/projects"); // cold read → list:1
		await daemon.app.request("/api/diagnostics/scope/projects"); // cached → still list:1
		expect(counts.list).toBe(1);

		// Bind a new folder to a NEW project → invalidates the shared cache.
		const bindRes = await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: bindFolder, name: "freshproj" }),
		});
		expect(bindRes.status).toBe(200);

		// The next read is a cache MISS (invalidated) → it re-syncs (list:2) and the new project appears.
		const after = await daemon.app.request("/api/diagnostics/scope/projects");
		expect(after.status).toBe(200);
		expect(counts.list).toBe(2); // re-synced after invalidation.
		const body = (await after.json()) as ScopeProjectsBody;
		expect(body.projects.map((p) => p.projectId)).toContain("freshproj");
	});
});
