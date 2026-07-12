/**
 * ISS-010 — the injected-token telemetry writer (`recordInjection`) suite.
 *
 * Verification posture: a FAKE {@link StorageQuery} captures the statements the writer emits,
 * so the append-only INSERT (columns, clamps, agent-scope defaults), the skip-on-zero gate,
 * and the fail-soft never-throws contract are asserted deterministically with no live
 * DeepLake, no creds, no clock (injected `now`/`newId` seams).
 */

import { describe, expect, it } from "vitest";

import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult } from "../../../../src/daemon/storage/result.js";
import {
	recordInjection,
	type InjectionLogDeps,
} from "../../../../src/daemon/runtime/telemetry/injection-log.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };
const NOW = "2026-07-12T00:00:00.000Z";

/** A scripted fake storage: records every SQL it saw; the handler scripts the INSERT result. */
function fakeStorage(onQuery?: (sql: string) => QueryResult | Promise<QueryResult>): {
	storage: StorageQuery;
	sql: string[];
} {
	const sql: string[] = [];
	const storage: StorageQuery = {
		async query(statement: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sql.push(statement);
			return onQuery !== undefined ? onQuery(statement) : ok([], 0);
		},
	};
	return { storage, sql };
}

const fixedDeps = (storage: StorageQuery): InjectionLogDeps => ({
	storage,
	now: () => new Date(NOW),
	newId: () => "inj-1",
});

describe("ISS-010 recordInjection — the append-only injection event", () => {
	it("appends one memory_injections row stamping EVERY column explicitly (the recordAccess model)", async () => {
		const { storage, sql } = fakeStorage();
		const res = await recordInjection(
			{ source: "recall", hits: 3, tokens: 120, sessionId: "sess-9", projectId: "proj-4" },
			fixedDeps(storage),
			SCOPE,
		);
		expect(res.appended).toBe(true);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_injections"'));
		expect(insert).toBeDefined();
		// Column list: the writer stamps everything — appendOnlyInsert stamps NOTHING.
		expect(insert).toContain("(id, at, source, hits, tokens, session_id, project_id, agent_id, visibility)");
		expect(insert).toContain("'inj-1'"); // injected deterministic id.
		expect(insert).toContain(`'${NOW}'`); // injected clock.
		expect(insert).toContain("'recall'");
		expect(insert).toContain("3, 120"); // hits, tokens inlined as integers.
		expect(insert).toContain("'sess-9'");
		expect(insert).toContain("'proj-4'");
	});

	it("an absent agent scope falls back to the schema defaults ('default' / 'global')", async () => {
		const { storage, sql } = fakeStorage();
		await recordInjection({ source: "prime", hits: 2, tokens: 40 }, fixedDeps(storage), SCOPE);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_injections"'));
		expect(insert).toContain("'default'");
		expect(insert).toContain("'global'");
		// Absent sessionId/projectId land as '' (never a partial row).
		expect(insert).toContain("'', ''");
	});

	it("carries a REAL agent scope onto the row when the caller threads one", async () => {
		const { storage, sql } = fakeStorage();
		await recordInjection(
			{ source: "recall_fast", hits: 1, tokens: 10, agent: { agentId: "agent-7", visibility: "private" } },
			fixedDeps(storage),
			SCOPE,
		);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_injections"'));
		expect(insert).toContain("'agent-7'");
		expect(insert).toContain("'private'");
	});

	it("clamps float/negative counters to non-negative integers (BIGINT columns, Math.trunc + Math.max)", async () => {
		const { storage, sql } = fakeStorage();
		await recordInjection({ source: "recall", hits: 2.9, tokens: 100.7 }, fixedDeps(storage), SCOPE);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_injections"'));
		// Truncated, never rounded up, never a float literal in a BIGINT column.
		expect(insert).toContain("2, 100");
		expect(insert).not.toContain("2.9");
		expect(insert).not.toContain("100.7");
	});

	it("skips the write entirely when hits <= 0 (no zero-signal rows)", async () => {
		const { storage, sql } = fakeStorage();
		const res = await recordInjection({ source: "recall", hits: 0, tokens: 500 }, fixedDeps(storage), SCOPE);
		expect(res.appended).toBe(false);
		expect(sql).toHaveLength(0);
	});

	it("skips the write entirely when tokens <= 0 — including a negative clamped to 0", async () => {
		const { storage, sql } = fakeStorage();
		const zero = await recordInjection({ source: "prime", hits: 4, tokens: 0 }, fixedDeps(storage), SCOPE);
		const negative = await recordInjection({ source: "prime", hits: 4, tokens: -12 }, fixedDeps(storage), SCOPE);
		expect(zero.appended).toBe(false);
		expect(negative.appended).toBe(false);
		expect(sql).toHaveLength(0);
	});

	it("gates the closed source taxonomy at the boundary (a widened string never writes an unknown source)", async () => {
		const { storage, sql } = fakeStorage();
		// Simulate a caller crossing the seam with a widened string (the runtime gate, not just the type).
		const res = await recordInjection(
			{ source: "hook" as unknown as "recall", hits: 1, tokens: 10 },
			fixedDeps(storage),
			SCOPE,
		);
		expect(res.appended).toBe(false);
		expect(sql).toHaveLength(0);
	});

	it("FAIL-SOFT: a query_error result reports appended:false, never throws", async () => {
		const { storage } = fakeStorage(() => ({ kind: "query_error", message: "boom" }));
		const res = await recordInjection({ source: "recall", hits: 1, tokens: 10 }, fixedDeps(storage), SCOPE);
		expect(res.appended).toBe(false);
	});

	it("FAIL-SOFT: a THROWING storage client still resolves { appended: false } (telemetry never costs a recall)", async () => {
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				throw new Error("transport down");
			},
		};
		await expect(
			recordInjection({ source: "recall", hits: 1, tokens: 10 }, fixedDeps(storage), SCOPE),
		).resolves.toEqual({ appended: false });
	});

	it("defaults the clock and id when no deps are injected (wall-clock ISO + a UUID)", async () => {
		const { storage, sql } = fakeStorage();
		const res = await recordInjection({ source: "recall", hits: 1, tokens: 5 }, { storage }, SCOPE);
		expect(res.appended).toBe(true);
		const insert = sql.find((s) => s.startsWith('INSERT INTO "memory_injections"')) ?? "";
		// An ISO-8601 stamp and a UUID-shaped id landed without injected seams.
		expect(insert).toMatch(/'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'/);
		expect(insert).toMatch(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/);
	});
});
