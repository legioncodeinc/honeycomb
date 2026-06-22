/**
 * Summaries barrel — PRD-017. One import surface for the wiki-summaries subsystem so a
 * consumer (the daemon worker assembly, the 017b Wave-2 Bee, the tests) reaches the
 * contracts, the 017a summary-worker, and the 017b stub from one place.
 *
 * 017a (`worker.ts`) is FULL this Wave: contracts + seams, the per-session lock, the
 * retry-on-empty event fetch + placeholder cleanup, the host-CLI gate (WIKI_WORKER env),
 * the non-fatal embed, and the SELECT-before-INSERT `memory` write at
 * `/summaries/<userName>/<sessionId>.md`. 017b (`synthesis.ts`) is an honest stub the
 * retrieval-worker-bee fills in Wave 2.
 */

// ── Contracts + seams (the pinned Wave-2 surface) ──
export {
	createFakeSummaryGenCli,
	DEFAULT_BACKOFF_MS,
	DEFAULT_GATE_TIMEOUT_MS,
	DEFAULT_RETRY_LIMIT,
	DEFAULT_WORKER_CONFIG,
	type EmbedClient,
	FINAL_TRIGGER_EVENTS,
	type FinalTriggerEvent,
	notImplemented,
	PERIODIC_TRIGGER_REASONS,
	type PeriodicTriggerReason,
	type SessionEvent,
	type SessionEventFetcher,
	SUMMARY_TRIGGER_KINDS,
	type SummaryGenCli,
	type SummaryLock,
	type SummaryLockHandle,
	type SummaryRow,
	type SummarySession,
	type SummaryStore,
	type SummaryTrigger,
	type SummaryTriggerKind,
	type SummaryWriteOutcome,
	type WorkerConfig,
} from "./contracts.js";

// ── PRD-046b Tier-1 KEY READ path (the cheap, pure-SQL prime skim — NO generation at read) ──
export {
	buildDurableKeySkimSql,
	buildEpisodicKeySkimSql,
	DEFAULT_KEY_SKIM_LIMIT,
	type KeySource,
	MAX_KEY_SKIM_LIMIT,
	MEMORIES_TABLE,
	type PrimedKey,
	type PrimeKeyReadDeps,
	resolveKeySkimLimit,
	skimPrimeKeys,
} from "./prime-keys.js";

// ── PRD-046c PRIME DIGEST assembler (token-bounded, recency-aware, deduped — pure transform) ──
export {
	assemblePrimeDigest,
	DEFAULT_DURABLE_LIMIT,
	DEFAULT_PRIME_MAX_TOKENS,
	DEFAULT_RECENT_LIMIT,
	estimatePrimeTokens,
	identityRecencyRanker,
	type KeyDeduper,
	normalizedTextDeduper,
	PRIME_EMPTY_MARKER,
	PRIME_FOOTER,
	PRIME_GUARD_CLOSE,
	PRIME_GUARD_NOTICE,
	PRIME_HEADER,
	type PrimeDigest,
	type PrimeDigestBudget,
	type PrimeEntry,
	type RecencyRanker,
} from "./prime-digest.js";

// ── PRD-046b Tier-1 KEY derivation (the grounded two-step distillation, folded into the gate) ──
export {
	buildStructuredSummaryPrompt,
	deriveKeyFromExtraction,
	type Extraction,
	ExtractionSchema,
	extractJsonObject,
	type GroundedSummary,
	isKeyGrounded,
	MAX_KEY_CHARS,
	parseSummaryGate,
	SUMMARY_GATE_INSTRUCTIONS,
	SummaryGateSchema,
	type SummaryGateOutput,
} from "./key.js";

// ── 017a summary worker (FULL) ──
export {
	buildSummaryPrompt,
	CAPTURE_ENV,
	createFileSessionLock,
	createHostSummaryGenCli,
	createSessionEventFetcher,
	createSummaryStore,
	defaultSummaryLockBaseDir,
	DESCRIPTION_EXCERPT_CHARS,
	embedNonFatal,
	excerptOf,
	fetchWithRetry,
	IN_PROGRESS_MARKER,
	MEMORY_TABLE,
	renderScrubbedEvents,
	runSummaryWorker,
	SESSIONS_TABLE,
	type Sleeper,
	SUMMARY_PATH_PREFIX,
	type SummaryCliSpec,
	type SummarySkippedReason,
	type SummarySpawner,
	summaryPath,
	type SummaryWorkerDeps,
	type SummaryWorkerResult,
	systemSleeper,
	systemSummarySpawner,
	WIKI_WORKER_ENV,
} from "./worker.js";

// ── 046a summary JOB worker (the deferred-assembly mount + trigger wiring) ──
export {
	createSummaryJobWorker,
	parseSummaryJobPayload,
	SUMMARY_JOB_KIND,
	SummaryJobPayloadSchema,
	type SummaryJobPayload,
	type SummaryJobWorker,
	type SummaryJobWorkerDeps,
	type SummaryJobWorkerLogger,
	summaryCliSpecFor,
	type SummaryWorkerDepsFactory,
	triggerFromPayload,
} from "./job.js";

// ── 017b synthesis (FULL — the team-facing wiki: MEMORY.md + thread heads) ──
// ── PRD-046b: + the version-bumped /MEMORY.md REFRESH (refreshMemoryIndex / refreshRow). ──
export {
	createSynthesisStore,
	DEFAULT_SYNTHESIS_AUTHOR,
	type MemoryIndexRefreshResult,
	type MemoryIndexResult,
	MEMORY_INDEX_PATH,
	refreshMemoryIndex,
	renderMemoryIndex,
	renderThreadHead,
	type SummaryRecord,
	synthesizeMemoryIndex,
	synthesizeThreadHeads,
	SYNTHESIS_DESCRIPTION_CHARS,
	SYNTHESIS_RESOLVE_POLLS,
	type SynthesisDeps,
	type SynthesisRefreshOutcome,
	type SynthesisStore,
	type SynthesisWriteOutcome,
	type SynthesizedRow,
	THREAD_HEAD_PATH_PREFIX,
	type ThreadHeadResult,
	threadHeadPath,
	threadKeyOf,
	type VersionedSynthesizedRow,
} from "./synthesis.js";
