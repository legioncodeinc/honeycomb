/**
 * The `/api/auth/status` read-model — PRD-044a (the Settings page DeepLake-auth section).
 *
 * ── The one rule that defines this surface: THE TOKEN IS SACRED ───────────────
 * This handler reports, TRUTHFULLY, what the daemon is connected to DeepLake as — and it
 * carries NO `token` field BY CONSTRUCTION. The redacted body is metadata only:
 *
 *   { connected, orgId, orgName, workspace, agentId, source, savedAt, expiresAt? }
 *
 * There is no code path here that reads `creds.token` into the response. `source` is
 * `"env"` when `HONEYCOMB_TOKEN` is set, `"file"` when the credential resolved from
 * `~/.deeplake/credentials.json` (or the legacy fallback), and `"none"` when nothing
 * resolves. `expiresAt` is present ONLY when a real `TokenClaims.exp` exists
 * ({@link verifyTokenClaims}) — it is NEVER fabricated; absent → the page shows
 * "expiry unknown".
 *
 * ── Where it mounts (OQ-3: the loopback session must not trip the role guard) ──
 * `/api/auth` is a PROTECTED group declared in `server.ts` (`{ path: "/api/auth", protect:
 * true }`) with NO handlers today. We ATTACH this one read via `daemon.group("/api/auth")`,
 * the same seam `mountSettingsApi`/`mountSecretsApi` use — ZERO edit to the group decl. The
 * read is GATED to `local` mode: in local the loopback `dashboard-web` viewer is effectively
 * the single tenant and the permission middleware is open by design, so the status read never
 * trips a cross-tenant/role guard. A non-local request yields a clean disconnected body
 * (`{ connected: false, source: "none", … }`) — never a 500, never a token, never another
 * tenant's identity (OQ-3). This is STATUS-FIRST (OQ-1 RESOLVED): there is NO in-page
 * `/api/auth/login` device-flow this slice — the connect affordance hands off to the
 * `honeycomb login` CLI and the page re-reads this endpoint on focus/poll.
 *
 * ── Why `loadCredentials`, not `resolveTenancy` ──────────────────────────────
 * The status view describes the PERSISTED identity (org/workspace/agent/source/savedAt) the
 * daemon would connect as. {@link loadCredentials} returns exactly that (applying the
 * `HONEYCOMB_TOKEN` env rule) WITHOUT running the integrity gate — so a status read never
 * throws a `TenancyIntegrityError` into the page; a present-but-conflicting credential still
 * reports its file identity honestly. `expiresAt` is read separately + defensively from the
 * token claim (the ONLY use of the token here — to decode its `exp`, never to echo it).
 */

import type { Context, Hono } from "hono";

import type { DeploymentMode } from "../config.js";
import type { Daemon } from "../server.js";
import { verifyTokenClaims } from "./contracts.js";
import { ENV_TOKEN, loadCredentials } from "./credentials-store.js";
import { resolveTenancyConfirmation } from "./tenancy-confirmation.js";

/** The route group the auth read-model attaches to (declared + protected in `server.ts`). */
export const AUTH_GROUP = "/api/auth" as const;

/** Where the resolved credential came from — `env` token wins, else the file, else nothing. */
export type AuthStatusSource = "env" | "file" | "none";

/**
 * The REDACTED auth-status body the page reads (PRD-044a). Metadata ONLY — there is no
 * `token` field by construction. `expiresAt` is present only when a real `TokenClaims.exp`
 * exists (never fabricated). A disconnected daemon reports `connected: false` + `source:
 * "none"` with empty identity fields.
 */
export interface AuthStatusBody {
	/** True iff a usable credential resolved (a token + org are present). */
	readonly connected: boolean;
	/** The org id the credential is bound to (empty when disconnected). */
	readonly orgId: string;
	/** The human-readable org name (display only; falls back to the org id). */
	readonly orgName: string;
	/** The active workspace id (empty when disconnected). */
	readonly workspace: string;
	/** The within-workspace agent id (empty when disconnected). */
	readonly agentId: string;
	/** Where the credential came from: `env` (HONEYCOMB_TOKEN), `file`, or `none`. */
	readonly source: AuthStatusSource;
	/** ISO timestamp the credential was last saved (empty when disconnected/unknown). */
	readonly savedAt: string;
	/** Token expiry (epoch seconds) — ONLY when a real `TokenClaims.exp` exists; never faked. */
	readonly expiresAt?: number;
	/**
	 * PRD-073c: whether the active tenancy is CONFIRMED — an explicit link-time selection stamped the
	 * marker, OR a pre-073 credential is grandfathered by its non-empty orgId (parent AC-5). The
	 * dashboard header reads this to show "org X / workspace Y (confirmed)".
	 */
	readonly tenancyConfirmed: boolean;
	/** PRD-073c: the explicit-selection marker timestamp — present ONLY for an explicitly-selected credential. */
	readonly tenancyConfirmedAt?: string;
}

