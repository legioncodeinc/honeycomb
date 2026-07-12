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
import { POLLINATING_STATE_TABLES } from "./pollinating-state.js"; // PRD-009a (pollinating token-budget counter)
// ── The five group arrays. Wave 1 implemented a + c; b/d/e are wired stubs. ──
import { KNOWLEDGE_GRAPH_TABLES } from "./knowledge-graph.js"; // PRD-003b (stub)
import { MEMORIES_TABLES } from "./memories.js"; // PRD-003a (implemented)
import { MEMORY_CONFLICTS_TABLES } from "./memory-conflicts.js"; // PRD-058b (semantic-conflict projection)
import { MEMORY_INJECTIONS_TABLES } from "./memory-injections.js"; // ISS-010 (injected-token telemetry)
import { MEMORY_LIFECYCLE_TABLES } from "./memory-lifecycle.js"; // PRD-058e (access log + calibration)
import { PRODUCT_TABLES } from "./product.js"; // PRD-003d (stub)
import { PROJECTS_TABLES } from "./projects.js"; // PRD-049a (project registry)
import { buildRegistry, type CatalogRegistry } from "./registry.js";
import { ROUTING_HISTORY_TABLES } from "./routing-history.js"; // PRD-010 (routing-decision telemetry)
import { RUNTIME_JOBS_TABLES } from "./runtime-jobs.js"; // PRD-004b (durable job queue)
import { SESSIONS_SUMMARIES_TABLES } from "./sessions-summaries.js"; // PRD-003c (implemented)
import { SOURCES_TABLES } from "./sources.js"; // PRD-013a (source-artifact + document tables)
import { SYNCED_ASSETS_TABLES } from "./synced-assets.js"; // PRD-033a (asset-sync substrate)
import { TENANCY_TABLES } from "./tenancy.js"; // PRD-003e (stub)
import { type CatalogTable } from "./types.js";

/**
 * The full table catalog: every group's tables spread into one frozen array.
 * Adding a group means importing its array and adding it to this spread — the
 * group files own their columns; this barrel owns only the aggregation.
 */
export const CATALOG: readonly CatalogTable[] = Object.freeze([
	...MEMORIES_TABLES,
	...MEMORY_CONFLICTS_TABLES,
	...MEMORY_LIFECYCLE_TABLES,
	...MEMORY_INJECTIONS_TABLES,
	...SESSIONS_SUMMARIES_TABLES,
	...KNOWLEDGE_GRAPH_TABLES,
	...PRODUCT_TABLES,
	...TENANCY_TABLES,
	...RUNTIME_JOBS_TABLES,
	...POLLINATING_STATE_TABLES,
	...ROUTING_HISTORY_TABLES,
	...SOURCES_TABLES,
	...SYNCED_ASSETS_TABLES,
	...PROJECTS_TABLES,
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
	buildDedupCheckManySql,
	buildDedupCheckSql,
	buildMemoryCountsByProjectSql,
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
	buildSessionCountsByProjectSql,
	buildTranscriptLookupSql,
	isTranscriptPath,
	MEMORY_COLUMNS,
	MEMORY_TABLE_ROLES,
	SESSIONS_COLUMNS,
	SESSIONS_SUMMARIES_TABLES,
	TRANSCRIPT_PATH_PREFIX,
	transcriptPath,
} from "./sessions-summaries.js";
export {
	buildAccessHistorySql,
	buildLatestCalibrationSql,
	isMemoryAccessKind,
	MEMORY_ACCESS_COLUMNS,
	MEMORY_ACCESS_KINDS,
	MEMORY_ACCESS_TABLE,
	type MemoryAccessKind,
	MEMORY_CALIBRATION_COLUMNS,
	MEMORY_CALIBRATION_TABLE,
	MEMORY_LIFECYCLE_TABLES,
} from "./memory-lifecycle.js";
export {
	buildInjectionRangeSql,
	buildInjectionTokenSumSql,
	INJECTION_SOURCES,
	type InjectionSource,
	isInjectionSource,
	MEMORY_INJECTIONS_COLUMNS,
	MEMORY_INJECTIONS_TABLE,
	MEMORY_INJECTIONS_TABLES,
} from "./memory-injections.js";
export {
	buildConflictByIdSql,
	buildOpenConflictProjectionSql,
	CONFLICT_SIGNALS,
	CONFLICT_STATUSES,
	CONFLICT_VERDICTS,
	type ConflictSignal,
	type ConflictStatus,
	type ConflictVerdict,
	DEFAULT_CONFLICT_STATUS,
	DEFAULT_CONFLICT_VERDICT,
	isConflictSignal,
	isConflictStatus,
	isConflictVerdict,
	MEMORY_CONFLICTS_COLUMNS,
	MEMORY_CONFLICTS_TABLE,
	MEMORY_CONFLICTS_TABLES,
	normalizeConflictPair,
} from "./memory-conflicts.js";
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
export {
	ROI_COST_BASES,
	ROI_METRICS_COLUMNS,
	type RoiCostBasis,
	TEAM_ACTIVE,
	TEAM_INACTIVE,
	TEAM_MEMBER_TYPES,
	TEAMS_COLUMNS,
	type TeamMemberType,
	TENANCY_TABLES,
} from "./tenancy.js";
export { POLLINATING_STATE_COLUMNS, POLLINATING_STATE_TABLE, POLLINATING_STATE_TABLES } from "./pollinating-state.js";
export { ROUTING_HISTORY_COLUMNS, ROUTING_HISTORY_TABLE, ROUTING_HISTORY_TABLES } from "./routing-history.js";
export {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	ARTIFACT_FAILURE,
	ARTIFACT_STATUSES,
	ARTIFACT_SUPERSEDED,
	type ArtifactStatus,
	DOCUMENT_CHUNK_COLUMNS,
	DOCUMENT_CHUNK_TABLE,
	DOCUMENT_MEMORIES_COLUMNS,
	DOCUMENT_MEMORIES_TABLE,
	MEMORY_ARTIFACTS_COLUMNS,
	MEMORY_ARTIFACTS_TABLE,
	PROVENANCE_COLUMNS,
	SOURCES_TABLES,
} from "./sources.js";
export {
	buildCurrentAssetVersionSql,
	SYNCED_ASSET_TYPES,
	SYNCED_ASSETS_COLUMNS,
	SYNCED_ASSETS_TABLE,
	SYNCED_ASSETS_TABLES,
	type SyncedAssetType,
	TOMBSTONE_FALSE,
	TOMBSTONE_TRUE,
} from "./synced-assets.js";
export {
	assertNotReservedProjectId,
	buildEnsureUnsortedSelectSql,
	buildListProjectsSql,
	buildProjectByIdSql,
	isReservedProjectId,
	PROJECT_NOT_RESERVED,
	PROJECT_RESERVED,
	PROJECTS_COLUMNS,
	PROJECTS_TABLE,
	PROJECTS_TABLES,
	type ProjectRow,
	RESERVED_PROJECT_IDS,
	ReservedProjectIdError,
	UNSORTED_PROJECT_ID,
	UNSORTED_PROJECT_NAME,
} from "./projects.js";
