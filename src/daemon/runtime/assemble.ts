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

import { LEGACY_CREDENTIALS_DIR_NAME, DIR_MODE } from "./auth/credentials-store.js";
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
import { mountDreamApi } from "./dreaming/api.js";
import { mountCompactApi } from "./maintenance/compact-api.js";
import { mountLogsApi } from "./logs/api.js";
import { mountNotificationsApi } from "./notifications/api.js";
import { attachSessionsPrune } from "./sessions/prune.js";

// ── Data-API mount seams (PRD-022a / 022b / 022c) the composition root fires (D-2 / d-AC-1) ──
import { mountMemoriesApi } from "./memories/index.js";
import { mountVfsApi } from "./vfs/api.js";
import { mountProductDataApi } from "./product/index.js";
import { type SecretsApiDeps } from "./secrets/api.js";
import { SecretsStore, createMachineKeyProvider } from "./secrets/store.js";
import type { SecretScope } from "./secrets/contracts.js";

import { buildInferenceModelClient } from "./inference/model-client-factory.js";
import type { ModelClient } from "./pipeline/model-client.js";
import { resolveDreamingConfig } from "./dreaming/config.js";
import { createDreamingTrigger } from "./dreaming/trigger.js";
import { createDreamingWorker, type DreamingJobWorker } from "./dreaming/worker.js";

import { createStorageClient } from "../storage/index.js";
import {
	type CredentialProvider,
	defaultCredentialProvider,
} from "../storage/config.js";
import type { QueryScope, StorageClient } from "../storage/client.js";
import { isOk } from "../storage/result.js";
import { type EmbedAttachment, createEmbedAttachment } from "./services/embed-client.js";
import { type EmbedSupervisor, createEmbedSupervisor } from "./services/embed-supervisor.js";

/**
 * The inference-config filename the daemon reads its `inference:` block from (PRD-026
 * AC-T). It lives at the WORKSPACE ROOT — `$HONEYCOMB_WORKSPACE` (the same base dir the
 * `.secrets/` store + the secrets API resolve under, defaulting to the daemon's cwd) — so
 * the file the operator edits, the `.secrets/` dir the `${ANTHROPIC_API_KEY}` ref resolves
 * against, and the daemon all agree on ONE location. The file is OPTIONAL: when absent (or
 * lacking an `inference:` block) `buildInferenceModelClient` degrades to the no-op client
 * and the daemon boots cleanly with dreaming/inference simply unavailable. It carries NO
 * secret — only the `${SECRET_REF}` reference (an inline key is rejected at parse). */
export const AGENT_CONFIG_FILE_NAME = "agent.yaml";

/** The single-instance lock filename under `~/.honeycomb/` (FR-8 / a-AC-6). */
export const LOCK_FILE_NAME = "daemon.lock";
/** The PID filename under `~/.honeycomb/` (FR-8 / a-AC-6). */
export const PID_FILE_NAME = "daemon.pid";

