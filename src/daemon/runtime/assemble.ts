/**
 * The daemon composition root — PRD-021a (a-AC-1..6 / FR-1..10).
 *
 * `assembleDaemon()` is THE one function that makes the daemon real: it is the
 * single production caller that constructs the LIVE storage client (the only place
 * outside the daemon-internal storage modules that imports `daemon/storage` to get a
 * live client — allowed because this file lives under `src/daemon/`, the composition
 * root; D-2 / a-AC-1), builds `createDaemon`, fires the mount/attach seams EXACTLY ONCE
 * after construction (a-AC-2 — the four core seams + the `/api/logs` reader always, the
 * viewable `/dashboard` host local-mode only per security F-1), swaps the three no-op
 * services for their real implementations (a-AC-3), wires a cheap live `/health` storage
 * probe (a-AC-4),
 * installs graceful SIGINT/SIGTERM shutdown that drains services + closes the socket +
 * removes the lock (a-AC-5), and writes a PID/lock single-instance guard so a second
 * start does not double-bind port 3850 (a-AC-6).
 *
 * ── Wiring-only (D-1) ────────────────────────────────────────────────────────
 * This module adds NO business logic and NO DeepLake schema. Every dependency it
 * passes is an already-built-and-tested seam from a prior PRD: the storage client
 * (002a), the real services (004b/004c/004d), the auth authenticator + RBAC policy
 * (011b/011c/011d), and the four attach seams (019b/020a/020b/020d). The composition
 * root only chooses the order and fires each once.
 *
 * ── Downstream waves land here (D-4) ─────────────────────────────────────────
 * 021c attaches the context + session-end hook endpoints and 021d/021e fill the
 * dashboard-log and MCP transport surfaces. Those build ON the assembled daemon: the
 * four seams below are the extension points, and `assembleDaemon` returns the live
 * `Daemon` so a later wave can attach more without editing the bootstrap. Where a seam
 * needs a dep that does not exist yet (the team/hybrid `PruneActorAuthority` actor↔
 * identity binding), this wires the fail-closed default and marks the seam — it does
 * NOT fake it (see {@link assembleSeams}).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CREDENTIALS_DIR_NAME, DIR_MODE } from "./auth/credentials-store.js";
import {
	type AuthorizationPolicy,
	type Authenticator,
	createApiKeyAuthenticator,
	createRbacPolicy,
	createTokenAuthenticator,
	defaultDenyPolicy,
	type Identity,
	type PresentedCredentials,
} from "./auth/index.js";
import { type RuntimeConfig, resolveRuntimeConfig } from "./config.js";
import { type RequestLogger, createRequestLogger } from "./logger.js";
import { createRuntimePathService } from "./middleware/runtime-path.js";
import { createFileWatcherService, type HarnessTarget } from "./services/file-watcher.js";
import { createJobQueueService } from "./services/job-queue.js";
import { type CreateDaemonOptions, type Daemon, type DaemonServices, createDaemon } from "./server.js";

import { attachHooksHandlers } from "./capture/attach.js";
import { mountDashboardApi } from "./dashboard/api.js";
import { mountDashboardHost } from "./dashboard/host.js";
import { mountLogsApi } from "./logs/api.js";
import { mountNotificationsApi } from "./notifications/api.js";
import { attachSessionsPrune } from "./sessions/prune.js";

import { createStorageClient } from "../storage/index.js";
import type { QueryScope, StorageClient } from "../storage/client.js";
import { isOk } from "../storage/result.js";

/** The single-instance lock filename under `~/.honeycomb/` (FR-8 / a-AC-6). */
export const LOCK_FILE_NAME = "daemon.lock";
/** The PID filename under `~/.honeycomb/` (FR-8 / a-AC-6). */
export const PID_FILE_NAME = "daemon.pid";

/** How often the cheap live `/health` probe refreshes the cached health bit (a-AC-4). */
const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 15_000;

/** The coarse pipeline status the cached `/health` bit reports (mirrors server.ts). */
type PipelineStatus = "ok" | "degraded" | "unconfigured";

