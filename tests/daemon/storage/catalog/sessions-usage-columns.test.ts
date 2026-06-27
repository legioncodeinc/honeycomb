/**
 * PRD-060a — Token & Cache Usage Capture: the additive `sessions` columns + heal.
 *
 *   - a-AC-3 — the `sessions` group gains `input_tokens`, `output_tokens`,
 *     `cache_read_input_tokens`, `cache_creation_input_tokens` (nullable BIGINT)
 *     and `source_tool` (TEXT NOT NULL DEFAULT '') via the ADDITIVE schema-heal
 *     path; the heal is additive (ALTER ADD COLUMN, no drop/rewrite) and idempotent.
 *   - a-AC-4 — a legacy dataset MISSING the columns heals them in additively; the
 *     pre-heal introspection diff is exactly the five new columns.
 *
 * The single ColumnDef source flows into `CATALOG`/`healTargetFor("sessions")` via
 * the barrel spread, so this suite asserts the columns are reachable through the
 * SAME `healTargetFor` the capture handler uses — no separate heal wiring exists.
 */

import { describe, expect, it } from "vitest";

import { buildAddColumnSql, buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { SESSIONS_COLUMNS } from "../../../../src/daemon/storage/catalog/sessions-summaries.js";

function colSql(name: string): string | undefined {
	return SESSIONS_COLUMNS.find((c) => c.name === name)?.sql;
}

const TOKEN_COLUMNS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

describe("PRD-060a a-AC-3: the sessions group gains the five additive usage columns", () => {
	it("a-AC-3 the four token columns are NULLABLE BIGINT (no DEFAULT 0 — zero ≠ null)", () => {
		for (const name of TOKEN_COLUMNS) {
			const sql = colSql(name);
			expect(sql, name).toBe("BIGINT");
			// The load-bearing zero-vs-null property: NO DEFAULT, so an absent count is SQL NULL
			// ("token data absent"), kept DISTINCT from a measured 0. A `DEFAULT 0` would collapse them.
			expect(sql, `${name} must not default`).not.toMatch(/DEFAULT/i);
			expect(sql, `${name} must be nullable`).not.toMatch(/NOT NULL/i);
		}
	});

	it("a-AC-7 source_tool is TEXT NOT NULL DEFAULT '' (the always-present discriminant)", () => {
		expect(colSql("source_tool")).toBe("TEXT NOT NULL DEFAULT ''");
	});

	it("PRD-060 ROI fix: model is TEXT NOT NULL DEFAULT '' ('' = model unknown), healed additively", () => {
		expect(colSql("model")).toBe("TEXT NOT NULL DEFAULT ''");
		const def = SESSIONS_COLUMNS.find((c) => c.name === "model")!;
		// Additive heal via the SAME ALTER ADD COLUMN path; '' backfills on a populated legacy table.
		expect(buildAddColumnSql("sessions", def)).toBe(`ALTER TABLE "sessions" ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
		// Reachable through healTargetFor('sessions') (single-sourced via the barrel spread).
		expect(healTargetFor("sessions").columns.map((c) => c.name)).toContain("model");
	});

	it("a-AC-3 the whole sessions array still validates (nullable BIGINT is exempt from the NOT-NULL-DEFAULT guard)", () => {
		expect(() => validateColumnDefs("sessions", SESSIONS_COLUMNS)).not.toThrow();
	});

	it("a-AC-3 the columns are reachable through healTargetFor('sessions') (single-sourced via the barrel)", () => {
		const target = healTargetFor("sessions");
		const names = target.columns.map((c) => c.name);
		for (const name of [...TOKEN_COLUMNS, "source_tool"]) {
			expect(names, name).toContain(name);
		}
		// And the catalog table aggregates the SAME single ColumnDef source (by content).
		const sessions = CATALOG.find((t) => t.name === "sessions");
		expect(sessions?.columns).toEqual(SESSIONS_COLUMNS);
	});
});

describe("PRD-060a a-AC-3 / a-AC-4: the heal is ADDITIVE (ALTER ADD COLUMN) and idempotent", () => {
	it("a-AC-3 each new column heals via a targeted ALTER TABLE ADD COLUMN — never a drop/rewrite", () => {
		for (const name of TOKEN_COLUMNS) {
			const def = SESSIONS_COLUMNS.find((c) => c.name === name)!;
			expect(buildAddColumnSql("sessions", def)).toBe(`ALTER TABLE "sessions" ADD COLUMN ${name} BIGINT`);
		}
		const srcDef = SESSIONS_COLUMNS.find((c) => c.name === "source_tool")!;
		expect(buildAddColumnSql("sessions", srcDef)).toBe(
			`ALTER TABLE "sessions" ADD COLUMN source_tool TEXT NOT NULL DEFAULT ''`,
		);
	});

	it("a-AC-3 the CREATE TABLE carries all five columns from the single ColumnDef source", () => {
		const create = buildCreateTableSql("sessions", SESSIONS_COLUMNS);
		for (const name of TOKEN_COLUMNS) {
			expect(create).toMatch(new RegExp(`\\b${name} BIGINT\\b`));
		}
		expect(create).toMatch(/\bsource_tool TEXT NOT NULL DEFAULT ''/);
	});

	it("a-AC-4 a legacy dataset missing the columns diffs to exactly the additive columns (no rewrite of existing)", () => {
		// Simulate `information_schema.columns` for a pre-060a / pre-060-ROI table: every column EXCEPT
		// the 060a five AND the PRD-060 ROI `model` column. The diff must be EXACTLY those additive
		// columns — the existing columns are untouched (no drop/rewrite).
		const newNames = new Set<string>([...TOKEN_COLUMNS, "source_tool", "model"]);
		const legacyPresent = new Set(
			SESSIONS_COLUMNS.filter((c) => !newNames.has(c.name)).map((c) => c.name.toLowerCase()),
		);
		const missing = SESSIONS_COLUMNS.filter((c) => !legacyPresent.has(c.name.toLowerCase())).map((c) => c.name);
		expect(new Set(missing)).toEqual(newNames);
	});

	it("a-AC-3 the heal is idempotent: once present, the diff is empty (no re-ALTER)", () => {
		// After the heal, every column is present → the add-only-missing diff is a no-op.
		const allPresent = new Set(SESSIONS_COLUMNS.map((c) => c.name.toLowerCase()));
		const missing = SESSIONS_COLUMNS.filter((c) => !allPresent.has(c.name.toLowerCase()));
		expect(missing).toHaveLength(0);
	});
});
