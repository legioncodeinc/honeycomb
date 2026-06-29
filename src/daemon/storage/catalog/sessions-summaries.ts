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
	// PRD-049b: `project` is the existing free-text raw cwd path (kept per D5). `project_id`
	// is the RESOLVED registry key (049a) the scope clause segments on — additive, healed via
	// the `ALTER TABLE ADD COLUMN … DEFAULT ''` path. Default '' resolves to the workspace
	// `__unsorted__` inbox at read time (D5 / D8 unbound-session fallback).
	{ name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	// ── PRD-060a (a-AC-3 / a-AC-6): per-turn token + cache usage ──────────────────
	// Additive columns, healed in via the SAME `ALTER TABLE ADD COLUMN` path the rest
	// of the catalog uses (the heal engine iterates THIS array; nothing else to wire).
	//
	// ZERO vs NULL (a-AC-1 / a-AC-6, the open-question ruling): these four counts are
	// NULLABLE BIGINT with NO `DEFAULT 0`. The distinction is load-bearing — a genuine
	// `cache_read_input_tokens = 0` (a real measurement: nothing read from cache) must
	// stay DISTINCT from "no usage data" (the count was never produced). A `DEFAULT 0`
	// would collapse "absent" into "measured zero", which a-AC-6 forbids, so absent is
	// encoded as SQL NULL and a measured zero as the integer 0. Nullable columns are
	// exempt from the NOT-NULL-needs-a-DEFAULT load guard (NULL is their implicit
	// default), so `ALTER TABLE ADD COLUMN … BIGINT` heals cleanly onto a populated
	// legacy table: existing rows read back NULL = "token data absent" (a-AC-4).
	{ name: "input_tokens", sql: "BIGINT" },
	{ name: "output_tokens", sql: "BIGINT" },
	{ name: "cache_read_input_tokens", sql: "BIGINT" },
	{ name: "cache_creation_input_tokens", sql: "BIGINT" },
	// ── PRD-060 ROI fix: the per-turn MODEL id ────────────────────────────────────
	// The model the turn ran on (e.g. `claude-opus-4-8`), read from the Claude Code
	// transcript so the ROI dashboard prices the turn at its REAL model's rate instead of
	// the Sonnet default (`rowToCapturedTurn` reads this; `resolveRate` does the rest).
	// Additive, healed in via the SAME `ALTER TABLE ADD COLUMN … DEFAULT ''` path as the
	// 060a columns. TEXT NOT NULL DEFAULT '' — heal-safe on a populated legacy table because
	// the empty string backfills, and `'' = "model unknown"` (the model-absent encoding).
	{ name: "model", sql: "TEXT NOT NULL DEFAULT ''" },
	// The capture-source discriminant (a-AC-7): every Claude-Code row carries
	// `source_tool = 'claude-code'`, so 060b/060e can render a "Claude Code only"
	// partial state. NOT NULL DEFAULT '' (a discriminant always present; '' = unknown
	// source) — heal-safe on a populated table because the empty string backfills.
	{ name: "source_tool", sql: "TEXT NOT NULL DEFAULT ''" },
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
	// PRD-046b (b-AC-2/b-AC-4): the Tier-1 KEY — a ≤1-sentence, keyword-dense headline
	// derived from the GROUNDED summary so the prime (046c) skims keys with a pure SQL
	// select, NO generation at read time. Additive, heal-compatible (NOT NULL DEFAULT '').
	{ name: "key", sql: "TEXT NOT NULL DEFAULT ''" },
	// PRD-046b (b-AC-1): the index-refresh version. The `/MEMORY.md` index row is
	// re-written version-bumped as new summaries land (highest version = current),
	// mirroring `ontology/supersede.ts` / `pollinating/trigger.ts`. Per-session summary
	// rows keep version 0 (they are written exactly-once SELECT-before-INSERT); only the
	// synthesized index/head rows version-bump. Additive, heal-compatible.
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "mime_type", sql: "TEXT NOT NULL DEFAULT 'text/plain'" },
	// PRD-049b: `project` is the existing free-text raw cwd path (kept per D5); `project_id`
	// is the RESOLVED registry key (049a) the scope clause segments on — additive, healed via
	// `ALTER TABLE ADD COLUMN … DEFAULT ''`. Default '' resolves to the workspace inbox at read.
	{ name: "project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
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
 * Build the per-project session-count aggregate (PRD-059c c-AC-1 / c-AC-2): ONE
 * grouped read over `sessions` returning `(project_id, count, last_capture)` for
 * every project in the active org/workspace partition in a single round-trip. The
 * caller passes the active {@link QueryScope}, so the storage client's partition
 * layer scopes the read — `sessions` is an ENGINE table (no `org_id`/
 * `workspace_id` column); isolation comes from the partition header, not a WHERE.
 *
 * `sessions` is append-only RAW capture (one row per event), so the count is the
 * raw-event volume per project — the honest "captured activity" signal the
 * Projects page surfaces. The empty/`''` `project_id` group is the workspace
 * `__unsorted__` inbox (D5 / D8 unbound-session fallback); the caller maps the
 * `''` bucket onto the inbox id for c-AC-2's inbox size. `last_capture` is
 * `max(creation_date)` (ISO-8601 TEXT, lexicographically chronological), a cheap
 * by-product of the same GROUP BY.
 *
 * All identifiers route through `sqlIdent`; there is NO interpolated VALUE, so
 * `audit:sql` stays clean.
 */
export function buildSessionCountsByProjectSql(): string {
	const tbl = sqlIdent("sessions");
	const pid = sqlIdent("project_id");
	const created = sqlIdent("creation_date");
	return `SELECT ${pid}, count(*) AS n, max(${created}) AS last_capture FROM "${tbl}" GROUP BY ${pid}`;
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
