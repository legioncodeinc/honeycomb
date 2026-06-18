/**
 * Authorization phase (007c) — THE SECURITY BOUNDARY (Wave 2, filled by
 * `retrieval-worker-bee`).
 *
 * Phase 3: re-query the `memories` table with the FULL scope before any
 * content-bearing stage runs. Takes the merged candidate pool (IDs only) and
 * returns the AUTHORIZED subset (IDs only). Every later phase (shaping, gate
 * hydration, access tracking) runs strictly on what this phase returns.
 *
 * ── The two rings (007c FR-1/FR-5) ──────────────────────────────────────────
 * Scope is two rings, enforced in this order:
 *   - OUTER: the org/workspace partition. It rides `deps.scope` →
 *     `storage.query(sql, scope)` (the storage `QueryScope`). Even a buggy inner
 *     clause cannot cross a workspace, because the partition is applied at the
 *     storage layer BENEATH the SQL (c-AC-6 / FR-5).
 *   - INNER: the within-workspace `agent_id` read-policy clause, produced by the
 *     SHARED {@link buildScopeClause} — NEVER a hand-written WHERE (c-AC-1 / FR-2).
 *
 * ── The re-query (FR-1/FR-4/FR-6) ───────────────────────────────────────────
 * One batched `SELECT id FROM memories WHERE id IN (<candidates>) AND <clause>
 * AND <caller filters>` under the partition scope. A candidate that does not come
 * back is DROPPED (FR-6). Caller filters (type/tag/project/pinned/importance/
 * date) are applied INSIDE this same authorized statement (FR-4), never as an
 * unscoped pre-filter. IDs ONLY come back — no content (the gate hydrates, 007e).
 *
 * ── Group membership (FR-3) ─────────────────────────────────────────────────
 * The `memories` engine table carries `agent_id` but NOT the agent's
 * `policy_group` (that lives on the `agents` roster). For a `group` agent this
 * phase resolves the same-`policy_group` agent ids off the roster (a scoped
 * `agents` SELECT) and passes them to {@link buildScopeClause} as `groupAgentIds`.
 * The builder renders global-from-group-peers + own; with no peers it degrades to
 * own-only (fail-closed).
 *
 * ── Fail-closed (FR-7 / c-AC-5) ─────────────────────────────────────────────
 * A malformed / missing / unresolvable agent id, or an unknown policy, yields the
 * builder's `isolated` clause + a structured {@link ScopeClauseError}. This phase
 * surfaces that error (logger + the carried context), never widening and never
 * swallowing it. The query still runs — scoped to own-only.
 *
 * ── VFS browse (FR-8 / c-AC-7) ──────────────────────────────────────────────
 * {@link authorizeBrowse} exposes the SAME clause for the explicit browse path so
 * a directory listing cannot bypass the read policy: it applies the clause before
 * any row returns.
 *
 * Reach storage via `deps.storage`; SQL via the 002b helpers (`sLiteral`,
 * `sqlLike`, `sqlIdent`) + the shared clause builder. NEVER a raw fetch, NEVER a
 * hand-quoted value — `audit:sql` scans `src/daemon`.
 */

import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import { AGENT_READ_POLICIES } from "../../storage/catalog/tenancy.js";
import type { QueryScope } from "../../storage/client.js";
import type { RecallPhaseDeps } from "./engine.js";
import type { AuthorizedContext, CallerFilters, MergedPool, RecallQuery, RecallScope } from "./contracts.js";
import { buildScopeClause, type ScopeClause } from "./scope-clause.js";

/** The engine table this boundary re-queries. */
const MEMORIES_TABLE = "memories";
const ID_COLUMN = "id";
const AGENT_ID_COLUMN = "agent_id";
const POLICY_GROUP_COLUMN = "policy_group";
const READ_POLICY_COLUMN = "read_policy";
const AGENTS_TABLE = "agents";

/** The `read_policy` token that means "group" (the only one that needs roster resolution). */
const GROUP_POLICY = "group";

