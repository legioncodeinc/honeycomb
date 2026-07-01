/**
 * Daemon HTTP server bootstrap (PRD-004a FR-1..8).
 *
 * Builds the Hono app: mounts every route group from FR-2 as a scaffolded
 * sub-app with permission middleware ALREADY mounted (so a later module attaches
 * a real handler and inherits enforcement without re-wiring — a-AC-6 / FR-8),
 * implements the two non-protected diagnostics endpoints `/health` (a-AC-2) and
 * `/api/status` (a-AC-3), wires structured per-request logging (FR-7), and
 * pre-wires the Wave-2 registration seams (job queue, file watcher, runtime-path
 * middleware) so 004b/004c/004d fill their own module + test with ZERO
 * bootstrap/shared-file contention.
 *
 * The daemon is the ONLY DeepLake client (FR-6): handlers reach storage solely
 * through the injected storage client / catalog; no handler opens DeepLake. The
 * whole server lives under `src/daemon/` so the daemon-only invariant test
 * (`tests/daemon/storage/invariant.test.ts`) still passes.
 *
 * Verification posture: `createDaemon(...)` returns `{ app, ... }` and the app is
 * exercised in-process via `app.request(...)` — no socket is bound in tests. The
 * real `listen()` path (via `@hono/node-server`) is `startDaemon`, used only in
 * production; importing this module does NOT auto-listen.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { HONEYCOMB_VERSION } from "../../shared/constants.js";
import { CATALOG } from "../storage/catalog/index.js";
import type { StorageQuery } from "../storage/client.js";
import { type DeploymentMode, type RuntimeConfig, resolveRuntimeConfig } from "./config.js";
import { createRequestLogger, type RequestLogger } from "./logger.js";
import {
	type PermissionCheck,
	type PermissionMiddlewareOptions,
	defaultDenyPermissionCheck,
	legacyPermissionCheckAdapter,
	permissionMiddleware,
} from "./middleware/permission.js";
import { type AuthorizationPolicy, type Authenticator } from "./auth/contracts.js";
import {
	type RuntimePathService,
	noopRuntimePathService,
	runtimePathMiddleware,
} from "./middleware/runtime-path.js";
import { type FileWatcherService, noopFileWatcherService } from "./services/file-watcher.js";
import { type JobQueueService, noopJobQueueService } from "./services/job-queue.js";
import { type EmbedSupervisor, noopEmbedSupervisor } from "./services/embed-supervisor.js";
import { type HealthDetail, publicHealthDetail } from "./health.js";
/**
 * The route-group surface (FR-2). Each entry is mounted as a scaffolded sub-app.
 * `protect: false` for the two diagnostics endpoints that require NO permission
 * (FR-3: `/health`, `/api/status`); everything else mounts permission middleware
 * so a later handler inherits it (a-AC-6). `session: true` marks groups that sit
 * behind the runtime-path middleware (004d) — session-scoped capture surfaces.
 *
 * Mounting EVERY group here (even those with no handler yet) is the seam: later
 * modules call `daemon.group("/api/memories")` and attach handlers to a router
 * that is already protected and already mounted at the right base path.
 */
interface RouteGroupSpec {
	readonly path: string;
	readonly protect: boolean;
	readonly session: boolean;
}

/**
 * The full FR-2 list. Order is mount order; specificity is handled by Hono's
 * router (exact `/api/status` is registered before the `/api/*` groups so it is
 * never shadowed). `/health` and `/api/status` are unprotected (FR-3).
 */
