/**
 * DeepLake storage adapter — daemon-only barrel (PRD-002a).
 *
 * This is the storage layer's public surface WITHIN the daemon. It is imported
 * by `src/daemon/index.ts` and the Wave-2 adapter layers (escaping 002b,
 * healing 002c, write patterns 002d, vector 002e) — and by nothing outside
 * `src/daemon/`. Non-daemon code reaches storage over the daemon RPC (port
 * 3850), never by importing this module (a-AC-5).
 */

import { type SleepFn, StorageClient, type StorageQuery } from "./client.js";
import {
	type CredentialProvider,
	defaultCredentialProvider,
	resolveStorageConfig,
	type StorageConfig,
} from "./config.js";
import { type DeepLakeTransport, HttpDeepLakeTransport } from "./transport.js";

export {
	isReadStatement,
	isTransientResult,
	type QueryOptions,
	type QueryScope,
	type SleepFn,
	StorageClient,
	type StorageQuery,
} from "./client.js";
export {
	type CredentialProvider,
	type CredentialsFileProviderOptions,
	DEFAULT_QUERY_TIMEOUT_MS,
	deeplakeCredentialsFileProvider,
	defaultCredentialProvider,
	envCredentialProvider,
	redactToken,
	resolveStorageConfig,
	type StorageConfig,
	StorageConfigError,
	StorageConfigSchema,
} from "./config.js";
export {
	type ConnectionError,
	connectionError,
	isOk,
	ok,
	type QueryError,
	type QueryOk,
	type QueryResult,
	type QueryTimeout,
	queryError,
	type StorageRow,
	timeoutResult,
} from "./result.js";
export {
	DEEPLAKE_CLIENT_HEADER,
	DEEPLAKE_ORG_HEADER,
	type DeepLakeTransport,
	HttpDeepLakeTransport,
	TransportError,
	type TransportErrorKind,
	type TransportRequest,
} from "./transport.js";

// ── Wave 2: SQL safety (002b) ──────────────────────────────────────────────
export { eLiteral, sLiteral, sqlColumnList, sqlIdent, sqlLike, sqlStr } from "./sql.js";

// ── Wave 2: schema + healing (002c) ────────────────────────────────────────
export {
	buildAddColumnSql,
	buildCreateTableSql,
	buildIntrospectionSql,
	type ColumnDef,
	SchemaDefinitionError,
	validateColumnDefs,
} from "./schema.js";
export {
	classifyFailure,
	type ColumnHealResult,
	type FailureClass,
	HealFailure,
	healColumns,
	type HealTarget,
	withHeal,
} from "./heal.js";

// ── Wave 2: write patterns (002d) ──────────────────────────────────────────
export {
	appendOnlyInsert,
	appendVersionBumped,
	type ColumnValue,
	readAppendOrdered,
	readLatestVersion,
	type RowValues,
	selectBeforeInsert,
	type SelectBeforeInsertResult,
	updateOrInsertByKey,
	val,
} from "./writes.js";

// ── Wave 2: vector columns + GPU search (002e) ─────────────────────────────
export {
	assertEmbeddingDim,
	buildLexicalDegradeSql,
	buildVectorSearchSql,
	clampNonNegative,
	DEFAULT_OVERFETCH_MULTIPLIER,
	EMBEDDING_DIMS,
	embeddingColumn,
	type RecallResult,
	resolveLimits,
	type ScoredId,
	serializeFloat4Array,
	vectorSearch,
	type VectorScopeFilter,
	VectorDimensionError,
	type VectorSearchArgs,
} from "./vector.js";

// ── PRD-028: read-your-writes convergence seam ─────────────────────────────
export {
	type ConvergeBudget,
	type ConvergeBudgetOverride,
	type ConvergeBudgetProvider,
	type ConvergeClock,
	type ConvergeTraceSink,
	DEFAULT_CONVERGE_BACKOFF_BASE_MS,
	DEFAULT_CONVERGE_BACKOFF_CAP_MS,
	DEFAULT_CONVERGE_BUDGET,
	DEFAULT_CONVERGE_MAX_ATTEMPTS,
	DEFAULT_CONVERGE_MAX_WALL_CLOCK_MS,
	envConvergeBudgetProvider,
	minRowCount,
	minVersion,
	type RawConvergeBudget,
	readConverged,
	type ReadConvergedOptions,
	type ReadWatermark,
	resolveConvergeBudget,
	rowPresent,
	type SleepFn as ConvergeSleepFn,
	watermarkOf,
	watermarkPredicate,
	type WatermarkPredicateOptions,
} from "./converge.js";

// ── PRD-030: storage-level version-history compaction ──────────────────────
export {
	assertVersionBumpedTable,
	COMPACTABLE_VERSION_BUMPED_TABLES,
	compactVersionHistory,
	type CompactionClock,
	CompactionConfigError,
	type CompactionConfigProvider,
	type CompactionLogger,
	type CompactionOptions,
	CompactionRefusedError,
	type CompactionRetention,
	CompactionRetentionSchema,
	type CompactionSummary,
	computeReapSet,
	createVersionCompactor,
	DEFAULT_KEEP_LATEST_N,
	DEFAULT_TIMESTAMP_COLUMN,
	DEFAULT_VERSION_COLUMN,
	DEFAULT_WINDOW_DAYS,
	envCompactionConfigProvider,
	isVersionBumpedTable,
	type RawCompactionConfig,
	resolveCompactionConfig,
	type VersionRow,
} from "./compaction.js";

/**
 * Build the storage client, failing closed on bad config (FR-2 / a-AC-3).
 *
 * Order matters: config is resolved and validated FIRST, so the daemon throws
 * a `StorageConfigError` before any transport is constructed or any connection
 * is attempted. The transport defaults to the real HTTP transport but can be
 * injected (the fake transport in tests) so the client logic is verified
 * without a live endpoint.
 *
 * PRD-023 (D-3 / AC-7): the DEFAULT provider is now {@link defaultCredentialProvider}
 * — ENV-OVER-FILE. With NO `HONEYCOMB_DEEPLAKE_*` env and a valid shared
 * `~/.deeplake/credentials.json`, the file supplies `{ endpoint, token, org, workspace }`
 * and the assembled daemon connects from it (the AC-7 spine); a present
 * `HONEYCOMB_DEEPLAKE_*` value still wins per-field. Tests inject `options.provider`
 * to bypass both (the override path is unchanged).
 */
export function createStorageClient(
	options: {
		provider?: CredentialProvider;
		/** Inject a transport (e.g. the fake) instead of the real HTTP one. */
		transport?: DeepLakeTransport;
		/**
		 * Inject the read-retry backoff clock (tests). Defaults to the real timer;
		 * a test passes a no-op so the bounded backoff is instant and deterministic.
		 */
		sleep?: SleepFn;
	} = {},
): StorageClient {
	const provider = options.provider ?? defaultCredentialProvider();
	const config: StorageConfig = resolveStorageConfig(provider);
	const transport: DeepLakeTransport = options.transport ?? new HttpDeepLakeTransport(config.endpoint, config.token);
	return new StorageClient(transport, config, options.sleep);
}

/** Re-export the structural query contract Wave 2 codes against. */
export type { StorageQuery as StorageClientQuery };