/** The `memories` columns each caller filter maps onto (FR-4). */
const TYPE_COLUMN = "type";
const TAGS_COLUMN = "tags";
const PROJECT_COLUMN = "project";
const PINNED_COLUMN = "pinned";
const IMPORTANCE_COLUMN = "importance";
const CREATED_AT_COLUMN = "created_at";
/** `pinned` BIGINT encodings (catalog `memories.pinned`). */
const PINNED_TRUE = 1;
const PINNED_FALSE = 0;

/**
 * The authorized pool: the surviving candidates (IDs only) plus the
 * {@link AuthorizedContext} carrying the compiled scope clause the gate re-applies
 * when it hydrates content (e-AC-4). The pool shape is the same `MergedPool` so
 * downstream phases take a uniform input.
 */
export interface AuthorizedPool extends MergedPool {
	/** The compiled scope context content-bearing phases reuse (the clause + scope). */
	readonly context: AuthorizedContext;
}

/**
 * An authorization phase: re-query with the full scope, drop unauthorized
 * candidates, and attach the {@link AuthorizedContext}. The Wave-1 default is
 * {@link noopAuthorizationPhase}; {@link authorizationPhase} is the real boundary.
 */
export type AuthorizationPhase = (
	pool: MergedPool,
	query: RecallQuery,
	deps: RecallPhaseDeps,
) => Promise<AuthorizedPool>;

/**
 * The fail-closed no-op authorization phase the engine routes by default (Wave 1).
 *
 * It does NOT pass the pool through unauthorized: with no real re-query wired it
 * returns an EMPTY authorized set (the conservative posture — authorize nothing
 * rather than leak everything), but it STILL compiles the real scope clause via
 * the shared {@link buildScopeClause} so the {@link AuthorizedContext} is correctly
 * shaped for the gate even in the stub. The real re-query is
 * {@link authorizationPhase}, injected via `createRecallEngine({ authorization })`.
 */
export const noopAuthorizationPhase: AuthorizationPhase = async (
	_pool: MergedPool,
	query: RecallQuery,
	_deps: RecallPhaseDeps,
): Promise<AuthorizedPool> => {
	const clause = buildScopeClause({
		agentId: query.scope.agentId,
		readPolicy: query.scope.readPolicy,
		policyGroup: query.scope.policyGroup,
		org: query.scope.org,
		workspace: query.scope.workspace,
	});
	return {
		candidates: [],
		degraded: _pool.degraded,
		context: { clause, scope: query.scope },
	};
};

/** The org/workspace partition (the outer ring) a re-query runs under. */
function partitionScope(scope: RecallScope): QueryScope {
	return { org: scope.org, workspace: scope.workspace };
}

/**
 * Build the roster lookup that resolves the same-`policy_group` member agent ids
 * for a `group` agent (FR-3). Runs against the `agents` roster, scoped to the
 * partition via the storage `QueryScope`. Matches agents in the SAME
 * `policy_group` whose own `read_policy` is `group` (a peer in the group), and
 * returns their `agent_id`s ONLY. Every value routes through `sLiteral`; every
 * identifier through `sqlIdent` (the endpoint binds no params).
 *
 * Pure: takes the policy group and returns SQL. A blank policy group yields a
 * statement that matches nothing (the empty-group degrade is handled by the
 * caller, which never calls this for a blank group).
 */
export function buildGroupMembersSql(policyGroup: string): string {
	const tbl = sqlIdent(AGENTS_TABLE);
	const idCol = sqlIdent(ID_COLUMN);
	const groupCol = sqlIdent(POLICY_GROUP_COLUMN);
	const policyCol = sqlIdent(READ_POLICY_COLUMN);
	return (
		`SELECT ${idCol} AS id ` +
		`FROM "${tbl}" ` +
		`WHERE ${groupCol} = ${sLiteral(policyGroup)} AND ${policyCol} = ${sLiteral(GROUP_POLICY)}`
	);
}

/**
 * Resolve the same-`policy_group` member agent ids off the `agents` roster (FR-3),
 * scoped to the partition. Returns the member ids (deduped, blanks dropped). Only
 * meaningful for a `group` agent; the caller skips this for any other policy. On a
 * non-`ok` roster query, returns `[]` → the group degrades to own-only
 * (fail-closed, never wider).
 */
