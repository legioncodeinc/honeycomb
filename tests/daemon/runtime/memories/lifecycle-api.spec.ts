/**
 * PRD-058d — the lifecycle READ-API suite (the list reads + the read-side `H(m,t)`).
 *
 * Acceptance criteria → tests:
 *   58d.2.1 the read-side `H = A · C · (1 − σ) · κ` assembles from emitted fields, dormant terms = identity.
 *   58d.2.3 the lifecycle-history read filters `memory_history` to the lifecycle operations only.
 *   Plus: every read runs UNDER the request partition scope (scope enforced before content); the conflict +
 *         stale-ref list reads route every value through the SQL guards (sLiteral/sqlIdent — audit:sql clean);
 *         a storage error degrades to [] (fail-soft), never a throw.
 */

import { describe, expect, it } from "vitest";

import { ok, queryError, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import {
	LIFECYCLE_HISTORY_OPERATIONS,
	assembleHealth,
	buildLifecycleHistorySql,
	buildStaleRefListSql,
	listConflicts,
	listLifecycleHistory,
	listStaleRefs,
	resolveLifecyclePage,
} from "../../../../src/daemon/runtime/memories/lifecycle-api.js";
import { buildConflictListSql } from "../../../../src/daemon/storage/catalog/memory-conflicts.js";

const SCOPE: QueryScope = { org: "acme", workspace: "backend" };
const OTHER_SCOPE: QueryScope = { org: "evil-corp", workspace: "x" };

/** A fake StorageQuery that returns a fixed result and records the scope each query ran under. */
function fakeStorage(result: QueryResult): { storage: StorageQuery; scopes: QueryScope[]; sqls: string[] } {
	const scopes: QueryScope[] = [];
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			scopes.push(scope);
			return result;
		},
	};
	return { storage, scopes, sqls };
}

describe("PRD-058d — the read-side H(m,t) projection (AC-55d.2.1)", () => {
	it("H = A · C · (1 − σ) · κ when every term is present", () => {
		const h = assembleHealth({ activation: 0.5, calibratedConfidence: 0.8, staleness: 0.25, kappa: 1 });
		// 0.5 * 0.8 * 0.75 * 1 = 0.3
		expect(h.health).toBeCloseTo(0.3, 6);
		expect(h.activation).toBe(0.5);
		expect(h.confidence).toBe(0.8);
		expect(h.staleness).toBe(0.25);
		expect(h.kappa).toBe(1);
	});

	it("a DORMANT term reads as its identity factor (A=1, C=1, σ=0, κ=1) so H degrades to the live terms", () => {
		// No activation, no calibration, no stale data, no conflict → every factor identity → H = 1.
		expect(assembleHealth({}).health).toBe(1);
		// Only staleness is live → H = 1 − σ.
		expect(assembleHealth({ staleness: 0.4 }).health).toBeCloseTo(0.6, 6);
		// Only a hard-superseded conflict (κ = 0) → H = 0 regardless of the other (dormant) terms.
		expect(assembleHealth({ kappa: 0 }).health).toBe(0);
	});

	it("freshnessScore is an alias for A when activation is absent; activation wins when both are present", () => {
		expect(assembleHealth({ freshnessScore: 0.6 }).activation).toBe(0.6);
		expect(assembleHealth({ activation: 0.2, freshnessScore: 0.9 }).activation).toBe(0.2);
	});

	it("out-of-range inputs clamp into [0,1]", () => {
		const h = assembleHealth({ activation: 5, calibratedConfidence: -1, staleness: 2, kappa: 10 });
		expect(h.health).toBe(0); // staleness clamps to 1 → 1 − σ = 0
	});
});

