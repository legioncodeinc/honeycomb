/**
 * Memory-pipeline barrel — PRD-006 (the single import surface for the pipeline).
 *
 * Re-exports the Wave-1 scaffold (config, the ModelClient seam, the cross-stage
 * contracts, the stage-worker harness, the extraction stage, the handler registry)
 * and the four Wave-2 stage stubs, so the daemon-assembly module (and tests) import
 * the pipeline from one place. A Wave-2 Bee fills its stage module; its real
 * exports flow out through here automatically.
 */

// ── Config (the flags every stage reads) ──────────────────────────────────────
export {
	AutonomousConfigSchema,
	type AutonomousConfig,
	type ExtractionConfig,
	ExtractionConfigSchema,
	EXTRACTION_PROVIDER_AUTO,
	EXTRACTION_PROVIDER_AUTO_RESOLVED,
	EXTRACTION_PROVIDER_NONE,
	envPipelineConfigProvider,
	type GraphConfig,
	GraphConfigSchema,
	type GraphEnvDecision,
	isExtractionEnabled,
	type PipelineConfig,
	PipelineConfigError,
	type PipelineConfigProvider,
	PipelineConfigSchema,
	type RawPipelineConfig,
	readGraphEnvDecision,
	resolveEffectiveExtractionProvider,
	resolveGraphEnabledVaultFirst,
	resolveMemoryEnabledVaultFirst,
	type RetentionConfig,
	RetentionConfigSchema,
	resolvePipelineConfig,
} from "./config.js";

// ── ModelClient seam ──────────────────────────────────────────────────────────
export {
	createFakeModelClient,
	type FakeModelClient,
	type FakeModelScript,
	type ModelClient,
	type ModelRequest,
	MODEL_WORKLOADS,
	type ModelWorkload,
	noopModelClient,
	toModelRequest,
} from "./model-client.js";

// ── Cross-stage contracts ─────────────────────────────────────────────────────
export {
	ConfidenceSchema,
	type EntityTriple,
	EntityTripleSchema,
	type ExtractionResult,
	type Fact,
	FactSchema,
	normalizeMemoryType,
	parseEntityTriple,
	parseFact,
	parseProposal,
	type Proposal,
	type ProposalAction,
	PROPOSAL_ACTIONS,
	ProposalSchema,
} from "./contracts.js";

// ── Stage-worker harness ──────────────────────────────────────────────────────
export {
	createStageWorker,
	isPipelineJobKind,
	PIPELINE_JOB_KINDS,
	type PipelineJobKind,
	type PipelineJobScope,
	type StageHandler,
	type StageHandlers,
	type StageJob,
	type StageWorker,
	type StageWorkerDeps,
	type StageWorkerLogger,
} from "./stage-worker.js";

// ── Extraction (006a, filled) ─────────────────────────────────────────────────
export {
	buildExtractionPrompt,
	createExtractionHandler,
	type ExtractionHandlerDeps,
	type ExtractionLogger,
	extractFromText,
	parseExtractionJson,
	stripChainOfThought,
} from "./extraction.js";

// ── Live reload (SP-1 / ISS-001/ISS-005 — settings/keys apply without restart) ──
export {
	type CreateLiveExtractionGateOptions,
	type CreatePipelineReloadSeamOptions,
	createLiveExtractionGate,
	createPipelineReloadSeam,
	type ExtractionGateProbe,
	type LiveExtractionGate,
	LiveModelClient,
	PIPELINE_RELOAD_DEBOUNCE_MS,
	type PipelineReloadController,
	type PipelineReloadSeam,
	type ReloadScheduleFn,
} from "./reload.js";

// ── Handler registry ──────────────────────────────────────────────────────────
export { createPipelineHandlers, type PipelineHandlerDeps } from "./handlers.js";

// ── Fan-out wiring (045a — the chain that advances a turn through the stages) ──
export { controlledWriteFanOut, decisionFanOut, extractionFanOut } from "./fan-out.js";

// ── Memory-formation observability (the glanceable "are memories committing?" signal) ──
export {
	createMemoryFormationTracker,
	type ExtractionEventSink,
	type MemoryFormationOutcome,
	type MemoryFormationSnapshot,
	type MemoryFormationTracker,
	withExtractionErrorTracking,
} from "./memory-formation.js";

// ── Wave-2 stage stubs (now filled — 045a wires + chains them) ────────────────
export {
	type ControlledWriteHandlerDeps,
	type ControlledWriteOutcome,
	createControlledWriteHandler,
	noopControlledWriteHandler,
} from "./controlled-writes.js";
export {
	createDecisionHandler,
	type DecisionHandlerDeps,
	type FactDecision,
	noopDecisionHandler,
} from "./decision.js";
export { createGraphPersistHandler, type GraphPersistHandlerDeps, noopGraphPersistHandler } from "./graph-persist.js";
export { createRetentionHandler, type RetentionHandlerDeps, noopRetentionHandler } from "./retention.js";
