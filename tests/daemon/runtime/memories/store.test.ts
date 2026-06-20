/**
 * PRD-022a memory WRITE adapter suite — a-AC-4 (modify/forget reason-gated + audited)
 * and a-AC-3 (store lands a row), driven at the adapter level against a fake-but-real
 * SQL-aware `StorageQuery` and also through the HTTP route for the reason-gate 400.
 *
 *   a-AC-4  modify/forget REQUIRE a reason (reject without it) and write an
 *           append-only `memory_history` audit row recording the reason.
 *   a-AC-3  store calls the controlled-writes ADD engine and lands a `memories` row.
 *
 * The mutate path is an append-only VERSION BUMP (never an in-place UPDATE — the
 * DeepLake-coalesces-UPDATE lesson); `forget` is a soft-delete tombstone.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	forgetMemory,
	modifyMemory,
	mountMemoriesApi,
	storeMemory,
	MemoryReasonRequiredError,
} from "../../../../src/daemon/runtime/memories/index.js";
import { resolvePipelineConfig } from "../../../../src/daemon/runtime/pipeline/config.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const SESSION = "sess-022a-write";
const SCOPE = { org: ORG, workspace: WORKSPACE };

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function headers(): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
	};
}

/** A responder where the dedup probe + version-max reads are empty (so writes proceed). */
function responder() {
	return (_req: TransportRequest): Record<string, unknown>[] => [];
}

function makeStorage() {
	const fake = new FakeDeepLakeTransport(responder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

const baseConfig = resolvePipelineConfig();

describe("PRD-022a memory write adapters (a-AC-3 / a-AC-4)", () => {
	it("a-AC-3: storeMemory inserts a real memories row through controlled-writes", async () => {
		const { storage, fake } = makeStorage();
		const result = await storeMemory(
			{ content: "use ESM imports everywhere", scope: SCOPE },
			{ storage, config: baseConfig, newId: () => "mem-store-1" },
		);
		expect(result.outcome.action).toBe("inserted");
		expect(result.outcome.memoryId).toBe("mem-store-1");
		expect(fake.requests.some((r) => /INSERT INTO\s+"memories"/i.test(r.sql))).toBe(true);
	});

	it("a-AC-4: modifyMemory with a blank reason throws the reason-required error (engine never runs)", async () => {
		const { storage, fake } = makeStorage();
		await expect(
			modifyMemory({ id: "mem-1", reason: "   ", content: "new", scope: SCOPE }, { storage, config: baseConfig }),
		).rejects.toBeInstanceOf(MemoryReasonRequiredError);
		// No write reached storage: the gate fired before the engine.
		expect(fake.requests.some((r) => /INSERT INTO/i.test(r.sql))).toBe(false);
	});

	it("a-AC-4: modifyMemory with a reason version-bumps memories AND writes a memory_history audit row", async () => {
		const { storage, fake } = makeStorage();
		const result = await modifyMemory(
			{ id: "mem-7", reason: "the API moved to /v2", content: "the endpoint is /v2", scope: SCOPE },
			{ storage, config: baseConfig, newId: () => "audit-1" },
		);
		expect(result.outcome.action).toBe("version_bumped");
		expect(result.audited).toBe(true);

		// The mutation is an append-only INSERT (version bump), NOT an in-place UPDATE of content.
		const memoriesInserts = fake.requests.filter((r) => /INSERT INTO\s+"memories"/i.test(r.sql));
		expect(memoriesInserts.length).toBeGreaterThan(0);

		// The audit row landed in memory_history carrying the operation + reason.
		const auditInserts = fake.requests.filter((r) => /INSERT INTO\s+"memory_history"/i.test(r.sql));
		expect(auditInserts.length).toBe(1);
		expect(auditInserts[0]?.sql).toContain("modify");
		expect(auditInserts[0]?.sql).toContain("the API moved to /v2");
	});

	it("a-AC-4: forgetMemory soft-deletes via a version bump AND writes a memory_history audit row", async () => {
		const { storage, fake } = makeStorage();
		const result = await forgetMemory(
			{ id: "mem-9", reason: "the user asked to forget it", scope: SCOPE },
			{ storage, config: baseConfig, newId: () => "audit-2" },
		);
		expect(result.outcome.action).toBe("version_bumped");
		expect(result.audited).toBe(true);

		// forget is a soft-delete tombstone: the version-bumped row carries the
		// is_deleted column (sqlIdent renders a bare identifier, not a quoted one).
		const memoriesInserts = fake.requests.filter((r) => /INSERT INTO\s+"memories"/i.test(r.sql));
		expect(memoriesInserts.length).toBeGreaterThan(0);
		expect(memoriesInserts.some((r) => /\bis_deleted\b/.test(r.sql))).toBe(true);

		const auditInserts = fake.requests.filter((r) => /INSERT INTO\s+"memory_history"/i.test(r.sql));
		expect(auditInserts.length).toBe(1);
		expect(auditInserts[0]?.sql).toContain("forget");
	});

	it("a-AC-4: POST /api/memories/:id/modify without a reason → zod 400 before the engine", async () => {
		const { storage, fake } = makeStorage();
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/mem-1/modify", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ content: "new content" }), // no reason
		});
		expect(res.status).toBe(400);
		expect(fake.requests.some((r) => /INSERT INTO/i.test(r.sql))).toBe(false);
	});

	it("a-AC-4: POST /api/memories/:id/forget with a reason → mutation applied + audited (200)", async () => {
		const { storage } = makeStorage();
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/mem-1/forget", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ reason: "stale fact" }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { action: string; audited: boolean };
		expect(json.action).toBe("version_bumped");
		expect(json.audited).toBe(true);
	});

	// ── Security L-1 (audit-after-mutate ordering): the mutation lands FIRST, then the
	// audit row. If the `memory_history` audit INSERT fails AFTER the version-bump
	// mutation has already landed, the failure is NOT swallowed: `audited:false` is
	// SURFACED on the result so the dropped provenance row is OBSERVABLE, never silent.
	// (The reason-gate, the actual accountability requirement, fires BEFORE the mutation,
	// so a reasonless mutation can never land regardless of audit-write outcome.)
	it("a-AC-4 / L-1: a failing memory_history audit write after the mutation surfaces audited:false (not silent)", async () => {
		// Responder: the `memories` version-bump mutation succeeds (empty reads + INSERT ok),
		// but the `memory_history` audit INSERT throws — exactly the audit-after-mutate failure.
		const fake = new FakeDeepLakeTransport((req) => {
			if (/INSERT INTO\s+"memory_history"/i.test(req.sql)) {
				throw new TransportError("query", "audit sink unavailable", 503);
			}
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		const result = await modifyMemory(
			{ id: "mem-L1", reason: "rotate the stale value", content: "the new value", scope: SCOPE },
			{ storage, config: baseConfig, newId: () => "audit-L1" },
		);

		// The mutation STILL landed (the append-only version bump is not rolled back) ...
		expect(result.outcome.action).toBe("version_bumped");
		expect(fake.requests.some((r) => /INSERT INTO\s+"memories"/i.test(r.sql))).toBe(true);
		// ... and the audit failure is SURFACED, not swallowed: audited === false (L-1 posture).
		expect(result.audited).toBe(false);
		// The audit INSERT was attempted (the failure was real, not skipped).
		expect(fake.requests.some((r) => /INSERT INTO\s+"memory_history"/i.test(r.sql))).toBe(true);
	});
});
