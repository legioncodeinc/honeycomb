/**
 * Virtual-filesystem barrel — PRD-015 (the memory mount intercept + dispatch layer).
 *
 * The public surface of the VFS module. `DeepLakeFs` is the long-lived intercept; the
 * `DaemonDispatch` seam is the ONLY path out to storage (a-AC-6); `classifyPath` is the pure
 * router; `generateVirtualIndex` synthesizes the index. Wave 1 (015a) ships the read side +
 * the seams; Wave 2 (015b) fills the write buffer. See CONVENTIONS.md before extending.
 */

export {
	type ContentCache,
	createFakeDaemonDispatch,
	createFakeSnapshotLoader,
	type DaemonDispatch,
	type FakeDaemonDispatch,
	type FakeDaemonDispatchOptions,
	type FsOp,
	type FsVerb,
	FS_VERBS,
	type LoadedSnapshot,
	notImplemented,
	type PathClass,
	type PendingBuffer,
	type PendingWrite,
	type RecordedDispatch,
	type Row,
	type Rows,
	SessionPermissionError,
	type SnapshotLoader,
	type VfsScope,
} from "./contracts.js";

export { classifyPath, GOAL_STATUS_TOKENS, type GoalStatusToken, toMountRelative } from "./classify.js";

export {
	buildRecentMemoriesSql,
	buildRecentSessionsSql,
	generateVirtualIndex,
	INDEX_SECTION_LIMIT,
} from "./index-gen.js";

export {
	buildMemorySummarySql,
	buildSessionsConcatSql,
	NotFoundError,
	type ReadDeps,
	resolveRead,
} from "./read.js";

export { DeepLakeFs, type DeepLakeFsOptions } from "./fs.js";

export {
	buildGoalCloseSql,
	buildGoalInsertSql,
	buildGoalProbeSql,
	buildGoalStatusTransitionSql,
	buildGoalUpdateSql,
	buildKpiInsertSql,
	buildKpiProbeSql,
	buildKpiUpdateSql,
	buildMemoryAppendSql,
	buildMemoryInsertSql,
	buildMemoryProbeSql,
	buildMemoryUpdateSql,
	createWriteBuffer,
	decomposeGoalPath,
	decomposeKpiPath,
	type Embedder,
	floatArrayLiteral,
	FLUSH_AT_PENDING,
	FLUSH_DEBOUNCE_MS,
	type FlushOutcome,
	type GoalPathParts,
	GoalTransitionError,
	type KpiPathParts,
	kpiKey,
	type TimerLike,
	type WriteBuffer,
	type WriteBufferDeps,
	type WriteBufferOptions,
} from "./write-buffer.js";
