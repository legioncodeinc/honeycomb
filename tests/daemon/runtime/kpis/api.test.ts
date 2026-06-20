/**
 * PRD-022c `/api/kpis` — c-AC-2 (existing key UPDATES, never a duplicate) + c-AC-6.
 *
 * The headline is c-AC-2: POSTing the SAME key twice yields ONE row (the second add UPDATES
 * the first), proven against the in-memory `updateOrInsertByKey` fake.
 */

import { describe, expect, it } from "vitest";

import type { Daemon } from "../../../../src/daemon/runtime/server.js";
import { mountKpisApi, KPIS_GROUP } from "../../../../src/daemon/runtime/kpis/api.js";
import { makeKeyedDaemon } from "../product/_keyed-harness.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend", "content-type": "application/json" };

function buildApp() {
	const { daemon, table } = makeKeyedDaemon("kpis", KPIS_GROUP);
	mountKpisApi(daemon as unknown as Daemon, { storage: daemon.storage });
	return { app: daemon.app, table };
}

describe("PRD-022c /api/kpis", () => {
	it("c-AC-2 POSTing the same key twice UPDATES the existing KPI rather than inserting a duplicate", async () => {
		const { app, table } = buildApp();

		const first = await app.request("/api/kpis", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ key: "p95-latency", value: "320", unit: "ms" }),
		});
		expect(first.status).toBe(201);

		const second = await app.request("/api/kpis", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ key: "p95-latency", value: "180", unit: "ms" }),
		});
		expect(second.status).toBe(201);

		// EXACTLY one row for the key — the second add updated, not duplicated.
		const matching = table.rows.filter((r) => r.key === "p95-latency");
		expect(matching).toHaveLength(1);
		expect(matching[0]?.value).toBe("180");

		// The read reflects the updated value.
		const get = await app.request("/api/kpis", { headers: HEADERS });
		const body = (await get.json()) as { kpis: Array<{ key: string; value: string }> };
		const found = body.kpis.find((k) => k.key === "p95-latency");
		expect(found?.value).toBe("180");
	});

	it("c-AC-1/c-AC-2 distinct keys produce distinct rows (no accidental merge)", async () => {
		const { app, table } = buildApp();
		for (const k of ["a", "b", "c"]) {
			await app.request("/api/kpis", {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ key: k, value: k.toUpperCase() }),
			});
		}
		expect(table.rows).toHaveLength(3);
	});

	it("c-AC-6 malformed body + missing org are both rejected at the edge", async () => {
		const { app, table } = buildApp();
		const bad = await app.request("/api/kpis", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ value: "no key" }),
		});
		expect(bad.status).toBe(400);

		const noOrg = await app.request("/api/kpis", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "k", value: "v" }),
		});
		expect(noOrg.status).toBe(400);
		expect(table.rows).toHaveLength(0);
	});
});
