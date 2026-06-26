/**
 * The shared spend-ledger writer + roster resolution + scoped read — PRD-060f
 * (f-AC-1 .. f-AC-13).
 *
 * This module owns the WRITE PATH for the two new tenant-scoped tables defined in
 * `storage/catalog/tenancy.ts` (`roi_metrics`, append-only; `teams`, version-bumped)
 * plus the `read_policy`-governed LOCAL read of `roi_metrics` (060e consumes it). It
 * does NOT compute cents — 060b/060c/060d produce the measured/modeled/allocated
 * money and this writer ACCEPTS them as integer-cent inputs (f-AC-4).
 *
 * ── Append-only, re-price by append, never UPDATE (f-AC-2/f-AC-3) ─────────────
 * {@link appendRoiMetric} writes exactly ONE immutable row per call via
 * `appendOnlyInsert`. A re-price is another call with a new `price_ref`; both rows
 * persist under the same `session_id` and the read resolves the canonical row by
 * `MAX(created_at)`. There is NO mutate path in this module — it never emits UPDATE
 * or DELETE.
 *
 * ── The per-user gate (f-AC-6/f-AC-7) — the central constraint ────────────────
 * `user_id` is set ONLY when `verifiedClaim?.source === 'backend-token'`, `''`
 * otherwise. The gate {@link resolveGatedUserId} NEVER consults git-email, `$USER`,
 * OS-login, or any client-asserted identity — those are trivially spoofable and would
 * poison a cross-org leaderboard. The verified claim does not exist today, so in
 * practice every `user_id` is `''`. There is no historical backfill: a row written
 * before a claim lands keeps `user_id = ''` forever.
 *
 * ── team_id resolved at write time (f-AC-9) ──────────────────────────────────
 * {@link resolveTeamId} looks the writing `agent_id` up in the `teams` roster and
 * stamps the resolved `team_id` onto the row; an unassigned agent resolves to `''`.
 * It is fail-soft: any storage error / absent table resolves to `''` and NEVER throws,
 * so a missing roster never blocks an ROI write.
 *
 * ── Additive-heal + degrade-not-throw (f-AC-10) ──────────────────────────────
 * Both tables heal additively (every NOT NULL column carries a DEFAULT). The writer
 * routes through `appendOnlyInsert`/`appendVersionBumped` (heal-aware via `withHeal`).
 * The read {@link readRoiMetrics} DEGRADES to `{ status: "shared-ledger-absent" }`
 * when the table/column is missing rather than throwing — the daemon boots either way.
 *
 * ── SQL-guarded under the active QueryScope (f-AC-11) ────────────────────────
 * Every interpolated value routes through the `writes.ts` `val.*` constructors (which
 * render via `sLiteral`/`eLiteral`) or through `sLiteral`/`sqlIdent` directly. No raw
 * string interpolation reaches the query, and every statement runs under the caller's
 * `QueryScope` (the org/workspace partition outer ring).
 *
 * ── read_policy-scoped local read (f-AC-13) ──────────────────────────────────
 * {@link readRoiMetrics} scopes the local read through `read_policy`: `isolated`
 * returns only the requesting agent's own rows; `shared` returns workspace-wide rows.
 * The scope predicate is built here against `roi_metrics`'s OWN columns (it carries
 * `agent_id` but not the `memories`-shaped `visibility`/`is_deleted`), reusing the
 * canonical {@link ScopeReadPolicy} type, every value SQL-guarded.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import {
	ROI_COST_BASES,
	type RoiCostBasis,
	TEAM_ACTIVE,
} from "../../storage/catalog/tenancy.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, appendVersionBumped, type RowValues, val } from "../../storage/writes.js";
import { asReadPolicy, type ScopeReadPolicy } from "../recall/scope-clause.js";

// ────────────────────────────────────────────────────────────────────────────
// The per-user gate (f-AC-6 / f-AC-7)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A verified person claim. The ONLY admissible source of a `user_id` is
 * `source === 'backend-token'` — a claim minted by the (not-yet-existing) backend.
 * Any other source, or no claim at all, yields `''`.
 */
export interface VerifiedUserClaim {
	/** The provenance of the claim. ONLY `'backend-token'` is admitted as a user_id source. */
	readonly source: string;
	/** The claimed user id (used ONLY when `source === 'backend-token'`). */
	readonly userId: string;
}

/** The one admissible claim source (f-AC-6). */
export const BACKEND_TOKEN_SOURCE = "backend-token" as const;