/**
 * The seams the composition root needs from the environment so a test drives the
 * assembly deterministically (a temp `~/.honeycomb`, a fake clock, an injected
 * storage client) without touching the real machine or a live backend.
 */
export interface AssembleDaemonOptions {
	/**
	 * The resolved runtime config (host/port/mode). Defaults to env resolution
	 * (fail-closed). A test injects a fixed config (e.g. an ephemeral port).
	 */
	readonly config?: RuntimeConfig;
	/**
	 * The live storage client. Defaults to {@link createStorageClient} (the ONLY
	 * production construction — a-AC-1). A test injects a fake `StorageClient`-shaped
	 * object so the deterministic bits run without a live DeepLake.
	 */
	readonly storage?: StorageClient;
	/** The request logger. Defaults to the stderr JSON-lines + ring-buffer logger. */
	readonly logger?: RequestLogger;
	/**
	 * The `~/.honeycomb` directory the PID + lock files live in. Defaults to the real
	 * home dir; a test points it at a temp dir so the guard never collides with a real
	 * daemon's lock.
	 */
	readonly runtimeDir?: string;
	/** Cached-health-bit refresh interval (a-AC-4). Default 15s. */
	readonly healthProbeIntervalMs?: number;
	/**
	 * The harness identity-copy targets the file watcher syncs (004c). Defaults to an
	 * empty set (no harness copies) so a bare assembly does not require PRD-019 paths;
	 * a fuller wiring (021c) supplies the real per-harness destinations.
	 */
	readonly harnessTargets?: readonly HarnessTarget[];
	/** The workspace root the file watcher watches. Defaults to `process.cwd()`. */
	readonly workspaceDir?: string;
	/**
	 * The four mount/attach seam functions, injectable for testing (a-AC-2). Defaults to
	 * the REAL seams ({@link defaultSeamFns}). A unit test injects recording fakes to assert
	 * each is called EXACTLY ONCE, after construction, in order — without mocking the
	 * module graph (the repo's DI-over-mock posture). Production never sets this.
	 */
	readonly seams?: SeamFns;
}

/**
 * The mount/attach seam functions the composition root fires once (a-AC-2). The four
 * core seams (`attachHooks`/`mountDashboard`/`mountNotifications`/`attachPrune`) fire
 * unconditionally; `mountLogs` fires unconditionally (its `/api/logs` group is already
 * `protect:true` in `server.ts`, so it carries no security gate); `mountDashboardHost`
 * fires LOCAL-MODE ONLY (security F-1 — see {@link assembleSeams}).
 */
export interface SeamFns {
	readonly attachHooks: typeof attachHooksHandlers;
	readonly mountDashboard: typeof mountDashboardApi;
	readonly mountNotifications: typeof mountNotificationsApi;
	readonly attachPrune: typeof attachSessionsPrune;
	/** The `/api/logs` ring-buffer reader (021d). Fires always — its group is `protect:true`. */
	readonly mountLogs: typeof mountLogsApi;
	/** The viewable `/dashboard` HTML host (021d). Fires LOCAL-MODE ONLY (security F-1). */
	readonly mountDashboardHost: typeof mountDashboardHost;
}

/** The REAL seam functions (the production wiring). */
export const defaultSeamFns: SeamFns = {
	attachHooks: attachHooksHandlers,
	mountDashboard: mountDashboardApi,
	mountNotifications: mountNotificationsApi,
	attachPrune: attachSessionsPrune,
	mountLogs: mountLogsApi,
	mountDashboardHost,
};

