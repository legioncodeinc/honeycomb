/**
 * PRD-009a — `dreaming_state` catalog table — proves the FR-1 column + scope + pattern.
 *
 * Verification posture (EXECUTION_LEDGER-prd-009): no live DeepLake. The binding
 * DoD at the catalog level: the ColumnDef array validates (no NOT NULL without
 * DEFAULT); the FR-1 columns are present with the right types/defaults; the table
 * is `version-bumped` (D-3) and `scope:"agent"` (D-1) and flows into `CATALOG` /
 * `REGISTRY` through the barrel.
 */

import { describe, expect, it } from "vitest";

import { validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, REGISTRY, catalogTable, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	DREAMING_STATE_COLUMNS,
	DREAMING_STATE_TABLE,
} from "../../../../src/daemon/storage/catalog/dreaming-state.js";

/** Find a column's `sql` from a ColumnDef array. */
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-009a dreaming_state catalog table", () => {
	it("carries the FR-1 columns: tokens_since_last_pass (BIGINT), last_pass_at, pending_job_id, version", () => {
		expect(() => validateColumnDefs(DREAMING_STATE_TABLE, DREAMING_STATE_COLUMNS)).not.toThrow();
		// FR-1 counter column is a BIGINT defaulting to 0.
		expect(colSql(DREAMING_STATE_COLUMNS, "tokens_since_last_pass")).toMatch(/BIGINT NOT NULL DEFAULT 0/);
		// FR-1 pass-tracking columns present.
		expect(colSql(DREAMING_STATE_COLUMNS, "last_pass_at")).toBeDefined();
		expect(colSql(DREAMING_STATE_COLUMNS, "pending_job_id")).toBeDefined();
		// version-bump key (D-3).
		expect(colSql(DREAMING_STATE_COLUMNS, "version")).toMatch(/BIGINT NOT NULL DEFAULT 1/);
		// identity key.
		expect(colSql(DREAMING_STATE_COLUMNS, "id")).toBeDefined();
	});

	it("is engine-scoped (D-1 / D-2): carries agent_id + visibility, NO org_id/workspace_id columns", () => {
		expect(colSql(DREAMING_STATE_COLUMNS, "agent_id")).toMatch(/DEFAULT 'default'/);
		expect(colSql(DREAMING_STATE_COLUMNS, "visibility")).toMatch(/DEFAULT 'global'/);
		// Org/workspace isolation rides the partition, NOT columns (CONVENTIONS §3).
		expect(colSql(DREAMING_STATE_COLUMNS, "org_id")).toBeUndefined();
		expect(colSql(DREAMING_STATE_COLUMNS, "workspace_id")).toBeUndefined();
	});

	it("flows into CATALOG + REGISTRY as version-bumped / agent scope (D-3 / D-1)", () => {
		const record = catalogTable(DREAMING_STATE_TABLE);
		expect(record, "dreaming_state in the catalog").toBeDefined();
		expect(record?.pattern).toBe("version-bumped");
		expect(record?.scope).toBe("agent");
		expect(record?.embeddingColumns).toEqual([]);
		expect(REGISTRY.primitiveFor(DREAMING_STATE_TABLE)).toBe("appendVersionBumped");
		expect(CATALOG.some((t) => t.name === DREAMING_STATE_TABLE)).toBe(true);
		// healTargetFor resolves it without re-stating columns.
		expect(healTargetFor(DREAMING_STATE_TABLE).table).toBe(DREAMING_STATE_TABLE);
	});
});
