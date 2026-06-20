/**
 * Daemon-served dashboard barrel — PRD-020b (the canonical view-data layer, D-6).
 *
 * The public surface: the {@link DashboardData} view-model contract (the six view-models),
 * the {@link DashboardDataSource} seam + {@link createFakeDashboardDataSource} fake, the
 * {@link Connectivity} state, the pure view-builders ({@link ViewBlock} render tree), and the
 * {@link renderDashboard} orchestrator. This is the CANONICAL view layer the Cursor extension
 * webview (020c) embeds — both surfaces read the SAME data contract (D-6). Wave 1 is contracts
 * + honest stubs; Wave 2 fills the builders + the daemon-side `mountDashboardApi` endpoints
 * (scaffolded in `src/daemon/`). See CONVENTIONS.md before filling.
 */

export {
	type Connectivity,
	createFakeDashboardDataSource,
	type DashboardData,
	type DashboardDataSource,
	EMPTY_DASHBOARD_DATA,
	type FakeDashboardDataSourceOptions,
	type GraphEdge,
	type GraphNode,
	type GraphView,
	type KpisView,
	notImplemented,
	reachable,
	type RuleRow,
	type RulesView,
	type SessionRow,
	type SessionsView,
	type SettingsView,
	type SkillSyncRow,
	type SkillSyncView,
	unreachable,
} from "./contracts.js";

export {
	buildGraphView,
	buildKpisView,
	buildRulesView,
	buildSessionsView,
	buildSettingsView,
	buildSkillSyncView,
	GRAPH_BUILD_PROMPT,
	type ViewBlock,
} from "./views.js";

export {
	buildConnectivityBanner,
	renderDashboard,
	type RenderedDashboard,
} from "./dashboard.js";

export {
	createDaemonDashboardDataSource,
	daemonBaseUrl,
	DASHBOARD_HOST_PATH,
	type FetchLike,
	launchDashboard,
	type LaunchDashboardOptions,
	openDashboard,
	type OpenDashboardResult,
} from "./launch.js";

// ── PRD-021d: the viewable-host HTML serializer + the live-log follow-client (d-AC-3 / d-AC-4)
export { escapePageHtml, LIVE_LOG_SLOT_ID, renderDashboardPage } from "./html.js";

export {
	buildLiveLogPanel,
	type FollowLogsOptions,
	followLogs,
	formatLogLine,
	LIVE_LOG_EMPTY,
	type LogRecord,
	parseLogFrame,
	type StreamFetchLike,
} from "./logs.js";
