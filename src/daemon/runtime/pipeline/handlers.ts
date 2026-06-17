/**
 * Pipeline handler registry — PRD-006 Wave 1 (the one place every stage is routed).
 *
 * Assembles the {@link StageHandlers} map the {@link createStageWorker} routes by
 * job kind. Wave 1 wires the FILLED extraction handler and the FOUR Wave-2 STUBS
 * (decision / controlled-writes / graph-persist / retention), so the worker
 * compiles and routes all five kinds today and a Wave-2 Bee only swaps the body of
 * its own stage factory — never this map's shape.
 *
 * This is the seam mirror of the 004 bootstrap's service map: the routing is wired
 * once here; filling a stage is a one-file edit in that stage's module.
 *
 * Construction posture (consistent with PRD-004/005 deferring real-service assembly
 * to the CLI / PRD-020): this builds the handler map from injected deps; it does
 * NOT open storage or start anything. The daemon-assembly module (later) calls this
 * with the resolved config + model + storage deps and hands the map to the worker.
 */

import { type ControlledWriteHandlerDeps, createControlledWriteHandler } from "./controlled-writes.js";
import { createDecisionHandler, type DecisionHandlerDeps } from "./decision.js";
import { createExtractionHandler, type ExtractionHandlerDeps } from "./extraction.js";
import { createGraphPersistHandler, type GraphPersistHandlerDeps } from "./graph-persist.js";
import { createRetentionHandler, type RetentionHandlerDeps } from "./retention.js";
import type { StageHandlers } from "./stage-worker.js";

/**
 * The per-stage deps the registry threads to each factory. Wave 1 only
 * {@link ExtractionHandlerDeps} carries real deps; the other four are stub deps a
 * Wave-2 Bee widens in its own module. Each is optional so a test can register only
 * the stages it exercises (the rest fall back to their no-op stub).
 */
export interface PipelineHandlerDeps {
	/** Extraction (006a, filled): config + model + optional logger + onResult. */
	readonly extraction: ExtractionHandlerDeps;
	/** Decision (006b stub): widened by `retrieval-worker-bee`. */
	readonly decision?: DecisionHandlerDeps;
	/** Controlled writes (006c stub): widened by `deeplake-dataset-worker-bee`. */
	readonly controlledWrite?: ControlledWriteHandlerDeps;
	/** Graph persistence (006d stub): widened by `deeplake-dataset-worker-bee`. */
	readonly graphPersist?: GraphPersistHandlerDeps;
	/** Retention (006e stub): widened by `deeplake-dataset-worker-bee`. */
	readonly retention?: RetentionHandlerDeps;
}

/**
 * Build the full {@link StageHandlers} map. Extraction is the filled handler; the
 * other four resolve to their stub factories (no-op until their Bee fills them).
 * The job kinds here MUST match {@link PIPELINE_JOB_KINDS} in `stage-worker.ts` —
 * the worker indexes this map by the leased job's kind.
 */
export function createPipelineHandlers(deps: PipelineHandlerDeps): StageHandlers {
	return {
		memory_extraction: createExtractionHandler(deps.extraction),
		memory_decision: createDecisionHandler(deps.decision),
		memory_controlled_write: createControlledWriteHandler(deps.controlledWrite),
		memory_graph_persist: createGraphPersistHandler(deps.graphPersist),
		memory_retention: createRetentionHandler(deps.retention),
	};
}
