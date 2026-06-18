/**
 * PRD-013a — Sources & Documents catalog tables (Wave 1, IMPLEMENTED).
 *
 * The three NEW `USING deeplake` tables that back the source-artifact contract:
 * `memory_artifacts` (the per-unit source-artifact rows), `document_memories`
 * (the doc → chunk link rows), and `document_chunk` (the provenanced chunk
 * memories). All are written ONLY by the daemon on port 3850 through the PRD-002d
 * write primitives + the PRD-002c heal engine — never a hand-rolled `ALTER`. The
 * source lifecycle engine (`runtime/sources/lifecycle.ts`) owns the
 * connect/index/update/health/purge transitions; the document worker
 * (`runtime/sources/document-worker.ts`, 013b) runs the per-document chunk/embed/
 * index lifecycle as `memory_jobs`. This module owns ONLY the column-definition
 * arrays the create path and the heal pass both iterate.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE LOAD-BEARING DECISION — append-only soft-delete via STATUS ADVANCE (D-2/D-3)
 * ════════════════════════════════════════════════════════════════════════════
 * A source is READ-ONLY evidence: every derived row carries provenance and stays
 * purgeable, and the source FILES are NEVER modified. Removal of a derived row is
 * therefore NOT a per-row hard `DELETE` (unreliable on this backend — PRD-004 /
 * PRD-006e D-8 proved a DELETE can leave rows; a by-id read can be served from a
 * stale segment) and NOT an in-place `UPDATE` (the UPDATE-coalescing / segment-
 * freshness flap that `memory_jobs` + `graph-persist.ts` + `supersede.ts` all hit
 * and solved). Instead:
 *
 *   `memory_artifacts` + `document_chunk` are `pattern: "version-bumped"`.
 *
 * A soft-delete (a removed/renamed source file, a-AC-4) or a purge-by-`source_id`
 * (a disconnect, a-AC-2) is a STATUS ADVANCE: APPEND a NEW version row carrying the
 * SAME `id`, the prior id's `version` + 1, and `status` advanced to `deleted` /
 * `superseded`, every other column copied forward INTACT. The row's CURRENT state
 * is its HIGHEST-`version` row (resolved exactly like `runtime-jobs.ts` /
 * `supersede.ts`'s `latestById`), so once the highest version reads `deleted` the
 * row falls out of recall while full history stays on disk. This is an INSERT,
 * never an in-place mutate — a-AC-4 LITERALLY requires "status advance, not in-place
 * UPDATE", so the pattern enforces it from the catalog level. `document_memories`
 * is the same shape (its doc→chunk link is soft-deleted by status advance when the
 * document is deleted, 013b b-AC-5).
 *
 * ── Deterministic ids include source_id (D-1) ───────────────────────────────
 * Every artifact / chunk id is a sha256 that INCLUDES the `source_id` (computed in
 * the lifecycle engine), so a purge is a clean SCOPED sweep: every row a source
 * produced is addressable by its `source_id`, and nothing else is. The provenance
 * quartet (`source_id`/`source_kind`/`source_path`/`source_root`) rides on every
 * derived row so a source hit traces back to the original vault / channel / repo
 * (a-AC-3 / FR-1) and a purge can select by `source_id` alone.
 *
 * ── Status lifecycle (D-3 / FR-7/FR-8/FR-12) ────────────────────────────────
 *   active     → the live derived row, recall-eligible (the highest version).
 *   superseded → replaced by a newer version of the same logical row (a rename's
 *                add-half, or a re-index that fingerprinted a change).
 *   deleted    → soft-deleted (the source file was removed, or the source was
 *                purged); falls out of recall, history retained (a-AC-2 / a-AC-4).
 *   failure    → a partial fetch/parse failure marker — a FAILURE ARTIFACT (D-4 /
 *                a-AC-7). Written ALONGSIDE existing rows; never deletes one.
 *
 * Each transition is a NEW appended row at the next `version` for the row's `id`;
 * the row's current status is the status on its highest-`version` row.
 *
 * ── Scope (D-2 / CONVENTIONS §3) ────────────────────────────────────────────
 * `scope: "tenant"`. A source is mounted into a specific org + workspace (FR-1
 * REQUIRES the derived rows be scoped to an org and workspace), and the
 * provenance/purge boundary is the (org, workspace, source_id) tuple — so the rows
 * carry explicit `org_id` + `workspace_id` columns (the cross-cutting-table shape,
 * like `codebase` / `telemetry`), NOT the engine `agent_id`/`visibility` pair. The
 * storage partition still isolates physically; the explicit columns let a purge
 * and a health scan filter to exactly one source's footprint.
 *
 * Every `NOT NULL` column carries a `DEFAULT` so the heal pass's
 * `ALTER TABLE ADD COLUMN … NOT NULL` succeeds on a populated table (PRD-002c).
 * `chunk_embedding` is the nullable 768-dim `FLOAT4[]` (nomic-embed-text-v1.5,
 * index AC-4): NULL by design so recall degrades to lexical when embedding is off
 * or fails (the embed seam is fail-soft — 013b b-AC-2). `metadata` is JSONB BY
 * DESIGN — a genuinely-schemaless per-provider blob (the sanctioned JSONB use per
 * CONVENTIONS §5), nullable so NULL is its implicit default.
 */