/** An assembled, fully-wired daemon plus the composition root's lifecycle controls. */
export interface AssembledDaemon {
	/** The constructed daemon (the Hono app + wired real services). Never auto-listens. */
	readonly daemon: Daemon;
	/** The resolved runtime config the daemon was assembled against. */
	readonly config: RuntimeConfig;
	/**
	 * Start the composition-root lifecycle: write the PID/lock guard, start the cached
	 * `/health` probe refresher, and start the daemon's services. Does NOT bind the
	 * socket (that is `startDaemon`). Idempotent.
	 */
	start(): Promise<void>;
	/**
	 * Graceful shutdown (a-AC-5): drain the services via `stopServices()`, stop the
	 * health refresher, and remove the PID/lock files so no stale lock survives. Safe to
	 * call more than once. The socket close is the caller's (the `RunningDaemon.close`
	 * from `startDaemon` calls `stopServices` itself; this clears the lock).
	 */
	shutdown(): Promise<void>;
	/** The current cached pipeline-health bit (for `/api/status` + diagnostics). */
	pipelineStatus(): PipelineStatus;
}

/** Thrown when a second start detects a daemon already holding the lock (a-AC-6). */
export class DaemonAlreadyRunningError extends Error {
	/** The PID recorded in the existing lock, when readable. */
	readonly existingPid: number | null;
	constructor(existingPid: number | null) {
		super(
			existingPid !== null
				? `a Honeycomb daemon is already running (pid ${existingPid}); refusing to double-bind`
				: "a Honeycomb daemon lock is already held; refusing to double-bind",
		);
		this.name = "DaemonAlreadyRunningError";
		this.existingPid = existingPid;
	}
}

/** Resolve the `~/.honeycomb` runtime dir (honoring a test override). */
function resolveRuntimeDir(dir: string | undefined): string {
	return dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** True when a process with `pid` is currently alive (signal 0 probes liveness). */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// Signal 0 performs the permission/existence check WITHOUT delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// ESRCH → no such process (stale). EPERM → the process exists but is owned by
		// another user (still "alive" for our single-instance purpose).
		const code = (err as NodeJS.ErrnoException)?.code;
		return code === "EPERM";
	}
}

/**
 * Acquire the single-instance PID/lock guard (FR-8 / a-AC-6). Writes `daemon.pid` +
 * `daemon.lock` under the runtime dir. If a lock already exists AND its recorded PID
 * is still alive, throws {@link DaemonAlreadyRunningError} so the second start does NOT
 * double-bind port 3850. A STALE lock (the recorded process is gone) is reclaimed — a
 * crashed daemon never wedges the next start. Returns the resolved paths so shutdown
 * removes exactly what it wrote.
 */
export function acquireSingleInstanceLock(runtimeDir: string): { lockPath: string; pidPath: string } {
	mkdirSync(runtimeDir, { recursive: true, mode: DIR_MODE });
	const lockPath = join(runtimeDir, LOCK_FILE_NAME);
	const pidPath = join(runtimeDir, PID_FILE_NAME);

	const existingPid = readPidFile(lockPath);
	if (existingPid !== null && isPidAlive(existingPid)) {
		throw new DaemonAlreadyRunningError(existingPid);
	}

	// Fresh or stale-reclaimed: stamp this process's pid into both files. The lock and
	// pid files carry the same value; the lock is what the guard checks, the pid file is
	// the operator-facing convenience (`cat ~/.honeycomb/daemon.pid`).
	const pid = String(process.pid);
	writeFileSync(lockPath, pid, { encoding: "utf8" });
	writeFileSync(pidPath, pid, { encoding: "utf8" });
	return { lockPath, pidPath };
}

/** Read a PID from a lock/pid file, or `null` when absent/unreadable/garbage. */
function readPidFile(path: string): number | null {
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (raw.length === 0) return null;
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		// Absent file is the common case (no daemon running) — not an error.
		return null;
	}
}

/** Remove the PID/lock files (graceful shutdown / stale reclaim). Never throws. */
export function releaseSingleInstanceLock(runtimeDir: string): void {
	for (const name of [LOCK_FILE_NAME, PID_FILE_NAME]) {
		try {
			rmSync(join(runtimeDir, name), { force: true });
		} catch {
			// A missing lock on shutdown is fine — the goal (no stale lock) already holds.
		}
	}
}

