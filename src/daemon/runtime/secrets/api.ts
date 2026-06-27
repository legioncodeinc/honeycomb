/**
 * The names-only `/api/secrets` API — PRD-012a (a-AC-2 / a-AC-5 / FR-5 / FR-6).
 *
 * ── The one rule that defines this surface ───────────────────────────────────
 * NAMES are exposed; VALUES are exposed NOWHERE. This module mounts exactly three
 * routes and DELIBERATELY mounts NO value-returning route:
 *
 *   - `GET    /api/secrets`        → list NAMES only (a-AC-2);
 *   - `POST   /api/secrets/:name`  → store (body carries the value; nothing is returned but ok);
 *   - `DELETE /api/secrets/:name`  → delete.
 *
 * There is NO `GET /api/secrets/:name` and no other value-returning endpoint, by design
 * (a-AC-2 / a-AC-5 / FR-6). A probe to `GET /api/secrets/:name` simply does not match a
 * route → 404. The decrypt path ({@link "./store.js"}'s `getSecretValue` / the
 * `SecretResolver`) is INTERNAL (router-only) and is never wired to a handler here.
 *
 * The 012b surfaces — `POST /exec`, `GET /exec/:jobId`, `…/bitwarden/*`,
 * `…/1password/*` — are mounted as honest `notImplemented` (501) stubs so a premature
 * call fails loud with the owning sub-PRD; they accept NO value-returning shape either.
 *
 * ── Where it mounts ──────────────────────────────────────────────────────────
 * `/api/secrets` is a PROTECTED group (server.ts ROUTE_GROUPS: `protect: true`). The
 * bootstrap already mounted the PRD-011 permission middleware ahead of it, so attaching
 * handlers via `daemon.group("/api/secrets")` inherits auth/RBAC with ZERO re-wiring —
 * the secrets capability is grantable and every request is already authenticated +
 * authorized before a handler runs. No edit to `server.ts`.
 *
 * Scope is resolved per-request via an injected {@link ScopeResolver} seam (default: the
 * `x-honeycomb-*` header reader the rest of the daemon uses), so the assembly step can
 * later swap in the Identity-derived scope without touching the handlers.
 */

import type { Context } from "hono";
import type { Hono } from "hono";

import type { DeploymentMode } from "../config.js";
import type { QueryScope } from "../../storage/client.js";
import type { SecretScope } from "./contracts.js";
import type { SecretExecRequest, SecretExecRunner } from "./exec.js";
import type { SecretsStore } from "./store.js";
import { getRequestIdentity } from "../middleware/permission.js";

/** The route group the secrets API attaches to (FR-5). */
export const SECRETS_GROUP = "/api/secrets" as const;

/**
 * Resolve the {@link SecretScope} for a request (a-AC-6). The default reads the
 * `x-honeycomb-*` headers (the same tenancy the rest of the daemon reads); the assembly
 * step can inject an Identity-derived resolver later. Returns `null` when the request
 * carries no usable org → the handler 400s (fail-closed; a request without a tenancy
 * never falls back to a broad scope).
 */
export interface ScopeResolver {
	/** Resolve the scope, or `null` if the request has no resolvable tenancy. */
	resolve(c: Context): SecretScope | null;
}

/**
 * A scope resolver that reads the `x-honeycomb-*` headers first and, ONLY in `local` mode,
 * falls back to the daemon's configured `defaultScope` when the request carries no tenancy
 * header (PRD-022 local-mode default). This is the SAME precedence the data-API mounts use
 * via {@link import("../scope.js").resolveScopeOrLocalDefault} — header → (local) default →
 * null/400. It exists because the dashboard web app is a loopback thin client that sends NO
 * `x-honeycomb-org` header; without this fallback the `/api/settings` + `/api/secrets` reads
 * 400 in local mode (the empty Settings page bug). In team/hybrid the fallback never fires
 * (a missing org still 400s fail-closed), so cross-tenant access stays rejected at the edge.
 */
export function localDefaultScopeResolver(
	mode: DeploymentMode,
	defaultScope: QueryScope | undefined,
): ScopeResolver {
	return {
		resolve(c: Context): SecretScope | null {
			const fromHeader = headerScopeResolver.resolve(c);
			if (fromHeader !== null) return fromHeader;
			if (mode === "local" && defaultScope !== undefined) {
				return { org: defaultScope.org, workspace: defaultScope.workspace ?? "default" };
			}
			return null;
		},
	};
}

/**
 * The default header-based scope resolver (mirrors capture-handler's tenancy read).
 *
 * Cross-tenant hardening (PRD-022): when a validated Identity is present (team/hybrid
 * authenticated requests), the resolved org MUST equal `identity.org`. A forged
 * `x-honeycomb-org` header that disagrees with the token's own org returns `null` →
 * the handler fails closed (400). This prevents an authenticated caller for org A from
 * writing secrets under org B's namespace by forging the tenancy header. In local mode
 * no Identity is stamped, so the prior pure-header behaviour is unchanged.
 */
