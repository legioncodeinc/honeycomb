/**
 * The Honeycomb DeepLake table catalog (PRD-003) — daemon-only barrel.
 *
 * This is the single aggregation point: it imports every group's
 * `readonly CatalogTable[]` and spreads them into ONE `CATALOG`. Each group's
 * tables were already validated at their own module load (via `defineGroup` →
 * `defineTable` → `validateColumnDefs`), so importing this barrel is enough to
 * prove every ColumnDef array in the whole catalog is well-formed.
 *
 * It then builds the write-pattern `REGISTRY` (table → pattern → primitive) and
 * exposes a `healTargetFor(table)` so a producer gets the `{ table, columns }`
 * `HealTarget` the PRD-002 write primitives + heal engine consume — without
 * re-stating the columns.
 *
 * ── WAVE 2 CONTRACT — DO NOT TOUCH THIS FILE OR `registry.ts` ──
 * The five group arrays are already imported and spread below. A Wave-2 Bee
 * fills its group file (`knowledge-graph.ts` / `product.ts` / `tenancy.ts`) and
 * its OWN test file; a filled stub flows into `CATALOG` and `REGISTRY`
 * automatically. There is no edit to make here. See `catalog/CONVENTIONS.md`.
 */

import { type HealTarget } from "../heal.js";
// ── The five group arrays. Wave 1 implemented a + c; b/d/e are wired stubs. ──
import { KNOWLEDGE_GRAPH_TABLES } from "./knowledge-graph.js"; // PRD-003b (stub)
import { MEMORIES_TABLES } from "./memories.js"; // PRD-003a (implemented)
import { PRODUCT_TABLES } from "./product.js"; // PRD-003d (stub)
import { buildRegistry, type CatalogRegistry } from "./registry.js";
import { RUNTIME_JOBS_TABLES } from "./runtime-jobs.js"; // PRD-004b (durable job queue)
import { SESSIONS_SUMMARIES_TABLES } from "./sessions-summaries.js"; // PRD-003c (implemented)
import { TENANCY_TABLES } from "./tenancy.js"; // PRD-003e (stub)
import { type CatalogTable } from "./types.js";

/**
 * The full table catalog: every group's tables spread into one frozen array.
 * Adding a group means importing its array and adding it to this spread — the
 * group files own their columns; this barrel owns only the aggregation.
 */
export const CATALOG: readonly CatalogTable[] = Object.freeze([
	...MEMORIES_TABLES,
	...SESSIONS_SUMMARIES_TABLES,
	...KNOWLEDGE_GRAPH_TABLES,
	...PRODUCT_TABLES,
	...TENANCY_TABLES,
	...RUNTIME_JOBS_TABLES,
]);

/** The write-pattern registry over the whole catalog (table → pattern → primitive). */
export const REGISTRY: CatalogRegistry = buildRegistry(CATALOG);

/** Look up a table's full catalog record by name; `undefined` if absent. */
export function catalogTable(name: string): CatalogTable | undefined {
	return REGISTRY.byName.get(name);
}

/**
 * The `{ table, columns }` `HealTarget` for a catalog table — the shape the
 * PRD-002 write primitives and heal engine take. Throws on an unknown table so a
 * typo surfaces immediately rather than producing a half-built target.
 */
export function healTargetFor(name: string): HealTarget {
	const t = REGISTRY.byName.get(name);
	if (t === undefined) {
		throw new Error(`Catalog: no table named "${name}"`);
	}
	return { table: t.name, columns: t.columns };
}

// ── Re-exports so a consumer imports the catalog from one place. ──
export { type CatalogRegistry, PATTERN_PRIMITIVE } from "./registry.js";
export { type CatalogScope, type CatalogTable, type WritePattern } from "./types.js";
export {
	buildDedupCheckSql,
	contentHash,
	MEMORIES_COLUMNS,
	MEMORIES_TABLES,
	MEMORY_HISTORY_ACTORS,
	MEMORY_HISTORY_COLUMNS,
	NOT_SOFT_DELETED,
	SHADOW_ACTOR,
	SOFT_DELETED,
} from "./memories.js";
export {
	buildTranscriptLookupSql,
	isTranscriptPath,
	MEMORY_COLUMNS,
	MEMORY_TABLE_ROLES,
	SESSIONS_COLUMNS,
	SESSIONS_SUMMARIES_TABLES,
	TRANSCRIPT_PATH_PREFIX,
	transcriptPath,
} from "./sessions-summaries.js";
export { KNOWLEDGE_GRAPH_TABLES } from "./knowledge-graph.js";
export { PRODUCT_TABLES } from "./product.js";
export {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_BACKOFF_CAP_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_MAX_ATTEMPTS,
	JOB_DEAD,
	JOB_DONE,
	JOB_FAILED,
	JOB_LEASED,
	JOB_QUEUED,
	JOB_STATUSES,
	type JobStatus,
	MEMORY_JOBS_COLUMNS,
	MEMORY_JOBS_TABLE,
	RUNTIME_JOBS_TABLES,
} from "./runtime-jobs.js";
export { TENANCY_TABLES } from "./tenancy.js";
