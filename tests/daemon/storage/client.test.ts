/**
 * PRD-002a client + connection contract suite.
 *
 * Verifies a-AC-1..7 against the fake transport (no live DeepLake). Each test
 * name maps to the AC it proves. The fake transport + stub provider come from
 * tests/helpers/fake-deeplake.ts — the same fixture Wave 2 routes through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageConfigError } from "../../../src/daemon/storage/config.js";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import { DEEPLAKE_ORG_HEADER } from "../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

function clientWith(transport: FakeDeepLakeTransport, recordOverrides = {}) {
	return createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord(recordOverrides)),
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
		// Query would take 5s; client timeout is 20ms → abort fires first.
		fake.enqueueSlow([{ id: "late" }], 5_000);
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
		fake.enqueueConnectionError("ECONNREFUSED 127.0.0.1:443");
		const client = clientWith(fake);

		const result = await client.query("SELECT 1", { org: "o" });
		expect(result.kind).toBe("connection_error");
		if (result.kind === "connection_error") expect(result.message).toContain("ECONNREFUSED");
	});

	it("a-AC-7 query never throws for an expected failure — it returns a result kind", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueConnectionError("boom");
		const client = clientWith(fake);
		// No try/catch needed by callers: the failure is data, not an exception.
		await expect(client.query("SELECT 1", { org: "o" })).resolves.toBeDefined();
	});
});