export const headerScopeResolver: ScopeResolver = {
	resolve(c: Context): SecretScope | null {
		const org = c.req.header("x-honeycomb-org");
		if (org === undefined || org.length === 0) return null;
		// Cross-tenant guard: a forged org header can never cross the token's own org boundary.
		const identity = getRequestIdentity(c);
		if (identity !== undefined && org !== identity.org) return null;
		const workspace = c.req.header("x-honeycomb-workspace");
		const agentId = c.req.header("x-honeycomb-agent");
		const ws = workspace !== undefined && workspace.length > 0 ? workspace : "default";
		return agentId !== undefined && agentId.length > 0
			? { org, workspace: ws, agentId }
			: { org, workspace: ws };
	},
};

/** Construction deps for the secrets API. Everything injected for testability. */
export interface SecretsApiDeps {
	/** The machine-bound store the handlers read/write through. */
	readonly store: SecretsStore;
	/** The per-request scope resolver (default: header-based). */
	readonly scope?: ScopeResolver;
	/**
	 * The `secret_exec` runner (PRD-012b). When PRESENT, the `POST /exec` + `GET /exec/:jobId`
	 * routes become real handlers (202 submit + redacted scoped status). When ABSENT, those
	 * routes stay honest 501 stubs (the deferred-assembly posture — the running daemon injects
	 * the runner at assembly, the same way the store is constructed-then-injected). The
	 * `bitwarden/*` + `1password/*` routes resolve vault refs BY REFERENCE inside an exec
	 * submission's `vaultRefs`, so there is no separate value-returning vault route by design.
	 */
	readonly execRunner?: SecretExecRunner;
}

/**
 * Mount the names-only secrets API onto a route group (a-AC-2 / a-AC-5 / FR-5 / FR-6).
 *
 * Call AFTER `createDaemon(...)` with `daemon.group("/api/secrets")` so the handlers
 * inherit the already-mounted auth/RBAC middleware. The three real routes are registered
 * RELATIVE to the group base (`/`, `/:name`); the 012b routes are mounted as 501 stubs.
 *
 * CRITICAL: there is NO `group.get("/:name", …)`. The absence is the security property.
 */
export function mountSecretsApi(group: Hono, deps: SecretsApiDeps): void {
	const scope = deps.scope ?? headerScopeResolver;
	const store = deps.store;
	const runner = deps.execRunner;

	// ── 012b exec routes — registered FIRST so the static `/exec` + vault paths win over the
	// parametric `/:name` route below (Hono matches in registration order, so a
	// `POST /api/secrets/exec` must reach the exec handler, NOT `setSecret(name="exec")`).
	//
	// CRITICAL invariant preserved: NONE of these returns a decrypted value. `POST /exec`
	// accepts secret NAMES + vault REFs (never a value), queues a job, and returns 202 + a
	// jobId. `GET /exec/:jobId` returns a REDACTED, scope-checked status. The vault routes
	// resolve BY REFERENCE inside a submission's `vaultRefs` (b-AC-4) — there is deliberately
	// no value-returning vault GET.
	if (runner !== undefined) {
		// POST /api/secrets/exec — submit a job → 202 + jobId (b-AC-1 / b-AC-6).
		group.post("/exec", async (c) => {
			const sc = scope.resolve(c);
			if (sc === null) return badTenancy(c);
			const request = await readExecRequest(c, sc);
			if (request === null) {
				return c.json({ error: "bad_request", reason: "exec body must carry a command" }, 400);
			}
			const res = runner.submit(request);
			if (!res.ok) {
				if (res.reason === "queue_full") {
					// The DoS bound (b-AC-6): the pool + queue are full → 429, never an unbounded spawn.
					return c.json({ error: "queue_full", reason: "exec pool and queue are at capacity" }, 429);
				}
				return c.json({ error: "bad_request", reason: "invalid exec request" }, 400);
			}
			// 202 Accepted: the job is QUEUED; the caller polls GET /exec/:jobId for the result.
			return c.json({ ok: true, jobId: res.jobId, status: "queued" }, 202);
		});

		// GET /api/secrets/exec/:jobId — redacted, scope-checked status (b-AC-3 / FR-8).
		group.get("/exec/:jobId", (c) => {
			const sc = scope.resolve(c);
			if (sc === null) return badTenancy(c);
			const jobId = c.req.param("jobId");
			const view = runner.getStatus(jobId, sc);
			if (view === null) {
				// Unknown OR a different scope's job → 404 (a job id is not a cross-scope oracle).
				return c.json({ error: "not_found", reason: "no such exec job" }, 404);
			}
			// The view is redacted by construction — stdout/stderr already have every value masked.
			return c.json(view);
		});

		// Vault provider routes: resolution is BY REFERENCE inside an exec submission's
		// `vaultRefs` (b-AC-4), so these document the seam and never return a value. A direct
		// hit returns guidance, not a credential.
		group.all("/bitwarden/*", (c) =>
			c.json({ error: "use_exec", reason: "reference a Bitwarden item via exec vaultRefs; values are never returned" }, 400),
		);
		group.all("/1password/*", (c) =>
			c.json({ error: "use_exec", reason: "reference a 1Password item via exec vaultRefs; values are never returned" }, 400),
		);
	} else {
		// Deferred-assembly posture: no runner wired yet → honest 501 stubs so a premature call
		// fails loud with the owning sub-PRD rather than silently 404-ing. They accept NO
		// value-returning shape either.
		group.post("/exec", (c) => notImplementedRoute(c, "POST /api/secrets/exec (secret_exec)"));
		group.get("/exec/:jobId", (c) => notImplementedRoute(c, "GET /api/secrets/exec/:jobId (exec status)"));
		group.all("/bitwarden/*", (c) => notImplementedRoute(c, "Bitwarden vault provider"));
		group.all("/1password/*", (c) => notImplementedRoute(c, "1Password vault provider"));
	}

	// GET /api/secrets — list NAMES only (a-AC-2). Never a value.
	group.get("/", (c) => {
		const sc = scope.resolve(c);
		if (sc === null) return badTenancy(c);
		const names = store.listSecretNames(sc);
		return c.json({ names });
	});

	// POST /api/secrets/:name — store. The value arrives in the body and is NEVER echoed.
	group.post("/:name", async (c) => {
		const sc = scope.resolve(c);
		if (sc === null) return badTenancy(c);
		const name = c.req.param("name");
		const value = await readValue(c);
		if (value === null) {
			return c.json({ error: "bad_request", reason: "request body must carry a string value" }, 400);
		}
		const res = await store.setSecret(name, value, sc);
		if (!res.ok) {
			if (res.reason === "invalid_name") {
				return c.json({ error: "bad_request", reason: "invalid secret name" }, 400);
			}
			return c.json({ error: "store_failed", reason: "could not store the secret" }, 502);
		}
		// 201 carries the NAME back (it is public) and NOTHING else — never the value.
		return c.json({ ok: true, name }, 201);
	});

	// DELETE /api/secrets/:name — delete (scoped).
	group.delete("/:name", (c) => {
		const sc = scope.resolve(c);
		if (sc === null) return badTenancy(c);
		const name = c.req.param("name");
		const res = store.deleteSecret(name, sc);
		if (!res.ok) {
			if (res.reason === "invalid_name") {
				return c.json({ error: "bad_request", reason: "invalid secret name" }, 400);
			}
			if (res.reason === "not_found") {
				return c.json({ error: "not_found", reason: "no such secret" }, 404);
			}
			return c.json({ error: "delete_failed", reason: "could not delete the secret" }, 502);
		}
		return c.json({ ok: true, name });
	});
}

