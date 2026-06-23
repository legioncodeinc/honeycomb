/**
 * The `/api/sources` + `/api/documents` API — PRD-013a (a-AC-1 / a-AC-2 / FR-2 /
 * FR-9 / FR-10) + the 013b document-submission scaffold.
 *
 * ── Where it mounts ──────────────────────────────────────────────────────────
 * `/api/sources` and `/api/documents` are PROTECTED groups (server.ts ROUTE_GROUPS:
 * `protect: true`; PRD-011 RBAC gates them). The bootstrap already mounted the
 * permission middleware ahead of them, so attaching handlers via
 * `daemon.group("/api/sources")` / `daemon.group("/api/documents")` inherits
 * auth/RBAC with ZERO re-wiring — every request is authenticated + authorized
 * before a handler runs. No edit to `server.ts`.
 *
 * ── What 013a wires (THIS module) ────────────────────────────────────────────
 *   /api/sources:
 *     - GET    /api/sources         → list registered source ids.
 *     - POST   /api/sources         → connect/add a source (validate config →
 *                                      register + enqueue index job, a-AC-1).
 *     - GET    /api/sources/:id/health → the source's health report (FR-9).
 *     - DELETE /api/sources/:id     → disconnect → purge (append-only soft-delete
 *                                      by source_id; files untouched, a-AC-2).
 *   /api/documents:
 *     - POST   /api/documents       → submit a document URL → id + status; an
 *                                      identical URL returns the EXISTING record
 *                                      (dedup, b-AC-1). 013a scaffolds the dedup-
 *                                      by-URL check; the document WORKER lifecycle
 *                                      (chunk/embed/index) is a 013b harness stub.
 *     - GET    /api/documents/:id   → the document's id + status.
 *     - DELETE /api/documents/:id   → soft-delete the document + linked chunks (b-AC-5).
 *
 * The provider for a connect/index is resolved by an injected {@link ProviderResolver}
 * seam (Wave-2 registers the real Obsidian/Discord/GitHub providers; tests inject a
 * fake). Scope is resolved per-request via the same header reader the rest of the
 * daemon uses (mirrors `secrets/api.ts`'s `headerScopeResolver`).
 *
 * Every dynamic SQL fragment is already guarded inside the lifecycle engine; this
 * module never builds SQL — it parses the request, resolves scope + provider, and
 * delegates to {@link SourceLifecycle}.
 */

import type { Context, Hono } from "hono";

import type { QueryScope } from "../../storage/client.js";
import { getRequestIdentity } from "../middleware/permission.js";
import { parseSourceConfig, type SourceConfig, type SourceProvider } from "./contracts.js";
import {
	createSourceLifecycle,
	type SourceLifecycleDeps,
	type SourceRegistry,
} from "./lifecycle.js";
import { type DocumentWorker, isBlockedUrlError, type SubmitResult } from "./document-worker.js";

/** The route groups the sources API attaches to (FR-2). */
export const SOURCES_GROUP = "/api/sources" as const;
export const DOCUMENTS_GROUP = "/api/documents" as const;

/**
 * Resolve the {@link QueryScope} for a request from the `x-honeycomb-*` headers
 * (the same tenancy the rest of the daemon reads). Returns `null` when the request
 * carries no usable org → the handler 400s (fail-closed; a request without a
 * tenancy never falls back to a broad scope).
 */
export interface SourceScopeResolver {
	/** Resolve the scope, or `null` if the request has no resolvable tenancy. */
	resolve(c: Context): QueryScope | null;
}

/**
 * The default header-based scope resolver.
 *
 * ── Cross-tenant guard (PRD-022 security; mirrors `scope.ts` `resolveScopeFromHeaders`) ──
 * In team/hybrid the permission middleware has already AUTHENTICATED the request and stamped
 * the VALIDATED {@link import("../auth/contracts.js").Identity} onto the context. These
 * handlers partition storage by the `x-honeycomb-org` HEADER, so without a cross-check an
 * authenticated caller for org A could forge `x-honeycomb-org: orgB` and list/add/delete
 * org B's sources + documents. When a validated Identity is present, the resolved org MUST
 * equal `identity.org`; a mismatch returns `null` → the handler fails closed (400). In local
 * mode no Identity is stamped, so the prior pure-header behaviour is unchanged.
 */
export const headerScopeResolver: SourceScopeResolver = {
	resolve(c: Context): QueryScope | null {
		const org = c.req.header("x-honeycomb-org");
		if (org === undefined || org.length === 0) return null;
		// A forged org header can never cross the token's own org boundary (PRD-022).
		const identity = getRequestIdentity(c);
		if (identity !== undefined && org !== identity.org) return null;
		const workspace = c.req.header("x-honeycomb-workspace");
		const ws = workspace !== undefined && workspace.length > 0 ? workspace : "default";
		return { org, workspace: ws };
	},
};

