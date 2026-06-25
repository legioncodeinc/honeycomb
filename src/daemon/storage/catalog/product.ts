/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-003d — Product Tables (Wave 2, IMPLEMENTED)                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The five product tables carried from hivemind onto DeepLake: `skills` (mined
 * SKILL.md versions), `rules` (org-wide principles), `goals` and `kpis` (keyed
 * product state), and `codebase` (per-identity graph snapshots). All are
 * `USING deeplake` tables written only by the daemon on port 3850.
 *
 * Write-pattern assignment (PRD-002d / CONVENTIONS.md §2):
 *
 *   - `skills`, `rules`  → version-bumped  (appendVersionBumped).
 *                          Every edit INSERTs version N+1; current state is
 *                          ORDER BY version DESC LIMIT 1. (d-AC-1 / d-AC-5)
 *
 *   - `goals`, `kpis`    → update-or-insert by logical key (updateOrInsertByKey).
 *                          One row per key; D-4 minimal shape:
 *                          key / value / target / status / unit + scope /
 *                          timestamps. (d-AC-3)
 *
 *   - `codebase`         → select-before-insert (selectBeforeInsert).
 *                          Probe identity key, INSERT if absent, re-verify so
 *                          concurrent-writer races are observable (d-AC-4/d-AC-6).
 *                          snapshot_sha256 dedups identical pushes; snapshot_jsonb
 *                          carries the NetworkX node-link payload. (d-AC-2)
 *
 * Scope (D-2 / index AC-3 / FR-7):
 *   - skills/rules/goals/kpis: `scope: "agent"` — engine tables; carry
 *     agent_id + visibility; org/workspace isolation via storage partitioning.
 *   - codebase: `scope: "tenant"` — cross-cutting table; carries explicit
 *     org_id + workspace_id rather than relying on the partition layer.
 *
 * Adapted from hivemind-v1 SKILLS_COLUMNS / RULES_COLUMNS / CODEBASE_COLUMNS
 * (HIVEMIND_* → HONEYCOMB_*). goals/kpis deviate from hivemind-v1's version-
 * bumped path-convention toward D-4's minimal update-or-insert-by-key shape, as
 * PRD-003d FRs are the tighter contract (EXECUTION_LEDGER-prd-003.md D-4).
 *
 * SQL-safety: all query helpers route identifiers through sqlIdent and values
 * through sLiteral (PRD-002b / CONVENTIONS.md §9). `npm run audit:sql` enforces.
 */

import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

// ── skills ──────────────────────────────────────────────────────────────────

/**
 * `skills` — one row per skill version (FR-1 / d-AC-5).
 *
 * The current skill for a `(project_key, name)` pair is `ORDER BY version DESC
 * LIMIT 1`. Every edit INSERTs a fresh row at version N+1 — never mutates
 * (d-AC-1). Scope: engine table (D-2) → agent_id + visibility.
 *
 * Column mapping (FR-1 / hivemind-v1 SKILLS_COLUMNS adapted):
 *   identity:    id, name, project_key, project_id
 *   install:     scope, install, author, contributors, source_sessions
 *   body:        description, trigger_text, body
 *   version:     version (BIGINT default 1)
 *   promotion:   cross_project_scope, promoted_by, promoted_at, promoted_from_project (PRD-049c)
 *   timestamps:  created_at, updated_at
 *   scope:       agent_id, visibility
 *
 * ── PRD-049c — per-project skill isolation + explicit cross-project promotion ──
 * `project_id` is the RESOLVED registry key (049a) the surfacing predicate segments on —
 * ADDITIVE, heal-compatible (NOT NULL DEFAULT ''). The legacy path-derived `project_key`
 * STAYS as a display/back-compat alias (D7): existing rows are NOT rewritten. A row written
 * before 049c carries `project_id = ''`, which the surfacing predicate ({@link import("../../runtime/recall/scope-clause.js").buildProjectScopeClause})
 * admits at read time alongside the session's project + the inbox (back-compat, D5).
 *
 * The four promotion columns make cross-project sharing an EXPLICIT, provenance-recorded
 * opt-in (49c-AC-2 / 49c-AC-4). They are NEVER set by the mine path or the pull path — only
 * by the two explicit promote operations (this-user-cross-project / workspace-wide):
 *   - `cross_project_scope` — `none` (project-scoped, the mine/pull default) | `user`
 *     (this user's other projects) | `workspace` (all teammates, every project). The
 *     surfacing predicate admits a `user`/`workspace` row in ANY of the user's projects.
 *   - `promoted_by` / `promoted_at` — WHO promoted it and WHEN (visible provenance, 49c-AC-2).
 *   - `promoted_from_project` — the ORIGIN `project_id` the skill was promoted FROM, so the
 *     surfaced result shows "promoted from <project>" cross-project provenance (49c-AC-2).
 * Append-only/version-bump discipline (d-AC-1): a promotion is a NEW version row stamping
 * these columns, never an in-place UPDATE of the mined row.
 */
