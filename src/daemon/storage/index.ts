/**
 * DeepLake storage adapter — daemon-only barrel (PRD-002a).
 *
 * This is the storage layer's public surface WITHIN the daemon. It is imported
 * by `src/daemon/index.ts` and the Wave-2 adapter layers (escaping 002b,
 * healing 002c, write patterns 002d, vector 002e) — and by nothing outside
 * `src/daemon/`. Non-daemon code reaches storage over the daemon RPC (port
 * 3850), never by importing this module (a-AC-5).
 */

import { StorageClient, type StorageQuery } from "./client.js";
import { type CredentialProvider, envCredentialProvider, resolveStorageConfig, type StorageConfig } from "./config.js";
import { type DeepLakeTransport, HttpDeepLakeTransport } from "./transport.js";

export {
	type QueryOptions,
	type QueryScope,
	StorageClient,
	type StorageQuery,
} from "./client.js";
export {
	type CredentialProvider,
	DEFAULT_QUERY_TIMEOUT_MS,
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

/**
 * Build the storage client, failing closed on bad config (FR-2 / a-AC-3).
 *
 * Order matters: config is resolved and validated FIRST, so the daemon throws
 * a `StorageConfigError` before any transport is constructed or any connection
 * is attempted. The transport defaults to the real HTTP transport but can be
 * injected (the fake transport in tests) so the client logic is verified
 * without a live endpoint.
 */
export function createStorageClient(
	options: {
		provider?: CredentialProvider;
		/** Inject a transport (e.g. the fake) instead of the real HTTP one. */
		transport?: DeepLakeTransport;
	} = {},
): StorageClient {
	const provider = options.provider ?? envCredentialProvider();
	const config: StorageConfig = resolveStorageConfig(provider);
	const transport: DeepLakeTransport = options.transport ?? new HttpDeepLakeTransport(config.endpoint, config.token);
	return new StorageClient(transport, config);
}

/** Re-export the structural query contract Wave 2 codes against. */
export type { StorageQuery as StorageClientQuery };
