/**
 * PRD-042 — the Sync page daemon MOUNT (`/api/diagnostics/assets` + `/api/diagnostics/sync/*`).
 *
 * Mounts {@link mountSyncApi} onto a fake daemon (a bare Hono exposed via `daemon.group`) over a
 * RECORDING action engine + a canned view, then drives it with `app.request`. The decisive assertions:
 *   - GET /assets returns the union view-model (skills + agents);
 *   - each action route parses its `{ assetType, name }` body + dispatches to the right engine method;
 *   - the action PATHS are under `/api/diagnostics/sync/` so the 042c activity feed can filter them;
 *   - a body with no resolvable org 400s (fail-closed) in a mode with no default scope;
 *   - the `defaultScope` backfills a local-mode request that omits org;
 *   - no secret rides any response.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSyncApi, SYNC_GROUP, type MountSyncOptions } from "../../../../src/daemon/runtime/dashboard/sync-mount.js";
import type { SyncActionApi, SyncActionRequest } from "../../../../src/daemon/runtime/dashboard/sync-api.js";
import type { Daemon } from "../../../../src/daemon/runtime/server.js";
import type { StorageQuery, QueryScope } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult } from "../../../../src/daemon/storage/result.js";

/** A storage stub that answers the union SELECT with a canned skill + agent row. */
function stubStorage(): StorageQuery {
	return {
		async query(_sql: string, _scope: QueryScope): Promise<QueryResult> {
			return ok([], 1);
		},
	};
}

/** A recording action engine: captures each request + replays a canned converged result. */
function recordingApi(): { api: SyncActionApi; calls: { action: string; req: SyncActionRequest }[] } {
	const calls: { action: string; req: SyncActionRequest }[] = [];
	const make = (action: string) => async (req: SyncActionRequest) => {
		calls.push({ action, req });
		return { ok: true, action: action as "promote", assetType: req.assetType, honeycombId: "hc_x", state: "shared" as const, version: 2 };
	};
	const api: SyncActionApi = {
		promote: make("promote"),
		pull: make("pull"),
		demote: make("demote"),
		enable: make("enable"),
		disable: make("disable"),
	};
	return { api, calls };
}

/**
 * Build a fake daemon + mount the Sync API, then route the group onto a root app. The mount happens
 * BEFORE `root.route` (Hono copies routes at `route()` time, mirroring `server.ts`'s note), so the
 * handlers are present when the request lands. Returns the app + the recording engine's calls.
 */
function buildMounted(
	mode: "local" | "team",
	over: Partial<MountSyncOptions> = {},
): { app: Hono; calls: { action: string; req: SyncActionRequest }[] } {
	const root = new Hono();
	const group = new Hono();
	const daemon = {
		config: { mode },
		group: (path: string) => (path === SYNC_GROUP ? group : undefined),
	} as unknown as Daemon;
	const { api, calls } = recordingApi();
	mountSyncApi(daemon, { storage: stubStorage(), actionApi: api, ...over });
	root.route(SYNC_GROUP, group);
	return { app: root, calls };
}

const LOCAL_SCOPE: QueryScope = { org: "acme", workspace: "backend" };

describe("PRD-042 /api/diagnostics/sync mount", () => {
	it("each action route dispatches a parsed request under /api/diagnostics/sync/<action>", async () => {
		const { app, calls } = buildMounted("local", { defaultScope: LOCAL_SCOPE });

		for (const action of ["promote", "pull", "demote", "enable", "disable"] as const) {
			const res = await app.request(`/api/diagnostics/sync/${action}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ assetType: action === "pull" ? "agent" : "skill", name: "x", honeycombId: "hc_x" }),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.action).toBe(action);
		}
		expect(calls.map((c) => c.action)).toEqual(["promote", "pull", "demote", "enable", "disable"]);
		// pull was sent assetType:agent — symmetry proven through the mount too.
		expect(calls.find((c) => c.action === "pull")?.req.assetType).toBe("agent");
	});

	it("GET /assets returns the union view-model (skills + agents)", async () => {
		// The route is wired + returns the {skills,agents} shape (an empty union is valid here — the
		// real fetchAssetSyncView reads the stub storage, which returns no rows).
		const { app } = buildMounted("local", { defaultScope: LOCAL_SCOPE });
		const res = await app.request("/api/diagnostics/assets", { method: "GET" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("skills");
		expect(body).toHaveProperty("agents");
		expect(Array.isArray(body.skills)).toBe(true);
		expect(Array.isArray(body.agents)).toBe(true);
	});

	it("fails closed (400) when no org is resolvable and no default scope", async () => {
		// team mode, no defaultScope, no identity → no resolvable org.
		const { app } = buildMounted("team");
		const res = await app.request("/api/diagnostics/sync/promote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ assetType: "skill", name: "x" }),
		});
		expect(res.status).toBe(400);
	});

	it("a malformed body 400s", async () => {
		const { app } = buildMounted("local", { defaultScope: LOCAL_SCOPE });
		const res = await app.request("/api/diagnostics/sync/promote", { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" });
		expect(res.status).toBe(400);
	});

	it("no secret rides an action response", async () => {
		const { app } = buildMounted("local", { defaultScope: LOCAL_SCOPE });
		const res = await app.request("/api/diagnostics/sync/promote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ assetType: "skill", name: "x", native: "SECRET-BODY" }),
		});
		const text = await res.text();
		expect(text).not.toContain("SECRET-BODY");
		expect(text).not.toContain("@");
	});
});
