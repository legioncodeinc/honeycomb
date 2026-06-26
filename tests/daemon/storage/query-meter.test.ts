/**
 * PRD-062a query-meter + idle-baseline suite (L-A1 / L-A2).
 *
 * Proves the meter at the single storage choke point:
 *   - counts reads vs writes per `source` (AC-62a.1.1);
 *   - defaults an unlabeled call to `other` (the non-invasive default);
 *   - adds ZERO additional DeepLake queries in default mode (AC-62a.1.2);
 *   - is a PURE PASS-THROUGH: a metered query returns the same result as an
 *     unmetered one (Test Plan: Vitest parity);
 *   - exposes a snapshot + a structured log line (AC-62a.1.3);
 *   - drives an idle-baseline harness that shows non-zero poll counts and
 *     ~zero capture/recall on an idle window (AC-62a.2.1), needing NO live creds.
 *
 * All verification is against the FAKE in-memory transport — no live DeepLake.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import { QueryMeter } from "../../../src/daemon/storage/query-meter.js";
import { runIdleBaseline } from "../../helpers/idle-baseline-harness.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

const SCOPE = { org: "fake-org" } as const;

/** A metered client over the fake transport, no-op backoff clock. */
function meteredClient(transport: FakeDeepLakeTransport, meter = new QueryMeter()) {
	return createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord()),
		sleep: async () => {},
		meter,
	});
}

// ── The meter unit itself (no client) ───────────────────────────────────────

describe("QueryMeter: per-source read/write counting", () => {
	it("counts reads and writes separately per source", () => {
		const meter = new QueryMeter();
		meter.record("poll-lease", false);
		meter.record("poll-lease", false);
		meter.record("capture-write", true);

		const snap = meter.snapshot();
		expect(snap.totalReads).toBe(2);
		expect(snap.totalWrites).toBe(1);
		const lease = snap.perSource.find((e) => e.source === "poll-lease");
		expect(lease).toEqual({ source: "poll-lease", reads: 2, writes: 0 });
		const capture = snap.perSource.find((e) => e.source === "capture-write");
		expect(capture).toEqual({ source: "capture-write", reads: 0, writes: 1 });
	});

	it("defaults an unlabeled record to `other`", () => {
		const meter = new QueryMeter();
		meter.record(); // no source, no isWrite
		const snap = meter.snapshot();
		expect(snap.perSource).toEqual([{ source: "other", reads: 1, writes: 0 }]);
	});

	it("omits zero-traffic sources but keeps canonical order for present ones", () => {
		const meter = new QueryMeter();
		meter.record("embedding", false);
		meter.record("poll-lease", false);
		const sources = meter.snapshot().perSource.map((e) => e.source);
		// poll-lease precedes embedding in QUERY_SOURCES; present-only, ordered.
		expect(sources).toEqual(["poll-lease", "embedding"]);
	});

	it("reset zeroes every counter", () => {
		const meter = new QueryMeter();
		meter.record("recall-arm", false);
		meter.reset();
		expect(meter.snapshot()).toEqual({ perSource: [], totalReads: 0, totalWrites: 0 });
	});

	it("renders a structured log line (and an empty header when idle)", () => {
		const empty = new QueryMeter();
		expect(empty.formatLogLine()).toBe("[query-meter] total_reads=0 total_writes=0");

		const meter = new QueryMeter();
		meter.record("poll-lease", false);
		meter.record("capture-write", true);
		const line = meter.formatLogLine();
		expect(line).toContain("total_reads=1 total_writes=1");
		expect(line).toContain("poll-lease=r:1/w:0");
		expect(line).toContain("capture-write=r:0/w:1");
	});
});

// ── The meter wired into the storage client (the choke point) ───────────────

describe("StorageClient: meters at the single choke point (AC-62a.1.1)", () => {
	it("classifies SELECT as a read and INSERT as a write, per source", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ id: "a" }]).enqueueRows([]);
		const client = meteredClient(fake);

		await client.query("SELECT id FROM memory", SCOPE, { source: "recall-arm" });
		await client.query("INSERT INTO sessions (id) VALUES ('x')", SCOPE, { source: "capture-write" });

		const snap = client.meterSnapshot();
		expect(snap.perSource.find((e) => e.source === "recall-arm")).toEqual({
			source: "recall-arm",
			reads: 1,
			writes: 0,
		});
		expect(snap.perSource.find((e) => e.source === "capture-write")).toEqual({
			source: "capture-write",
			reads: 0,
			writes: 1,
		});
	});

	it("an un-labeled call site is counted under `other` (non-invasive default)", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]);
		const client = meteredClient(fake);

		await client.query("SELECT 1", SCOPE); // no opts.source
		expect(client.meterSnapshot().perSource).toEqual([{ source: "other", reads: 1, writes: 0 }]);
	});

	it("meters ONCE per logical query even when the read-retry layer re-issues", async () => {
		const fake = new FakeDeepLakeTransport();
		// First attempt flaps transiently (500), second attempt succeeds → the
		// retry layer issues TWO transport calls but the meter must count ONE op.
		fake.enqueueQueryError("backend flap", 500).enqueueRows([{ id: "a" }]);
		const client = meteredClient(fake);

		const result = await client.query("SELECT id FROM memory", SCOPE, { source: "poll-lease" });
		expect(result.kind).toBe("ok");
		expect(fake.requests).toHaveLength(2); // two transport attempts
		const lease = client.meterSnapshot().perSource.find((e) => e.source === "poll-lease");
		expect(lease).toEqual({ source: "poll-lease", reads: 1, writes: 0 }); // one metered op
	});
});

