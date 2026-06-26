/**
 * PRD-058e, recall wiring + schema suite.
 *
 * Covers the recall-side integration of the Stage-2 upgrade (the A_actr-behind-freshnessScore
 * swap, the calibrated-confidence emission, the recall-event recording, and the fail-soft
 * fallback to the 058a Stage-1 path) plus the additive lazy-heal schema (58e.schema).
 *
 * Acceptance criteria → tests:
 *   58e.1.1 a reinforced memory recalls with a higher activation than a never-reinforced one.
 *   58e.schema all three schema changes lazy-heal (new tables CREATE, new columns ALTER ADD).
 * Plus: A_actr is stamped behind freshnessScore; the source-less path is the byte-for-byte 058a
 * Stage-1 path (no regression); a source throw degrades to Stage-1 (fail-soft); calibrated
 * confidence surfaces; a recall event is recorded per memories hit.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	recallMemories,
	type ActivationSource,
	type MemoryActivationInputs,
	type MemoryRecallHit,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { fitIsotonic, IDENTITY_MODEL } from "../../../../src/daemon/runtime/memories/calibration.js";
import {
	buildCreateTableSql,
	buildAddColumnSql,
} from "../../../../src/daemon/storage/schema.js";
import { catalogTable, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { MEMORIES_COLUMNS } from "../../../../src/daemon/storage/catalog/memories.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-06-26T00:00:00.000Z");

function memRow(id: string, createdAt: string): StorageRow {
	return { source: "memories", id, text: `fact ${id}`, created_at: createdAt };
}
function daysAgo(days: number): string {
	return new Date(NOW - days * MS_PER_DAY).toISOString();
}

/** A purely-lexical fake storage (no embed seam) → degraded recall, deterministic. */
function lexicalStorage(memories: StorageRow[], confidence?: Record<string, number>): {
	storage: StorageQuery;
	sql: string[];
} {
	const sql: string[] = [];
	const storage: StorageQuery = {
		async query(statement: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sql.push(statement);
			if (/'memories'\s+AS\s+source/i.test(statement)) return ok(memories, 0);
			if (/'memory'\s+AS\s+source/i.test(statement)) return ok([], 0);
			if (/'sessions'\s+AS\s+source/i.test(statement)) return ok([], 0);
			// The calibration confidence fetch: SELECT id AS id, confidence AS confidence FROM memories WHERE id IN (...)
			if (/FROM "memories"/.test(statement) && /AS confidence/i.test(statement)) {
				const rows = Object.entries(confidence ?? {}).map(([id, c]) => ({ id, confidence: c }));
				return ok(rows, 0);
			}
			return ok([], 0);
		},
	};
	return { storage, sql };
}

/** An activation source backed by a fixed history map keyed by `memories <id>`. */
function fixedActivationSource(map: Record<string, MemoryActivationInputs>): ActivationSource {
	return {
		async load(hits: readonly MemoryRecallHit[]): Promise<Map<string, MemoryActivationInputs>> {
			const out = new Map<string, MemoryActivationInputs>();
			for (const h of hits) {
				const key = `${h.source} ${h.id}`;
				const inputs = map[key];
				if (inputs !== undefined) out.set(key, inputs);
			}
			return out;
		},
	};
}