export async function resolveGroupMembers(
	scope: RecallScope,
	deps: RecallPhaseDeps,
): Promise<string[]> {
	if (scope.policyGroup.trim() === "") return [];
	const result = await deps.storage.query(buildGroupMembersSql(scope.policyGroup), partitionScope(scope));
	if (!isOk(result)) {
		deps.logger?.event("recall.authz_group_resolve_failed", {
			org: scope.org,
			workspace: scope.workspace,
			policyGroup: scope.policyGroup,
			kind: result.kind,
		});
		return [];
	}
	const seen = new Set<string>();
	for (const row of result.rows as StorageRow[]) {
		const id = String(row.id ?? "").trim();
		if (id !== "") seen.add(id);
	}
	return [...seen];
}

/**
 * Build the `AND <col> = ...` conjuncts for the caller filters (FR-4). Each is
 * applied INSIDE the authorized re-query, never as an unscoped pre-filter. Values
 * route through `sLiteral` / `sqlLike`; identifiers through `sqlIdent`; numeric
 * encodings (pinned 0/1) inline as numbers. An absent filter contributes nothing.
 *
 * - `type` / `project`     → exact `=` match.
 * - `tag`                  → JSON-array substring match (`tags::text ILIKE '%"tag"%'`),
 *                            the tag escaped for both the literal AND the LIKE wildcards.
 * - `pinned`               → `pinned = 1` (true) or `pinned = 0` (false), the BIGINT flag.
 * - `minImportance`        → `importance >= <n>` (a finite numeric inline).
 * - `createdAfter/Before`  → ISO `created_at` text range (`>=` / `<=`).
 *
 * Pure: takes the filters and returns a SQL fragment (possibly empty).
 */
export function buildFilterConjuncts(filters: CallerFilters | undefined): string {
	if (filters === undefined) return "";
	const parts: string[] = [];

	if (filters.type !== undefined && filters.type !== "") {
		parts.push(`AND ${sqlIdent(TYPE_COLUMN)} = ${sLiteral(filters.type)}`);
	}
	if (filters.project !== undefined && filters.project !== "") {
		parts.push(`AND ${sqlIdent(PROJECT_COLUMN)} = ${sLiteral(filters.project)}`);
	}
	if (filters.tag !== undefined && filters.tag !== "") {
		// `tags` is a JSON array TEXT column (default '[]'); match the quoted token as a
		// substring. `sqlLike` escapes the value AND its `%`/`_`, so the tag cannot inject
		// a wildcard or close the literal early.
		const tagPattern = `'%"${sqlLike(filters.tag)}"%'`;
		parts.push(`AND ${sqlIdent(TAGS_COLUMN)}::text ILIKE ${tagPattern}`);
	}
	if (filters.pinned !== undefined) {
		const flag = filters.pinned ? PINNED_TRUE : PINNED_FALSE;
		parts.push(`AND ${sqlIdent(PINNED_COLUMN)} = ${flag}`);
	}
	if (filters.minImportance !== undefined && Number.isFinite(filters.minImportance)) {
		// Clamp to [0,1] (the importance range) and inline as a finite numeric literal.
		const bound = Math.min(1, Math.max(0, filters.minImportance));
		parts.push(`AND ${sqlIdent(IMPORTANCE_COLUMN)} >= ${bound}`);
	}
	if (filters.createdAfter !== undefined && filters.createdAfter !== "") {
		parts.push(`AND ${sqlIdent(CREATED_AT_COLUMN)} >= ${sLiteral(filters.createdAfter)}`);
	}
	if (filters.createdBefore !== undefined && filters.createdBefore !== "") {
		parts.push(`AND ${sqlIdent(CREATED_AT_COLUMN)} <= ${sLiteral(filters.createdBefore)}`);
	}

	return parts.join(" ");
}

/**
 * Build the `id IN (<candidate ids>)` constraint (FR-1). Every id routes through
 * `sLiteral`; the column through `sqlIdent`. Blank ids are dropped. With no usable
 * ids the function returns `null` — the caller short-circuits to an EMPTY
 * authorized set rather than emitting an `IN ()` that the engine rejects.
 *
 * Pure: takes the ids and returns the `id IN (...)` fragment, or `null`.
 */
