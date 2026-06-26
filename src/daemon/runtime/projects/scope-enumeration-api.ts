/**
 * The dashboard SCOPE-SWITCHER enumeration endpoints — PRD-049e (49e-AC-1 / 49e-AC-3).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * Three loopback, LOCAL-MODE-ONLY GET reads the dashboard's Org→Workspace→Project switcher
 * (`src/dashboard/web/scope-context.tsx` → the filled `ScopeSwitcherSlot`) hydrates from:
 *
 *   GET /api/diagnostics/scope/orgs                    → the user's orgs (`GET /organizations`)
 *   GET /api/diagnostics/scope/workspaces?org=<id>     → that org's workspaces (`GET /workspaces`)
 *   GET /api/diagnostics/scope/projects                → the workspace's registry projects (049a cache)
 *
 * All three are scoped to the user's PRIVILEGES by the backend: `listOrgs`/`listWorkspaces` return
 * only what the authenticated token can see (49e-AC-1), and the projects read is the workspace's
 * synced `~/.deeplake/projects.json` registry copy (the daemon's own resolved tenancy) — nothing the
 * user lacks access to appears.
 *
 * ── 49e-AC-3: the Org change re-mints BEFORE enumerating the new org ─────────
 * The persisted credential's bearer token is bound to ONE org (PRD-011 mint). To enumerate a
 * DIFFERENT org's workspaces the token must first be re-minted bound to that org (`reMint`, the
 * PRD-011 mechanic). So when the requested `?org=` differs from the credential's own `orgId`, the
 * workspaces handler RE-MINTS an org-bound token FIRST, then calls `listWorkspaces` with it — the
 * re-mint strictly precedes the enumeration (the suite asserts the call order). When the requested
 * org matches the credential org, no re-mint is needed (the existing token is already bound).
 *
 * ── Local-mode only + the token is sacred (D-4 / security F-1) ───────────────
 * These attach onto the already-mounted, protected `/api/diagnostics` group (NO `server.ts` edit),
 * but they ALSO self-gate to `local` mode (a non-local request 404s) — the dashboard is a local-mode
 * loopback surface (mirrors `mountAuthStatusApi`/`mountSetupStateApi`). The bearer token resolved from
 * `~/.deeplake/credentials.json` rides ONLY in the `Authorization` header inside the auth client; it
 * is NEVER returned in a body, logged, or echoed. The response bodies are id+name lists only.
 *
 * ── Fail-soft, never a 500 ───────────────────────────────────────────────────
 * No credential / no token → a clean empty list (the switcher renders an empty/needs-login state).
 * An auth-API error (network/4xx/5xx) → an empty list with a redacted `error` reason (never the
 * token, never a 500 that crashes the page). The projects read is the already-fail-soft 049d sync +
 * the fail-soft cache reader, so a registry-read miss returns whatever the prior cache held.
 */

import type { Context } from "hono";

import type { DeploymentMode } from "../config.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import {
	type DeeplakeAuthClient,
	createDeeplakeAuthClient,
	resolveApiUrl,
} from "../auth/deeplake-issuer.js";
import { loadDiskCredentials } from "../auth/credentials-store.js";
import { getRequestIdentity } from "../middleware/permission.js";
import { loadProjectsCache } from "../../../hooks/shared/index.js";
import { syncRegistryToCache } from "./registry-sync.js";

/** The route group the scope-enumeration reads attach to (already mounted + protected in `server.ts`). */
export const SCOPE_ENUM_GROUP = "/api/diagnostics" as const;

/** The orgs enumeration route (full path `/api/diagnostics/scope/orgs`). */
export const SCOPE_ORGS_PATH = "/scope/orgs" as const;
/** The workspaces enumeration route (full path `/api/diagnostics/scope/workspaces`). */
export const SCOPE_WORKSPACES_PATH = "/scope/workspaces" as const;
/** The projects enumeration route (full path `/api/diagnostics/scope/projects`). */
export const SCOPE_PROJECTS_PATH = "/scope/projects" as const;

/** One enumerated org (id + display name). NO token by construction. */
export interface ScopeOrg {
	readonly id: string;
	readonly name: string;
}

/** One enumerated workspace (id + display name). NO token by construction. */
export interface ScopeWorkspace {
	readonly id: string;
	readonly name: string;
}

/** One enumerated project (the registry copy the switcher lists). NO token by construction. */
export interface ScopeProject {
	readonly projectId: string;
	readonly name: string;
	/**
	 * PRD-059d: true when this registry project has NO local folder binding on THIS device — i.e. it is
	 * IMPORTABLE (created on another device, not yet attached here). The dashboard "Import project from
	 * cloud" list (059d) shows the `boundLocally:false` projects; the Projects page (059c) shows the
	 * `boundLocally:true` ones. Computed from the local `bindings[]` the resolver reads.
	 */
	readonly boundLocally: boolean;
}