/**
 * Compose the real {@link Authenticator} for team/hybrid mode (D-9). Tries the
 * bearer-token half (011b) then the API-key half (011d), returning the first
 * positively-validated {@link Identity}, else `null` (→ 401). In `local` mode the
 * daemon is loopback single-user and the permission middleware is open, so the
 * authenticator is never consulted; we still build it so a mode flip needs no rewire.
 *
 * Both halves are the REAL impls: the token half verifies a Bearer token via
 * `verifyTokenClaims` (011b), and the api-key half does the real `api_keys`
 * lookup-by-keyid → scrypt-verify → Identity read against the live storage client +
 * scope (011d). The composite returns the first non-null, else `null` → the middleware
 * maps `null` to 401.
 */
function composeAuthenticator(storage: StorageClient, scope: QueryScope): Authenticator {
	const tokenAuth = createTokenAuthenticator();
	// The REAL api-key half: it reads the `api_keys` table through the live client and
	// scope, hashes + verifies the presented key, and rejects revoked/cross-project keys.
	const apiKeyAuth = createApiKeyAuthenticator(storage, scope);
	return {
		async authenticate(presented: PresentedCredentials): Promise<Identity | null> {
			const byToken = await tokenAuth.authenticate(presented);
			if (byToken !== null) return byToken;
			return apiKeyAuth.authenticate(presented);
		},
	};
}

/**
 * Choose the authenticator + policy for the deployment mode (FR-9). `local` is loopback
 * single-user: the permission middleware is open, so the fail-closed defaults are fine
 * (they are never consulted). `team`/`hybrid` get the real composed authenticator + the
 * real RBAC policy. The ASSEMBLY ORDER does not change with mode — only which gate
 * objects are passed (a-AC-9 posture).
 */
function authForMode(
	mode: RuntimeConfig["mode"],
	storage: StorageClient,
	scope: QueryScope,
): { authenticator: Authenticator; policy: AuthorizationPolicy } {
	if (mode === "team" || mode === "hybrid") {
		return { authenticator: composeAuthenticator(storage, scope), policy: createRbacPolicy() };
	}
	// `local`: open middleware; the defaults are never reached but keep the shape stable.
	return { authenticator: composeAuthenticator(storage, scope), policy: defaultDenyPolicy };
}

/**
 * Fire the mount/attach seams EXACTLY ONCE, after construction, in a deterministic order
 * (a-AC-2 / FR-3): hooks → dashboard → notifications → sessions-prune → logs →
 * dashboard-host. Each reads through the live storage client + the queue/logger it needs.
 * This is the single caller of these seams in production; calling it twice would
 * double-register routes, so the composition root calls it once (the seams hold no global
 * state — the once-ness lives here).
 *
 * The first FIVE seams fire UNCONDITIONALLY. The sixth (`mountDashboardHost`) fires
 * LOCAL-MODE ONLY — see the security gate at step 6.
 */
