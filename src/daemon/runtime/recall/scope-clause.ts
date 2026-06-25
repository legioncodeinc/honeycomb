/**
 * The shared ScopeClauseBuilder — THE authorization chokepoint (PRD-007c
 * FR-2/FR-3, D-7). Built in Wave 1 so 007c authorization, 007e hydration, the VFS
 * browse surface, AND the live re-query tests ALL reuse ONE clause builder.
 *
 * ── Why one chokepoint (007c FR-2 / implementation notes) ───────────────────
 * The DeepLake query endpoint binds no parameters, so every memory query
 * hand-interpolates its WHERE clause. If each call site wrote its own read-policy
 * SQL, a scoping review would be an audit of every hand-written WHERE. Instead,
 * EVERY memory query routes its read-policy fragment through {@link buildScopeClause}.
 * A scoping review then becomes a search for this one builder: a new code path
 * either carries the clause or it does not.
 *
 * ── The two rings (007c scope) ──────────────────────────────────────────────
 * Scope is two rings. The OUTER ring — the org/workspace partition — is enforced
 * BENEATH this clause at the storage layer via the {@link import("../../storage/client.js").QueryScope}
 * every `storage.query(sql, scope)` carries (007c FR-5): even a buggy inner clause
 * cannot cross a workspace boundary (c-AC-6). This builder produces the INNER ring
 * — the within-workspace `agent_id` read-policy clause — as a WHERE fragment over
 * the engine table's scope columns (`agent_id`, `visibility`), ANDed with the
 * archived-exclusion. The caller ANDs this fragment into its statement and runs it
 * under the partition scope.
 *
 * ── The three policies (007c FR-3 / D-7) ────────────────────────────────────
 *   - `isolated`  own memories only            → `agent_id = '<self>'`
 *   - `shared`    workspace-global + own       → `visibility = 'global' OR agent_id = '<self>'`
 *   - `group`     same-policy_group global+own → global from same-group agents + own
 *
 * ALL THREE exclude archived memories (007c FR-3). On the `memories` engine table,
 * "archived" is the soft-delete flag `is_deleted = 1` ({@link import("../../storage/catalog/memories.js").SOFT_DELETED}),
 * so every clause ANDs `is_deleted = 0`.
 *
 * NOTE on `group`: the `memories` engine table carries `agent_id` but not the
 * agent's `policy_group` (that lives on the `agents` roster). Resolving the
 * same-group agent set is a roster lookup the CALLER performs (007c resolves the
 * group membership and passes the resolved `groupAgentIds`); this builder renders
 * the membership it is GIVEN into the clause. When no group members are resolved,
 * `group` degrades to own-only — fail-closed, never wider.
 *
 * ── Fail-closed (007c FR-7 / D-7 / c-AC-5) ──────────────────────────────────
 * A malformed / missing / unresolvable agent id, OR an unknown read policy, falls
 * back to the `isolated` fragment AND surfaces a structured {@link ScopeClauseError}
 * (org, workspace, agentId, policy, reason) on the returned clause — NEVER a wider
 * policy, NEVER a swallowed failure. The caller logs the error context; the SQL it
 * gets is already the safe isolated fragment.
 *
 * ── SQL safety (007c FR-2 / PRD-002b) ───────────────────────────────────────
 * Every interpolated value (agent id, group member ids, visibility token) routes
 * through `sLiteral`; every column identifier through `sqlIdent`. `audit:sql`
 * scans `src/daemon` and this module passes it. The built fragment is a string
 * `sql` plus the `values` it interpolated (for auditability), never bound params
 * (the endpoint has none).
 *
 * ── No-touch (CONVENTIONS §shared) ──────────────────────────────────────────
 * This is a Wave-1 shared file. Wave-2 phases CONSUME `buildScopeClause`; they do
 * NOT edit it. A new policy is a Wave-1 change here, behind the same fail-closed
 * default.
 */

import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { UNSORTED_PROJECT_ID } from "../../storage/catalog/projects.js";

/** The engine table's scope columns this clause filters on. */
const AGENT_ID_COLUMN = "agent_id";
const VISIBILITY_COLUMN = "visibility";
const IS_DELETED_COLUMN = "is_deleted";
/**
 * PRD-049b: the RESOLVED registry key column the project segment filters on (additive,
 * beside `agent_id`/`visibility`). The free-text `project` column (a raw cwd path, D5) is
 * NOT this — that is display metadata; `project_id` is the resolved registry key.
 */
