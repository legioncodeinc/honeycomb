/**
 * The dashboard orchestrator — PRD-020b (FR-1 / FR-7 / FR-8 / b-AC-1 / b-AC-2 / D-6).
 *
 * `renderDashboard(source)` is the single entry both surfaces call (the daemon-served
 * dashboard and the Cursor webview, D-6): probe connectivity → if unreachable, return the
 * clear connectivity banner (b-AC-2, no hang/blank) → else fetch the full
 * {@link DashboardData} through the seam and build every view (b-AC-1). It is a THIN CLIENT:
 * the data comes through the {@link DashboardDataSource} seam, never DeepLake.
 *
 * ── STABLE RENDER CONTRACT (D-6 — 020c embeds this) ──────────────────────────
 *   `renderDashboard(source: DashboardDataSource): Promise<RenderedDashboard>` and the
 *   `RenderedDashboard` shape are FROZEN. 020c's `DashboardWebviewRenderer` calls THIS and
 *   paints `result.views` (the same `ViewBlock[]`). The order of the six views in `views`
 *   when reachable is part of the contract: KPIs, sessions, settings, graph, rules, skill-sync.
 */

import {
	type Connectivity,
	type DashboardDataSource,
} from "./contracts.js";
import {
	buildGraphView,
	buildKpisView,
	buildRulesView,
	buildSessionsView,
	buildSettingsView,
	buildSkillSyncView,
	type ViewBlock,
} from "./views.js";

/**
 * The rendered dashboard: the connectivity state + (when reachable) the six built views.
 * When `connectivity.reachable` is false, `views` is the connectivity banner ONLY (b-AC-2).
 */
export interface RenderedDashboard {
	/** The connectivity state (FR-8 / b-AC-2). */
	readonly connectivity: Connectivity;
	/** The built view blocks (the six views when reachable; the banner when not). */
	readonly views: readonly ViewBlock[];
}

/**
 * Build the daemon-down connectivity banner (FR-8 / b-AC-2). A clear `kind: "connectivity"`
 * block carrying the daemon URL + a retry affordance — NOT a blank panel and NOT a hang. The
 * caller returns this ALONE when the probe is unreachable. STABLE so 020c shows the same banner.
 */
export function buildConnectivityBanner(connectivity: Connectivity): ViewBlock {
	if (connectivity.reachable) {
		return { kind: "connectivity", title: "Daemon connected", rows: [connectivity.url], data: connectivity };
	}
	const rows = [
		`Cannot reach the daemon at ${connectivity.url}.`,
		...(connectivity.detail !== undefined ? [connectivity.detail] : []),
		"Retry: ensure the daemon is running, then reload.",
	];
	return { kind: "connectivity", title: "Daemon unreachable", rows, data: connectivity };
}

/**
 * Render the dashboard (FR-1 / FR-7 / FR-8). `source.probe()` → branch on connectivity:
 * unreachable → the banner ALONE (b-AC-2, never hang/blank); reachable → `source.fetchAll()`
 * → build KPIs / sessions / settings / graph / rules / skill-sync in that order (b-AC-1).
 * The SAME function drives both the daemon dashboard and the Cursor webview (D-6).
 */
export async function renderDashboard(source: DashboardDataSource): Promise<RenderedDashboard> {
	const connectivity = await source.probe();
	if (!connectivity.reachable) {
		// b-AC-2: a clear connectivity state — the banner ONLY. We do NOT call fetchAll()
		// while the daemon is down (no hang, no blank panels behind a spinner).
		return { connectivity, views: [buildConnectivityBanner(connectivity)] };
	}
	const data = await source.fetchAll();
	const views: ViewBlock[] = [
		buildKpisView(data.kpis),
		buildSessionsView(data.sessions),
		buildSettingsView(data.settings),
		buildGraphView(data.graph),
		buildRulesView(data.rules),
		buildSkillSyncView(data.skillSync),
	];
	return { connectivity, views };
}