/**
 * Resolve the gated `user_id` (f-AC-6/f-AC-7). Returns `claim.userId` ONLY when the
 * claim is present AND `source === 'backend-token'`; `''` in every other case. This
 * is the WHOLE gate — there is deliberately no git-email / `$USER` / OS-login branch,
 * by construction, so this function can NEVER read a spoofable client-asserted
 * identity. The verified claim does not exist today, so this returns `''` in practice.
 */
export function resolveGatedUserId(verifiedClaim?: VerifiedUserClaim): string {
	if (verifiedClaim !== undefined && verifiedClaim.source === BACKEND_TOKEN_SOURCE) {
		return verifiedClaim.userId;
	}
	return "";
}

// ────────────────────────────────────────────────────────────────────────────
// Team resolution (f-AC-9)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the writing agent's `team_id` from the `teams` roster (f-AC-9). Reads the
 * highest-version `member_type='agent'` row whose `member_id` is `agentId` and returns
 * its `team_id`. An unassigned agent resolves to `''`.
 *
 * FAIL-SOFT (never throws): any non-ok storage result (missing table, connection flap,
 * timeout) resolves to `''` so a roster problem can never block an ROI write. The
 * version-bumped read takes the row with the greatest `version` for the agent, so a
 * re-assignment (a later version) wins.
 */
export async function resolveTeamId(
	client: StorageQuery,
	scope: QueryScope,
	agentId: string,
): Promise<string> {
	const tbl = sqlIdent("teams");
	const memberType = sqlIdent("member_type");
	const memberId = sqlIdent("member_id");
	const activeCol = sqlIdent("active");
	const versionCol = sqlIdent("version");
	// Finding (team-active-order): pick the LATEST-version row for this (member_type, member_id) pair
	// FIRST, THEN apply the `active` check. The prior form filtered `active = 1` BEFORE ordering, so a
	// later DEACTIVATION row (a newer version with active=0) was skipped and a STALE active row still
	// resolved a team_id. The version-resolution is an inner subquery (the latest version for the pair);
	// the outer SELECT returns the team_id only when THAT latest row is active. Every value SQL-guarded.
	const sql =
		`SELECT team_id FROM "${tbl}" AS t ` +
		`WHERE ${memberType} = ${sLiteral("agent")} ` +
		`AND ${memberId} = ${sLiteral(agentId)} ` +
		`AND ${activeCol} = ${TEAM_ACTIVE} ` +
		`AND ${versionCol} = (` +
		`SELECT MAX(${versionCol}) FROM "${tbl}" AS u ` +
		`WHERE u.${memberType} = ${sLiteral("agent")} AND u.${memberId} = ${sLiteral(agentId)}` +
		`) ` +
		`LIMIT 1`;

	let res: QueryResult;
	try {
		res = await client.query(sql, scope);
	} catch {
		// Fail-soft: any thrown failure → unassigned, never propagate.
		return "";
	}
	if (!isOk(res) || res.rows.length === 0) return "";
	const raw = (res.rows[0] as StorageRow).team_id;
	return typeof raw === "string" ? raw : "";
}

// ────────────────────────────────────────────────────────────────────────────
// The ROI-metric writer (f-AC-1 .. f-AC-6, f-AC-9, f-AC-11)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The computed inputs for one ROI row. The cents are produced by 060b/060c/060d and
 * passed in as INTEGER cents (f-AC-4) — this writer asserts integer-ness defensively
 * and never converts to/from float. `costBasis` defaults to `'none'`; an allocated
 * infra share MUST carry `costBasis: 'allocated'` + a non-empty `allocationMethod`
 * (f-AC-5).
 */
export interface RoiMetricInput {
	/** Row id (caller-supplied; e.g. a uuid). */
	readonly id: string;
	/** The session this row prices. A re-price reuses this id with a new `priceRef`. */
	readonly sessionId: string;
	/** The writing agent/machine. Defaults to `'default'` when blank. */
	readonly agentId: string;
	/** Multi-project scope (PRD-049); `''` when none. */
	readonly projectId?: string;
	/** Measured token usage (integer counts). */
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheCreationTokens?: number;
	/** MEASURED cache savings, integer cents (060b). */
	readonly measuredCacheSavingsCents?: number;
	/** MODELED savings, integer cents (060b). */
	readonly modeledSavingsCents?: number;
	/** Pointer to 060b's assumption data field. */
	readonly modeledAssumptionRef?: string;
	/** Gross cost, integer cents. */
	readonly grossCostCents?: number;
	/** Infra cost, integer cents (060c). */
	readonly infraCostCents?: number;
	/** Whether the infra share is measured, an allocated estimate, or none (f-AC-5). */
	readonly costBasis?: RoiCostBasis;
	/** How an allocated share was split; `''` unless `costBasis === 'allocated'`. */
	readonly allocationMethod?: string;
	/** Provenance: the rate-table version that priced this row; a re-price uses a new value. */
	readonly priceRef?: string;
	/** Period bounds for read-time GROUP BY (ISO text). */
	readonly periodStart?: string;
	readonly periodEnd?: string;
	/** Write time; `MAX(created_at)` per `session_id` resolves the canonical row. */
	readonly createdAt: string;
	/**
	 * The verified person claim, gating `user_id` (f-AC-6). Absent today → `user_id=''`.
	 * NEVER a git-email/$USER/OS-login fallback.
	 */
	readonly verifiedClaim?: VerifiedUserClaim;
}

