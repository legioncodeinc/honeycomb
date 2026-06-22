/**
 * PRD-034b FR-1/FR-6/FR-7 + impl note — the stress-harness ORCHESTRATION unit suite.
 *
 * Deterministic, NO live backend: the load is driven through the REAL StorageClient +
 * its REAL retry layer, but against the in-memory FakeDeepLakeTransport wrapped in the
 * RecordingTransport, with a no-op backoff sleep so the run is instant. These prove:
 *   - config dials resolve + clamp + are reproducible (FR-6);
 *   - the seeded RNG is deterministic (FR-6);
 *   - outcome/statement classification is correct;
 *   - the RecordingTransport captures the RAW per-attempt stream so raw-vs-effective
 *     shows the backend's true error rate vs the post-retry rate (the impl note);
 *   - runStress builds a well-formed, secret-free report and DROPs its tables (b-AC-1/7);
 *   - the human summary carries NO secret (b-AC-7).
 * Run in `npm run ci` (no creds, no daemon).
 */

import { describe, expect, it } from "vitest";

import { healTargetFor } from "../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../src/daemon/storage/index.js";
import { TransportError, type TransportRequest } from "../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../helpers/fake-deeplake.js";
import {
	classifyAttempt,
	DEFAULT_STRESS_CONFIG,
	kindOfSql,
	mulberry32,
	parseConcurrency,
	RecordingTransport,
	renderStressSummary,
	resolveStressConfig,
	runStress,
	STRESS_REPORT_SCHEMA_VERSION,
} from "../../src/eval/deeplake-stress.js";

// ── Config dials (FR-6) ──────────────────────────────────────────────────────

describe("resolveStressConfig (FR-6 dials)", () => {
	it("applies sane defaults for an empty config", () => {
		const c = resolveStressConfig({});
		expect(c).toEqual(DEFAULT_STRESS_CONFIG);
	});

	it("parses + clamps the dials and a CSV concurrency sweep", () => {
		const c = resolveStressConfig({
			concurrency: "8,1,4,4", // de-duped + sorted ascending
			operations: "50",
			versionsPerKey: "5",
			seed: "999",
		});
		expect(c.concurrency).toEqual([1, 4, 8]);
		expect(c.operations).toBe(50);
		expect(c.versionsPerKey).toBe(5);
		expect(c.seed).toBe(999);
	});

	it("clamps garbage dials to safe floors / defaults (never throws)", () => {
		const c = resolveStressConfig({
			concurrency: "0,-3", // both clamp up to 1 → de-duped to [1]
			operations: "-10", // clamps to 1
			versionsPerKey: "abc", // non-finite → default
			seed: "not-a-number", // non-finite → default seed
		});
		expect(c.concurrency).toEqual([1]);
		expect(c.operations).toBe(1);
		expect(c.versionsPerKey).toBe(DEFAULT_STRESS_CONFIG.versionsPerKey);
		expect(c.seed).toBe(DEFAULT_STRESS_CONFIG.seed);
	});

	it("falls back to the default sweep for a blank/garbage concurrency", () => {
		expect(parseConcurrency("", [2, 6])).toEqual([2, 6]);
		expect(parseConcurrency(undefined, [2, 6])).toEqual([2, 6]);
		expect(parseConcurrency([3, 1, 3], [9])).toEqual([1, 3]);
	});
});

// ── Seeded RNG reproducibility (FR-6) ────────────────────────────────────────

describe("mulberry32 (FR-6 reproducibility)", () => {
	it("yields an identical sequence for the same seed", () => {
		const a = mulberry32(1234);
		const b = mulberry32(1234);
		const seqA = [a(), a(), a(), a()];
		const seqB = [b(), b(), b(), b()];
		expect(seqA).toEqual(seqB);
		for (const x of seqA) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThan(1);
		}
	});

	it("yields a different sequence for a different seed", () => {
		const a = mulberry32(1);
		const b = mulberry32(2);
		expect(a()).not.toBe(b());
	});
});

// ── Classification ───────────────────────────────────────────────────────────