export function buildCandidateInClause(candidateIds: readonly string[]): string | null {
	const usable = [...new Set(candidateIds.filter((id) => id.trim() !== ""))];
	if (usable.length === 0) return null;
	const inList = usable.map((id) => sLiteral(id)).join(", ");
	return `${sqlIdent(ID_COLUMN)} IN (${inList})`;
}

/**
 * Build the authorized re-query SQL (FR-1/FR-4): `SELECT id FROM memories WHERE
 * <id IN candidates> AND <scope clause> AND <caller filters>`. IDs ONLY — no
 * content column (the gate hydrates, 007e). The clause's `sql` is the
 * parenthesized read-policy fragment from {@link buildScopeClause}; the caller
 * filters are appended INSIDE the same WHERE. Returns `null` when there are no
 * usable candidate ids (the caller returns an empty authorized set).
 *
 * Pure: takes the candidate ids, the compiled clause, and the filters; returns SQL.
 */
export function buildAuthorizationSql(args: {
	readonly candidateIds: readonly string[];
	readonly clause: ScopeClause;
	readonly filters: CallerFilters | undefined;
}): string | null {
	const inClause = buildCandidateInClause(args.candidateIds);
	if (inClause === null) return null;
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent(ID_COLUMN);
	const conjuncts = buildFilterConjuncts(args.filters);
	const filterSql = conjuncts === "" ? "" : ` ${conjuncts}`;
	return (
		`SELECT ${idCol} AS id ` +
		`FROM "${tbl}" ` +
		`WHERE ${inClause} AND ${args.clause.sql}${filterSql}`
	);
}

/** Project an authorized re-query result into the surviving id set (IDs only). */
function survivingIds(result: QueryResult): Set<string> {
	const survivors = new Set<string>();
	if (!isOk(result)) return survivors;
	for (const row of result.rows as StorageRow[]) {
		const id = String(row.id ?? "");
		if (id !== "") survivors.add(id);
	}
	return survivors;
}

/**
 * Compile the read-policy clause for a request, resolving group membership first
 * (FR-3). Returns the {@link ScopeClause} (the auth chokepoint output) and the
 * resolved member ids. A `group` agent gets its same-`policy_group` peers
 * resolved off the roster; every other policy resolves no members. A malformed
 * agent or unknown policy fails closed inside {@link buildScopeClause} (FR-7).
 */
export async function compileRequestClause(
	scope: RecallScope,
	deps: RecallPhaseDeps,
): Promise<{ clause: ScopeClause; groupAgentIds: string[] }> {
	const isGroup =
		scope.readPolicy === GROUP_POLICY && (AGENT_READ_POLICIES as readonly string[]).includes(GROUP_POLICY);
	const groupAgentIds = isGroup ? await resolveGroupMembers(scope, deps) : [];
	const clause = buildScopeClause({
		agentId: scope.agentId,
		readPolicy: scope.readPolicy,
		policyGroup: scope.policyGroup,
		groupAgentIds,
		org: scope.org,
		workspace: scope.workspace,
	});
	return { clause, groupAgentIds };
}

/**
 * The authorization boundary (007c) — the real {@link AuthorizationPhase}.
 *
 * 1. Compile the read-policy clause via {@link buildScopeClause}, resolving group
 *    membership off the `agents` roster for a `group` agent (FR-3). A malformed
 *    agent / unknown policy fails closed to `isolated` + a structured error (FR-7)
 *    surfaced via the logger and carried on the context.
 * 2. Re-query `memories` for `id IN (<candidates>) AND <clause> AND <caller
 *    filters>` under the org/workspace PARTITION (FR-1/FR-4/FR-5). IDs only.
 * 3. Drop every candidate that did not survive (FR-6); keep the merged pool's
 *    per-channel scores + provenance for the survivors so shaping still has the
 *    evidence.
 * 4. Attach the {@link AuthorizedContext} (clause + scope) so the gate re-applies
 *    the SAME clause when it hydrates (e-AC-4).
 *
 * Never throws for an authorization outcome: an empty pool, an empty candidate
 * set, or a failed re-query all yield an EMPTY authorized set — fail-closed,
 * authorize nothing rather than leak.
 */
