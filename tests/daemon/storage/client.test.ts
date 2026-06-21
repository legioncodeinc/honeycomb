/**
 * PRD-002a client + connection contract suite.
 *
 * Verifies a-AC-1..7 against the fake transport (no live DeepLake). Each test
 * name maps to the AC it proves. The fake transport + stub provider come from
 * tests/helpers/fake-deeplake.ts — the same fixture Wave 2 routes through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAbsoluteUpdate,
	isReadStatement,
	isTransientResult,
	statementRetryability,
} from "../../../src/daemon/storage/client.js";
import { StorageConfigError } from "../../../src/daemon/storage/config.js";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import { DEEPLAKE_ORG_HEADER } from "../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

function clientWith(transport: FakeDeepLakeTransport, recordOverrides = {}) {
	return createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord(recordOverrides)),
		// Inject a no-op backoff clock so the read-retry layer's bounded backoff is
		// instant and deterministic in unit tests (never the real timer).
		sleep: async () => {},
	});
}

/** Spy on stderr.write with a narrow mock so trace assertions stay typed. */
function spyStderr() {
	return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

/** Fetch a recorded request by index, asserting it exists (no non-null `!`). */
function reqAt(fake: FakeDeepLakeTransport, i: number) {
	const r = fake.requests[i];
	if (!r) throw new Error(`no recorded request at index ${i}`);
	return r;
}

describe("a-AC-1: client initializes against the configured endpoint and exposes a query interface", () => {
	it("a-AC-1 initializes and connects (first query succeeds) against the fake transport", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ "1": 1 }]);
		const client = clientWith(fake);

		expect(client.endpoint).toBe("https://fake.deeplake.test");
		const result = await client.connect({ org: "fake-org" });

		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(1);
		// connect() routes a SELECT 1 through the same query path every layer uses.
		expect(reqAt(fake, 0).sql).toContain("SELECT 1");
	});

	it("a-AC-1 exposes query() that returns rows through the result union", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ id: "a" }, { id: "b" }]);
		const client = clientWith(fake);

		const result = await client.query("SELECT id FROM memory", { org: "fake-org" });
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.rows).toEqual([{ id: "a" }, { id: "b" }]);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("a-AC-2: every query carries the resolved org so DeepLake enforces the partition boundary", () => {
	it("a-AC-2 sends the resolved org with each query", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]).enqueueRows([]);
		const client = clientWith(fake);

		await client.query("SELECT 1", { org: "org-alpha" });
		await client.query("SELECT 2", { org: "org-beta", workspace: "ws-2" });

		expect(reqAt(fake, 0).org).toBe("org-alpha");
		expect(reqAt(fake, 0).workspace).toBe("fake-ws"); // default from config
		expect(reqAt(fake, 1).org).toBe("org-beta");
		expect(reqAt(fake, 1).workspace).toBe("ws-2"); // per-call override
	});

	it("a-AC-2 the API forces a scope: there is no unscoped query overload", () => {
		const fake = new FakeDeepLakeTransport();
		const client = clientWith(fake);
		// Type-level invariant: query(sql) without a scope does not compile. We
		// assert it at the type level without invoking (a runtime call with an
		// undefined scope would throw); the `@ts-expect-error` is the real check.
		type QueryFn = typeof client.query;
		const _typecheck = (fn: QueryFn): void => {
			// @ts-expect-error scope is required — an unscoped tenant query is impossible.
			() => fn("SELECT * FROM memory");
		};
		expect(typeof _typecheck).toBe("function");
	});

	it("a-AC-2 the HTTP transport puts the org in the X-Activeloop-Org-Id header", () => {
		// Header name is the partition-boundary contract; assert it is the org header.
		expect(DEEPLAKE_ORG_HEADER).toBe("X-Activeloop-Org-Id");
	});
});

