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

import type { Hono } from "hono";

import { type RuntimeConfig } from "../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../src/daemon/runtime/logger.js";
import {
	type AssembledDaemon,
	assembleDaemon,
} from "../../src/daemon/runtime/assemble.js";
import { startDaemon as startDaemonListener } from "../../src/daemon/runtime/listen.js";
import { createStorageClient } from "../../src/daemon/storage/index.js";
import type { QueryOptions, QueryScope, StorageClient } from "../../src/daemon/storage/client.js";
import { ok, type QueryResult } from "../../src/daemon/storage/result.js";

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
	/**
	 * The filesystem path to the `inference:` config (`agent.yaml`) the assembled daemon
	 * builds its real {@link ModelClient} from (PRD-026 AC-T). Forwarded verbatim to
	 * {@link assembleDaemon}. PRD-045d (d-AC-2) passes the committed `agent.yaml` so an
	 * ENABLED dreaming pass reaches the real `memory_dreaming` model. Absent → the daemon's
	 * default (`agent.yaml` under the workspace root); unparseable → the no-op model client.
	 */
	readonly agentConfigPath?: string;
	/**
	 * The dreaming `memory.dreaming` config provider seam (PRD-026 AC-W gate). Forwarded
	 * verbatim to {@link assembleDaemon}. PRD-045d (d-AC-2) injects a fixed `{ enabled: true }`
	 * provider so the assembled gate STARTS the real dreaming worker WITHOUT mutating
	 * `process.env` (the worker is built + started by the composition root, not the test).
	 * Absent → the env provider (OFF unless `HONEYCOMB_DREAMING_ENABLED`).
	 */
	readonly dreamingConfigProvider?: Parameters<typeof assembleDaemon>[0]["dreamingConfigProvider"];
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
		// PRD-045d (d-AC-2): forward the dreaming gate + inference config so an ENABLED dreaming
		// pass can run end-to-end on the assembled daemon. Both are additive + backward-compatible
		// (absent → the daemon's env-resolved defaults, unchanged for every other itest).
		...(options.agentConfigPath !== undefined ? { agentConfigPath: options.agentConfigPath } : {}),
		...(options.dreamingConfigProvider !== undefined ? { dreamingConfigProvider: options.dreamingConfigProvider } : {}),
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

// ════════════════════════════════════════════════════════════════════════════
// PLAIN-CI FAKE-STORAGE VARIANT — PRD-031 Wave A (D-1 / D-2 / D-5).
//
// The live `bootTestDaemon` above is UNCHANGED (Wave B reuses it verbatim). This
// is the ADDITIVE sibling: it assembles the SAME daemon through the SAME
// `assembleDaemon` → `assembleSeams` path (every seam in real order, behind the
// REAL middleware chain), but backs it with an INJECTED scriptable fake
// `StorageQuery` and returns the assembled Hono `app` so a test drives it via
// `app.request(...)`. No token, no network, no port-bind, no PID/lock — so the
// route-collision (AC-1) and header-gap (AC-2) bug CLASSES run in PLAIN CI on
// every PR. The load-bearing point is that this is the FULLY-ASSEMBLED app, not a
// hand-mounted single handler: the collision/header classes only surface when the
// real seams fire in real order behind the real middleware (D-1).
//
// Why it does NOT call `assembled.start()`: `app.request(...)` exercises the Hono
// router + middleware + handlers in-process WITHOUT a socket, exactly as
// `server.ts` documents ("the app is exercised in-process via `app.request(...)`
// — no socket is bound in tests"). The services (queue/watcher/embed) are
// CONSTRUCTED (cheap, hermetic) but never STARTED, so there is no timer, no child
// process, and no `~/.honeycomb` lock to clean up. The fake storage answers every
// statement synchronously, so no async warmup is needed either.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A SQL-aware responder for the fake storage: given the statement + the resolved
 * scope, return the {@link QueryResult} the storage call should produce. A test
 * scripts this to make a recall arm surface deterministic rows (`ok([...])`) or a
 * sibling arm degrade (a `query_error`). The default (when no responder is passed)
 * is `ok([])` for EVERY statement — every read is empty, every health probe is ok —
 * which is the hermetic floor a router/header test needs.
 */
export type FakeStorageResponder = (sql: string, scope: QueryScope) => QueryResult;

/** A statement recorded by the fake storage, for post-hoc assertions. */
export interface FakeStorageRequest {
	readonly sql: string;
	readonly scope: QueryScope;
}