/**
 * Resolve a {@link SourceProvider} for a source kind (D-7 seam). Wave-2 registers
 * the real Obsidian/Discord/GitHub providers; the document path uses a built-in
 * document provider (013b). Returns `null` for an unregistered kind → the handler
 * 400s. The lifecycle is provider-agnostic, so this is the ONLY place the kind →
 * provider mapping lives.
 */
export interface ProviderResolver {
	/** Resolve a provider for a config (by `config.kind`), or `null` if unknown. */
	resolve(config: SourceConfig): SourceProvider | null;
}

/** Construction deps for the sources API. Everything injected for testability. */
export interface SourcesApiDeps {
	/** Run lifecycle statements through this storage client. */
	readonly storage: SourceLifecycleDeps["storage"];
	/** The durable job queue (connect enqueues an index job). */
	readonly queue: SourceLifecycleDeps["queue"];
	/** The source-config registry. */
	readonly registry: SourceRegistry;
	/** The kind → provider resolver (D-7 seam). */
	readonly providers: ProviderResolver;
	/** The per-request scope resolver (default: header-based). */
	readonly scope?: SourceScopeResolver;
	/** Optional lifecycle log sink. */
	readonly logger?: SourceLifecycleDeps["logger"];
	/**
	 * The 013b document worker — when PRESENT, `POST /api/documents` submits a real
	 * document job (dedup-by-URL + queue). When ABSENT (013a default), the document
	 * routes use the harness stub's in-memory submit so the surface is honest +
	 * testable before 013b fills the worker internals.
	 */
	readonly documentWorker?: DocumentWorker;
	/**
	 * Delay (ms) between the lifecycle's purge-discovery polls (a DELETE soft-deletes by
	 * scanning the source's ids — see `lifecycle.ts` `DISCOVERY_POLL_DELAY_MS`). Production
	 * leaves it unset (the ~400ms spacing that spans the fresh-write propagation window). A
	 * unit/integration test on the deterministic fake store passes `0` so the spaced polls do
	 * not push a DELETE toward the vitest default timeout (the fake is authoritative on the
	 * first poll, so the spacing is pure wall-clock waste there).
	 */
	readonly discoveryPollDelayMs?: number;
}

/** 400 for a request with no resolvable tenancy. */
function badTenancy(c: Context): Response {
	return c.json({ error: "bad_request", reason: "request carries no resolvable org/workspace scope" }, 400);
}

/**
 * Build a {@link SourceLifecycle} for a request scope. The engine is cheap +
 * stateless beyond its deps, so we build one per request bound to the resolved
 * scope (mirrors how other per-request daemon handlers scope their writes).
 */
function lifecycleFor(deps: SourcesApiDeps, scope: QueryScope) {
	return createSourceLifecycle({
		storage: deps.storage,
		scope,
		queue: deps.queue,
		registry: deps.registry,
		...(deps.logger !== undefined ? { logger: deps.logger } : {}),
		...(deps.discoveryPollDelayMs !== undefined ? { discoveryPollDelayMs: deps.discoveryPollDelayMs } : {}),
	});
}

/**
 * Mount the `/api/sources` API onto a route group (a-AC-1 / a-AC-2 / FR-2 / FR-9 /
 * FR-10). Call AFTER `createDaemon(...)` with `daemon.group("/api/sources")` so the
 * handlers inherit the already-mounted auth/RBAC middleware. Routes register
 * RELATIVE to the group base.
 */
