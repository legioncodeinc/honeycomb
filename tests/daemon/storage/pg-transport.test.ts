/**
 * PgDeepLakeTransport: the direct self-hosted Postgres backend.
 *
 * Verified against a FAKE pool injected via the `poolFactory` constructor param,
 * so there is NO live Postgres in CI (mirrors the fake-transport posture the
 * HTTP path uses). Each test proves one slice of the reverse-engineered contract:
 *
 *   (a) (G2) a CREATE SCHEMA + a SET search_path are issued for the request
 *       workspace BEFORE the statement, so the workspace == its own Postgres
 *       schema and unqualified table names resolve inside it.
 *   (b) rows pass through as StorageRow[] (the pure passthrough, G3).
 *   (c) (G1) a pg error message reaches TransportError.message UNMODIFIED, so
 *       heal.classifyFailure would still match `relation "x" does not exist`.
 *   (d) a workspace identifier carrying a double-quote is quote-escaped, never
 *       string-concatenated raw (no SQL injection via the workspace name).
 *
 * Plus the abort + connection-failure mappings the storage client relies on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../../../src/daemon/storage/heal.js";
import { PgDeepLakeTransport } from "../../../src/daemon/storage/pg-transport.js";
import type { StorageRow } from "../../../src/daemon/storage/result.js";
import { TransportError, type TransportRequest } from "../../../src/daemon/storage/transport.js";

/** A scriptable fake pg client that records every statement it is handed. */
class FakeClient {
	readonly queries: string[] = [];
	released = false;
	releaseArg: unknown;

	constructor(
		private readonly opts: {
			/** Rows to return, keyed by a predicate on the SQL (default: []). */
			rowsFor?: (sql: string) => StorageRow[] | undefined;
			/** Throw this error when the predicate matches (a server-side rejection). */
			errorFor?: (sql: string) => Error | undefined;
			/** When true for a SQL, the query never resolves (so an abort can win the race). */
			blockFor?: (sql: string) => boolean;
		} = {},
	) {}

	async query(sql: string): Promise<{ rows: StorageRow[] }> {
		this.queries.push(sql);
		const err = this.opts.errorFor?.(sql);
		if (err) throw err;
		if (this.opts.blockFor?.(sql)) {
			// Never settles: the transport's abort race must be what rejects.
			return new Promise<{ rows: StorageRow[] }>(() => {});
		}
		return { rows: this.opts.rowsFor?.(sql) ?? [] };
	}

	release(arg?: unknown): void {
		this.released = true;
		this.releaseArg = arg;
	}
}

/** A scriptable fake pg pool whose `connect()` hands out (and records) fake clients. */
class FakePool {
	readonly clients: FakeClient[] = [];

	constructor(
		private readonly makeClient: () => FakeClient,
		private readonly connectError?: Error,
	) {}

	async connect(): Promise<FakeClient> {
		if (this.connectError) throw this.connectError;
		const c = this.makeClient();
		this.clients.push(c);
		return c;
	}
}

/** Build a transport bound to a fake pool (cast at the seam, like the prod factory's pool). */
function transportWith(pool: FakePool): PgDeepLakeTransport {
	return new PgDeepLakeTransport(
		"postgres://user@localhost:5432/deeplake",
		async () => pool as unknown as import("pg").Pool,
	);
}

/** A TransportRequest with a fresh, un-aborted signal (returns the controller for abort tests). */
function makeReq(sql: string, workspace: string): { req: TransportRequest; controller: AbortController } {
	const controller = new AbortController();
	return {
		controller,
		req: { sql, org: "local", workspace, signal: controller.signal },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PgDeepLakeTransport: workspace == Postgres schema (G2)", () => {
	it("issues CREATE SCHEMA then SET search_path for the workspace BEFORE the statement", async () => {
		const pool = new FakePool(() => new FakeClient({ rowsFor: () => [{ id: "a" }] }));
		const transport = transportWith(pool);
		const { req } = makeReq("SELECT id FROM memory", "team-blue");

		await transport.query(req);

		const client = pool.clients[0];
		expect(client).toBeDefined();
		const issued = (client as FakeClient).queries;
		// Order matters: schema, then search_path, then the actual statement.
		expect(issued[0]).toBe('CREATE SCHEMA IF NOT EXISTS "team-blue"');
		expect(issued[1]).toBe('SET search_path TO "team-blue", public');
		expect(issued[2]).toBe("SELECT id FROM memory");
	});

	it("creates the schema once per workspace (cached) but SETs search_path every query", async () => {
		const pool = new FakePool(() => new FakeClient());
		const transport = transportWith(pool);

		await transport.query(makeReq("SELECT 1", "ws").req);
		await transport.query(makeReq("SELECT 2", "ws").req);

		const all = pool.clients.flatMap((c) => c.queries);
		expect(all.filter((q) => q.startsWith("CREATE SCHEMA"))).toHaveLength(1);
		expect(all.filter((q) => q.startsWith("SET search_path"))).toHaveLength(2);
	});
});

