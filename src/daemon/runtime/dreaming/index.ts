/**
 * Dreaming-loop barrel — the public surface the daemon assembly + tests import from
 * one place instead of reaching into each module.
 *
 * The dreaming loop (PRD-009) is: the token-budget {@link createDreamingTrigger}
 * (counter + single-pending guard + enqueue), the pass-lifecycle
 * {@link createDreamingRunner} harness, the two payload strategies
 * ({@link createIncrementalStrategy} / {@link createCompactionStrategy} + the
 * mode-selection helpers), the resolved {@link resolveDreamingConfig} knobs, the
 * cross-module {@link DreamingJobPayload} contracts, and — PRD-026 — the
 * daemon-resident {@link createDreamingWorker} that leases `["dreaming"]` jobs and
 * runs the runner. The HTTP "Dream now" trigger ({@link mountDreamApi}) is exported
 * too so the composition root attaches it alongside the worker.
 *
 * ── The worker is the PRD-026 consumer ───────────────────────────────────────
 * Before PRD-026 nothing in the live daemon consumed a `dreaming` job: the trigger
 * enqueued and the runner could run, but no harness leased + invoked it. The worker
 * is that harness. The Wave-1c daemon-assembly bee constructs AND starts it ONLY when
 * `resolveDreamingConfig().enabled` (default OFF) and stops it in teardown.
 */

export {
	resolveDreamingConfig,
	envDreamingConfigProvider,
	DreamingConfigSchema,
	DreamingConfigError,
	DEFAULT_TOKEN_THRESHOLD,
	DEFAULT_MAX_INPUT_TOKENS,
	type DreamingConfig,
	type DreamingConfigProvider,
	type RawDreamingConfig,
} from "./config.js";

export {
	DREAMING_JOB_KIND,
	DREAMING_PASS_MODES,
	DREAMING_MUTATION_KINDS,
	MUTATION_KIND_TO_OPERATION,
	DreamingJobPayloadSchema,
	DreamingMutationSchema,
	DreamingMutationSetSchema,
	parseDreamingJobPayload,
	parseDreamingMutationSet,
	type DreamingJobPayload,
	type DreamingPassMode,
	type DreamingMutation,
	type DreamingMutationSet,
	type DreamingMutationKind,
	type DreamingMutationOutcome,
	type DreamingPassResult,
} from "./contracts.js";

export {
	createDreamingTrigger,
	dreamingStateId,
	DreamingTrigger,
	type DreamingTriggerDeps,
	type DreamingScope,
	type DreamingState,
	type DreamingJobEnqueuer,
	type DreamingTickResult,
	type DreamingTickDecision,
	type DreamingTickReason,
	type PendingJobTerminalProbe,
} from "./trigger.js";

export {
	createDreamingRunner,
	DreamingRunner,
	type DreamingRunnerDeps,
	type DreamingPayload,
	type DreamingPayloadStrategy,
	type DreamingStateUpdater,
	type DreamingRunnerLogger,
} from "./runner.js";

export {
	createIncrementalStrategy,
	IncrementalPayloadStrategy,
	defaultDreamingIdentitySource,
	createGraphQueryTool,
	type IncrementalStrategyDeps,
	type DreamingIdentitySource,
	type DreamingIdentityContext,
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
	createDreamingWorker,
	type DreamingJobWorker,
	type DreamingWorkerDeps,
	type DreamingTriggerSeam,
	type DreamingWorkerLogger,
	type DreamingWorkerClock,
} from "./worker.js";

export {
	mountDreamApi,
	DREAM_TRIGGER_PATH,
	DREAM_TRIGGER_GROUP,
	DREAM_DEFAULT_AGENT_ID,
	type MountDreamOptions,
	type DreamAck,
	type DreamTriggerSeam,
} from "./api.js";
