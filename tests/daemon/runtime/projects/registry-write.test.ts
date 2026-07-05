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
 * PRD-062 FIX 1 — the `projects` registry WRITE path (upsert-on-bind + fail-soft).
 *
 * Before this fix there was NO write path to the Deeplake `projects` table, so a bound project
 * lived only in the local JSON cache and the next `syncRegistryToCache` erased it. These tests prove
 * the write path:
 *   - reg-AC-1: a NEW project upserts as an INSERT carrying its columns + tenancy.
 *   - reg-AC-2: an EXISTING project upserts as an UPDATE (no duplicate INSERT).
 *   - reg-AC-3: the reserved inbox / an empty id is refused (nothing written).
 *   - reg-AC-4: a backend flap yields ok:false and never throws (fail-soft bind UX).
 *   - reg-AC-5: POST /projects/bind persists the new project through the registry write path.
 *
 * Verification posture: a recording fake StorageQuery (asserts the exact SQL) and, for the bind
 * route, a REAL daemon in local mode exercised in-process. No live DeepLake, no network.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, queryError } from "../../../../src/daemon/storage/result.js";
import { upsertProjectRow } from "../../../../src/daemon/runtime/projects/registry-write.js";
import { type BindAck, mountOnboardingApi } from "../../../../src/daemon/runtime/projects/onboarding-api.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { GitRemoteReader } from "../../../../src/hooks/shared/index.js";

const SCOPE: QueryScope = { org: "acme", workspace: "backend" };

/** A recording fake StorageQuery: captures every SQL and answers per a router. */
function recordingStorage(router: (sql: string) => QueryResult): { storage: StorageQuery; sql: string[] } {
	const sql: string[] = [];
	const storage: StorageQuery = {
		async query(q: string): Promise<QueryResult> {
			sql.push(q);
			return router(q);
		},
	};
	return { storage, sql };
}

describe("PRD-062 FIX 1: upsertProjectRow writes the projects registry", () => {
	it("reg-AC-1: a NEW project upserts as an INSERT with its columns + tenancy", async () => {
		// The key-probe SELECT returns no rows → updateOrInsertByKey INSERTs.
		const { storage, sql } = recordingStorage(() => ok([], 0));
		const res = await upsertProjectRow(storage, SCOPE, {
			projectId: "api",
			name: "API",
			remoteSignal: "github.com/acme/api",
			boundPaths: ["/work/api"],
		});
		expect(res.ok).toBe(true);
		const insert = sql.find((s) => /INSERT INTO "projects"/.test(s));
		expect(insert).toBeDefined();
		expect(insert).toContain("'api'"); // project_id via the guarded literal path.
		expect(insert).toContain("'acme'"); // org_id tenancy.
		expect(insert).toContain("'backend'"); // workspace_id tenancy.
		expect(insert).toContain("'github.com/acme/api'"); // remote_signal.
	});

	it("reg-AC-2: an EXISTING project upserts as an UPDATE, never a duplicate INSERT", async () => {
		const { storage, sql } = recordingStorage((q) =>
			// The key-probe SELECT finds a row → updateOrInsertByKey UPDATEs in place.
			/^\s*SELECT/i.test(q) ? ok([{ project_id: "api" }], 0) : ok([], 0),
		);
		const res = await upsertProjectRow(storage, SCOPE, { projectId: "api", name: "API", remoteSignal: "", boundPaths: [] });
		expect(res.ok).toBe(true);
		expect(sql.some((s) => /UPDATE "projects" SET/.test(s))).toBe(true);
		expect(sql.some((s) => /INSERT INTO "projects"/.test(s))).toBe(false);
	});

	it("reg-AC-3: refuses to write the reserved inbox or an empty id (nothing is written)", async () => {
		const { storage, sql } = recordingStorage(() => ok([], 0));
		expect((await upsertProjectRow(storage, SCOPE, { projectId: "__unsorted__", name: "Unsorted", remoteSignal: "", boundPaths: [] })).ok).toBe(false);
		expect((await upsertProjectRow(storage, SCOPE, { projectId: "  ", name: "", remoteSignal: "", boundPaths: [] })).ok).toBe(false);
		expect(sql).toEqual([]); // no statement ever issued for a refused write.
	});

	it("reg-AC-3b (security remediation): case/name VARIANTS of the reserved inbox are refused too", async () => {
		// The 049a-AC-6 guard is trim + case-insensitive over BOTH the reserved id and the reserved
		// display name (`isReservedProjectId`) — an exact-match check alone would let `__UNSORTED__` /
		// `Unsorted` materialize a user row shadowing the per-workspace capture inbox.
		const { storage, sql } = recordingStorage(() => ok([], 0));
		expect((await upsertProjectRow(storage, SCOPE, { projectId: "__UNSORTED__", name: "x", remoteSignal: "", boundPaths: [] })).ok).toBe(false);
		expect((await upsertProjectRow(storage, SCOPE, { projectId: " __Unsorted__ ", name: "x", remoteSignal: "", boundPaths: [] })).ok).toBe(false);
		expect((await upsertProjectRow(storage, SCOPE, { projectId: "legit-id", name: "Unsorted", remoteSignal: "", boundPaths: [] })).ok).toBe(false);
		expect((await upsertProjectRow(storage, SCOPE, { projectId: "legit-id", name: "unsorted", remoteSignal: "", boundPaths: [] })).ok).toBe(false);
		expect(sql).toEqual([]); // every variant refused before any statement is issued.
	});

	it("reg-AC-4: a backend flap yields ok:false and never throws (fail-soft)", async () => {
		const { storage } = recordingStorage(() => queryError("boom", 500));
		const res = await upsertProjectRow(storage, SCOPE, { projectId: "api", name: "API", remoteSignal: "", boundPaths: [] });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("query_error");
	});
});

describe("PRD-062 FIX 1: POST /projects/bind persists the project into the registry", () => {
	function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
		return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
	}
	let browseRoot: string;
	let cacheDir: string;
	beforeEach(() => {
		browseRoot = mkdtempSync(join(tmpdir(), "hc-regwrite-browse-"));
		cacheDir = mkdtempSync(join(tmpdir(), "hc-regwrite-cache-"));
	});
	afterEach(() => {
		for (const d of [browseRoot, cacheDir]) rmSync(d, { recursive: true, force: true });
	});

	it("reg-AC-5: a bind upserts the new project row (ack.registrySynced true, INSERT recorded)", async () => {
		const folder = join(browseRoot, "svc");
		mkdirSync(folder, { recursive: true });
		const { storage, sql } = recordingStorage(() => ok([], 0));
		const readRemote: GitRemoteReader = (cwd) => (cwd === folder ? "git@github.com:acme/svc.git" : null);
		const daemon: Daemon = createDaemon({
			config: cfg(),
			storage: storage as never,
			logger: createRequestLogger({ silent: true }),
		});
		mountOnboardingApi(daemon, { org: "acme", workspace: "backend", projectsDir: cacheDir, browseRoot, storage, readRemote });

		const res = await daemon.app.request("/api/diagnostics/projects/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: folder }),
		});
		expect(res.status).toBe(200);
		const ack = (await res.json()) as BindAck;
		expect(ack.bound).toBe(true);
		expect(ack.projectId).toBe("svc"); // suggested from the canonical remote's repo segment.
		expect(ack.registrySynced).toBe(true); // FIX 1: the registry upsert landed.
		const insert = sql.find((s) => /INSERT INTO "projects"/.test(s));
		expect(insert).toBeDefined();
		expect(insert as string).toContain("'svc'");
		expect(insert as string).toContain("'github.com/acme/svc'");
	});
});
