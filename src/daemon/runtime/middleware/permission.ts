/**
 * Permission middleware — PRD-004a FR-3 (the seam) → PRD-011c (the real auth).
 *
 * 004a shipped this as a mode-aware enforcement seam with a pluggable
 * {@link PermissionCheck} (default-deny) that resolved a role from a SPOOFABLE
 * header. PRD-011 EVOLVES it into the real authentication + authorization gate:
 *
 *   - it AUTHENTICATES the request (bearer token / `x-api-key`) via an
 *     {@link Authenticator}, distinguishing **401 unauthenticated** (no valid
 *     credential — "who are you?") from **403 forbidden** (valid credential, but not
 *     permitted here);
 *   - the role/org/project come from the VALIDATED {@link Identity} an Authenticator
 *     returns, NEVER from a request header. The 004a `x-honeycomb-role` trust path
 *     is REMOVED — a header-asserted role is a privilege-escalation bypass (c-AC-2).
 *     Org/workspace headers survive ONLY as a tenancy HINT the authenticator
 *     cross-checks against the token, never as the role source (a-AC-5);
 *   - it is FAIL-CLOSED by default: with the default
 *     {@link alwaysUnauthenticated} + {@link defaultDenyPolicy}, every `team`/`hybrid`
 *     request is denied (401, then 403 once a real authenticator lands).
 *
 * Mode behaviour (FR-3 / D-2):
 *   - `local`         → open. The handler runs with NO auth and NO check (c-AC-4 /
 *                       a-AC-5): loopback single-user.
 *   - `team`/`hybrid` → enforce. Authenticate → no Identity → **401**; a valid
 *                       Identity → policy.decide → `forbidden` → **403**, `allow` →
 *                       `next()`. The check runs BEFORE the handler; on deny the
 *                       middleware short-circuits and the handler never runs.
 *   - `hybrid`        → additionally FAIL-CLOSED on the socket peer: with no
 *                       trustworthy socket-peer signal it REQUIRES a token, and it
 *                       NEVER trusts the `Host` header to decide trust (c-AC-1).
 *
 * `/health` and `/api/status` mount NO permission middleware (FR-3), so this is
 * never on their path.
 *
 * ── Backward compatibility (the 004a seam still works) ──────────────────────
 * The 004a {@link PermissionCheck} seam is retained as a LEGACY adapter
 * ({@link legacyPermissionCheckAdapter}) so the existing 004a server tests — which
 * inject a `permissionCheck` and exercise the allow/deny→403 path — stay green
 * verbatim. The adapter is the ONE place that still derives a context from headers,
 * and it is opt-in: PRD-011 wires the header-free {@link permissionMiddleware}
 * directly. New code MUST NOT use the legacy adapter.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { DeploymentMode } from "../config.js";
import {
	type AuthDecision,
	type AuthorizationPolicy,
	type Authenticator,
	type Identity,
	type PresentedCredentials,
	alwaysUnauthenticated,
	defaultDenyPolicy,
} from "../auth/contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// Validated-Identity context propagation (PRD-022 cross-tenant hardening).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The Hono context key the permission middleware stamps the VALIDATED {@link Identity}
 * under after a successful authenticate (team/hybrid). Downstream scope resolvers read
 * it via {@link getRequestIdentity} to cross-check the `x-honeycomb-org` header against
 * the token's own org, so a forged tenancy header can never partition storage to a
 * tenant the caller's token does not bind to. Absent in `local` mode (no auth runs).
 */
export const IDENTITY_CONTEXT_KEY = "honeycombIdentity" as const;

/**
 * Read the VALIDATED {@link Identity} the permission middleware stamped onto the context
 * (team/hybrid authenticated requests), or `undefined` when none is present (local mode,
 * or an unauthenticated/legacy path). Pure — never throws. This is the trustworthy org
 * source a tenancy cross-check compares the request's `x-honeycomb-org` header against.
 */
export function getRequestIdentity(c: Context): Identity | undefined {
	const value = c.get(IDENTITY_CONTEXT_KEY) as unknown;
	return isIdentity(value) ? value : undefined;
}

/** Narrow an arbitrary context value to an {@link Identity} (defensive — the var is untyped). */
function isIdentity(value: unknown): value is Identity {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { org?: unknown }).org === "string" &&
		typeof (value as { role?: unknown }).role === "string"
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Socket-peer seam (hybrid fail-closed, c-AC-1).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A trustworthy socket-peer signal for `hybrid` mode (c-AC-1). In `hybrid`, a
 * loopback/unix-socket peer may be trusted as local, but ONLY from a real
 * transport-level signal — NEVER the `Host` header, which a client forges freely.
 * Wave 1 ships the seam + a fail-closed default ({@link noSocketPeer}); the daemon
 * assembly wires a real peer probe (deferred). Returns `true` only when the request
 * genuinely arrives from a trusted local peer.
 */
export interface SocketPeerProbe {
	/** True iff this request arrives from a transport-trusted local peer. */
	isTrustedLocalPeer(c: Context): boolean;
}