/**
 * A scriptable fake {@link StorageQuery} (also structurally a {@link StorageClient}
 * for the parts `assembleDaemon` touches: `query`, `connect`, `endpoint`). It NEVER
 * opens a socket and NEVER reads a credential — every call is answered by the
 * injected {@link FakeStorageResponder} (default: `ok([])`). Each statement is
 * recorded on `requests` so a test can assert the partition scope that reached the
 * "wire" without a live backend.
 */
export interface FakeStorage extends StorageClient {
	/** Every statement issued through this fake, in order. */
	readonly requests: FakeStorageRequest[];
}

/** Build a scriptable fake storage client (no token, no network). */
export function createFakeStorage(responder?: FakeStorageResponder): FakeStorage {
	const requests: FakeStorageRequest[] = [];
	const answer: FakeStorageResponder = responder ?? ((): QueryResult => ok([], 1));
	const fake = {
		get endpoint(): string {
			return "https://fake.honeycomb.invalid";
		},
		requests,
		async query(sql: string, scope: QueryScope, _opts: QueryOptions = {}): Promise<QueryResult> {
			void _opts;
			requests.push({ sql, scope });
			return answer(sql, scope);
		},
		async connect(scope: QueryScope): Promise<QueryResult> {
			return this.query("SELECT 1", scope);
		},
	};
	return fake as unknown as FakeStorage;
}

/** Options for {@link assembleTestDaemonApp}. */
export interface AssembleTestDaemonAppOptions {
	/**
	 * The deployment mode. Defaults to `local` (the loopback single-user dogfood
	 * target): the permission middleware is open, so a data route reaches its handler
	 * without a real authenticator — exactly the surface AC-1/AC-2 exercise.
	 */
	readonly mode?: RuntimeConfig["mode"];
	/**
	 * The fake storage responder. Defaults to `ok([])` for every statement. Pass one to
	 * make a recall arm surface deterministic rows (so the handler-reached case is
	 * unambiguous) or a sibling arm degrade.
	 */
	readonly responder?: FakeStorageResponder;
	/** Inject a pre-built fake storage (overrides `responder`). Defaults to a fresh one. */
	readonly storage?: FakeStorage;
}

/** The fully-assembled fake-storage daemon: the Hono app + the fake + lifecycle controls. */
export interface AssembledTestDaemonApp {
	/** The fully-assembled Hono app. Drive it via `app.request(...)` — no socket is bound. */
	readonly app: Hono;
	/** The assembled daemon (the app + wired services + lifecycle controls). Never started here. */
	readonly assembled: AssembledDaemon;
	/** The injected fake storage (assert on `storage.requests` after a request). */
	readonly storage: FakeStorage;
}

/**
 * Assemble the REAL daemon (via {@link assembleDaemon} → `assembleSeams`, every seam
 * in real order behind the real middleware) backed by a FAKE {@link StorageQuery},
 * and return its Hono `app` for `app.request(...)` drive — NO token, NO network, NO
 * port-bind (PRD-031 Wave A / D-1 / D-2). This is the additive sibling of
 * {@link bootTestDaemon}: same assembly, but hermetic + in-process so the
 * route-collision (AC-1) and header-gap (AC-2) bug classes run in PLAIN CI.
 *
 * The composition root resolves the daemon's own tenancy to the `{ org: "local",
 * workspace: "default" }` fallback here (no provider injected with a fake storage —
 * `assembleDaemon` leaves the scope at the deterministic default), so in `local`
 * mode a data request with no `x-honeycomb-org` resolves to that single tenant. The
 * caller does NOT call `start()` — `app.request(...)` needs no socket, no lock, and
 * no started services. There is nothing to tear down.
 */
export function assembleTestDaemonApp(options: AssembleTestDaemonAppOptions = {}): AssembledTestDaemonApp {
	const storage = options.storage ?? createFakeStorage(options.responder);
	const config: RuntimeConfig = {
		host: "127.0.0.1",
		port: 0, // ephemeral / unused — no socket is bound.
		mode: options.mode ?? "local",
		widened: false,
	};
	const assembled = assembleDaemon({
		config,
		// Inject the FAKE storage: no provider is resolved, so the daemon scope falls
		// through to the deterministic `{ org: "local", workspace: "default" }` default.
		storage: storage as unknown as StorageClient,
		logger: createRequestLogger({ silent: true }),
	});
	return { app: assembled.daemon.app, assembled, storage };
}
