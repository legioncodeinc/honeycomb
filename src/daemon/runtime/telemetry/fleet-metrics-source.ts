/**
 * The production {@link MetricsSource} — PRD-071b (AC-071b.2.1): reads the fleet metrics totals
 * from honeycomb's EXISTING dashboard counters, through the storage seam, without recomputation.
 *
 * `memoryCount` reuses `fetchKpiCounts` verbatim (the SAME query the dashboard's KPI band reads).
 * `actionsTakenTotal` is a single guarded `COUNT(*)` over `roi_metrics` — the ROI ledger's
 * append-only action log (`roi-ledger.ts`) — scoped the same way every other storage read in this
 * daemon is (`storage.query(sql, scope)`, branch via `isOk`, `sqlIdent` for the identifier). This
 * file is the ONLY place `metrics.ts` touches storage, keeping `metrics.ts` itself storage-free and
 * unit-testable against a fake {@link MetricsSource}.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import { fetchKpiCounts } from "../dashboard/api.js";
import type { MetricsSource, MetricsTotals } from "./metrics.js";

/** Fail-soft `COUNT(*) FROM roi_metrics` — 0 on any error or missing table, never a throw. */
async function countRoiMetricsRows(storage: StorageQuery, scope: QueryScope): Promise<number> {
	try {
		const tbl = sqlIdent("roi_metrics");
		const res = await storage.query(`SELECT COUNT(*) AS n FROM "${tbl}"`, scope);
		if (!isOk(res)) return 0;
		const raw = res.rows[0]?.n;
		const n = typeof raw === "number" ? raw : typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

/** Build the real {@link MetricsSource} over the daemon's live storage client + resolved scope. */
export function createDashboardMetricsSource(storage: StorageQuery, scope: QueryScope): MetricsSource {
	return {
		async fetchTotals(): Promise<MetricsTotals> {
			const [kpiCounts, actionsTakenTotal] = await Promise.all([
				fetchKpiCounts(storage, scope),
				countRoiMetricsRows(storage, scope),
			]);
			return { memoryCount: kpiCounts.memoryCount, actionsTakenTotal };
		},
	};
}
