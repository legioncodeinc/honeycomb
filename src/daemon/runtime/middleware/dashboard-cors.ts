/**
 * Dashboard CORS middleware (ADR-0001 cutover follow-up).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Per ADR-0001 (`src/dashboard/launch.ts:142-164`, `src/commands/install.ts:60-73`),
 * thehive now serves the dashboard SPA on its own origin (`http://127.0.0.1:3853`);
 * honeycomb "keeps `/api/*` only". That SPA's wire client (`the-hive/src/dashboard/
 * web/wire.ts`) reads/writes honeycomb's `/health`, `/setup/*`, and `/api/*` routes
 * as CROSS-ORIGIN fetches (it federates them to honeycomb's origin via
 * `createFederatedFetch`/`buildFederatedUrl`), which is new: before the ADR-0001
 * cutover the dashboard was served BY honeycomb itself, same-origin, and never
 * needed a CORS allowance.
 *
 * Without this middleware every non-trivial dashboard call from thehive's origin
 * fails: a browser sends a CORS preflight (`OPTIONS`) ahead of any JSON POST or
 * request carrying a custom header, honeycomb has no `OPTIONS` handler and no
 * `Access-Control-*` response headers, so the preflight 404s with no CORS headers
 * and the browser blocks the real request before it is ever sent — even though the
 * route itself works fine (verified: `curl -X POST .../setup/login` succeeds; only
 * the browser's CORS enforcement blocks it).
 *
 * ── SCOPE: A FIXED, LOOPBACK-ONLY ALLOWLIST ──────────────────────────────────
 * thehive is a single companion process at a single canonical port, per the same
 * fixed-port convention every daemon in this system already follows (honeycomb
 * 3850, hivedoctor 3852, thehive 3853, hivenectar 3854 — `shared/constants.ts`).
 * This middleware allows exactly the origins thehive's dashboard is reachable at
 * ({@link THEHIVE_DASHBOARD_ORIGINS}: the loopback IP, `localhost`, and the
 * `honeycomb.local` mDNS/hosts nicety `install.ts` also opens) — never a wildcard,
 * never an attacker-influenced value. No credentials (cookies) cross this
 * boundary — the dashboard's own auth is header-based (`x-honeycomb-session`,
 * bearer tokens elsewhere), so `credentials` is left at its default (`false`);
 * CORS here is additive browser-side plumbing, NOT the authorization boundary —
 * honeycomb's existing permission middleware (`middleware/permission.ts`) still
 * gates every protected route regardless of Origin.
 *
 * ── METHODS / HEADERS: MATCH THE REAL WIRE CLIENT, NOTHING WIDER ────────────
 * The dashboard wire client only ever sends `GET`/`POST` and the headers below
 * (`the-hive/src/dashboard/web/wire.ts` — `DASHBOARD_SESSION_HEADERS`,
 * `PROJECT_HEADER`); the allowlists here mirror that exactly rather than opening
 * every method/header "to be safe" (a wider CORS allowance is not "safer" — it is
 * simply unused surface).
 */

import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { THEHIVE_HOST, THEHIVE_PORT } from "../../../shared/constants.js";

/** The `honeycomb.local` mDNS/hosts nicety `commands/install.ts` opens thehive's portal at. */
const THEHIVE_LOCAL_HOSTNAME = "honeycomb.local" as const;

/**
 * Every browser-facing origin thehive's dashboard may legitimately be loaded from
 * (all loopback, all fixed by convention — never derived from request input).
 */
export const THEHIVE_DASHBOARD_ORIGINS: readonly string[] = Object.freeze([
	`http://${THEHIVE_HOST}:${THEHIVE_PORT}`,
	`http://localhost:${THEHIVE_PORT}`,
	`http://${THEHIVE_LOCAL_HOSTNAME}:${THEHIVE_PORT}`,
]);

/** The HTTP methods the dashboard wire client actually issues (no PUT/PATCH/DELETE today). */
const DASHBOARD_CORS_METHODS = ["GET", "POST"] as const;

/** The request headers the dashboard wire client actually sends. */
const DASHBOARD_CORS_HEADERS = [
	"content-type",
	"accept",
	"x-honeycomb-runtime-path",
	"x-honeycomb-session",
	"x-honeycomb-project",
] as const;

/**
 * Build the CORS middleware thehive's dashboard needs to read honeycomb's `/health`,
 * `/setup/*`, and `/api/*` responses cross-origin. `allowedOrigins` defaults to
 * {@link THEHIVE_DASHBOARD_ORIGINS}; a test (or a future multi-portal deployment)
 * can inject a different fixed list, but production always passes a concrete
 * allowlist — never a wildcard or a request-derived value.
 */
export function dashboardCorsMiddleware(
	allowedOrigins: readonly string[] = THEHIVE_DASHBOARD_ORIGINS,
): MiddlewareHandler {
	return cors({
		origin: [...allowedOrigins],
		allowMethods: [...DASHBOARD_CORS_METHODS],
		allowHeaders: [...DASHBOARD_CORS_HEADERS],
	});
}