/**
 * The fail-closed default {@link SocketPeerProbe}: NO peer is ever trusted, so
 * `hybrid` always requires a token (c-AC-1). The daemon assembly swaps in a real
 * probe that inspects the actual socket; until then `hybrid` behaves like `team`.
 */
export const noSocketPeer: SocketPeerProbe = {
	isTrustedLocalPeer(): boolean {
		return false;
	},
};

// ────────────────────────────────────────────────────────────────────────────
// The new middleware options.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The injected auth dependencies (D-9). Both default fail-closed:
 *   - `authenticator` (default {@link alwaysUnauthenticated}) → no Identity → 401;
 *   - `policy` (default {@link defaultDenyPolicy}) → an authenticated caller is
 *     still `forbidden` → 403.
 * The daemon assembly injects the composed real authenticator (011b token + 011d
 * api-key) and the real RBAC policy (011c). `socketPeer` (default
 * {@link noSocketPeer}) drives the `hybrid` fail-closed peer decision (c-AC-1).
 */
export interface PermissionMiddlewareOptions {
	/** Validates presented credentials → Identity, or null → 401. Default: always-unauthenticated. */
	readonly authenticator?: Authenticator;
	/** Decides allow/forbidden for a validated Identity. Default: default-deny. */
	readonly policy?: AuthorizationPolicy;
	/** The hybrid socket-peer probe (c-AC-1). Default: trust no peer (require a token). */
	readonly socketPeer?: SocketPeerProbe;
}

/** Strip the `Bearer ` prefix from an `Authorization` header value, if present. */
function readBearer(c: Context): string | undefined {
	const raw = c.req.header("authorization");
	if (raw === undefined) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
	if (match !== null) return match[1];
	return undefined;
}

/** Read the presented credentials from the request (bearer token + `x-api-key`). */
function readPresentedCredentials(c: Context): PresentedCredentials {
	const bearer = readBearer(c);
	const apiKey = c.req.header("x-api-key");
	return {
		...(bearer !== undefined ? { bearer } : {}),
		...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
	};
}

/** True when the request presents NO credential at all (→ short-circuit to 401). */
function hasNoCredential(presented: PresentedCredentials): boolean {
	return presented.bearer === undefined && presented.apiKey === undefined;
}

/**
 * Build the permission middleware for one route group with the PRD-011 auth shape.
 * Closes over the mode accessor + the injected auth deps. The mode is read at
 * request time (a thunk), so one mounted middleware respects the running daemon's
 * mode and tests can construct daemons in different modes against the same factory.
 *
 * @param group   the route-group label (e.g. `/api/memories`) this guards.
 * @param getMode returns the daemon's current deployment mode.
 * @param options the injected `{ authenticator, policy, socketPeer }` (all default fail-closed).
 */
export function permissionMiddleware(
	group: string,
	getMode: () => DeploymentMode,
	options: PermissionMiddlewareOptions = {},
): MiddlewareHandler {
	const authenticator = options.authenticator ?? alwaysUnauthenticated;
	const policy = options.policy ?? defaultDenyPolicy;
	const socketPeer = options.socketPeer ?? noSocketPeer;

	return async (c: Context, next: Next): Promise<void | Response> => {
		const mode = getMode();

		// local mode: open. No auth, no check (c-AC-4 / a-AC-5).
		if (mode === "local") {
			await next();
			return;
		}

		const presented = readPresentedCredentials(c);

		// hybrid fail-closed (c-AC-1): with no trustworthy socket-peer signal, require
		// a token — and NEVER trust the `Host` header to decide trust. A trusted local
		// peer (real transport signal only) may pass without a token; otherwise hybrid
		// behaves exactly like team. We compute trust ONLY from the socket-peer probe.
		if (mode === "hybrid" && socketPeer.isTrustedLocalPeer(c)) {
			await next();
			return;
		}

		// team / hybrid (untrusted peer): a request with no credential is unauthenticated
		// up front — short-circuit to 401 without even calling the authenticator.
		if (hasNoCredential(presented)) {
			return unauthorized(c);
		}

		// Authenticate: the role/org/project come from the VALIDATED Identity, NEVER a
		// header. A null result is unauthenticated → 401 (c-AC-3).
		const identity: Identity | null = await authenticator.authenticate(presented);
		if (identity === null) {
			return unauthorized(c);
		}

		// Stamp the VALIDATED Identity onto the request context so downstream scope
		// resolvers can cross-check the `x-honeycomb-org` header against the token's
		// own org (PRD-022 cross-tenant hardening). The data handlers partition storage
		// by the header org; without this, an authenticated caller for org A could forge
		// `x-honeycomb-org: orgB` and read/write org B's tenant. The handlers consult
		// `c.get(IDENTITY_CONTEXT_KEY)` and reject a header that disagrees with the
		// validated org. Purely additive — no existing allow/deny path changes here.
		c.set(IDENTITY_CONTEXT_KEY, identity);

		// Authorize the validated Identity against the route context. The project comes
		// from the request (query/header is a HINT only); the policy compares it to the
		// Identity's own project binding (c-AC-5). Org/workspace are NOT taken as the
		// role source — they are the Identity's, already validated.
		const decision: AuthDecision = policy.decide(identity, {
			group,
			method: c.req.method,
			...(readProjectHint(c) !== undefined ? { project: readProjectHint(c) as string } : {}),
		});

		if (decision === "allow") {
			await next();
			return;
		}
		if (decision === "unauthenticated") {
			// A policy normally returns allow/forbidden, but if a real policy surfaces
			// `unauthenticated` we honor the 401 mapping (fail-closed either way).
			return unauthorized(c);
		}
		return forbidden(c, group);
	};
}

