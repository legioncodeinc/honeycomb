/**
 * PRD-003a — Memories, Embeddings, and History (Wave 1, IMPLEMENTED).
 *
 * The distilled-memory engine tables: `memories` (the kept facts recall ranks
 * over) and `memory_history` (the append-only audit trail of every proposal).
 * Both are `USING deeplake` tables written exclusively by the daemon, scoped by
 * `agent_id` + `visibility` (D-2: engine tables; org/workspace isolation comes
 * from the storage partition layer, not columns — index AC-3).
 *
 * Pattern assignment (PRD-002d):
 *   - `memories`        → update-or-insert by `id` (the kept-fact identity).
 *                         Most edits land as NEW rows; superseding is handled in
 *                         the graph layer (PRD-003b). (a-AC-6)
 *   - `memory_history`  → append-only INSERT (strictly, never mutated). (a-AC-2)
 *
 * Dedup (a-AC-3): `content_hash` is a SHA-256 over `normalized_content`. The
 * decision stage (PRD-006, OUT of scope) checks it before INSERT; this module
 * supplies the hash helper {@link contentHash} and the catalog-level dedup probe
 * {@link buildDedupCheckSql} so the invariant is demonstrable here.
 *
 * Soft-delete (a-AC-5): `is_deleted` is a BIGINT 0/1; recall excludes
 * `is_deleted = 1` rows and retention purges them later (PRD-006e). Helpers
 * {@link SOFT_DELETED} / {@link NOT_SOFT_DELETED} name the two states so a writer
 * advancing the flag and a reader excluding deleted rows agree on the encoding.
 */

import { createHash } from "node:crypto";
import { embeddingColumn } from "../vector.js";
import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

/** Allowed `memory_history.changed_by` actors (a-AC-2 / FR-5). */
export const MEMORY_HISTORY_ACTORS = Object.freeze(["harness", "pipeline", "pipeline-shadow"] as const);
/** The actor stamped in shadow mode — memories is NOT mutated (a-AC-7). */
export const SHADOW_ACTOR = "pipeline-shadow" as const;

/** `is_deleted` encodings (a-AC-5). BIGINT 0/1 per D-3. */
export const NOT_SOFT_DELETED = 0 as const;
export const SOFT_DELETED = 1 as const;

/**
 * `memories` — distilled facts (FR-1). The column order mirrors the FR exactly:
 * identity → content → dedup → scoring → provenance → scope → embedding → time.
 *
 * Scope (D-2 / index AC-3): `agent_id` (default `'default'`) + `visibility`
 * (default `'global'`); NO `org_id`/`workspace_id` column — engine table.
 * `content_embedding` is the nullable 768-dim `FLOAT4[]` (index AC-4 / a-AC-1).
 */
export const MEMORIES_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "type", sql: "TEXT NOT NULL DEFAULT 'fact'" },
	{ name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
	// PRD-046b (b-AC-2/b-AC-4/b-AC-5): the DURABLE Tier-1 KEY — a ≤1-sentence,
	// keyword-dense headline of the distilled fact so the prime (046c) skims durable
	// keys with a pure SQL select, NO generation at read time. Additive, heal-compatible
	// (NOT NULL DEFAULT ''); a fact with no derived key falls back to its `content` at
	// read time, so an un-keyed legacy row is still primeable.
	{ name: "key", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "normalized_content", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "content_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "confidence", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "importance", sql: "FLOAT4 NOT NULL DEFAULT 0.5" },
	{ name: "tags", sql: "TEXT NOT NULL DEFAULT '[]'" },
	{ name: "who", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_type", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "pinned", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "is_deleted", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "extraction_status", sql: "TEXT NOT NULL DEFAULT 'none'" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	embeddingColumn("content_embedding"),
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `memory_history` — append-only audit trail (FR-5 / a-AC-2). Records every
 * proposal with `changed_by` ∈ {harness, pipeline, pipeline-shadow}, the
 * proposed `operation`, the target `memory_id`, and the TEXTUAL before/after
 * payload (D-5: no embedding diff). Append-only, never mutated. Scope is `none`
 * (D-2): each row is scoped transitively by the `memory_id` it references.
 */
export const MEMORY_HISTORY_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "changed_by", sql: "TEXT NOT NULL DEFAULT 'pipeline'" },
	{ name: "operation", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "before_payload", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "after_payload", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** The 003a group — spread into `CATALOG` by the barrel. */
export const MEMORIES_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: "memories",
		columns: MEMORIES_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: ["content_embedding"],
		scope: "agent",
	},
	{
		name: "memory_history",
		columns: MEMORY_HISTORY_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "none",
	},
]);

/**
 * Compute the dedup key for a memory: a lowercase hex SHA-256 over the
 * `normalized_content` (FR-2 / a-AC-3). Identical normalized content yields an
 * identical hash, so the decision stage (PRD-006) can skip a duplicate INSERT by
 * matching on `content_hash`. Pure and deterministic.
 */
export function contentHash(normalizedContent: string): string {
	return createHash("sha256").update(normalizedContent, "utf8").digest("hex");
}

/**
 * Build the dedup probe (a-AC-3): does a row with this `content_hash` already
 * exist for the scope? The decision stage runs this BEFORE an INSERT and skips
 * the write when it returns a row. The hash value routes through `sLiteral` and
 * the table/column through `sqlIdent` (SQL-safety floor, PRD-002b) — no value is
 * hand-quoted. Returns IDs only; PRD-006 owns the actual skip decision.
 */
export function buildDedupCheckSql(hash: string): string {
	const tbl = sqlIdent("memories");
	const col = sqlIdent("content_hash");
	const id = sqlIdent("id");
	return `SELECT ${id} FROM "${tbl}" WHERE ${col} = ${sLiteral(hash)} LIMIT 1`;
}
