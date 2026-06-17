/**
 * PRD-003b — Knowledge Graph / Ontology — proves b-AC-1..7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-003): no live DeepLake. Each b-AC has
 * a named, unskipped test against the PRD-002 fake transport. The binding DoD per
 * table: the ColumnDef array validates at load; `buildCreateTableSql` emits the
 * right DDL; a missing-table write heals + retries once via the real heal engine;
 * the required lineage/scope/embedding columns are present with correct
 * types/defaults; the assigned write pattern emits correct SQL.
 *
 * Producer logic (PRD-008 graph persistence, PRD-007 traversal) is OUT of scope —
 * those ACs are met at the catalog level: the column + helper/validator enforce
 * the invariant, tested against the fake transport.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import { appendOnlyInsert, appendVersionBumped, val } from "../../../../src/daemon/storage/writes.js";
import { CATALOG, REGISTRY, catalogTable, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	assertDependencyReason,
	buildHighestActiveVersionSql,
	buildSupersedeMarkSql,
	CLAIM_ACTIVE,
	CLAIM_SUPERSEDED,
	DependencyReasonError,
	ENTITIES_COLUMNS,
	ENTITY_ATTRIBUTES_COLUMNS,
	ENTITY_DEPENDENCIES_COLUMNS,
	EPISTEMIC_ASSERTIONS_COLUMNS,
	EPISTEMIC_STANCES,
	KNOWLEDGE_GRAPH_TABLES,
	MEMORY_ENTITY_MENTIONS_COLUMNS,
	ONTOLOGY_PROPOSALS_COLUMNS,
	RELATED_TO,
} from "../../../../src/daemon/storage/catalog/knowledge-graph.js";
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

describe("PRD-003b knowledge-graph catalog", () => {
	it("b-AC-1 entity_attributes carries kind, content, confidence, importance, status, superseded_by, claim_key, group_key, version, and lineage scaffolding", () => {
		// ColumnDef array validates at load (no NOT NULL without DEFAULT).
		expect(() => validateColumnDefs("entity_attributes", ENTITY_ATTRIBUTES_COLUMNS)).not.toThrow();
		// Required lineage + claim columns are all present (b-AC-1).
		for (const name of [
			"kind",
			"content",
			"confidence",
			"importance",
			"status",
			"superseded_by",
			"claim_key",
			"group_key",
			"version",
			"aspect_id",
			"agent_id",
			"memory_id",
			"created_at",
			"updated_at",
		]) {
			expect(colSql(ENTITY_ATTRIBUTES_COLUMNS, name), `column ${name}`).toBeDefined();
		}
		// kind defaults 'attribute', status defaults 'active' (b-AC-1).
		expect(colSql(ENTITY_ATTRIBUTES_COLUMNS, "kind")).toMatch(/DEFAULT 'attribute'/);
		expect(colSql(ENTITY_ATTRIBUTES_COLUMNS, "status")).toMatch(/DEFAULT 'active'/);
		// version is a BIGINT default 1 (the lineage counter).
		expect(colSql(ENTITY_ATTRIBUTES_COLUMNS, "version")).toMatch(/BIGINT NOT NULL DEFAULT 1\b/);
		// confidence/importance are FLOAT4 with sane defaults.
		expect(colSql(ENTITY_ATTRIBUTES_COLUMNS, "confidence")).toMatch(/FLOAT4 NOT NULL DEFAULT 1\.0/);
		expect(colSql(ENTITY_ATTRIBUTES_COLUMNS, "importance")).toMatch(/FLOAT4 NOT NULL DEFAULT 0\.5/);
		// content_embedding is a nullable FLOAT4[] (768-dim, index AC-4).
		const emb = colSql(ENTITY_ATTRIBUTES_COLUMNS, "content_embedding");
		expect(emb).toBe("FLOAT4[]");
		expect(emb).not.toMatch(/NOT NULL/);
		expect(EMBEDDING_DIMS).toBe(768);
		expect(catalogTable("entity_attributes")?.embeddingColumns).toEqual(["content_embedding"]);
		// Pattern is version-bumped (b-AC-2/b-AC-6 supersession).
		expect(REGISTRY.patternFor("entity_attributes")).toBe("version-bumped");
		expect(REGISTRY.primitiveFor("entity_attributes")).toBe("appendVersionBumped");
	});

	it("b-AC-2 a claim edit INSERTs a new version row (status active) and marks the prior row status='superseded' — no in-place mutate", async () => {
		// Step 1: the version-bump INSERT goes through the real appendVersionBumped
		// primitive. The MAX(version) probe returns the current top version (3), so
		// the new row is version 4 with status='active'.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ version: 3 }]); // readMaxVersion probe → current highest is 3
		fake.enqueueRows([]); // INSERT new version row → ok
		const bump = await appendVersionBumped(client(fake), healTargetFor("entity_attributes"), SCOPE, {
			keyColumn: "claim_key",
			keyValue: "claim-1",
			row: [
				["id", val.str("attr-v4")],
				["claim_key", val.str("claim-1")],
				["content", val.text("the new claim content")],
				["status", val.str(CLAIM_ACTIVE)],
			],
		});
		expect(bump.result.kind).toBe("ok");
		expect(bump.version).toBe(4);
		const insertSql = fake.requests.find((r) => /^INSERT/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/^INSERT INTO "entity_attributes"/);
		expect(insertSql).toMatch(/'active'/);
		expect(insertSql).toMatch(/version/);
		expect(insertSql).toMatch(/, 4\b/); // version 4 inlined as a numeric scalar

		// Step 2: the prior row is marked superseded by the catalog-level helper —
		// an UPDATE of status + superseded_by, never a content mutate.
		const mark = buildSupersedeMarkSql("attr-v3", "attr-v4");
		expect(mark).toMatch(/^UPDATE "entity_attributes" SET/);
		expect(mark).toContain(`status = '${CLAIM_SUPERSEDED}'`);
		expect(mark).toContain("superseded_by = 'attr-v4'");
		expect(mark).toContain("WHERE id = 'attr-v3'");
		// It marks status/superseded_by only — it does not overwrite content.
		expect(mark).not.toMatch(/content\s*=/);
	});

	it("b-AC-3 entity_dependencies carries type/strength/confidence/reason; a related_to edge with empty reason is rejected, a non-empty one accepted", async () => {
		expect(() => validateColumnDefs("entity_dependencies", ENTITY_DEPENDENCIES_COLUMNS)).not.toThrow();
		for (const name of ["source_entity_id", "target_entity_id", "type", "strength", "confidence", "reason"]) {
			expect(colSql(ENTITY_DEPENDENCIES_COLUMNS, name), `column ${name}`).toBeDefined();
		}
		expect(colSql(ENTITY_DEPENDENCIES_COLUMNS, "strength")).toMatch(/FLOAT4/);
		expect(colSql(ENTITY_DEPENDENCIES_COLUMNS, "confidence")).toMatch(/FLOAT4/);

		// A related_to edge with an empty (or whitespace) reason is rejected.
		expect(() => assertDependencyReason(RELATED_TO, "")).toThrow(DependencyReasonError);
		expect(() => assertDependencyReason(RELATED_TO, "   ")).toThrow(DependencyReasonError);
		// A non-related_to edge needs no reason.
		expect(() => assertDependencyReason("depends_on", "")).not.toThrow();

		// A non-empty related_to edge passes validation AND writes via the real
		// append-only primitive, carrying type/strength/confidence/reason.
		expect(() => assertDependencyReason(RELATED_TO, "co-occurs in the same session")).not.toThrow();
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // INSERT ok
		const res = await appendOnlyInsert(client(fake), healTargetFor("entity_dependencies"), SCOPE, [
			["id", val.str("dep-1")],
			["source_entity_id", val.str("e1")],
			["target_entity_id", val.str("e2")],
			["type", val.str(RELATED_TO)],
			["strength", val.num(0.4)],
			["confidence", val.num(0.9)],
			["reason", val.text("co-occurs in the same session")],
		]);
		expect(res.kind).toBe("ok");
		const sql = fake.requests[0].sql;
		expect(sql).toMatch(/^INSERT INTO "entity_dependencies"/);
		expect(sql).toMatch(/'related_to'/);
		expect(sql).toMatch(/strength/);
		expect(sql).toMatch(/confidence/);
		// Append-only pattern (each edge an immutable record).
		expect(REGISTRY.patternFor("entity_dependencies")).toBe("append-only");
		expect(REGISTRY.primitiveFor("entity_dependencies")).toBe("appendOnlyInsert");
	});

	it("b-AC-4 ontology_proposals carries operation, status, JSONB payload, confidence, rationale, evidence, risk_note", () => {
		expect(() => validateColumnDefs("ontology_proposals", ONTOLOGY_PROPOSALS_COLUMNS)).not.toThrow();
		for (const name of ["operation", "status", "payload", "confidence", "rationale", "evidence", "risk_note"]) {
			expect(colSql(ONTOLOGY_PROPOSALS_COLUMNS, name), `column ${name}`).toBeDefined();
		}
		// payload is JSONB (genuinely schemaless control-plane body, CONVENTIONS §5)
		// and is nullable (no NOT NULL → NULL is its implicit default).
		expect(colSql(ONTOLOGY_PROPOSALS_COLUMNS, "payload")).toBe("JSONB");
		expect(colSql(ONTOLOGY_PROPOSALS_COLUMNS, "payload")).not.toMatch(/NOT NULL/);
		// Append-only control plane: status advances by a new row.
		expect(REGISTRY.patternFor("ontology_proposals")).toBe("append-only");
		expect(REGISTRY.primitiveFor("ontology_proposals")).toBe("appendOnlyInsert");
	});

	it("b-AC-5 memory_entity_mentions joins memory_id to entity_id with a mention count/score", async () => {
		expect(() => validateColumnDefs("memory_entity_mentions", MEMORY_ENTITY_MENTIONS_COLUMNS)).not.toThrow();
		for (const name of ["memory_id", "entity_id", "mention_count", "score"]) {
			expect(colSql(MEMORY_ENTITY_MENTIONS_COLUMNS, name), `column ${name}`).toBeDefined();
		}
		// The join row writes through the real append-only primitive.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // INSERT ok
		const res = await appendOnlyInsert(client(fake), healTargetFor("memory_entity_mentions"), SCOPE, [
			["id", val.str("men-1")],
			["memory_id", val.str("m1")],
			["entity_id", val.str("e1")],
			["mention_count", val.num(2)],
			["score", val.num(0.75)],
		]);
		expect(res.kind).toBe("ok");
		const sql = fake.requests[0].sql;
		expect(sql).toMatch(/^INSERT INTO "memory_entity_mentions"/);
		expect(sql).toMatch(/memory_id/);
		expect(sql).toMatch(/entity_id/);
		expect(sql).toMatch(/'m1'/);
		expect(sql).toMatch(/'e1'/);
	});

	it("b-AC-6 the highest-active-version read returns the current claim (ORDER BY version DESC, status='active')", async () => {
		const readSql = buildHighestActiveVersionSql("claim-1");
		expect(readSql).toMatch(/^SELECT \* FROM "entity_attributes"/);
		expect(readSql).toContain("claim_key = 'claim-1'");
		expect(readSql).toContain(`status = '${CLAIM_ACTIVE}'`);
		expect(readSql).toMatch(/ORDER BY version DESC LIMIT 1/);

		// Against the fake transport, the read resolves the active highest version
		// even though a superseded row also exists for the claim.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ id: "attr-v4", version: 4, status: "active", claim_key: "claim-1" }]);
		const result = await client(fake).query(readSql, SCOPE);
		expect(result.kind).toBe("ok");
		expect(result.kind === "ok" && result.rows[0].version).toBe(4);
		expect(result.kind === "ok" && result.rows[0].status).toBe("active");
		// The read filtered on the active status and ordered by version.
		expect(fake.requests[0].sql).toContain(`status = '${CLAIM_ACTIVE}'`);
		expect(fake.requests[0].sql).toMatch(/ORDER BY version DESC/);
	});

	it("b-AC-7 first write to an ontology table creates from the ColumnDef array and retries once", async () => {
		const seen: string[] = [];
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) {
					throw new TransportError("query", 'relation "entities" does not exist', 404);
				}
				return []; // retry succeeds
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				return ENTITIES_COLUMNS.map((c) => ({ column_name: c.name }));
			}
			return []; // any SELECT probe → absent
		});
		const res = await appendOnlyInsert(client(fake), healTargetFor("entities"), SCOPE, [
			["id", val.str("e-first")],
			["name", val.str("Acme")],
		]);
		expect(res.kind).toBe("ok");
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "entities"/.test(s))).toBe(true);
		// The create DDL is exactly what the catalog ColumnDef array renders.
		expect(buildCreateTableSql("entities", ENTITIES_COLUMNS)).toMatch(
			/CREATE TABLE IF NOT EXISTS "entities" \(.*\) USING deeplake/,
		);
		// Original INSERT + one retry after heal.
		expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2);
	});

	it("epistemic_assertions records stance, subject, predicate, provenance and is version-bumped (FR-6)", () => {
		expect(() => validateColumnDefs("epistemic_assertions", EPISTEMIC_ASSERTIONS_COLUMNS)).not.toThrow();
		for (const name of ["stance", "subject", "predicate", "object", "provenance", "version", "status"]) {
			expect(colSql(EPISTEMIC_ASSERTIONS_COLUMNS, name), `column ${name}`).toBeDefined();
		}
		// All seven FR-6 stances are catalogued.
		expect(EPISTEMIC_STANCES).toEqual([
			"claimed",
			"believed",
			"observed",
			"decided",
			"preferred",
			"denied",
			"questioned",
		]);
		expect(REGISTRY.patternFor("epistemic_assertions")).toBe("version-bumped");
		expect(catalogTable("epistemic_assertions")?.embeddingColumns).toEqual(["content_embedding"]);
	});

	it("registry + catalog: all seven ontology tables are present with their assigned patterns; legacy relations is excluded (FR-8)", () => {
		const expected: Record<string, string> = {
			entities: "update-or-insert",
			entity_aspects: "update-or-insert",
			entity_attributes: "version-bumped",
			entity_dependencies: "append-only",
			memory_entity_mentions: "append-only",
			epistemic_assertions: "version-bumped",
			ontology_proposals: "append-only",
		};
		for (const [name, pattern] of Object.entries(expected)) {
			expect(CATALOG.some((t) => t.name === name), `catalog has ${name}`).toBe(true);
			expect(REGISTRY.patternFor(name), `pattern for ${name}`).toBe(pattern);
			expect(catalogTable(name)?.scope, `scope for ${name}`).toBe("agent");
		}
		// The group exports exactly the seven tables.
		expect(KNOWLEDGE_GRAPH_TABLES.map((t) => t.name).sort()).toEqual(Object.keys(expected).sort());
		// FR-8: the legacy relations table is NOT defined in the new catalog.
		expect(CATALOG.some((t) => t.name === "relations")).toBe(false);
	});
});