/**
 * Read the project the request targets as a HINT (query param `project`, else the
 * `x-honeycomb-project` header). This is NOT trusted for the role — it only names
 * which project the request acts on, so the policy can compare it to the Identity's
 * OWN project binding (c-AC-5). A mismatch is denied by the policy, never by trust.
 */
function readProjectHint(c: Context): string | undefined {
	const q = c.req.query("project");
	if (typeof q === "string" && q.length > 0) return q;
	const h = c.req.header("x-honeycomb-project");
	if (typeof h === "string" && h.length > 0) return h;
	return undefined;
}

/** The 401 response: no valid credential. Carries no token, no detail that leaks. */
function unauthorized(c: Context): Response {
	return c.json({ error: "unauthorized" }, 401);
}

/** The 403 response: authenticated but not permitted on this group. */
function forbidden(c: Context, group: string): Response {
	return c.json({ error: "forbidden", reason: "permission denied", group }, 403);
}

// ────────────────────────────────────────────────────────────────────────────
// LEGACY 004a seam — retained as an opt-in adapter (do NOT use in new code).
// ────────────────────────────────────────────────────────────────────────────

/** The minimal auth context the LEGACY {@link PermissionCheck} sees. No token is exposed. */
export interface PermissionContext {
	/** The role asserted by the request, if any (LEGACY: resolved from a header). */
	readonly role?: string;
	/** The resolved org, if any. */
	readonly org?: string;
	/** The resolved workspace, if any. */
	readonly workspace?: string;
	/** The agent scope asserted by the request, if any. */
	readonly agent?: string;
	/** The route group label this check guards. */
	readonly group: string;
}

/**
 * The LEGACY 004a policy seam: given a header-resolved context, return whether the
 * request is permitted. RETAINED so the 004a server tests stay green; PRD-011 code
 * uses {@link permissionMiddleware} with an {@link Authenticator}/{@link AuthorizationPolicy}
 * instead. Sync or async.
 *
 * @deprecated Use the {@link Authenticator} + {@link AuthorizationPolicy} seams. A
 * header-resolved role is a privilege-escalation bypass; this exists only for the
 * 004a compatibility surface and is gated behind {@link legacyPermissionCheckAdapter}.
 */
export type PermissionCheck = (ctx: PermissionContext) => boolean | Promise<boolean>;

/**
 * The default-deny LEGACY check (the 004a stub). No role is recognized, so every
 * `team`/`hybrid` request is denied — the fail-closed posture a missing policy must
 * keep. Retained for the 004a compatibility path.
 */
export const defaultDenyPermissionCheck: PermissionCheck = () => false;

/** Read the LEGACY header-resolved {@link PermissionContext} (004a compatibility only). */
function resolveLegacyContext(c: Context, group: string): PermissionContext {
	const header = (name: string): string | undefined => {
		const v = c.req.header(name);
		return v !== undefined && v.length > 0 ? v : undefined;
	};
	return {
		role: header("x-honeycomb-role"),
		org: header("x-honeycomb-org"),
		workspace: header("x-honeycomb-workspace"),
		agent: header("x-honeycomb-agent"),
		group,
	};
}

/**
 * Adapt a LEGACY {@link PermissionCheck} into a {@link MiddlewareHandler} preserving
 * EXACT 004a semantics: `local` open; `team`/`hybrid` run the check on the
 * header-resolved context, denying with 403 (the 004a test contract). This is the
 * one place the spoofable-header path still lives, isolated and opt-in so the 004a
 * suite keeps passing while PRD-011's real gate is the default everywhere else.
 *
 * Do NOT use this in new code — it is a privilege-escalation surface by design
 * (header-asserted role). It exists solely so the migration is non-breaking.
 */
export function legacyPermissionCheckAdapter(
	group: string,
	getMode: () => DeploymentMode,
	check: PermissionCheck = defaultDenyPermissionCheck,
): MiddlewareHandler {
	return async (c: Context, next: Next): Promise<void | Response> => {
		const mode = getMode();
		if (mode === "local") {
			await next();
			return;
		}
		const permitted = await check(resolveLegacyContext(c, group));
		if (!permitted) {
			return forbidden(c, group);
		}
		await next();
	};
}
