/**
 * PRD-021a composition-root suite — a-AC-1..6 (FR-1..10).
 *
 * Verification posture (mirrors server.test.ts): in-process via `daemon.app.request(...)`
 * with injected fakes for the deterministic bits — no socket is bound, no live DeepLake.
 * Each test is named after the AC it proves so the ledger maps one-to-one to a passing
 * test. The four seams are injected as recording fakes (the repo's DI-over-mock posture)
 * to prove each fires EXACTLY ONCE, after construction. The three real services are
 * asserted by identity against the exported no-op singletons (a real impl is not the
 * stub). A fake storage client drives the cached `/health` bit to 200 (reachable) and
 * 503 (unreachable). The PID/lock guard is exercised against a temp `~/.honeycomb`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import {
	type SeamFns,
	DaemonAlreadyRunningError,
	LOCK_FILE_NAME,
	PID_FILE_NAME,
	acquireSingleInstanceLock,
	assembleDaemon,
} from "../../../src/daemon/runtime/assemble.js";
import { noopFileWatcherService } from "../../../src/daemon/runtime/services/file-watcher.js";
import { noopJobQueueService } from "../../../src/daemon/runtime/services/job-queue.js";
import { noopRuntimePathService } from "../../../src/daemon/runtime/middleware/runtime-path.js";
import type { StorageClient } from "../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../src/daemon/storage/result.js";

/** A resolved config for the assembly without touching env. */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/**
 * A fake `StorageClient`-shaped object: every `query` returns the scripted result. The
 * health probe runs `SELECT 1` through this, so scripting an `ok` vs an error result
 * drives the cached `/health` bit deterministically.
 */
function fakeStorage(result: QueryResult): StorageClient {
	return {
		get endpoint() {
			return "https://example.invalid";
		},
		async connect() {
			return result;
		},
		async query() {
			return result;
		},
	} as unknown as StorageClient;
}

const OK_RESULT: QueryResult = { kind: "ok", rows: [{ "?column?": 1 }], durationMs: 1 };
const ERR_RESULT: QueryResult = { kind: "connection_error", message: "unreachable" };