/** `GET /scope/orgs` body. `orgs` is empty when no credential resolves; `error` is a redacted reason. */
export interface ScopeOrgsBody {
	readonly orgs: readonly ScopeOrg[];
	readonly error?: string;
}

/** `GET /scope/workspaces` body. `remintedForOrg` echoes the org a re-mint bound to (49e-AC-3 observ.). */
export interface ScopeWorkspacesBody {
	readonly workspaces: readonly ScopeWorkspace[];
	/** The org the workspaces were enumerated for (echoed for the switcher). */
	readonly org: string;
	/** True when an org-bound token re-mint ran BEFORE enumeration (the org differed from the credential). */
	readonly reminted: boolean;
	readonly error?: string;
}

/** `GET /scope/projects` body. `projects` is the workspace's synced registry copy (049a). */
export interface ScopeProjectsBody {
	readonly projects: readonly ScopeProject[];
	/** The org/workspace the projects belong to (echoed for the switcher). */
	readonly org: string;
	readonly workspace: string;
}

/** Options for {@link mountScopeEnumerationApi}. All seams injectable for deterministic tests. */
export interface MountScopeEnumerationOptions {
	/** The live storage client the projects read syncs the registry through (never a raw fetch). */
	readonly storage: StorageQuery;
	/** The daemon's own default tenancy (the loopback projects read scopes to it when no header is sent). */
	readonly defaultScope: QueryScope;
	/** Override the credentials directory (tests). Defaults to `~/.deeplake`. */
	readonly credentialsDir?: string;
	/** Override the projects-cache directory (tests). Defaults to `~/.deeplake`. */
	readonly projectsDir?: string;
	/** The env the apiUrl/token rules read (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The auth-client factory (the `api.deeplake.ai` adapter). Defaults to the REAL
	 * {@link createDeeplakeAuthClient}; a test injects a fake that records the call order
	 * (so the 49e-AC-3 reMint-before-listWorkspaces assertion is deterministic) without a network.
	 */
	readonly authClientFactory?: (apiUrl: string) => DeeplakeAuthClient;
}

/** A resolved token + its bound org + the apiUrl, or `null` when no usable credential exists. */
interface ResolvedToken {
	readonly token: string;
	readonly org: string;
	readonly apiUrl: string;
}

/**
 * Resolve the daemon's persisted bearer token + its bound org (PRD-049e). Reads the SAME
 * `~/.deeplake/credentials.json` the daemon connects through ({@link loadDiskCredentials}, which
 * applies the `HONEYCOMB_TOKEN` env rule). Returns `null` when no usable credential (no token)
 * exists — the handlers then answer a clean empty list (never a 500). The token NEVER leaves this
 * module except in the auth client's `Authorization` header.
 */
function resolveToken(opts: MountScopeEnumerationOptions): ResolvedToken | null {
	const env = opts.env ?? process.env;
	const disk = loadDiskCredentials(opts.credentialsDir, env);
	if (disk === null || disk.token.length === 0) return null;
	const apiUrl = disk.apiUrl !== undefined && disk.apiUrl.length > 0 ? disk.apiUrl : resolveApiUrl(env);
	return { token: disk.token, org: disk.orgId, apiUrl };
}

/** A redacted reason for a failed auth-API call — the status/message, NEVER the token (D-4). */
function redactedReason(err: unknown): string {
	if (err instanceof Error) return err.message.slice(0, 200);
	return String(err).slice(0, 200);
}

/**
 * Attach the three scope-enumeration reads onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (PRD-049e). Call ONCE after `createDaemon(...)`; the composition root fires
 * it under the LOCAL-mode gate (mirroring the other dashboard read mounts). If the group is not
 * mounted the attach is a no-op. Every handler self-gates to local mode (a non-local request 404s) and
 * is fail-soft — an auth-API failure yields a clean empty list with a redacted reason, never a 500.
 */
