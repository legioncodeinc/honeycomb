/**
 * ISS-011 — the REAL ROI trend (`parseTrendRange` + `assembleRoiTrend` + `fetchRoiTrendView`).
 *
 * Proves, deterministically (injected `now`, no live DeepLake):
 *   - the range parser maps 7d/30d/90d and defaults everything else to 30;
 *   - `assembleRoiTrend` buckets by `created_at.slice(0,10)` IN TS (never SQL GROUP BY),
 *     ZERO-FILLS every day of the window oldest→newest, drops rows outside the cutoff,
 *     takes `startedAt` from the PRE-CUTOFF minimum, and labels exactly two series
 *     `measured-savings` (solid) / `modeled-savings` (dashed est.) — the labels the page's
 *     seriesColor heuristics key off;
 *   - `fetchRoiTrendView` degrades to `EMPTY_ROI_TREND` on a missing ledger / zero rows and
 *     serves a real `ok` trend over the fake transport when rows exist.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	assembleRoiTrend,
	fetchRoiTrendView,
	parseTrendRange,
} from "../../../../src/daemon/runtime/dashboard/api.js";
import { EMPTY_ROI_TREND } from "../../../../src/dashboard/contracts.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "o1", workspace: "ws1" };
const NOW = new Date("2026-07-12T12:00:00.000Z");

/** A ledger row shaped like a canonical roi_metrics read (only the columns the trend folds). */
function row(createdAt: string, measured: number, modeled: number): StorageRow {
	return {
		id: `r-${createdAt}-${measured}-${modeled}`,
		session_id: `s-${createdAt}`,
		created_at: createdAt,
		measured_cache_savings_cents: measured,
		modeled_savings_cents: modeled,
	};
}

describe("ISS-011 parseTrendRange", () => {
	it("maps 7d/30d/90d to their day counts and defaults everything else to 30", () => {
		expect(parseTrendRange("7d")).toBe(7);
		expect(parseTrendRange("30d")).toBe(30);
		expect(parseTrendRange("90d")).toBe(90);
		expect(parseTrendRange("")).toBe(30);
		expect(parseTrendRange("1y")).toBe(30);
		expect(parseTrendRange("garbage")).toBe(30);
	});
});

describe("ISS-011 assembleRoiTrend — pure bucketing, zero-fill, cutoff, startedAt, labels", () => {
	it("buckets by day IN TS and zero-fills EVERY day of the window oldest→newest", () => {
		const view = assembleRoiTrend(
			[
				row("2026-07-12T01:00:00.000Z", 100, 10),
				row("2026-07-12T09:00:00.000Z", 50, 5), // same day → summed into one bucket.
				row("2026-07-10T00:30:00.000Z", 30, 3),
			],
			7,
			NOW,
		);
		expect(view.status).toBe("ok");
		expect(view.series).toHaveLength(2);
		const measured = view.series[0]!;
		const modeled = view.series[1]!;
		// The window is the last 7 UTC calendar days ending today, oldest first, every day present.
		const periods = measured.points.map((p) => p.period);
		expect(periods).toEqual([
			"2026-07-06",
			"2026-07-07",
			"2026-07-08",
			"2026-07-09",
			"2026-07-10",
			"2026-07-11",
			"2026-07-12",
		]);
		expect(modeled.points.map((p) => p.period)).toEqual(periods);
		// Same-day rows SUM; silent days are ZERO, never interpolated / omitted.
		expect(measured.points.map((p) => p.cents)).toEqual([0, 0, 0, 0, 30, 0, 150]);
		expect(modeled.points.map((p) => p.cents)).toEqual([0, 0, 0, 0, 3, 0, 15]);
	});

	it("drops rows OUTSIDE the window from the series but keeps them in startedAt (pre-cutoff minimum)", () => {
		const view = assembleRoiTrend(
			[
				row("2026-05-01T00:00:00.000Z", 999, 99), // far outside a 7d window.
				row("2026-07-12T00:00:00.000Z", 20, 2),
			],
			7,
			NOW,
		);
		// The old row never leaks into a bucket…
		const measured = view.series[0]!;
		expect(measured.points.reduce((sum, p) => sum + p.cents, 0)).toBe(20);
		// …but it IS the tracking origin: startedAt is the min created_at across ALL rows.
		expect(view.startedAt).toBe("2026-05-01T00:00:00.000Z");
	});

	it("labels the two series exactly measured-savings (modeled:false) and modeled-savings (modeled:true)", () => {
		const view = assembleRoiTrend([row("2026-07-12T00:00:00.000Z", 1, 1)], 7, NOW);
		// LOAD-BEARING: the page's seriesColor heuristics key off these labels (no net/infra/cost substring).
		expect(view.series.map((s) => s.label)).toEqual(["measured-savings", "modeled-savings"]);
		expect(view.series.map((s) => s.modeled)).toEqual([false, true]);
		for (const s of view.series) {
			expect(s.label).not.toMatch(/net|infra|cost/);
		}
	});

	it("money stays INTEGER cents at every point (a stringy/float cell is rounded, never NaN)", () => {
		const view = assembleRoiTrend(
			[
				{ ...row("2026-07-12T00:00:00.000Z", 0, 0), measured_cache_savings_cents: "12", modeled_savings_cents: 3.4 },
			],
			7,
			NOW,
		);
		const today = view.series[0]!.points.at(-1)!;
		expect(today.cents).toBe(12);
		const todayModeled = view.series[1]!.points.at(-1)!;
		expect(Number.isInteger(todayModeled.cents)).toBe(true);
	});

	it("clamps a degenerate window to at least one day", () => {
		const view = assembleRoiTrend([row("2026-07-12T00:00:00.000Z", 5, 0)], 0, NOW);
		expect(view.series[0]!.points).toHaveLength(1);
		expect(view.series[0]!.points[0]!.period).toBe("2026-07-12");
	});
});