import { embeddingColumn } from "../vector.js";
import { type CatalogTable, defineGroup } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Status lifecycle (D-3) — the values the version-bumped status column advances
// through. Frozen + exported so the lifecycle engine, the document worker, and
// the tests read the SAME literals the rows are written with (never a hand-typed
// string).
// ────────────────────────────────────────────────────────────────────────────

/** A live derived row — the recall-eligible highest version. */
export const ARTIFACT_ACTIVE = "active" as const;
/** Replaced by a newer version of the same logical row (a-AC-4 rename add-half). */
export const ARTIFACT_SUPERSEDED = "superseded" as const;
/** Soft-deleted — falls out of recall, history retained (a-AC-2 / a-AC-4). */
export const ARTIFACT_DELETED = "deleted" as const;
/** A partial fetch/parse failure marker — a FAILURE ARTIFACT (D-4 / a-AC-7). */
export const ARTIFACT_FAILURE = "failure" as const;

/** The four legal `status` values, frozen, in lifecycle order (D-3). */
export const ARTIFACT_STATUSES = Object.freeze([
	ARTIFACT_ACTIVE,
	ARTIFACT_SUPERSEDED,
	ARTIFACT_DELETED,
	ARTIFACT_FAILURE,
] as const);

/** A `memory_artifacts` / `document_chunk` `status` value. */
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** The bare table names, exported so producers never re-spell them. */
export const MEMORY_ARTIFACTS_TABLE = "memory_artifacts" as const;
export const DOCUMENT_MEMORIES_TABLE = "document_memories" as const;
export const DOCUMENT_CHUNK_TABLE = "document_chunk" as const;

/**
 * The provenance quartet every source-derived row carries (D-1 / FR-1 / a-AC-3).
 * Exported as ColumnDefs so the additive heal columns added to the graph rows
 * (`knowledge-graph.ts`) are the SAME definitions, single-sourced here. Each is
 * `TEXT NOT NULL DEFAULT ''` so a heal `ADD COLUMN` backfills cleanly on a
 * populated table and a row that predates the column reads `''` (treated as "no
 * source").
 */