/** Coerce to a finite integer (defensive — money is integer cents, never float). */
function toInt(n: number | undefined): number {
	if (n === undefined || !Number.isFinite(n)) return 0;
	return Math.trunc(n);
}

/** Narrow an arbitrary cost-basis input to a known value, defaulting to `'none'`. */
function asCostBasis(raw: RoiCostBasis | undefined): RoiCostBasis {
	return raw !== undefined && (ROI_COST_BASES as readonly string[]).includes(raw) ? raw : "none";
}

/**
 * Append ONE immutable ROI row (f-AC-1/f-AC-2). Resolves `team_id` from the roster at
 * write time (f-AC-9) and gates `user_id` on the verified claim (f-AC-6), then writes
 * via `appendOnlyInsert` under the active `QueryScope` (heal-aware, f-AC-10). Returns
 * the storage result and the resolved `team_id` / `user_id` for the caller to surface.
 *
 * A re-price is simply another call with a fresh `priceRef`: it APPENDs a second row
 * for the same `session_id` (never an UPDATE), and the read picks `MAX(created_at)`.
 */
export async function appendRoiMetric(
	client: StorageQuery,
	scope: QueryScope,
	input: RoiMetricInput,
): Promise<{ result: QueryResult; teamId: string; userId: string }> {
	const agentId = input.agentId.trim() === "" ? "default" : input.agentId;
	// f-AC-9: resolve team at write time (fail-soft to '').
	const teamId = await resolveTeamId(client, scope, agentId);
	// f-AC-6/f-AC-7: gate user_id on the verified backend-token claim.
	const userId = resolveGatedUserId(input.verifiedClaim);
	const costBasis = asCostBasis(input.costBasis);

	const row: RowValues = [
		["id", val.str(input.id)],
		["session_id", val.str(input.sessionId)],
		["org_id", val.str(scope.org)],
		["workspace_id", val.str(scope.workspace ?? "")],
		["agent_id", val.str(agentId)],
		["project_id", val.str(input.projectId ?? "")],
		["team_id", val.str(teamId)],
		["user_id", val.str(userId)],
		["input_tokens", val.num(toInt(input.inputTokens))],
		["output_tokens", val.num(toInt(input.outputTokens))],
		["cache_read_tokens", val.num(toInt(input.cacheReadTokens))],
		["cache_creation_tokens", val.num(toInt(input.cacheCreationTokens))],
		["measured_cache_savings_cents", val.num(toInt(input.measuredCacheSavingsCents))],
		["modeled_savings_cents", val.num(toInt(input.modeledSavingsCents))],
		["modeled_assumption_ref", val.str(input.modeledAssumptionRef ?? "")],
		["gross_cost_cents", val.num(toInt(input.grossCostCents))],
		["infra_cost_cents", val.num(toInt(input.infraCostCents))],
		["cost_basis", val.str(costBasis)],
		["allocation_method", val.str(input.allocationMethod ?? "")],
		["price_ref", val.str(input.priceRef ?? "")],
		["period_start", val.str(input.periodStart ?? "")],
		["period_end", val.str(input.periodEnd ?? "")],
		["created_at", val.str(input.createdAt)],
	];

	const result = await appendOnlyInsert(client, healTargetFor("roi_metrics"), scope, row);
	return { result, teamId, userId };
}

// ────────────────────────────────────────────────────────────────────────────
// The roster writer (f-AC-8)
// ────────────────────────────────────────────────────────────────────────────

