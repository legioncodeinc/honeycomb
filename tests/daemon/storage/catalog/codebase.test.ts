/**
 * PRD-014 codebase catalog — the `codebase` snapshot table the graph build pushes to.
 *
 * The `codebase` table is NOT new to PRD-014: it was laid down by PRD-003d
 * (`catalog/product.ts`, ported from hivemind-v1) as the per-identity graph-snapshot
 * store. PRD-014 is the FEATURE that fills it. This test asserts the table the 014c
 * push/pull engine targets is correctly joined CATALOG with the shape that feature
 * needs: SELECT-before-INSERT, tenant scope, the identity tuple, `snapshot_jsonb` +
 * `snapshot_sha256`, and drift-diagnostic columns.
 *
 * Verification posture (EXECUTION_LEDGER-prd-014): no live DeepLake. The binding DoD is
 * a load-time + registry assertion over the existing catalog record.
 */

import { describe, expect, it } from "vitest";

import { CATALOG, catalogTable, healTargetFor, REGISTRY } from "../../../../src/daemon/storage/catalog/index.js";
import { CODEBASE_COLUMNS } from "../../../../src/daemon/storage/catalog/product.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";

const CODEBASE_TABLE = "codebase";

function names(cols: readonly { name: string }[]): string[] {
	return cols.map((c) => c.name);
}
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-014 codebase snapshot table (the 014c push target)", () => {
	it("validates at load + emits CREATE TABLE … USING deeplake DDL", () => {
		expect(() => validateColumnDefs("codebase", CODEBASE_COLUMNS)).not.toThrow();
		const ddl = buildCreateTableSql(CODEBASE_TABLE, CODEBASE_COLUMNS);
		expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "codebase"');
		expect(ddl).toContain("USING deeplake");
	});

	it("is JOINED into CATALOG + REGISTRY exactly once (no duplicate)", () => {
		const matches = CATALOG.filter((t) => t.name === CODEBASE_TABLE);
		expect(matches.length).toBe(1);
		expect(catalogTable(CODEBASE_TABLE)).toBeDefined();
		expect(REGISTRY.byName.get(CODEBASE_TABLE)).toBeDefined();
	});

	it("uses select-before-insert + tenant scope + no embedding (structural, not vector-recalled)", () => {
		const record = catalogTable(CODEBASE_TABLE);
		expect(record?.pattern).toBe("select-before-insert");
		expect(record?.scope).toBe("tenant");
		expect(record?.embeddingColumns).toEqual([]);
	});

	it("carries the identity tuple + snapshot_jsonb + snapshot_sha256 the 014c push needs", () => {
		const cols = names(CODEBASE_COLUMNS);
		// Identity tuple (per the PRD-014 SnapshotIdentity, named per the v1 schema).
		for (const c of ["org_id", "workspace_id", "repo_slug", "user_id", "worktree_id", "commit_sha"]) {
			expect(cols, `identity column ${c}`).toContain(c);
		}
		// Content-addressed push payload + drift fingerprint.
		expect(cols).toContain("snapshot_jsonb");
		expect(cols).toContain("snapshot_sha256");
		expect(colSql(CODEBASE_COLUMNS, "snapshot_jsonb")).toBe("JSONB");
		// Drift diagnostics the determinism guarantee depends on (D-6 generator version).
		expect(cols).toContain("generator_version");
		expect(cols).toContain("schema_version");
	});

	it("every NOT NULL column carries a DEFAULT (heal-compatible ADD COLUMN)", () => {
		for (const c of CODEBASE_COLUMNS) {
			if (/NOT NULL/i.test(c.sql)) {
				expect(c.sql, `${c.name} must DEFAULT for heal ADD COLUMN`).toMatch(/DEFAULT/i);
			}
		}
	});

	it("healTargetFor resolves the codebase columns (the 014c write target)", () => {
		const target = healTargetFor(CODEBASE_TABLE);
		expect(target.table).toBe(CODEBASE_TABLE);
		expect(names(target.columns)).toEqual(names(CODEBASE_COLUMNS));
	});
});
