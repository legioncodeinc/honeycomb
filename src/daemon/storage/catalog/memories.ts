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
	// PRD-049b: the existing free-text `project` (a raw cwd path, kept per D5 — no bulk
	// migration) STAYS for display/back-compat. `project_id` is the RESOLVED registry key
	// (049a) the scope clause segments on — additive, heal-compatible (NOT NULL DEFAULT '').
	// Default '' resolves to the workspace `__unsorted__` inbox at read time (D5).
	{ name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
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
	// PRD-058e (reinforcement + ACT-R activation): the reinforcement-aware reference time
	// `t_ref = max(created_at, last_reinforced_at)` 058a already reads forward-compatibly.
	// Nullable (no DEFAULT needed — NULL is its implicit default, heal-safe): a never-
	// reinforced row reads NULL and `t_ref` falls back to `created_at`. Maintained by the
	// access-log compaction (`access-log.ts`) from the `memory_access` event stream.
	{ name: "last_reinforced_at", sql: "TIMESTAMPTZ" },
	// PRD-058e: the denormalized TOTAL-accesses counter. SINGLE-OWNER (round-3 #1): incremented
	// `+1` per access at APPEND only (`access-log.ts` `recordAccess`/`maintainMemoryCache`), counted
	// EXACTLY ONCE and NEVER re-touched by compaction — pruning the raw `memory_access` log to the last
	// N=32 events discards an optimization detail, not this signal. Read back as the displayed lifetime
	// reinforcement total (`recall.ts` `MemoryRecallHit.accessCount`); the activation MATH reads the
	// RETAINED raw rows, not this counter, so the two are never summed (no double count, no loss).
	// Nullable default 0 (heal-safe ALTER ADD COLUMN backfill).
	{ name: "access_count", sql: "BIGINT DEFAULT 0" },
	// PRD-058c (stale code-reference healing — the `σ(m,t)` term): the staleness verdict for
	// the memory's extracted code references. A LOGICAL enum `fresh` | `stale` | `unknown`
	// stored as TEXT (DeepLake has no native ENUM DDL; the value set is enforced in code by
	// {@link REF_STATUS_VALUES}). Nullable (NULL is its implicit default — heal-safe, no
	// backfill): a never-verified row reads NULL and recall treats it as `unknown` (NEUTRAL,
	// never demoted), exactly as 058a treats a missing timestamp as maximally fresh. Set by the
	// stale-ref diagnostic (`runtime/maintenance/stale-ref-diagnostic.ts`).
	{ name: "ref_status", sql: "TEXT" },
	// PRD-058c: the wall-clock the diagnostic last resolved this memory's references against a
	// snapshot. Drives the verification-freshness factor `v(m,t) = 2^(−(t − verified_at)/h_verify)`
	// and the spaced re-verification cadence (058e paces WHEN; this is the timestamp it reads).
	// Nullable (NULL = never verified → `v` treated as fully decayed → due for a fresh check).
	// The staleness analogue of 058e's `last_reinforced_at`.
	{ name: "verified_at", sql: "TIMESTAMPTZ" },
	// PRD-058c: the specific unresolved references behind a `stale` verdict, stored as a JSON
	// array string (the catalog encodes list-valued columns as TEXT JSON, like `tags`). Capped
	// at {@link MAX_STALE_REFS} entries with an overflow marker so a reference-dense memory does
	// not store an unbounded token list. Nullable (NULL/`'[]'` = nothing unresolved).
	{ name: "stale_refs", sql: "TEXT" },
	// PRD-058e: the access-log COMPACTION WATERMARK — the `at` of the newest raw `memory_access`
	// event already folded into `access_count` (`access-log.ts` `compactAccessLog`). DeepLake has
	// no multi-statement transaction, so compaction folds the count then deletes the raw rows in
	// two steps; this watermark makes that pair IDEMPOTENT across a partial failure: a fold only
	// counts events STRICTLY NEWER than the watermark and advances the watermark in the SAME cache
	// write, so a re-run after a failed delete re-deletes the (already-folded) rows but never
	// re-folds them (no double count), and a failed cache-write simply leaves the watermark
	// unadvanced for a clean retry (no loss). Nullable (NULL = nothing folded yet — every event is
	// newer than an absent watermark, so the first compaction folds normally). Heal-safe ALTER ADD.
	{ name: "access_compacted_at", sql: "TIMESTAMPTZ" },
	// PRD-058e: the COMPANION half of the compaction watermark CURSOR, the `id` of the newest raw
	// `memory_access` event already folded into `access_count`. The watermark is a TOTAL-ORDER cursor
	// `(access_compacted_at, access_compacted_id)`, not `access_compacted_at` alone: when several access
	// events share the same `at`, an `at`-only cursor cannot tell an already-folded row from a not-yet-
	// folded same-`at` sibling, so a later run would treat the sibling as already folded (`at === watermark`,
	// not `>`) and DELETE it without counting it: a silent reinforcement loss. Pairing `at` with the row
	// `id` gives a strict total order so a same-`at` sibling still compares "after" the cursor and is folded.
	// Advanced in the SAME atomic cache write as `access_compacted_at` + `access_count`. Nullable (NULL =
	// nothing folded yet, paired with a NULL `access_compacted_at`). Heal-safe ALTER ADD (additive backfill).
	{ name: "access_compacted_id", sql: "TEXT" },
]);