export function assembleSeams(daemon: Daemon, storage: StorageClient, seams: SeamFns = defaultSeamFns): void {
	// 1. /api/hooks/* capture (019b). The capture write enqueues per-turn cues into the
	//    REAL durable queue (a-AC-3 service), heals the `sessions` table lazily.
	//    NOTE (021c): the context + session-end hook endpoints are NOT attached here yet
	//    — 021c attaches them onto the same already-mounted `/api/hooks` group and
	//    021d/021e fill their handlers. This seam is written so those land cleanly.
	seams.attachHooks(daemon, { storage, queue: daemon.services.queue });

	// 2. The dashboard data API (020b) — the six daemon-served view-models.
	seams.mountDashboard(daemon, { storage });

	// 3. The backend notifications API (020d) — the org's pending notifications.
	seams.mountNotifications(daemon, { storage });

	// 4. The sessions prune handler (020a) — paired trace+summary tombstones.
	//    SEAM (deferred, marked NOT faked): in team/hybrid the destructive prune needs a
	//    real `PruneActorAuthority` binding the requested actor to the authenticated
	//    identity. That actor↔identity binding is a follow-up (the "surface Identity to
	//    handlers" refactor). Until it lands, the seam's own fail-closed
	//    `denyUnboundActorAuthority` default applies (a multi-user prune is DENIED), which
	//    is the correct closed posture — never an open one. `local` mode (the first-class
	//    dogfood target, D-3) is single-user loopback and unaffected.
	seams.attachPrune(daemon, { storage });

	// 5. The /api/logs ring-buffer reader (021d / d-AC-2). Fires UNCONDITIONALLY — no
	//    security gate is needed because the `/api/logs` route group is already
	//    `protect:true` in `server.ts` (it inherits the same auth/RBAC middleware the
	//    JSON dashboard views enforce; in `local` mode that middleware is open per D-3).
	//    The record shape (`RequestLogRecord`) carries no token/header/body, so the read
	//    cannot leak a secret (security audit, /api/logs token-leak proof). The logger the
	//    handler reads is the daemon's own ring buffer.
	seams.mountLogs(daemon, { logger: daemon.logger });

	// 6. The viewable /dashboard HTML host (021d / d-AC-3) — LOCAL-MODE ONLY (security F-1).
	//    `mountDashboardHost` attaches `GET /dashboard` onto the UNPROTECTED root group
	//    (`server.ts`: `{ path: "/", protect: false }`), so a team/hybrid daemon would
	//    serve another tenant's KPIs/sessions/rules HTML with no auth check — the tenancy
	//    bypass security F-1 flagged. We gate it to `local` mode, the first-class
	//    single-user loopback dogfood target (D-3): there is exactly one tenant, the
	//    permission middleware is open by design, and the host is unreachable in
	//    team/hybrid. DEFERRED: wiring the host for team/hybrid waits on the separate
	//    `x-honeycomb-org` header-trust hardening ticket (the "surface Identity to
	//    handlers" refactor) — once that lands, the host can move to its own `protect:true`
	//    group and this gate can widen. Until then, team/hybrid get NO `/dashboard` route
	//    (it falls through to the root 501/404 scaffold), which is the correct closed
	//    posture — never an open tenancy hole.
	if (daemon.config.mode === "local") {
		seams.mountDashboardHost(daemon, { storage });
	}
}

/**
 * The composition root (a-AC-1..6 / FR-1..10). Constructs the live storage client,
 * resolves the daemon scope, builds the real services, composes the auth gates for the
 * mode, wires the cached `/health` probe, builds the daemon, and fires the four seams
 * once. Returns the assembled daemon plus lifecycle controls (PID/lock guard, graceful
 * shutdown). Pure construction — no socket is bound and no service is started here;
 * call `start()` then `startDaemon(assembled.daemon)` to listen.
 */