export const authorizationPhase: AuthorizationPhase = async (
	pool: MergedPool,
	query: RecallQuery,
	deps: RecallPhaseDeps,
): Promise<AuthorizedPool> => {
	const scope = query.scope;
	const { clause } = await compileRequestClause(scope, deps);
	const context: AuthorizedContext = { clause, scope };

	// Surface a fail-closed event so a malformed/unknown caller is observable, never
	// swallowed (FR-7 / c-AC-5). The clause is already the safe isolated fragment.
	if (clause.error !== undefined) {
		deps.logger?.event("recall.authz_fail_closed", {
			org: clause.error.org,
			workspace: clause.error.workspace,
			agentId: clause.error.agentId,
			policy: clause.error.policy,
			reason: clause.error.reason,
			route: "recall",
		});
	}

	const candidateIds = pool.candidates.map((c) => c.id);
	const sql = buildAuthorizationSql({ candidateIds, clause, filters: query.filters });
	if (sql === null) {
		// No usable candidate ids → nothing to authorize → empty (valid) set.
		return { candidates: [], degraded: pool.degraded, context };
	}

	const result = await deps.storage.query(sql, partitionScope(scope));
	const survivors = survivingIds(result);

	// Drop every candidate that did not survive the scoped re-query (FR-6), preserving
	// per-channel scores + provenance for the survivors so shaping keeps the evidence.
	const authorized = pool.candidates.filter((c) => survivors.has(c.id));
	return { candidates: authorized, degraded: pool.degraded, context };
};

/**
 * The VFS browse authorization (FR-8 / c-AC-7). The explicit browse path lists
 * rows directly; it MUST apply the SAME read-policy clause before any row returns,
 * so a directory listing cannot bypass the policy a scored recall enforces.
 *
 * Builds `SELECT id FROM memories WHERE <scope clause> AND <caller filters>`
 * under the partition — the same clause builder, the same partition ring, IDs
 * only. There is no candidate-id `IN (...)` because browse enumerates the
 * authorized set rather than filtering a pre-collected pool. Returns SQL; the raw
 * `<#>`/content load is NOT done here (browse content hydration goes through the
 * same gate-style scoped read).
 *
 * Pure: takes the compiled clause + filters and returns SQL.
 */
export function buildBrowseAuthorizationSql(args: {
	readonly clause: ScopeClause;
	readonly filters?: CallerFilters;
}): string {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const idCol = sqlIdent(ID_COLUMN);
	const conjuncts = buildFilterConjuncts(args.filters);
	const filterSql = conjuncts === "" ? "" : ` ${conjuncts}`;
	return `SELECT ${idCol} AS id FROM "${tbl}" WHERE ${args.clause.sql}${filterSql}`;
}

/**
 * Authorize a VFS browse request (FR-8 / c-AC-7): resolve + compile the SAME scope
 * clause, run the browse SELECT under the partition, and return the authorized
 * row ids ONLY — before any content is returned. A browse path that skipped this
 * would be a read-policy bypass; routing it through the one clause builder keeps
 * the boundary auditable (scoping review = a search for `buildScopeClause`).
 *
 * Returns the authorized id list and the compiled clause (so a caller can reuse it
 * for the scoped content load). On a non-`ok` query, returns an empty id list —
 * fail-closed.
 */
export async function authorizeBrowse(
	scope: RecallScope,
	deps: RecallPhaseDeps,
	filters?: CallerFilters,
): Promise<{ ids: string[]; clause: ScopeClause }> {
	const { clause } = await compileRequestClause(scope, deps);
	if (clause.error !== undefined) {
		deps.logger?.event("recall.authz_fail_closed", {
			org: clause.error.org,
			workspace: clause.error.workspace,
			agentId: clause.error.agentId,
			policy: clause.error.policy,
			reason: clause.error.reason,
			route: "vfs-browse",
		});
	}
	const sql = buildBrowseAuthorizationSql({ clause, filters });
	const result = await deps.storage.query(sql, partitionScope(scope));
	const ids = [...survivingIds(result)];
	return { ids, clause };
}
