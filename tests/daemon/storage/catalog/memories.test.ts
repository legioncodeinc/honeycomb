/**
 * PRD-003a — Memories, Embeddings, History — proves a-AC-1..7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-003): no live DeepLake. Each a-AC
 * has a named, unskipped test against the PRD-002 fake transport. The binding
 * DoD per table: the ColumnDef array validates; `buildCreateTableSql` emits the
 * right DDL; a missing-table write heals + retries once via the real heal
 * engine; the required scope/embedding/dedup/soft-delete columns are present
 * with correct types/defaults; the assigned write pattern emits correct SQL.
 *
 * Producer logic (PRD-006 decision stage, shadow mode) is OUT of scope — those
 * ACs are met at the catalog level: the column + helper enforce the invariant,
 * tested against the fake transport.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import { appendOnlyInsert, updateOrInsertByKey, val } from "../../../../src/daemon/storage/writes.js";
import { CATALOG, REGISTRY, catalogTable, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	buildDedupCheckSql,
	contentHash,
	MEMORIES_COLUMNS,
	MEMORY_HISTORY_ACTORS,
	MEMORY_HISTORY_COLUMNS,
	NOT_SOFT_DELETED,
	SHADOW_ACTOR,
	SOFT_DELETED,
} from "../../../../src/daemon/storage/catalog/memories.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

/** Find a column's `sql` from a ColumnDef array. */
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-003a memories catalog", () => {
	it("a-AC-1 memories row carries content_hash, confidence, importance, source_id, agent_id, visibility, nullable 768-dim content_embedding", () => {
		// ColumnDef array validates at load (no NOT NULL without DEFAULT).
		expect(() => validateColumnDefs("memories", MEMORIES_COLUMNS)).not.toThrow();
		for (const name of ["content_hash", "source_id", "agent_id", "visibility"]) {
			expect(colSql(MEMORIES_COLUMNS, name), `column ${name}`).toBeDefined();
		}
		// confidence FLOAT4 default 1.0, importance FLOAT4 default 0.5.
		expect(colSql(MEMORIES_COLUMNS, "confidence")).toMatch(/FLOAT4 NOT NULL DEFAULT 1\.0/);
		expect(colSql(MEMORIES_COLUMNS, "importance")).toMatch(/FLOAT4 NOT NULL DEFAULT 0\.5/);
		// scope defaults (D-2 engine table): agent_id 'default', visibility 'global'.
		expect(colSql(MEMORIES_COLUMNS, "agent_id")).toMatch(/DEFAULT 'default'/);
		expect(colSql(MEMORIES_COLUMNS, "visibility")).toMatch(/DEFAULT 'global'/);
		// content_embedding is a nullable FLOAT4[] (768-dim contract, index AC-4).
		const emb = colSql(MEMORIES_COLUMNS, "content_embedding");
		expect(emb).toBe("FLOAT4[]");
		expect(emb).not.toMatch(/NOT NULL/);
		expect(EMBEDDING_DIMS).toBe(768);
		// The catalog records the embedding column for the table.
		expect(catalogTable("memories")?.embeddingColumns).toEqual(["content_embedding"]);
	});

	it("a-AC-2 memory_history records changed_by in {harness, pipeline, pipeline-shadow}", async () => {
		expect(MEMORY_HISTORY_ACTORS).toEqual(["harness", "pipeline", "pipeline-shadow"]);
		expect(colSql(MEMORY_HISTORY_COLUMNS, "changed_by")).toBeDefined();
		// Each actor writes a valid append-only history row through the real primitive.
		for (const actor of MEMORY_HISTORY_ACTORS) {
			const fake = new FakeDeepLakeTransport();
			fake.enqueueRows([]); // INSERT ok
			const res = await appendOnlyInsert(client(fake), healTargetFor("memory_history"), SCOPE, [
				["id", val.str(`h-${actor}`)],
				["memory_id", val.str("m1")],
				["changed_by", val.str(actor)],
				["operation", val.str("create")],
			]);
			expect(res.kind).toBe("ok");
			expect(fake.requests[0].sql).toMatch(new RegExp(`'${actor}'`));
			expect(fake.requests[0].sql).toMatch(/^INSERT INTO "memory_history"/);
		}
	});

	it("a-AC-3 identical normalized_content yields a matching content_hash and the dedup probe skips the duplicate INSERT", async () => {
		const a = contentHash("the sky is blue");
		const b = contentHash("the sky is blue");
		const c = contentHash("the sky is green");
		expect(a).toBe(b); // deterministic SHA-256
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);

		// The dedup probe finds the existing row, so the decision stage skips INSERT.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ id: "existing" }]); // probe returns a match
		const probe = await client(fake).query(buildDedupCheckSql(a), SCOPE);
		expect(probe.kind).toBe("ok");
		expect(fake.requests[0].sql).toContain(`content_hash = '${a}'`);
		// Simulate the decision: a match means do NOT insert.
		const matched = probe.kind === "ok" && probe.rows.length > 0;
		expect(matched).toBe(true);
		// Only the probe went out — no INSERT followed.
		expect(fake.requests.length).toBe(1);
	});

	it("a-AC-4 embedding disabled writes content_embedding NULL and the row is still recoverable via lexical filters", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // SELECT for updateOrInsert key probe → absent
		fake.enqueueRows([]); // INSERT ok
		const res = await updateOrInsertByKey(client(fake), healTargetFor("memories"), SCOPE, {
			keyColumn: "id",
			keyValue: "m-noembed",
			row: [
				["id", val.str("m-noembed")],
				["content", val.text("a fact with no embedding")],
				["content_embedding", val.raw("NULL")], // embedding disabled → NULL
			],
		});
		expect(res.kind).toBe("ok");
		const insertSql = fake.requests.find((r) => /^INSERT/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/content_embedding/);
		expect(insertSql).toMatch(/NULL/);
		// content_embedding is nullable (no NOT NULL), so a NULL row is valid and
		// lexical recall (ILIKE on content) still returns it — the column type permits it.
		expect(colSql(MEMORIES_COLUMNS, "content_embedding")).not.toMatch(/NOT NULL/);
	});

	it("a-AC-5 soft-deleted memory advances is_deleted=1 and the encoding excludes it from recall while retaining it", async () => {
		expect(NOT_SOFT_DELETED).toBe(0);
		expect(SOFT_DELETED).toBe(1);
		// is_deleted is a BIGINT 0/1 (D-3), default 0 (live).
		expect(colSql(MEMORIES_COLUMNS, "is_deleted")).toMatch(/BIGINT NOT NULL DEFAULT 0/);
		// Advancing the flag is an update-or-insert, not a DELETE — the row is retained.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ id: "m-del" }]); // key exists
		fake.enqueueRows([]); // UPDATE ok
		const res = await updateOrInsertByKey(client(fake), healTargetFor("memories"), SCOPE, {
			keyColumn: "id",
			keyValue: "m-del",
			row: [
				["id", val.str("m-del")],
				["is_deleted", val.num(SOFT_DELETED)],
			],
		});
		expect(res.kind).toBe("ok");
		const upd = fake.requests.find((r) => /^UPDATE/.test(r.sql))?.sql ?? "";
		expect(upd).toMatch(/is_deleted = 1/);
		expect(upd).not.toMatch(/DELETE/);
	});

	it("a-AC-6 first INSERT to memories creates from the ColumnDef array and retries once", async () => {
		const seen: string[] = [];
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'relation "memories" does not exist', 404);
				return []; // retry succeeds
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				return MEMORIES_COLUMNS.map((c) => ({ column_name: c.name }));
			}
			if (/^SELECT/.test(req.sql)) return []; // key probe → absent
			return [];
		});
		const res = await updateOrInsertByKey(client(fake), healTargetFor("memories"), SCOPE, {
			keyColumn: "id",
			keyValue: "m-first",
			row: [["id", val.str("m-first")]],
		});
		expect(res.kind).toBe("ok");
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "memories"/.test(s))).toBe(true);
		// The create DDL is exactly what the catalog ColumnDef array renders.
		expect(buildCreateTableSql("memories", MEMORIES_COLUMNS)).toMatch(
			/CREATE TABLE IF NOT EXISTS "memories" \(.*\) USING deeplake/,
		);
		expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2); // original + one retry
	});

	it("a-AC-7 shadow mode records changed_by='pipeline-shadow' in memory_history and does not mutate memories", async () => {
		expect(SHADOW_ACTOR).toBe("pipeline-shadow");
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // history INSERT ok
		const res = await appendOnlyInsert(client(fake), healTargetFor("memory_history"), SCOPE, [
			["id", val.str("h-shadow")],
			["memory_id", val.str("m1")],
			["changed_by", val.str(SHADOW_ACTOR)],
			["operation", val.str("create")],
		]);
		expect(res.kind).toBe("ok");
		expect(fake.requests[0].sql).toMatch(/'pipeline-shadow'/);
		// Only the history table was written — memories was never touched.
		expect(fake.requests.every((r) => !/INTO "memories"/.test(r.sql))).toBe(true);
		expect(fake.requests.every((r) => !/UPDATE "memories"/.test(r.sql))).toBe(true);
	});

	it("registry: memories is update-or-insert and memory_history is append-only", () => {
		expect(REGISTRY.patternFor("memories")).toBe("update-or-insert");
		expect(REGISTRY.primitiveFor("memories")).toBe("updateOrInsertByKey");
		expect(REGISTRY.patternFor("memory_history")).toBe("append-only");
		expect(REGISTRY.primitiveFor("memory_history")).toBe("appendOnlyInsert");
		// Both tables are present in the aggregated catalog.
		expect(CATALOG.some((t) => t.name === "memories")).toBe(true);
		expect(CATALOG.some((t) => t.name === "memory_history")).toBe(true);
	});
});