export const PROVENANCE_COLUMNS = Object.freeze([
	{ name: "source_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_kind", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_root", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `memory_artifacts` — the per-unit source-artifact rows (FR-3 / a-AC-1). One row
 * per source unit (a vault .md, a Discord message, a GitHub issue, a submitted
 * document). VERSION-BUMPED: a soft-delete / supersede / purge APPENDs a new
 * version with the advanced `status`, never an in-place UPDATE (a-AC-4). The
 * current state of an artifact id is its highest-`version` row.
 *
 * Column order: identity → provenance quartet → scope → classification →
 * lifecycle → content → schemaless metadata → time.
 *
 * - `id`            deterministic sha256 (includes `source_id`); the logical row
 *                   identity the version chain shares.
 * - provenance      `source_id`/`source_kind`/`source_path`/`source_root` (D-1).
 * - `org_id` /
 *   `workspace_id`  explicit tenancy (D-2 `tenant` scope / FR-1).
 * - `kind`          the artifact kind (e.g. `note`, `message`, `issue`, `document`).
 * - `status`        the lifecycle state; defaults `'active'` (D-3).
 * - `content` /
 *   `summary`       the raw evidence text + an optional distilled summary.
 * - `content_hash`  sha256 over the content — the fingerprint a re-scan compares
 *                   to skip an unchanged unit (FR-6) and the shared-embedding key.
 * - `failure_reason` populated only on a FAILURE ARTIFACT (status `failure`, D-4).
 * - `metadata`      JSONB schemaless per-provider blob (nullable).
 * - `version`       BIGINT append-only version for this `id`; defaults to 1.
 */
export const MEMORY_ARTIFACTS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	...PROVENANCE_COLUMNS,
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "kind", sql: "TEXT NOT NULL DEFAULT 'artifact'" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "title", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "summary", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "content_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "failure_reason", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "metadata", sql: "JSONB" },
	{ name: "superseded_by", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `document_memories` — the doc → chunk link rows (D-6 / 013b). One row per
 * (document, chunk) edge: it ties a submitted/indexed document artifact to each
 * chunk memory it produced, so a document delete can soft-delete the document +
 * EVERY linked chunk (013b b-AC-5). VERSION-BUMPED so the link is soft-deleted by
 * a status advance alongside its endpoints (never an in-place UPDATE).
 *
 * - `id`             deterministic sha256 (includes `source_id` + document + chunk).
 * - `document_id`    the owning `memory_artifacts` document row id.
 * - `chunk_id`       the linked `document_chunk` row id.
 * - provenance       carried so the link is purgeable by `source_id` too (a-AC-2).
 * - `ordinal`        the chunk's position in the document (BIGINT, for ordering).
 * - `status`         lifecycle state; soft-deleted with the document (b-AC-5).
 * - `version`        BIGINT append-only version for this `id`.
 */
export const DOCUMENT_MEMORIES_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "document_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "chunk_id", sql: "TEXT NOT NULL DEFAULT ''" },
	...PROVENANCE_COLUMNS,
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "ordinal", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `document_chunk` — the provenanced chunk memories (FR-3 / a-AC-1 / 013b). One
 * row per chunk of a source artifact / document, carrying the chunk text, its
 * provenance, a `content_hash` for shared-embedding dedup (two identical chunks
 * across documents share ONE embedding keyed by the hash — 013b b-AC-4), and the
 * nullable 768-dim `chunk_embedding` tensor (index AC-4; fail-soft — a null
 * embedding stays keyword-searchable, 013b b-AC-2). VERSION-BUMPED so a chunk is
 * soft-deleted / purged by a status advance (a-AC-2 / a-AC-4).
 *
 * - `id`             deterministic sha256 (includes `source_id`); the chunk identity.
 * - `artifact_id`    the owning `memory_artifacts` row id.
 * - provenance       quartet — carries path + heading/line-range detail via
 *                    `source_path` + `metadata` (013c heading-split chunks).
 * - `content`        the chunk text (the keyword-searchable body).
 * - `content_hash`   sha256 over the chunk content — the shared-embedding key (b-AC-4).
 * - `chunk_embedding` nullable 768-dim `FLOAT4[]` (index AC-4); null → lexical.
 * - `status`         lifecycle state; defaults `'active'`.
 * - `metadata`       JSONB schemaless per-chunk detail (heading, line range, …).
 * - `version`        BIGINT append-only version for this `id`.
 */
export const DOCUMENT_CHUNK_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "artifact_id", sql: "TEXT NOT NULL DEFAULT ''" },
	...PROVENANCE_COLUMNS,
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "kind", sql: "TEXT NOT NULL DEFAULT 'chunk'" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "content_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "ordinal", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "metadata", sql: "JSONB" },
	embeddingColumn("chunk_embedding"),
	{ name: "superseded_by", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** The 013a sources group — spread into `CATALOG` by the barrel. */
export const SOURCES_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: MEMORY_ARTIFACTS_TABLE,
		columns: MEMORY_ARTIFACTS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		name: DOCUMENT_MEMORIES_TABLE,
		columns: DOCUMENT_MEMORIES_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		name: DOCUMENT_CHUNK_TABLE,
		columns: DOCUMENT_CHUNK_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: ["chunk_embedding"],
		scope: "tenant",
	},
]);
