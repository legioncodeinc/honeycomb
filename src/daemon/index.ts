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

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DAEMON_HOST, DAEMON_PORT, HONEYCOMB_VERSION } from "../shared/constants.js";
import { type AssembleDaemonOptions, type AssembledDaemon, assembleDaemon } from "./runtime/assemble.js";
import { resolveRuntimeConfig } from "./runtime/config.js";
import { startDaemon as startDaemonListener } from "./runtime/listen.js";
import { type CreateDaemonOptions, createDaemon, type Daemon } from "./runtime/server.js";

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
export {
	type EmbedSupervisor,
	type EmbedSupervisorDeps,
	createEmbedSupervisor,
	noopEmbedSupervisor,
} from "./runtime/services/embed-supervisor.js";
export type { DaemonService } from "./runtime/services/types.js";
export { type RunningDaemon, startDaemon as startDaemonListener } from "./runtime/listen.js";

// ── PRD-021a composition root ───────────────────────────────────────────────
export {
	type AssembleDaemonOptions,
	type AssembledDaemon,
	acquireSingleInstanceLock,
	assembleDaemon,
	assembleSeams,
	DaemonAlreadyRunningError,
	LOCK_FILE_NAME,
	PID_FILE_NAME,
	releaseSingleInstanceLock,
} from "./runtime/assemble.js";

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

/** A fully-assembled, listening production daemon plus its graceful close. */
export interface RunningAssembledDaemon {
	/** The assembled daemon (Hono app + real services + lifecycle controls). */
	readonly assembled: AssembledDaemon;
	/** The resolved listen address. */
	readonly address: { host: string; port: number };
	/** Drain services + close the socket + remove the PID/lock file (a-AC-5). */
	close(): Promise<void>;
}

/**
 * The PRODUCTION entry (PRD-021a FR-10 / a-AC-5 / a-AC-6). Assembles the daemon via
 * {@link assembleDaemon} (live storage client, the four seams fired once, the three
 * real services, the live `/health` probe, the PID/lock guard), starts its lifecycle,
 * binds the socket via {@link startDaemonListener}, and installs SIGINT/SIGTERM handlers
 * that gracefully drain + close + remove the lock. This is the function the bundled
 * `daemon/index.js` invokes; importing this module never auto-listens (FR-10) — only an
 * explicit call (the CLI / the `if (isMainEntry)` guard below) starts the socket.
 *
 * A second start against an already-running daemon throws {@link DaemonAlreadyRunningError}
 * from the lock guard (a-AC-6) BEFORE binding, so port 3850 is never double-bound.
 */
export async function runAssembledDaemon(options: AssembleDaemonOptions = {}): Promise<RunningAssembledDaemon> {
	const assembled = assembleDaemon(options);
	// Acquire the lock + start services + the health probe BEFORE binding the socket so a
	// double-start fails fast and the daemon never accepts requests before it is warm.
	await assembled.start();

	let running: Awaited<ReturnType<typeof startDaemonListener>>;
	try {
		running = await startDaemonListener(assembled.daemon);
	} catch (err) {
		// A bind failure (EADDRINUSE) after a clean lock acquire: roll the lifecycle back so
		// the lock is released and services are drained, then re-throw the real cause.
		await assembled.shutdown();
		throw err;
	}

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await running.close(); // closes the socket + calls daemon.stopServices()
		await assembled.shutdown(); // stops the health probe + removes the PID/lock file
	};

	// a-AC-5: SIGINT/SIGTERM → graceful shutdown (drain + close + no stale lock). Handlers
	// are registered once; a second signal is ignored (close is idempotent).
	const onSignal = (signal: NodeJS.Signals): void => {
		void close().then(() => {
			// Re-raise nothing: the process exits naturally once the loop drains. We
			// surface the signal name on the structured logger via stderr only.
			process.stderr.write(`[honeycomb] daemon stopped on ${signal}\n`);
		});
	};
	process.once("SIGINT", () => onSignal("SIGINT"));
	process.once("SIGTERM", () => onSignal("SIGTERM"));

	return { assembled, address: running.address, close };
}

