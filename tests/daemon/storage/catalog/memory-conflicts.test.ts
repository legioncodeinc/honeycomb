/**
 * PRD-058b — the memory_conflicts catalog table (the `κ(m,t)` projection).
 *
 * Locks the additive-heal schema: the ColumnDef array validates, the table is registered in CATALOG with
 * the `version-bumped` pattern + `agent` scope, the enum/score/nullable columns carry the right DDL, and the
 * SQL builders + the normalized-pair canonicalizer behave. No live DeepLake — validated against the catalog
 * + the fake transport, exactly like memories.test.ts.
 */

import { describe, expect, it } from "vitest";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, catalogTable, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	buildConflictByIdSql,
	buildOpenConflictProjectionSql,
	CONFLICT_SIGNALS,
	CONFLICT_STATUSES,
	CONFLICT_VERDICTS,
	DEFAULT_CONFLICT_STATUS,
	DEFAULT_CONFLICT_VERDICT,
	isConflictSignal,
	isConflictStatus,
	isConflictVerdict,
	MEMORY_CONFLICTS_COLUMNS,
	MEMORY_CONFLICTS_TABLE,
	normalizeConflictPair,
} from "../../../../src/daemon/storage/catalog/memory-conflicts.js";

/** Find a column's `sql` from a ColumnDef array. */
function colSql(name: string): string | undefined {
	return MEMORY_CONFLICTS_COLUMNS.find((c) => c.name === name)?.sql;
}

describe("PRD-058b memory_conflicts — schema", () => {
	it("the ColumnDef array validates (no NOT-NULL-without-DEFAULT, no bad identifier)", () => {
		expect(() => validateColumnDefs(MEMORY_CONFLICTS_TABLE, MEMORY_CONFLICTS_COLUMNS)).not.toThrow();
	});

	it("is registered in CATALOG with the version-bumped pattern + agent scope", () => {
		const t = catalogTable(MEMORY_CONFLICTS_TABLE);
		expect(t).toBeDefined();
		expect(t!.pattern).toBe("version-bumped");
		expect(t!.scope).toBe("agent");
		expect(t!.embeddingColumns).toEqual([]);
		expect(CATALOG.some((x) => x.name === MEMORY_CONFLICTS_TABLE)).toBe(true);
	});

	it("carries the normalized pair, the audit-trail scores, the κ_loser, and the version column", () => {
		expect(colSql("memory_a_id")).toMatch(/TEXT/);
		expect(colSql("memory_b_id")).toMatch(/TEXT/);
		// Scores are FLOAT4; nullable resolution fields have NO DEFAULT (NULL is implicit, heal-safe).
		expect(colSql("contra_score")).toMatch(/FLOAT4 NOT NULL DEFAULT/);
		expect(colSql("margin")).toBe("FLOAT4"); // nullable until resolved.
		expect(colSql("kappa_loser")).toBe("FLOAT4"); // nullable until resolved.
		expect(colSql("winner_id")).toBe("TEXT"); // nullable until resolved.
		// The enums default to the SAFETY defaults.
		expect(colSql("verdict")).toMatch(/DEFAULT 'review'/);
		expect(colSql("status")).toMatch(/DEFAULT 'open'/);
		expect(colSql("version")).toMatch(/BIGINT NOT NULL DEFAULT 1/);
		// The engine scope columns (D-2): agent_id + visibility, NO org/workspace column.
		expect(colSql("agent_id")).toMatch(/DEFAULT 'default'/);
		expect(colSql("visibility")).toMatch(/DEFAULT 'global'/);
		expect(MEMORY_CONFLICTS_COLUMNS.some((c) => c.name === "org_id" || c.name === "workspace_id")).toBe(false);
	});

	it("the CREATE TABLE DDL emits a USING deeplake table over the columns", () => {
		const ddl = buildCreateTableSql(MEMORY_CONFLICTS_TABLE, MEMORY_CONFLICTS_COLUMNS);
		expect(ddl).toMatch(/CREATE TABLE/i);
		expect(ddl).toMatch(/memory_conflicts/);
		// healTargetFor resolves the table (so the version-bumped writer heals it on first write).
		expect(healTargetFor(MEMORY_CONFLICTS_TABLE).table).toBe(MEMORY_CONFLICTS_TABLE);
	});

	it("the enum value sets + their defaults + the narrowers are consistent", () => {
		expect(CONFLICT_SIGNALS).toEqual(["lexical", "embedding", "model"]);
		expect(CONFLICT_VERDICTS).toContain("supersede");
		expect(CONFLICT_STATUSES).toEqual(["open", "resolved", "reversed"]);
		expect(DEFAULT_CONFLICT_VERDICT).toBe("review"); // the safety default, never supersede.
		expect(DEFAULT_CONFLICT_STATUS).toBe("open");
		expect(isConflictSignal("model")).toBe(true);
		expect(isConflictSignal("bogus")).toBe(false);
		expect(isConflictVerdict("supersede")).toBe(true);
		expect(isConflictStatus("reversed")).toBe(true);
	});
});

describe("PRD-058b normalizeConflictPair — the canonical (sorted) pair", () => {
	it("sorts the pair so a pair is recorded once regardless of detection order", () => {
		expect(normalizeConflictPair("b", "a")).toEqual({ aId: "a", bId: "b" });
		expect(normalizeConflictPair("a", "b")).toEqual({ aId: "a", bId: "b" });
	});
});

describe("PRD-058b SQL builders — guarded, MAX(version)-aware", () => {
	it("the open-conflict projection reads the live (MAX version) OPEN rows", () => {
		const sql = buildOpenConflictProjectionSql();
		expect(sql).toMatch(/FROM\s+"memory_conflicts"/);
		expect(sql).toMatch(/MAX\(version\)/);
		expect(sql).toMatch(/status\s*=\s*'open'/);
	});

	it("the by-id lookup reads the highest-version row, id routed through sLiteral", () => {
		const sql = buildConflictByIdSql("c-123");
		expect(sql).toMatch(/id\s*=\s*'c-123'/);
		expect(sql).toMatch(/ORDER BY\s+version\s+DESC\s+LIMIT 1/);
	});

	it("a by-id lookup escapes a quote-bearing id (no SQL injection through the id)", () => {
		const sql = buildConflictByIdSql("c'; DROP TABLE x; --");
		// The single quote is doubled by sLiteral; the statement still targets the id column literal.
		expect(sql).toContain("''");
	});
});