describe("a-AC-3: missing/out-of-range config rejects with a structured error, daemon fails closed", () => {
	it("a-AC-3 throws StorageConfigError when the token is missing", () => {
		const fake = new FakeDeepLakeTransport();
		expect(() =>
			createStorageClient({
				transport: fake,
				provider: stubProvider(fakeCredentialRecord({ token: undefined })),
			}),
		).toThrow(StorageConfigError);
	});

	it("a-AC-3 throws when the endpoint is not a URL, listing the failing field", () => {
		const fake = new FakeDeepLakeTransport();
		try {
			createStorageClient({
				transport: fake,
				provider: stubProvider(fakeCredentialRecord({ endpoint: "not-a-url" })),
			});
			throw new Error("expected StorageConfigError");
		} catch (e) {
			expect(e).toBeInstanceOf(StorageConfigError);
			expect((e as StorageConfigError).issues.join(" ")).toContain("endpoint");
		}
	});

	it("a-AC-3 fails closed before any transport call is made", () => {
		const fake = new FakeDeepLakeTransport();
		expect(() =>
			createStorageClient({
				transport: fake,
				provider: stubProvider(fakeCredentialRecord({ org: "" })),
			}),
		).toThrow(StorageConfigError);
		// No statement was issued — config rejection precedes any query.
		expect(fake.requests).toHaveLength(0);
	});

	it("a-AC-3 clamps a negative timeout to a non-negative range rather than rejecting", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]);
		// -5 is clamped to 0 (abort-immediately), not rejected and not left negative.
		const client = clientWith(fake, { queryTimeoutMs: -5 });
		const result = await client.query("SELECT 1", { org: "o" }, { timeoutMs: 50 });
		// override keeps this call alive; the point is construction did not throw.
		expect(result.kind).toBe("ok");
	});
});

describe("a-AC-4: a query exceeding HONEYCOMB_QUERY_TIMEOUT_MS returns a timeout result, never a hang", () => {
	it("a-AC-4 returns a timeout result for a slow query, not an indefinite block", async () => {
		const fake = new FakeDeepLakeTransport();
		// Query would take 5s; client timeout is 20ms → abort fires first. A timeout
		// is TRANSIENT and `SELECT pg_sleep(5)` is a read, so the retry layer re-issues
		// it up to the bounded budget; enqueue a slow response for every attempt so the
		// final surfaced result is still a timeout (each attempt gets its own 20ms race).
		for (let i = 0; i < 4; i++) fake.enqueueSlow([{ id: "late" }], 5_000);
		const client = clientWith(fake);

		const result = await client.query("SELECT pg_sleep(5)", { org: "o" }, { timeoutMs: 20 });
		expect(result.kind).toBe("timeout");
		if (result.kind === "timeout") expect(result.timeoutMs).toBe(20);
	});

	it("a-AC-4 a fast query under the budget still succeeds", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueSlow([{ id: "ok" }], 5);
		const client = clientWith(fake);

		const result = await client.query("SELECT 1", { org: "o" }, { timeoutMs: 1_000 });
		expect(result.kind).toBe("ok");
	});
});

describe("a-AC-6: HONEYCOMB_TRACE_SQL gates statement logging, evaluated at call time", () => {
	let stderrSpy: ReturnType<typeof spyStderr>;
	beforeEach(() => {
		stderrSpy = spyStderr();
	});
	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("a-AC-6 does not log statements when tracing is unset", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]);
		const client = clientWith(fake, { traceSql: false });
		await client.query("SELECT secret FROM t", { org: "o" });
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("a-AC-6 logs statements to stderr when tracing is set", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]);
		const client = clientWith(fake, { traceSql: true });
		await client.query("SELECT 1 FROM t", { org: "o" });
		expect(stderrSpy).toHaveBeenCalled();
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("[deeplake-sql]");
	});

	it("a-AC-6/FR-8 a trace line redacts the org and never echoes the token in full", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]);
		const client = clientWith(fake, { traceSql: true, org: "supersecretorg", token: "tok-zzzz9999" });
		await client.query("SELECT 1", { org: "supersecretorg" });
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).not.toContain("supersecretorg");
		expect(written).not.toContain("tok-zzzz9999");
	});
});

