/**
 * The product-data API facade — PRD-022c (c-AC-3 / c-AC-4 / c-AC-5 / FR-3..FR-6).
 *
 * This module owns the read-only `/api/skills` + `/api/rules` reads AND the single
 * `mountProductDataApi` seam the assembly (022d) fires once to wire the whole product-data
 * surface. It re-exposes the EXISTING `mountSourcesApi` (PRD-013) + `mountSecretsApi`
 * (PRD-012, names-only) through daemon-seam wrappers so the composition root mounts them
 * the same way it mounts the goals/kpis/skills/rules groups — `mount<X>(daemon, deps)` —
 * rather than juggling the `daemon.group(path)` resolution at every call site.
 *
 * ── What this wires ──────────────────────────────────────────────────────────
 *   - GET `/api/skills` → the scoped tenant's mined skills, highest-version-per-id
 *                         (016/018 version-bumped table). Read-only (c-AC-3 / FR-3).
 *   - GET `/api/rules`  → the org's ACTIVE rules, highest-version-per-key, `status='active'`
 *                         (version-bumped). Read-only (c-AC-3 / FR-4).
 *   - `mountSourcesApi`  → mounted onto `/api/sources` (c-AC-4 / FR-5) — it EXISTS (013),
 *                          this just wires it so `/api/sources` answers (not 404).
 *   - `mountSecretsApi`  → mounted onto `/api/secrets` (c-AC-5 / FR-6) — names-only, the
 *                          value never crosses the HTTP boundary (security invariant).
 *   - `mountGoalsApi` / `mountKpisApi` → re-fired here so `mountProductDataApi` is the ONE
 *                          seam 022d calls for goals + kpis + skills + rules.
 *
 * ── Wiring-only (D-1) ────────────────────────────────────────────────────────
 * NO new business logic and NO schema. The skills/rules tables (016/018/003d) and the
 * sources/secrets engines (013/012) all exist; this parses + scopes + delegates. Every
 * read SELECT builds through `sqlIdent`; there are no caller-interpolated values (the
 * scope partition isolates the tenant), so the version-bumped reads are static +
 * injection-free. `audit:sql` scans `src/daemon`.
 *
 * ── Tenancy (c-AC-6) ─────────────────────────────────────────────────────────
 * Skills/rules reads resolve `{ org, workspace }` from the `x-honeycomb-*` headers; no org
 * → 400 fail-closed. The sources/secrets handlers carry their OWN header scope resolvers
 * (they 400 fail-closed on a missing org too), so cross-tenant access is rejected at the
 * edge across every product-data route.
 */

import type { Context, Hono } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import type { DeploymentMode } from "../config.js";
import { resolveRequestProject, resolveScopeOrLocalDefault } from "../scope.js";
import { buildProjectScopeClause } from "../recall/scope-clause.js";
import type { Daemon } from "../server.js";

import { mountSourcesApi, mountDocumentsApi, type SourcesApiDeps } from "../sources/api.js";
import { mountSecretsApi, type SecretsApiDeps } from "../secrets/api.js";
import { mountGoalsApi, GOALS_GROUP } from "../goals/api.js";
import { mountKpisApi, KPIS_GROUP } from "../kpis/api.js";

/** The product-data read route groups (already mounted + protected in `server.ts`). */
export const SKILLS_GROUP = "/api/skills" as const;
export const RULES_GROUP = "/api/rules" as const;
export const SOURCES_GROUP = "/api/sources" as const;
export const DOCUMENTS_GROUP = "/api/documents" as const;
export const SECRETS_GROUP = "/api/secrets" as const;

/** Options for {@link mountProductDataApi}: the storage client + the sources/secrets deps. */
export interface ProductDataApiOptions {
	/** The storage client the goals/kpis/skills/rules reads + writes run through. */
	readonly storage: StorageQuery;
	/**
	 * The deps the EXISTING `mountSourcesApi` (013) needs (registry / queue / providers /
	 * storage). When ABSENT the `/api/sources` mount is skipped (the assembly wires it when
	 * the source engine is available). Provided by 022d at assembly.
	 */
	readonly sources?: SourcesApiDeps;
	/**
	 * The deps the EXISTING names-only `mountSecretsApi` (012) needs (the machine-bound
	 * store). When ABSENT the `/api/secrets` mount is skipped. Provided by 022d at assembly.
	 */
	readonly secrets?: SecretsApiDeps;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a goals/kpis/skills/rules request with no `x-honeycomb-org`
	 * header falls back to this single configured tenant (a loopback thin client need not
	 * know the org GUID). ABSENT → pure header-only resolution. NEVER consulted outside local.
	 */
	readonly defaultScope?: QueryScope;
}

