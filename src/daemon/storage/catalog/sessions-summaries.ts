/**
 * PRD-003c — Sessions, Transcripts, and Summaries (Wave 1, IMPLEMENTED).
 *
 * The capture + summary tables. Together with `memories` (PRD-003a) these are
 * the THREE memory tables whose roles must never blur (index AC-2 / c-AC-3):
 *
 *   - `sessions` → RAW events. One row per prompt / tool call / response, a
 *                  JSONB `message`, append-only INSERT. Readers reconstruct a
 *                  turn stream by selecting on `path` ordered by `creation_date`
 *                  and concatenating — never by mutating a row. (c-AC-1)
 *   - `memory`   → VFS + wiki SUMMARIES. UPDATE-or-INSERT by `path`; a wiki
 *                  summary upserts in place and the VFS upserts file rows at
 *                  their path. (c-AC-2)
 *   - `memories` → DISTILLED facts (PRD-003a). Defined elsewhere; named here only
 *                  to assert the role boundary.
 *
 * Session transcripts are a `memory` PATH CONVENTION (`transcripts/<session>`),
 * NOT a distinct table (D-1 / c-AC-4) — see {@link transcriptPath}.
 *
 * Scope (D-2): both are engine tables → `agent_id` + `visibility`; org/workspace
 * isolation comes from the storage partition layer.
 *
 * Adapted from hivemind-v1 `SESSIONS_COLUMNS` / `MEMORY_COLUMNS`, trimmed to the
 * 003c FR-1 / FR-4 column lists (HIVEMIND_* → HONEYCOMB_*).
 */

import { embeddingColumn } from "../vector.js";
import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

/**
 * `sessions` — raw per-event capture (FR-1 / c-AC-1). Append-only INSERT.
 * `message` is JSONB (genuinely schemaless per-event payload); `message_embedding`
 * is the nullable 768-dim `FLOAT4[]` (index AC-4 / c-AC-5).
 */
export const SESSIONS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "message", sql: "JSONB" },
	embeddingColumn("message_embedding"),
	{ name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `memory` — VFS + wiki summaries (FR-4 / c-AC-2). UPDATE-or-INSERT by `path`.
 * `summary` is the body; `summary_embedding` is the nullable 768-dim `FLOAT4[]`
 * recall ranks summaries over (index AC-4). `mime_type` defaults `'text/plain'`.
 *
 * This is the VFS/summaries table — DISTINCT from `memories` (003a, distilled
 * facts) and `sessions` (raw). Session transcripts live HERE as a path
 * convention (c-AC-4), not as a separate table.
 */
export const MEMORY_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "path", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "filename", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "summary", sql: "TEXT NOT NULL DEFAULT ''" },
	embeddingColumn("summary_embedding"),
	// PRD-017: a short excerpt of the summary body. Also load-bearing for the
	// wiki summary worker's in-progress placeholder marker (description='in progress')
	// so a stranded placeholder can be targeted for removal. Additive, heal-compatible.
	{ name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "mime_type", sql: "TEXT NOT NULL DEFAULT 'text/plain'" },
	{ name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "creation_date", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "last_update_date", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** The 003c group — spread into `CATALOG` by the barrel. */
export const SESSIONS_SUMMARIES_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: "sessions",
		columns: SESSIONS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: ["message_embedding"],
		scope: "agent",
	},
	{
		name: "memory",
		columns: MEMORY_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: ["summary_embedding"],
		scope: "agent",
	},
]);

/** Root prefix for the session-transcript path convention (D-1 / c-AC-4). */
export const TRANSCRIPT_PATH_PREFIX = "transcripts/" as const;

/**
 * The `memory` path a session transcript persists at (D-1 / c-AC-4 / FR-6).
 * Returns `transcripts/<session>` — a PATH into the `memory` table, NOT a new
 * table. The summary worker writes the transcript via the `memory`
 * UPDATE-or-INSERT-by-`path` pattern at this path. `sessionId` is trimmed of any
 * surrounding slashes so the convention stays canonical.
 */
export function transcriptPath(sessionId: string): string {
	const clean = sessionId.replace(/^\/+|\/+$/g, "");
	return `${TRANSCRIPT_PATH_PREFIX}${clean}`;
}

/** Is this `memory` path a session transcript (c-AC-4)? */
export function isTranscriptPath(path: string): boolean {
	return path.startsWith(TRANSCRIPT_PATH_PREFIX);
}

/**
 * Build a `memory` lookup by transcript path (c-AC-4). Demonstrates the
 * transcript is reachable through the ordinary `memory`-by-`path` access, not a
 * bespoke table. The path routes through `sLiteral` (SQL-safety floor).
 */
export function buildTranscriptLookupSql(sessionId: string): string {
	const tbl = sqlIdent("memory");
	const col = sqlIdent("path");
	return `SELECT * FROM "${tbl}" WHERE ${col} = ${sLiteral(transcriptPath(sessionId))} LIMIT 1`;
}

/**
 * The role of each of the three memory tables (index AC-2 / c-AC-3). Exported so
 * a test can assert the roles are distinct and non-overlapping, and so a reader
 * has a single authoritative statement of which table holds what.
 */
export const MEMORY_TABLE_ROLES = Object.freeze({
	sessions: "raw events",
	memory: "VFS and summaries",
	memories: "distilled facts",
} as const);