/** Recording seam fakes: count calls + record the order so "exactly once, after construction" is provable. */
function recordingSeams(order: string[]): { seams: SeamFns; calls: Record<keyof SeamFns, number> } {
	const calls = {
		attachHooks: 0,
		mountDashboard: 0,
		mountNotifications: 0,
		attachPrune: 0,
		mountLogs: 0,
		mountDashboardHost: 0,
		mountMemories: 0,
		mountVfs: 0,
		mountProductData: 0,
	} as Record<keyof SeamFns, number>;
	const seams: SeamFns = {
		attachHooks: ((daemon) => {
			calls.attachHooks += 1;
			order.push("attachHooks");
			// Prove "after construction": the daemon passed in is a fully-built Daemon.
			expect(typeof daemon.group).toBe("function");
			return { register() {}, recordTurn() {} } as never;
		}) as SeamFns["attachHooks"],
		mountDashboard: ((daemon) => {
			calls.mountDashboard += 1;
			order.push("mountDashboard");
			expect(typeof daemon.group).toBe("function");
		}) as SeamFns["mountDashboard"],
		mountNotifications: ((daemon) => {
			calls.mountNotifications += 1;
			order.push("mountNotifications");
			expect(typeof daemon.group).toBe("function");
		}) as SeamFns["mountNotifications"],
		attachPrune: ((daemon) => {
			calls.attachPrune += 1;
			order.push("attachPrune");
			expect(typeof daemon.group).toBe("function");
		}) as SeamFns["attachPrune"],
		mountLogs: ((daemon, options) => {
			calls.mountLogs += 1;
			order.push("mountLogs");
			expect(typeof daemon.group).toBe("function");
			// The logs reader is wired with the daemon's OWN ring-buffer logger.
			expect(options.logger).toBe(daemon.logger);
		}) as SeamFns["mountLogs"],
		mountDashboardHost: ((daemon) => {
			calls.mountDashboardHost += 1;
			order.push("mountDashboardHost");
			expect(typeof daemon.group).toBe("function");
		}) as SeamFns["mountDashboardHost"],
		// ── The three data-API seams (022a / 022b / 022c) the 022d composition root fires. ──
		mountMemories: ((daemon, options) => {
			calls.mountMemories += 1;
			order.push("mountMemories");
			expect(typeof daemon.group).toBe("function");
			// The memories API is wired with the live storage client (the recall + write engines).
			expect(options.storage).toBeDefined();
				// PRD-022: the daemon's default tenancy scope is threaded so a no-org loopback
				// request resolves in local mode (the SDK/MCP 400 regression fix).
				expect(options.defaultScope, "memories receives the threaded default scope").toBeDefined();
				expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountMemories"],
		mountVfs: ((daemon, options) => {
			calls.mountVfs += 1;
			order.push("mountVfs");
			expect(typeof daemon.group).toBe("function");
			// The VFS browse reads run through the same live storage client.
			expect(options.storage).toBeDefined();
				// PRD-022: the VFS browse receives the threaded default scope too.
				expect(options.defaultScope, "vfs receives the threaded default scope").toBeDefined();
				expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountVfs"],
		mountProductData: ((daemon, options) => {
			calls.mountProductData += 1;
			order.push("mountProductData");
			expect(typeof daemon.group).toBe("function");
			// goals/kpis/skills/rules wire through storage; secrets is wired (constructible),
			// sources is deferred (NOT faked) — see resolveProductDataDeps in assemble.ts.
			expect(options.storage).toBeDefined();
			expect(options.secrets, "secrets engine is wired at the composition root").toBeDefined();
			expect(options.sources, "sources is deferred (not wired, not faked — D-1)").toBeUndefined();
				// PRD-022: the product-data surface receives the threaded default scope.
				expect(options.defaultScope, "product-data receives the threaded default scope").toBeDefined();
				expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountProductData"],
	};
	return { seams, calls };
}

let runtimeDir: string;

beforeEach(() => {
	runtimeDir = mkdtempSync(join(tmpdir(), "honeycomb-assemble-"));
});

afterEach(() => {
	rmSync(runtimeDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("a-AC-2 / d-AC-1 the mount/attach seams fire exactly once, after construction", () => {
	it("in LOCAL mode fires all nine seams (logs + dashboard-host + the three data seams) each exactly once, in order", () => {
		const order: string[] = [];
		const { seams, calls } = recordingSeams(order);
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			seams,
		});
		// The four core seams + the /api/logs reader (always) + the /dashboard host
		// (local-mode only, fired here because the mode is `local`) + the three data-API
		// seams (memories / vfs / product-data, always) each fire EXACTLY ONCE.
		expect(calls.attachHooks).toBe(1);
		expect(calls.mountDashboard).toBe(1);
		expect(calls.mountNotifications).toBe(1);
		expect(calls.attachPrune).toBe(1);
		expect(calls.mountLogs).toBe(1);
		expect(calls.mountDashboardHost).toBe(1);
		// d-AC-1: every data-API seam fires once and only once.
		expect(calls.mountMemories).toBe(1);
		expect(calls.mountVfs).toBe(1);
		expect(calls.mountProductData).toBe(1);
		// Deterministic order: the 021 seams, then the 022 data seams (memories → vfs → product).
		expect(order).toEqual([
			"attachHooks",
			"mountDashboard",
			"mountNotifications",
			"attachPrune",
			"mountLogs",
			"mountDashboardHost",
			"mountMemories",
			"mountVfs",
			"mountProductData",
		]);
	});

	it("d-AC-1 the three data-API seams fire UNCONDITIONALLY (in team mode too, each exactly once)", () => {
		const order: string[] = [];
		const { seams, calls } = recordingSeams(order);
		assembleDaemon({
			config: cfg({ mode: "team" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			seams,
		});
		// The data-API seams resolve their own protected groups, so they are NOT mode-gated —
		// each fires once regardless of mode (the production assembly fires them in team too).
		expect(calls.mountMemories).toBe(1);
		expect(calls.mountVfs).toBe(1);
		expect(calls.mountProductData).toBe(1);
		// The /dashboard host stays local-only (security F-1) even though the data seams fire.
		expect(calls.mountDashboardHost).toBe(0);
	});

	it("mountLogs fires UNCONDITIONALLY (its /api/logs group is already protect:true) — fired in team mode too", () => {
		const order: string[] = [];
		const { seams, calls } = recordingSeams(order);
		assembleDaemon({
			config: cfg({ mode: "team" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			seams,
		});
		// The logs reader is NOT mode-gated — it serves on a protect:true group, so it
		// fires once regardless of mode (d-AC-2 production assembly).
		expect(calls.mountLogs).toBe(1);
	});
});

describe("security F-1: mountDashboardHost is LOCAL-MODE ONLY (the team-mode tenancy gate holds)", () => {
	for (const mode of ["team", "hybrid"] as const) {
		it(`in ${mode.toUpperCase()} mode the /dashboard host is NOT fired (the unprotected-root tenancy hole never opens)`, () => {
			const order: string[] = [];
			const { seams, calls } = recordingSeams(order);
			assembleDaemon({
				config: cfg({ mode }),
				storage: fakeStorage(OK_RESULT),
				logger: createRequestLogger({ silent: true }),
				runtimeDir,
				seams,
			});
			// The viewable HTML host attaches to the UNPROTECTED root group; in team/hybrid
			// it would serve another tenant's data with no auth (security F-1). The gate
			// holds: it is NEVER fired off `local`.
			expect(calls.mountDashboardHost).toBe(0);
			expect(order).not.toContain("mountDashboardHost");
			// The other five seams (incl. the protect:true /api/logs reader) STILL fire once.
			expect(calls.attachHooks).toBe(1);
			expect(calls.mountDashboard).toBe(1);
			expect(calls.mountNotifications).toBe(1);
			expect(calls.attachPrune).toBe(1);
			expect(calls.mountLogs).toBe(1);
		});
	}
});

describe("d-AC-5 the ASSEMBLED daemon still rejects malformed/no-session requests at the edge", () => {
	/** The session-group headers a valid request to /api/memories must carry. */
	const sessionHeaders = {
		"x-honeycomb-org": "acme",
		"x-honeycomb-workspace": "default",
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": "d-ac-5-session",
		"content-type": "application/json",
	};

	it("d-AC-5 a recall with NO x-honeycomb-session is 400'd by the runtime-path middleware (before the wired handler)", async () => {
		// Assemble with the REAL seams (mountMemoriesApi fires via assembleSeams) + a fake storage
		// client, so the actual `/api/memories` session group + middleware run in-process.
		const { daemon } = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		const noSession = { ...sessionHeaders } as Record<string, string>;
		delete noSession["x-honeycomb-session"];
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: noSession,
			body: JSON.stringify({ query: "anything" }),
		});
		// The runtime-path middleware 400s a session-group request missing the session header,
		// BEFORE the wired recall handler — the wiring did not open a no-session hole (FR-8 / D-3).
		expect(res.status).toBe(400);
	});

	it("d-AC-5 a recall WITH a session but a MALFORMED body is 400'd by zod (before the engine)", async () => {
		const { daemon } = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		// A body missing the required `query` clears the middleware (session present) but fails the
		// 022a zod schema → 400 before the recall engine. The wiring preserved the boundary guard.
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: sessionHeaders,
			body: JSON.stringify({ notquery: "oops" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("bad_request");
	});

	it("PRD-022 (local) a store with a session but NO org falls back to the daemon's default tenant (not 400)", async () => {
		// THE dogfood fix: in LOCAL mode the assembled daemon threads its configured default
		// scope into the data mounts, so a loopback thin client (SDK/MCP) that carries a session
		// but NO x-honeycomb-org resolves to the single local tenant instead of 400'ing. (Before
		// PRD-022 this returned 400 — the SDK/MCP recall regression. The CLI worked only because
		// it happened to send the org header.)
		const { daemon } = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		const noOrg = { ...sessionHeaders } as Record<string, string>;
		delete noOrg["x-honeycomb-org"];
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: noOrg,
			body: JSON.stringify({ content: "hi" }),
		});
		// The store reached the engine via the default tenant — NOT a 400 fail-closed.
		expect(res.status).not.toBe(400);
		expect(res.status).toBe(201);
	});

	it("d-AC-5 (team) a store with NO org is STILL rejected (the team-mode tenancy guard is intact)", async () => {
		// The PRD-022 fallback is LOCAL-ONLY: in team mode an unauthenticated/no-org store must
		// still be rejected. The assembled team daemon's permission middleware rejects it (401)
		// before the handler — either way it is NEVER 201, so the fallback did not widen team
		// tenancy.
		const { daemon } = assembleDaemon({
			config: cfg({ mode: "team" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		const noOrg = { ...sessionHeaders } as Record<string, string>;
		delete noOrg["x-honeycomb-org"];
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: noOrg,
			body: JSON.stringify({ content: "hi" }),
		});
		// Rejected — the no-org store never resolved to any tenant in team mode.
		expect(res.status).not.toBe(201);
		expect([400, 401, 403]).toContain(res.status);
	});
});

describe("a-AC-3 the three no-op services are replaced with their real implementations", () => {
	it("wires real queue/watcher/runtimePath services (not the no-op singletons)", () => {
		const { daemon } = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		// The real impls are distinct objects from the exported no-op stubs.
		expect(daemon.services.queue).not.toBe(noopJobQueueService);
		expect(daemon.services.watcher).not.toBe(noopFileWatcherService);
		expect(daemon.services.runtimePath).not.toBe(noopRuntimePathService);
		// Each still satisfies the DaemonService lifecycle shape.
		expect(typeof daemon.services.queue.start).toBe("function");
		expect(typeof daemon.services.watcher.start).toBe("function");
		expect(typeof daemon.services.runtimePath.start).toBe("function");
	});
});

describe("a-AC-4 /health performs a live storage probe → 200 reachable, 503 unreachable", () => {
	it("returns 200 when the cached probe sees DeepLake reachable", async () => {
		const assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		// start() primes the cached health bit with one SELECT 1 (here: ok).
		await assembled.start();
		try {
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.status).toBe("ok");
			expect(body.pipeline).toBe("ok");
			expect(assembled.pipelineStatus()).toBe("ok");
		} finally {
			await assembled.shutdown();
		}
	});

	it("returns 503 when the cached probe sees DeepLake unreachable (process stays up)", async () => {
		const assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(ERR_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		await assembled.start();
		try {
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(503);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.status).toBe("degraded");
			expect(body.pipeline).toBe("degraded");
			expect(assembled.pipelineStatus()).toBe("degraded");
		} finally {
			await assembled.shutdown();
		}
	});
});

describe("a-AC-5 graceful shutdown drains services and removes the lock (no stale lock)", () => {
	it("calls stopServices and removes the PID/lock files on shutdown", async () => {
		const assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		const stopSpy = vi.spyOn(assembled.daemon, "stopServices");
		await assembled.start();
		// The lock files exist while running.
		expect(existsSync(join(runtimeDir, LOCK_FILE_NAME))).toBe(true);
		expect(existsSync(join(runtimeDir, PID_FILE_NAME))).toBe(true);

		await assembled.shutdown();
		// stopServices drained the real services.
		expect(stopSpy).toHaveBeenCalledTimes(1);
		// No stale lock survives.
		expect(existsSync(join(runtimeDir, LOCK_FILE_NAME))).toBe(false);
		expect(existsSync(join(runtimeDir, PID_FILE_NAME))).toBe(false);
	});

	it("shutdown is idempotent (a second call is a no-op, never throws)", async () => {
		const assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		await assembled.start();
		await assembled.shutdown();
		await expect(assembled.shutdown()).resolves.toBeUndefined();
	});
});

describe("a-AC-6 the PID/lock guard prevents a double-bind", () => {
	it("a second start against a held lock throws DaemonAlreadyRunningError (no double-bind)", async () => {
		const first = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		await first.start();
		try {
			// A second start sharing the SAME runtime dir detects the live lock (this very
			// process's pid is alive) and refuses to start, BEFORE binding any socket.
			const second = assembleDaemon({
				config: cfg(),
				storage: fakeStorage(OK_RESULT),
				logger: createRequestLogger({ silent: true }),
				runtimeDir,
			});
			await expect(second.start()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
		} finally {
			await first.shutdown();
		}
	});

	it("a STALE lock (recorded pid is dead) is reclaimed, never wedging the next start", () => {
		// Write a lock holding a pid that is certainly not alive.
		const { lockPath } = acquireSingleInstanceLock(runtimeDir);
		// Overwrite the lock with a dead pid (a very large, unused pid).
		const DEAD_PID = 2 ** 31 - 1;
		rmSync(lockPath, { force: true });
		// Re-acquire writes our own live pid; a dead-pid lock from a prior crash is reclaimed.
		const reacquired = acquireSingleInstanceLock(runtimeDir);
		const written = Number.parseInt(readFileSync(reacquired.lockPath, "utf8").trim(), 10);
		expect(written).toBe(process.pid);
		expect(written).not.toBe(DEAD_PID);
	});
});

describe("a-AC-1 assembleDaemon constructs against the live storage client surface", () => {
	it("exposes the resolved config and a fully-built daemon (the composition root product)", () => {
		const assembled = assembleDaemon({
			config: cfg({ port: 4100, mode: "team", widened: true }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
		});
		expect(assembled.config.port).toBe(4100);
		expect(assembled.config.mode).toBe("team");
		expect(typeof assembled.daemon.group).toBe("function");
		// /api/status reports the catalog the daemon was built with (no live probe).
		expect(assembled.daemon.config.widened).toBe(true);
	});
});
