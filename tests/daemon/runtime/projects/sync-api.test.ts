/**
 * PRD-049d — the registry → cache sync HTTP trigger seam suite.
 *
 * Verification posture (mirrors the pollinate seam suite): the seam is mounted on a REAL daemon
 * (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's permission middleware
 * is open) and exercised in-process via `daemon.app.request(...)` — no socket, no live DeepLake. A
 * FAKE StorageQuery scripts the registry read; a temp `~/.deeplake` dir holds the cache the sync
 * writes. The cases prove the live wiring + the ack contract + the fail-soft posture.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { type ProjectsSyncAck, mountProjectsSyncApi } from "../../../../src/daemon/runtime/projects/sync-api.js";
import { loadProjectsCache } from "../../../../src/hooks/shared/index.js";

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

function daemonWithSync(storage: StorageQuery, dir: string): Daemon {
	const daemon = createDaemon({ config: cfg(), storage: storage as never, logger: createRequestLogger({ silent: true }) });
	mountProjectsSyncApi(daemon, { storage, defaultScope: DEFAULT_SCOPE, dir });
	return daemon;
}

async function postSync(daemon: Daemon): Promise<{ status: number; ack: ProjectsSyncAck }> {
	const res = await daemon.app.request("/api/diagnostics/projects-sync", { method: "POST" });
	const ack = (await res.json()) as ProjectsSyncAck;
	return { status: res.status, ack };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-syncapi-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/diagnostics/projects-sync refreshes the cache (the live 049d wiring)", () => {
	it("returns 200 + {synced:true,projectCount} and writes the cache", async () => {
		const daemon = daemonWithSync(fakeStorage(ok([registryRow()], 1)), dir);
		const { status, ack } = await postSync(daemon);
		expect(status).toBe(200);
		expect(ack).toEqual({ synced: true, projectCount: 1 });
		expect(loadProjectsCache(dir).projects[0]?.projectId).toBe("api");
	});

	it("is fail-soft: a registry read failure returns {synced:false,reason}, never a 500", async () => {
		const daemon = daemonWithSync(fakeStorage(queryError("missing table", 404)), dir);
		const { status, ack } = await postSync(daemon);
		expect(status).toBe(200);
		expect(ack.synced).toBe(false);
		expect(ack.reason).toContain("query_error");
	});

	it("carries NO token/secret in the ack body (D-4)", async () => {
		const daemon = daemonWithSync(fakeStorage(ok([registryRow()], 1)), dir);
		const { ack } = await postSync(daemon);
		expect(JSON.stringify(ack)).not.toMatch(/token|secret|bearer/i);
	});
});