const ROUTE_GROUPS: readonly RouteGroupSpec[] = Object.freeze([
	{ path: "/health", protect: false, session: false },
	{ path: "/api/status", protect: false, session: false },
	{ path: "/api/auth", protect: true, session: false },
	{ path: "/api/memories", protect: true, session: true },
	{ path: "/memory", protect: true, session: true },
	{ path: "/api/hooks", protect: true, session: true },
	{ path: "/api/embeddings", protect: true, session: false },
	{ path: "/api/documents", protect: true, session: false },
	{ path: "/api/sources", protect: true, session: false },
	{ path: "/api/connectors", protect: true, session: false },
	{ path: "/api/harnesses", protect: true, session: false },
	{ path: "/api/skills", protect: true, session: false },
	{ path: "/api/rules", protect: true, session: false },
	{ path: "/api/goals", protect: true, session: false },
	{ path: "/api/kpis", protect: true, session: false },
	{ path: "/api/graph", protect: true, session: false },
	{ path: "/api/ontology", protect: true, session: false },
	{ path: "/api/secrets", protect: true, session: false },
	{ path: "/api/settings", protect: true, session: false },
	{ path: "/api/assets", protect: true, session: false },
	{ path: "/api/org", protect: true, session: false },
	{ path: "/api/workspace", protect: true, session: false },
	{ path: "/api/diagnostics", protect: true, session: false },
	// The dashboard imperative-actions surface (logout / embeddings / restart / uninstall). Protected
	// (inherits auth/RBAC) AND additionally local-mode + origin/CSRF gated inside the handlers
	// (`dashboard/actions-api.ts`), since these are credential/process/lifecycle actions.
	{ path: "/api/actions", protect: true, session: false },
	{ path: "/api/pipeline", protect: true, session: false },
	{ path: "/api/repair", protect: true, session: false },
	{ path: "/api/inference", protect: true, session: false },
	{ path: "/v1", protect: true, session: false },
	{ path: "/api/tasks", protect: true, session: false },
	{ path: "/api/logs", protect: true, session: false },
	{ path: "/api/update", protect: true, session: false },
	{ path: "/api/git", protect: true, session: false },
	{ path: "/mcp", protect: true, session: true },
	{ path: "/", protect: false, session: false },
]);

/**
 * The services the daemon owns (D-4: in-process, daemon-owned). Wave 2 swaps a
 * stub for its real impl by passing it to `createDaemon`; the bootstrap never
 * changes. Defaults are the no-op stubs so the daemon compiles and runs today.
 */
export interface DaemonServices {
	/** The durable job queue (004b). */
	readonly queue: JobQueueService;
	/** The identity file watcher (004c). */
	readonly watcher: FileWatcherService;
	/** The runtime-path claim service (004d). */
	readonly runtimePath: RuntimePathService;
	/**
	 * The embed-daemon supervisor (PRD-025 Wave 2 / D-6). Spawns + health-checks +
	 * crash-restarts the embed daemon child, warming it OFF the turn path. Defaults
	 * to the inert {@link noopEmbedSupervisor}; `assembleDaemon` swaps in the real one.
	 */
	readonly embed: EmbedSupervisor;
}

/** Options for building the daemon. Everything is injectable for testability. */
export interface CreateDaemonOptions {
	/** The resolved runtime config. Defaults to env resolution (fail-closed). */
	readonly config?: RuntimeConfig;
	/**
	 * The storage client the daemon reads through (FR-6). Optional so the server
	 * surface (routes, middleware, /health, /api/status) is testable without a
	 * live backend; when absent, /health reports storage as not-configured and
	 * /api/status omits the live probe.
	 */
	readonly storage?: StorageQuery;
	/**
	 * The LEGACY 004a pluggable permission check (default: default-deny). When
	 * supplied, the daemon mounts the legacy header-resolved adapter for the 004a
	 * compatibility surface (the 004a server tests inject this). New (PRD-011) code
	 * injects `authenticator` + `policy` instead — see below.
	 *
	 * @deprecated Prefer `authenticator` + `policy` (PRD-011). A header-resolved role
	 * is a privilege-escalation bypass; this only exists for 004a compatibility.
	 */
	readonly permissionCheck?: PermissionCheck;
	/**
	 * The PRD-011 authenticator (011b token + 011d api-key, composed at assembly).
	 * Default fail-closed: always-unauthenticated → every team/hybrid request is 401.
	 * Ignored when the legacy `permissionCheck` is supplied (the 004a path).
	 */
	readonly authenticator?: Authenticator;
	/**
	 * The PRD-011 RBAC policy (011c). Default fail-closed: default-deny → an
	 * authenticated caller is still 403. Ignored when `permissionCheck` is supplied.
	 */
	readonly policy?: AuthorizationPolicy;
	/** The request logger (default: stderr JSON-lines + ring buffer). */
	readonly logger?: RequestLogger;
	/** Wave-2 services. Each defaults to its no-op stub. */
	readonly services?: Partial<DaemonServices>;
	/**
	 * Coarse, CHEAP pipeline-health probe for `/health` (FR-4). Returns the
	 * current coarse status WITHOUT a per-request DeepLake round-trip — it reads a
	 * cached health bit a later module maintains. Default: `ok` when a storage
	 * client is wired, `unconfigured` otherwise. Injecting `() => "degraded"`
	 * drives the storage-down 503 path (impl note) so the degraded branch is
	 * testable without a live failure.
	 */
	readonly pipelineProbe?: () => "ok" | "degraded" | "unconfigured";
	/**
	 * The structured `/health` DETAIL seam (PRD-029 AC-2 / AC-3 / D-3, additive). Returns
	 * the {@link HealthDetail} — the coarse `status` PLUS per-subsystem `reasons` (storage
	 * reachability / embeddings on-off / schema) — read from the SAME cached state the
	 * coarse probe maintains (D-4: no new probe). When supplied, the `/health` body adds the
	 * mode-gated `reasons` block: in `local` mode `/health` includes `reasons`; in
	 * `team`/`hybrid` the PUBLIC `/health` returns the coarse bit ONLY (no internal topology
	 * to an unauthenticated remote — AC-3) and the full detail lives on the protected
	 * `/api/diagnostics/health` surface. ABSENT (a bare `createDaemon` / the 004a suite) →
	 * the pre-029 coarse `/health` body, UNCHANGED. The composition root supplies the real
	 * thunk built over the health bit + the assembly-known embed state.
	 */
	readonly healthDetail?: () => HealthDetail;
}