describe("PRD-058e recall wiring, A_actr behind freshnessScore", () => {
	it("source-less recall is the byte-for-byte 058a Stage-1 path (no activation field, no regression)", async () => {
		const { storage } = lexicalStorage([memRow("old", daysAgo(360)), memRow("new", daysAgo(1))]);
		const result = await recallMemories({ query: "x", scope: SCOPE, limit: 10 }, { storage, now: () => NOW });
		expect(result.degraded).toBe(true);
		expect(result.hits.map((h) => h.id)).toEqual(["new", "old"]); // 058a recency order.
		// No activation source → the explicit activation/accessCount fields are NOT stamped.
		for (const h of result.hits) {
			expect(h.activation).toBeUndefined();
			expect(h.accessCount).toBeUndefined();
			expect(h.freshnessScore).toBeGreaterThan(0); // 058a Stage-1 freshness still present.
		}
	});

	it("58e.1.1 a wired activation source swaps A_actr behind freshnessScore + stamps activation/accessCount", async () => {
		const { storage } = lexicalStorage([memRow("reinf", daysAgo(30)), memRow("cold", daysAgo(30))]);
		// Same age, but `reinf` has many useful accesses, `cold` has none.
		const source = fixedActivationSource({
			"memories reinf": {
				history: [
					{ atMs: NOW - 30 * MS_PER_DAY, usefulness: 1 },
					{ atMs: NOW - 10 * MS_PER_DAY, usefulness: 1 },
					{ atMs: NOW - 1 * MS_PER_DAY, usefulness: 1 },
				],
				accessCount: 3,
			},
			"memories cold": { history: [{ atMs: NOW - 30 * MS_PER_DAY, usefulness: 1 }], accessCount: 1 },
		});
		const result = await recallMemories(
			{ query: "x", scope: SCOPE, limit: 10 },
			{ storage, now: () => NOW, activationSource: source },
		);
		const reinf = result.hits.find((h) => h.id === "reinf")!;
		const cold = result.hits.find((h) => h.id === "cold")!;
		// A_actr is stamped behind freshnessScore AND surfaced explicitly; the reinforced memory is higher.
		expect(reinf.activation).toBeGreaterThan(cold.activation!);
		expect(reinf.freshnessScore).toBe(reinf.activation); // the swap is behind the same field.
		expect(reinf.accessCount).toBe(3);
		// The reinforced memory ranks first (higher activation → higher adjusted score at equal R).
		expect(result.hits[0]!.id).toBe("reinf");
	});

	it("a source THROW degrades to the 058a Stage-1 path (fail-soft, never a throw)", async () => {
		const { storage } = lexicalStorage([memRow("a", daysAgo(5))]);
		const throwingSource: ActivationSource = {
			async load(): Promise<Map<string, MemoryActivationInputs>> {
				throw new Error("access log down");
			},
		};
		const result = await recallMemories(
			{ query: "x", scope: SCOPE, limit: 10 },
			{ storage, now: () => NOW, activationSource: throwingSource },
		);
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]!.freshnessScore).toBeGreaterThan(0); // Stage-1 fallback computed.
	});

	it("a hit absent from the source map falls back to its 058a Stage-1 activation (per-hit fail-soft)", async () => {
		const { storage } = lexicalStorage([memRow("known", daysAgo(2)), memRow("unknown", daysAgo(2))]);
		const source = fixedActivationSource({
			"memories known": { history: [{ atMs: NOW - 1 * MS_PER_DAY, usefulness: 1 }], accessCount: 1 },
		});
		const result = await recallMemories(
			{ query: "x", scope: SCOPE, limit: 10 },
			{ storage, now: () => NOW, activationSource: source },
		);
		// `unknown` was not in the map → it still has a freshnessScore (058a Stage-1), never dropped.
		const unknown = result.hits.find((h) => h.id === "unknown")!;
		expect(unknown.freshnessScore).toBeGreaterThan(0);
		expect(result.hits).toHaveLength(2);
	});
});