/** The 400 for a request with no resolvable tenancy (fail-closed — never a broad scope). */
function badTenancy(c: Context): Response {
	return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
}

/**
 * Read the secret value from the POST body. Accepts either a JSON `{ value: "..." }` or a
 * raw text body. Returns `null` for a missing/empty/non-string value (→ 400). The value is
 * consumed by the store and never echoed back.
 */
async function readValue(c: Context): Promise<string | null> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("application/json")) {
		try {
			const body: unknown = await c.req.json();
			if (typeof body === "object" && body !== null) {
				const v = (body as Record<string, unknown>).value;
				if (typeof v === "string" && v.length > 0) return v;
			}
			return null;
		} catch {
			return null;
		}
	}
	const text = await c.req.text();
	return text.length > 0 ? text : null;
}

/** The honest 501 for a 012b route — names the owning sub-PRD, returns no value. */
function notImplementedRoute(c: Context, what: string): Response {
	return c.json({ error: "not_implemented", reason: `${what} is implemented in PRD-012b` }, 501);
}

/**
 * Parse a `POST /exec` body into a {@link SecretExecRequest}, binding the request to the
 * server-resolved `scope` (never a body-supplied scope — a caller cannot exec under another
 * tenancy). The body carries the COMMAND, args, secret NAMES, and vault REFs — NEVER a secret
 * value (a value in the body would be a client mistake, not a path the runner reads). Returns
 * `null` for a missing/empty command (→ 400). Non-string args/names are dropped defensively.
 */
async function readExecRequest(c: Context, scope: SecretScope): Promise<SecretExecRequest | null> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const b = body as Record<string, unknown>;

	const command = b.command;
	if (typeof command !== "string" || command.length === 0) return null;

	const args = Array.isArray(b.args) ? b.args.filter((a): a is string => typeof a === "string") : [];
	const secretNames = Array.isArray(b.secretNames)
		? b.secretNames.filter((n): n is string => typeof n === "string")
		: [];

	const vaultRefs: Record<string, string> = {};
	if (typeof b.vaultRefs === "object" && b.vaultRefs !== null) {
		for (const [k, v] of Object.entries(b.vaultRefs as Record<string, unknown>)) {
			if (typeof v === "string") vaultRefs[k] = v;
		}
	}

	const timeoutMs = typeof b.timeoutMs === "number" ? b.timeoutMs : undefined;

	return { command, args, secretNames, vaultRefs, scope, timeoutMs };
}
