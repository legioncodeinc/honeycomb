/**
 * DeepLake storage adapter — daemon-only barrel (PRD-002a).
 *
 * This is the storage layer's public surface WITHIN the daemon. It is imported
 * by `src/daemon/index.ts` and the Wave-2 adapter layers (escaping 002b,
 * healing 002c, write patterns 002d, vector 002e) — and by nothing outside
 * `src/daemon/`. Non-daemon code reaches storage over the daemon RPC (port
 * 3850), never by importing this module (a-AC-5).
 */

import { type QueryOptions, type QueryScope, type SleepFn, StorageClient, type StorageQuery } from "./client.js";
import {
	type CredentialProvider,
	defaultCredentialProvider,
	resolveStorageConfig,
	type StorageConfig,
} from "./config.js";
import { QueryMeter } from "./query-meter.js";
import { PgDeepLakeTransport } from "./pg-transport.js";
import { connectionError, type QueryResult } from "./result.js";
import { type DeepLakeTransport, HttpDeepLakeTransport } from "./transport.js";

export {
	isAbsoluteUpdate,
	isReadStatement,
	isTransientResult,
	type QueryOptions,
	type QueryScope,
	type SleepFn,
	type StatementRetryability,
	statementRetryability,
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
	DEFAULT_QUERY_SOURCE,
	type MeterSnapshot,
	type MeterSnapshotEntry,
	QUERY_SOURCES,
	QueryMeter,
	type QuerySource,
	type SourceCounts,
} from "./query-meter.js";
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
export { PgDeepLakeTransport, type PgPoolFactory } from "./pg-transport.js";

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
 * Choose the default transport for a resolved config (self-hosted Postgres
 * backend). A `postgres://` / `postgresql://` endpoint means the operator is
 * pointing honeycomb at an Activeloop `pg_deeplake` Postgres URL DIRECTLY (no
 * HTTP gateway), so we wire the {@link PgDeepLakeTransport}; anything else is an
 * HTTP DeepLake endpoint and gets the {@link HttpDeepLakeTransport}. Both sit
 * behind the same `DeepLakeTransport` seam, so the client is identical either
 * way. `config.endpoint` is `z.string().url()`, so a `postgres://` URL has
 * already validated by the time we get here.
 */
export function createDefaultTransport(config: StorageConfig): DeepLakeTransport {
	if (/^postgres(ql)?:\/\//i.test(config.endpoint)) {
		return new PgDeepLakeTransport(config.endpoint);
	}
	return new HttpDeepLakeTransport(config.endpoint, config.token);
}

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
		/**
		 * Inject a shared query meter (PRD-062a). Defaults to a fresh in-memory
		 * {@link QueryMeter}; the daemon may pass a single shared instance so its
		 * diagnostics surface and the idle-baseline harness read the SAME counts.
		 */
		meter?: QueryMeter;
	} = {},
): StorageClient {
	const provider = options.provider ?? defaultCredentialProvider();
	const config: StorageConfig = resolveStorageConfig(provider);
	const transport: DeepLakeTransport = options.transport ?? createDefaultTransport(config);
	return new StorageClient(transport, config, options.sleep, options.meter);
}