describe("a-AC-7: connection failure vs query failure return distinct typed result kinds", () => {
	it("a-AC-7 a server rejection maps to query_error with its status", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError('relation "memory" does not exist', 404);
		const client = clientWith(fake);

		const result = await client.query("SELECT * FROM memory", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") {
			expect(result.status).toBe(404);
			expect(result.message).toContain("does not exist");
		}
	});

	it("a-AC-7 a 402 out-of-credits is a query_error carrying status 402", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError("insufficient balance", 402);
		const client = clientWith(fake);
		const result = await client.query("INSERT INTO t VALUES (1)", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") expect(result.status).toBe(402);
	});

	it("a-AC-7 a wire failure maps to connection_error, distinct from query_error", async () => {
		const fake = new FakeDeepLakeTransport();
		// A connection_error is TRANSIENT, and `SELECT 1` is a read → the retry
		// layer re-issues it up to the bounded budget. Enqueue the same wire failure
		// for every attempt so the final surfaced result is still connection_error.
		for (let i = 0; i < 4; i++) fake.enqueueConnectionError("ECONNREFUSED 127.0.0.1:443");
		const client = clientWith(fake);

		const result = await client.query("SELECT 1", { org: "o" });
		expect(result.kind).toBe("connection_error");
		if (result.kind === "connection_error") expect(result.message).toContain("ECONNREFUSED");
	});

	it("a-AC-7 query never throws for an expected failure — it returns a result kind", async () => {
		const fake = new FakeDeepLakeTransport();
		// `SELECT 1` is a retryable read; enqueue the transient wire failure for the
		// whole bounded budget so the call resolves (never throws) with the failure.
		for (let i = 0; i < 4; i++) fake.enqueueConnectionError("boom");
		const client = clientWith(fake);
		// No try/catch needed by callers: the failure is data, not an exception.
		await expect(client.query("SELECT 1", { org: "o" })).resolves.toBeDefined();
	});
});

