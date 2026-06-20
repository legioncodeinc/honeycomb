/**
 * PRD-022c `/api/goals` — c-AC-1 (goal add → upsert + read) + c-AC-6 (zod + tenancy).
 *
 * Verification posture (mirrors the dashboard/sources suites): mount `mountGoalsApi` onto a
 * real `Daemon`-shaped object whose `group()` returns a bare Hono router, drive it with
 * `app.request`, and back it with an IN-MEMORY storage fake that honours the
 * `updateOrInsertByKey` semantics (SELECT-by-key → UPDATE if present else INSERT) so the
 * upsert + read-back is proven without a live backend.
 */

import { describe, expect, it } from "vitest";

import type { Daemon } from "../../../../src/daemon/runtime/server.js";
import { mountGoalsApi, GOALS_GROUP } from "../../../../src/daemon/runtime/goals/api.js";
import { makeKeyedDaemon } from "../product/_keyed-harness.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend", "content-type": "application/json" };

function buildApp() {
	const { daemon, table } = makeKeyedDaemon("goals", GOALS_GROUP);
	// Mount the handlers onto the live-bound group BEFORE issuing requests.
	mountGoalsApi(daemon as unknown as Daemon, { storage: daemon.storage });
	return { app: daemon.app, table };
}

describe("PRD-022c /api/goals", () => {
	it("c-AC-1 POST /api/goals lands the goal via update-or-insert-by-key, GET returns it", async () => {
		const { app, table } = buildApp();

		const post = await app.request("/api/goals", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ key: "ship-022", value: "wire the data API", target: "2026-07", unit: "" }),
		});
		expect(post.status).toBe(201);
		const posted = (await post.json()) as { ok: boolean; goal: { key: string; value: string } };
		expect(posted.ok).toBe(true);
		expect(posted.goal.key).toBe("ship-022");

		// Exactly one row landed for the key.
		expect(table.rows.filter((r) => r.key === "ship-022")).toHaveLength(1);

		const get = await app.request("/api/goals", { headers: HEADERS });
		expect(get.status).toBe(200);
		const body = (await get.json()) as { goals: Array<{ key: string; value: string }> };
		const found = body.goals.find((g) => g.key === "ship-022");
		expect(found?.value).toBe("wire the data API");
	});

	it("c-AC-6 a malformed body (missing key) is rejected with 400 at the edge, no row written", async () => {
		const { app, table } = buildApp();
		const res = await app.request("/api/goals", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ value: "no key here" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("bad_request");
		expect(table.rows).toHaveLength(0);
	});

	it("c-AC-6 a request with no x-honeycomb-org is rejected fail-closed (400), never a broad write", async () => {
		const { app, table } = buildApp();
		const res = await app.request("/api/goals", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "k", value: "v" }),
		});
		expect(res.status).toBe(400);
		expect(table.rows).toHaveLength(0);

		const get = await app.request("/api/goals", {});
		expect(get.status).toBe(400);
	});

	it("c-AC-6 an over-shaped body (unknown field) is rejected by the strict schema", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/goals", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ key: "k", value: "v", agent_id: "root", visibility: "global" }),
		});
		expect(res.status).toBe(400);
	});
});
