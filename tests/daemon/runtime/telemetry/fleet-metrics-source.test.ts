/**
 * PRD-071b (AC-071b.2.1) — the production {@link createDashboardMetricsSource} adapter.
 *
 * Proves `memoryCount` comes from the SAME `fetchKpiCounts` query the dashboard's KPI band reads,
 * and `actionsTakenTotal` is a single guarded `COUNT(*)` over `roi_metrics` — against a lightweight
 * fake {@link StorageQuery} (no real DeepLake, no transport). No hand-rolled SQL string comparison:
 * this asserts on the RESOLVED totals, which is what `metrics.ts` actually consumes.
 */

import { describe, expect, it } from "vitest";
import { createDashboardMetricsSource } from "../../../../src/daemon/runtime/telemetry/fleet-metrics-source.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, queryError } from "../../../../src/daemon/storage/result.js";

const SCOPE: QueryScope = { org: "acme", workspace: "default" };

/** A minimal SQL-aware fake: routes on a substring of the statement. */
function fakeStorage(routes: ReadonlyArray<{ match: string; result: QueryResult }>): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			const route = routes.find((r) => sql.includes(r.match));
			if (route === undefined) throw new Error(`unexpected SQL in test fake: ${sql}`);
			return route.result;
		},
	};
}

describe("PRD-071b: createDashboardMetricsSource", () => {
	it("AC-071b.2.1 maps memoryCount from fetchKpiCounts and actionsTakenTotal from COUNT(*) roi_metrics", async () => {
		const storage = fakeStorage([
			{ match: `"memories"`, result: ok([{ n: 37 }], 1) },
			{ match: `"sessions"`, result: ok([{ n: 12 }], 1) },
			{ match: "synced_assets", result: ok([{ n: 0 }], 1) },
			{ match: "roi_metrics", result: ok([{ n: 9 }], 1) },
		]);
		const source = createDashboardMetricsSource(storage, SCOPE);
		const totals = await source.fetchTotals();
		expect(totals).toEqual({ memoryCount: 37, actionsTakenTotal: 9 });
	});

	it("fail-soft: a missing roi_metrics table degrades actionsTakenTotal to 0, never throws", async () => {
		const storage = fakeStorage([
			{ match: `"memories"`, result: ok([{ n: 5 }], 1) },
			{ match: `"sessions"`, result: ok([{ n: 5 }], 1) },
			{ match: "synced_assets", result: ok([{ n: 0 }], 1) },
			{ match: "roi_metrics", result: queryError('relation "roi_metrics" does not exist') },
		]);
		const source = createDashboardMetricsSource(storage, SCOPE);
		await expect(source.fetchTotals()).resolves.toEqual({ memoryCount: 5, actionsTakenTotal: 0 });
	});

	it("fail-soft: a thrown storage error degrades actionsTakenTotal to 0, never throws", async () => {
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				if (sql.includes("roi_metrics")) throw new Error("connection reset");
				if (sql.includes(`"memories"`)) return ok([{ n: 3 }], 1);
				if (sql.includes(`"sessions"`)) return ok([{ n: 3 }], 1);
				return ok([{ n: 0 }], 1);
			},
		};
		const source = createDashboardMetricsSource(storage, SCOPE);
		await expect(source.fetchTotals()).resolves.toEqual({ memoryCount: 3, actionsTakenTotal: 0 });
	});
});