/**
 * Build a DEFERRED storage client that NEVER throws at construction (PRD-050b b-AC-1 / b-AC-3).
 *
 * ── Why this exists (the boot-without-credentials invariant) ─────────────────
 * {@link createStorageClient} validates config EAGERLY and throws a `StorageConfigError` when no
 * usable credential resolves (a fresh install: no `~/.deeplake/credentials.json`, no
 * `HONEYCOMB_DEEPLAKE_*` env — `token`/`org`/`endpoint` are all `undefined`, which the
 * `StorageConfigSchema` rejects). The daemon composition root constructs the storage client at
 * boot, so that eager throw would take the WHOLE daemon down before it could serve the pre-auth
 * dashboard + the guided-setup login (PRD-050b). That is the exact seam b-AC-1 audits and forbids.
 *
 * This factory wraps the construction so a missing/invalid credential degrades the client to a
 * "not connected yet" state instead of a throw:
 *   - it builds the real {@link createStorageClient} LAZILY, on the FIRST query (not at boot);
 *   - a `StorageConfigError` (no creds) is caught and the call returns a typed `connection_error`
 *     result — exactly the closed-union "no server response" kind every storage consumer already
 *     branches on (so a DeepLake-backed seam degrades to an empty/"connect me" state, never a 500);
 *   - once a real client is successfully built it is CACHED, so the happy path pays the build cost
 *     at most once.
 *
 * ── This is what makes the live pre-auth → authenticated transition work (b-AC-3) ──
 * Because construction is RE-ATTEMPTED per query until it succeeds (the failed build is NOT
 * cached — only a successful one is), the moment the login flow writes the shared credential the
 * NEXT query through this client builds a real, connected client and the authenticated surfaces
 * hydrate — on the SAME running daemon, with NO restart and NO credential value cached at boot.
 *
 * The default provider ({@link defaultCredentialProvider}, env-over-file) is read fresh on each
 * build attempt, so a credential written after boot is picked up. A `transport` override is honored
 * for tests (a fake transport that needs no live endpoint).
 */
export function createLazyStorageClient(
	options: {
		provider?: CredentialProvider;
		transport?: DeepLakeTransport;
		sleep?: SleepFn;
		meter?: QueryMeter;
	} = {},
): StorageClient {
	let built: StorageClient | null = null;
	const meter = options.meter ?? new QueryMeter();

	/** Try to build the real client; return it on success, or `null` when no usable credential resolves. */
	const tryBuild = (): StorageClient | null => {
		if (built !== null) return built;
		try {
			built = createStorageClient({ ...options, meter });
			return built;
		} catch {
			// No usable credential yet (a fresh install) → stay deferred. We do NOT cache the
			// failure: the NEXT call re-attempts the build, so a credential written after boot is
			// picked up on the next request (the live pre-auth → authenticated transition, b-AC-3).
			return null;
		}
	};

	// A structural StorageClient: only the public surface (`query`/`connect`/`endpoint`) is used by
	// daemon consumers, so the deferred wrapper implements exactly that. The single cast at this
	// factory boundary keeps every call site untouched (the same `as StorageClient` posture the
	// fakes in tests use), while the wrapper is fully type-checked against the public members it forwards.
	const lazy: StorageQuery & {
		connect(scope: QueryScope): Promise<QueryResult>;
		readonly endpoint: string;
		meterSnapshot(): ReturnType<StorageClient["meterSnapshot"]>;
		meterLogLine(): string;
	} = {
		get endpoint(): string {
			// Before the first successful build there is no resolved endpoint; report a stable
			// placeholder (no secret, diagnostics-only) rather than reading creds eagerly here.
			return tryBuild()?.endpoint ?? "pending-credentials";
		},
		meterSnapshot(): ReturnType<StorageClient["meterSnapshot"]> {
			return tryBuild()?.meterSnapshot() ?? meter.snapshot();
		},
		meterLogLine(): string {
			return tryBuild()?.meterLogLine() ?? meter.formatLogLine();
		},
		async connect(scope: QueryScope): Promise<QueryResult> {
			return this.query("SELECT 1", scope);
		},
		async query(sql: string, scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
			const client = tryBuild();
			if (client === null) {
				// No credential on disk/env yet — the daemon is in the pre-auth phase (PRD-050b).
				// Return a typed connection_error so the DeepLake-backed seam shows its empty/"connect"
				// state instead of throwing a 500 (b-AC-1). No token, no secret, no stack.
				return connectionError("no DeepLake credential resolved yet (pre-auth phase)");
			}
			return client.query(sql, scope, opts);
		},
	};
	return lazy as unknown as StorageClient;
}

/** Re-export the structural query contract Wave 2 codes against. */
export type { StorageQuery as StorageClientQuery };