const PROJECT_ID_COLUMN = "project_id";
/**
 * The sentinel for a row carrying NO resolved project (the column DEFAULT '' — a legacy
 * row written before 049b, or a workspace-global row). Per D5 these resolve to the inbox
 * at read time and are admitted alongside both a bound project and the inbox so back-compat
 * recall never silently drops the pre-049b corpus.
 */
const PROJECT_ID_UNSET = "";
/**
 * PRD-049c: the EXPLICIT cross-project promotion tokens. A skills row whose promotion column
 * holds one of these surfaces in ANY of the user's projects (49c-AC-2), so the project-segment
 * predicate ADMITS it in addition to the session's own project + the inbox. The mine/pull default
 * `'none'` is NOT admitted by the promotion arm — a `none` row is governed purely by its
 * `project_id` (49c-AC-1 isolation). Only set on the `skills` table; memory/session recall passes
 * no `promotionColumn` and this list is unused there.
 */
const CROSS_PROJECT_ADMITTED = Object.freeze(["user", "workspace"] as const);
/** The `visibility` token that marks a workspace-global memory (catalog default). */
const VISIBILITY_GLOBAL = "global";
/** Soft-delete encodings (catalog `memories.is_deleted`, BIGINT 0/1). Archived = 1. */
const NOT_ARCHIVED = 0;

/** The three read policies this builder implements (007c FR-3 / D-7). */
export const SCOPE_READ_POLICIES = Object.freeze(["isolated", "shared", "group"] as const);
/** One read policy. */
export type ScopeReadPolicy = (typeof SCOPE_READ_POLICIES)[number];

/** Narrow an arbitrary string to a known read policy (else `null` → fail-closed). */
export function asReadPolicy(raw: string): ScopeReadPolicy | null {
	return (SCOPE_READ_POLICIES as readonly string[]).includes(raw) ? (raw as ScopeReadPolicy) : null;
}

/**
 * The structured failure a fail-closed clause carries (007c FR-7 / c-AC-5). Not
 * thrown — attached to the returned clause so the caller gets the SAFE isolated
 * SQL AND the context to log. Carrying it (rather than throwing) is what lets the
 * boundary fail closed without a swallowed catch: the query still runs, scoped to
 * own-only.
 */
export interface ScopeClauseError {
	/** The org the request was scoped to (for the structured log). */
	readonly org: string;
	/** The workspace the request was scoped to. */
	readonly workspace: string;
	/** The agent id as received (may be blank/malformed — that's the point). */
	readonly agentId: string;
	/** The read policy as received (may be unknown). */
	readonly policy: string;
	/** Why the builder fell back to `isolated`. */
	readonly reason: string;
}

/**
 * A compiled read-policy clause — the auth chokepoint's output (007c FR-2). `sql`
 * is the WHERE fragment (NO leading `WHERE`/`AND`; the caller composes it). The
 * fragment is fully parenthesized so it ANDs safely into any statement. `values`
 * lists every value interpolated (for auditability/tests). `policyApplied` is the
 * policy actually rendered (may be `isolated` even when a wider one was requested,
 * if the builder failed closed). `error` is present iff the builder failed closed.
 */
export interface ScopeClause {
	/** The parenthesized WHERE fragment (no leading `WHERE`/`AND`). */
	readonly sql: string;
	/** Every value interpolated into the fragment, for auditability. */
	readonly values: string[];
	/** The policy actually rendered (may differ from requested when fail-closed). */
	readonly policyApplied: ScopeReadPolicy;
	/** Present iff the builder fell back to `isolated` (fail-closed); structured context. */
	readonly error?: ScopeClauseError;
}

/** Inputs to {@link buildScopeClause}. */
export interface ScopeClauseInput {
	/** The within-workspace agent id the clause scopes to. Blank/malformed → fail closed. */
	readonly agentId: string;
	/** The agent's read policy. Unknown → fail closed to `isolated`. */
	readonly readPolicy: string;
	/** The agent's policy group (only meaningful for `group`). */
	readonly policyGroup?: string;
	/**
	 * The resolved member agent ids for a `group` policy (the caller resolves group
	 * membership off the `agents` roster and passes it in). Empty/absent for a
	 * `group` policy → that policy degrades to own-only (fail-closed, never wider).
	 */
	readonly groupAgentIds?: readonly string[];
	/** The org, for the fail-closed structured error context. */
	readonly org?: string;
	/** The workspace, for the fail-closed structured error context. */
	readonly workspace?: string;
}

