/**
 * Memories data-API barrel — PRD-022a. The single import surface for the
 * `/api/memories/*` mount seam + its recall / write / read adapters.
 *
 * The composition root (022d) imports {@link mountMemoriesApi} from here and fires
 * it ONCE after `createDaemon(...)`, mirroring how it fires `mountDashboardApi`.
 */

// ── The mount seam (022d calls this) ─────────────────────────────────────────
export {
	MEMORIES_GROUP,
	RECALL_DEGRADED_EVENT,
	RECALL_MODE_SETTING_KEY,
	type MountMemoriesOptions,
	type VaultSettingsReader,
	MAX_RECALL_TOKEN_BUDGET,
	mountMemoriesApi,
	resolveMemoryScope,
} from "./api.js";

// ── Prime-digest endpoint (PRD-046c) ─────────────────────────────────────────
export {
	type MountMemoriesPrimeOptions,
	type PrimeResponse,
	PrimeResponseSchema,
	buildPrimeForScope,
	mountMemoriesPrimeApi,
} from "./prime.js";

// ── Recall adapter (a-AC-2) ──────────────────────────────────────────────────
export {
	DEFAULT_RECALL_LIMIT,
	MAX_RECALL_LIMIT,
	type ActivationSource,
	type ConflictSuppressionSource,
	type MemoryActivationInputs,
	type MemoryRecallDeps,
	type MemoryRecallHit,
	type MemoryRecallRequest,
	type MemoryRecallResult,
	type RecallSource,
	buildMemoriesArmSql,
	buildMemoryArmSql,
	buildSessionsArmSql,
	recallMemories,
	resolveRecallLimit,
} from "./recall.js";

// ── PRD-058e: reinforcement, ACT-R activation, calibration ───────────────────
export {
	type AccessEvent,
	type ActrParams,
	DEFAULT_ACTR_PARAMS,
	actrActivation,
	baseLevelActivation,
} from "./activation.js";
export {
	type AccessLogDeps,
	DEFAULT_ACCESS_COMPACTION_KEEP,
	compactAccessLog,
	readAccessHistory,
	recordAccess,
} from "./access-log.js";
export {
	type CalibrationModel,
	type CalibrationSample,
	type ReliabilityBin,
	IDENTITY_MODEL,
	applyCalibration,
	brierScore,
	deserializeModel,
	expectedCalibrationError,
	fitIsotonic,
	reliabilityDiagram,
	serializeModel,
	shouldAdoptRefit,
} from "./calibration.js";
export {
	type CalibrationIntrospection,
	readCalibrationIntrospection,
} from "./calibration-store.js";
export {
	type ContradictionDetector,
	type RecallOutcomeSignals,
	type UsefulnessGrade,
	type UsefulnessGraderDeps,
	gradeRecallBatch,
	gradeUsefulness,
	noContradictionDetector,
} from "./usefulness-grader.js";
export {
	type ReverifyScheduleConfig,
	DEFAULT_REVERIFY_SCHEDULE,
	isDueForReverify,
	reverifyIntervalMs,
} from "./reverify-schedule.js";

// ── PRD-058b: semantic conflict detection + resolution (the `κ(m,t)` gate) ───
export {
	type ConflictCandidate,
	type ConflictDetectDeps,
	type ContradictionDetector as ConflictContradictionDetector,
	type DetectedConflict,
	type KeepBothMemo,
	DEFAULT_LEXICAL_CONCLUSIVE,
	DEFAULT_MODEL_ESCALATION_SIM,
	DEFAULT_THETA_DETECT,
	buildContradictionPrompt,
	contraScore,
	createContradictionDetector,
	detectConflicts,
	oppLexical,
	parsePContradiction,
	scorePair,
} from "./conflict-detect.js";
export {
	type ConflictPersistDeps,
	type ConflictProjection,
	type ConflictResolution,
	type ConflictResolveParams,
	type ConflictVoter,
	type CandidateVoter,
	type DetectAndProjectDeps,
	type DetectAndProjectResult,
	CONFLICT_ACTOR,
	DEFAULT_GAMMA,
	DEFAULT_RHO,
	DEFAULT_TAU_REVIEW,
	DEFAULT_TAU_SUPERSEDE,
	PROV_DISTILLED,
	PROV_RAW,
	appendConflictHistory,
	corroboration,
	createConflictSuppressionSource,
	detectAndProject,
	projectConflict,
	provWeight,
	readConflictConverged,
	resolveConflict,
	reverseSupersession,
	supersedeLoser,
} from "./conflict-resolve.js";
export {
	type KeepBothMemoStore,
	type MountConflictsOptions,
	type ResolveOutcome,
	type ResolveRequest,
	ResolveSchema,
	applyConflictResolution,
	mountConflictsApi,
} from "./conflicts-api.js";
// PRD-058b LIVE (C-1): the post-commit conflict-detection hook + the claim-outcome derivation.
export {
	type ControlledWriteConflictHookDeps,
	createControlledWriteConflictHook,
} from "./conflict-hook.js";
export {
	OUTCOME_AFFIRM,
	OUTCOME_NEGATE,
	deriveClaimOutcome,
} from "./claim-outcome.js";

