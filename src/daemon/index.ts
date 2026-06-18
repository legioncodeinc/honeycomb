/**
 * Daemon core entry root.
 *
 * The long-lived process that owns durable state. This is the ONLY package that
 * links the DeepLake client; every other target reaches it through the thin
 * `src/daemon-client` surface. Keeping DeepLake imports confined here is what
 * lets PRD-001b emit a daemon-only DeepLake bundle (index AC-2).
 *
 * PRD-004a wires the runtime: the Hono HTTP server (`./runtime/server.ts`), the
 * config resolver, the permission/runtime-path middleware, the structured
 * logger, and the production listen path. The Wave-2 services (job queue 004b,
 * file watcher 004c, runtime-path 004d) are pre-wired stubs injected by
 * `createDaemon`; see `./runtime/CONVENTIONS.md`.
 */

import { DAEMON_HOST, DAEMON_PORT, HONEYCOMB_VERSION } from "../shared/constants.js";
import { resolveRuntimeConfig } from "./runtime/config.js";
import { startDaemon as startDaemonListener } from "./runtime/listen.js";
import { createDaemon, type CreateDaemonOptions, type Daemon } from "./runtime/server.js";

// DeepLake access path lives here (PRD-002). Do NOT add a DeepLake import in any
// non-daemon package; harness/CLI/MCP bundles must stay DeepLake-free.
//
// PRD-002a: the storage adapter (DeepLake client/config/transport/result-union)
// lives under ./storage and is re-exported ONLY from this daemon root, so the
// DeepLake path is reachable solely inside the daemon bundle (a-AC-5).
export * from "./storage/index.js";

// ── PRD-004a runtime surface ────────────────────────────────────────────────
export {
	type CreateDaemonOptions,
	createDaemon,
	type Daemon,
	type DaemonServices,
} from "./runtime/server.js";
export {
	type DeploymentMode,
	DEPLOYMENT_MODES,
	envRuntimeConfigProvider,
	resolveRuntimeConfig,
	type RuntimeConfig,
	RuntimeConfigError,
	RuntimeConfigSchema,
} from "./runtime/config.js";
export { createRequestLogger, type RequestLogger, type RequestLogRecord } from "./runtime/logger.js";
export {
	defaultDenyPermissionCheck,
	legacyPermissionCheckAdapter,
	noSocketPeer,
	type PermissionCheck,
	type PermissionContext,
	type PermissionMiddlewareOptions,
	permissionMiddleware,
	type SocketPeerProbe,
} from "./runtime/middleware/permission.js";
export * from "./runtime/auth/index.js";
export {
	noopRuntimePathService,
	type RuntimePath,
	type RuntimePathService,
	runtimePathMiddleware,
} from "./runtime/middleware/runtime-path.js";
export { type FileWatcherService, noopFileWatcherService } from "./runtime/services/file-watcher.js";
export { type JobInput, type JobQueueService, type LeasedJob, noopJobQueueService } from "./runtime/services/job-queue.js";
export type { DaemonService } from "./runtime/services/types.js";
export { type RunningDaemon, startDaemon as startDaemonListener } from "./runtime/listen.js";

/** Static description of the daemon process, derived from shared constants. */
export interface DaemonInfo {
	host: string;
	port: number;
	version: string;
}

/** Return the daemon's bind info without starting it. */
export function daemonInfo(): DaemonInfo {
	return { host: DAEMON_HOST, port: DAEMON_PORT, version: HONEYCOMB_VERSION };
}

/**
 * Build the daemon (Hono app + wired services) without binding a socket. The CLI
 * calls this, then `runDaemon` to listen. Tests call this and exercise
 * `daemon.app` in-process via `app.request(...)`. Importing this module never
 * auto-listens.
 */
export function createServer(options: CreateDaemonOptions = {}): Daemon {
	return createDaemon(options);
}

/**
 * Production entry: resolve config from the environment (fail-closed), build the
 * daemon, and bind the HTTP socket on `host:port` (FR-1). Returns a handle to
 * close it. This is the only path that opens a socket; the CLI invokes it.
 */
export async function runDaemon(options: CreateDaemonOptions = {}): Promise<{
	daemon: Daemon;
	address: { host: string; port: number };
	close(): Promise<void>;
}> {
	const config = options.config ?? resolveRuntimeConfig();
	const daemon = createDaemon({ ...options, config });
	const running = await startDaemonListener(daemon);
	return { daemon, address: running.address, close: running.close };
}
