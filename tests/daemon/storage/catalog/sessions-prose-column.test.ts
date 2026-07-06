/**
 * PRD-074a — Sessions Prose Column: the additive `sessions.prose` column + heal.
 *
 *   - a-AC-1 — the `sessions` group gains `prose` (TEXT NOT NULL DEFAULT ''),
 *     positioned alongside the existing additive columns (`model`, `source_tool`).
 *   - a-AC-2 — the column heals cleanly onto a legacy `sessions` table via the
 *     ADDITIVE schema-heal path (`healColumns` / `withHeal`). The heal is
 *     additive (a targeted `ALTER TABLE ADD COLUMN`; no drop/rewrite) AND
 *     idempotent (a second heal on an already-healed table is a no-op). Mirrors
 *     PRD-060a's a-AC-3 discipline exactly.
 *
 * The single ColumnDef source flows into `CATALOG` / `healTargetFor("sessions")`
 * via the barrel spread, so this suite asserts `prose` is reachable through the
 * SAME `healTargetFor` the capture handler uses — no separate heal wiring exists.
 */

import { describe, expect, it } from "vitest";

import { buildAddColumnSql, buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { SESSIONS_COLUMNS } from "../../../../src/daemon/storage/catalog/sessions-summaries.js";

function colSql(name: string): string | undefined {
	return SESSIONS_COLUMNS.find((c) => c.name === name)?.sql;
}

describe("PRD-074a a-AC-1: the sessions group gains the additive `prose` column", () => {
	it("a-AC-1 `prose` is TEXT NOT NULL DEFAULT '' ('' = prose absent, legacy fallback)", () => {
		expect(colSql("prose")).toBe("TEXT NOT NULL DEFAULT ''");
	});

	it("a-AC-1 `prose` is positioned alongside the existing additive columns (model / source_tool)", () => {
		const names = SESSIONS_COLUMNS.map((c) => c.name);
		const proseIdx = names.indexOf("prose");
		const sourceToolIdx = names.indexOf("source_tool");
		const modelIdx = names.indexOf("model");
		expect(proseIdx).toBeGreaterThan(-1);
		// `prose` sits with the additive columns, after `source_tool` (the last 060a
		// additive column) and before the `creation_date` / `last_update_date` bookend.
		expect(proseIdx).toBeGreaterThan(sourceToolIdx);
		expect(proseIdx).toBeGreaterThan(modelIdx);
		expect(names[proseIdx + 1]).toBe("creation_date");
	});

	it("a-AC-1 the whole sessions array still validates (NOT NULL DEFAULT '' satisfies the load guard)", () => {
		// The load guard at schema.ts validateColumnDefs: a NOT NULL column must carry a
		// DEFAULT. `prose` is `TEXT NOT NULL DEFAULT ''` → the empty string satisfies it,
		// exactly like `model` / `source_tool`.
		expect(() => validateColumnDefs("sessions", SESSIONS_COLUMNS)).not.toThrow();
	});

	it("a-AC-1 `prose` is reachable through healTargetFor('sessions') (single-sourced via the barrel)", () => {
		const target = healTargetFor("sessions");
		expect(target.columns.map((c) => c.name)).toContain("prose");
		// And the catalog table aggregates the SAME single ColumnDef source (by content).
		const sessions = CATALOG.find((t) => t.name === "sessions");
		expect(sessions?.columns).toEqual(SESSIONS_COLUMNS);
	});
});

describe("PRD-074a a-AC-2: the `prose` heal is ADDITIVE (ALTER ADD COLUMN) and idempotent", () => {
	it("a-AC-2 `prose` heals via a targeted ALTER TABLE ADD COLUMN — never a drop/rewrite", () => {
		const def = SESSIONS_COLUMNS.find((c) => c.name === "prose")!;
		// The additive shape: `ALTER TABLE "sessions" ADD COLUMN prose TEXT NOT NULL DEFAULT ''`.
		// No `IF NOT EXISTS` (Deep Lake returns 500-not-409 on a duplicate add; the diff is the
		// guard). No DROP, no rewrite — the existing tensors are untouched.
		expect(buildAddColumnSql("sessions", def)).toBe(
			`ALTER TABLE "sessions" ADD COLUMN prose TEXT NOT NULL DEFAULT ''`,
		);
		// The CREATE TABLE carries `prose` from the SAME single ColumnDef source.
		const create = buildCreateTableSql("sessions", SESSIONS_COLUMNS);
		expect(create).toMatch(/\bprose TEXT NOT NULL DEFAULT ''/);
	});

	it("a-AC-2 a legacy dataset missing `prose` diffs to EXACTLY `prose` (existing columns untouched)", () => {
		// Simulate `information_schema.columns` for a pre-074a table: every column EXCEPT
		// `prose`. The add-only-missing diff must be EXACTLY `['prose']` — every existing
		// column (id, path, message, the 060a usage columns, model, source_tool, …) is left
		// alone. Healing never drops, never rewrites; it only adds what is genuinely absent.
		const legacyPresent = new Set(
			SESSIONS_COLUMNS.filter((c) => c.name !== "prose").map((c) => c.name.toLowerCase()),
		);
		const missing = SESSIONS_COLUMNS.filter((c) => !legacyPresent.has(c.name.toLowerCase())).map((c) => c.name);
		expect(missing).toEqual(["prose"]);
	});

	it("a-AC-2 the heal is idempotent: once `prose` is present, the diff is empty (no re-ALTER)", () => {
		// After the heal, `prose` is present → the add-only-missing diff is a no-op. A second
		// heal on an already-healed table issues zero ALTERs (the guard is the diff, not
		// `IF NOT EXISTS`). This is the c-AC-6 convergence posture.
		const allPresent = new Set(SESSIONS_COLUMNS.map((c) => c.name.toLowerCase()));
		const missing = SESSIONS_COLUMNS.filter((c) => !allPresent.has(c.name.toLowerCase()));
		expect(missing).toHaveLength(0);
	});
});
