/**
 * The auto-update engine (PRD-064e) public surface.
 *
 * One barrel so a later wave (064f CLI / the supervisor wiring) imports the engine, the
 * poll loop, the gate, and the version source from a single path. Everything here is
 * additive and self-contained: it imports install-lock + telemetry + the command-runner
 * boundary as read-only collaborators and touches no shipped daemon code.
 */

export {
	fetchBlessedVersion,
	parseBlessedManifest,
	DEFAULT_BLESSED_URL,
	DEFAULT_BLESSED_TIMEOUT_MS,
	type BlessedManifest,
	type BlessedFetch,
	type BlessedFetchResult,
	type BlessedFailReason,
	type BlessedChannelOptions,
} from "./blessed-channel.js";

export {
	createRegistryLatestReader,
	parseLatestVersion,
	defaultLatestUrl,
	DEFAULT_REGISTRY_TIMEOUT_MS,
	type ReadLatestVersionFn,
	type RegistryFetch,
	type RegistryReaderOptions,
} from "./registry.js";

export {
	createInstalledPackageVersionReader,
	parseInstalledVersion,
	type InstalledPackageReaderOptions,
} from "./installed-version.js";

export {
	decideUpdate,
	type UpdateDecision,
	type UpdateDecisionInput,
	type UpdateOptOut,
	type NoUpdateReason,
} from "./update-policy.js";

export {
	createUpdateEngine,
	outcomeOf,
	PRIMARY_PACKAGE,
	type UpdateEngine,
	type UpdateEngineDeps,
	type UpdatePreview,
	type UpdateTransactionResult,
	type UpdateTransactionStatus,
	type ReadInstalledVersionFn,
	type RestartDaemonFn,
	type VerifyHealthyFn,
} from "./update-engine.js";

export {
	createDefaultUpdateEmit,
	type UpdateEmit,
	type UpdateOutcome,
	type UpdateTelemetryEvent,
} from "./update-telemetry.js";

export {
	createUpdatePollLoop,
	jitteredDelay,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_JITTER_FRACTION,
	type UpdatePollLoop,
	type UpdatePollLoopDeps,
	type PollClock,
} from "./poll-loop.js";

export {
	parseVersion,
	compareParsed,
	isStrictlyNewer,
	isSameVersion,
	type ParsedVersion,
} from "./version.js";
