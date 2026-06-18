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

// ── 017b synthesis (FULL — the team-facing wiki: MEMORY.md + thread heads) ──
export {
	createSynthesisStore,
	DEFAULT_SYNTHESIS_AUTHOR,
	type MemoryIndexResult,
	MEMORY_INDEX_PATH,
	renderMemoryIndex,
	renderThreadHead,
	type SummaryRecord,
	synthesizeMemoryIndex,
	synthesizeThreadHeads,
	SYNTHESIS_DESCRIPTION_CHARS,
	type SynthesisDeps,
	type SynthesisStore,
	type SynthesisWriteOutcome,
	type SynthesizedRow,
	THREAD_HEAD_PATH_PREFIX,
	type ThreadHeadResult,
	threadHeadPath,
	threadKeyOf,
} from "./synthesis.js";
