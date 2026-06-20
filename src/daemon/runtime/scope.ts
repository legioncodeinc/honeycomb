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
 * The data handlers partition storage by the header org, so a header that disagrees with
 * the token's own org would let an authenticated caller for org A read/write org B by
 * forging `x-honeycomb-org: orgB`. When a validated Identity is present, the resolved
 * org MUST equal `identity.org`; a mismatch returns `null` → the handler fails closed
 * (its existing 400/deny). In local mode no Identity is stamped, so the prior pure-header
 * behaviour is unchanged.
 */
export function resolveScopeFromHeaders(c: Context): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org === undefined || org.length === 0) return null;
	// Cross-tenant guard: a forged org header can never cross the token's own org boundary.
	const identity = getRequestIdentity(c);
	if (identity !== undefined && org !== identity.org) return null;
	const workspace = c.req.header("x-honeycomb-workspace");
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
