/**
 * The memory READ adapters — PRD-022a (FR-4): `memory_get` + `memory_list`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WIRING ONLY (ledger D-1). Reads the EXISTING `memories` engine table through
 * the injected {@link StorageQuery} with guarded SQL. No new schema, no new
 * ranking. `memory_get` reads one memory by id (highest version, not soft-deleted);
 * `memory_list` lists the scoped tenant's memories (newest first, bounded).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Version-bumped reads ─────────────────────────────────────────────────────
 * The controlled-writes engine lands `memories` rows as append-only version bumps
 * (a `version` column heals onto the table on the first bump). The current row for
 * an id is therefore the HIGHEST version. `memory_get` resolves the latest version
 * for the id and drops it when that latest version is a tombstone (`is_deleted = 1`).
 *
 * ── Tenancy + SQL safety ─────────────────────────────────────────────────────
 * Every read runs under the per-request {@link QueryScope} (the org/workspace
 * storage partition). Every identifier routes through `sqlIdent`, every value
 * through `sLiteral` — no value is hand-quoted (`audit:sql` scans `src/daemon`).
 */

import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";

/** The default page size for `memory_list` (CLI-facing). */
export const DEFAULT_LIST_LIMIT = 50;
/** The hard ceiling on a `memory_list` page. */
export const MAX_LIST_LIMIT = 500;

/**
 * A read-model of a single memory row the get/list handlers serialize.
 *
 * ── PRD-040 OQ-1: the additive detail-metadata widen ─────────────────────────
 * The original shape (`id`/`type`/`content`/`confidence`/`agentId`/`createdAt`/
 * `updatedAt`) is unchanged. PRD-040a's detail view needs the row's SCOPE
 * (`visibility`), PROVENANCE (`sourceType`/`sourceId`), `version`, and whether the
 * row is semantically indexed (`hasEmbedding`, derived from `content_embedding IS
 * NOT NULL`). Those five fields are ADDED here, OPTIONAL by design so an older/thin
 * client (or a daemon serving the pre-widen shape) still parses — the dashboard
 * wire schema `.catch()`-defaults each. No secret rides this shape: every field is a
 * scope tag, a provenance string, a version number, or a boolean.
 */
export interface MemoryRecord {
	/** The `memories.id`. */
	readonly id: string;
	/** The memory `type` (e.g. `fact`). */
	readonly type: string;
	/** The memory content. */
	readonly content: string;
	/** The confidence score (0..1). */
	readonly confidence: number;
	/** The agent the memory is scoped to. */
	readonly agentId: string;
	/** The ISO creation timestamp. */
	readonly createdAt: string;
	/** The ISO last-update timestamp. */
	readonly updatedAt: string;
	/** PRD-040 OQ-1: the memory's scope visibility (`global`/`org`/…). Optional (additive). */
	readonly visibility?: string;
	/** PRD-040 OQ-1: the provenance `source_type` (e.g. `session`). Optional (additive). */
	readonly sourceType?: string;
	/** PRD-040 OQ-1: the provenance `source_id`. Optional (additive). */
	readonly sourceId?: string;
	/** PRD-040 OQ-1: the row's version on the append-only version-bumped table. Optional (additive). */
	readonly version?: number;
	/** PRD-040 OQ-1: whether the row is semantically indexed (`content_embedding IS NOT NULL`). Optional. */
	readonly hasEmbedding?: boolean;
}

/** Construction deps for the read adapters. */
export interface MemoryReadDeps {
	/** The DeepLake storage client (daemon-only). Reads ONLY through this. */
	readonly storage: StorageQuery;
}

/** Clamp a caller-supplied list limit into `[1, MAX_LIST_LIMIT]`, defaulting a missing/bad value. */
export function resolveListLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
	const truncated = Math.trunc(limit);
	if (truncated < 1) return DEFAULT_LIST_LIMIT;
	return Math.min(truncated, MAX_LIST_LIMIT);
}

