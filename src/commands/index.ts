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
	isSessionGroupPath,
	mintCliSessionId,
	type DaemonRequest,
	type DaemonResponse,
	DEFAULT_GLOBAL_FLAGS,
	type FakeDaemonClient,
	type FakeDaemonClientOptions,
	type GlobalFlags,
	isAuthPassthrough,
	isStorageVerb,
	lookupVerb,
	notImplemented,
	type OutputSink,
	type RecordedDaemonCall,
	type VerbClass,
	type VerbSpec,
	VERB_TABLE,
} from "./contracts.js";

export { createDispatcher, dispatch, parseInvocation, usageText } from "./dispatch.js";

export {
	buildPruneRequest,
	parseSessionsArgs,
	runSessionsCommand,
	SESSIONS_LIST_ROUTE,
	SESSIONS_PRUNE_ROUTE,
	type SessionsInvocation,
} from "./sessions.js";

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

export {
	POLLINATE_ENDPOINT,
	type PollinateCliInvocation,
	parsePollinateCliArgs,
	runPollinateVerb,
} from "./pollinate.js";

export {
	MAINTENANCE_COMPACT_ENDPOINT,
	type MaintenanceCliInvocation,
	parseMaintenanceCliArgs,
	runMaintenanceVerb,
} from "./maintenance.js";

export {
	coerceSettingValue,
	parseSettingsCliArgs,
	runSettingsVerb,
	SETTINGS_ENDPOINT,
	type SettingsCliInvocation,
	type SettingValue,
} from "./settings.js";

export {
	ASSETS_ENDPOINT,
	type AssetCliDeps,
	type AssetCliInvocation,
	parseAssetCliArgs,
	runAssetVerb,
} from "./asset.js";

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
} from "./local-handlers.js";

export {
	type DaemonLifecycle,
	type DaemonStatus,
	type DaemonVerbDeps,
	ensureDaemonRunning,
	parseDaemonArgs,
	runDaemonCommand,
} from "./daemon.js";

export {
	DASHBOARD_LOCAL_HOST,
	DASHBOARD_PATH,
	type DashboardOpener,
	type InstallVerbDeps,
	localDashboardUrl,
	loopbackDashboardUrl,
	openLocalDashboardUrl,
	parseRefArg,
	resolveEffectiveRef,
	runInstallCommand,
} from "./install.js";

export { type TelemetryVerbDeps, runTelemetryCommand } from "./telemetry.js";