// ── PRD-058d: the lifecycle config + read endpoints + the read-side `H(m,t)` ─
export {
	type LifecycleConfig,
	type LifecycleConfigProvider,
	type LifecycleFlagRef,
	type RawLifecycleConfig,
	type StaleRefPosture,
	LIFECYCLE_FLAG_REFERENCE,
	LifecycleConfigError,
	LifecycleConfigSchema,
	STALE_REF_POSTURES,
	effectiveStalenessExponent,
	envLifecycleConfigProvider,
	lifecycleRecency,
	mergeRawLifecycle,
	resolveLifecycleConfig,
	resolveLifecycleConfigLayered,
	staticLifecycleConfigProvider,
} from "./lifecycle-config.js";
export {
	type ConflictListItem,
	type LifecycleHistoryItem,
	type MountLifecycleOptions,
	type StaleRefListItem,
	DEFAULT_LIFECYCLE_PAGE,
	LIFECYCLE_HISTORY_OPERATIONS,
	MAX_LIFECYCLE_PAGE,
	buildLifecycleHistorySql,
	buildStaleRefListSql,
	listConflicts,
	listLifecycleHistory,
	listStaleRefs,
	mountLifecycleApi,
	resolveLifecyclePage,
} from "./lifecycle-api.js";
export {
	type LifecycleHealthInputs,
	type MemoryHealth,
	assembleHealth,
} from "./lifecycle-health.js";

// ── Write adapters (a-AC-3 / a-AC-4) ─────────────────────────────────────────
export {
	type MemoryWriteDeps,
	type MemoryWriteResult,
	type MutateMemoryRequest,
	type MutationOperation,
	MemoryReasonRequiredError,
	forgetMemory,
	memoryContentHash,
	modifyMemory,
	type StoreMemoryRequest,
	storeMemory,
} from "./store.js";

// ── Read adapters (FR-4) ─────────────────────────────────────────────────────
export {
	DEFAULT_LIST_LIMIT,
	MAX_LIST_LIMIT,
	type MemoryReadDeps,
	type MemoryRecord,
	buildGetSql,
	buildListSql,
	getMemory,
	listMemories,
	resolveListLimit,
} from "./reads.js";

// ── PRD-062d: fan-out coalescing + recall concurrency caps ───────────────────
export { Semaphore, mapBounded } from "./bounded-pool.js";
export {
	type AmplificationConfig,
	type AmplificationConfigProvider,
	type RawAmplificationConfig,
	AmplificationConfigError,
	AmplificationConfigSchema,
	DEFAULT_FANOUT_BATCH,
	DEFAULT_RECALL_MAX_CONCURRENCY,
	MIN_RECALL_MAX_CONCURRENCY,
	amplificationConfig,
	envAmplificationConfigProvider,
	resetAmplificationConfigCache,
	resolveAmplificationConfig,
} from "./amplification-config.js";

// ── Resolve adapter (PRD-046e) ────────────────────────────────────────────────
export {
	DEFAULT_RESOLVE_TURNS,
	MAX_RESOLVE_TURNS,
	type DurableFactRow,
	type EpisodicSummaryRow,
	type ResolveRefDeps,
	type ResolveResult,
	type SessionTurnRow,
	buildDurableDepth1Sql,
	buildEpisodicDepth1Sql,
	buildSessionDepth2Sql,
	buildSessionRowIdMatcher,
	extractSessionId,
	resolveRef,
} from "./resolve.js";
