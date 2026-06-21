/**
 * PRD-033c — the daemon `/api/assets` MOUNT (publish/pull/tombstone routes).
 *
 * Verification posture: mount `mountAssetsGroup` onto a bare Hono over a RECORDING
 * fake {@link AssetSyncApi} engine, then drive it with `app.request`. The decisive
 * assertions: each route parses its body into the right request shape and delegates to
 * the engine; a missing/invalid body 400s (fail-closed); a Local-tier publish is rejected
 * (Local never reaches DeepLake); and the `defaultScope` backfills a body that omits org.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
	type AssetsApiDeps,
	ASSETS_GROUP,
	mountAssetsGroup,
} from "../../../../src/daemon/runtime/assets/api.js";
import type {
	AssetSyncApi,
	PublishRequest,
	PullRequest,
	TombstoneRequest,
} from "../../../../src/daemon/runtime/assets/contracts.js";

/** A recording fake engine: captures every request + replays canned responses. */
function createRecordingEngine(): {
	engine: AssetSyncApi;
	published: PublishRequest[];
	pulled: PullRequest[];
	tombstoned: TombstoneRequest[];
} {
	const published: PublishRequest[] = [];
	const pulled: PullRequest[] = [];
	const tombstoned: TombstoneRequest[] = [];
	const engine: AssetSyncApi = {
		async publish(req) {
			published.push(req);
			return { honeycombId: req.honeycombId, version: 1, published: true };
		},
		async pull(req) {
			pulled.push(req);
			return { assets: [], tableAbsent: false };
		},
		async tombstone(req) {
			tombstoned.push(req);
			return { honeycombId: req.honeycombId, version: 2, tombstoned: true };
		},
	};
	return { engine, published, pulled, tombstoned };
}

function build(deps: AssetsApiDeps): Hono {
	const root = new Hono();
	const group = new Hono();
	mountAssetsGroup(group, deps);
	root.route(ASSETS_GROUP, group);
	return root;
}

const PUBLISH_BODY = {
	honeycombId: "hc_aaaa0000aaaa0000aaaa0000aaaa0000",
	assetType: "skill",
	harness: "claude_code",
	native: "body",
	canonical: "body",
	contentHash: "h",
	cell: { tier: "Team", style: "Repository" },
	scope: { org: "acme", workspace: "backend", author: "alice", deviceId: "dev-1" },
	deviceSet: [],
};