/** The 400 body for a request with no resolvable org (fail-closed — never a broad scope). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** One mined-skill view row (016/018) + the PRD-049c project + cross-project provenance. */
export interface SkillReadRow {
	readonly id: string;
	readonly name: string;
	readonly scope: string;
	readonly visibility: string;
	readonly version: number;
	/** PRD-049c: the resolved project the skill is scoped to (`''`/unset for a legacy row). */
	readonly projectId: string;
	/** PRD-049c (49c-AC-2): the cross-project promotion reach — `none` | `user` | `workspace`. */
	readonly crossProjectScope: string;
	/** PRD-049c (49c-AC-2): WHO promoted it (visible provenance; `''` when unpromoted). */
	readonly promotedBy: string;
	/** PRD-049c (49c-AC-2): the ORIGIN project it was promoted FROM (`''` when unpromoted). */
	readonly promotedFromProject: string;
}

/** One active-rule view row. */
export interface RuleReadRow {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly status: string;
	readonly version: number;
}

/** String coercion that never returns undefined for a text column. */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Number coercion that never returns NaN for a version column. */
function toNum(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Build the highest-version-per-id SELECT for a version-bumped table (mirrors
 * `skillify/publish-endpoint.ts`'s `buildSelectNewerSql`). A self-join against
 * `MAX(version)` grouped by the logical id column yields exactly the current row for each
 * id — every prior version stays in the append-only log but never reads as current. All
 * identifiers route through `sqlIdent`; there are no caller values (the scope is a
 * daemon-side partition filter), so the statement is static + injection-free.
 *
 * @param table        the version-bumped table name (`"skills"` / `"rules"`)
 * @param idColumn     the logical id column to group by (`"id"` / `"key"`)
 * @param selectColumns the columns to project from the current row
 * @param whereClause  PRD-049c: an OPTIONAL pre-built, parenthesized WHERE fragment (no leading
 *                     `WHERE`/`AND`) ANDed onto the CURRENT (highest-version) row — the skills
 *                     surfacing path passes the project-segment predicate here so a project-B
 *                     row is filtered server-side (49c-AC-1). Empty → no extra filter (rules).
 */
export function buildHighestVersionSql(
	table: string,
	idColumn: string,
	selectColumns: readonly string[],
	whereClause = "",
): string {
	const tbl = sqlIdent(table);
	const id = sqlIdent(idColumn);
	const version = sqlIdent("version");
	const projection = selectColumns.map((col) => `s.${sqlIdent(col)} AS ${sqlIdent(col)}`).join(", ");
	// The project predicate (49c-AC-1) is ANDed onto the CURRENT row `s.*`, so the segment runs on
	// the highest-version row that won the self-join — a promoted (later) version is judged on its
	// own promotion columns, never a superseded prior version's.
	const where = whereClause === "" ? "" : ` WHERE ${whereClause}`;
	return (
		`SELECT ${projection}, s.${version} AS version ` +
		`FROM "${tbl}" s ` +
		`JOIN (SELECT ${id}, MAX(${version}) AS mv FROM "${tbl}" GROUP BY ${id}) latest ` +
		`ON s.${id} = latest.${id} AND s.${version} = latest.mv` +
		`${where} ` +
		`LIMIT 1000`
	);
}

/** Run a SELECT through the storage seam, returning rows or `[]` on any non-ok result (fail-soft). */
async function selectRows(storage: StorageQuery, sql: string, scope: QueryScope): Promise<StorageRow[]> {
	const result = await storage.query(sql, scope);
	return isOk(result) ? result.rows : [];
}

/**
 * The session's resolved project segment for skills surfacing (PRD-049c). `projectId`/`bound`
 * come from {@link resolveRequestProject} (049a/049b); they drive {@link buildProjectScopeClause}
 * so a skill surfaces ONLY in its origin project + any explicitly cross-project-promoted skill
 * (49c-AC-1 / 49c-AC-2). ABSENT → the unbound inbox session (the project-only segment narrows to
 * inbox + unset rows), exactly the 049b unbound posture.
 */
export interface SkillProjectScope {
	/** The session's resolved project id (049a). */
	readonly projectId: string;
	/** Whether the session resolved a real bound project (049a `resolveScope(cwd).bound`). */
	readonly bound: boolean;
}

/**
 * Fetch the scoped tenant's mined skills, highest-version-per-id (c-AC-3 / FR-3), filtered to the
 * session's PROJECT (PRD-049c 49c-AC-1) PLUS any explicitly cross-project-promoted skill (49c-AC-2).
 *
 * The project segment is built by the SINGLE factored {@link buildProjectScopeClause} (49c reuses
 * the 049b builder, NOT a parallel predicate) with the skill table's `project_id` column AND the
 * `cross_project_scope` promotion column, so a project-B row is filtered server-side and a promoted
 * row surfaces in any of the user's projects. When `project` is ABSENT (a caller that does not scope
 * by project, e.g. the dashboard read), the unbound-inbox segment applies. The surfaced row carries
 * the cross-project provenance (`crossProjectScope`/`promotedBy`/`promotedFromProject`) so the
 * promotion is VISIBLE (49c-AC-2).
 */
export async function fetchSkills(
	storage: StorageQuery,
	scope: QueryScope,
	project?: SkillProjectScope,
): Promise<SkillReadRow[]> {
	// PRD-049c: the project-segment predicate over the skills `project_id` + promotion column. A
	// missing `project` is the unbound inbox session (049b posture). REUSES buildProjectScopeClause.
	const projectClause = buildProjectScopeClause({
		projectId: project?.projectId ?? "",
		...(project?.bound !== undefined ? { bound: project.bound } : {}),
		projectColumn: "project_id",
		promotionColumn: "cross_project_scope",
	}).sql;
	const sql = buildHighestVersionSql(
		"skills",
		"id",
		["id", "name", "scope", "visibility", "project_id", "cross_project_scope", "promoted_by", "promoted_from_project"],
		projectClause,
	);
	const rows = await selectRows(storage, sql, scope);
	return rows.map((r) => ({
		id: toStr(r.id),
		name: toStr(r.name),
		scope: toStr(r.scope),
		visibility: toStr(r.visibility),
		version: toNum(r.version),
		projectId: toStr(r.project_id),
		crossProjectScope: toStr(r.cross_project_scope) || "none",
		promotedBy: toStr(r.promoted_by),
		promotedFromProject: toStr(r.promoted_from_project),
	}));
}

/** Fetch the org's ACTIVE rules, highest-version-per-key (c-AC-3 / FR-4). */
export async function fetchRules(storage: StorageQuery, scope: QueryScope): Promise<RuleReadRow[]> {
	const sql = buildHighestVersionSql("rules", "key", ["id", "key", "name", "status"]);
	const rows = await selectRows(storage, sql, scope);
	return rows
		.map((r) => ({
			id: toStr(r.id),
			key: toStr(r.key),
			name: toStr(r.name),
			status: toStr(r.status),
			version: toNum(r.version),
		}))
		// Only the ACTIVE rules surface (a superseded/retired rule's current version reads
		// `status != 'active'` and is filtered out — FR-4).
		.filter((rule) => rule.status === "active");
}

/**
 * Attach the read-only `GET /api/skills` handler onto the daemon's already-mounted group.
 * `defaultScope` (optional, PRD-022) is the daemon's configured tenant for the local-mode
 * fallback; absent → pure header-only resolution (the prior fail-closed behaviour).
 */
export function mountSkillsReadApi(daemon: Daemon, storage: StorageQuery, defaultScope?: QueryScope): void {
	const group = daemon.group(SKILLS_GROUP);
	if (group === undefined) return;
	const mode = daemon.config.mode;
	// PRD-049c: skills surfacing is PROJECT-scoped (49c-AC-1) + admits explicitly-promoted skills
	// (49c-AC-2). Resolve the session project from the cwd header (049b `resolveRequestProject`)
	// and thread it into `fetchSkills` so the project-segment predicate runs server-side. Rules
	// stay on the project-agnostic shared handler — project is a skills/memory concern only.
	group.get("/", async (c: Context) => {
		const scope = resolveScopeOrLocalDefault(c, mode, defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const project = resolveRequestProject(c, scope);
		const rows = await fetchSkills(storage, scope, { projectId: project.projectId, bound: project.bound });
		return c.json({ skills: rows });
	});
}

/**
 * Attach the read-only `GET /api/rules` handler onto the daemon's already-mounted group.
 * `defaultScope` (optional, PRD-022) is the daemon's configured tenant for the local-mode
 * fallback; absent → pure header-only resolution.
 */
export function mountRulesReadApi(daemon: Daemon, storage: StorageQuery, defaultScope?: QueryScope): void {
	const group = daemon.group(RULES_GROUP);
	if (group === undefined) return;
	mountReadHandler(group, "rules", daemon.config.mode, defaultScope, (scope) => fetchRules(storage, scope));
}

/**
 * Attach one scoped read handler onto a group at `GET /`, keyed under `key` in the JSON
 * envelope. Resolves the tenancy scope with the PRD-022 precedence (header → local-mode
 * default → 400), then delegates to the fetcher. Shared so `/api/skills` + `/api/rules`
 * reads do not duplicate the scope + envelope dance (jscpd discipline).
 */
function mountReadHandler<T>(
	group: Hono,
	key: string,
	mode: DeploymentMode,
	defaultScope: QueryScope | undefined,
	fetch: (scope: QueryScope) => Promise<T[]>,
): void {
	group.get("/", async (c: Context) => {
		const scope = resolveScopeOrLocalDefault(c, mode, defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const rows = await fetch(scope);
		return c.json({ [key]: rows });
	});
}

/**
 * Mount the existing `mountSourcesApi` (013) onto `/api/sources` (c-AC-4 / FR-5). Resolves
 * `daemon.group("/api/sources")` and delegates to the already-built engine so `/api/sources`
 * answers (not 404). No-op if the group is not mounted or the deps are absent.
 *
 * THE ASSEMBLY CALL (022d): `mountProductSourcesApi(daemon, sourcesDeps)`.
 */
export function mountProductSourcesApi(daemon: Daemon, deps: SourcesApiDeps): void {
	const group = daemon.group(SOURCES_GROUP);
	if (group === undefined) return;
	mountSourcesApi(group, deps);
}

/**
 * Mount the existing `mountDocumentsApi` (013b) onto `/api/documents` (PRD-045e e-AC-3).
 * Resolves `daemon.group("/api/documents")` and delegates to the document worker carried
 * on the SAME {@link SourcesApiDeps} so `POST /api/documents` ingests instead of 501ing.
 * No-op if the group is not mounted. When `deps.documentWorker` is absent the handlers
 * surface the honest 501 themselves (the 013b contract) — but the assembly always wires
 * the real worker, so production ingests.
 *
 * THE ASSEMBLY CALL (045e): `mountProductDocumentsApi(daemon, sourcesDeps)`.
 */
export function mountProductDocumentsApi(daemon: Daemon, deps: SourcesApiDeps): void {
	const group = daemon.group(DOCUMENTS_GROUP);
	if (group === undefined) return;
	mountDocumentsApi(group, deps);
}

/**
 * Mount the existing names-only `mountSecretsApi` (012) onto `/api/secrets` (c-AC-5 / FR-6).
 * Resolves `daemon.group("/api/secrets")` and delegates to the already-built engine. The
 * secrets API mounts NO value-returning route by construction, so a value never crosses the
 * HTTP boundary. No-op if the group is not mounted or the deps are absent.
 *
 * THE ASSEMBLY CALL (022d): `mountProductSecretsApi(daemon, secretsDeps)`.
 */
export function mountProductSecretsApi(daemon: Daemon, deps: SecretsApiDeps): void {
	const group = daemon.group(SECRETS_GROUP);
	if (group === undefined) return;
	mountSecretsApi(group, deps);
}

/**
 * The single product-data seam the assembly (022d) fires once (c-AC-1..6). Wires goals +
 * kpis (read/write) + skills + rules (read-only) always; wires sources + secrets when their
 * deps are supplied. This is the ONE call 022d makes for the product-data surface — it
 * mirrors `mountDashboardApi(daemon, { storage })`, fired the same way as the other data-API
 * seams in `assembleSeams()`.
 *
 * Each inner mount resolves its own already-mounted, already-protected route group, so there
 * is no edit to `server.ts`. Fire ONCE — calling twice would double-register routes.
 */
export function mountProductDataApi(daemon: Daemon, options: ProductDataApiOptions): void {
	// The local-mode default-scope fallback (PRD-022): thread the daemon's configured tenant
	// into every product-data read/write so a no-org loopback request resolves in local mode.
	const defaultScope = options.defaultScope;

	// goals + kpis: read + upsert-by-key (c-AC-1 / c-AC-2). `mode` is read from the daemon
	// inside mountGoalsApi/mountKpisApi; `defaultScope` is threaded here.
	mountGoalsApi(daemon, {
		storage: options.storage,
		...(defaultScope !== undefined ? { defaultScope } : {}),
	});
	mountKpisApi(daemon, {
		storage: options.storage,
		...(defaultScope !== undefined ? { defaultScope } : {}),
	});

	// skills + rules: read-only scoped reads (c-AC-3).
	mountSkillsReadApi(daemon, options.storage, defaultScope);
	mountRulesReadApi(daemon, options.storage, defaultScope);

	// sources + documents: the EXISTING 013 engines, wired so /api/sources AND
	// /api/documents answer (c-AC-4 / PRD-045e e-AC-2/e-AC-3). Skipped when the source
	// engine deps are not supplied (the assembly wires them when constructible). Both
	// route groups read from the SAME SourcesApiDeps (the registry + providers + the
	// document worker), so one dep object lights up both surfaces.
	if (options.sources !== undefined) {
		mountProductSourcesApi(daemon, options.sources);
		mountProductDocumentsApi(daemon, options.sources);
	}

	// secrets: the EXISTING 012 names-only engine, wired value-safe (c-AC-5). Skipped when
	// the secrets store dep is not supplied.
	if (options.secrets !== undefined) {
		mountProductSecretsApi(daemon, options.secrets);
	}
}

// Re-export the group constants the goals/kpis modules own so a single import of the product
// barrel surfaces the whole route-group set (the assembly + tests reference them by name).
export { GOALS_GROUP, KPIS_GROUP };