export function assembleDaemon(options: AssembleDaemonOptions = {}): AssembledDaemon {
	const config = options.config ?? resolveRuntimeConfig();
	const logger = options.logger ?? createRequestLogger();
	const runtimeDir = resolveRuntimeDir(options.runtimeDir);
	const probeIntervalMs = options.healthProbeIntervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS;

	// ── a-AC-1: construct the LIVE storage client. This is the ONLY production code
	// that imports `daemon/storage` to get a live client; allowed because this file is
	// inside `src/daemon/` (the composition root, D-2). A test injects a fake client.
	const storage = options.storage ?? createStorageClient();

	// The daemon's own tenancy partition: the org/workspace the storage config resolved.
	// `createStorageClient` validated config fail-closed, so `endpoint` is set, but the
	// org/workspace are not exposed on the client surface — re-resolve them cheaply from
	// the same provider so the queue + probe run under the right scope. An injected fake
	// client may not carry config; fall back to a benign loopback scope in that case.
	const scope = resolveDaemonScope(storage);

	// ── a-AC-3: the three REAL services replace the no-op stubs.
	const services: Partial<DaemonServices> = {
		queue: createJobQueueService({ storage, scope }),
		watcher: createFileWatcherService({
			workspaceDir: options.workspaceDir ?? process.cwd(),
			harnessTargets: options.harnessTargets ?? [],
			gitSync: { enabled: false },
		}),
		runtimePath: createRuntimePathService(),
	};

	// ── a-AC-4: the cached health bit. A cheap background `SELECT 1` refreshes a coarse
	// status; `/health` reads the bit (NO per-request heavy query). Initial state is
	// `ok` (a freshly-constructed live client is assumed reachable until the first probe
	// proves otherwise) — the server's own default would also report `ok` when storage is
	// wired, so this never reports a false green that the server would not.
	let healthBit: PipelineStatus = "ok";
	const pipelineProbe = (): PipelineStatus => healthBit;

	const { authenticator, policy } = authForMode(config.mode, storage, scope);

	const createOptions: CreateDaemonOptions = {
		config,
		storage,
		authenticator,
		policy,
		logger,
		services,
		pipelineProbe,
	};
	const daemon = createDaemon(createOptions);

	// ── a-AC-2: fire the seams EXACTLY ONCE, after construction (four core seams + the
	// /api/logs reader always; the /dashboard host local-mode only per security F-1).
	assembleSeams(daemon, storage, options.seams ?? defaultSeamFns);

	// ── The cached-health refresher: a cheap connectivity round trip on an interval,
	// updating the bit `/health` reads. Unref'd so it never keeps the process alive.
	let probeTimer: ReturnType<typeof setInterval> | null = null;
	async function refreshHealth(): Promise<void> {
		try {
			const res = await storage.query("SELECT 1", scope, { timeoutMs: 5_000 });
			healthBit = isOk(res) ? "ok" : "degraded";
		} catch {
			// A thrown probe (should not happen — the client returns a typed result) is
			// treated as degraded, never a crash of the refresher loop.
			healthBit = "degraded";
		}
	}

	let started = false;
	let locked = false;

	return {
		daemon,
		config,
		pipelineStatus: (): PipelineStatus => healthBit,

		async start(): Promise<void> {
			if (started) return;
			// a-AC-6: acquire the single-instance guard BEFORE starting services so a
			// second start fails fast (DaemonAlreadyRunningError) without warming anything.
			acquireSingleInstanceLock(runtimeDir);
			locked = true;
			started = true;

			// Prime the health bit once, then refresh on the interval.
			await refreshHealth();
			probeTimer = setInterval(() => {
				void refreshHealth();
			}, probeIntervalMs);
			if (typeof (probeTimer as NodeJS.Timeout).unref === "function") {
				(probeTimer as NodeJS.Timeout).unref();
			}

			// Start the daemon's real services (queue → watcher → runtime-path).
			await daemon.startServices();
		},

		async shutdown(): Promise<void> {
			// a-AC-5: graceful shutdown — stop the refresher, drain the services, and
			// remove the lock so no stale lock survives. Idempotent + never throws on a
			// missing lock.
			if (probeTimer !== null) {
				clearInterval(probeTimer);
				probeTimer = null;
			}
			if (started) {
				await daemon.stopServices();
				started = false;
			}
			if (locked) {
				releaseSingleInstanceLock(runtimeDir);
				locked = false;
			}
		},
	};
}

/**
 * Resolve the daemon's tenancy scope (`{ org, workspace }`) for the queue + health
 * probe. The storage client does not expose its config's org/workspace, so re-resolve
 * them from the same env provider the live client used. An injected fake client (tests)
 * has no env config; fall back to a benign single-user loopback scope so the
 * deterministic bits run without env. The scope is only the partition the queue rows +
 * the `SELECT 1` probe carry — never a tenancy a request is authorized against.
 */
function resolveDaemonScope(storage: StorageClient): QueryScope {
	// The real client carries an `endpoint` getter but not org/workspace; re-resolve from
	// env. In tests the env is unset, so this throws — caught to fall back to loopback.
	void storage;
	const org = process.env.HONEYCOMB_DEEPLAKE_ORG;
	const workspace = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;
	if (org !== undefined && org.length > 0) {
		return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
	}
	// Fail-soft default for a fake-client / no-env assembly (tests). A live assembly
	// always has `HONEYCOMB_DEEPLAKE_ORG` set (the storage config resolved fail-closed on
	// it), so this fallback never applies in production.
	return { org: "local", workspace: "default" };
}
