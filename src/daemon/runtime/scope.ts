/**
 * Shared request-scope resolution for the data-access handlers — PRD-022 (local-mode
 * default-scope fallback).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every data handler (`/api/memories`, `/memory`, `/api/goals`, `/api/kpis`,
 * `/api/skills`, `/api/rules`) resolves its per-request {@link QueryScope} from the
 * `x-honeycomb-*` headers. That is correct for team/hybrid, where the org/identity is
 * always carried. But in LOCAL single-user mode (ledger D-3, the dogfood target) the
 * daemon has exactly ONE configured tenant (its own resolved storage scope) and the
 * permission middleware is OPEN. A loopback thin client (the SDK `client.recall()`, the
 * MCP `memory_search`) carries actor/runtime-path/session headers but NOT the org GUID —
 * it must not be required to know it. The CLI loopback client happens to send
 * `x-honeycomb-org`, which is why the CLI worked while the SDK + MCP got a 400.
 *
 * ── The precedence (fail-closed outside local) ───────────────────────────────
 *   (a) `x-honeycomb-org` header present  → use it (+ optional `x-honeycomb-workspace`),
 *                                            exactly as before. The header ALWAYS wins.
 *   (b) else, mode === "local" AND a `defaultScope` was injected → the daemon's own
 *       configured default tenant (the single LOCAL tenant). The fallback fires ONLY in
 *       local mode.
 *   (c) else → `null` → the caller 400s (the existing fail-closed posture). A team/hybrid
 *       request with no org STILL 400s — tenancy is NOT loosened outside local.
 *
 * The default scope is threaded from the composition root (`assemble.ts`), which already
 * resolves the daemon's tenancy (`resolveDaemonScope(storage)`), into each data mount's
 * options as `defaultScope`. A unit-constructed daemon (no injected default) keeps the
 * pure header-only behaviour, so the existing 400 cases are unchanged.
 */

import type { Context } from "hono";