describe("PRD-058e recall wiring, calibrated confidence + recall-event recording", () => {
	it("a wired non-identity calibration model stamps calibratedConfidence (C = g(f)) on memories hits", async () => {
		const { storage } = lexicalStorage([memRow("m1", daysAgo(1))], { m1: 0.9 });
		// A fitted curve that maps high raw confidence down (over-confident corrected).
		const samples = Array.from({ length: 100 }, (_, i) => ({ f: 0.9, y: (i % 4 === 0 ? 1 : 0) as 0 | 1 }));
		const model = fitIsotonic(samples, 50);
		expect(model.identity).toBe(false);
		const result = await recallMemories(
			{ query: "x", scope: SCOPE, limit: 10 },
			{ storage, now: () => NOW, calibration: model },
		);
		const hit = result.hits.find((h) => h.id === "m1")!;
		expect(hit.calibratedConfidence).toBeDefined();
		expect(hit.calibratedConfidence!).toBeLessThan(0.9); // corrected below the raw f.
		expect(hit.rawConfidence).toBe(0.9);
	});

	it("the dormant IDENTITY model STILL surfaces calibratedConfidence = f (C = f), the c exponent stays 0", async () => {
		// AC-55e.2.2: once a calibration model is wired, a consumer always sees a `C` — the IDENTITY model
		// is the dormant `C = f` case, NOT a "skip emitting C" case. The dashboard / store-health `H` need
		// the calibrated value even at cold-start, so identity stamps calibratedConfidence = rawConfidence
		// = the stored f. The `c` exponent stays 0 (no reorder) — identity must not mean "drop C".
		const { storage } = lexicalStorage([memRow("m1", daysAgo(1))], { m1: 0.9 });
		const result = await recallMemories(
			{ query: "x", scope: SCOPE, limit: 10 },
			{ storage, now: () => NOW, calibration: IDENTITY_MODEL },
		);
		const hit = result.hits.find((h) => h.id === "m1")!;
		expect(hit.calibratedConfidence).toBe(0.9); // identity → C = f, still emitted.
		expect(hit.rawConfidence).toBe(0.9);
	});

	it("records a `recall` access event per memories hit, fail-soft on a recorder throw", async () => {
		const { storage } = lexicalStorage([memRow("m1", daysAgo(1)), memRow("m2", daysAgo(2))]);
		const recorded: string[] = [];
		const result = await recallMemories(
			{ query: "x", scope: SCOPE, limit: 10 },
			{
				storage,
				now: () => NOW,
				recordRecallAccess: async (id: string) => {
					recorded.push(id);
					if (id === "m2") throw new Error("log flap"); // must not fail the recall.
				},
			},
		);
		expect(result.hits).toHaveLength(2); // recall still answered.
		expect(recorded.sort()).toEqual(["m1", "m2"]); // both attempted; the throw was swallowed.
	});
});

describe("PRD-058e schema (58e.schema), additive lazy-heal, no migration", () => {
	it("memory_access is registered as an append-only engine table and CREATE TABLE builds", () => {
		const t = catalogTable("memory_access");
		expect(t).toBeDefined();
		expect(t!.pattern).toBe("append-only");
		expect(t!.scope).toBe("agent");
		const sql = buildCreateTableSql(t!.name, t!.columns);
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS "memory_access"');
		expect(sql).toContain("USING deeplake");
		// The PRD-specified event columns are present.
		for (const col of ["id", "memory_id", "at", "usefulness", "kind"]) {
			expect(t!.columns.some((c) => c.name === col)).toBe(true);
		}
	});

	it("memory_calibration is registered and carries the curve-snapshot columns", () => {
		const t = catalogTable("memory_calibration");
		expect(t).toBeDefined();
		expect(t!.pattern).toBe("append-only");
		for (const col of ["id", "fit_at", "model_blob", "ece", "brier", "n_samples"]) {
			expect(t!.columns.some((c) => c.name === col)).toBe(true);
		}
	});

	it("ALL new memories lifecycle columns ALTER-ADD cleanly (additive heal, no backfill failure)", () => {
		// Every 058c/058e lifecycle column the catalog added to `memories`: the reinforcement cache
		// (last_reinforced_at, access_count), the staleness layer (ref_status, verified_at, stale_refs),
		// and the compaction watermark CURSOR (access_compacted_at + its companion access_compacted_id).
		// Each must be additive-heal-safe so an ALTER ADD COLUMN backfills a populated table without
		// failing the load-time guard.
		const names = ["last_reinforced_at", "access_count", "ref_status", "verified_at", "stale_refs", "access_compacted_at", "access_compacted_id"];
		const columns = names.map((name) => {
			const col = MEMORIES_COLUMNS.find((c) => c.name === name);
			expect(col, `column ${name} is registered`).toBeDefined();
			return col!;
		});
		for (const col of columns) {
			// Nullable (or DEFAULT) → ALTER ADD COLUMN on a populated table backfills cleanly.
			expect(buildAddColumnSql("memories", col)).toContain(`ALTER TABLE "memories" ADD COLUMN ${col.name}`);
			// None is NOT NULL-without-DEFAULT (that would fail the load-time guard / heal backfill).
			expect(/NOT\s+NULL/i.test(col.sql) && !/DEFAULT/i.test(col.sql), `${col.name} heal-safe`).toBe(false);
		}
	});

	it("healTargetFor resolves the new tables (the write primitives can heal them)", () => {
		expect(healTargetFor("memory_access").table).toBe("memory_access");
		expect(healTargetFor("memory_calibration").table).toBe("memory_calibration");
	});
});