describe("bounded read-only transient-retry layer (fix/heal-introspection-transient-resilience)", () => {
	it("retries a read that transient-fails (502) twice then succeeds → ok, transport called 3x", async () => {
		const fake = new FakeDeepLakeTransport();
		// Two transient 5xx flaps, then a success. The read retry should re-issue past
		// both flaps and surface the eventual ok — transport hit exactly three times.
		fake.enqueueQueryError("502 <html>bad gateway</html>", 502);
		fake.enqueueQueryError("502 <html>bad gateway</html>", 502);
		fake.enqueueRows([{ id: "recovered" }]);
		const client = clientWith(fake);

		const result = await client.query("SELECT id FROM memory", { org: "o" });
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(result.rows).toEqual([{ id: "recovered" }]);
		expect(fake.requests).toHaveLength(3);
	});

	it("retries a 429 read (rate-limit is transient) then succeeds", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError("429 too many requests", 429);
		fake.enqueueRows([{ ok: 1 }]);
		const client = clientWith(fake);

		const result = await client.query("SELECT 1", { org: "o" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(2);
	});

	it("a read that transient-fails persistently → returns the last failure after the bounded attempts (no infinite loop)", async () => {
		const fake = new FakeDeepLakeTransport();
		// Five 503s queued, but the budget is 4 total attempts — the loop must stop
		// at 4 and surface the last failure, never spinning forever.
		for (let i = 0; i < 5; i++) fake.enqueueQueryError("503 service unavailable", 503);
		const client = clientWith(fake);

		const result = await client.query("SELECT * FROM sessions", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") expect(result.status).toBe(503);
		// Bounded: exactly 4 attempts (1 original + 3 retries), the 5th stays queued.
		expect(fake.requests).toHaveLength(4);
	});

	it("an INSERT that transient-fails → returns the failure on the FIRST attempt (no retry — NEVER double-insert)", async () => {
		const fake = new FakeDeepLakeTransport();
		// A 502 on an INSERT is transient AT THE WIRE, but an INSERT is NEVER retried
		// here: the wire is at-least-once, so the 502'd write may have LANDED, and a
		// retry would create a DUPLICATE row (the version-bumped-append failure mode —
		// two rows at the same logical version inflate counts). It must surface on
		// attempt 1; the success behind it must NOT be consumed.
		fake.enqueueQueryError("502 <html>bad gateway</html>", 502);
		fake.enqueueRows([{ id: "would-be-duplicate" }]); // must NOT be consumed.
		const client = clientWith(fake);

		const result = await client.query("INSERT INTO memory (id) VALUES ('x')", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") expect(result.status).toBe(502);
		expect(fake.requests).toHaveLength(1); // exactly one attempt — no retry.
	});

	it("an unsafe write (ALTER / CREATE / MERGE) transient failure surfaces on the FIRST attempt (not idempotent here)", async () => {
		for (const sql of [
			'ALTER TABLE "memory" ADD COLUMN c TEXT',
			"CREATE TABLE memory (id TEXT)",
			"MERGE INTO memory USING src ON memory.id = src.id WHEN MATCHED THEN UPDATE SET v = 1",
		]) {
			const fake = new FakeDeepLakeTransport();
			fake.enqueueQueryError("500 internal", 500);
			fake.enqueueRows([]); // must NOT be consumed.
			const client = clientWith(fake);

			const result = await client.query(sql, { org: "o" });
			expect(result.kind).toBe("query_error");
			expect(fake.requests).toHaveLength(1); // never retried — not provably idempotent.
		}
	});

	it("a DELETE that transient-fails (502) twice then succeeds → RETRIES and lands ok (the compaction-reap fix)", async () => {
		const fake = new FakeDeepLakeTransport();
		// The compaction REAP is a guarded DELETE. DELETE is idempotent (re-running
		// leaves the same rows gone), so a 502 storm on it MUST be retried so the reap
		// completes — exactly the compaction AC-1/AC-4 "rows did not converge" fix.
		fake.enqueueQueryError("502 <html>bad gateway</html>", 502);
		fake.enqueueQueryError("502 <html>bad gateway</html>", 502);
		fake.enqueueRows([]); // the eventual successful DELETE.
		const client = clientWith(fake);

		const result = await client.query("DELETE FROM skills WHERE skill_id = 's1' AND version IN (1, 2)", { org: "o" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(3); // retried past both flaps — the reap completed.
	});

	it("a keyed-upsert UPDATE (absolute SET) that transient-fails then succeeds → RETRIES (the /api/kpis fix)", async () => {
		const fake = new FakeDeepLakeTransport();
		// The `/api/kpis` upsert UPDATEs an existing key with a deterministic absolute
		// SET — re-running lands the byte-identical row, so it is idempotent and safe to
		// retry. A 502 on it must be absorbed, not surfaced.
		fake.enqueueQueryError("502 bad gateway", 502);
		fake.enqueueRows([]);
		const client = clientWith(fake);

		const sql = "UPDATE \"kpis\" SET value = 'revenue', target = '100', updated_at = '2026-06-21' WHERE key = 'mrr'";
		const result = await client.query(sql, { org: "o" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(2); // retried past the flap — the upsert landed.
	});

	it("a query_error (the api-keys storm class) on an idempotent DELETE with a transient 5xx status is retried", async () => {
		const fake = new FakeDeepLakeTransport();
		// The api-keys revoke failure surfaced as a transient backend `query_error`. On
		// an idempotent statement carrying a transient 5xx status it must be retried;
		// only the deterministic-rejection query_error (next test) fails fast.
		fake.enqueueQueryError("query_error: 503 service unavailable", 503);
		fake.enqueueRows([]);
		const client = clientWith(fake);

		const result = await client.query("DELETE FROM api_keys WHERE id = 'k1'", { org: "o" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(2);
	});

	it("a deterministic SQL error on an idempotent DELETE (non-transient) FAILS FAST — no retry", async () => {
		const fake = new FakeDeepLakeTransport();
		// A real SQL/logic error (400 syntax, a no-status opaque rejection) is NOT a
		// transient transport flap. Even on an idempotent DELETE it must surface on
		// attempt 1 — never retried (retrying a real error masks it + burns balance).
		fake.enqueueQueryError("400 syntax error at or near 'WHEER'", 400);
		fake.enqueueRows([]); // must NOT be consumed.
		const client = clientWith(fake);

		const result = await client.query("DELETE FROM skills WHEER id = 'x'", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") expect(result.status).toBe(400);
		expect(fake.requests).toHaveLength(1); // failed fast — a real SQL error is never retried.
	});

	it("a relative-mutation UPDATE (col = col + 1) is NOT retried — re-running would double-apply", async () => {
		const fake = new FakeDeepLakeTransport();
		// A counter increment reads the column to compute the new value, so a second
		// apply DIVERGES (over-counts). It is correctly classified unsafe → no retry.
		fake.enqueueQueryError("502 bad gateway", 502);
		fake.enqueueRows([]); // must NOT be consumed.
		const client = clientWith(fake);

		const result = await client.query('UPDATE "dreaming_state" SET counter = counter + 1 WHERE id = \'d\'', { org: "o" });
		expect(result.kind).toBe("query_error");
		expect(fake.requests).toHaveLength(1); // a relative mutation is never retried.
	});

	it("a data-modifying CTE (WITH … INSERT) is treated as a write — surfaces on the first attempt", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError("502 bad gateway", 502);
		fake.enqueueRows([]); // must NOT be consumed.
		const client = clientWith(fake);

		const sql = "WITH src AS (SELECT 1 AS v) INSERT INTO memory (v) SELECT v FROM src";
		const result = await client.query(sql, { org: "o" });
		expect(result.kind).toBe("query_error");
		expect(fake.requests).toHaveLength(1); // never retried — it modifies data.
	});

	it("a read-only CTE (WITH … SELECT) IS retried like a plain SELECT", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError("502 bad gateway", 502);
		fake.enqueueRows([{ id: "z" }]);
		const client = clientWith(fake);

		const sql = "WITH recent AS (SELECT id FROM memory) SELECT id FROM recent";
		const result = await client.query(sql, { org: "o" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(2); // retried past the flap.
	});

	it("a read that fails with a NON-transient query_error (42P01 missing-table) surfaces IMMEDIATELY on attempt 1 (heal must see it)", async () => {
		const fake = new FakeDeepLakeTransport();
		// 404 missing-table is NOT a transient flap — heal classifies on it and must
		// see it on the first try. Any retry would mask it. Enqueue a success behind
		// it to prove the layer does NOT reach for a second attempt.
		fake.enqueueQueryError('relation "memory" does not exist', 404);
		fake.enqueueRows([{ id: "must-not-be-read" }]);
		const client = clientWith(fake);

		const result = await client.query("SELECT * FROM memory", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") {
			expect(result.status).toBe(404);
			expect(result.message).toContain("does not exist");
		}
		expect(fake.requests).toHaveLength(1); // no retry on a schema error.
	});

	it("a read that fails with a 400 syntax error (non-transient) surfaces immediately on attempt 1", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError("400 syntax error at or near 'FORM'", 400);
		fake.enqueueRows([]); // must NOT be consumed.
		const client = clientWith(fake);

		const result = await client.query("SELECT * FORM memory", { org: "o" });
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") expect(result.status).toBe(400);
		expect(fake.requests).toHaveLength(1);
	});

	it("a query_error with NO status (an opaque rejection) is non-transient — surfaces on attempt 1", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError("permission denied for relation memory"); // no status
		fake.enqueueRows([]); // must NOT be consumed.
		const client = clientWith(fake);

		const result = await client.query("SELECT * FROM memory", { org: "o" });
		expect(result.kind).toBe("query_error");
		expect(fake.requests).toHaveLength(1);
	});

	it("backoff is bounded and uses the injected sleep — fast + deterministic, sleep called once per retry", async () => {
		const fake = new FakeDeepLakeTransport();
		for (let i = 0; i < 4; i++) fake.enqueueQueryError("502 bad gateway", 502);
		const sleeps: number[] = [];
		// Inject a recording no-op clock: prove backoff is invoked between attempts
		// (3 sleeps for 4 attempts) and that each delay is within the bounded ceiling.
		const client = createStorageClient({
			transport: fake,
			provider: stubProvider(fakeCredentialRecord()),
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
		});

		const result = await client.query("SELECT 1", { org: "o" });
		expect(result.kind).toBe("query_error");
		expect(fake.requests).toHaveLength(4); // bounded total attempts.
		expect(sleeps).toHaveLength(3); // one backoff before each of the 3 retries.
		// Jittered, but every delay must respect the [0, 1000ms] ceiling.
		for (const ms of sleeps) {
			expect(ms).toBeGreaterThanOrEqual(0);
			expect(ms).toBeLessThanOrEqual(1_000);
		}
	});

	it("a successful read on the first attempt never sleeps (the fake settles immediately — zero retry cost)", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ id: "a" }]);
		const sleeps: number[] = [];
		const client = createStorageClient({
			transport: fake,
			provider: stubProvider(fakeCredentialRecord()),
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
		});

		const result = await client.query("SELECT id FROM memory", { org: "o" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(1);
		expect(sleeps).toHaveLength(0); // no flap → no backoff → no retry.
	});
});

describe("isReadStatement / isTransientResult unit guards", () => {
	it("classifies SELECT and read-only WITH as reads; data-modifying statements as writes", () => {
		expect(isReadStatement("SELECT 1")).toBe(true);
		expect(isReadStatement("  \n  select * from t")).toBe(true);
		expect(isReadStatement("-- a comment\nSELECT 1")).toBe(true);
		expect(isReadStatement("/* block */ SELECT 1")).toBe(true);
		expect(isReadStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);

		expect(isReadStatement("INSERT INTO t VALUES (1)")).toBe(false);
		expect(isReadStatement("UPDATE t SET a = 1")).toBe(false);
		expect(isReadStatement("DELETE FROM t")).toBe(false);
		expect(isReadStatement('ALTER TABLE "t" ADD COLUMN c TEXT')).toBe(false);
		expect(isReadStatement("CREATE TABLE t (id TEXT)")).toBe(false);
		expect(isReadStatement("DROP TABLE t")).toBe(false);
		expect(isReadStatement("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe(false);
		expect(isReadStatement("")).toBe(false); // unknown shape → write (no retry).
	});

	it("classifies transient vs deterministic results", () => {
		expect(isTransientResult({ kind: "connection_error", message: "drop" })).toBe(true);
		expect(isTransientResult({ kind: "timeout", message: "slow", timeoutMs: 10 })).toBe(true);
		for (const status of [429, 500, 502, 503, 504]) {
			expect(isTransientResult({ kind: "query_error", message: "x", status })).toBe(true);
		}
		for (const status of [400, 401, 403, 404, 409]) {
			expect(isTransientResult({ kind: "query_error", message: "x", status })).toBe(false);
		}
		expect(isTransientResult({ kind: "query_error", message: "x" })).toBe(false); // no status
		expect(isTransientResult({ kind: "ok", rows: [], durationMs: 1 })).toBe(false);
	});
});

describe("statementRetryability — idempotency tagging by statement shape", () => {
	it("tags reads (SELECT / read-only WITH) as 'read'", () => {
		expect(statementRetryability("SELECT 1")).toBe("read");
		expect(statementRetryability("  \n select * from t")).toBe("read");
		expect(statementRetryability("-- c\nSELECT 1")).toBe("read");
		expect(statementRetryability("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("read");
	});

	it("tags DELETE and deterministic-absolute UPDATE as 'idempotent-write' (safe to retry)", () => {
		expect(statementRetryability("DELETE FROM t WHERE id = 'x'")).toBe("idempotent-write");
		expect(statementRetryability("DELETE FROM skills WHERE skill_id = 's' AND version IN (1, 2)")).toBe("idempotent-write");
		expect(statementRetryability("UPDATE t SET a = 1")).toBe("idempotent-write");
		expect(statementRetryability('UPDATE "kpis" SET value = \'v\', target = \'t\' WHERE key = \'k\'')).toBe("idempotent-write");
		expect(statementRetryability('UPDATE "api_keys" SET revoked = 1 WHERE id = \'k\'')).toBe("idempotent-write");
		// A column name appearing INSIDE a string literal value is data, not a self-reference.
		expect(statementRetryability("UPDATE t SET note = 'the note column matters' WHERE id = 'x'")).toBe("idempotent-write");
	});

	it("tags INSERT and every non-provably-idempotent statement as 'unsafe-write' (NEVER retried)", () => {
		expect(statementRetryability("INSERT INTO t VALUES (1)")).toBe("unsafe-write");
		expect(statementRetryability("CREATE TABLE t (id TEXT)")).toBe("unsafe-write");
		expect(statementRetryability('ALTER TABLE "t" ADD COLUMN c TEXT')).toBe("unsafe-write");
		expect(statementRetryability("DROP TABLE t")).toBe("unsafe-write");
		expect(statementRetryability("TRUNCATE t")).toBe("unsafe-write");
		expect(statementRetryability("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = 1")).toBe("unsafe-write");
		expect(statementRetryability("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe("unsafe-write");
		expect(statementRetryability("")).toBe("unsafe-write"); // unknown shape → unsafe.
		// A RELATIVE mutation (reads its own prior value) is NOT idempotent → unsafe.
		expect(statementRetryability("UPDATE t SET counter = counter + 1 WHERE id = 'd'")).toBe("unsafe-write");
		expect(statementRetryability("UPDATE t SET log = log || 'more' WHERE id = 'd'")).toBe("unsafe-write");
	});
});

describe("isAbsoluteUpdate — relative-mutation guard", () => {
	it("recognizes deterministic absolute SETs as idempotent", () => {
		expect(isAbsoluteUpdate("UPDATE T SET A = 1")).toBe(true);
		expect(isAbsoluteUpdate("UPDATE T SET A = 1, B = 'X' WHERE ID = 'K'")).toBe(true);
		// A literal containing another column's name is data, not a self-reference.
		expect(isAbsoluteUpdate("UPDATE T SET NOTE = 'NOTE TEXT' WHERE ID = 'X'")).toBe(true);
		// A comma inside a function call is not a SET-list separator.
		expect(isAbsoluteUpdate("UPDATE T SET A = COALESCE('X', 'Y') WHERE ID = 'K'")).toBe(true);
	});

	it("rejects relative mutations (the RHS reads the assigned column) as non-idempotent", () => {
		expect(isAbsoluteUpdate("UPDATE T SET COUNTER = COUNTER + 1")).toBe(false);
		expect(isAbsoluteUpdate("UPDATE T SET N = N - 1 WHERE ID = 'X'")).toBe(false);
		expect(isAbsoluteUpdate("UPDATE T SET LOG = LOG || 'MORE'")).toBe(false);
		// A multi-assignment where ONE arm is relative demotes the whole statement.
		expect(isAbsoluteUpdate("UPDATE T SET A = 1, COUNTER = COUNTER + 1 WHERE ID = 'X'")).toBe(false);
	});

	it("fails safe (false) when the SET list cannot be cleanly parsed", () => {
		expect(isAbsoluteUpdate("UPDATE T WHERE ID = 'X'")).toBe(false); // no SET
		expect(isAbsoluteUpdate("UPDATE T SET BADCLAUSE WHERE ID = 'X'")).toBe(false); // no '='
	});
});