/** The inputs for one roster row (f-AC-8). */
export interface TeamMemberInput {
	/** Row id. */
	readonly id: string;
	/** The team. */
	readonly teamId: string;
	/** Display name. */
	readonly teamName?: string;
	/** `'agent'` works today; `'user'` is structurally valid but inert until verified. */
	readonly memberType: "agent" | "user";
	/** `agent_id`, or `user_id` once verified. */
	readonly memberId: string;
	/** `'member'|'lead'|'admin'`; defaults to `'member'`. */
	readonly role?: string;
	/** `1` live / `0` inactive; defaults to `1`. */
	readonly active?: number;
	/** Write/edit timestamps (ISO text). */
	readonly createdAt: string;
	readonly updatedAt?: string;
}

/**
 * Upsert ONE roster member, version-bumped (f-AC-8). Keyed by `member_id`: an edit
 * APPENDs version N+1; the read takes `ORDER BY version DESC LIMIT 1`. Heal-aware. The
 * `member_type` union lets an `agent` row resolve a `team_id` today while a `user` row
 * is structurally valid but inert until `user_id` is verified.
 */
export async function upsertTeamMember(
	client: StorageQuery,
	scope: QueryScope,
	input: TeamMemberInput,
): Promise<{ result: QueryResult; version: number }> {
	const row: RowValues = [
		["id", val.str(input.id)],
		["team_id", val.str(input.teamId)],
		["team_name", val.str(input.teamName ?? "")],
		["member_type", val.str(input.memberType)],
		["member_id", val.str(input.memberId)],
		["role", val.str(input.role ?? "member")],
		["active", val.num(input.active ?? TEAM_ACTIVE)],
		["org_id", val.str(scope.org)],
		["workspace_id", val.str(scope.workspace ?? "")],
		["created_at", val.str(input.createdAt)],
		["updated_at", val.str(input.updatedAt ?? input.createdAt)],
	];
	return appendVersionBumped(client, healTargetFor("teams"), scope, {
		keyColumn: "member_id",
		keyValue: input.memberId,
		row,
	});
}

// ────────────────────────────────────────────────────────────────────────────
// The read_policy-scoped local read (f-AC-10 / f-AC-13)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The local-read result discriminant (f-AC-10). `ok` carries the canonical-per-session
 * rows; `shared-ledger-absent` is the DEGRADED state when the table/column is missing —
 * the read NEVER throws, so the daemon boots whether or not the ledger has been created.
 */
export type RoiReadResult =
	| { readonly status: "ok"; readonly rows: StorageRow[] }
	| { readonly status: "shared-ledger-absent"; readonly reason: string };

/** Inputs to {@link readRoiMetrics}. */
export interface RoiReadInput {
	/** The requesting agent (scopes an `isolated` read to its own rows). */
	readonly agentId: string;
	/**
	 * PRD-049e -- the SELECTED project to narrow the read to (`roi_metrics.project_id`). ABSENT/blank
	 * => no project filter (workspace-wide, back-compat). ANDed in alongside the read-policy scope.
	 */
	readonly projectId?: string;
	/** The read policy. `isolated` → own rows only; `shared` → workspace-wide (f-AC-13). */
	readonly readPolicy: string;
}

/**
 * Build the `roi_metrics` read-scope WHERE fragment from a read policy (f-AC-13).
 * `roi_metrics` carries `agent_id` (but not the `memories`-shaped `visibility`/
 * `is_deleted`), so this is the ledger-shaped sibling of `buildScopeClause`, reusing
 * the canonical {@link ScopeReadPolicy} semantics:
 *
 *   - `isolated` → `agent_id = '<self>'` (own rows only)
 *   - `shared`   → `'1' = '1'` (workspace-wide; the org/workspace partition outer ring
 *                  already bounds the rows to this workspace)
 *   - `group`    → degrades to own-only here (group membership is a roster concern the
 *                  ledger read does not resolve), fail-closed, never wider.
 *
 * Fail-closed: a blank/malformed agent id OR an unknown policy yields the `isolated`
 * fragment. Every value routes through `sLiteral`; the column through `sqlIdent`.
 */
