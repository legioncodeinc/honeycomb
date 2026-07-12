/**
 * PRD-002c Lazy Schema Healing — proves c-AC-1..7.
 *
 * Drives the heal engine through the fake transport's SQL-aware Responder so a
 * single test can script: first INSERT → query_error, CREATE → ok, introspection
 * SELECT → canned columns, ALTER → ok, retried INSERT → ok. Each AC has a named
 * test.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient, type StorageClient } from "../../../src/daemon/storage/index.js";
import {
	classifyFailure,
	type HealTarget,
	healColumns,
	withHeal,
} from "../../../src/daemon/storage/heal.js";
import { SchemaDefinitionError, validateColumnDefs } from "../../../src/daemon/storage/schema.js";
import { queryError } from "../../../src/daemon/storage/result.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";
import type { TransportRequest } from "../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

const COLUMNS = [
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
] as const;

const TARGET: HealTarget = { table: "memory", columns: COLUMNS };

function clientWith(responder: (req: TransportRequest) => unknown): StorageClient {
	const fake = new FakeDeepLakeTransport(responder as never);
	const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return client;
}

describe("PRD-002c lazy schema healing", () => {
	it("c-AC-1 missing-table write creates from the ColumnDef array and retries once", async () => {
		const seen: string[] = [];
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'relation "memory" does not exist', 404);
				return []; // retry succeeds
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				return [{ column_name: "id" }, { column_name: "path" }, { column_name: "version" }];
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		expect(res.kind).toBe("ok");
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "memory"/.test(s))).toBe(true);
		expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2); // original + one retry
	});

	it("c-AC-2 missing-column write reads information_schema, diffs, adds only missing", async () => {
		const altered: string[] = [];
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'column "version" does not exist', 400);
				return [];
			}
			if (/information_schema\.columns/.test(req.sql)) {
				// `version` is missing; id + path are present.
				return [{ column_name: "id" }, { column_name: "path" }];
			}
			if (/^ALTER TABLE/.test(req.sql)) {
				altered.push(req.sql);
				return [];
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		expect(res.kind).toBe("ok");
		// Exactly one ALTER, for the only missing column.
		expect(altered.length).toBe(1);
		expect(altered[0]).toMatch(/ADD COLUMN version BIGINT/);
		// No CREATE TABLE on a missing-column path.
		expect(altered[0]).not.toMatch(/CREATE TABLE/);
	});

	it("c-AC-3 permission error rethrows unchanged, never creates or alters", async () => {
		const issued: string[] = [];
		const fake = new FakeDeepLakeTransport((req) => {
			issued.push(req.sql);
			if (/^INSERT/.test(req.sql)) throw new TransportError("query", "permission denied for table memory", 403);
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		expect(res.kind).toBe("query_error");
		// Only the single failing INSERT went out — no CREATE/ALTER/SELECT.
		expect(issued.length).toBe(1);
		expect(issued.some((s) => /CREATE|ALTER|information_schema/.test(s))).toBe(false);
	});

	it("c-AC-4 a heal that still fails the retry rethrows, no second retry loop", async () => {
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				throw new TransportError("query", 'column "version" does not exist', 400);
			}
			if (/information_schema\.columns/.test(req.sql)) return [{ column_name: "id" }, { column_name: "path" }];
			if (/^ALTER TABLE/.test(req.sql)) return [];
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		expect(res.kind).toBe("query_error");
		// original + exactly one retry = 2 attempts, never a third.
		expect(insertAttempts).toBe(2);
	});

	it("c-AC-5 a NOT NULL column without DEFAULT is rejected at load by the guard", () => {
		expect(() =>
			validateColumnDefs("BAD", [{ name: "x", sql: "TEXT NOT NULL" }]),
		).toThrow(SchemaDefinitionError);
		expect(() =>
			validateColumnDefs("BAD", [{ name: "x", sql: "TEXT NOT NULL" }]),
		).toThrow(/NOT NULL but has no DEFAULT/);
		// A NOT NULL column WITH a default passes; a nullable column passes.
		expect(() => validateColumnDefs("OK", COLUMNS)).not.toThrow();
		expect(() => validateColumnDefs("OK", [{ name: "emb", sql: "FLOAT4[]" }])).not.toThrow();
	});

	it("c-AC-6 two workers healing the same table converge (IF NOT EXISTS + add-only-missing)", async () => {
		// Worker A's ALTER loses the race: the column "already exists" because
		// worker B added it. Re-verification finds it present → treated as success.
		let introspectCalls = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			if (/information_schema\.columns/.test(req.sql)) {
				introspectCalls++;
				// First read: version missing. Re-verify read: version now present
				// (worker B added it during our race).
				return introspectCalls === 1
					? [{ column_name: "id" }, { column_name: "path" }]
					: [{ column_name: "id" }, { column_name: "path" }, { column_name: "version" }];
			}
			if (/^ALTER TABLE/.test(req.sql)) {
				throw new TransportError("query", 'column "version" already exists', 500);
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await healColumns(client, TARGET, SCOPE);
		// The diff said `version` was missing; the ALTER raced and re-verify
		// confirmed it — no throw, converged to the single-heal result.
		expect(res.missing).toEqual(["version"]);
		expect(res.altered).toEqual([]); // we did not win the ALTER, but converged.
	});

	it("c-AC-7 every heal identifier passes sqlIdent (a bad table name throws, no ALTER/CREATE emitted)", async () => {
		// The introspection SELECT filters `information_schema` by the table NAME
		// as a VALUE (sqlStr-escaped) — legitimately. The identifier guard fires
		// where the name is interpolated as an IDENTIFIER: the ALTER/CREATE. So a
		// bad table name throws via sqlIdent in buildAddColumnSql, and crucially no
		// ALTER or CREATE statement (the identifier-interpolated ones) ever goes out.
		const fake = new FakeDeepLakeTransport((req: TransportRequest) => {
			// Force a missing-column diff so the heal reaches the ALTER builder.
			if (/information_schema\.columns/.test(req.sql)) return [{ column_name: "id" }];
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const badTarget: HealTarget = { table: "memory; DROP", columns: COLUMNS };
		await expect(healColumns(client, badTarget, SCOPE)).rejects.toThrow(/Invalid SQL identifier/);
		// No ALTER or CREATE (the identifier-interpolated statements) reached the wire.
		expect(fake.requests.some((r) => /^ALTER|^CREATE/.test(r.sql))).toBe(false);
	});

	it("classifyFailure routes messages correctly (unit guard for the engine)", () => {
		expect(classifyFailure('relation "memory" does not exist')).toBe("missing-table");
		expect(classifyFailure('column "version" does not exist')).toBe("missing-column");
		expect(classifyFailure("permission denied for table memory")).toBe("other");
		expect(classifyFailure("syntax error near SELECT")).toBe("other");
		expect(classifyFailure(undefined)).toBe("other");
	});

	it("classifyFailure matches DeepLake's REAL wire phrasing (BUG-04 live-grounded)", () => {
		// Captured read-only against the live hosted backend (api.deeplake.ai, workspace
		// `apiary`) — the client message is the transport's `${status}: ${body.slice(0,200)}`.
		// These strings REFUTE the BUG-04 leading hypothesis that DeepLake's phrasing evades
		// `classifyFailure`: a real missing-column / missing-table DeepLake error DOES route to
		// heal, so the dedup probe heals-then-inserts rather than dropping the memory. The
		// residual `query_error` the register saw is therefore a NON-schema failure (5xx flap /
		// 402 balance / permission), correctly routed to `other`.
		const missingColumn =
			'400: {"error":"Column does not exist: column \\"content_hash\\" does not exist","code":"INVALID_REQUEST","request_id":"x"}';
		const missingTable =
			'400: {"error":"Table does not exist: relation \\"memories\\" does not exist","code":"INVALID_REQUEST","request_id":"x"}';
		expect(classifyFailure(missingColumn)).toBe("missing-column");
		expect(classifyFailure(missingTable)).toBe("missing-table");
		// A degraded-window flap / balance / auth error is NOT a schema gap → stays `other`.
		expect(classifyFailure('503: {"error":"service unavailable"}')).toBe("other");
		expect(classifyFailure('402: {"error":"insufficient balance"}')).toBe("other");
	});

	it("introspection transient-fails once then succeeds → heal completes (missing-column)", async () => {
		// The information_schema SELECT flaps with a transient 503 on its first
		// attempt, then succeeds on the bounded retry — so the column diff still
		// runs and the missing column is ALTERed in. Proves readColumnSet retries
		// transient failures rather than throwing on the first flap.
		let introspectAttempts = 0;
		const altered: string[] = [];
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'column "version" does not exist', 400);
				return [];
			}
			if (/information_schema\.columns/.test(req.sql)) {
				introspectAttempts++;
				// First introspection read flaps (transient 5xx); second succeeds.
				if (introspectAttempts === 1) throw new TransportError("query", "503: upstream segment unavailable", 503);
				return [{ column_name: "id" }, { column_name: "path" }];
			}
			if (/^ALTER TABLE/.test(req.sql)) {
				altered.push(req.sql);
				return [];
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		expect(res.kind).toBe("ok");
		expect(introspectAttempts).toBe(2); // flapped once, retried, then succeeded.
		expect(altered.length).toBe(1); // the diff still ran and added the missing column.
		expect(altered[0]).toMatch(/ADD COLUMN version BIGINT/);
	});

	it("introspection transient-fails persistently → withHeal still does the write retry (missing-table, no throw)", async () => {
		// The table is missing → CREATE TABLE succeeds with the full ColumnDef.
		// Every introspection read then flaps transiently (connection error) and
		// never recovers. withHeal must NOT surface a 500: it falls back to the
		// single write retry, which succeeds against the freshly-created table.
		let introspectAttempts = 0;
		let insertAttempts = 0;
		let created = false;
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'relation "memory" does not exist', 404);
				return []; // retry succeeds — the table now exists.
			}
			if (/^CREATE TABLE/.test(req.sql)) {
				created = true;
				return [];
			}
			if (/information_schema\.columns/.test(req.sql)) {
				introspectAttempts++;
				// Persistent transient flap — never settles.
				throw new TransportError("connection", "ECONNRESET");
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		// No throw to the caller; the write retry is the honest answer.
		expect(res.kind).toBe("ok");
		expect(created).toBe(true);
		expect(insertAttempts).toBe(2); // original + one retry, exactly.
		expect(introspectAttempts).toBeGreaterThan(1); // it retried the flap before giving up.
	});

	it("a genuine ALTER failure still propagates HealFailure (not swallowed as a flap)", async () => {
		// Introspection succeeds and reports `version` missing; the ALTER then fails
		// with a NON-"already exists" error. That is a real schema problem (phase
		// "alter"), not an introspection flap, so withHeal must let it propagate.
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^INSERT/.test(req.sql)) throw new TransportError("query", 'column "version" does not exist', 400);
			if (/information_schema\.columns/.test(req.sql)) return [{ column_name: "id" }, { column_name: "path" }];
			if (/^ALTER TABLE/.test(req.sql)) {
				throw new TransportError("query", "permission denied to alter table memory", 403);
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		await expect(
			withHeal(client, TARGET, SCOPE, () => client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE)),
		).rejects.toMatchObject({ name: "HealFailure", phase: "alter" });
	});

	it("a non-transient introspection query_error (permission) throws immediately, no pointless retries", async () => {
		// The introspection SELECT is rejected with a 403 permission error — a
		// deterministic, NON-transient failure. readColumnSet must throw on the
		// FIRST attempt (phase "introspection") with no retries; here that surfaces
		// through healColumns directly (not via withHeal's tolerant wrapper).
		let introspectAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			if (/information_schema\.columns/.test(req.sql)) {
				introspectAttempts++;
				throw new TransportError("query", "permission denied for relation information_schema.columns", 403);
			}
			return [];
		});
		const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		await expect(healColumns(client, TARGET, SCOPE)).rejects.toMatchObject({
			name: "HealFailure",
			phase: "introspection",
		});
		expect(introspectAttempts).toBe(1); // exactly one attempt — no retry on a deterministic rejection.
	});

	it("withHeal never heals a connection or timeout result (only query_error)", async () => {
		const client = clientWith((req) => {
			if (/^INSERT/.test(req.sql)) throw new TransportError("connection", "ECONNREFUSED");
			return [];
		});
		const res = await withHeal(client, TARGET, SCOPE, () =>
			client.query(`INSERT INTO "memory" (id) VALUES ('x')`, SCOPE),
		);
		expect(res.kind).toBe("connection_error");
		// Sanity: queryError helper still constructs the right shape (no dead import).
		expect(queryError("x", 404).kind).toBe("query_error");
	});
});
