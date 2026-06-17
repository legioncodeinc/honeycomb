/**
 * Write-pattern registry (PRD-003 spine — the seam PRD-002d's primitives and
 * later producers consume).
 *
 * Given the aggregated `CATALOG`, this builds a typed `table → WritePattern`
 * (and `table → CatalogTable`) lookup so a producer can ask "what pattern does
 * this table use?" and route to the correct `writes.ts` primitive without
 * hard-coding the mapping at every call site. The registry is DERIVED from the
 * group files' `pattern` field — there is no second hand-maintained mapping that
 * could drift (the same single-source discipline as the ColumnDef arrays).
 *
 * The `PATTERN_PRIMITIVE` map names the one `writes.ts` primitive each pattern
 * binds to, so the documentation of "which function writes this table" lives in
 * code, next to the type, not only in prose.
 */

import { type CatalogTable, type WritePattern } from "./types.js";

/**
 * The `writes.ts` primitive each {@link WritePattern} binds to (PRD-002d). A
 * producer resolves a table's pattern via {@link CatalogRegistry.patternFor},
 * then calls the named primitive. Documented here so the binding is discoverable
 * from the registry alone.
 */
export const PATTERN_PRIMITIVE: Readonly<Record<WritePattern, string>> = Object.freeze({
	"append-only": "appendOnlyInsert",
	"version-bumped": "appendVersionBumped",
	"update-or-insert": "updateOrInsertByKey",
	"select-before-insert": "selectBeforeInsert",
});

/** A built registry over the catalog: name → table, name → pattern. */
export interface CatalogRegistry {
	/** Every table in the catalog, in catalog order. */
	readonly tables: readonly CatalogTable[];
	/** Look up a table record by name; `undefined` if absent. */
	readonly byName: ReadonlyMap<string, CatalogTable>;
	/** Look up the write pattern for a table; `undefined` if absent. */
	patternFor(table: string): WritePattern | undefined;
	/** The primitive name a table's pattern binds to; `undefined` if absent. */
	primitiveFor(table: string): string | undefined;
}

/**
 * Build the registry from the aggregated catalog. Throws on a duplicate table
 * name across groups, because two tables sharing a name is a catalog defect that
 * would silently shadow one in the lookup — caught at module load, not at write
 * time.
 */
export function buildRegistry(tables: readonly CatalogTable[]): CatalogRegistry {
	const byName = new Map<string, CatalogTable>();
	for (const t of tables) {
		if (byName.has(t.name)) {
			throw new Error(`Catalog registry: duplicate table name "${t.name}" across groups`);
		}
		byName.set(t.name, t);
	}
	return {
		tables,
		byName,
		patternFor: (table) => byName.get(table)?.pattern,
		primitiveFor: (table) => {
			const pattern = byName.get(table)?.pattern;
			return pattern === undefined ? undefined : PATTERN_PRIMITIVE[pattern];
		},
	};
}