// NOTE (PRD-023): the daemon RUNTIME dir (PID + lock) stays at `~/.honeycomb` — it is
// Honeycomb-private process state, NOT a shared credential. Only the credentials file
// moved to the shared `~/.deeplake` (D-1). So the runtime dir resolves via the LEGACY
// dir name; the credentials store owns the `.deeplake` path independently.

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
	/**
	 * The credential provider the daemon resolves its OWN tenancy scope (`{ org, workspace }`)
	 * and friendly `orgName` from — the SAME provider {@link createStorageClient} connects
	 * through (env-over-file, {@link defaultCredentialProvider}). Defaults to that provider so
	 * a plain `honeycomb login` (NO env) resolves the real org from `~/.deeplake/credentials.json`
	 * instead of the `"local"` placeholder. A unit test that injects a fake {@link storage}
	 * leaves this unset → no creds → the deterministic `{ org: "local", workspace: "default" }`
	 * fallback (the suite is unchanged). A test may inject a fake provider to drive the scope
	 * deterministically without env or a real file.
	 */
	readonly provider?: CredentialProvider;
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
	/**
	 * The embed seam wired into the store + capture paths (PRD-025 AC-2). Defaults to the
	 * REAL `createEmbedAttachment({ storage })` resolved from `resolveEmbedClientOptions`
	 * (D-1 default-on) — so a fresh daemon stores + captures with a real 768-dim vector when
	 * embeddings are available, and falls back to a NULL vector (lexical) when not, never a
	 * throw. A unit test injects a FAKE attachment (e.g. a no-op or a deterministic stub) to
	 * keep the assembly hermetic. Production never sets this.
	 */
	readonly embed?: EmbedAttachment;
	/**
	 * The embed-daemon SUPERVISOR wired into the daemon lifecycle (PRD-025 Wave 2 / D-6).
	 * Defaults to the REAL {@link createEmbedSupervisor} — so a fresh daemon spawns,
	 * health-checks, and crash-restarts the embed daemon child (warming it OFF the turn
	 * path, D-3), and an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` makes it inert (D-1
	 * opt-out, no child spawned). A unit test injects a FAKE supervisor (e.g. a no-op or a
	 * recording stub) so the assembly never spawns a real process. Production never sets this.
	 */
	readonly embedSupervisor?: EmbedSupervisor;
	/**
	 * The filesystem path to the `inference:` config (`agent.yaml`) the daemon builds its
	 * real {@link ModelClient} from (PRD-026 AC-T). Defaults to `agent.yaml` under
	 * `$HONEYCOMB_WORKSPACE` (the daemon's cwd when unset) — the SAME base the `.secrets/`
	 * store resolves the `${ANTHROPIC_API_KEY}` ref under. A test points it at a temp file
	 * (or a path that does not exist) to drive the no-op degrade deterministically. Absent /
	 * unparseable → the no-op model client (never a throw).
	 */
	readonly agentConfigPath?: string;
	/**
	 * The dreaming `memory.dreaming` config provider seam (PRD-026 AC-W gate). Defaults to
	 * the env provider ({@link resolveDreamingConfig}'s default), so `enabled` is OFF unless
	 * `HONEYCOMB_DREAMING_ENABLED=true`/`1`. A test injects a fixed provider to drive the
	 * `enabled:true` / `enabled:false` worker-start gate WITHOUT touching `process.env`.
	 */
	readonly dreamingConfigProvider?: Parameters<typeof resolveDreamingConfig>[0];
	/**
	 * The pre-built dreaming worker, injectable for testing (AC-W). Production leaves it
	 * unset → the composition root builds the REAL worker from the daemon's scope + storage +
	 * model + queue WHEN `config.enabled`. A test injects a recording fake to assert
	 * `start()`/`stop()` are called exactly when the gate says so, without a live queue.
	 * When `null` is injected the build step is skipped entirely (the "no worker constructed
	 * when disabled" assertion). Production never sets this.
	 */
	readonly dreamingWorker?: DreamingJobWorker | null;
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
	/** The `/api/memories/*` data API (022a). Fires UNCONDITIONALLY — its group is a protected session group. */
	readonly mountMemories: typeof mountMemoriesApi;
	/** The `/memory/*` VFS browse reads (022b). Fires UNCONDITIONALLY — its group is a protected session group. */
	readonly mountVfs: typeof mountVfsApi;
	/** The product-data surface — goals/kpis/skills/rules (+secrets) (022c). Fires UNCONDITIONALLY. */
	readonly mountProductData: typeof mountProductDataApi;
	/**
	 * The "Dream now" trigger — `POST /api/diagnostics/dream` (PRD-024 / AC-6). Fires
	 * UNCONDITIONALLY: its `/api/diagnostics` group is already `protect:true`, so it inherits
	 * the same auth/RBAC as the dashboard's JSON views (open in `local`, gated in team/hybrid).
	 */
	readonly mountDream: typeof mountDreamApi;
	/**
	 * The standalone version-history COMPACTION trigger — `POST /api/diagnostics/compact`
	 * (PRD-030 / D-2 PRIMARY). Fires UNCONDITIONALLY: its `/api/diagnostics` group is already
	 * `protect:true`, so it inherits the same auth/RBAC as the dashboard's JSON views (open in
	 * `local`, gated in team/hybrid). Fail-soft — a mount error never crashes the daemon.
	 */
	readonly mountCompact: typeof mountCompactApi;
}

