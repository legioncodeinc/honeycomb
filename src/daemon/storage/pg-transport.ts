/**
 * Direct Postgres transport against Activeloop's `pg_deeplake` extension.
 *
 * This is the SECOND `DeepLakeTransport` implementation behind the same seam the
 * HTTP transport uses ({@link HttpDeepLakeTransport}). Instead of POSTing to a
 * DeepLake HTTP gateway, it connects DIRECTLY to a `pg_deeplake` Postgres URL
 * (`postgres://...`), so a self-hoster can run the open-source extension
 * (`quay.io/activeloopai/pg-deeplake`) and point honeycomb straight at it with
 * no gateway in the middle.
 *
 * Why this works as a pure passthrough (G3): `pg_deeplake` speaks honeycomb's
 * SQL dialect natively (`USING deeplake`, `float4[768]`, the `<#>` cosine
 * operator, `deeplake_index` BM25), so this transport never rewrites a
 * statement. It only (a) puts each workspace in its own Postgres schema and (b)
 * forwards `req.sql` verbatim, returning `result.rows` as `StorageRow[]`.
 *
 * Two hard-won contract points are baked in below so the next person does not
 * have to re-discover them:
 *
 *   (G1) RAW error text. `heal.ts` `classifyFailure` regex-matches the RAW pg
 *        error message (e.g. `relation "x" does not exist`). We therefore pass
 *        `err.message` through UNMODIFIED into `TransportError("query", ...)`.
 *        NEVER JSON-wrap it: JSON.stringify escapes the quotes
 *        (`relation \"x\" does not exist`) and the heal regexes stop matching,
 *        so schema-heal silently breaks.
 *
 *   (G2) Workspace == Postgres schema. honeycomb introspects
 *        `information_schema.columns WHERE table_schema = '<workspace>'` and
 *        then uses UNqualified table names. So this transport creates a schema
 *        per workspace (`CREATE SCHEMA IF NOT EXISTS "<ws>"`) and `SET
 *        search_path` to it on every checkout, so an unqualified `memory` table
 *        resolves inside the workspace's schema.
 *
 * The pg import is LAZY/dynamic (only loaded when a `postgres://` endpoint
 * selects this backend) and the pool factory is injectable so tests drive the
 * whole surface against a fake pool with no live Postgres.
 */

import type { StorageRow } from "./result.js";
import { type DeepLakeTransport, TransportError, type TransportRequest } from "./transport.js";

/**
 * Factory for the pg connection pool. Injectable so a test passes a fake pool
 * (no live Postgres); the default lazily imports `pg` and builds a real pool.
 */
export type PgPoolFactory = (connectionString: string) => Promise<import("pg").Pool>;

/**
 * The default pool factory. `pg` is an OPTIONAL dependency, dynamic-imported
 * HERE so it is loaded ONLY when this backend is actually used: the HTTP-only
 * path and the lean cloud bundles never need `pg` on disk (G4: this transport is
 * selected only for a `postgres://`/`postgresql://` endpoint).
 */
const defaultPoolFactory: PgPoolFactory = async (connectionString) => {
	// pg is CommonJS; under ESM interop the constructor may sit on the namespace
	// or on the default export depending on the resolver, so accept either (the
	// same `as unknown as ... & { default? }` shape the codebase uses for other
	// dynamically-imported CJS deps).
	type PgPoolCtor = typeof import("pg").Pool;
	const mod = (await import("pg")) as unknown as { Pool?: PgPoolCtor; default?: { Pool: PgPoolCtor } };
	const Pool = mod.Pool ?? mod.default?.Pool;
	if (Pool === undefined) throw new Error("pg module did not export Pool");
	return new Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000 });
};

/** Quote a Postgres identifier so a workspace name is NEVER string-concatenated raw into SQL. */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Extract a plain message from an unknown thrown value (G1: kept verbatim, never wrapped). */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Direct-to-Postgres transport for a self-hosted `pg_deeplake` backend. Behind
 * the same {@link DeepLakeTransport} seam as the HTTP transport, so the storage
 * client, heal, write, and vector layers are byte-identical regardless of which
 * backend is wired.
 */
export class PgDeepLakeTransport implements DeepLakeTransport {
	private readonly poolFactory: PgPoolFactory;
	/** Memoized pool: the factory runs at most once, on the first query. */
	private poolPromise: Promise<import("pg").Pool> | null = null;
	/**
	 * Workspaces whose schema we have already `CREATE SCHEMA IF NOT EXISTS`'d on
	 * this process, so we issue the create once per workspace, not once per query.
	 */
	private readonly ensuredSchemas = new Set<string>();

	constructor(
		private readonly connectionString: string,
		poolFactory: PgPoolFactory = defaultPoolFactory,
	) {
		this.poolFactory = poolFactory;
	}

