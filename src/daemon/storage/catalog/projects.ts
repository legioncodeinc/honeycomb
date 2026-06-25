/**
 * PRD-049a — Project Identity & Resolution: the `projects` registry table.
 *
 * The server-side, cross-device source of truth for "the list of projects you
 * can assign folders to" (operator decision D4). A **Project** is a registry-
 * backed identity that FOLDERS are bound to — NOT a GitHub repository id. A git
 * remote, when present, is only an optional auto-bind *signal*; resolution works
 * identically with no repo (OpenClaw/Hermes/scratch dirs). This module owns the
 * column-definition array the create path and the heal pass both iterate; the
 * resolver (`resolveScope`, a separate thin-client module) and the local
 * `~/.deeplake/projects.json` cache are built elsewhere and CONSUME the contract
 * exported here (a-AC-1 … a-AC-6).
 *
 * ── Scope (CONVENTIONS.md §3 / D-2 / index "Data model changes") ─────────────
 * `scope: "tenant"`. The registry is a CROSS-CUTTING table that carries EXPLICIT
 * `org_id` + `workspace_id` (`TEXT NOT NULL DEFAULT ''`), exactly like `agents`
 * and `synced_assets`. Project is a soft segment WITHIN a workspace (Org =
 * Company → Workspace = Team → Project = a folder-bound segment of a team's
 * work), so a project belongs to exactly one `(org_id, workspace_id)` and the
 * reserved `__unsorted__` inbox exists PER workspace.
 *
 * ── Write pattern (CONVENTIONS.md §2 / PRD-002d) ─────────────────────────────
 * `pattern: "update-or-insert"` keyed by `project_id`. A registry of projects is
 * mutable-CRUD-ish (create a project, rename it, edit its match rules) — one
 * logical row per `project_id`, the SAME shape as the `agents` roster, `goals`,
 * and `kpis`. It is deliberately NOT `version-bumped`: a project is not an
 * append-only edit-log whose history must be replayed (that pattern is for
 * skills / rules / api_keys, where a stale by-id read on this backend would be a
 * correctness bug). It is NOT `append-only` (that is for immutable events). The
 * `update-or-insert` trade-off — the rare DeepLake UPDATE-coalescing drop on a
 * hot concurrent edit of the SAME `project_id` — is acceptable here: project
 * CRUD is low-frequency and human-driven, never a hot concurrent-write path.
 *
 * Lazy-create + heal (D-6): there is NO DDL pre-step. The first write against
 * `healTargetFor("projects")` fails with a missing-table error, `withHeal`
 * issues the `buildCreateTableSql` CREATE from THIS ColumnDef array, and the
 * write retries — exactly like every other catalog table. Adding a column later
 * is one additive `ALTER TABLE ADD COLUMN` the heal pass emits from the diff;
 * every NOT NULL column carries a DEFAULT so that ALTER lands on a populated
 * table (the `validateColumnDefs` load-time guard enforces it).
 *
 * ── Reserved inbox (a-AC-6) ──────────────────────────────────────────────────
 * Every workspace has a reserved `__unsorted__` project — the capture inbox a
 * session falls to when no binding, no git signal, and no path candidate
 * resolves a real project (capture is NEVER dropped). {@link UNSORTED_PROJECT_ID}
 * is that reserved id. A user-created project may NOT collide with it: a create
 * MUST route through {@link assertNotReservedProjectId} first (the collision
 * guard 049a-AC-6). `__unsorted__` is seeded per workspace via
 * {@link buildEnsureUnsortedSelectSql} (probe) → INSERT if absent.
 *
 * ── Match-rule storage — JSONB vs columns (CONVENTIONS.md §5) ────────────────
 * Two deterministic match keys are DISCRETE columns because the resolver filters
 * on them in a WHERE on (nearly) every resolution — they FAIL the 80/20 JSONB
 * test:
 *   - `remote_signal` — the CANONICALIZED git remote (`host/owner/repo`, e.g.
 *     `github.com/acme/api`). Canonicalization is the resolver's job (it folds
 *     `git@github.com:acme/api.git` ≡ `https://github.com/acme/api` to ONE form,
 *     a-AC-1); the registry stores and matches the canonical string by
 *     deterministic EQUALITY. Storing it as a column (not inside a JSON blob)
 *     is what lets the git-signal branch be a single indexed `WHERE remote_signal
 *     = …` lookup (a-AC-4).
 * The variable-length bound-path set is JSONB because it is read WHOLE by the
 * longest-prefix matcher in the resolver and is never filtered field-by-field in
 * SQL (the sanctioned schemaless-payload use):
 *   - `bound_paths` — a JSON array of normalized absolute path prefixes a folder→
 *     project binding has recorded for this project. The resolver loads the
 *     candidate projects for the workspace and does the longest-prefix match in
 *     TypeScript; SQL never indexes into the array.
 *
 * SQL-safety (CONVENTIONS.md §9 / PRD-002b): this module defines columns + read-
 * shape builders only. Every dynamic fragment routes through `sqlIdent`
 * (identifiers) / `sLiteral` (values). `npm run audit:sql` fails CI on a raw
 * interpolation; no value here is hand-quoted.
 */