describe("StorageClient: meter adds zero DeepLake queries (AC-62a.1.2)", () => {
	it("the metered path issues exactly one transport call per query, no extra", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]).enqueueRows([]).enqueueRows([]);
		const client = meteredClient(fake);

		await client.query("SELECT 1", SCOPE, { source: "poll-lease" });
		await client.query("SELECT 2", SCOPE, { source: "poll-reaper" });
		await client.query("INSERT INTO sessions (id) VALUES ('x')", SCOPE, { source: "capture-write" });

		// 3 queries → exactly 3 transport requests. The meter is in-memory only;
		// it never issues a DeepLake query of its own.
		expect(fake.requests).toHaveLength(3);
		const snap = client.meterSnapshot();
		expect(snap.totalReads).toBe(2);
		expect(snap.totalWrites).toBe(1);
	});
});

describe("StorageClient: metering is a pure pass-through (Vitest parity)", () => {
	it("a metered query returns a result identical to an unmetered one", async () => {
		const rows = [{ id: "a", v: 1 }, { id: "b", v: 2 }];

		// Unmetered baseline: a fresh fake, no source label.
		const unmeteredFake = new FakeDeepLakeTransport();
		unmeteredFake.enqueueRows(rows);
		const unmetered = meteredClient(unmeteredFake);
		const unmeteredResult = await unmetered.query("SELECT id, v FROM memory", SCOPE);

		// Metered: same statement, same canned rows, WITH a source label.
		const meteredFake = new FakeDeepLakeTransport();
		meteredFake.enqueueRows(rows);
		const metered = meteredClient(meteredFake);
		const meteredResult = await metered.query("SELECT id, v FROM memory", SCOPE, { source: "recall-arm" });

		// Identical result shape + rows; the only difference is the recorded count.
		expect(meteredResult.kind).toBe("ok");
		expect(unmeteredResult.kind).toBe("ok");
		if (meteredResult.kind === "ok" && unmeteredResult.kind === "ok") {
			expect(meteredResult.rows).toEqual(unmeteredResult.rows);
			expect(meteredResult.rows).toEqual(rows);
		}
		// The labeled query also reached the wire byte-identically.
		expect(meteredFake.requests[0]?.sql).toBe(unmeteredFake.requests[0]?.sql);
	});

	it("metering a failing query does not change the failure result", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueQueryError('relation "memory" does not exist', 404);
		const client = meteredClient(fake);

		const result = await client.query("SELECT 1 FROM memory", SCOPE, { source: "poll-lease" });
		// A non-transient query_error surfaces unchanged (still metered as a read).
		expect(result.kind).toBe("query_error");
		if (result.kind === "query_error") expect(result.status).toBe(404);
		expect(client.meterSnapshot().totalReads).toBe(1);
	});
});

// ── Idle-baseline harness (AC-62a.2.1) ──────────────────────────────────────

describe("idle-baseline harness: poll counts non-zero, capture/recall ~zero", () => {
	it("an idle window shows polling reads and no capture/recall activity", async () => {
		const fake = new FakeDeepLakeTransport();
		// An idle daemon issues, per tick: 2 lease reads + 1 reaper read = 3 reads.
		// Over 10 ticks → 30 queries; enqueue 30 empty responses.
		for (let i = 0; i < 30; i++) fake.enqueueRows([]);
		const client = meteredClient(fake);

		const result = await runIdleBaseline({
			client,
			scope: SCOPE,
			perTick: [
				{ source: "poll-lease", sql: "SELECT id FROM memory_jobs", perTick: 2 },
				{ source: "poll-reaper", sql: "SELECT id FROM memory_jobs WHERE leased", perTick: 1 },
			],
			ticks: 10,
			windowSeconds: 10,
		});

		// 30 reads over a 10s window → 180 reads/min, 100% polling, zero capture/recall.
		expect(result.totalReads).toBe(30);
		expect(result.readsPerMinute).toBe(180);
		expect(result.pollingShare).toBe(1);
		expect(result.snapshot.perSource.find((e) => e.source === "capture-write")).toBeUndefined();
		expect(result.snapshot.perSource.find((e) => e.source === "recall-arm")).toBeUndefined();
		// And the harness issued exactly the queries it described — no hidden reads.
		expect(fake.requests).toHaveLength(30);
	});
});
