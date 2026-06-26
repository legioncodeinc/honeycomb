/**
 * PRD-058e, Memory-lifecycle reinforcement + calibration tables.
 *
 * The two NEW durable tables the reinforcement / ACT-R activation / confidence
 * calibration loop appends to, plus the two ADDITIVE columns it heals onto
 * `memories` (declared in `memories.ts`, named here only for the role boundary):
 *
 *   - `memory_access`      → APPEND-ONLY access-event log. One row per memory
 *                            create / recall / reinforce / downweight event,
 *                            carrying the usefulness weight `u_k ∈ [0,1]` and the
 *                            event time `at`. This is the access history `t_1 …
 *                            t_n` the ACT-R base-level activation `B(m,t)` sums
 *                            over (`activation.ts`). Never mutated; the retention
 *                            worker compacts old raw events into the denormalized
 *                            `memories.access_count` + `memories.last_reinforced_at`
 *                            so the log does not grow without bound (PRD-058e
 *                            Risks / open question N=32).
 *   - `memory_calibration` → APPEND-ONLY curve snapshots. One row per isotonic
 *                            refit, carrying the serialized model blob + its
 *                            held-out `ece` / `brier` / `n_samples`, versioned by
 *                            `fit_at`. The live curve is the highest-`fit_at` row
 *                            (`calibration.ts`). Never mutated; a new fit appends a
 *                            fresh snapshot so the curve history stays auditable.
 *
 * ── Scope (D-2: engine tables) ───────────────────────────────────────────────
 * Both are `agent`-scoped engine tables: they carry `agent_id` + `visibility`,
 * exactly like `memories` / `memory_history` (`memories.ts`) and the rest of the
 * engine catalog. The PRD-058e data-model sketch lists `org`/`workspace`/`agent_id`
 * as the access-event scope, but in this codebase org/workspace isolation is the
 * STORAGE PARTITION boundary ({@link import("../client.js").QueryScope}), NOT a
 * column on an engine table (catalog/types.ts D-2, index AC-3). So the partition
 * supplies org/workspace and the row carries `agent_id` + `visibility`, the same
 * resolution every other engine table already uses. A row is reachable
 * transitively by its `memory_id`.
 *
 * ── Append-only, never destructive (PRD-058e Technical Considerations) ────────
 * `memory_access` is `append-only` and `memory_calibration` is `append-only`:
 * reinforcement and refit are EVENTS, so each is a fresh immutable row (the
 * version-bump-consistent discipline, never an in-place edit DeepLake can
 * coalesce). The `memories` denormalized cache (`access_count` /
 * `last_reinforced_at`) is maintained through the existing `update-or-insert`
 * pattern `memories` already uses; only the RAW event log here is append-only.
 *
 * ── ADDITIVE lazy-heal, NO migration, NO backfill ────────────────────────────
 * Both tables are NEW, so the heal pass CREATEs them on first write; the two new
 * `memories` columns are `NOT NULL DEFAULT` / nullable so the
 * `ALTER TABLE ADD COLUMN` heal backfills existing rows cleanly (PRD-002c). No
 * migration, no backfill: a pre-058e memory simply reads `access_count = 0` /
 * `last_reinforced_at = ''` until its first reinforcement.
 */

import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

/**
 * The access-event KINDS recorded in `memory_access.kind` (PRD-058e data model).
 * A closed taxonomy so a writer and the activation/grader readers agree on the
 * encoding, mirrors the `MEMORY_HISTORY_ACTORS` discipline in `memories.ts`.
 *
 *   - `create`     → the memory was created; the seed access `(t_1, u_1 = 1)`.
 *   - `recall`     → the memory was recalled + injected into context (graded
 *                    usefulness arrives later as a reinforce/downweight).
 *   - `reinforce`  → a recall confirmed useful (`u ≈ 1`); strengthens activation.
 *   - `downweight` → a recall ignored or contradicted (`u → 0`); does not inflate
 *                    activation (AC-55e.1.3).
 */
export const MEMORY_ACCESS_KINDS = Object.freeze(["create", "recall", "reinforce", "downweight"] as const);
/** One `memory_access.kind` token. */
export type MemoryAccessKind = (typeof MEMORY_ACCESS_KINDS)[number];

/** Is `value` a recognized {@link MemoryAccessKind}? (defense-in-depth gate, mirrors `isValidRecallMode`). */
export function isMemoryAccessKind(value: string): value is MemoryAccessKind {
	return (MEMORY_ACCESS_KINDS as readonly string[]).includes(value);
}

