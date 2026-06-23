/**
 * Pollinating-loop barrel — the public surface the daemon assembly + tests import from
 * one place instead of reaching into each module.
 *
 * The pollinating loop (PRD-009) is: the token-budget {@link createPollinatingTrigger}
 * (counter + single-pending guard + enqueue), the pass-lifecycle
 * {@link createPollinatingRunner} harness, the two payload strategies
 * ({@link createIncrementalStrategy} / {@link createCompactionStrategy} + the
 * mode-selection helpers), the resolved {@link resolvePollinatingConfig} knobs, the
 * cross-module {@link PollinatingJobPayload} contracts, and — PRD-026 — the
 * daemon-resident {@link createPollinatingWorker} that leases `["pollinating"]` jobs and
 * runs the runner. The HTTP "Pollinate now" trigger ({@link mountPollinateApi}) is exported
 * too so the composition root attaches it alongside the worker.
 *
 * ── The worker is the PRD-026 consumer ───────────────────────────────────────
 * Before PRD-026 nothing in the live daemon consumed a `pollinating` job: the trigger
 * enqueued and the runner could run, but no harness leased + invoked it. The worker
 * is that harness. The Wave-1c daemon-assembly bee constructs AND starts it ONLY when
 * `resolvePollinatingConfig().enabled` (default OFF) and stops it in teardown.
 */

export {
	resolvePollinatingConfig,
	envPollinatingConfigProvider,
	PollinatingConfigSchema,
	PollinatingConfigError,
	DEFAULT_TOKEN_THRESHOLD,
	DEFAULT_MAX_INPUT_TOKENS,
	type PollinatingConfig,
	type PollinatingConfigProvider,
	type RawPollinatingConfig,
} from "./config.js";

export {
	POLLINATING_JOB_KIND,
	POLLINATING_PASS_MODES,
	POLLINATING_MUTATION_KINDS,
	MUTATION_KIND_TO_OPERATION,
	PollinatingJobPayloadSchema,
	PollinatingMutationSchema,
	PollinatingMutationSetSchema,
	parsePollinatingJobPayload,
	parsePollinatingMutationSet,
	type PollinatingJobPayload,
	type PollinatingPassMode,
	type PollinatingMutation,
	type PollinatingMutationSet,
	type PollinatingMutationKind,
	type PollinatingMutationOutcome,
	type PollinatingPassResult,
} from "./contracts.js";

export {
	createPollinatingTrigger,
	pollinatingStateId,
	PollinatingTrigger,
	type PollinatingTriggerDeps,
	type PollinatingScope,
	type PollinatingState,
	type PollinatingJobEnqueuer,
	type PollinatingTickResult,
	type PollinatingTickDecision,
	type PollinatingTickReason,
	type PendingJobTerminalProbe,
} from "./trigger.js";

export {
	createPollinatingRunner,
	PollinatingRunner,
	type PollinatingRunnerDeps,
	type PollinatingPayload,
	type PollinatingPayloadStrategy,
	type PollinatingStateUpdater,
	type PollinatingRunnerLogger,
} from "./runner.js";

export {
	createIncrementalStrategy,
	IncrementalPayloadStrategy,
	defaultPollinatingIdentitySource,
	createGraphQueryTool,
	type IncrementalStrategyDeps,
	type PollinatingIdentitySource,
	type PollinatingIdentityContext,
	type GraphQueryTool,
} from "./incremental.js";

export {
	createCompactionStrategy,
	CompactionPayloadStrategy,
	shouldEnterCompaction,
	resolvePassMode,
	type EntityGraph,
} from "./compaction.js";

export {
	createPollinatingWorker,
	type PollinatingJobWorker,
	type PollinatingWorkerDeps,
	type PollinatingTriggerSeam,
	type PollinatingWorkerLogger,
	type PollinatingWorkerClock,
} from "./worker.js";

export {
	mountPollinateApi,
	POLLINATE_TRIGGER_PATH,
	POLLINATE_TRIGGER_GROUP,
	POLLINATE_DEFAULT_AGENT_ID,
	type MountPollinateOptions,
	type PollinateAck,
	type PollinateTriggerSeam,
} from "./api.js";