/**
 * The LOGICAL value set for {@link MEMORIES_COLUMNS}'s `ref_status` column (PRD-058c). The
 * column is TEXT (DeepLake has no ENUM DDL); this frozen set is the in-code constraint a writer
 * stamps and a reader narrows against:
 *   - `fresh`   — every extracted indexed reference resolves; `σ ≈ 0`.
 *   - `stale`   — at least one indexed reference is dangling; `σ > 0`.
 *   - `unknown` — no indexed references, or the graph oracle was unavailable; NEUTRAL (never
 *                 demoted). A NULL row (never verified) reads as `unknown`.
 */
export const REF_STATUS_VALUES = Object.freeze(["fresh", "stale", "unknown"] as const);

/** One of the {@link REF_STATUS_VALUES}. */
export type RefStatus = (typeof REF_STATUS_VALUES)[number];

/**
 * The cap on how many unresolved references `stale_refs` stores for one memory (PRD-058c open
 * question — "cap at a small N, record the overflow as a count"). A memory with more than this
 * many dangling refs stores the first `MAX_STALE_REFS` plus a synthetic overflow marker
 * (`+<n> more`) so the array never grows unbounded on a reference-dense memory.
 */
export const MAX_STALE_REFS = 16 as const;

/** The overflow marker appended to a capped `stale_refs` list (records the dropped count). */
export function staleRefsOverflowMarker(dropped: number): string {
	return `+${dropped} more`;
}

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

/**
 * Build the per-project memory-count aggregate (PRD-059c c-AC-1 / c-AC-2): ONE
 * grouped read over `memories` that returns `(project_id, count, last_capture)`
 * for every project in the active org/workspace partition in a single round-trip,
 * rather than N per-project COUNTs. The caller (`scope-enumeration-api.ts`) passes
 * the active {@link QueryScope}, so the storage client's partition layer scopes the
 * read to the org/workspace — `memories` is an ENGINE table (no `org_id`/
 * `workspace_id` column), isolation comes from the partition header, not a WHERE.
 *
 * Soft-deleted facts (`is_deleted = 1`) are excluded so the count matches what
 * recall would surface. The empty/`''` `project_id` group is the workspace
 * `__unsorted__` inbox (D5: a row with no resolved project falls to the inbox);
 * the caller maps the `''` bucket onto {@link UNSORTED_PROJECT_ID} for c-AC-2's
 * inbox size. `last_capture` is `max(created_at)` (an ISO-8601 TEXT sort, which is
 * lexicographically chronological) — a cheap by-product of the same GROUP BY.
 *
 * All identifiers route through `sqlIdent`; there is NO interpolated VALUE (the
 * only literal is the constant `is_deleted` flag), so `audit:sql` stays clean.
 */
export function buildMemoryCountsByProjectSql(): string {
	const tbl = sqlIdent("memories");
	const pid = sqlIdent("project_id");
	const del = sqlIdent("is_deleted");
	const created = sqlIdent("created_at");
	return (
		`SELECT ${pid}, count(*) AS n, max(${created}) AS last_capture ` +
		`FROM "${tbl}" WHERE ${del} = ${NOT_SOFT_DELETED} GROUP BY ${pid}`
	);
}