/** Number coercion that never returns NaN for a score column. */
function toNum(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/** String coercion that never returns undefined for a text column. */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/**
 * The select column list shared by get + list. PRD-040 OQ-1 widens it additively with the
 * detail-metadata columns (`visibility`/`source_type`/`source_id`/`version`) and a DERIVED
 * `has_embedding` boolean — `content_embedding IS NOT NULL`, computed server-side so the heavy
 * 768-dim FLOAT4[] vector is NEVER pulled over the wire (only its presence bit). Every column +
 * the derived alias route through `sqlIdent` (no hand-quoted identifier — `audit:sql` clean).
 */
const SELECT_COLS = [
	sqlIdent("id"),
	sqlIdent("type"),
	sqlIdent("content"),
	sqlIdent("confidence"),
	sqlIdent("agent_id"),
	sqlIdent("is_deleted"),
	sqlIdent("created_at"),
	sqlIdent("updated_at"),
	// PRD-040 OQ-1 additive metadata.
	sqlIdent("visibility"),
	sqlIdent("source_type"),
	sqlIdent("source_id"),
	sqlIdent("version"),
	// Derived embedding-presence bit — never selects the vector itself, only `IS NOT NULL`.
	`(${sqlIdent("content_embedding")} IS NOT NULL) AS ${sqlIdent("has_embedding")}`,
].join(", ");

/** Boolean coercion tolerant of the DB's 0/1, "t"/"f", and native boolean encodings. */
function toBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const s = String(value ?? "").toLowerCase();
	return s === "true" || s === "t" || s === "1";
}

/** Map a `memories` row into the read-model (PRD-040 OQ-1: with the additive metadata fields). */
function shapeRecord(row: StorageRow): MemoryRecord {
	return {
		id: toStr(row.id),
		type: toStr(row.type),
		content: toStr(row.content),
		confidence: toNum(row.confidence),
		agentId: toStr(row.agent_id),
		createdAt: toStr(row.created_at),
		updatedAt: toStr(row.updated_at),
		// PRD-040 OQ-1 additive metadata for the detail view (scope/provenance/version/embedding).
		visibility: toStr(row.visibility),
		sourceType: toStr(row.source_type),
		sourceId: toStr(row.source_id),
		version: toNum(row.version),
		hasEmbedding: toBool(row.has_embedding),
	};
}

/**
 * Build the `memory_get` SQL: the HIGHEST-version row for the id (the current row
 * on the append-only version-bumped table). `is_deleted` is selected so the
 * caller drops a tombstone. The `version` ordering is tolerant — a table that has
 * not yet healed the `version` column (no bump has happened) still reads the row.
 */
export function buildGetSql(id: string): string {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	return (
		`SELECT ${SELECT_COLS} FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(id)} ` +
		`ORDER BY ${sqlIdent("version")} DESC LIMIT 1`
	);
}

/**
 * Build the `memory_list` SQL: the scoped tenant's non-deleted memories, newest
 * first, bounded by the page limit. The org/workspace partition rides the
 * `storage.query` scope; `is_deleted = 0` excludes tombstones.
 */
export function buildListSql(limit: number): string {
	const tbl = sqlIdent("memories");
	// `limit` is a clamped integer (resolveListLimit) → a bare numeric interpolation,
	// the same shape the rest of the data layer uses for a dynamic LIMIT (audit-safe).
	const safeLimit = Math.max(1, Math.trunc(limit));
	return (
		`SELECT ${SELECT_COLS} FROM "${tbl}" ` +
		`WHERE ${sqlIdent("is_deleted")} = 0 ` +
		`ORDER BY ${sqlIdent("created_at")} DESC LIMIT ${safeLimit}`
	);
}

/**
 * Read a single memory by id (FR-4), scoped to `scope`. Returns the record, or
 * `null` when the id is unknown OR its latest version is a tombstone
 * (`is_deleted = 1`) — a forgotten memory reads as gone. Never throws: a storage
 * error reads as `null` (the handler answers 404, not 500).
 */
export async function getMemory(id: string, scope: QueryScope, deps: MemoryReadDeps): Promise<MemoryRecord | null> {
	if (id.trim() === "") return null;
	const result = await deps.storage.query(buildGetSql(id), scope);
	if (!isOk(result) || result.rows.length === 0) return null;
	const row = result.rows[0];
	if (row === undefined) return null;
	// Drop a tombstone: the latest version is a soft-delete.
	if (toNum(row.is_deleted) === 1) return null;
	return shapeRecord(row);
}

/**
 * List the scoped tenant's memories (FR-4), newest first, bounded. Returns `[]`
 * on a storage error (the handler answers 200 with an empty list, not 500). The
 * version-bump model can surface multiple versions of the same id in the raw
 * scan, so the list de-dups by id, keeping the first (newest by `created_at`) seen.
 */
export async function listMemories(limit: number, scope: QueryScope, deps: MemoryReadDeps): Promise<MemoryRecord[]> {
	const result = await deps.storage.query(buildListSql(limit), scope);
	if (!isOk(result)) return [];
	const seen = new Set<string>();
	const records: MemoryRecord[] = [];
	for (const row of result.rows) {
		const record = shapeRecord(row);
		if (record.id === "" || seen.has(record.id)) continue;
		seen.add(record.id);
		records.push(record);
		if (records.length >= limit) break;
	}
	return records;
}
