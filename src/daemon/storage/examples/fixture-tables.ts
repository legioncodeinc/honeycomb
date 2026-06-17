/**
 * MINIMAL FIXTURE ColumnDef arrays — NOT the real table catalog (that is
 * PRD-003).
 *
 * PRD-002 builds the storage SUBSTRATE: the escaping helpers, the heal engine,
 * the write primitives, the vector-search interface. To exercise those
 * primitives end-to-end against the fake transport, the adapter needs
 * REPRESENTATIVE tables — one per write pattern, plus a table carrying a 768-dim
 * embedding column. These are intentionally trimmed to the columns each pattern
 * actually touches; they are illustrative fixtures, not the production schema.
 *
 * When PRD-003 lands, it supplies the full per-table ColumnDef arrays and the
 * pattern assignment; these fixtures are then only used by tests and examples.
 * Each array is validated at load by `validateColumnDefs`, so a malformed
 * fixture fails the import the same way a real catalog table would.
 */

import { type ColumnDef, validateColumnDefs } from "../schema.js";

/**
 * Append-only INSERT table (PRD-002d FR-1): one row per event, read ordered by
 * `creation_date`. Carries a nullable 768-dim `message_embedding` so it also
 * serves the vector-search fixtures (PRD-002e FR-1).
 */
export const FIXTURE_SESSIONS_COLUMNS: readonly ColumnDef[] = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "message", sql: "JSONB" },
	{ name: "message_embedding", sql: "FLOAT4[]" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'private'" },
	{ name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * Append-only VERSION-BUMPED table (PRD-002d FR-2/FR-3): every edit INSERTs
 * version N+1; the reader takes `ORDER BY version DESC LIMIT 1`. Supersede
 * appends a new version with `status='superseded'` rather than mutating.
 */
export const FIXTURE_SKILLS_COLUMNS: readonly ColumnDef[] = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "skill_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "body", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * UPDATE-or-INSERT-by-key table (PRD-002d FR-4): one row per logical key
 * (`path`). The small-team v1 trade-off — accepts the rare UPDATE-coalescing
 * risk in exchange for a single row per key. Carries a nullable 768-dim
 * `summary_embedding` for the vector fixtures.
 */
export const FIXTURE_MEMORY_COLUMNS: readonly ColumnDef[] = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "summary", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "summary_embedding", sql: "FLOAT4[]" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'private'" },
	{ name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * SELECT-before-INSERT table (PRD-002d FR-5): insert iff the identity key is
 * absent, then re-verify after insert so a race is observable, not a silent
 * double. The identity key here is `commit_sha`.
 */
export const FIXTURE_CODEBASE_COLUMNS: readonly ColumnDef[] = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "commit_sha", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "snapshot_jsonb", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "node_count", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

// Validate every fixture at load, exactly as a real catalog table would be.
validateColumnDefs("FIXTURE_SESSIONS_COLUMNS", FIXTURE_SESSIONS_COLUMNS);
validateColumnDefs("FIXTURE_SKILLS_COLUMNS", FIXTURE_SKILLS_COLUMNS);
validateColumnDefs("FIXTURE_MEMORY_COLUMNS", FIXTURE_MEMORY_COLUMNS);
validateColumnDefs("FIXTURE_CODEBASE_COLUMNS", FIXTURE_CODEBASE_COLUMNS);