/** The constructed daemon: the Hono app plus the wired services + accessors. */
export interface Daemon {
	/** The Hono app. Exercise in-process via `app.request(...)`; never auto-listens. */
	readonly app: Hono;
	/** The resolved runtime config (host/port/mode/widened). */
	readonly config: RuntimeConfig;
	/** The wired services (stubs by default; real impls when injected). */
	readonly services: DaemonServices;
	/** The request logger (read its buffer for `/api/logs` + tests). */
	readonly logger: RequestLogger;
	/**
	 * The sub-app (router) for a scaffolded route group (FR-2 / a-AC-6). A later
	 * module ATTACHES its handlers here — e.g. `daemon.group("/api/memories").get(
	 * "/:id", h)` — and they inherit the permission (and, for session groups, the
	 * runtime-path) middleware already mounted on the group, WITHOUT re-wiring auth.
	 * Returns `undefined` for an unknown group path. The group base is stripped, so
	 * a handler registers at the path RELATIVE to the group (`/:id`, not the full
	 * `/api/memories/:id`).
	 */
	group(path: string): Hono | undefined;
	/** Start all daemon services (does NOT bind a socket). Idempotent-friendly. */
	startServices(): Promise<void>;
	/** Stop all daemon services. */
	stopServices(): Promise<void>;
}

/** Coarse pipeline status for `/health` — derived without a heavy query (FR-4). */
type PipelineStatus = "ok" | "degraded" | "unconfigured";

/**
 * Build the daemon: resolve config, wire services + logging, construct the Hono
 * app with every route group scaffolded and protected, and implement /health +
 * /api/status. Pure construction — no socket is bound and no service is started
 * here (call `startServices()` / `startDaemon()` for that).
 */