import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

// ── Reserved inbox identity (a-AC-3 / a-AC-6) ────────────────────────────────

/**
 * The reserved per-workspace inbox project id. A session that resolves no
 * binding, no git signal, and no path candidate falls to THIS project so capture
 * is never dropped (a-AC-3). It mirrors `agent_id`'s `DEFAULT 'default'`
 * discipline (CONVENTIONS.md §3): the inner ring defaults to a known bucket on
 * unknown rather than failing the write.
 *
 * It is RESERVED: a user-created project may not adopt this id or name
 * ({@link assertNotReservedProjectId} is the 049a-AC-6 collision guard). One
 * `__unsorted__` exists per `(org_id, workspace_id)` — the id is the same string
 * in every workspace, disambiguated by the tenancy columns on the row.
 */
export const UNSORTED_PROJECT_ID = "__unsorted__" as const;

/**
 * The display name the seeded `__unsorted__` row carries. Kept distinct from the
 * id so the dashboard can render a friendly label while the id stays the stable
 * reserved key.
 */
export const UNSORTED_PROJECT_NAME = "Unsorted" as const;

/**
 * The reserved identifiers a user-created project may NOT collide with (049a-AC-6).
 * Both the id and the name are reserved so a user can neither re-create the inbox
 * by id nor shadow it by display name. Comparison is case-insensitive +
 * trimmed (see {@link assertNotReservedProjectId}).
 */
export const RESERVED_PROJECT_IDS = Object.freeze([UNSORTED_PROJECT_ID] as const);

// ── projects ─────────────────────────────────────────────────────────────────

/** The bare table name — the single place the literal `"projects"` lives. */
export const PROJECTS_TABLE = "projects" as const;

/**
 * `projects` — the per-workspace project registry (PRD-049a). UPDATE-or-INSERT by
 * `project_id`. Column order: identity → display → match rules → tenancy → time.
 *
 *   - `project_id`    the stable registry key a folder is bound to and a memory/
 *                     session/skill row's resolved `project_id` references. The
 *                     reserved inbox is {@link UNSORTED_PROJECT_ID}. NOT a GitHub
 *                     repo id.
 *   - `name`          human display label (e.g. "API", "Unsorted").
 *   - `remote_signal` the CANONICALIZED git remote (`host/owner/repo`) this
 *                     project auto-binds from, or '' when the project has no git
 *                     signal. A DISCRETE column (not JSONB) so the resolver's git
 *                     branch is a single `WHERE remote_signal = …` equality match
 *                     (a-AC-4). Canonicalization (folding `git@`/`https`/`.git`
 *                     to one form, a-AC-1) is the RESOLVER's job; the registry
 *                     stores + matches the canonical string verbatim.
 *   - `bound_paths`   JSON array of normalized absolute path prefixes bound to
 *                     this project. Read WHOLE by the resolver's longest-prefix
 *                     matcher; never filtered field-by-field in SQL → the
 *                     sanctioned schemaless-payload column (CONVENTIONS.md §5).
 *                     `TEXT NOT NULL DEFAULT '[]'` (a JSON-array string), matching
 *                     the `tags` / `permissions` / `device_set` precedent rather
 *                     than a nullable `JSONB` — the resolver always parses it as a
 *                     present array, never NULL.
 *   - `is_reserved`   BIGINT 0/1; 1 ONLY on the seeded `__unsorted__` inbox row.
 *                     Lets a read identify the inbox structurally and the create
 *                     guard reject a collision without string-matching the id.
 *   - `org_id` /
 *     `workspace_id`  EXPLICIT tenancy (D-2, scope = "tenant"). A project belongs
 *                     to exactly one (org, workspace); `__unsorted__` is reserved
 *                     PER (org_id, workspace_id).
 *   - `created_at` /
 *     `updated_at`    ISO-8601 timestamps (TEXT, the catalog convention).
 *
 * Every NOT NULL column carries a DEFAULT so an additive `ALTER TABLE ADD COLUMN`
 * on a populated table backfills existing rows (the `validateColumnDefs` guard).
 */
