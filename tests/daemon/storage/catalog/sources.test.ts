/**
 * PRD-013a sources catalog — proves the three new tables joined CATALOG with the
 * right write pattern + scope + provenance, and the graph rows got the additive
 * provenance quartet.
 *
 * Verification posture (EXECUTION_LEDGER-prd-013): no live DeepLake. The binding
 * DoD: each ColumnDef array validates at load; `buildCreateTableSql` emits DDL;
 * the tables appear in CATALOG/REGISTRY with `version-bumped` + `tenant`; the
 * provenance quartet + a `version` column are present; the graph tables carry the
 * additive quartet (heal-compatible, DEFAULT '').
 */

import { describe, expect, it } from "vitest";

import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, catalogTable, healTargetFor, REGISTRY } from "../../../../src/daemon/storage/catalog/index.js";
import {
	ARTIFACT_STATUSES,
	DOCUMENT_CHUNK_COLUMNS,
	DOCUMENT_CHUNK_TABLE,
	DOCUMENT_MEMORIES_COLUMNS,
	DOCUMENT_MEMORIES_TABLE,
	MEMORY_ARTIFACTS_COLUMNS,
	MEMORY_ARTIFACTS_TABLE,
	PROVENANCE_COLUMNS,
	SOURCES_TABLES,
} from "../../../../src/daemon/storage/catalog/sources.js";
import {
	ENTITIES_COLUMNS,
	ENTITY_ATTRIBUTES_COLUMNS,
	ENTITY_DEPENDENCIES_COLUMNS,
	MEMORY_ENTITY_MENTIONS_COLUMNS,
} from "../../../../src/daemon/storage/catalog/knowledge-graph.js";

const PROVENANCE_NAMES = ["source_id", "source_kind", "source_path", "source_root"] as const;

function names(cols: readonly { name: string }[]): string[] {
	return cols.map((c) => c.name);
}

function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-013a sources catalog", () => {
	it("the three tables validate at load + emit CREATE TABLE DDL", () => {
		expect(() => validateColumnDefs("memory_artifacts", MEMORY_ARTIFACTS_COLUMNS)).not.toThrow();
		expect(() => validateColumnDefs("document_memories", DOCUMENT_MEMORIES_COLUMNS)).not.toThrow();
		expect(() => validateColumnDefs("document_chunk", DOCUMENT_CHUNK_COLUMNS)).not.toThrow();

		const ddl = buildCreateTableSql(MEMORY_ARTIFACTS_TABLE, MEMORY_ARTIFACTS_COLUMNS);
		expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "memory_artifacts"');
		expect(ddl).toContain("USING deeplake");
	});

	it("all three joined CATALOG as version-bumped + tenant-scoped", () => {
		for (const table of [MEMORY_ARTIFACTS_TABLE, DOCUMENT_MEMORIES_TABLE, DOCUMENT_CHUNK_TABLE]) {
			const record = catalogTable(table);
			expect(record, `${table} in CATALOG`).toBeDefined();
			expect(record?.pattern, `${table} pattern`).toBe("version-bumped");
			expect(record?.scope, `${table} scope`).toBe("tenant");
			// REGISTRY resolved a primitive for it, and healTargetFor works.
			expect(REGISTRY.byName.get(table)).toBeDefined();
			expect(healTargetFor(table).table).toBe(table);
		}
		// The group is part of the aggregate catalog.
		for (const t of SOURCES_TABLES) {
			expect(CATALOG.some((c) => c.name === t.name)).toBe(true);
		}
	});

	it("every source-derived row carries the provenance quartet + explicit tenancy + a version column", () => {
		for (const cols of [MEMORY_ARTIFACTS_COLUMNS, DOCUMENT_MEMORIES_COLUMNS, DOCUMENT_CHUNK_COLUMNS]) {
			for (const p of PROVENANCE_NAMES) {
				expect(names(cols)).toContain(p);
				expect(colSql(cols, p)).toBe("TEXT NOT NULL DEFAULT ''");
			}
			// tenant scope columns (D-2: explicit org/workspace, not agent_id).
			expect(names(cols)).toContain("org_id");
			expect(names(cols)).toContain("workspace_id");
			// version-bumped → a version column with default 1.
			expect(colSql(cols, "version")).toBe("BIGINT NOT NULL DEFAULT 1");
		}
		// The shared PROVENANCE_COLUMNS export matches the quartet.
		expect(names(PROVENANCE_COLUMNS)).toEqual([...PROVENANCE_NAMES]);
	});

	it("document_chunk carries the nullable 768-dim chunk_embedding + a content_hash for shared-embedding dedup", () => {
		const record = catalogTable(DOCUMENT_CHUNK_TABLE);
		expect(record?.embeddingColumns).toContain("chunk_embedding");
		expect(colSql(DOCUMENT_CHUNK_COLUMNS, "chunk_embedding")).toBe("FLOAT4[]"); // nullable by design
		expect(colSql(DOCUMENT_CHUNK_COLUMNS, "content_hash")).toBe("TEXT NOT NULL DEFAULT ''");
	});

	it("status column defaults active; the four lifecycle states are frozen in order", () => {
		expect(colSql(MEMORY_ARTIFACTS_COLUMNS, "status")).toBe("TEXT NOT NULL DEFAULT 'active'");
		expect([...ARTIFACT_STATUSES]).toEqual(["active", "superseded", "deleted", "failure"]);
	});

	it("the source-derived graph tables got the additive provenance quartet (heal-compatible, DEFAULT '')", () => {
		// entities already had source_id; the additive cols add the rest of the quartet.
		for (const p of PROVENANCE_NAMES) {
			expect(names(ENTITIES_COLUMNS), `entities.${p}`).toContain(p);
			expect(names(ENTITY_ATTRIBUTES_COLUMNS), `entity_attributes.${p}`).toContain(p);
			expect(names(ENTITY_DEPENDENCIES_COLUMNS), `entity_dependencies.${p}`).toContain(p);
			expect(names(MEMORY_ENTITY_MENTIONS_COLUMNS), `memory_entity_mentions.${p}`).toContain(p);
		}
		// The additive columns are NOT NULL DEFAULT '' so the heal ADD COLUMN backfills.
		for (const cols of [ENTITY_ATTRIBUTES_COLUMNS, ENTITY_DEPENDENCIES_COLUMNS, MEMORY_ENTITY_MENTIONS_COLUMNS]) {
			for (const p of PROVENANCE_NAMES) {
				expect(colSql(cols, p)).toBe("TEXT NOT NULL DEFAULT ''");
			}
		}
		// The graph tables still validate at load with the additive columns.
		expect(() => validateColumnDefs("entities", ENTITIES_COLUMNS)).not.toThrow();
		expect(() => validateColumnDefs("entity_attributes", ENTITY_ATTRIBUTES_COLUMNS)).not.toThrow();
	});
});
