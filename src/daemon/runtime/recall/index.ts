/**
 * Recall engine barrel — PRD-007. The single import surface for the five-phase
 * recall engine (collect → traverse → authorize → shape → gate).
 *
 * Wave 1 exports: the config, the cross-phase contracts, the shared
 * ScopeClauseBuilder (the auth chokepoint), the engine harness, 007a collection,
 * and the four phase types + no-op defaults. A Wave-2 Bee fills its phase module
 * and imports the contracts/engine/scope-clause from here.
 */

// ── Config (D-1..D-6 knobs) ──────────────────────────────────────────────────
export {
	type DampeningConfig,
	type RawRecallConfig,
	type RecallConfig,
	RecallConfigError,
	type RecallConfigProvider,
	RecallConfigSchema,
	type RerankerConfig,
	type RerankerStrategy,
	RERANKER_STRATEGIES,
	type TraversalConfig,
	envRecallConfigProvider,
	resolveRecallConfig,
} from "./config.js";

// ── Cross-phase contracts ────────────────────────────────────────────────────
export {
	type AuthorizedContext,
	type Candidate,
	type CandidateScores,
	type CallerFilters,
	type MergedPool,
	type RecallChannel,
	type RecallQuery,
	type RecallReadPolicy,
	type RecallScope,
	RECALL_CHANNELS,
	RECALL_READ_POLICIES,
	bestScore,
	mergeChannels,
} from "./contracts.js";

// ── The shared ScopeClauseBuilder (the auth chokepoint) ──────────────────────
export {
	type ScopeClause,
	type ScopeClauseError,
	type ScopeClauseInput,
	type ScopeReadPolicy,
	SCOPE_READ_POLICIES,
	asReadPolicy,
	buildScopeClause,
} from "./scope-clause.js";

// ── The engine harness ───────────────────────────────────────────────────────
export {
	type ChannelResult,
	type RecallEngineDeps,
	type RecallLogger,
	type RecallPhaseDeps,
	type RecallPhases,
	RecallEngine,
	createRecallEngine,
} from "./engine.js";

// ── 007a collection (FILLED) ─────────────────────────────────────────────────
export {
	type CollectionDeps,
	type HintSource,
	type ScoredId,
	buildFtsSql,
	collectCandidates,
	computeQueryVector,
	emptyHintSource,
	prepareLexicalTerm,
} from "./collection.js";

// ── Phase types + no-op defaults (Wave-2 fills) ──────────────────────────────
export {
	type AuthorizationPhase,
	type AuthorizedPool,
	authorizationPhase,
	authorizeBrowse,
	buildAuthorizationSql,
	buildBrowseAuthorizationSql,
	buildCandidateInClause,
	buildFilterConjuncts,
	buildGroupMembersSql,
	compileRequestClause,
	noopAuthorizationPhase,
	resolveGroupMembers,
} from "./authorization.js";
export { type GatePhase, type RecallHit, type RecallResult, noopGatePhase } from "./gate.js";
export { type ShapedCandidate, type ShapedPool, type ShapingPhase, noopShapingPhase } from "./shaping.js";
export { type TraversalPhase, noopTraversalPhase } from "./traversal.js";