export const PROJECTS_COLUMNS = Object.freeze([
	// Identity
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	// Display
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	// Match rules
	{ name: "remote_signal", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "bound_paths", sql: "TEXT NOT NULL DEFAULT '[]'" },
	// Reserved-inbox marker (1 = the per-workspace __unsorted__ row)
	{ name: "is_reserved", sql: "BIGINT NOT NULL DEFAULT 0" },
	// Tenancy (explicit per D-2, scope = "tenant")
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	// Timestamps
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
] as const);

/** `is_reserved` encodings. BIGINT 0/1 per the catalog's flag convention. */
export const PROJECT_NOT_RESERVED = 0 as const;
export const PROJECT_RESERVED = 1 as const;

/**
 * A registry project row — the clean TypeScript type the resolver (`resolveScope`)
 * and the local `projects.json` cache consume. Field names mirror the ColumnDef
 * names 1:1. `boundPaths` is the PARSED form of the `bound_paths` JSON-array
 * string; the consumer parses on read and serializes on write.
 */
export interface ProjectRow {
	/** Stable registry key a folder binds to; {@link UNSORTED_PROJECT_ID} for the inbox. */
	readonly project_id: string;
	/** Human display label. */
	readonly name: string;
	/** Canonicalized git remote (`host/owner/repo`), or '' when none. */
	readonly remote_signal: string;
	/** Normalized absolute path prefixes bound to this project (parsed from `bound_paths`). */
	readonly boundPaths: readonly string[];
	/** True only for the per-workspace reserved `__unsorted__` inbox row. */
	readonly is_reserved: boolean;
	/** Owning organization id (tenancy). */
	readonly org_id: string;
	/** Owning workspace id (tenancy); the inbox is reserved per workspace. */
	readonly workspace_id: string;
	/** ISO-8601 creation timestamp. */
	readonly created_at: string;
	/** ISO-8601 last-update timestamp. */
	readonly updated_at: string;
}

// ── The 049a projects group ──────────────────────────────────────────────────

/**
 * The 049a projects group — spread into `CATALOG` by the barrel (`index.ts`).
 * Adding the import + spread there is the ONLY wiring needed: the record flows
 * into `CATALOG`, the write-pattern `REGISTRY` (update-or-insert →
 * updateOrInsertByKey), and the daemon's `CATALOG`-derived trusted-table list
 * automatically.
 */
export const PROJECTS_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: PROJECTS_TABLE,
		columns: PROJECTS_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: [],
		scope: "tenant",
	},
]);

// ── Collision guard (049a-AC-6) ──────────────────────────────────────────────

/**
 * Structured rejection raised when a user-created project would collide with the
 * reserved `__unsorted__` inbox (049a-AC-6). A distinct type so a create path can
 * catch it and surface a clean "that name is reserved" message rather than a
 * generic write failure.
 */
export class ReservedProjectIdError extends Error {
	readonly attempted: string;
	constructor(attempted: string) {
		super(`Project id/name "${attempted}" is reserved for the per-workspace inbox and cannot be user-created`);
		this.name = "ReservedProjectIdError";
		this.attempted = attempted;
	}
}

/**
 * Normalize a candidate id/name for reserved-collision comparison: trim and
 * lowercase, so `" __UNSORTED__ "` is caught as a collision with `__unsorted__`
 * (049a-AC-6). Pure.
 */