	/** Build (once) and return the shared pool. */
	private async getPool(): Promise<import("pg").Pool> {
		if (this.poolPromise === null) this.poolPromise = this.poolFactory(this.connectionString);
		return this.poolPromise;
	}

	/**
	 * (G2) Ensure the workspace's Postgres schema exists. Cached in
	 * {@link ensuredSchemas} so the create is issued once per workspace per
	 * process. Raced against the abort signal so a slow CREATE during a statement
	 * timeout is honored too. The identifier is quoted, never concatenated raw.
	 */
	private async ensureSchema(
		client: import("pg").PoolClient,
		workspace: string,
		signal: AbortSignal,
		onAbort: () => void,
	): Promise<void> {
		if (this.ensuredSchemas.has(workspace)) return;
		await runWithAbort(client, `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(workspace)}`, signal, onAbort);
		this.ensuredSchemas.add(workspace);
	}

	async query(req: TransportRequest): Promise<StorageRow[]> {
		// The client's per-statement timeout may have already aborted before we
		// even checked out a connection. Surface a timeout immediately rather than
		// open a connection we would only have to tear down (the client maps a
		// transport timeout rejection onto a timeout result).
		if (req.signal.aborted) {
			throw new TransportError("timeout", "request aborted before query started");
		}

		const pool = await this.getPool();

		let client: import("pg").PoolClient;
		try {
			client = await pool.connect();
		} catch (err) {
			// No usable connection (refused socket, auth, exhausted pool). This is a
			// wire/connection failure, NOT a statement rejection.
			throw new TransportError("connection", messageOf(err));
		}

		// Set when the abort wins any race below, so the catch maps to a timeout
		// and the finally DESTROYS (does not pool-return) the connection.
		let aborted = false;
		const onAbort = (): void => {
			aborted = true;
		};
		try {
			// (G2) workspace == its own schema; SET search_path on every checkout
			// (pooled connections are reused, so the search_path must be re-set each
			// time). `public` stays on the path so the shared `pg_deeplake` functions
			// and `information_schema` resolve. EVERY statement (the schema setup AND
			// the query) is raced against the abort, so a timeout landing during
			// setup is honored and never blocks until the setup awaits settle.
			await this.ensureSchema(client, req.workspace, req.signal, onAbort);
			await runWithAbort(client, `SET search_path TO ${quoteIdent(req.workspace)}, public`, req.signal, onAbort);

			// (G3) pure-passthrough query, raced against the abort signal.
			return await runWithAbort(client, req.sql, req.signal, onAbort);
		} catch (err) {
			// The abort path: our timeout fired. The client relies on the transport
			// rejecting on abort, then classifies it as a timeout result.
			if (aborted || req.signal.aborted) {
				throw new TransportError("timeout", "request aborted by timeout signal");
			}
			if (err instanceof TransportError) throw err;
			// (G1) RAW pg error message, UNMODIFIED (NEVER JSON-wrapped) so
			// `heal.classifyFailure` still matches `relation "x" does not exist`
			// and friends and schema-heal keeps working.
			throw new TransportError("query", messageOf(err));
		} finally {
			if (aborted) {
				// Destroy the connection: an in-flight query may still be running on it,
				// so returning it to the pool would let that statement linger and
				// corrupt the next checkout. A truthy arg to release() removes it.
				client.release(new Error("aborted by timeout signal"));
			} else {
				client.release();
			}
		}
	}
}

/**
 * Run `sql` on `client` and resolve its rows, OR reject when `signal` aborts
 * first. The losing query promise is always settled (its rejection is consumed
 * by the attached handler) so an aborted-but-still-running statement never
 * produces an unhandled rejection. `sql` is forwarded VERBATIM (G3 passthrough);
 * upstream layers have already escaped it.
 */
function runWithAbort(
	client: import("pg").PoolClient,
	sql: string,
	signal: AbortSignal,
	onAbort: () => void,
): Promise<StorageRow[]> {
	return new Promise<StorageRow[]>((resolve, reject) => {
		const abortListener = (): void => {
			onAbort();
			reject(new TransportError("timeout", "request aborted by timeout signal"));
		};
		// The signal may have ALREADY aborted during the schema-setup awaits above;
		// `addEventListener` does not fire for an already-aborted signal, so check
		// explicitly first (otherwise an abort that landed mid-setup would hang).
		if (signal.aborted) {
			abortListener();
			return;
		}
		signal.addEventListener("abort", abortListener, { once: true });
		client.query(sql).then(
			(res) => {
				signal.removeEventListener("abort", abortListener);
				resolve(res.rows as StorageRow[]);
			},
			(err) => {
				// Consume the rejection even if the abort already settled the outer
				// promise, so the destroyed-connection query never goes unhandled.
				signal.removeEventListener("abort", abortListener);
				reject(err);
			},
		);
	});
}
