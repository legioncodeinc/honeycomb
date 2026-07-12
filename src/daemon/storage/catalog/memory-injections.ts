/**
 * Memory-injection telemetry catalog table (`memory_injections`).
 *
 * APPEND-ONLY log: one row per injection event — a recall response or a prime
 * digest served to a harness. Written only by the daemon through the PRD-002d
 * write primitives + the PRD-002c heal engine (lazy CREATE on first write, no
 * migration, no backfill). Rows are immutable events, never edited (the same
 * discipline as `memory_access` / `routing_history`).
 *
 * ── Scope (D-2) ─────────────────────────────────────────────────────────────
 * `scope: "agent"`: the row carries `agent_id` + `visibility`; org/workspace
 * isolation rides the storage partition (QueryScope), never columns. NOTE the
 * aggregate readers below are DELIBERATELY cross-agent: injection totals are
 * workspace/project telemetry, so they do not AND the agent conjunct in — the
 * partition still isolates tenants (same rationale as `routing_history`'s
 * denormalized-context columns).
 *
 * Every NOT NULL column carries a DEFAULT so the heal ALTER backfills a
 * populated table cleanly (PRD-002c load-time guard).
 */

import { sLiteral, sqlIdent } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

/** The closed injection-source taxonomy: which read path served the tokens. */
export const INJECTION_SOURCES = Object.freeze(["recall", "recall_fast", "prime"] as const);
export type InjectionSource = (typeof INJECTION_SOURCES)[number];

/** Type guard onto the closed {@link InjectionSource} taxonomy (writer gates on this). */
export function isInjectionSource(value: string): value is InjectionSource {
	return (INJECTION_SOURCES as readonly string[]).includes(value);
}

/**
 * `memory_injections` — one row per injection event. Column order:
 * identity → time → event (source/hits/tokens) → attribution → scope.
 */
export const MEMORY_INJECTIONS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source", sql: "TEXT NOT NULL DEFAULT 'recall'" }, // NOT '' — closed taxonomy
	{ name: "hits", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "tokens", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "session_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
]);

/** The bare `memory_injections` table name, exported so writers never re-spell it. */
export const MEMORY_INJECTIONS_TABLE = "memory_injections" as const;

/** The injection-telemetry group — spread into `CATALOG` by the barrel. */
export const MEMORY_INJECTIONS_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: MEMORY_INJECTIONS_TABLE,
		columns: MEMORY_INJECTIONS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "agent",
	},
]);

/** The optional ` WHERE project_id = '<id>'` conjunct (blank/absent → workspace-wide). */
function projectWhereClause(projectId?: string): string {
	return projectId !== undefined && projectId !== ""
		? ` WHERE ${sqlIdent("project_id")} = ${sLiteral(projectId)}`
		: "";
}

/** COALESCE guards NULL-on-empty; caller still reads via a toNum-style guard. NO GROUP BY. */
export function buildInjectionTokenSumSql(projectId?: string): string {
	const tbl = sqlIdent(MEMORY_INJECTIONS_TABLE);
	const tokensCol = sqlIdent("tokens");
	const whereClause = projectWhereClause(projectId);
	return `SELECT COALESCE(SUM(${tokensCol}), 0) AS tokens FROM "${tbl}"${whereClause}`;
}

/** Ranged read; day bucketing (`at.slice(0,10)`) in TS. ISO cutoff compares lexicographically. */
export function buildInjectionRangeSql(sinceIso: string, projectId?: string): string {
	const tbl = sqlIdent(MEMORY_INJECTIONS_TABLE);
	const atCol = sqlIdent("at");
	const projectClause = projectId !== undefined && projectId !== ""
		? ` AND ${sqlIdent("project_id")} = ${sLiteral(projectId)}`
		: "";
	return (
		`SELECT ${atCol} AS at, ${sqlIdent("source")} AS source, ${sqlIdent("hits")} AS hits, ` +
		`${sqlIdent("tokens")} AS tokens FROM "${tbl}" ` +
		`WHERE ${atCol} >= ${sLiteral(sinceIso)}${projectClause} ` +
		`ORDER BY ${atCol} ASC`
	);
}