function normalizeForReservedCheck(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Is this id/name reserved (049a-AC-6)? True when the trimmed, lowercased
 * candidate equals any {@link RESERVED_PROJECT_IDS} entry (or the reserved
 * display name). Pure — the create path calls it before writing.
 */
export function isReservedProjectId(candidate: string): boolean {
	const norm = normalizeForReservedCheck(candidate);
	if (norm === normalizeForReservedCheck(UNSORTED_PROJECT_NAME)) return true;
	return RESERVED_PROJECT_IDS.some((reserved) => normalizeForReservedCheck(reserved) === norm);
}

/**
 * Assert a user-supplied project id AND name do not collide with the reserved
 * inbox (049a-AC-6). The create path MUST call this BEFORE the
 * `updateOrInsertByKey` write — a project that adopts `__unsorted__` (by id or by
 * the reserved display name) would shadow the inbox and break the never-dropped
 * capture guarantee. Throws {@link ReservedProjectIdError} on a collision;
 * returns void on success so it composes as a guard at the top of a create.
 */
export function assertNotReservedProjectId(projectId: string, name: string): void {
	if (isReservedProjectId(projectId)) throw new ReservedProjectIdError(projectId);
	if (isReservedProjectId(name)) throw new ReservedProjectIdError(name);
}

// ── Read-shape builders (audit:sql-clean) ────────────────────────────────────

/**
 * Build the SELECT that lists every project for ONE workspace (the resolver loads
 * these candidates, then does the longest-prefix / remote-signal match in
 * TypeScript). Filters by the explicit tenancy columns (scope = "tenant"). Both
 * the table and column identifiers route through `sqlIdent`; the org/workspace
 * values route through `sLiteral` (SQL-safety floor, PRD-002b).
 */
export function buildListProjectsSql(orgId: string, workspaceId: string): string {
	const tbl = sqlIdent(PROJECTS_TABLE);
	const orgCol = sqlIdent("org_id");
	const wsCol = sqlIdent("workspace_id");
	return `SELECT * FROM "${tbl}" WHERE ${orgCol} = ${sLiteral(orgId)} AND ${wsCol} = ${sLiteral(workspaceId)}`;
}

/**
 * Build the existence probe for the reserved `__unsorted__` inbox in ONE
 * workspace (the ensure-unsorted seed reads this, then INSERTs the inbox row only
 * when it returns zero rows). Matches on the reserved `project_id` AND the
 * tenancy columns, so the inbox is seeded per `(org_id, workspace_id)`. Used by
 * the ensure-unsorted helper the daemon runs on first capture in a workspace.
 * Identifiers via `sqlIdent`; values via `sLiteral` (PRD-002b).
 */
export function buildEnsureUnsortedSelectSql(orgId: string, workspaceId: string): string {
	const tbl = sqlIdent(PROJECTS_TABLE);
	const idCol = sqlIdent("project_id");
	const orgCol = sqlIdent("org_id");
	const wsCol = sqlIdent("workspace_id");
	return (
		`SELECT ${idCol} FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(UNSORTED_PROJECT_ID)} ` +
		`AND ${orgCol} = ${sLiteral(orgId)} AND ${wsCol} = ${sLiteral(workspaceId)} LIMIT 1`
	);
}

/**
 * Build the by-id lookup for ONE project in ONE workspace (used to resolve a
 * bound `project_id` to its row, e.g. for display or to read its match rules).
 * `update-or-insert` tables resolve a key with a plain by-id SELECT (no version
 * ordering — there is one logical row per key). Identifiers via `sqlIdent`;
 * values via `sLiteral` (PRD-002b).
 */
export function buildProjectByIdSql(projectId: string, orgId: string, workspaceId: string): string {
	const tbl = sqlIdent(PROJECTS_TABLE);
	const idCol = sqlIdent("project_id");
	const orgCol = sqlIdent("org_id");
	const wsCol = sqlIdent("workspace_id");
	return (
		`SELECT * FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(projectId)} ` +
		`AND ${orgCol} = ${sLiteral(orgId)} AND ${wsCol} = ${sLiteral(workspaceId)} LIMIT 1`
	);
}