/** A bare-identifier agent id must be non-empty and free of SQL-hostile shapes. */
function isUsableAgentId(agentId: string): boolean {
	// A blank or whitespace-only agent id is unresolvable → fail closed. (Non-blank
	// values are still escaped via `sLiteral`; this guard catches the missing-id
	// case the FR calls out, not an injection — escaping covers that.)
	return agentId.trim() !== "";
}

/** The archived-exclusion conjunct every policy carries (007c FR-3). */
function notArchivedSql(): string {
	// `is_deleted` is a BIGINT 0/1 numeric column; the constant is a numeric literal
	// (NOT_ARCHIVED), inlined as a number — no value escaping applies to numbers.
	return `${sqlIdent(IS_DELETED_COLUMN)} = ${NOT_ARCHIVED}`;
}

/** The own-only predicate (`agent_id = '<self>'`), shared by every policy. */
function ownSql(agentId: string): string {
	return `${sqlIdent(AGENT_ID_COLUMN)} = ${sLiteral(agentId)}`;
}

/** Build the fail-closed `isolated` clause (own non-archived only). */
function isolatedClause(agentId: string, error?: ScopeClauseError): ScopeClause {
	const sql = `(${ownSql(agentId)} AND ${notArchivedSql()})`;
	const base: ScopeClause = { sql, values: [agentId], policyApplied: "isolated" };
	return error === undefined ? base : { ...base, error };
}

/**
 * Build the read-policy WHERE fragment — THE authorization chokepoint (007c
 * FR-2/FR-3, D-7). Returns a {@link ScopeClause} the caller ANDs into its memory
 * query. Fail-closed: a malformed/missing agent id or an unknown policy yields the
 * `isolated` fragment plus a structured {@link ScopeClauseError}, never a wider
 * policy (c-AC-5).
 *
 * The three policies (all exclude archived):
 *   - `isolated`: `agent_id = '<self>'`
 *   - `shared`:   `visibility = 'global' OR agent_id = '<self>'`
 *   - `group`:    `(visibility = 'global' AND agent_id IN (<group members>)) OR agent_id = '<self>'`
 *
 * For `group` with no resolved members, the global arm is empty, so the clause
 * degrades to own-only — fail-closed, never wider.
 */