export function buildRoiReadScopeSql(
	input: RoiReadInput,
	tableAlias?: string,
): { sql: string; policyApplied: ScopeReadPolicy } {
	// The column may be qualified with a table alias for a self-join (e.g. `m.agent_id`).
	// Both the alias and the column route through `sqlIdent` so neither is raw.
	const agentCol = tableAlias !== undefined ? `${sqlIdent(tableAlias)}.${sqlIdent("agent_id")}` : sqlIdent("agent_id");
	const ownSql = `${agentCol} = ${sLiteral(input.agentId)}`;
	// Finding (isolated-agentid): a BLANK agent id has no own-rows to scope to. The dashboard layer has
	// no real agent identity to fall back on (the org id is a TENANT id, not an agent id), so an
	// `isolated` read with no agent FAILS CLOSED to a guarded-FALSE predicate (empty result) rather than
	// matching the empty-agent rows or silently filtering on the org. `shared` is unaffected (it admits
	// all workspace rows regardless of agent).
	const noRows = `(${sLiteral("1")} = ${sLiteral("0")})`;
	const policy = asReadPolicy(input.readPolicy);

	// Fail-closed: missing/malformed agent id OR unknown policy → isolated (own-only).
	if (input.agentId.trim() === "" || policy === null || policy === "isolated") {
		// Fail-closed: an `isolated` read with NO agent to pin to returns NO rows (guarded false),
		// never the empty-agent rows and never a filter on the org id.
		const ownClause = input.agentId.trim() === "" ? noRows : ownSql;
		return { sql: `(${ownClause})`, policyApplied: "isolated" };
	}
	if (policy === "shared") {
		// Workspace-wide: the outer-ring QueryScope partition already bounds rows to this
		// workspace, so the inner clause admits all of them. A guarded always-true literal
		// keeps the predicate SQL-safe and uniform.
		return { sql: `(${sLiteral("1")} = ${sLiteral("1")})`, policyApplied: "shared" };
	}
	// policy === "group": ledger read has no roster membership here → degrade to own-only.
	return { sql: `(${ownSql})`, policyApplied: "group" };
}

/**
 * Read `roi_metrics` at the requesting agent's `read_policy` (f-AC-13), resolving the
 * CANONICAL row per `session_id` by `MAX(created_at)` (f-AC-3) and excluding superseded
 * re-price rows. DEGRADES to `{ status: "shared-ledger-absent" }` when the table is
 * missing rather than throwing (f-AC-10) — the daemon boots either way.
 *
 * The canonical-row resolution is a self-join: a row survives iff no row with the same
 * `session_id` has a strictly greater `created_at`. The read-policy fragment is ANDed in,
 * so an `isolated` policy never returns another agent's rows and `shared` returns
 * workspace-wide rows.
 */
export async function readRoiMetrics(
	client: StorageQuery,
	scope: QueryScope,
	input: RoiReadInput,
): Promise<RoiReadResult> {
	const tbl = sqlIdent("roi_metrics");
	// Qualify the scope predicate against the `m` self-join alias (f-AC-13).
	const { sql: scopeSql } = buildRoiReadScopeSql(input, "m");
	// Finding (project-scope): when a SELECTED project is present (PRD-049e), narrow the ledger read to
	// that project's rows (`m.project_id = '<sel>'`) so switching projects re-scopes the rollups. ABSENT
	// => no project conjunct (workspace-wide, back-compat). The value routes through `sLiteral`.
	const projectClause =
		input.projectId !== undefined && input.projectId.trim() !== ""
			? ` AND ${sqlIdent("m")}.${sqlIdent("project_id")} = ${sLiteral(input.projectId.trim())}`
			: "";
	// Canonical per session_id = MAX(created_at): keep a row iff no newer row shares its
	// session_id. The original re-priced row is RETAINED on disk (auditable), just not
	// returned here.
	// Finding (canonical-tie): the NOT EXISTS keeps a row iff no NEWER row shares its session_id. Two
	// re-price rows with the SAME `created_at` would BOTH survive (each sees the other as not-greater)
	// and double-count. Add a stable tie-breaker on `id`: a row is superseded when another shares its
	// session_id and has either a greater `created_at`, OR the same `created_at` AND a greater `id`. So
	// on a created_at tie exactly ONE row (the lexicographically-greatest id) survives -- deterministic.
	const sql =
		`SELECT m.* FROM "${tbl}" AS m ` +
		`WHERE ${scopeSql}${projectClause} ` +
		`AND NOT EXISTS (SELECT 1 FROM "${tbl}" AS n ` +
		`WHERE n.session_id = m.session_id ` +
		`AND (n.created_at > m.created_at OR (n.created_at = m.created_at AND n.id > m.id)))`;

	let res: QueryResult;
	try {
		res = await client.query(sql, scope);
	} catch (err) {
		return { status: "shared-ledger-absent", reason: err instanceof Error ? err.message : "query threw" };
	}
	if (!isOk(res)) {
		// A missing table/column surfaces as a query_error; degrade rather than throw.
		return { status: "shared-ledger-absent", reason: res.kind === "query_error" ? res.message : res.kind };
	}
	return { status: "ok", rows: res.rows };
}