/** The honest disconnected body — never a blank panel, never a fabricated org (044a). */
export const DISCONNECTED_STATUS: AuthStatusBody = Object.freeze({
	connected: false,
	orgId: "",
	orgName: "",
	workspace: "",
	agentId: "",
	source: "none",
	savedAt: "",
	tenancyConfirmed: false,
});

/** Deps for {@link mountAuthStatusApi}. Everything injected for testability. */
export interface AuthStatusApiDeps {
	/**
	 * The credentials directory override (tests point this at a temp `~/.deeplake`). Absent →
	 * the real shared credentials dir. Mirrors {@link loadCredentials}'s `dir` parameter.
	 */
	readonly credentialsDir?: string;
	/** The env to read the `HONEYCOMB_TOKEN` source + the token from (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the REDACTED {@link AuthStatusBody} from the persisted credentials (PRD-044a).
 *
 * Pure-ish (its only IO is the credentials-file read via {@link loadCredentials}, which never
 * throws): a missing/malformed credential yields {@link DISCONNECTED_STATUS}. The token is
 * decoded ONLY to read its `exp` claim ({@link verifyTokenClaims}) — never echoed. When no
 * `exp` claim exists (the Wave-1 stub), `expiresAt` is OMITTED (the page shows "expiry
 * unknown"), never fabricated. `source` is `env` when `HONEYCOMB_TOKEN` is set, else `file`.
 */
export function resolveAuthStatus(deps: AuthStatusApiDeps = {}): AuthStatusBody {
	const env = deps.env ?? process.env;
	const creds = loadCredentials(deps.credentialsDir, env);
	if (creds === null) return DISCONNECTED_STATUS;

	// The env token wins (b-AC-5) — so the SOURCE is `env` when HONEYCOMB_TOKEN is set, even
	// though the file's identity (org/workspace) still describes the active tenancy.
	const envToken = env[ENV_TOKEN];
	const source: AuthStatusSource = typeof envToken === "string" && envToken.length > 0 ? "env" : "file";

	// Decode the token's claims ONLY to read `exp` — the token itself never crosses into the
	// body. `verifyTokenClaims` is total (null on any bad token), so this never throws.
	const claims = verifyTokenClaims(creds.token);
	const expiresAt = claims !== null && typeof claims.exp === "number" ? claims.exp : undefined;

	// PRD-073c: the confirmed-tenancy state read from the SAME persisted credential (marker OR
	// grandfathered non-empty orgId). Never throws; never reads the token into the body.
	const confirmation = resolveTenancyConfirmation({
		...(deps.credentialsDir !== undefined ? { credentialsDir: deps.credentialsDir } : {}),
		env,
	});

	return {
		connected: true,
		orgId: creds.orgId,
		orgName: creds.orgName,
		workspace: creds.workspace,
		agentId: creds.agentId,
		source,
		savedAt: creds.savedAt,
		...(expiresAt !== undefined ? { expiresAt } : {}),
		tenancyConfirmed: confirmation.confirmed,
		...(confirmation.confirmedAt !== undefined ? { tenancyConfirmedAt: confirmation.confirmedAt } : {}),
	};
}

/**
 * Mount the `GET /api/auth/status` read onto a route group (PRD-044a). Call AFTER
 * `createDaemon(...)` with `daemon.group("/api/auth")` so the handler inherits the
 * already-mounted auth/RBAC middleware. The single route is registered relative to the group
 * base (`/status`).
 *
 * OQ-3: the read is GATED to `local` mode. A non-local request returns the clean
 * {@link DISCONNECTED_STATUS} (200) rather than another tenant's identity or a 500 — the
 * dashboard is a local-mode loopback surface, so there is no team/hybrid status to serve here.
 */
export function mountAuthStatusGroup(group: Hono, mode: DeploymentMode, deps: AuthStatusApiDeps = {}): void {
	group.get("/status", (c: Context) => {
		// OQ-3: outside local mode the loopback status read returns a clean disconnected body —
		// never another tenant's identity, never a 500. The dashboard is local-mode only.
		if (mode !== "local") return c.json(DISCONNECTED_STATUS);
		return c.json(resolveAuthStatus(deps));
	});
}

/**
 * Resolve `/api/auth` and mount the status read (the assembly seam). Mirrors
 * `mountSettingsApi(daemon, deps)`: resolves the protected group and delegates. A no-op when
 * the group is not mounted (unknown daemon shape).
 */
export function mountAuthStatusApi(daemon: Daemon, deps: AuthStatusApiDeps = {}): void {
	const group = daemon.group(AUTH_GROUP);
	if (group === undefined) return;
	mountAuthStatusGroup(group, daemon.config.mode, deps);
}