export function buildScopeClause(input: ScopeClauseInput): ScopeClause {
	const agentId = input.agentId ?? "";
	const org = input.org ?? "";
	const workspace = input.workspace ?? "";

	// Fail-closed gate 1: an unusable (blank/whitespace) agent id → isolated + error.
	if (!isUsableAgentId(agentId)) {
		return isolatedClause(agentId, {
			org,
			workspace,
			agentId,
			policy: input.readPolicy,
			reason: "missing or malformed agent id",
		});
	}

	// Fail-closed gate 2: an unknown read policy → isolated + error.
	const policy = asReadPolicy(input.readPolicy);
	if (policy === null) {
		return isolatedClause(agentId, {
			org,
			workspace,
			agentId,
			policy: input.readPolicy,
			reason: `unknown read policy "${input.readPolicy}"`,
		});
	}

	const archived = notArchivedSql();
	const own = ownSql(agentId);

	if (policy === "isolated") {
		return { sql: `(${own} AND ${archived})`, values: [agentId], policyApplied: "isolated" };
	}

	if (policy === "shared") {
		// Workspace-global OR own, all non-archived.
		const globalSql = `${sqlIdent(VISIBILITY_COLUMN)} = ${sLiteral(VISIBILITY_GLOBAL)}`;
		const sql = `((${globalSql} OR ${own}) AND ${archived})`;
		return { sql, values: [VISIBILITY_GLOBAL, agentId], policyApplied: "shared" };
	}

	// policy === "group": global from same-policy_group agents + own, archived excluded.
	const members = (input.groupAgentIds ?? []).filter((m) => m.trim() !== "");
	if (members.length === 0) {
		// No resolved group members → the global arm is empty → degrade to own-only.
		// Fail-closed (never wider) but NOT an error: an isolated-shaped group with no
		// peers is a legitimate state, surfaced as own-only rather than a structured error.
		return {
			sql: `(${own} AND ${archived})`,
			values: [agentId],
			policyApplied: "group",
		};
	}

	const globalCol = sqlIdent(VISIBILITY_COLUMN);
	const inList = members.map((m) => sLiteral(m)).join(", ");
	const groupGlobalSql = `(${globalCol} = ${sLiteral(VISIBILITY_GLOBAL)} AND ${sqlIdent(AGENT_ID_COLUMN)} IN (${inList}))`;
	const sql = `((${groupGlobalSql} OR ${own}) AND ${archived})`;
	return {
		sql,
		values: [VISIBILITY_GLOBAL, ...members, agentId],
		policyApplied: "group",
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-049b — the project-segment predicate (the SECOND inner-ring clause)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A compiled project-segment WHERE fragment — the 049b sibling of {@link ScopeClause}
 * (PRD-049b 49b-AC-2). `sql` is a parenthesized fragment (NO leading `WHERE`/`AND`; the
 * caller ANDs it beside the {@link buildScopeClause} agent clause). `values` lists every
 * interpolated value for auditability. `bound` echoes whether the session resolved a real
 * project (vs the unbound inbox fallback) so a caller can surface the D8 degraded-scoping
 * warning. This is exported + cleanly factored so PRD-049c REUSES it verbatim for skills.
 */
export interface ProjectScopeClause {
	/** The parenthesized WHERE fragment (no leading `WHERE`/`AND`). */
	readonly sql: string;
	/** Every value interpolated into the fragment, for auditability. */
	readonly values: string[];
	/** True when the session resolved a real bound project; false for the inbox fallback (D8). */
	readonly bound: boolean;
}

/** Inputs to {@link buildProjectScopeClause}. */
export interface ProjectScopeInput {
	/**
	 * The session's RESOLVED project id (PRD-049a `resolveScope(cwd).projectId`). The
	 * reserved {@link UNSORTED_PROJECT_ID} (or a blank id) is the UNBOUND inbox session
	 * (D8 / 49b-AC-3): recall narrows to inbox + workspace-global only, never another
	 * project. Any other value is a bound project (49b-AC-2).
	 */
	readonly projectId: string;
	/**
	 * Whether the session resolved a REAL project (PRD-049a `resolveScope(cwd).bound`).
	 * Defaults to inferring from `projectId` (a non-blank, non-`__unsorted__` id is bound)
	 * so a caller can pass just the id. Carried onto the result for the D8 warning surface.
	 */
	readonly bound?: boolean;
	/** The column the predicate filters on. Defaults to `project_id`; 049c may pass the skill table's column. */
	readonly projectColumn?: string;
	/**
	 * PRD-049c (49c-AC-2): the OPTIONAL cross-project promotion column on the `skills` table
	 * (`cross_project_scope`). When provided, the disjunction ADMITS — in ADDITION to the session's
	 * project + the inbox/unset rows — any row whose promotion column is an explicit cross-project
	 * reach (`user` / `workspace`), so a promoted skill surfaces in ANY of the user's projects. When
	 * ABSENT (memory/session recall, 049b), the predicate is byte-for-byte 049b's project-only segment
	 * — promotion is a skills-only concern. The mine/pull default `'none'` is never admitted by this
	 * arm, so an unpromoted skill stays isolated to its `project_id` (49c-AC-1).
	 */
	readonly promotionColumn?: string;
}

/**
 * Build the project-segment WHERE fragment — the SECOND inner-ring clause beside the
 * {@link buildScopeClause} agent_id/visibility clause (PRD-049b 49b-AC-2 / 49b-AC-4).
 * Project is an ADDITIONAL predicate, NOT a replacement: the caller ANDs both fragments,
 * so a row must pass BOTH the agent read policy AND the project segment to be visible.
 *
 * The fragment ADMITS exactly:
 *   - the session's resolved `project_id` (a bound session sees its own project), AND
 *   - the workspace `__unsorted__` inbox — ONLY for an UNBOUND session (49b-AC-3); a BOUND
 *     session does NOT see the inbox (its captures landed in the real project), AND
 *   - rows with an UNSET `project_id` (`''`) — legacy pre-049b rows + workspace-global rows
 *     that resolve to the inbox at read (D5), so back-compat recall never drops the prior corpus.
 * It EXCLUDES every OTHER project's `project_id` — even on a strong vector / high-degree-entity
 * hit (49b-AC-2): this fragment is ANDed into the SAME statement as the match, so an
 * authorized-id channel can surface an id but the content is filtered past this predicate.
 *
 *   - BOUND session in project P → `(project_id = 'P' OR project_id = '')`
 *   - UNBOUND session            → `(project_id = '__unsorted__' OR project_id = '')`
 *
 * ── PRD-049c — the cross-project promotion arm (49c-AC-2) ────────────────────
 * When `promotionColumn` is supplied (the `skills` table's `cross_project_scope`), the
 * disjunction ALSO admits any row whose promotion column is an explicit cross-project reach
 * (`user` / `workspace`), so an EXPLICITLY-promoted skill surfaces in ANY of the user's
 * projects in ADDITION to the project-segment rows above. The mine/pull default `'none'` is
 * NOT admitted by this arm, so an unpromoted skill stays isolated to its `project_id`
 * (49c-AC-1). When `promotionColumn` is absent (memory/session recall), the clause is
 * byte-for-byte 049b's project-only segment.
 *
 *   - BOUND skills session in P (promotion-aware) →
 *       `(project_id = 'P' OR project_id = '' OR cross_project_scope = 'user' OR cross_project_scope = 'workspace')`
 *
 * SQL-safe: the column routes through `sqlIdent`, every value through `sLiteral` (the
 * 002b floor; `audit:sql` scans `src/daemon`). Pure — no IO, never throws.
 */
export function buildProjectScopeClause(input: ProjectScopeInput): ProjectScopeClause {
	const projectColumn = input.projectColumn ?? PROJECT_ID_COLUMN;
	const rawId = input.projectId ?? "";
	// A blank or reserved-inbox id is the UNBOUND session; default `bound` from the id but
	// honor an explicit override (the resolver's authoritative `bound` flag).
	const isInbox = rawId.trim() === "" || rawId === UNSORTED_PROJECT_ID;
	const bound = input.bound ?? !isInbox;

	const col = sqlIdent(projectColumn);
	// The admitted project id: a bound session admits its real project; an unbound session
	// admits the reserved inbox. Either way, the UNSET sentinel ('') is ALSO admitted (D5
	// workspace-global / legacy rows). De-duped so a redundant `OR x OR x` is never emitted.
	const primaryId = bound ? rawId : UNSORTED_PROJECT_ID;
	const admitted = primaryId === PROJECT_ID_UNSET ? [PROJECT_ID_UNSET] : [primaryId, PROJECT_ID_UNSET];
	const disjuncts = admitted.map((id) => `${col} = ${sLiteral(id)}`);
	const values = [...admitted];

	// PRD-049c (49c-AC-2): admit explicitly-promoted skills in ANY of the user's projects. This
	// arm is ADDED ONLY when the caller passes a `promotionColumn` (the skills surfacing path); the
	// memory/session recall path passes none, so its predicate is unchanged (49b). `none` is never
	// admitted here — isolation (49c-AC-1) is preserved for unpromoted rows.
	if (input.promotionColumn !== undefined && input.promotionColumn !== "") {
		const promoCol = sqlIdent(input.promotionColumn);
		for (const reach of CROSS_PROJECT_ADMITTED) {
			disjuncts.push(`${promoCol} = ${sLiteral(reach)}`);
			values.push(reach);
		}
	}

	const sql = `(${disjuncts.join(" OR ")})`;
	return { sql, values, bound };
}

/**
 * Build the project-segment conjuncts as a {@link import("../../storage/vector.js").VectorScopeFilter}-style
 * AND fragment for the INLINE vector/hybrid path (49b-AC-2). The `<#>` vector search
 * (`vector.ts` `buildVectorSearchSql`) and the native hybrid operator take their scope as
 * extra ` AND <col> = '<val>'` conjuncts in the SAME statement — but the project segment is a
 * DISJUNCTION (project OR unset), so it cannot ride the single-equality `VectorScopeFilter`.
 * This returns the parenthesized `AND (…)` fragment a builder appends verbatim after its
 * own WHERE, keeping the project filter in the same round trip as the cosine match so a
 * strong vector hit is filtered BEFORE any id leaves the engine (49b-AC-2). Empty string is
 * never returned — the predicate always constrains.
 */
export function buildProjectScopeConjunct(input: ProjectScopeInput): string {
	return ` AND ${buildProjectScopeClause(input).sql}`;
}