describe("PgDeepLakeTransport: rows pass through (G3)", () => {
	it("returns res.rows verbatim as StorageRow[]", async () => {
		const rows = [
			{ id: "a", version: 2 },
			{ id: "b", version: 5 },
		];
		const pool = new FakePool(() => new FakeClient({ rowsFor: (sql) => (sql.includes("memory") ? rows : []) }));
		const transport = transportWith(pool);

		const out = await transport.query(makeReq("SELECT id, version FROM memory", "ws").req);

		expect(out).toEqual(rows);
		expect(pool.clients[0]?.released).toBe(true);
	});
});

describe("PgDeepLakeTransport: RAW error text reaches the client (G1)", () => {
	it("passes the pg error message UNMODIFIED so heal.classifyFailure still matches", async () => {
		const raw = 'relation "memory" does not exist';
		const pool = new FakePool(
			() => new FakeClient({ errorFor: (sql) => (sql.startsWith("SELECT") ? new Error(raw) : undefined) }),
		);
		const transport = transportWith(pool);

		const err = await transport.query(makeReq("SELECT 1 FROM memory", "ws").req).catch((e) => e);

		expect(err).toBeInstanceOf(TransportError);
		expect((err as TransportError).kind).toBe("query");
		// The message is byte-identical (no JSON-wrapping that would escape the quotes).
		expect((err as TransportError).message).toBe(raw);
		// And the heal classifier still routes it to missing-table off the raw text.
		expect(classifyFailure((err as TransportError).message)).toBe("missing-table");
		// The connection was returned to the pool (a normal rejection, not destroyed).
		expect(pool.clients[0]?.released).toBe(true);
		expect(pool.clients[0]?.releaseArg).toBeUndefined();
	});
});

describe("PgDeepLakeTransport: workspace identifiers are quote-escaped (no injection)", () => {
	it("escapes a double-quote in the workspace name rather than concatenating it raw", async () => {
		const pool = new FakePool(() => new FakeClient());
		const transport = transportWith(pool);
		// A hostile workspace that would break out of the identifier if concatenated raw.
		const evil = 'ws"; DROP SCHEMA public; --';
		await transport.query(makeReq("SELECT 1", evil).req);

		const issued = pool.clients[0]?.queries ?? [];
		// The embedded quote is doubled and the whole name stays inside one quoted identifier.
		expect(issued[0]).toBe('CREATE SCHEMA IF NOT EXISTS "ws""; DROP SCHEMA public; --"');
		expect(issued[1]).toBe('SET search_path TO "ws""; DROP SCHEMA public; --", public');
		// No statement is a bare DROP, the injection never escaped the identifier.
		expect(issued.some((q) => q.trim().toUpperCase().startsWith("DROP"))).toBe(false);
	});
});

describe("PgDeepLakeTransport: abort + connection mappings", () => {
	it("rejects with a timeout when the signal aborts mid-query, and DESTROYS the connection", async () => {
		const pool = new FakePool(() => new FakeClient({ blockFor: (sql) => sql.startsWith("SELECT") }));
		const transport = transportWith(pool);
		const { req, controller } = makeReq("SELECT pg_sleep(60)", "ws");

		const pending = transport.query(req);
		controller.abort();
		const err = await pending.catch((e) => e);

		expect(err).toBeInstanceOf(TransportError);
		expect((err as TransportError).kind).toBe("timeout");
		// Destroyed (truthy release arg), so the in-flight statement does not linger
		// on a pooled connection handed to the next caller.
		expect(pool.clients[0]?.released).toBe(true);
		expect(pool.clients[0]?.releaseArg).toBeTruthy();
	});

	it("rejects with a timeout WITHOUT opening a connection when already aborted", async () => {
		const pool = new FakePool(() => new FakeClient());
		const transport = transportWith(pool);
		const { req, controller } = makeReq("SELECT 1", "ws");
		controller.abort();

		const err = await transport.query(req).catch((e) => e);

		expect(err).toBeInstanceOf(TransportError);
		expect((err as TransportError).kind).toBe("timeout");
		expect(pool.clients).toHaveLength(0); // never checked out a connection
	});

	it("maps a pool.connect() failure to a connection error", async () => {
		const pool = new FakePool(() => new FakeClient(), new Error("ECONNREFUSED 127.0.0.1:5432"));
		const transport = transportWith(pool);

		const err = await transport.query(makeReq("SELECT 1", "ws").req).catch((e) => e);

		expect(err).toBeInstanceOf(TransportError);
		expect((err as TransportError).kind).toBe("connection");
		expect((err as TransportError).message).toBe("ECONNREFUSED 127.0.0.1:5432");
	});
});