export const SKILLS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	// PRD-049c: legacy path-derived alias (D7) — KEPT for display/back-compat, never migrated away.
	{ name: "project_key", sql: "TEXT NOT NULL DEFAULT ''" },
	// PRD-049c: the RESOLVED registry key (049a) the surfacing predicate segments on (additive, D5/D7).
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "scope", sql: "TEXT NOT NULL DEFAULT 'me'" },
	{ name: "install", sql: "TEXT NOT NULL DEFAULT 'project'" },
	{ name: "author", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "contributors", sql: "TEXT NOT NULL DEFAULT '[]'" },
	{ name: "source_sessions", sql: "TEXT NOT NULL DEFAULT '[]'" },
	{ name: "description", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "trigger_text", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "body", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	// PRD-049c D6: explicit cross-project promotion marker + provenance (never set by mine/pull).
	{ name: "cross_project_scope", sql: "TEXT NOT NULL DEFAULT 'none'" },
	{ name: "promoted_by", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "promoted_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "promoted_from_project", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);

// ── rules ────────────────────────────────────────────────────────────────────

/**
 * `rules` — org-wide principles, one row per rule version (FR-3).
 *
 * The active rule for a `key` is `ORDER BY version DESC LIMIT 1`. Edits INSERT
 * a fresh row at version N+1; the prior version survives in the append-only log
 * (d-AC-1). Scope: engine table (D-2) → agent_id + visibility.
 *
 * Column mapping (FR-3 / hivemind-v1 RULES_COLUMNS adapted to FR-3 column list):
 *   identity:  id, key (logical rule key, was rule_id in hivemind-v1)
 *   body:      name (display label), body (full text, was `text` in hivemind-v1)
 *   state:     scope, status (default 'active')
 *   version:   version (BIGINT default 1)
 *   timestamps: created_at, updated_at
 *   scope:     agent_id, visibility
 *
 * Deviation from hivemind-v1: column `text` renamed to `body` per FR-3;
 * `rule_id` renamed to `key` per FR-3; agent/plugin_version dropped in favour of
 * the standard agent_id/visibility scope columns.
 */
export const RULES_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "key", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "body", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "scope", sql: "TEXT NOT NULL DEFAULT 'team'" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);

// ── goals / kpis shared column shape ─────────────────────────────────────────

/**
 * D-4 minimal column shape shared by `goals` and `kpis` (FR-4 / D-4).
 *
 * Both tables are UPDATE-or-INSERT by logical `key` with the same minimal column
 * set: key / value / target / status / unit + agent scope + timestamps. Defining
 * the shape once and aliasing it removes the structural duplication while
 * preserving the distinct exported constants consumers reference by table name.
 *
 * Scope columns: agent engine table (D-2) → agent_id + visibility.
 *
 * Deviation from hivemind-v1: hivemind-v1 `GOALS_COLUMNS`/`KPIS_COLUMNS` use a
 * VFS path convention with version-bumping. PRD-003d D-4 + FR-4 mandate
 * update-or-insert-by-key with this minimal shape — the PRD FRs are the tighter
 * contract (EXECUTION_LEDGER-prd-003.md D-4).
 */
const GOAL_KPI_COLUMNS_BASE = Object.freeze([
	{ name: "key", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "value", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "target", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'open'" },
	{ name: "unit", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);

// ── goals ────────────────────────────────────────────────────────────────────

/**
 * `goals` — keyed product objectives (FR-4 / D-4).
 *
 * One row per logical key; UPDATE-or-INSERT by `key` (updateOrInsertByKey).
 * Uses {@link GOAL_KPI_COLUMNS_BASE}: the shared D-4 minimal column shape.
 */
export const GOALS_COLUMNS: typeof GOAL_KPI_COLUMNS_BASE = GOAL_KPI_COLUMNS_BASE;

// ── kpis ─────────────────────────────────────────────────────────────────────

/**
 * `kpis` — keyed product KPI state (FR-4 / D-4).
 *
 * One row per logical `key`; UPDATE-or-INSERT by `key`. Uses the same
 * {@link GOAL_KPI_COLUMNS_BASE} shape as `goals` — intentional per D-4.
 */
export const KPIS_COLUMNS: typeof GOAL_KPI_COLUMNS_BASE = GOAL_KPI_COLUMNS_BASE;

// ── codebase ──────────────────────────────────────────────────────────────────

/**
 * `codebase` — per-identity graph snapshots (FR-5 / FR-6 / FR-7 / d-AC-2).
 *
 * One row per (org, workspace, repo, user, worktree, commit) identity. Uses
 * SELECT-before-INSERT: probe the composite key, insert if absent, re-verify so
 * a concurrent-writer race is observable rather than silent (d-AC-4 / d-AC-6).
 *
 * snapshot_sha256 dedups identical pushes: same commit + same extractor version
 * SHOULD yield the same hash; a mismatch on the same commit signals extractor
 * drift and is recorded as a new row (FR-6).
 *
 * Scope: `"tenant"` (FR-7 / D-2 / index AC-3) — carries explicit org_id +
 * workspace_id rather than relying on the agent-level storage partition.
 *
 * Adapted from hivemind-v1 CODEBASE_COLUMNS. `ts` TIMESTAMP column omitted in
 * favour of `created_at TEXT` for consistency with the rest of the catalog's
 * timestamp convention; `parent_sha` and `pushed_by` retained as identity
 * context. `generator` column renamed `generator_name` to avoid shadowing any
 * future reserved word; all other columns are direct mappings.
 */
export const CODEBASE_COLUMNS = Object.freeze([
	// Tenant identity (explicit per D-2 / FR-7, scope = "tenant")
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	// Row identity
	{ name: "repo_slug", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "user_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "worktree_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "commit_sha", sql: "TEXT NOT NULL DEFAULT ''" },
	// Observation metadata
	{ name: "branch", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "parent_sha", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "pushed_by", sql: "TEXT NOT NULL DEFAULT ''" },
	// Snapshot payload
	{ name: "snapshot_sha256", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "snapshot_jsonb", sql: "JSONB" },
	// Graph stats
	{ name: "node_count", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "edge_count", sql: "BIGINT NOT NULL DEFAULT 0" },
	// Generator metadata (drift diagnostics)
	{ name: "generator_name", sql: "TEXT NOT NULL DEFAULT 'honeycomb-graph'" },
	{ name: "generator_version", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "schema_version", sql: "BIGINT NOT NULL DEFAULT 1" },
	// Timestamps
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);

// ── Catalog-level SQL helpers ────────────────────────────────────────────────

/**
 * Build the version-bump CURRENT READ for a skills or rules row (d-AC-1):
 * ORDER BY version DESC LIMIT 1 for a given key column + value. This is the
 * reader convention paired with appendVersionBumped. Every identifier goes
 * through sqlIdent; the key value through sLiteral (PRD-002b).
 *
 * @param table  - bare table name (`"skills"` or `"rules"`)
 * @param keyColumn - the logical key column (`"name"` for skills, `"key"` for rules)
 * @param keyValue  - the value to filter on
 */
export function buildCurrentVersionSql(table: string, keyColumn: string, keyValue: string): string {
	const tbl = sqlIdent(table);
	const col = sqlIdent(keyColumn);
	return (
		`SELECT * FROM "${tbl}" ` +
		`WHERE ${col} = ${sLiteral(keyValue)} ` +
		"ORDER BY version DESC LIMIT 1"
	);
}

/**
 * Build the snapshot dedup probe for codebase (d-AC-4): checks whether a row
 * with a matching snapshot_sha256 already exists for the composite identity.
 * A truthy result from the fake transport → SELECT-before-INSERT skips the
 * duplicate. All identifiers through sqlIdent; values through sLiteral.
 */
export function buildSnapshotDedupSql(sha256: string): string {
	const tbl = sqlIdent("codebase");
	const col = sqlIdent("snapshot_sha256");
	return `SELECT ${sqlIdent("commit_sha")} FROM "${tbl}" WHERE ${col} = ${sLiteral(sha256)} LIMIT 1`;
}

// ── The 003d group ───────────────────────────────────────────────────────────

/**
 * The 003d product group. Spread into `CATALOG` by the barrel (`index.ts`).
 * The barrel was pre-wired by Wave 1; filling this array flows all five tables
 * into CATALOG + REGISTRY automatically with no edits to shared files.
 */
export const PRODUCT_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: "skills",
		columns: SKILLS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "rules",
		columns: RULES_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "goals",
		columns: GOALS_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "kpis",
		columns: KPIS_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "codebase",
		columns: CODEBASE_COLUMNS,
		pattern: "select-before-insert",
		embeddingColumns: [],
		scope: "tenant",
	},
]);