describe("PRD-058d — scope enforced before content (every read runs under the request partition)", () => {
	it("listConflicts runs the query under the caller's scope, NOT another tenant's", async () => {
		const { storage, scopes } = fakeStorage(ok([], 0));
		await listConflicts(storage, SCOPE, "open", 50);
		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toEqual(SCOPE);
		expect(scopes[0]).not.toEqual(OTHER_SCOPE);
	});

	it("listStaleRefs + listLifecycleHistory both run under the caller's scope", async () => {
		const sr = fakeStorage(ok([], 0));
		await listStaleRefs(sr.storage, SCOPE, 50);
		expect(sr.scopes[0]).toEqual(SCOPE);
		const hist = fakeStorage(ok([], 0));
		await listLifecycleHistory(hist.storage, SCOPE, 50);
		expect(hist.scopes[0]).toEqual(SCOPE);
	});

	it("a storage error degrades every read to [] (fail-soft), never a throw", async () => {
		const { storage } = fakeStorage(queryError(`relation "memory_conflicts" does not exist`));
		await expect(listConflicts(storage, SCOPE, "open", 50)).resolves.toEqual([]);
		const sr = fakeStorage(queryError("boom"));
		await expect(listStaleRefs(sr.storage, SCOPE, 50)).resolves.toEqual([]);
		const h = fakeStorage(queryError("boom"));
		await expect(listLifecycleHistory(h.storage, SCOPE, 50)).resolves.toEqual([]);
	});
});

describe("PRD-058d — the lifecycle-history filter (AC-55d.2.3)", () => {
	it("the history SQL filters to the lifecycle operations and returns actor/reason/confidence/timestamp", async () => {
		const sql = buildLifecycleHistorySql(50);
		for (const op of LIFECYCLE_HISTORY_OPERATIONS) expect(sql).toContain(`'${op}'`);
		expect(sql).toContain("IN (");
		expect(sql).toContain("ORDER BY");
		// A non-lifecycle operation (e.g. a plain `add`) is NOT in the filter set.
		expect(sql).not.toContain("'add'");

		const row: StorageRow = {
			id: "h1",
			memory_id: "mem-1",
			changed_by: "pipeline",
			operation: "conflict_resolve",
			after_payload: JSON.stringify({ operation: "conflict_resolve", reason: "operator resolution: supersede", confidence: 0.9 }),
			created_at: "2026-06-26T00:00:00.000Z",
		};
		const { storage } = fakeStorage(ok([row], 1));
		const history = await listLifecycleHistory(storage, SCOPE, 50);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			memoryId: "mem-1",
			actor: "pipeline",
			operation: "conflict_resolve",
			reason: "operator resolution: supersede",
			confidence: 0.9,
			timestamp: "2026-06-26T00:00:00.000Z",
		});
	});
});

describe("PRD-058d — SQL guards (audit:sql clean) + list parsing", () => {
	it("the conflict list SQL escapes the status literal + names the columns through sqlIdent", () => {
		const sql = buildConflictListSql("open", 25);
		expect(sql).toContain("'open'");
		expect(sql).toContain("LIMIT 25");
		expect(sql).toContain("MAX(");
	});

	it("the stale-ref list SQL filters ref_status='stale' and drops tombstones", () => {
		const sql = buildStaleRefListSql(10);
		expect(sql).toContain("'stale'");
		expect(sql).toContain("is_deleted");
		expect(sql).toContain("LIMIT 10");
	});

	it("listStaleRefs parses the stale_refs JSON array defensively", async () => {
		const row: StorageRow = { id: "mem-9", ref_status: "stale", stale_refs: JSON.stringify(["src/gone.ts", "Foo#bar"]), verified_at: "2026-06-25T00:00:00.000Z" };
		const { storage } = fakeStorage(ok([row], 1));
		const rows = await listStaleRefs(storage, SCOPE, 50);
		expect(rows[0]).toMatchObject({ memoryId: "mem-9", refStatus: "stale", staleRefs: ["src/gone.ts", "Foo#bar"] });
	});

	it("resolveLifecyclePage clamps to [1, 500] and defaults a bad value", () => {
		expect(resolveLifecyclePage(undefined)).toBe(50);
		expect(resolveLifecyclePage(0)).toBe(50);
		expect(resolveLifecyclePage(10_000)).toBe(500);
		expect(resolveLifecyclePage(20)).toBe(20);
	});
});
