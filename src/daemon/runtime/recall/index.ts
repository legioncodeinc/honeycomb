/**
 * Recall barrel — PRD-007 (candidate collection + the shared scope/contract surface).
 *
 * ── PRD-045b de-scope ────────────────────────────────────────────────────────
 * The dormant five-phase `RecallEngine` orchestrator (collect → traverse →
 * authorize → shape → gate) was REMOVED: it had zero production callers and the
 * live recall path is `recallMemories` (lexical UNION-ALL + semantic `<#>` RRF, in
 * `memories/recall.ts`). What remains here is the part that IS live: 007a candidate
 * collection (reused by the VFS browse seam `vfs/api.ts`), the recall config, the
 * cross-phase contracts, and the `buildScopeClause` authorization-clause builder
 * (the canonical inner-ring scope chokepoint, asserted by the PRD-011e suite). See
 * `library/requirements/in-work/prd-045-daemon-wiring-closeout/prd-045b-...md`.
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
	type RecallLogger,
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

// ── 007a collection (FILLED, live — reused by the VFS browse seam) ────────────
export {
	type CollectionDeps,
	type HintSource,
	type RecallMode,
	type ScoredId,
	buildFtsSql,
	collectCandidates,
	computeQueryVector,
	emptyHintSource,
	prepareLexicalTerm,
} from "./collection.js";