describe("ISS-011 fetchRoiTrendView — the ledger-backed read (fail-soft, honest-empty)", () => {
	function client(responder: (req: TransportRequest) => Record<string, unknown>[]) {
		const fake = new FakeDeepLakeTransport(responder);
		return { storage: createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) }), fake };
	}

	it("a ledger with rows serves a REAL ok trend (series populated, startedAt stamped)", async () => {
		const todayIso = new Date().toISOString();
		const { storage } = client((req) =>
			/FROM\s+"roi_metrics"/i.test(req.sql)
				? [
						{
							id: "r1",
							session_id: "s1",
							created_at: todayIso,
							measured_cache_savings_cents: 40,
							modeled_savings_cents: 4,
						},
					]
				: [],
		);
		const view = await fetchRoiTrendView(storage, SCOPE, "7d", { readPolicy: "shared" });
		expect(view.status).toBe("ok");
		expect(view.startedAt).toBe(todayIso);
		expect(view.series.map((s) => s.label)).toEqual(["measured-savings", "modeled-savings"]);
		// Today's bucket carries the row; the window is 7 zero-filled days.
		const measured = view.series[0]!;
		expect(measured.points).toHaveLength(7);
		expect(measured.points.at(-1)!.cents).toBe(40);
	});

	it("an EMPTY ledger (no rows) degrades to EMPTY_ROI_TREND — never a fabricated flat line", async () => {
		const { storage } = client(() => []);
		const view = await fetchRoiTrendView(storage, SCOPE, "30d", { readPolicy: "shared" });
		expect(view).toEqual(EMPTY_ROI_TREND);
	});

	it("a MISSING ledger table (query error) degrades to EMPTY_ROI_TREND — fail-soft, never a throw", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError('relation "roi_metrics" does not exist', 404);
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const view = await fetchRoiTrendView(storage, SCOPE, "30d", { readPolicy: "shared" });
		expect(view).toEqual(EMPTY_ROI_TREND);
	});

	it("resolves the scope like fetchRoiView: an isolated read with NO agent fails closed (empty → honest-empty trend)", async () => {
		// The guarded-false predicate returns no rows → the trend stays honest-empty, and the SQL is
		// NEVER pinned to the org id (the isolated-agentid finding).
		const { storage, fake } = client(() => []);
		const view = await fetchRoiTrendView(storage, SCOPE, "30d", { readPolicy: "isolated" });
		expect(view).toEqual(EMPTY_ROI_TREND);
		const ledgerSql = fake.requests.find((r) => /FROM\s+"roi_metrics"/i.test(r.sql))?.sql ?? "";
		expect(ledgerSql).not.toContain("'o1'");
		expect(ledgerSql).toContain("('1' = '0')"); // fail-closed guarded-false, not an org filter.
	});

	it("narrows to the selected project when one is threaded (the 049e conjunct)", async () => {
		const { storage, fake } = client(() => []);
		await fetchRoiTrendView(storage, SCOPE, "30d", { readPolicy: "shared", projectId: "proj-web" });
		const ledgerSql = fake.requests.find((r) => /FROM\s+"roi_metrics"/i.test(r.sql))?.sql ?? "";
		expect(ledgerSql).toMatch(/project_id = 'proj-web'/);
	});
});