export function createDaemon(options: CreateDaemonOptions = {}): Daemon {
	const config = options.config ?? resolveRuntimeConfig();
	const logger = options.logger ?? createRequestLogger();
	const services: DaemonServices = {
		queue: options.services?.queue ?? noopJobQueueService,
		watcher: options.services?.watcher ?? noopFileWatcherService,
		runtimePath: options.services?.runtimePath ?? noopRuntimePathService,
		embed: options.services?.embed ?? noopEmbedSupervisor,
	};
	const storage = options.storage;
	const pipelineProbe = options.pipelineProbe ?? ((): PipelineStatus => coarsePipelineStatus(storage));
	// PRD-029: the structured-detail seam (additive). Absent → the pre-029 coarse body.
	const healthDetail = options.healthDetail;
	const startedAt = Date.now();

	// The mode is read through a thunk so every mounted middleware reflects the
	// daemon's mode without re-binding (and tests build daemons in each mode).
	const getMode = (): DeploymentMode => config.mode;

	// Permission posture: when the LEGACY 004a `permissionCheck` is supplied, mount the
	// header-resolved legacy adapter (the 004a compatibility surface its tests cover).
	// Otherwise mount the PRD-011 auth gate with the injected `authenticator` + `policy`,
	// both defaulting fail-closed (always-unauthenticated → 401, default-deny → 403).
	const legacyCheck = options.permissionCheck;
	const useLegacy = legacyCheck !== undefined;
	const permissionOptions: PermissionMiddlewareOptions = {
		...(options.authenticator !== undefined ? { authenticator: options.authenticator } : {}),
		...(options.policy !== undefined ? { policy: options.policy } : {}),
	};
	const mountPermission = (groupPath: string): MiddlewareHandler =>
		useLegacy
			? legacyPermissionCheckAdapter(groupPath, getMode, legacyCheck ?? defaultDenyPermissionCheck)
			: permissionMiddleware(groupPath, getMode, permissionOptions);

	const app = new Hono();

	// ── FR-7: structured per-request logging, mounted first so it wraps every
	// route (including /health). It records timing + the resolved scope; never a
	// token or body. The scope is read from the same headers the permission
	// resolver uses, so a logged org/workspace matches what was enforced.
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		logger.log({
			time: new Date().toISOString(),
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			durationMs: Date.now() - start,
			mode: config.mode,
			org: c.req.header("x-honeycomb-org"),
			workspace: c.req.header("x-honeycomb-workspace"),
		});
	});

	// ── No CORS middleware: the dashboard reaches honeycomb ONLY through thehive's
	// server-side proxy (the-hive ADR-0002). The browser talks same-origin to thehive
	// (`:3853`), and thehive fetches honeycomb over loopback SERVER-SIDE — so no browser
	// cross-origin request (and no preflight) ever hits honeycomb, and no `Access-Control-*`
	// allowance is needed. This supersedes the ADR-0001 cutover's client-side federated wire,
	// which fetched honeycomb's origin directly from the browser and required a CORS allowlist.

	// ── FR-2 / FR-8 / a-AC-6: scaffold every route group by mounting its
	// middleware on the ROOT app at the group prefix, and exposing a basePath
	// router (`daemon.group(base)`) bound to the root for later handler attachment.
	//
	// Why this shape and not `app.route(base, subApp)`: `app.route` COPIES the
	// sub-app's routes at call time, so a handler a later module adds to the
	// sub-app AFTER bootstrap is NOT picked up — that would break a-AC-6. Mounting
	// middleware on the root at `${base}/*` and returning `app.basePath(base)`
	// keeps the binding live: a handler attached later is reflected, runs the
	// already-mounted middleware (so it inherits permission/runtime-path WITHOUT
	// re-wiring — a-AC-6), and an unfilled path falls through to the root 501
	// scaffold (registered as `notFound` below). The two diagnostics endpoints
	// (/health, /api/status) get NO permission middleware (FR-3).
	const groups = new Map<string, Hono>();
	const knownPrefixes: string[] = [];
	for (const spec of ROUTE_GROUPS) {
		if (spec.path === "/health" || spec.path === "/api/status") continue;
		knownPrefixes.push(spec.path);
		// Mount middleware on the root at the group prefix. `${base}/*` matches the
		// group's subtree; for the root group `/` the pattern is `/*` (the whole
		// app), which is fine because `/` is unprotected so no middleware mounts.
		const mwPattern = spec.path === "/" ? "/*" : `${spec.path}/*`;
		if (spec.protect) {
			// Session-scoped groups sit behind runtime-path negotiation (004d),
			// mounted AHEAD of permission so a path-reject fails closed before any
			// session handler (d-AC-4 / d-AC-7). Order: runtime-path → permission.
			if (spec.session) {
				app.use(mwPattern, runtimePathMiddleware(services.runtimePath, getMode));
			}
			app.use(mwPattern, mountPermission(spec.path));
		}
		// A basePath router bound to the root app: a later module attaches handlers
		// to it (e.g. `daemon.group("/api/memories").get("/:id", h)`) and they
		// register on the root at the full path, inheriting the middleware above.
		groups.set(spec.path, app.basePath(spec.path));
	}

	// ── FR-4 / a-AC-2: /health — cheap liveness. No heavy DeepLake query.
	app.get("/health", (c) => {
		const pipeline = pipelineProbe();
		// Storage-unavailable degrades /health to non-200 while the process stays
		// up, so a client distinguishes daemon-down from storage-down (impl note).
		const status = pipeline === "degraded" ? 503 : 200;
		// PRD-029 (AC-2/AC-3): the coarse body is UNCHANGED (`status`/`pipeline`/`uptimeMs`/
		// `version` + the 503 gate); the structured `reasons` block is layered on ADDITIVELY
		// and MODE-GATED. `publicHealthDetail` includes `reasons` in `local` and strips it on
		// the PUBLIC team/hybrid body (status-only — no topology to an unauthenticated remote;
		// the full detail rides the protected `/api/diagnostics/health` surface). When the
		// detail seam is unset (bare daemon / 004a suite), the body stays the pre-029 shape.
		const detail = healthDetail !== undefined ? publicHealthDetail(healthDetail(), config.mode) : undefined;
		return c.json(
			{
				status: pipeline === "degraded" ? "degraded" : "ok",
				uptimeMs: Date.now() - startedAt,
				version: HONEYCOMB_VERSION,
				pipeline,
				...(detail?.reasons !== undefined ? { reasons: detail.reasons } : {}),
			},
			status,
		);
	});

	// ── FR-5 / a-AC-3: /api/status — resolved config, providers, tenancy.
	app.get("/api/status", (c) => {
		return c.json({
			version: HONEYCOMB_VERSION,
			config: {
				host: config.host,
				port: config.port,
				mode: config.mode,
				widened: config.widened,
			},
			// Configured providers: storage is the only provider 004a knows about;
			// later modules extend this. Coarse (no live round-trip) per the
			// open-question default (cached/coarse probe).
			providers: {
				storage: storage !== undefined ? "configured" : "unconfigured",
			},
			// Tenancy: the resolved org/workspace for this request, from the same
			// headers the permission layer reads. 004a resolves the request-scoped
			// identity; the org-default resolution is a later module's job.
			tenancy: {
				org: c.req.header("x-honeycomb-org") ?? null,
				workspace: c.req.header("x-honeycomb-workspace") ?? null,
			},
			// Coarse catalog readiness: the number of tables the daemon will serve,
			// derived from the in-memory CATALOG (no query). Lets an operator
			// confirm the catalog loaded without probing DeepLake.
			catalog: { tableCount: CATALOG.length },
		});
	});

	// ── FR-2 scaffold fallback: a request to a KNOWN group prefix with no filled
	// handler returns a 501 (scaffolded, honest "not implemented"); a truly
	// unknown path returns 404. This is the single place the 501 lives, so a
	// later module's handler always wins (it matches before falling through here),
	// and the group middleware has already run for the protected-but-unfilled case.
	app.notFound((c) => {
		const path = c.req.path;
		const group = knownPrefixes.find((p) => path === p || path.startsWith(`${p}/`));
		if (group !== undefined) {
			return c.json(
				{ error: "not_implemented", group, detail: "route scaffolded; handler lands in a later module" },
				501,
			);
		}
		return c.json({ error: "not_found", path }, 404);
	});

	return {
		app,
		config,
		services,
		logger,
		group(path: string): Hono | undefined {
			return groups.get(path);
		},
		async startServices(): Promise<void> {
			// Start order: queue → watcher → runtime-path. Awaited so an async
			// warmup completes before the daemon is considered ready (c-AC-7: the
			// watcher is up for the life of the process once this resolves).
			await services.queue.start();
			await services.watcher.start();
			await services.runtimePath.start();
			// PRD-025 D-6: the embed supervisor starts LAST. Its `start()` spawns the embed
			// child + waits (bounded) for liveness, then warms in the BACKGROUND (D-3) — the
			// warm wait is never awaited here, so daemon readiness is never blocked on a cold
			// model. A never-starting child leaves recall on the lexical path (degraded), not hung.
			await services.embed.start();
		},
		async stopServices(): Promise<void> {
			// Stop in reverse order; each stop is awaited for a graceful drain.
			// PRD-025 D-6: tear the embed child down FIRST so a clean daemon shutdown also
			// drains the supervised embed process (no orphaned child).
			await services.embed.stop();
			await services.runtimePath.stop();
			await services.watcher.stop();
			await services.queue.stop();
		},
	};
}

/**
 * Coarse pipeline status for /health (FR-4) WITHOUT a heavy query. `unconfigured`
 * when no storage client is wired; `ok` when one is. A real liveness probe (a
 * cached `SELECT 1` health bit) is a later refinement; /health must stay cheap,
 * so it never issues a per-request round-trip here.
 */
function coarsePipelineStatus(storage: StorageQuery | undefined): PipelineStatus {
	return storage === undefined ? "unconfigured" : "ok";
}