export function mountSourcesApi(group: Hono, deps: SourcesApiDeps): void {
	const scopeResolver = deps.scope ?? headerScopeResolver;

	// GET /api/sources — list registered source ids.
	group.get("/", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);
		const ids = await deps.registry.list();
		return c.json({ sources: ids });
	});

	// POST /api/sources — connect/add a source (a-AC-1).
	group.post("/", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);

		const body = await readJson(c);
		// Inject the request scope so the config's org/workspace match the partition.
		const candidate = { ...body, org: scope.org, workspace: scope.workspace ?? "default" };
		const config = parseSourceConfig(candidate);
		if (config === null) {
			return c.json({ error: "bad_request", reason: "invalid source config" }, 400);
		}
		const provider = deps.providers.resolve(config);
		if (provider === null) {
			return c.json({ error: "bad_request", reason: `no provider for kind "${config.kind}"` }, 400);
		}
		const lifecycle = lifecycleFor(deps, scope);
		const outcome = await lifecycle.connect(provider, config);
		return c.json({ sourceId: outcome.sourceId, jobId: outcome.jobId, health: outcome.health }, 201);
	});

	// GET /api/sources/:id/health — the source's health report (FR-9).
	group.get("/:id/health", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);
		const sourceId = c.req.param("id");
		const config = await deps.registry.get(sourceId);
		if (config === null) return c.json({ error: "not_found", sourceId }, 404);
		const provider = deps.providers.resolve(config);
		if (provider === null) return c.json({ error: "bad_request", reason: "no provider" }, 400);
		const lifecycle = lifecycleFor(deps, scope);
		const health = await lifecycle.health(provider, sourceId);
		return c.json(health);
	});

	// DELETE /api/sources/:id — disconnect → purge (a-AC-2).
	group.delete("/:id", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);
		const sourceId = c.req.param("id");
		const config = await deps.registry.get(sourceId);
		if (config === null) return c.json({ error: "not_found", sourceId }, 404);
		const provider = deps.providers.resolve(config);
		if (provider === null) return c.json({ error: "bad_request", reason: "no provider" }, 400);
		const lifecycle = lifecycleFor(deps, scope);
		const outcome = await lifecycle.purge(provider, sourceId);
		return c.json(outcome);
	});
}

/**
 * Mount the `/api/documents` API onto a route group (b-AC-1 scaffold / 013b). The
 * dedup-by-URL check + the submit→id+status shape are scaffolded here; the document
 * WORKER lifecycle internals (chunk/embed/index) are a 013b harness stub.
 */
export function mountDocumentsApi(group: Hono, deps: SourcesApiDeps): void {
	const scopeResolver = deps.scope ?? headerScopeResolver;
	const worker = deps.documentWorker;

	// POST /api/documents — submit a document URL → id + status; identical URL →
	// existing record (dedup, b-AC-1). 013a scaffolds the dedup; 013b fills the worker.
	group.post("/", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);
		const body = await readJson(c);
		const url = typeof body.url === "string" ? body.url.trim() : "";
		if (url === "") {
			return c.json({ error: "bad_request", reason: "document submission requires a url" }, 400);
		}
		if (worker === undefined) {
			// 013a default: the worker is unwired — surface an honest 501 so a premature
			// document submission fails loud with the owning sub-PRD (013b).
			return c.json(
				{ error: "not_implemented", detail: "document worker lands in PRD-013b", url },
				501,
			);
		}
		try {
			const submitted: SubmitResult = await worker.submit({
				url,
				org: scope.org,
				workspace: scope.workspace ?? "default",
			});
			// `deduped` true → the identical URL returned the existing record (b-AC-1).
			return c.json({ documentId: submitted.documentId, status: submitted.status, deduped: submitted.deduped }, 202);
		} catch (err: unknown) {
			// A BLOCKED url (SSRF guard: bad scheme, private/loopback/metadata address, too
			// many redirects) is a CALLER error → a clear 400, not a 5xx stack. The message
			// names the reason class only (never an internal IP), so it leaks no topology.
			if (isBlockedUrlError(err)) {
				return c.json({ error: "bad_request", reason: "document url is not allowed" }, 400);
			}
			throw err; // a genuine server fault still surfaces as a 500 (caught by the daemon).
		}
	});

	// GET /api/documents/:id — the document's id + status.
	group.get("/:id", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);
		const documentId = c.req.param("id");
		if (worker === undefined) {
			return c.json({ error: "not_implemented", detail: "document worker lands in PRD-013b", documentId }, 501);
		}
		const view = await worker.get(documentId, { org: scope.org, workspace: scope.workspace ?? "default" });
		if (view === null) return c.json({ error: "not_found", documentId }, 404);
		return c.json(view);
	});

	// DELETE /api/documents/:id — soft-delete the document + linked chunks (b-AC-5).
	group.delete("/:id", async (c) => {
		const scope = scopeResolver.resolve(c);
		if (scope === null) return badTenancy(c);
		const documentId = c.req.param("id");
		if (worker === undefined) {
			return c.json({ error: "not_implemented", detail: "document worker lands in PRD-013b", documentId }, 501);
		}
		const outcome = await worker.remove(documentId, { org: scope.org, workspace: scope.workspace ?? "default" });
		return c.json(outcome);
	});
}

/** Read a JSON body defensively; a non-JSON / empty body → `{}` (the handler 400s). */
async function readJson(c: Context): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await c.req.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
	} catch {
		// A non-JSON body is not a crash — the handler treats it as missing fields.
		return {};
	}
	return {};
}
