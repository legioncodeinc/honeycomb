/**
 * Schema primitives for the DeepLake storage adapter (PRD-002c).
 *
 * A table is described ONCE as a `readonly ColumnDef[]` — a `{ name, sql }`
 * array. The create path (`buildCreateTableSql`) and the heal path (`heal.ts`,
 * via `buildIntrospectionSql`) both iterate that SAME array, so adding a column
 * is one edit and there is no second mirror that can drift (FR-1).
 *
 * This module owns the SQL builders and the LOAD-TIME validator
 * (`validateColumnDefs`, D-3 / FR-7 / c-AC-5). It deliberately does NOT define
 * any real per-table catalog — that is PRD-003. The adapter supplies the engine;
 * the catalog supplies the arrays. Tests and the `examples/` fixtures provide
 * minimal ColumnDef arrays to exercise the engine.
 *
 * Every identifier emitted here is validated through `sqlIdent` (c-AC-7): a
 * table or column name is never interpolated unvalidated.
 */

import { sqlIdent, sqlStr } from "./sql.js";

/**
 * One column in a table definition. `name` is the bare identifier (e.g.
 * `summary_embedding`); `sql` is the column SQL minus the name (e.g.
 * `TEXT NOT NULL DEFAULT ''` or `FLOAT4[]`). The split lets the create path emit
 * `${name} ${sql}` and the heal path emit `ALTER TABLE … ADD COLUMN ${name}
 * ${sql}` from the identical record.
 */
export interface ColumnDef {
	/** Bare column identifier, validated as a SQL identifier at load. */
	readonly name: string;
	/** Column SQL minus the name, e.g. `TEXT NOT NULL DEFAULT ''`. */
	readonly sql: string;
}

/**
 * Structured rejection raised by the load-time guard. A distinct type so a
 * daemon-load schema defect (a bad ColumnDef) is never mistaken for a runtime
 * query failure. Carries the table label and the offending column.
 */
export class SchemaDefinitionError extends Error {
	readonly label: string;
	readonly column: string;
	constructor(label: string, column: string, reason: string) {
		super(`${label}: column "${column}" ${reason}`);
		this.name = "SchemaDefinitionError";
		this.label = label;
		this.column = column;
	}
}

/** Does this column SQL declare `NOT NULL`? */
function isNotNull(sql: string): boolean {
	return /\bNOT\s+NULL\b/i.test(sql);
}

/** Does this column SQL carry a `DEFAULT`? */
function hasDefault(sql: string): boolean {
	return /\bDEFAULT\b/i.test(sql);
}

/**
 * Load-time guard (D-3 / FR-7 / c-AC-5). Validates a ColumnDef array BEFORE any
 * write and rejects:
 *   - a column name that is not a valid SQL identifier,
 *   - a duplicate column name,
 *   - a `NOT NULL` column with no `DEFAULT`.
 *
 * The last is the load-bearing rule: `ALTER TABLE ADD COLUMN <name> … NOT NULL`
 * on a POPULATED table fails unless a DEFAULT is supplied to backfill existing
 * rows. Catching it at load means the structural defect surfaces before any
 * production write hits it — never inside the per-write heal pass (D-3: the
 * guard lives in the schema validator the heal module invokes at load, not in
 * the hot path). Nullable columns are exempt: NULL is their implicit default and
 * the backfill is trivial.
 *
 * Throws `SchemaDefinitionError` on the first offending column. Returns the
 * array unchanged on success so it composes as `validateColumnDefs("MEMORY",
 * MEMORY_COLUMNS)` at module load.
 */
export function validateColumnDefs(label: string, cols: readonly ColumnDef[]): readonly ColumnDef[] {
	const seen = new Set<string>();
	for (const col of cols) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name)) {
			throw new SchemaDefinitionError(label, col.name, "is not a valid SQL identifier");
		}
		const key = col.name.toLowerCase();
		if (seen.has(key)) {
			throw new SchemaDefinitionError(label, col.name, "is a duplicate");
		}
		seen.add(key);
		if (isNotNull(col.sql) && !hasDefault(col.sql)) {
			throw new SchemaDefinitionError(
				label,
				col.name,
				"is NOT NULL but has no DEFAULT — ALTER TABLE ADD COLUMN on a populated table would fail",
			);
		}
	}
	return cols;
}

/**
 * Render `CREATE TABLE IF NOT EXISTS "<name>" (...) USING deeplake` from a
 * column array (FR-1 / FR-3). `IF NOT EXISTS` is what makes two workers healing
 * the same missing table converge (FR-9 / c-AC-6): the second create is a
 * harmless no-op, not a duplicate-table error. The table name is validated
 * through `sqlIdent` (FR-8 / c-AC-7); column names are validated at load by
 * `validateColumnDefs`, so they are safe to interpolate bare here.
 */
export function buildCreateTableSql(tableName: string, cols: readonly ColumnDef[]): string {
	const safe = sqlIdent(tableName);
	const colSql = cols.map((c) => `${sqlIdent(c.name)} ${c.sql}`).join(", ");
	return `CREATE TABLE IF NOT EXISTS "${safe}" (${colSql}) USING deeplake`;
}

/**
 * Render the single introspection `SELECT` the heal pass issues against
 * `information_schema.columns` (FR-4). Reads the present column set for one
 * table in one workspace so the heal pass can diff it against the ColumnDef
 * array. Both the table and the workspace are VALUES here (they filter rows in
 * the catalog view, they are not interpolated as identifiers), so they route
 * through `sqlStr`, not `sqlIdent`.
 */
export function buildIntrospectionSql(tableName: string, workspace: string): string {
	return (
		"SELECT column_name FROM information_schema.columns " +
		`WHERE table_name = '${sqlStr(tableName)}' ` +
		`AND table_schema = '${sqlStr(workspace)}'`
	);
}

/**
 * Render one `ALTER TABLE "<table>" ADD COLUMN <name> <sql>` (FR-4). NEVER
 * `IF NOT EXISTS`: DeepLake returns HTTP 500 (not 409) on a duplicate add, so
 * `IF NOT EXISTS` does not save you — the add-only-missing DIFF in `heal.ts` is
 * the real guard, and an "already exists" race is caught and re-verified there.
 * The table name is validated through `sqlIdent` (c-AC-7); the column name is
 * load-validated, but we re-validate it here so a hand-built call can never
 * smuggle an unsafe name.
 */
export function buildAddColumnSql(tableName: string, col: ColumnDef): string {
	const safeTable = sqlIdent(tableName);
	const safeCol = sqlIdent(col.name);
	return `ALTER TABLE "${safeTable}" ADD COLUMN ${safeCol} ${col.sql}`;
}
