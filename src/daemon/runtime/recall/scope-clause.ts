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

/** The engine table's scope columns this clause filters on. */
const AGENT_ID_COLUMN = "agent_id";
const VISIBILITY_COLUMN = "visibility";
const IS_DELETED_COLUMN = "is_deleted";
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
