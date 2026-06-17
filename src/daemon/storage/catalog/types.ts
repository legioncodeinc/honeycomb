/**
 * Catalog record shape + write-pattern taxonomy (PRD-003, Wave 1 spine).
 *
 * Every durable Honeycomb table is described ONCE as a {@link CatalogTable}
 * record: its name, its `readonly ColumnDef[]` (the single source the create
 * path and the heal pass both iterate, PRD-002c), the embedding columns it
 * carries, the tenancy `scope` it relies on (D-2), and the {@link WritePattern}
 * its writers MUST use (PRD-002d). The barrel (`index.ts`) aggregates every
 * group's records into one `CATALOG`, validates each ColumnDef array at module
 * load via `validateColumnDefs`, and exposes the table→pattern registry the
 * write primitives + later producers consume.
 *
 * This file defines the SHAPE only — it imports nothing from the group files,
 * so a group file (`memories.ts`, `sessions-summaries.ts`, the b/d/e stubs) can
 * import {@link CatalogTable} without a circular dependency on the barrel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 2 CONTRACT (read before filling a stub)
 * ─────────────────────────────────────────────────────────────────────────────
 * A Wave-2 Bee filling a `knowledge-graph.ts` / `product.ts` / `tenancy.ts`
 * stub edits ONLY that one group file and ONLY its own test file. It NEVER
 * touches this file, the barrel (`index.ts`), or `registry.ts`: the barrel
 * already imports and spreads every group array, so a filled stub flows into
 * `CATALOG` and the pattern registry automatically. The contract is:
 *
 *   1. Export a `readonly CatalogTable[]` named `<GROUP>_TABLES` from the group
 *      file. (The barrel already imports this name — do not rename it.)
 *   2. Build each table with {@link defineTable} so the ColumnDef array is
 *      validated at load and the record is frozen.
 *   3. Declare every embedding column via `embeddingColumn(name)` (PRD-002e) and
 *      list its name in `embeddingColumns` (nullable 768-dim `FLOAT4[]`,
 *      index AC-4).
 *   4. Give every `NOT NULL` column a `DEFAULT` (the load-time guard rejects a
 *      `NOT NULL`-without-`DEFAULT` column, PRD-002c).
 *   5. Pick the `pattern` from {@link WritePattern} per PRD-002d's assignment;
 *      route writes through the matching `writes.ts` primitive (see the mapping
 *      in this file's doc and `CONVENTIONS.md`).
 *   6. Set `scope` per D-2: `"agent"` for engine tables (carry `agent_id` +
 *      `visibility`), `"tenant"` for cross-cutting tables (carry explicit
 *      `org_id` + `workspace_id`), `"none"` for tables that need neither.
 */

import { type ColumnDef, validateColumnDefs } from "../schema.js";

/**
 * The write pattern a table's writers MUST use (PRD-002d). Each value maps to
 * exactly one `writes.ts` primitive, so the registry is the seam that ties a
 * table to its correctness-without-transactions strategy:
 *
 *   - `append-only`      → `appendOnlyInsert` (one row per event; read ordered
 *                          by `creation_date`). sessions, memory_history.
 *   - `version-bumped`   → `appendVersionBumped` (INSERT version N+1 on edit;
 *                          read `ORDER BY version DESC LIMIT 1`). skills, rules,
 *                          entity_attributes.
 *   - `update-or-insert` → `updateOrInsertByKey` (one row per logical key).
 *                          memory (by path), memories (by id), goals, kpis.
 *   - `select-before-insert` → `selectBeforeInsert` (insert iff absent, then
 *                          re-verify so a race is observable). codebase.
 */
export type WritePattern = "append-only" | "version-bumped" | "update-or-insert" | "select-before-insert";

/**
 * The tenancy scope a table relies on (D-2). Drives which scope columns the
 * ColumnDef array MUST carry:
 *
 *   - `agent`  → engine table: carries `agent_id` (default `'default'`) +
 *                `visibility`; org/workspace isolation comes from the storage
 *                partition layer (index AC-3). memories, sessions, memory, skills…
 *   - `tenant` → cross-cutting table: carries explicit `org_id` + `workspace_id`
 *                (index AC-3 / 003d FR-7). codebase, api_keys, telemetry.
 *   - `none`   → an append-only audit/history table scoped transitively by the
 *                row it references (e.g. `memory_history.memory_id`).
 */
export type CatalogScope = "agent" | "tenant" | "none";

/**
 * One durable table in the catalog. The record the create path, the heal pass,
 * the write-pattern registry, and later producers all read.
 */
export interface CatalogTable {
	/** Bare table identifier (validated as a SQL identifier at load). */
	readonly name: string;
	/** The single source of truth for this table's columns (PRD-002c). */
	readonly columns: readonly ColumnDef[];
	/** The write pattern this table's writers MUST use (PRD-002d). */
	readonly pattern: WritePattern;
	/**
	 * Names of the nullable 768-dim `FLOAT4[]` embedding columns on this table
	 * (index AC-4). Empty when the table carries no embedding. Each name MUST
	 * appear in `columns`, declared via `embeddingColumn(name)`.
	 */
	readonly embeddingColumns: readonly string[];
	/** The tenancy scope this table relies on (D-2). */
	readonly scope: CatalogScope;
}

/**
 * Define + validate one catalog table. Runs `validateColumnDefs` at call time
 * (module load), so a malformed ColumnDef array (bad identifier, duplicate, a
 * `NOT NULL` column with no `DEFAULT`) fails the import — never a production
 * write. Asserts each declared embedding column actually exists in `columns` so
 * a typo in `embeddingColumns` is caught at load, not at query time. Returns a
 * frozen record.
 *
 * `label` is the schema label used in the validation error (e.g. `"memories"`).
 */
export function defineTable(table: CatalogTable): CatalogTable {
	validateColumnDefs(table.name, table.columns);
	const present = new Set(table.columns.map((c) => c.name.toLowerCase()));
	for (const emb of table.embeddingColumns) {
		if (!present.has(emb.toLowerCase())) {
			throw new Error(
				`Catalog table "${table.name}": declared embedding column "${emb}" is not in the ColumnDef array`,
			);
		}
	}
	return Object.freeze({
		...table,
		columns: Object.freeze([...table.columns]),
		embeddingColumns: Object.freeze([...table.embeddingColumns]),
	});
}

/** Helper to build a frozen `readonly CatalogTable[]` for a group file. */
export function defineGroup(tables: readonly CatalogTable[]): readonly CatalogTable[] {
	return Object.freeze(tables.map(defineTable));
}
