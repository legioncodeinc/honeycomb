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
	type MountMemoriesOptions,
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
	deriveSessionPath,
	resolveRef,
} from "./resolve.js";