import type { DeploymentMode } from "./config.js";
import type { QueryScope } from "../storage/client.js";
import { getRequestIdentity } from "./middleware/permission.js";
import { resolveScopeFromDisk, UNSORTED_PROJECT_ID } from "../../hooks/shared/project-resolver.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRD-049b — per-request project resolution from the session cwd (49b-AC-2 / D8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The header carrying the SESSION cwd a recall/browse request ran in (PRD-049b). The hook
 * stamps it (the thin client knows the session's working directory); the daemon resolves the
 * project from it via the SAME thin-client {@link resolveScopeFromDisk} (049a), NEVER from a
 * machine-global field — so two concurrent sessions in two folders resolve to two projects.
 * Project is a SOFT inner-ring segment within the trusted org/workspace partition (the index
 * "projects within one team are not a security boundary"), so resolving it from the request is
 * correct; the HARD org/workspace isolation stays at the storage partition (unchanged).
 */
export const CWD_HEADER = "x-honeycomb-cwd" as const;

/**
 * The header carrying an EXPLICITLY-SELECTED project id (PRD-049e 49e-AC-2). The dashboard's
 * scope switcher selects a project VIEWER-SIDE (it drives which data the pages show) and stamps
 * this header on its read requests — it carries NO cwd. When present, the daemon scopes the read
 * to exactly this project, SHORT-CIRCUITING the cwd→resolver branch: the dashboard already KNOWS
 * the project (the user picked it from the privilege-scoped enumeration), so there is nothing to
 * resolve from a working directory. This is a SOFT inner-ring segment WITHIN the trusted
 * org/workspace partition (the same posture as the cwd-resolved project — project is not a security
 * boundary; the HARD org/workspace isolation stays at the storage partition, unchanged). It is
 * additive + back-compat: a request WITHOUT this header falls through to the existing
 * {@link CWD_HEADER}/cwd resolution unchanged (49b). An empty/whitespace value is treated as ABSENT.
 *
 * NOTE: this is the SAME header the permission middleware reads as a project HINT
 * (`src/daemon/runtime/middleware/permission.ts`), so a team/hybrid policy can compare it to the
 * Identity's own project binding (c-AC-5) — there is no second header to keep in sync.
 */
export const PROJECT_HEADER = "x-honeycomb-project" as const;

/**
 * The resolved project segment a recall/browse request runs under (PRD-049b). `projectId` is the
 * 049a-resolved registry key; `bound` is false for the unbound inbox fallback (D8 / 49b-AC-3);
 * `degraded` is true when NO cwd was available to resolve from (the harness did not pass it), so
 * the caller surfaces the visible "project scoping degraded" warning (D8).
 */
export interface RequestProjectScope {
	/** The resolved project id; {@link UNSORTED_PROJECT_ID} for the unbound inbox session. */
	readonly projectId: string;
	/** True when a real project resolved (binding/git), false for the inbox fallback. */
	readonly bound: boolean;
	/** True when NO cwd was available → project scoping is degraded to inbox+global (D8 warning). */
	readonly degraded: boolean;
}

/**
 * Resolve the per-request project segment from the session cwd (PRD-049b 49b-AC-2 / D8). The cwd
 * arrives in the {@link CWD_HEADER} (recall/browse) or an explicit `cwd` arg (the recall body).
 *
 * When a cwd IS present, the project is resolved via the thin-client {@link resolveScopeFromDisk}
 * (the SAME resolver the capture path uses), scoped to the request's resolved org/workspace so a
 * stale cross-workspace cache can never bind the wrong project. When NO cwd is available (D8 — a
 * harness that does not pass it), the request falls to the workspace `__unsorted__` inbox +
 * workspace-global rows with `degraded: true`, so the caller surfaces a visible warning rather
 * than silently widening or returning nothing. NEVER throws (fail-soft, like the resolver).
 */
export function resolveRequestProject(
	c: Context,
	scope: QueryScope,
	explicitCwd?: string,
): RequestProjectScope {
	// PRD-049e (49e-AC-2): an EXPLICITLY-selected project (the dashboard switcher's viewer-side
	// selection, the {@link PROJECT_HEADER}) WINS over cwd resolution — the dashboard already knows
	// the project, so there is nothing to resolve from a working directory. A non-empty selection is
	// a BOUND project (not degraded): the read is narrowed to exactly it. The reserved inbox sentinel
	// is honored as the inbox (bound:false) so "show the unsorted inbox" is selectable. Absent/blank →
	// fall through to the existing 49b cwd resolution (back-compat).
	const selectedProject = (c.req.header(PROJECT_HEADER) ?? "").trim();
	if (selectedProject.length > 0) {
		const bound = selectedProject !== UNSORTED_PROJECT_ID;
		return { projectId: selectedProject, bound, degraded: false };
	}

	const headerCwd = c.req.header(CWD_HEADER);
	const cwd = explicitCwd !== undefined && explicitCwd !== "" ? explicitCwd : headerCwd;
	if (cwd === undefined || cwd.trim() === "") {
		// D8: no cwd to resolve from → inbox + workspace-global, with the degraded warning.
		return { projectId: UNSORTED_PROJECT_ID, bound: false, degraded: true };
	}
	try {
		const resolved = resolveScopeFromDisk({
			cwd,
			org: scope.org,
			...(scope.workspace !== undefined ? { workspace: scope.workspace } : {}),
		});
		return { projectId: resolved.projectId, bound: resolved.bound, degraded: false };
	} catch {
		// The resolver is fail-soft, but guard belt-and-suspenders: any unexpected throw falls to
		// the inbox + warning rather than failing the recall.
		return { projectId: UNSORTED_PROJECT_ID, bound: false, degraded: true };
	}
}

/**
 * Resolve the per-request tenancy scope from the `x-honeycomb-org` (+ optional
 * `x-honeycomb-workspace`) headers. Returns `null` when no org header is present. This is
 * the SHARED header reader the per-handler resolvers delegate to so the header-parse logic
 * lives in exactly one place (jscpd discipline). It carries NO mode/default awareness — it
 * is the pure header step (a) of the precedence.
 *
 * ── Cross-tenant hardening (PRD-022 security) ────────────────────────────────
 * In team/hybrid the permission middleware has already AUTHENTICATED the request and
 * stamped the VALIDATED {@link import("./auth/contracts.js").Identity} onto the context.
 * The data handlers partition storage by the header org/workspace, so a header that disagrees
 * with the token's own org or workspace would let an authenticated caller for org A read/write
 * org B by forging `x-honeycomb-org: orgB`, or access workspace X by forging
 * `x-honeycomb-workspace: workspaceX`. When a validated Identity is present, the resolved
 * org MUST equal `identity.org` AND the resolved workspace (when supplied) MUST equal
 * `identity.workspace`; a mismatch returns `null` → the handler fails closed (its existing
 * 400/deny). In local mode no Identity is stamped, so the prior pure-header behaviour is
 * unchanged.
 */
export function resolveScopeFromHeaders(c: Context): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org === undefined || org.length === 0) return null;
	// Cross-tenant guard: a forged org header can never cross the token's own org boundary.
	const identity = getRequestIdentity(c);
	if (identity !== undefined && org !== identity.org) return null;
	const workspace = c.req.header("x-honeycomb-workspace");
	// Cross-workspace guard: when a workspace is supplied AND an identity is present, the
	// workspace header must match the token's own workspace. A mismatch is a cross-workspace
	// access attempt and must be rejected (fail-closed).
	if (identity !== undefined && workspace !== undefined && workspace.length > 0 && workspace !== identity.workspace) {
		return null;
	}
	return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
}

/**
 * Resolve the per-request tenancy scope with the LOCAL-mode default-scope fallback
 * (PRD-022). The precedence is exactly (a) header → (b) local default → (c) null:
 *
 *   1. If the request carries `x-honeycomb-org`, use the header scope (the header ALWAYS
 *      wins, in EVERY mode — this preserves the prior behaviour for org-stamped requests).
 *   2. Otherwise, ONLY when `mode === "local"` AND a `defaultScope` was injected, fall back
 *      to the daemon's configured default tenant (the single local tenant — a loopback thin
 *      client need not know the org GUID).
 *   3. Otherwise return `null` → the handler returns its existing fail-closed 400. A
 *      team/hybrid request with no org STILL resolves to `null` here (the fallback never
 *      fires outside local), so team-mode tenancy is unchanged.
 *
 * @param c            the Hono request context
 * @param mode         the daemon's deployment mode (read from `daemon.config.mode`)
 * @param defaultScope the daemon's configured default scope, threaded from the composition
 *                     root. `undefined` for a unit-constructed daemon → pure header-only.
 */
export function resolveScopeOrLocalDefault(
	c: Context,
	mode: DeploymentMode,
	defaultScope: QueryScope | undefined,
): QueryScope | null {
	const fromHeader = resolveScopeFromHeaders(c);
	if (fromHeader !== null) return fromHeader;
	if (mode === "local" && defaultScope !== undefined) return defaultScope;
	return null;
}