export function mountScopeEnumerationApi(daemon: Daemon, options: MountScopeEnumerationOptions): void {
	const group = daemon.group(SCOPE_ENUM_GROUP);
	if (group === undefined) return;
	const mode: DeploymentMode = daemon.config.mode;
	const makeClient = options.authClientFactory ?? ((apiUrl: string) => createDeeplakeAuthClient({ apiUrl }));

	const notLocal = (c: Context): boolean => mode !== "local";

	// ── 49e-AC-1: GET /scope/orgs → the user's orgs (scoped to the token's privileges). ──
	group.get(SCOPE_ORGS_PATH, async (c) => {
		if (notLocal(c)) return c.json({ error: "not_found" }, 404);
		const resolved = resolveToken(options);
		if (resolved === null) {
			const body: ScopeOrgsBody = { orgs: [] };
			return c.json(body);
		}
		try {
			const client = makeClient(resolved.apiUrl);
			const rows = await client.listOrgs(resolved.token);
			const orgs: ScopeOrg[] = rows.map((o) => ({ id: o.id, name: o.name }));
			const body: ScopeOrgsBody = { orgs };
			return c.json(body);
		} catch (err: unknown) {
			const body: ScopeOrgsBody = { orgs: [], error: redactedReason(err) };
			return c.json(body);
		}
	});

	// ── 49e-AC-1 / 49e-AC-3: GET /scope/workspaces?org=<id> → that org's workspaces. ──
	// When the requested org differs from the credential's bound org, RE-MINT an org-bound
	// token FIRST (PRD-011), THEN enumerate — the re-mint strictly precedes the enumeration.
	group.get(SCOPE_WORKSPACES_PATH, async (c) => {
		if (notLocal(c)) return c.json({ error: "not_found" }, 404);
		const resolved = resolveToken(options);
		const requestedOrg = (c.req.query("org") ?? "").trim();
		// The org to enumerate: the explicit `?org=` wins; else the credential's own bound org.
		const targetOrg = requestedOrg.length > 0 ? requestedOrg : resolved?.org ?? "";
		if (resolved === null) {
			const body: ScopeWorkspacesBody = { workspaces: [], org: targetOrg, reminted: false };
			return c.json(body);
		}
		try {
			const client = makeClient(resolved.apiUrl);
			// 49e-AC-3: re-mint BEFORE enumeration when switching to a different org (the persisted
			// token is bound to `resolved.org`). A same-org request reuses the existing token.
			let token = resolved.token;
			let reminted = false;
			if (targetOrg.length > 0 && targetOrg !== resolved.org) {
				token = await client.reMint(resolved.token, targetOrg);
				reminted = true;
			}
			const rows = await client.listWorkspaces(token, targetOrg.length > 0 ? targetOrg : undefined);
			const workspaces: ScopeWorkspace[] = rows.map((w) => ({ id: w.id, name: w.name }));
			const body: ScopeWorkspacesBody = { workspaces, org: targetOrg, reminted };
			return c.json(body);
		} catch (err: unknown) {
			const body: ScopeWorkspacesBody = { workspaces: [], org: targetOrg, reminted: false, error: redactedReason(err) };
			return c.json(body);
		}
	});

	// ── 49e-AC-1: GET /scope/projects → the workspace's registry projects (049a cache). ──
	// Refresh the local `projects.json` from the workspace registry (fail-soft 049d sync), then read
	// the cache. The projects shown are the workspace's own registry copy — privilege-scoped by the
	// daemon's resolved tenancy (a user can only reach the workspace its credential partitions to).
	group.get(SCOPE_PROJECTS_PATH, async (c) => {
		if (notLocal(c)) return c.json({ error: "not_found" }, 404);
		const scope = resolveProjectsScope(c, options.defaultScope);
		// Best-effort refresh (fail-soft): a registry-read miss leaves the prior cache intact.
		await syncRegistryToCache({
			storage: options.storage,
			scope,
			...(options.projectsDir !== undefined ? { dir: options.projectsDir } : {}),
		});
		const cache = loadProjectsCache(options.projectsDir);
		// PRD-059d: a project is "bound locally on this device" when a local folder→project binding
		// targets it (the resolver's `bindings[]`), so the dashboard can split ACTIVE (boundLocally) from
		// IMPORTABLE (registry-only, no local binding). `?unbound=1` filters to the importable set (the
		// 059d "Import project from cloud" list) — registry projects with no local binding on this device.
		const locallyBound = new Set(cache.bindings.map((b) => b.projectId));
		const unboundOnly = (c.req.query("unbound") ?? "") === "1";
		const projects: ScopeProject[] = cache.projects
			.map((p) => ({ projectId: p.projectId, name: p.name, boundLocally: locallyBound.has(p.projectId) }))
			.filter((p) => (unboundOnly ? !p.boundLocally : true));
		const body: ScopeProjectsBody = {
			projects,
			org: scope.org,
			workspace: scope.workspace ?? "",
		};
		return c.json(body);
	});
}

/**
 * Resolve the tenancy the projects read syncs/reads under: the `x-honeycomb-org` (+ optional
 * `x-honeycomb-workspace`) header when present, else the daemon's loopback `defaultScope`. Mirrors
 * `resolveSyncScope` in `sync-api.ts` (the shared local-mode loopback idiom).
 *
 * Cross-tenant hardening (PRD-022 / PRD-049e): this handler self-gates to local mode (a non-local
 * request 404s before reaching here), so in practice no validated Identity is ever present. But the
 * guard is applied for consistency with `resolveSyncScope` / {@link import("../scope.js").resolveScopeFromHeaders}:
 * a header org that disagrees with a validated token org is NEVER honored — it falls back to the
 * daemon's own `defaultScope` rather than letting a forged tenancy header steer the read.
 */
function resolveProjectsScope(c: Context, defaultScope: QueryScope): QueryScope {
	const org = c.req.header("x-honeycomb-org");
	if (org !== undefined && org.length > 0) {
		const identity = getRequestIdentity(c);
		if (identity === undefined || org === identity.org) {
			const workspace = c.req.header("x-honeycomb-workspace");
			return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
		}
	}
	return defaultScope;
}