describe("classifyAttempt + kindOfSql", () => {
	it("maps a success (no error) to ok", () => {
		expect(classifyAttempt(undefined)).toBe("ok");
	});

	it("maps a TransportError to its outcome class by kind/status", () => {
		expect(classifyAttempt(new TransportError("timeout", "t"))).toBe("timeout");
		expect(classifyAttempt(new TransportError("connection", "c"))).toBe("connection");
		expect(classifyAttempt(new TransportError("query", "x", 502))).toBe("502");
		expect(classifyAttempt(new TransportError("query", "x", 429))).toBe("429");
		expect(classifyAttempt(new TransportError("query", "x", 404))).toBe("other"); // non-transient
		expect(classifyAttempt(new TransportError("query", "x"))).toBe("other"); // no status
	});

	it("maps a non-TransportError throw to connection (conservative)", () => {
		expect(classifyAttempt(new Error("boom"))).toBe("connection");
	});

	it("classifies the statement kind from the leading verb", () => {
		expect(kindOfSql("  INSERT INTO x ...")).toBe("insert");
		expect(kindOfSql("SELECT * FROM x")).toBe("select");
		expect(kindOfSql("DELETE FROM x")).toBe("delete");
		expect(kindOfSql("UPDATE x SET a=1")).toBe("update");
		expect(kindOfSql('DROP TABLE "x"')).toBe("other");
	});
});

// ── RecordingTransport raw-vs-effective capture (the impl-note headline) ──────

describe("RecordingTransport raw-vs-post-retry recording", () => {
	it("records EVERY transport attempt (raw), so a retried read shows all flaps", async () => {
		// A retryable SELECT that flaps 502 twice then succeeds. The client's retry layer
		// re-issues it; the recorder must capture all THREE round-trips (raw), even though
		// the operation EFFECTIVELY succeeded.
		let call = 0;
		const responder = (_req: TransportRequest) => {
			call += 1;
			if (call <= 2) throw new TransportError("query", "stale segment", 502);
			return [{ ok: 1 }];
		};
		const recorder = new RecordingTransport(new FakeDeepLakeTransport(responder));
		const client = createStorageClient({
			provider: stubProvider(fakeCredentialRecord()),
			transport: recorder,
			sleep: async () => {}, // no-op backoff → instant + deterministic
		});

		const res = await client.query("SELECT 1", { org: "fake-org", workspace: "fake-ws" });
		expect(res.kind).toBe("ok"); // effectively succeeded after retries

		// RAW: three attempts recorded — two 502 flaps + one ok.
		expect(recorder.attempts).toHaveLength(3);
		expect(recorder.attempts.map((a) => a.outcome)).toEqual(["502", "502", "ok"]);
		expect(recorder.attempts.every((a) => a.kind === "select")).toBe(true);
	});

	it("tags attempts with the concurrency level set out-of-band (FR-5)", async () => {
		const recorder = new RecordingTransport(new FakeDeepLakeTransport((_r) => [{ ok: 1 }]));
		const client = createStorageClient({
			provider: stubProvider(fakeCredentialRecord()),
			transport: recorder,
			sleep: async () => {},
		});
		recorder.setConcurrency(8);
		await client.query("SELECT 1", { org: "fake-org", workspace: "fake-ws" });
		expect(recorder.attempts[0]?.concurrency).toBe(8);
	});
});

// ── runStress end-to-end (FR-1 / b-AC-1 / b-AC-7) over the fake backend ──────

/**
 * A SQL-aware responder that emulates a healthy backend for the stress workload.
 * Every SELECT (the appendVersionBumped MAX(version) read AND the convergence read)
 * returns version 0 — so each append bumps to 1, 2, … AND the convergence read
 * reports a non-decreasing version that satisfies `minVersion`. We track the highest
 * version written per table-ish so the convergence SELECT reflects the writes.
 */
function makeHealthyResponder(): (req: TransportRequest) => unknown[] {
	let highestVersion = 0;
	return (req: TransportRequest) => {
		const head = req.sql.replace(/^\s+/, "").slice(0, 12).toUpperCase();
		if (head.startsWith("INSERT")) {
			// An INSERT carries the bumped version as a literal `, <n>)` tail; track the max
			// so the subsequent convergence SELECT can report a version that satisfies it.
			const m = req.sql.match(/(\d+)\s*\)\s*$/);
			if (m) highestVersion = Math.max(highestVersion, Number(m[1]));
			return [];
		}
		// MAX(version) read + convergence read: report the highest version written so the
		// next append bumps from it and the convergence predicate (version >= last) holds.
		if (head.startsWith("SELECT")) return [{ version: highestVersion }];
		// DROP / anything else: succeed with no rows.
		return [];
	};
}

