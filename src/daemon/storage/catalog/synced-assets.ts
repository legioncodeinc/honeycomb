/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-033a — Synced-Assets Table (Wave 1 foundation, IMPLEMENTED)         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `synced_assets` — the additive DeepLake table that backs the asset-sync
 * substrate (FR-8 / a-AC-6). One versioned row per published artifact version:
 * the verbatim NATIVE blob (keyed `(asset_type, harness)`), a RESERVED
 * `canonical` blob (empty in v1 beyond the identity adapter, D-7), the
 * `content_hash` for change detection, a monotonic `version`, a `tombstone`
 * flag (a row, never a DELETE — D-5), the tier/style state, and the
 * org/workspace/author tenancy + `device_set` (for `Device`-tier audiences).
 *
 * Write-pattern assignment (PRD-002d / D-5):
 *   - `synced_assets` → version-bumped (appendVersionBumped). Every publish
 *     INSERTs version N+1 for the logical `honeycomb_id`; current state is
 *     `ORDER BY version DESC LIMIT 1`. A demotion writes a fresh version with
 *     `tombstone='true'` — the prior versions survive in the append-only log.
 *     NEVER a true UPDATE (DeepLake coalesces UPDATEs against freshly written
 *     rows and silently drops one).
 *
 * Lazy-create + heal (FR-8 / D-6): there is NO DDL pre-step. The first
 * `appendVersionBumped` against `healTargetFor("synced_assets")` fails with a
 * missing-table error, `withHeal` issues the `buildCreateTableSql` CREATE from
 * THIS ColumnDef array, and the write retries — exactly like every other
 * catalog table.
 *
 * Scope (D-2): `"tenant"` — the substrate is a cross-cutting team-sharing table
 * that carries EXPLICIT `org` / `workspace` / `author` columns (the `Team`
 * boundary is workspace; the `Device` boundary is author + `device_set`),
 * rather than relying on the agent-level storage partition.
 *
 * SQL-safety: this module defines columns only; every write/read goes through
 * the PRD-002b guards (`sqlIdent` / `sLiteral` / `eLiteral`) in `writes.ts`.
 * `npm run audit:sql` enforces that no fragment here hand-interpolates a value
 * (the helpers below build statements through `sqlIdent` + `sLiteral`).
 *
 * ── Trusted-table list (the pull consults it) ───────────────────────────────
 * The daemon's trusted-table list is DERIVED from `CATALOG` (the same array the
 * `synced_assets` record is spread into via `catalog/index.ts`). Wiring this
 * group into the barrel therefore ALSO lands `synced_assets` in the trusted-
 * table list the substrate pull (PRD-033c) consults before its SELECT — no
 * separate list to edit. See `catalog/synced-assets.ts` CONVENTIONS note.
 */

import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

// ── Asset-type + harness enumerations (shared with the registry/contracts) ───

/** The asset kinds v1 syncs (FR-8 / a-AC-6). Hooks/rules/commands are deferred. */
export const SYNCED_ASSET_TYPES = Object.freeze(["skill", "agent"] as const);

/** A synced asset's kind: a skill (directory) or an agent (single file). */
export type SyncedAssetType = (typeof SYNCED_ASSET_TYPES)[number];

/** The string a live tombstone row carries (D-5: a tombstone is a row, not a DELETE). */
export const TOMBSTONE_TRUE = "true" as const;
/** The string a live (non-tombstone) row carries. */
export const TOMBSTONE_FALSE = "false" as const;

// ── synced_assets ─────────────────────────────────────────────────────────────

/**
 * `synced_assets` — one row per published artifact version (FR-8 / a-AC-6).
 *
 * The current state for a logical `honeycomb_id` is `ORDER BY version DESC LIMIT
 * 1`. Every publish/tombstone INSERTs a fresh row at version N+1 — never mutates
 * (D-5). Scope: tenant table (D-2) → explicit org/workspace/author.
 *
 * Column mapping (FR-8 / a-AC-6):
 *   identity:    honeycomb_id (the rename-stable id) + version (BIGINT default 1)
 *   kind:        asset_type ('skill' | 'agent'), harness (the native target)
 *   payload:     native (verbatim blob), canonical (reserved blob, default ''),
 *                content_hash (change detection / integrity)
 *   lifecycle:   tombstone ('true' | 'false', default 'false')
 *   placement:   tier (Local | Device | Team), style (Repository | User)
 *   tenancy:     org, workspace, author
 *   audience:    device_set (JSON array of device_ids, for Device tier, default '[]')
 *   timestamps:  created_at
 *
 * Every NOT NULL column carries a DEFAULT (the `validateColumnDefs` load-time
 * guard rejects a NOT NULL-without-DEFAULT column, so an additive ALTER TABLE
 * ADD COLUMN on a populated table can backfill existing rows). The two blob
 * columns (`native`, `canonical`) are TEXT — verbatim artifact bytes, not JSONB —
 * because they are opaque payloads the sync engine writes and reads whole, never
 * filtered or projected field-by-field.
 */
export const SYNCED_ASSETS_COLUMNS = Object.freeze([
	// Identity (rename-stable id + monotonic version)
	{ name: "honeycomb_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	// Kind
	{ name: "asset_type", sql: "TEXT NOT NULL DEFAULT 'skill'" },
	{ name: "harness", sql: "TEXT NOT NULL DEFAULT ''" },
	// Payload blobs (verbatim TEXT — opaque, written/read whole)
	{ name: "native", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "canonical", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "content_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	// Lifecycle (tombstone is a row, never a DELETE — D-5)
	{ name: "tombstone", sql: "TEXT NOT NULL DEFAULT 'false'" },
	// Placement (the tier × style lattice cell this version was published at)
	{ name: "tier", sql: "TEXT NOT NULL DEFAULT 'Local'" },
	{ name: "style", sql: "TEXT NOT NULL DEFAULT 'Repository'" },
	// Tenancy (explicit per D-2, scope = "tenant")
	{ name: "org", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
	// Audience (Device-tier device set — JSON array of device_ids)
	{ name: "device_set", sql: "TEXT NOT NULL DEFAULT '[]'" },
	// Timestamps
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);

/** The bare table name — the single place the literal `"synced_assets"` lives. */
export const SYNCED_ASSETS_TABLE = "synced_assets" as const;

// ── Catalog-level SQL helpers (read-shape builders, audit:sql-clean) ──────────

/**
 * Build the version-bump CURRENT READ for a `synced_assets` row (a-AC-6): the
 * highest-version row for a `honeycomb_id`, which is its current published
 * state (including a `tombstone='true'` retraction, when that is the latest
 * version). This is the reader convention paired with `appendVersionBumped`.
 * The identifier goes through `sqlIdent`; the id value through `sLiteral`.
 */
export function buildCurrentAssetVersionSql(honeycombId: string): string {
	const tbl = sqlIdent(SYNCED_ASSETS_TABLE);
	const col = sqlIdent("honeycomb_id");
	return `SELECT * FROM "${tbl}" WHERE ${col} = ${sLiteral(honeycombId)} ORDER BY version DESC LIMIT 1`;
}

// ── The 033a synced-assets group ──────────────────────────────────────────────

/**
 * The 033a synced-assets group. Spread into `CATALOG` by the barrel
 * (`index.ts`). Adding this import + spread is the ONLY wiring needed — the
 * record flows into `CATALOG`, the write-pattern `REGISTRY`, and the daemon's
 * `CATALOG`-derived trusted-table list automatically.
 */
export const SYNCED_ASSETS_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: SYNCED_ASSETS_TABLE,
		columns: SYNCED_ASSETS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "tenant",
	},
]);
