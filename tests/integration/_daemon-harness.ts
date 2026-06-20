/**
 * Reusable "boot a REAL assembled daemon" test harness — PRD-021a (Wave 1).
 *
 * This is the helper Wave 3 (021f's golden-path live itest) reuses to boot a real,
 * fully-assembled daemon against live DeepLake on an EPHEMERAL port and drive the real
 * code path. It wraps {@link assembleDaemon} + {@link startDaemonListener} so a live
 * itest gets a listening daemon + its base URL + a clean teardown in one call.
 *
 * ── Why this lives in its own file (not inline in one itest) ─────────────────
 * 021f reuses it verbatim. Keeping the boot logic here means the golden-path itest
 * imports `bootTestDaemon()` rather than copy-pasting the assemble+listen+shutdown
 * dance (the jscpd-duplication trap). The signature is the Wave-3 contract.
 *
 * ── Ephemeral port (NEVER 3850) ──────────────────────────────────────────────
 * The harness binds on port 0 by default so the OS picks a free port. This is the
 * load-bearing isolation rule: a live itest must NOT bind 3850 and clobber a real
 * daemon a developer is running. The actual bound port is read back from the listener
 * and returned in `baseUrl`.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The DeepLake token reaches the daemon ONLY through the storage layer's
 * `envCredentialProvider` (read from `HONEYCOMB_DEEPLAKE_*`). The harness never
 * hardcodes, logs, or echoes it. The caller passes no credentials — the live storage
 * client resolves them from env, fail-closed.
 *
 * ── Runtime dir isolation ────────────────────────────────────────────────────
 * The PID/lock guard writes to a per-boot temp dir (not the real `~/.honeycomb`), so a
 * test daemon never fights a real daemon's lock and the lock is cleaned in `stop()`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type RuntimeConfig } from "../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../src/daemon/runtime/logger.js";
import {
	type AssembledDaemon,
	assembleDaemon,
} from "../../src/daemon/runtime/assemble.js";
import { startDaemon as startDaemonListener } from "../../src/daemon/runtime/listen.js";
import { createStorageClient } from "../../src/daemon/storage/index.js";
import type { StorageClient } from "../../src/daemon/storage/client.js";

/** Options for {@link bootTestDaemon}. All optional with live-safe defaults. */
export interface BootTestDaemonOptions {
	/**
	 * The deployment mode. Defaults to `local` (loopback single-user — the first-class
	 * dogfood target, D-3): the permission middleware is open so the golden path runs
	 * without a real authenticator.
	 */
	readonly mode?: RuntimeConfig["mode"];
	/**
	 * The listen port. Defaults to 0 (EPHEMERAL — the OS picks a free port). NEVER pass
	 * 3850 from a test: that would clobber a real daemon.
	 */
	readonly port?: number;
	/**
	 * Inject a pre-built storage client. Defaults to the LIVE client
	 * ({@link createStorageClient}, creds from env via the storage layer). 021f passes
	 * the live client (the default) so the golden path hits real DeepLake.
	 */
	readonly storage?: StorageClient;
	/** Override the workspace dir the file watcher watches. Defaults to a temp dir. */
	readonly workspaceDir?: string;
}

/** A booted, listening test daemon plus its base URL and a clean teardown. */
export interface BootedTestDaemon {
	/** The assembled daemon (the Hono app + real services + lifecycle controls). */
	readonly assembled: AssembledDaemon;
	/** The base URL to issue HTTP requests against (e.g. `http://127.0.0.1:54321`). */
	readonly baseUrl: string;
	/** The actual bound address (host + the OS-picked ephemeral port). */
	readonly address: { host: string; port: number };
	/** Drain services + close the socket + remove the PID/lock + clean the temp dir. */
	stop(): Promise<void>;
}

/**
 * Boot a REAL assembled daemon for a live itest (the Wave-3 reusable harness).
 *
 * Assembles via {@link assembleDaemon} (live storage client, the four seams fired once,
 * the three real services, the live `/health` probe, the PID/lock guard in a temp dir),
 * starts its lifecycle, and binds the socket on an EPHEMERAL port via
 * {@link startDaemonListener}. Returns the listening daemon, its `baseUrl`, and a
 * `stop()` that drains + closes + removes the lock + cleans the temp dir.
 *
 * The caller drives the real HTTP surface against `baseUrl` (e.g. `GET /health`,
 * `GET /api/status`) and MUST call `stop()` in teardown.
 */
export async function bootTestDaemon(options: BootTestDaemonOptions = {}): Promise<BootedTestDaemon> {
	const runtimeDir = mkdtempSync(join(tmpdir(), "honeycomb-itest-daemon-"));
	const config: RuntimeConfig = {
		host: "127.0.0.1",
		port: options.port ?? 0, // ephemeral — never 3850.
		mode: options.mode ?? "local",
		widened: false,
	};

	const assembled = assembleDaemon({
		config,
		// Default to the LIVE storage client (creds from env via the storage layer).
		storage: options.storage ?? createStorageClient(),
		logger: createRequestLogger({ silent: true }),
		runtimeDir,
		...(options.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
	});

	// start() acquires the lock, primes the cached /health bit (one live SELECT 1), and
	// starts the real services. Then bind the socket on the ephemeral port.
	await assembled.start();
	const running = await startDaemonListener(assembled.daemon);

	const { host, port } = running.address;
	const baseUrl = `http://${host}:${port}`;

	let stopped = false;
	return {
		assembled,
		baseUrl,
		address: running.address,
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			await running.close(); // close socket + daemon.stopServices()
			await assembled.shutdown(); // stop health probe + remove PID/lock
			rmSync(runtimeDir, { recursive: true, force: true });
		},
	};
}