/** The REAL seam functions (the production wiring). */
export const defaultSeamFns: SeamFns = {
	attachHooks: attachHooksHandlers,
	mountDashboard: mountDashboardApi,
	mountNotifications: mountNotificationsApi,
	attachPrune: attachSessionsPrune,
	mountLogs: mountLogsApi,
	mountDashboardHost,
	mountMemories: mountMemoriesApi,
	mountVfs: mountVfsApi,
	mountProductData: mountProductDataApi,
	mountDream: mountDreamApi,
	mountCompact: mountCompactApi,
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
	return dir ?? join(homedir(), LEGACY_CREDENTIALS_DIR_NAME);
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
 * LOCAL-MODE ONLY — see the security gate at step 6. Steps 7–9 fire the data-API mount
 * seams (022a/022b/022c) UNCONDITIONALLY: each resolves its OWN already-mounted +
 * protected route group (`/api/memories`, `/memory`, `/api/goals`…), so there is no
 * `server.ts` edit and the fire order among them is unconstrained.
 */
export function assembleSeams(
	daemon: Daemon,
	storage: StorageClient,
	defaultScope: QueryScope,
	orgName: string | undefined,
	embed: EmbedAttachment,
	seams: SeamFns = defaultSeamFns,
): void {
	// The daemon's configured default tenancy scope (the single LOCAL tenant) is RESOLVED ONCE
	// at the composition root (`assembleDaemon`) from the SAME credential source the storage
	// client connected through, then THREADED in here — never re-resolved independently. (The
	// prior split, where the storage client read `~/.deeplake` but the scope re-read env, was
	// the bug: a plain login with no env resolved the scope to the `"local"` placeholder while
	// the client connected to the real org.) It is threaded into the three data-API mounts as
	// `defaultScope` so a loopback thin client (SDK/MCP) that carries NO `x-honeycomb-org`
	// header resolves to this tenant in local mode (PRD-022). In team/hybrid the data handlers
	// ignore it (the fallback fires ONLY in local mode), so threading it unconditionally is safe
	// — tenancy is never loosened outside local.

	// 1. /api/hooks/* capture (019b). The capture write enqueues per-turn cues into the
	//    REAL durable queue (a-AC-3 service), heals the `sessions` table lazily.
	//    NOTE (021c): the context + session-end hook endpoints are NOT attached here yet
	//    — 021c attaches them onto the same already-mounted `/api/hooks` group and
	//    021d/021e fill their handlers. This seam is written so those land cleanly.
	//    PRD-025 AC-2: the capture embed seam is the REAL `createEmbedAttachment` (D-1
	//    default-on), so a captured turn lands a non-NULL 768-dim `message_embedding`
	//    when embeddings are available; when not, the embedder returns null and the row
	//    lands lexically (NULL vector) — never a throw (the 005b null-on-failure floor).
	seams.attachHooks(daemon, { storage, queue: daemon.services.queue, embed });

	// 2. The dashboard data API (020b) — the six daemon-served view-models. Threads the
	//    LOCAL default scope so the dashboard web app (a loopback thin client that sends no
	//    `x-honeycomb-org`) resolves the single local tenant instead of 400ing (PRD-024 Wave 3).
	seams.mountDashboard(daemon, { storage, defaultScope, orgName });

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

	// 7. The /api/memories/* data API (022a). Recall + store + get/list + reason-gated
	//    modify/forget land on the already-mounted, protected `/api/memories` SESSION
	//    group. PRD-025 AC-2: the store `embed` seam is the REAL `createEmbedAttachment`
	//    client (D-1 default-on) — a deliberately-stored memory lands a non-NULL 768-dim
	//    `content_embedding` when embeddings are available; when not, the embedder returns
	//    null and the row lands lexically (NULL vector), still recallable via the lexical
	//    arm. This replaces the PRD-004 501 scaffold: after this, `honeycomb recall`/
	//    `remember`, the SDK `recall()`, and the MCP `memory_search` reach a REAL handler.
	seams.mountMemories(daemon, { storage, defaultScope, embed: embed.client });

	// 8. The /memory/* VFS browse reads (022b). cat / grep / ls / find / classify attach
	//    onto the already-mounted `/memory` SESSION group; `recallConfig` defaults to the
	//    env-resolved recall config and `hints` to the empty source, so `{ storage }` is
	//    the full wiring. Read-only — writes 405 with a pointer to `/api/memories` (022a).
	seams.mountVfs(daemon, { storage, defaultScope });

	// 9. The product-data surface (022c): goals + kpis (read/upsert) + skills + rules
	//    (read-only) always; PLUS the names-only `/api/secrets` engine (012), whose store
	//    is cleanly constructible at the composition root. `/api/sources` (013) is DEFERRED
	//    — see {@link resolveProductDataDeps} — because its registry/providers deps are not
	//    yet constructible here; the goal is NOT mounted (it falls through to the 501
	//    scaffold) rather than wired with a fake (D-1, never fake a dep).
	seams.mountProductData(daemon, resolveProductDataDeps(storage, defaultScope));

	// 10. The "Dream now" trigger — `POST /api/diagnostics/dream` (PRD-024 / AC-6 backend).
	//     Attaches onto the already-mounted, protected `/api/diagnostics` group (the dashboard's
	//     group), so there is NO `server.ts` edit and it inherits the same auth/RBAC the JSON
	//     dashboard views enforce (open in `local`, gated in team/hybrid). It kicks the REAL
	//     PRD-009 Dreaming loop via the 009a trigger seam, injected the daemon's OWN durable job
	//     queue (`daemon.services.queue`) as the enqueuer — NOT a second dreaming subsystem. The
	//     handler is NON-BLOCKING: the trigger only ENQUEUES a `dreaming` job (the consolidation
	//     pass is run later by the queue worker via the 009b/009c runner) and returns a 202 ack.
	//     The `defaultScope` is the daemon's tenancy partition the dreaming counter lives under
	//     (the same single local tenant the data-API mounts use). When the queue is the no-op stub
	//     (a bare `createDaemon`), the handler fails soft to a clean `{ triggered: false }` ack.
	seams.mountDream(daemon, { storage, defaultScope, enqueuer: daemon.services.queue });

	// 11. The standalone version-history COMPACTION trigger — `POST /api/diagnostics/compact`
	//     (PRD-030 / D-2 PRIMARY). Attaches onto the same already-mounted, protected
	//     `/api/diagnostics` group (NO `server.ts` edit), so it inherits the dashboard JSON
	//     views' auth/RBAC (open in `local`, gated in team/hybrid). It runs the Wave-1
	//     version-history compactor over the allow-listed version-bumped tables under the
	//     daemon's `defaultScope` — the standalone maintenance path that runs REGARDLESS of
	//     premium dreaming. FAIL-SOFT: the mount resolves the retention config (which could
	//     throw on a malformed `HONEYCOMB_COMPACTION_*` knob) and registers the route; we wrap
	//     it so a mount/config error degrades to "no compaction route this run" rather than
	//     crashing the daemon (the standalone job is best-effort, never load-bearing for boot).
	try {
		seams.mountCompact(daemon, { storage, defaultScope });
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: compaction route mount failed (non-fatal): ${reason}\n`);
	}
}

/**
 * Build the product-data seam deps (022c) the composition root can construct TODAY.
 *
 * - `storage`: the live client (goals/kpis/skills/rules read+write through it).
 * - `secrets`: the names-only secrets engine (012). Its only dep is a {@link SecretsStore}
 *   constructed from `$HONEYCOMB_WORKSPACE` (the workspace root the `.secrets/` dir lives
 *   under) + the real machine-key provider — both available at assembly. No value ever
 *   crosses the HTTP boundary (the API mounts no value-returning route by construction).
 * - `sources`: DEFERRED (NOT wired, NOT faked — D-1). The existing `mountSourcesApi` (013)
 *   needs a `registry` + a `providers` resolver that are not yet constructible at the
 *   composition root (they belong to the sources subsystem's own assembly, a follow-up).
 *   Omitting `sources` makes `mountProductDataApi` skip the `/api/sources` mount, so the
 *   group falls through to the 501 scaffold — the correct honest posture until the deps
 *   land. 022e does not depend on `/api/sources`.
 */
function resolveProductDataDeps(
	storage: StorageClient,
	defaultScope: QueryScope,
): {
	storage: StorageClient;
	secrets?: SecretsApiDeps;
	defaultScope: QueryScope;
} {
	// The secrets store base dir is the workspace root ($HONEYCOMB_WORKSPACE), defaulting to
	// the daemon's cwd when unset (the same default the secrets CONVENTIONS document).
	const baseDir = process.env.HONEYCOMB_WORKSPACE ?? process.cwd();
	const secrets: SecretsApiDeps = {
		store: new SecretsStore({ baseDir, machineKey: createMachineKeyProvider() }),
	};
	// `defaultScope` is threaded so goals/kpis/skills/rules apply the local-mode fallback
	// (PRD-022); the secrets/sources sub-handlers carry their own header scope resolvers.
	return { storage, secrets, defaultScope };
}

// ─────────────────────────────────────────────────────────────────────────────
// The daemon-resident dreaming WORKER wiring (PRD-026 AC-W + AC-T) — gated OFF.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The default workspace base dir the daemon resolves filesystem state under
 * (`$HONEYCOMB_WORKSPACE`, defaulting to the daemon's cwd). This is the SINGLE source the
 * `.secrets/` store (PRD-012a), the secrets API mount ({@link resolveProductDataDeps}), and
 * the inference {@link AGENT_CONFIG_FILE_NAME} all resolve under, so the `agent.yaml` the
 * operator edits and the `.secrets/` dir its `${ANTHROPIC_API_KEY}` ref decrypts from agree
 * on ONE root. Read at most once at assembly.
 */
function resolveWorkspaceBaseDir(): string {
	return process.env.HONEYCOMB_WORKSPACE ?? process.cwd();
}

/**
 * Resolve the path the daemon reads its `inference:` block from (PRD-026 AC-T): the
 * injected override when a test supplies one, else `agent.yaml` under the workspace root.
 * Returned as a path so {@link buildInferenceModelClient} loads it lazily (and degrades to
 * the no-op client when the file or block is absent — never a throw).
 */
function resolveAgentConfigPath(options: AssembleDaemonOptions): string {
	return options.agentConfigPath ?? join(resolveWorkspaceBaseDir(), AGENT_CONFIG_FILE_NAME);
}

/**
 * Lift the daemon's resolved {@link QueryScope} (`{ org, workspace? }`) onto the
 * {@link SecretScope} the inference secret resolver decrypts the `${ANTHROPIC_API_KEY}` ref
 * under. The org rides through unchanged; an absent `workspace` defaults to `"default"`,
 * matching the no-creds tenancy fallback ({@link resolveDaemonTenancy} step (c)). THIS is
 * the scope the operator/smoker MUST store the Anthropic key under for the resolver to find
 * it — it is the daemon's OWN tenancy, never a per-request identity.
 */
function secretScopeFromQueryScope(scope: QueryScope): SecretScope {
	return { org: scope.org, workspace: scope.workspace ?? "default" };
}

/**
 * Build the gated dreaming subsystem (AC-W + AC-T) — the real inference {@link ModelClient}
 * + the real {@link DreamingTrigger} + the {@link DreamingJobWorker} — and return the worker
 * to START, or `null` when dreaming is disabled.
 *
 * ── Fail-soft is the whole contract (D-1) ────────────────────────────────────
 * Nothing here may prevent the daemon from booting. The dreaming config is resolved inside a
 * try/catch (a fat-fingered `HONEYCOMB_DREAMING_*` knob degrades to "disabled", never a
 * throw); when disabled NONE of the heavy bits (model client, trigger, worker) are even
 * constructed. The model client is built via {@link buildInferenceModelClient}, which NEVER
 * throws — an absent/unparseable `agent.yaml` yields the no-op client, so the worker simply
 * produces zero-mutation passes until the operator adds the `inference:` block + key.
 *
 * ── The pendingTerminal probe choice (FR-6) ──────────────────────────────────
 * The trigger's single-pending guard wants a probe that resolves a `dreaming` job's terminal
 * state from `memory_jobs`. The public {@link JobQueueService} interface exposes NO
 * status-by-id read (only enqueue/lease/complete/fail) — the converging `resolveCurrent`
 * read is private. So we DO NOT pass a `pendingTerminal` and the trigger applies its
 * documented conservative default: never report terminal, i.e. never enqueue a SECOND pass on
 * a guess. The worker clears `pending_job_id` itself on a completed pass (via
 * `recordPassComplete`), so a finished pass un-wedges the scope through the normal path; only
 * a hard-crashed pass would wait for a later mechanism, which is the safe posture.
 *
 * @returns the constructed-but-NOT-started worker when `enabled`, else `null`.
 */
async function buildGatedDreamingWorker(
	options: AssembleDaemonOptions,
	storage: StorageClient,
	scope: QueryScope,
	queue: DaemonServices["queue"],
): Promise<DreamingJobWorker | null> {
	// Resolve the gate fail-soft FIRST: a malformed dreaming-config knob must NEVER take the
	// daemon down — treat it as disabled (the false-safe default the schema already documents).
	let config: ReturnType<typeof resolveDreamingConfig>;
	try {
		config = resolveDreamingConfig(options.dreamingConfigProvider);
	} catch {
		return null;
	}

	// GATE (D-1, default OFF): the gate is checked BEFORE any worker is returned — even an
	// INJECTED test worker is NOT started when disabled (the gate is the contract, not the
	// injection). When disabled, construct NOTHING heavy — no model client, no trigger, no
	// worker. Re-enabling later resumes from the accumulated counter.
	if (!config.enabled) {
		return null;
	}

	// Past the gate (enabled): an explicit test override replaces the real build (a recording
	// fake to assert start/stop, or `null` to assert "enabled but no worker constructed").
	// Production leaves it unset → the real build below runs.
	if (options.dreamingWorker !== undefined) {
		return options.dreamingWorker;
	}

	// The real inference ModelClient (AC-T). Never throws — degrades to the no-op client when
	// no `agent.yaml`/`inference:` block/key is present yet (so enabling dreaming before the
	// key exists boots cleanly and yields empty, zero-mutation passes).
	const secretsStore = new SecretsStore({
		baseDir: resolveWorkspaceBaseDir(),
		machineKey: createMachineKeyProvider(),
	});
	const model: ModelClient = await buildInferenceModelClient({
		scope: secretScopeFromQueryScope(scope),
		secretsStore,
		config: resolveAgentConfigPath(options),
	});

	// The REAL PRD-009a trigger: its `readState` feeds the worker's first-run backfill rule
	// and its additive `recordPassComplete` is the runner's append-only state-update seam. It
	// reuses the daemon's OWN durable queue as the enqueuer — no second dreaming subsystem.
	// No `pendingTerminal` probe is passed (see the JSDoc above): the queue exposes no public
	// status-by-id read, so the trigger applies its conservative never-terminal default.
	const trigger = createDreamingTrigger({ storage, scope, config, enqueuer: queue });

	// The consumer: leases ONLY `["dreaming"]`, runs the runner with the real model + the 008c
	// apply (inside the runner) + the append-only state update, completes/fails the job.
	return createDreamingWorker({ queue, storage, scope, config, model, trigger });
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
	//
	// Resolve the credential PROVIDER ONCE here so the storage client AND the daemon's own
	// tenancy scope are derived from the SAME source — they can never disagree (the prior
	// split, where the client read `~/.deeplake` but the scope re-read env, was the bug).
	// When a test injects a fake `storage`, there is no live provider and no creds to read,
	// so the scope falls through to the `"local"` default (the deterministic suite is
	// unchanged). When the real client is built, it connects THROUGH this very provider.
	const provider: CredentialProvider | undefined =
		options.storage !== undefined ? options.provider : (options.provider ?? defaultCredentialProvider());
	const storage = options.storage ?? createStorageClient(provider !== undefined ? { provider } : {});

	// The daemon's own tenancy partition + friendly org name: resolved from the SAME
	// credential provider the storage client connected through (env-over-file), with env as
	// an override and `"local"` ONLY as the true no-creds fallback (a fake client / no env).
	// The queue + health probe run under this scope; the dashboard settings view shows the
	// friendly `orgName`.
	const tenancy = resolveDaemonTenancy(provider);
	const scope = tenancy.scope;
	const daemonOrgName = tenancy.orgName;

	// ── a-AC-3: the three REAL services replace the no-op stubs.
	const services: Partial<DaemonServices> = {
		queue: createJobQueueService({ storage, scope }),
		watcher: createFileWatcherService({
			workspaceDir: options.workspaceDir ?? process.cwd(),
			harnessTargets: options.harnessTargets ?? [],
			gitSync: { enabled: false },
		}),
		runtimePath: createRuntimePathService(),
		// PRD-025 D-6: the daemon OWNS the embed daemon. The supervisor spawns + health-checks
		// + crash-restarts the embed child, warming it OFF the turn path (D-3). It reads the
		// SAME `HONEYCOMB_EMBEDDINGS` opt-out the embed client does, so an explicit `false`/`0`
		// makes it inert (no child) and unset/on spawns with zero config (D-1). A test injects a
		// fake supervisor so the hermetic assembly never spawns a real process.
		embed: options.embedSupervisor ?? createEmbedSupervisor(),
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

	// ── PRD-025 AC-2: the embed seam wired into the store + capture paths. Default to the
	// REAL `{ client, attacher }` pair (D-1 default-on, resolved from the env), built ONCE
	// here and threaded into BOTH the capture handler (the full attachment) and the memories
	// store path (its `client`). A test injects a fake attachment to keep assembly hermetic.
	// `createEmbedAttachment` reads `resolveEmbedClientOptions()` when no options are passed,
	// so unset → enabled; an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` → a null-returning
	// client (clean lexical-only). The attacher writes through the same live storage client.
	const embed = options.embed ?? createEmbedAttachment({ storage });

	// ── a-AC-2 / d-AC-1: fire the seams EXACTLY ONCE, after construction (the four core
	// seams + the /api/logs reader always; the /dashboard host local-mode only per security
	// F-1; PLUS the three data-API seams — memories/vfs/product-data — always, 022d).
	assembleSeams(daemon, storage, scope, daemonOrgName, embed, options.seams ?? defaultSeamFns);

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
	// PRD-026 AC-W: the daemon-resident dreaming worker. Built + started ONLY when
	// `resolveDreamingConfig().enabled` (default OFF), inside `start()` AFTER the queue is up,
	// and stopped in `shutdown()`. Null until/unless the gate opens — a disabled daemon never
	// constructs the heavy bits (model client, trigger, worker).
	let dreamingWorker: DreamingJobWorker | null = null;

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

			// ── PRD-026 AC-W: build + start the dreaming worker, GATED on `config.enabled`
			// (default OFF). It is built AFTER `startServices()` so it leases from a started
			// queue. The build is FAIL-SOFT: a dreaming-config error or a missing inference
			// config degrades to `null` (disabled) / the no-op model client — it must NEVER
			// prevent the daemon from booting, so any error here is swallowed into "no worker"
			// rather than propagated. When the gate is closed, `buildGatedDreamingWorker`
			// returns null and we start nothing.
			try {
				dreamingWorker = await buildGatedDreamingWorker(options, storage, scope, daemon.services.queue);
				dreamingWorker?.start();
			} catch (err: unknown) {
				// A dreaming wiring failure is surfaced to stderr (never silently swallowed) but is
				// NOT fatal: the daemon is already up and serving; dreaming simply stays off this
				// run. We narrow the error to a message so a thrown non-Error still reports cleanly.
				// stderr is the documented daemon log channel (logger.ts) and carries no secret here
				// — `buildGatedDreamingWorker` resolves the key only inside the router's local scope.
				const reason = err instanceof Error ? err.message : String(err);
				process.stderr.write(`honeycomb: dreaming worker start failed (non-fatal): ${reason}\n`);
				dreamingWorker = null;
			}
		},

		async shutdown(): Promise<void> {
			// a-AC-5: graceful shutdown — stop the dreaming worker + the refresher, drain the
			// services, and remove the lock so no stale lock survives. Idempotent + never throws
			// on a missing lock.
			if (dreamingWorker !== null) {
				dreamingWorker.stop();
				dreamingWorker = null;
			}
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

/** The daemon's own resolved tenancy: the scope its queue + probe run under, plus the
 * friendly org name the dashboard settings view shows (display-only, may be undefined). */
interface DaemonTenancy {
	/** The partition the queue rows + the `SELECT 1` probe carry — never a request's authorized tenancy. */
	readonly scope: QueryScope;
	/** The human-readable org name from the credentials (e.g. "OSPRY"); `undefined` when no creds. */
	readonly orgName: string | undefined;
}

/**
 * Resolve the daemon's OWN tenancy (`{ org, workspace }` + friendly `orgName`) from the
 * SAME credential provider the storage client connected through (env-over-file), so the
 * daemon's default scope can NEVER disagree with the org the client actually authenticated
 * against. (The prior implementation re-read `HONEYCOMB_DEEPLAKE_ORG` from the env ONLY and
 * fell back to the `"local"` placeholder — so a plain `honeycomb login` with NO env left the
 * client connected to the real org while the scope said `"local"`, degrading `/health` and
 * breaking recall. THAT split was the bug.)
 *
 * Precedence (matching `resolveStorageConfig`'s env-over-file merge):
 *   (a) `HONEYCOMB_DEEPLAKE_ORG` / `_WORKSPACE` env if set — the explicit override + the
 *       live-itest path that exports them (preserved exactly);
 *   (b) else the resolved credentials' `org` (← `orgId`) + `workspace` (← `workspaceId`) from
 *       `~/.deeplake/credentials.json` via the SAME `provider` the storage client used;
 *   (c) else `{ org: "local", workspace: "default" }` — the TRUE no-creds fallback (an
 *       injected fake client in unit tests has no provider, so the deterministic suite is
 *       unchanged).
 *
 * `provider` is the resolved credential provider (or `undefined` for a fake-client assembly
 * with no provider injected → the `"local"` fallback). It is read at most ONCE here; the
 * record is the un-validated raw config (the same `read()` the storage config validates),
 * carrying `org` / `workspace` / `orgName`. No token is read or logged here.
 */
function resolveDaemonTenancy(provider: CredentialProvider | undefined): DaemonTenancy {
	// (a) Env override wins, exactly as before — preserves the explicit escape hatch and the
	//     live-itest path that exports `HONEYCOMB_DEEPLAKE_ORG`/`_WORKSPACE`.
	const envOrg = process.env.HONEYCOMB_DEEPLAKE_ORG;
	const envWorkspace = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;

	// (b) The resolved credentials from the SAME provider the client connected through. `read()`
	//     applies the env-over-file merge already, so this single source agrees with the client.
	const record = provider !== undefined ? provider.read() : {};
	const fileOrg = asNonEmptyString(record.org);
	const fileWorkspace = asNonEmptyString(record.workspace);
	const orgName = asNonEmptyString(record.orgName);

	const org =
		envOrg !== undefined && envOrg.length > 0 ? envOrg : fileOrg;
	const workspace =
		envWorkspace !== undefined && envWorkspace.length > 0 ? envWorkspace : fileWorkspace;

	if (org !== undefined) {
		// A workspace is optional on the scope (the client defaults it to the config workspace);
		// thread it when we resolved one so the partition matches the storage client.
		const scope: QueryScope = workspace !== undefined ? { org, workspace } : { org };
		return { scope, orgName };
	}

	// (c) No creds at all (fake client / no env) → the deterministic single-user loopback scope.
	return { scope: { org: "local", workspace: "default" }, orgName: undefined };
}

/** Narrow an unknown provider-record field to a non-empty string, else `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
