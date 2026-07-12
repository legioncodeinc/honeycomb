/**
 * ISS-010 — `memory_injections` catalog table — registration + SQL-builder suite.
 *
 * Verification posture: no live DeepLake. The binding DoD at the catalog level:
 * the ColumnDef array validates (no NOT NULL without DEFAULT), the taxonomy /
 * counter / attribution / scope columns are present with the right defaults, the
 * table is `append-only` + `scope:"agent"` and flows into `CATALOG` / `REGISTRY`
 * through the barrel (so `healTargetFor` resolves it without re-stating columns),
 * and both readers route every identifier through `sqlIdent` and every value
 * through `sLiteral` with COALESCE-on-SUM and NO SQL GROUP BY.
 */

import { describe, expect, it } from "vitest";

import { CATALOG, REGISTRY, catalogTable, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	buildInjectionRangeSql,
	buildInjectionTokenSumSql,
	INJECTION_SOURCES,
	isInjectionSource,
	MEMORY_INJECTIONS_COLUMNS,
	MEMORY_INJECTIONS_TABLE,
} from "../../../../src/daemon/storage/catalog/memory-injections.js";
import { validateColumnDefs } from "../../../../src/daemon/storage/schema.js";

/** Find a column's `sql` from a ColumnDef array. */
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("ISS-010 memory_injections catalog table", () => {
	it("carries the event columns: id/at, source (closed taxonomy default), BIGINT hits/tokens, attribution", () => {
		expect(() => validateColumnDefs(MEMORY_INJECTIONS_TABLE, MEMORY_INJECTIONS_COLUMNS)).not.toThrow();
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "at")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		// The source default is a MEMBER of the closed taxonomy, never '' (an un-stamped row stays valid).
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "source")).toMatch(/DEFAULT 'recall'/);
		// The counters are BIGINT (integer meter values, no floats).
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "hits")).toMatch(/BIGINT NOT NULL DEFAULT 0/);
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "tokens")).toMatch(/BIGINT NOT NULL DEFAULT 0/);
		// Attribution columns (empty-string defaults, the `memories.project_id` precedent).
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "session_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "project_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
	});

	it("is engine-scoped (D-2): carries agent_id + visibility, NO org_id/workspace_id columns", () => {
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "agent_id")).toMatch(/DEFAULT 'default'/);
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "visibility")).toMatch(/DEFAULT 'global'/);
		// Org/workspace isolation rides the partition, NOT columns (CONVENTIONS §3).
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "org_id")).toBeUndefined();
		expect(colSql(MEMORY_INJECTIONS_COLUMNS, "workspace_id")).toBeUndefined();
	});

	it("flows into CATALOG + REGISTRY as append-only / agent scope, and healTargetFor resolves it", () => {
		const record = catalogTable(MEMORY_INJECTIONS_TABLE);
		expect(record, "memory_injections in the catalog").toBeDefined();
		expect(record?.pattern).toBe("append-only");
		expect(record?.scope).toBe("agent");
		expect(record?.embeddingColumns).toEqual([]);
		expect(REGISTRY.primitiveFor(MEMORY_INJECTIONS_TABLE)).toBe("appendOnlyInsert");
		expect(CATALOG.some((t) => t.name === MEMORY_INJECTIONS_TABLE)).toBe(true);
		// healTargetFor hands the writer `{ table, columns }` without re-stating the columns.
		const target = healTargetFor(MEMORY_INJECTIONS_TABLE);
		expect(target.table).toBe(MEMORY_INJECTIONS_TABLE);
		expect(target.columns).toStrictEqual(MEMORY_INJECTIONS_COLUMNS);
	});

	it("the source taxonomy is closed to recall / recall_fast / prime and the guard narrows it", () => {
		expect([...INJECTION_SOURCES]).toEqual(["recall", "recall_fast", "prime"]);
		expect(isInjectionSource("recall")).toBe(true);
		expect(isInjectionSource("recall_fast")).toBe(true);
		expect(isInjectionSource("prime")).toBe(true);
		expect(isInjectionSource("")).toBe(false);
		expect(isInjectionSource("hook")).toBe(false);
	});
});

describe("ISS-010 memory_injections SQL builders (guarded, DeepLake-quirk-safe)", () => {
	it("buildInjectionTokenSumSql COALESCEs the SUM (NULL on zero rows) and has NO GROUP BY", () => {
		const sql = buildInjectionTokenSumSql();
		expect(sql).toBe('SELECT COALESCE(SUM(tokens), 0) AS tokens FROM "memory_injections"');
		expect(sql).not.toMatch(/GROUP BY/i); // SUM under GROUP BY returns NULL on this backend.
	});

	it("buildInjectionTokenSumSql ANDs the project conjunct through sLiteral (blank/absent → workspace-wide)", () => {
		expect(buildInjectionTokenSumSql("proj-1")).toBe(
			`SELECT COALESCE(SUM(tokens), 0) AS tokens FROM "memory_injections" WHERE project_id = 'proj-1'`,
		);
		// Blank project → no clause (workspace-wide), same posture as the KPI counts.
		expect(buildInjectionTokenSumSql("")).not.toContain("WHERE");
		// The value routes through the guard: a quote-bearing id cannot break out of the literal.
		expect(buildInjectionTokenSumSql("p'--")).toContain("'p''--'");
	});

	it("buildInjectionRangeSql ranges lexicographically on the ISO cutoff, guards values, and has NO GROUP BY", () => {
		const sql = buildInjectionRangeSql("2026-07-01T00:00:00.000Z", "proj-2");
		expect(sql).toContain('FROM "memory_injections"');
		expect(sql).toContain("WHERE at >= '2026-07-01T00:00:00.000Z'");
		expect(sql).toContain("AND project_id = 'proj-2'");
		expect(sql).toContain("ORDER BY at ASC");
		expect(sql).not.toMatch(/GROUP BY/i); // day bucketing is a TS concern (`at.slice(0,10)`).
		// A quote-bearing cutoff cannot break out of the literal.
		expect(buildInjectionRangeSql("x'--")).toContain("'x''--'");
	});
});