/**
 * Whether this module is being executed directly as the daemon entry (the bundled
 * `daemon/index.js`), as opposed to imported by a test or another module. Only the
 * direct-execution path auto-listens (FR-10); importing the module never binds a socket.
 */
export function isDaemonMainEntry(importMetaUrl: string, argv1: string | undefined): boolean {
	const entry = argv1;
	if (typeof entry !== "string" || entry.length === 0) return false;
	try {
		if (importMetaUrl === pathToFileURL(entry).href) return true;
		return importMetaUrl === pathToFileURL(realpathSync(entry)).href;
	} catch {
		return false;
	}
}

function isMainEntry(): boolean {
	return isDaemonMainEntry(import.meta.url, process.argv[1]);
}

/**
 * Install the top-level process safety net (fail-soft).
 *
 * WHY THIS EXISTS — the daemon is a long-lived HTTP server; its event loop stays alive on the
 * listening socket, so a mere logged capture-flush failure must NEVER end the process. But a stray
 * promise rejection that escapes with no `.catch` (historically: the time-triggered capture flush,
 * fixed in `capture-buffer.ts`) is, under Node ≥15, FATAL by default — Node prints the rejection and
 * calls `process.exit(1)`. That is exactly how a DeepLake `capture.batch_insert.failed` was observed
 * to kill the daemon. This net is the backstop for any FUTURE such escape on any code path:
 *
 *   - `unhandledRejection` → LOG to stderr and KEEP RUNNING. A background async failure (a capture
 *     write, an embed, a queue tick) must degrade to a logged error, not a process death. The daemon
 *     keeps serving; the specific escape is fixed at its source (the primary fix), this only ensures
 *     no NEW escape is silently fatal.
 *   - `uncaughtException` → this is a genuinely unexpected synchronous throw with no handler. We LOG
 *     and, for a truly unknowable state, exit NON-ZERO so the OS supervisor (the Windows scheduled
 *     task's `RestartOnFailure`, systemd `Restart=on-failure`, launchd `KeepAlive`) restarts us. A
 *     non-zero code is deliberate: it is the ONLY signal that makes the supervisor re-up the daemon.
 *
 * The asymmetry is intentional: a stray REJECTION (almost always a fail-soft background op) keeps the
 * daemon alive; a stray synchronous THROW (a corrupt-state signal) restarts it clean. Neither exits 0.
 *
 * Exported so a test can assert the contract (rejection → alive, uncaught throw → non-zero exit)
 * without executing the module as the main entry.
 */
export function installProcessSafetyNet(): void {
	process.on("unhandledRejection", (reason: unknown) => {
		const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
		// Fail-soft: a background async failure must not end a long-lived HTTP daemon. Log + keep serving.
		process.stderr.write(`[honeycomb] unhandledRejection (kept alive): ${message}\n`);
	});
	process.on("uncaughtException", (err: unknown) => {
		const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
		// A synchronous throw with no handler = unknowable state. Log, then exit NON-ZERO so the OS
		// supervisor restarts us clean (a zero exit would leave the scheduled task Ready + never restart).
		process.stderr.write(`[honeycomb] uncaughtException (restarting): ${message}\n`);
		process.exitCode = 1;
		// Give the write + any in-flight graceful close a tick, then force the non-zero exit so the
		// supervisor's restart-on-failure fires. `process.exitCode` alone would let a wedged handle hang.
		setTimeout(() => process.exit(1), 100).unref();
	});
}

// Production auto-listen: ONLY when run as the main entry (the bundled daemon binary),
// never on import (a test imports `assembleDaemon`/`runAssembledDaemon` without binding).
if (isMainEntry()) {
	installProcessSafetyNet();
	runAssembledDaemon().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[honeycomb] daemon failed to start: ${message}\n`);
		process.exitCode = 1;
	});
}