describe("runStress (FR-1 end-to-end over the fake backend)", () => {
	it("drives the load, records attempts, builds a well-formed report, and lists its tables", async () => {
		const recorder = new RecordingTransport(new FakeDeepLakeTransport(makeHealthyResponder()));
		const client = createStorageClient({
			provider: stubProvider(fakeCredentialRecord({ org: "fake-org-guid-1234" })),
			transport: recorder,
			sleep: async () => {},
		});
		const config = resolveStressConfig({ concurrency: "1,2", operations: "3", versionsPerKey: "2", seed: "7" });
		const columns = [...healTargetFor("memories").columns, { name: "version", sql: "BIGINT NOT NULL DEFAULT 0" }];

		const report = await runStress({
			client,
			recorder,
			scope: { org: "fake-org-guid-1234", workspace: "honeycomb_ci" },
			config,
			runId: "unit1",
			columns,
		});

		expect(report.schemaVersion).toBe(STRESS_REPORT_SCHEMA_VERSION);
		expect(report.totalAttempts).toBeGreaterThan(0);
		// One throwaway table per concurrency level, namespaced by run id (b-AC-1).
		expect(report.tables).toEqual(["ci_stress_unit1_c1", "ci_stress_unit1_c2"]);
		// The concurrency-scaling table covers both levels.
		expect(report.concurrencyScaling.map((r) => r.concurrency)).toEqual([1, 2]);
		// Convergence sampled (one per level → 2), all converged against the healthy fake.
		expect(report.convergence.count).toBe(2);
		expect(report.convergence.convergedCount).toBe(2);
	});

	it("DROPs every throwaway table on teardown (b-AC-1 isolation)", async () => {
		const fake = new FakeDeepLakeTransport(makeHealthyResponder());
		const recorder = new RecordingTransport(fake);
		const client = createStorageClient({
			provider: stubProvider(fakeCredentialRecord()),
			transport: recorder,
			sleep: async () => {},
		});
		const config = resolveStressConfig({ concurrency: "1", operations: "1", versionsPerKey: "1", seed: "1" });
		const columns = [...healTargetFor("memories").columns, { name: "version", sql: "BIGINT NOT NULL DEFAULT 0" }];

		await runStress({
			client,
			recorder,
			scope: { org: "fake-org", workspace: "honeycomb_ci" },
			config,
			runId: "drop1",
			columns,
		});

		// A DROP TABLE IF EXISTS for the throwaway table must have been issued.
		const drops = fake.requests.filter((r) => /^\s*DROP\s+TABLE/i.test(r.sql));
		expect(drops.some((r) => r.sql.includes("ci_stress_drop1_c1"))).toBe(true);
	});

	it("produces a report + summary carrying NO secret (b-AC-7)", async () => {
		const ORG = "super-secret-org-guid-abcdef";
		const recorder = new RecordingTransport(new FakeDeepLakeTransport(makeHealthyResponder()));
		const client = createStorageClient({
			provider: stubProvider(fakeCredentialRecord({ org: ORG, token: "secret-token-zzzz" })),
			transport: recorder,
			sleep: async () => {},
		});
		const config = resolveStressConfig({ concurrency: "1", operations: "2", versionsPerKey: "1", seed: "3" });
		const columns = [...healTargetFor("memories").columns, { name: "version", sql: "BIGINT NOT NULL DEFAULT 0" }];

		const report = await runStress({
			client,
			recorder,
			scope: { org: ORG, workspace: "honeycomb_ci" },
			config,
			runId: "secret1",
			columns,
		});

		const json = JSON.stringify(report);
		expect(json).not.toContain(ORG); // full org GUID never in the report
		expect(json).not.toContain("secret-token-zzzz"); // token never in the report
		expect(report.orgRedacted).toBe("****cdef"); // redactToken keeps last 4 only

		const summary = renderStressSummary(report);
		expect(summary).not.toContain(ORG);
		expect(summary).not.toContain("secret-token-zzzz");
		expect(summary).toContain("****cdef"); // the redacted org IS shown (safe)
	});

	it("is reproducible: the same seed drives the identical workload (same SQL stream)", async () => {
		const run = async (seed: string): Promise<string[]> => {
			const fake = new FakeDeepLakeTransport(makeHealthyResponder());
			const recorder = new RecordingTransport(fake);
			const client = createStorageClient({
				provider: stubProvider(fakeCredentialRecord()),
				transport: recorder,
				sleep: async () => {},
			});
			const config = resolveStressConfig({ concurrency: "2", operations: "4", versionsPerKey: "1", seed });
			const columns = [...healTargetFor("memories").columns, { name: "version", sql: "BIGINT NOT NULL DEFAULT 0" }];
			await runStress({
				client,
				recorder,
				scope: { org: "fake-org", workspace: "honeycomb_ci" },
				config,
				runId: "repro",
				columns,
			});
			// The INSERT statements (the workload) — their keys are seed-derived.
			return fake.requests.filter((r) => /^\s*INSERT/i.test(r.sql)).map((r) => r.sql);
		};

		const a = await run("42");
		const b = await run("42");
		expect(a).toEqual(b); // same seed → identical workload
		const c = await run("43");
		expect(c).not.toEqual(a); // different seed → different keys
	});
});