describe("PRD-033c /api/assets mount", () => {
	it("POST /publish delegates a parsed PublishRequest to the engine", async () => {
		const { engine, published } = createRecordingEngine();
		const app = build({ engine });
		const res = await app.request(`${ASSETS_GROUP}/publish`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(PUBLISH_BODY),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { published: boolean };
		expect(body.published).toBe(true);
		expect(published).toHaveLength(1);
		expect(published[0].assetType).toBe("skill");
		expect(published[0].harness).toBe("claude_code");
		expect(published[0].cell.tier).toBe("Team");
		expect(published[0].scope.org).toBe("acme");
	});

	it("POST /publish rejects a Local-tier publish (Local never reaches DeepLake) → 400", async () => {
		const { engine, published } = createRecordingEngine();
		const app = build({ engine });
		const res = await app.request(`${ASSETS_GROUP}/publish`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...PUBLISH_BODY, cell: { tier: "Local", style: "Repository" } }),
		});
		expect(res.status).toBe(400);
		expect(published).toHaveLength(0);
	});

	it("POST /publish 400s a body missing required fields (fail-closed)", async () => {
		const { engine, published } = createRecordingEngine();
		const app = build({ engine });
		const res = await app.request(`${ASSETS_GROUP}/publish`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ honeycombId: "hc_x" }),
		});
		expect(res.status).toBe(400);
		expect(published).toHaveLength(0);
	});

	it("POST /pull delegates a parsed PullRequest; defaultScope backfills a missing org", async () => {
		const { engine, pulled } = createRecordingEngine();
		const app = build({ engine, defaultScope: { org: "local", workspace: "default" } });
		const res = await app.request(`${ASSETS_GROUP}/pull`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ scope: { author: "alice", deviceId: "dev-1" } }),
		});
		expect(res.status).toBe(200);
		expect(pulled).toHaveLength(1);
		expect(pulled[0].scope.org).toBe("local"); // backfilled from defaultScope
		expect(pulled[0].scope.author).toBe("alice");
	});

	it("POST /pull 400s when no org is resolvable and no default is set (fail-closed)", async () => {
		const { engine, pulled } = createRecordingEngine();
		const app = build({ engine });
		const res = await app.request(`${ASSETS_GROUP}/pull`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ scope: { author: "alice" } }),
		});
		expect(res.status).toBe(400);
		expect(pulled).toHaveLength(0);
	});

	it("POST /tombstone delegates a parsed TombstoneRequest to the engine", async () => {
		const { engine, tombstoned } = createRecordingEngine();
		const app = build({ engine });
		const res = await app.request(`${ASSETS_GROUP}/tombstone`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				honeycombId: PUBLISH_BODY.honeycombId,
				assetType: "skill",
				harness: "claude_code",
				cell: { tier: "Team", style: "Repository" },
				scope: PUBLISH_BODY.scope,
				deviceSet: [],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tombstoned: boolean };
		expect(body.tombstoned).toBe(true);
		expect(tombstoned).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD-033 SECURITY remediation — tenancy is AUTHENTICATED, never body-asserted.
// In team/hybrid the daemon stamps a validated Identity onto the context; the
// `/api/assets` handlers MUST take org/workspace/author from THAT, not the body.
// These tests stand in a stamping middleware (what the real permission middleware
// does) and prove a body-forged tenancy can never cross the token's own boundary.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_CONTEXT_KEY = "honeycombIdentity" as const;

/** Build the mount in team mode, stamping a fixed validated Identity (mirrors permission mw). */
function buildAuthed(deps: AssetsApiDeps, identity: Record<string, unknown>): Hono {
	const root = new Hono();
	const group = new Hono();
	group.use("*", async (c, next) => {
		c.set(IDENTITY_CONTEXT_KEY, identity);
		await next();
	});
	mountAssetsGroup(group, { ...deps, mode: "team" });
	root.route(ASSETS_GROUP, group);
	return root;
}

const TOKEN_IDENTITY = { org: "token-org", workspace: "token-ws", agentId: "token-actor", role: "write" };

describe("PRD-033 SECURITY: /api/assets tenancy is taken from the validated Identity (team/hybrid)", () => {
	it("publish OVERRIDES a body-forged org/workspace/author with the token's own (cross-tenant forge defeated)", async () => {
		const { engine, published } = createRecordingEngine();
		const app = buildAuthed({ engine }, TOKEN_IDENTITY);
		const res = await app.request(`${ASSETS_GROUP}/publish`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// The body LIES about workspace + author (it omits org so the request is not rejected
			// outright). The handler must IGNORE the body's workspace/author and use the token's.
			body: JSON.stringify({ ...PUBLISH_BODY, scope: { workspace: "victim-ws", author: "victim", deviceId: "dev-1" } }),
		});
		expect(res.status).toBe(200);
		expect(published).toHaveLength(1);
		// The published row carries the TOKEN's tenancy, never the forged body values.
		expect(published[0].scope.org).toBe("token-org");
		expect(published[0].scope.workspace).toBe("token-ws");
		expect(published[0].scope.author).toBe("token-actor");
	});

	it("publish 400s when the body org DISAGREES with the token org (fail-closed, no write)", async () => {
		const { engine, published } = createRecordingEngine();
		const app = buildAuthed({ engine }, TOKEN_IDENTITY);
		const res = await app.request(`${ASSETS_GROUP}/publish`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...PUBLISH_BODY, scope: { org: "another-org", workspace: "x", author: "y", deviceId: "z" } }),
		});
		expect(res.status).toBe(400);
		expect(published).toHaveLength(0);
	});

	it("pull is scoped to the token org/author, never a body-forged audience", async () => {
		const { engine, pulled } = createRecordingEngine();
		const app = buildAuthed({ engine }, TOKEN_IDENTITY);
		const res = await app.request(`${ASSETS_GROUP}/pull`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ scope: { author: "victim", deviceId: "dev-1" } }),
		});
		expect(res.status).toBe(200);
		expect(pulled).toHaveLength(1);
		expect(pulled[0].scope.org).toBe("token-org");
		expect(pulled[0].scope.author).toBe("token-actor");
	});

	it("tombstone is scoped to the token tenancy, never a body-forged one (no cross-tenant retract)", async () => {
		const { engine, tombstoned } = createRecordingEngine();
		const app = buildAuthed({ engine }, TOKEN_IDENTITY);
		const res = await app.request(`${ASSETS_GROUP}/tombstone`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				honeycombId: PUBLISH_BODY.honeycombId,
				assetType: "skill",
				harness: "claude_code",
				cell: { tier: "Team", style: "Repository" },
				scope: { workspace: "victim-ws", author: "victim", deviceId: "dev-1" },
				deviceSet: [],
			}),
		});
		expect(res.status).toBe(200);
		expect(tombstoned).toHaveLength(1);
		expect(tombstoned[0].scope.org).toBe("token-org");
		expect(tombstoned[0].scope.author).toBe("token-actor");
	});
});
