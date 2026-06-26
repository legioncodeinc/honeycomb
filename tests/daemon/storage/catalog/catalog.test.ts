/**
 * PRD-003 catalog spine — barrel + registry wiring (index AC-1/AC-4 at the
 * catalog level) and the Wave-2 stub contract.
 *
 * Proves the scaffold Wave 2 depends on: every group array is spread into
 * `CATALOG`, the registry derives a pattern for every table, the b/d/e stubs are
 * wired as empty arrays (so the barrel compiles before they are filled), and the
 * `defineTable` guards reject a malformed table.
 */

import { describe, expect, it } from "vitest";
import { buildCreateTableSql } from "../../../../src/daemon/storage/schema.js";
import {
	CATALOG,
	healTargetFor,
	KNOWLEDGE_GRAPH_TABLES,
	PRODUCT_TABLES,
	REGISTRY,
	TENANCY_TABLES,
} from "../../../../src/daemon/storage/catalog/index.js";
import { defineTable } from "../../../../src/daemon/storage/catalog/types.js";

const WRITE_PATTERNS = new Set(["append-only", "version-bumped", "update-or-insert", "select-before-insert"]);

describe("PRD-003 catalog barrel + registry", () => {
	it("index AC-1: every catalog table is created from its ColumnDef array via buildCreateTableSql", () => {
		expect(CATALOG.length).toBeGreaterThan(0);
		for (const t of CATALOG) {
			const ddl = buildCreateTableSql(t.name, t.columns);
			expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${t.name}"`);
			expect(ddl).toContain("USING deeplake");
			// healTargetFor returns the same single-source columns.
			expect(healTargetFor(t.name).columns).toBe(t.columns);
		}
	});

	it("registry assigns a known write pattern + primitive to every table", () => {
		for (const t of CATALOG) {
			expect(WRITE_PATTERNS.has(t.pattern), `${t.name} pattern ${t.pattern}`).toBe(true);
			expect(REGISTRY.patternFor(t.name)).toBe(t.pattern);
			expect(REGISTRY.primitiveFor(t.name)).toBeDefined();
		}
		expect(REGISTRY.patternFor("nonexistent")).toBeUndefined();
	});

	it("index AC-4: every declared embedding column exists in its table and is a nullable FLOAT4[]", () => {
		for (const t of CATALOG) {
			for (const embName of t.embeddingColumns) {
				const col = t.columns.find((c) => c.name === embName);
				expect(col, `${t.name}.${embName}`).toBeDefined();
				expect(col?.sql).toBe("FLOAT4[]");
				expect(col?.sql).not.toMatch(/NOT NULL/);
			}
		}
	});

	it("Wave-2 groups (003b/003d/003e) are all filled and wired through the barrel", () => {
		// 003d product tables.
		expect(PRODUCT_TABLES.map((t) => t.name).sort()).toEqual(["codebase", "goals", "kpis", "rules", "skills"]);
		// 003b knowledge-graph: 7 ontology tables (legacy `relations` excluded per FR-8).
		expect(KNOWLEDGE_GRAPH_TABLES.map((t) => t.name).sort()).toEqual([
			"entities",
			"entity_aspects",
			"entity_attributes",
			"entity_dependencies",
			"epistemic_assertions",
			"memory_entity_mentions",
			"ontology_proposals",
		]);
		// 003e agents/auth/telemetry: 5 tables + PRD-060f roi_metrics/teams: 2 tables.
		expect(TENANCY_TABLES.map((t) => t.name).sort()).toEqual([
			"agents",
			"api_keys",
			"recall_qa_ledger",
			"roi_metrics",
			"router_history",
			"teams",
			"telemetry_counters",
		]);
		// Every table in the catalog has a valid pattern + create DDL.
		for (const t of CATALOG) {
			expect(WRITE_PATTERNS.has(t.pattern), `${t.name} has known pattern`).toBe(true);
		}
	});

	it("defineTable rejects a NOT NULL column without a DEFAULT (load-time guard)", () => {
		expect(() =>
			defineTable({
				name: "bad",
				columns: [{ name: "x", sql: "TEXT NOT NULL" }],
				pattern: "append-only",
				embeddingColumns: [],
				scope: "none",
			}),
		).toThrow();
	});

	it("defineTable rejects an embedding column not present in the ColumnDef array", () => {
		expect(() =>
			defineTable({
				name: "bad2",
				columns: [{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" }],
				pattern: "append-only",
				embeddingColumns: ["missing_embedding"],
				scope: "none",
			}),
		).toThrow();
	});
});
