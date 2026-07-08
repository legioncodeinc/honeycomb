/**
 * Unified CLI command surface barrel — PRD-020a (the dispatcher + handlers).
 *
 * The public surface: the {@link CommandDispatcher} contract + {@link createDispatcher}, the
 * merged {@link VERB_TABLE} + {@link AUTH_SUBCOMMANDS}, the {@link DaemonClient} seam +
 * {@link createFakeDaemonClient} fake + the real {@link createLoopbackDaemonClient}, the
 * {@link AuthPassthrough} seam, and the per-group handlers (storage / sessions / status / local).
 * Wave 2 fills the handler bodies; the bin rewire onto {@link createDispatcher} is deferred
 * assembly (D-7). See CONVENTIONS.md.
 */

export {
	ASSETS_ENDPOINT,
	type AssetCliDeps,
	type AssetCliInvocation,
	parseAssetCliArgs,
	runAssetVerb,
} from "./asset.js";
export {
	AUTH_SUBCOMMANDS,
	type AuthPassthrough,
	CLI_RUNTIME_PATH,
	type CommandDeps,
	type CommandDispatcher,
	type CommandInvocation,
	type CommandResult,
	createFakeDaemonClient,
	createLoopbackDaemonClient,
	type DaemonClient,
	type DaemonRequest,
	type DaemonResponse,
	DEFAULT_GLOBAL_FLAGS,
	type FakeDaemonClient,
	type FakeDaemonClientOptions,
	type GlobalFlags,
	isAuthPassthrough,
	isSessionGroupPath,
	isStorageVerb,
	lookupVerb,
	mintCliSessionId,
	notImplemented,
	type OutputSink,
	type RecordedDaemonCall,
	VERB_GROUPS,
	VERB_TABLE,
	type VerbClass,
	type VerbGroup,
	type VerbSpec,
} from "./contracts.js";
export {
	type DaemonLifecycle,
	type DaemonStatus,
	type DaemonVerbDeps,
	ensureDaemonRunning,
	parseDaemonArgs,
	runDaemonCommand,
} from "./daemon.js";
export { createDispatcher, dispatch, parseInvocation, usageText } from "./dispatch.js";
export {
	CONNECT_STATUSES,
	type ConnectSeamResult,
	type ConnectStatus,
	connectStatusLine,
	type HarnessConnectionState,
	type HarnessStatusRunner,
	type RepairResult,
	runHarnessVerb,
} from "./harness-status.js";
export {
	DASHBOARD_PATH,
	DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE,
	type DashboardOpener,
	type DashboardProbe,
	dashboardPortalNotRunningMessage,
	type InstallVerbDeps,
	loopbackDashboardUrl,
	openLocalDashboardUrl,
	parseRefArg,
	probeLoopbackDashboard,
	resolveEffectiveRef,
	runInstallCommand,
} from "./install.js";
export {
	type ConnectorRunner,
	type ConnectorVerbArgs,
	type ConnectorVerbResult,
	type DashboardLauncher,
	type LocalDeps,
	runConnectorVerb,
	runDashboardCommand,
	runHookCommand,
	runUpdateCommand,
	type UninstallLifecycleSteps,
} from "./local-handlers.js";

export {
	MAINTENANCE_COMPACT_ENDPOINT,
	type MaintenanceCliInvocation,
	parseMaintenanceCliArgs,
	runMaintenanceVerb,
} from "./maintenance.js";

export {
	MEMORY_CONFLICT_VERDICTS,
	MEMORY_CONFLICTS_LIST_ROUTE,
	MEMORY_CONFLICTS_RESOLVE_ROUTE,
	MEMORY_STALE_REFS_ROUTE,
	type MemoryCliInvocation,
	type MemoryConflictVerdict,
	parseMemoryCliArgs,
	runMemoryVerb,
} from "./memory.js";
export {
	POLLINATE_ENDPOINT,
	type PollinateCliInvocation,
	parsePollinateCliArgs,
	runPollinateVerb,
} from "./pollinate.js";
export {
	buildPruneRequest,
	parseSessionsArgs,
	runSessionsCommand,
	SESSIONS_LIST_ROUTE,
	SESSIONS_PRUNE_ROUTE,
	type SessionsInvocation,
} from "./sessions.js";
export {
	coerceSettingValue,
	parseSettingsCliArgs,
	runSettingsVerb,
	SETTINGS_ENDPOINT,
	type SettingsCliInvocation,
	type SettingValue,
} from "./settings.js";
export {
	type DriftHealOutcome,
	type HealthCheckLike,
	healthSourceFromCheck,
	type OrgDriftHealer,
	runStatusCommand,
	type StatusDeps,
	type StatusHealthLine,
	type StatusHealthSource,
} from "./status.js";
export {
	buildStorageRequest,
	parseSkillId,
	runStorageVerb,
	STORAGE_VERB_ROUTES,
} from "./storage-handlers.js";

export { runTelemetryCommand, type TelemetryVerbDeps } from "./telemetry.js";