/**
 * `memory_access`, append-only access-event log (PRD-058e). One row per access
 * event. The activation function sums `u_k · (t − t_k)^(−d)` over these rows.
 *
 *   - `id`             the event identity (a UUID the writer mints).
 *   - `memory_id`      the memory this access belongs to (the join key).
 *   - `at`             the event time `t_k` (ISO-8601 TEXT, like every other
 *                      `created_at`/`creation_date` stamp in the catalog, stored
 *                      as TEXT so the existing timestamp-parse helpers read it).
 *   - `usefulness`     `u_k ∈ [0,1]` (FLOAT4), default `1.0` (a create / an
 *                      un-graded recall is fully useful until graded down).
 *   - `kind`           the {@link MemoryAccessKind} (TEXT, default `'recall'`).
 *   - `agent_id` / `visibility`  the engine scope (D-2).
 *
 * Every `NOT NULL` column carries a `DEFAULT` so the heal `ALTER ADD COLUMN`
 * backfills cleanly (PRD-002c load-time guard).
 */
export const MEMORY_ACCESS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "usefulness", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "kind", sql: "TEXT NOT NULL DEFAULT 'recall'" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
]);

/**
 * `memory_calibration`, append-only calibration-curve snapshots (PRD-058e).
 * One row per isotonic refit; the live curve is the highest-`fit_at` row.
 *
 *   - `id`          the snapshot identity (a UUID the writer mints).
 *   - `fit_at`      the refit time (ISO-8601 TEXT), the snapshot version key,
 *                   the reader takes `ORDER BY fit_at DESC LIMIT 1`.
 *   - `model_blob`  the serialized isotonic model (a small JSON-encoded
 *                   step-function, TEXT). Cold-start / insufficient-data writes
 *                   the identity model so `C = f`.
 *   - `ece`         the held-out Expected Calibration Error of THIS curve.
 *   - `brier`       the held-out Brier score of this curve.
 *   - `n_samples`   how many resolved `(f, y)` pairs the fit consumed.
 *   - `agent_id` / `visibility`  the engine scope (D-2).
 *
 * Every `NOT NULL` column carries a `DEFAULT` (heal-safe). The blob is TEXT (a
 * serialized model), never JSONB, so the existing TEXT read path hydrates it.
 */
export const MEMORY_CALIBRATION_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "fit_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "model_blob", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "ece", sql: "FLOAT4 NOT NULL DEFAULT 0.0" },
	{ name: "brier", sql: "FLOAT4 NOT NULL DEFAULT 0.0" },
	{ name: "n_samples", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
]);

/** The bare table identifiers, exported so the runtime modules name them without re-stating a literal. */
export const MEMORY_ACCESS_TABLE = "memory_access" as const;
/** The calibration-snapshot table identifier. */
export const MEMORY_CALIBRATION_TABLE = "memory_calibration" as const;

/** The 058e group, spread into `CATALOG` by the barrel. */
export const MEMORY_LIFECYCLE_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: MEMORY_ACCESS_TABLE,
		columns: MEMORY_ACCESS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: MEMORY_CALIBRATION_TABLE,
		columns: MEMORY_CALIBRATION_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "agent",
	},
]);

/**
 * Build the append-ordered read of a memory's access events (PRD-058e): every
 * `(at, usefulness, kind)` row for `memoryId`, oldest-first. This is the access
 * history the ACT-R activation sums over. The `memory_id` routes through
 * `sLiteral` and every identifier through `sqlIdent` (SQL-safety floor). Ordered
 * by `at ASC` so the activation reads `t_1 < … < t_n` in series order.
 */
export function buildAccessHistorySql(memoryId: string): string {
	const tbl = sqlIdent(MEMORY_ACCESS_TABLE);
	const memoryIdCol = sqlIdent("memory_id");
	const atCol = sqlIdent("at");
	const usefulnessCol = sqlIdent("usefulness");
	const kindCol = sqlIdent("kind");
	return (
		`SELECT ${atCol} AS at, ${usefulnessCol} AS usefulness, ${kindCol} AS kind ` +
		`FROM "${tbl}" ` +
		`WHERE ${memoryIdCol} = ${sLiteral(memoryId)} ` +
		`ORDER BY ${atCol} ASC`
	);
}

/**
 * Build the "current calibration curve" read (PRD-058e): the highest-`fit_at`
 * snapshot. Mirrors the version-bumped `buildHighestActiveVersionSql` reader
 * convention, even though older snapshots remain, the latest `fit_at` is the
 * live curve. No value to interpolate; every identifier through `sqlIdent`.
 */
export function buildLatestCalibrationSql(): string {
	const tbl = sqlIdent(MEMORY_CALIBRATION_TABLE);
	const fitAtCol = sqlIdent("fit_at");
	const modelBlobCol = sqlIdent("model_blob");
	const eceCol = sqlIdent("ece");
	const brierCol = sqlIdent("brier");
	const nSamplesCol = sqlIdent("n_samples");
	return (
		`SELECT ${fitAtCol} AS fit_at, ${modelBlobCol} AS model_blob, ${eceCol} AS ece, ` +
		`${brierCol} AS brier, ${nSamplesCol} AS n_samples ` +
		`FROM "${tbl}" ` +
		`ORDER BY ${fitAtCol} DESC LIMIT 1`
	);
}
