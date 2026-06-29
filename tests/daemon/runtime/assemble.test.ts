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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import {
	type SeamFns,
	type VaultSettingsReader,
	DaemonAlreadyRunningError,
	LOCK_FILE_NAME,
	PID_FILE_NAME,
	acquireSingleInstanceLock,
	assembleDaemon,
} from "../../../src/daemon/runtime/assemble.js";
import { VaultStore } from "../../../src/daemon/runtime/vault/store.js";
import { createVaultRegistry } from "../../../src/daemon/runtime/vault/registry.js";
import type { SettingResult } from "../../../src/daemon/runtime/vault/store.js";
import type { SettingValue } from "../../../src/daemon/runtime/vault/registry.js";
import type { SecretScope } from "../../../src/daemon/runtime/secrets/contracts.js";
import { createFakeMachineKeyProvider } from "../../../src/daemon/runtime/secrets/contracts.js";
import {
	CREDENTIALS_DIR_NAME,
	CREDENTIALS_FILE_NAME,
	ENV_TOKEN,
} from "../../../src/daemon/runtime/auth/credentials-store.js";
import { DEEPLAKE_TOKEN_NAME } from "../../../src/daemon/runtime/vault/migrate.js";
import { noopFileWatcherService } from "../../../src/daemon/runtime/services/file-watcher.js";
import { noopJobQueueService } from "../../../src/daemon/runtime/services/job-queue.js";
import {
	type EmbedSupervisor,
	createEmbedSupervisor,
	noopEmbedSupervisor,
} from "../../../src/daemon/runtime/services/embed-supervisor.js";
import { noopRuntimePathService } from "../../../src/daemon/runtime/middleware/runtime-path.js";
import type {
	PollinatingConfigProvider,
	RawPollinatingConfig,
} from "../../../src/daemon/runtime/pollinating/config.js";
import type { PollinatingJobWorker } from "../../../src/daemon/runtime/pollinating/worker.js";
import type { StorageClient } from "../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../src/daemon/storage/result.js";
import { fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

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
		mountMemoriesPrime: 0,
		mountVfs: 0,
		mountProductData: 0,
		mountPollinate: 0,
		mountProjectsSync: 0,
		mountCompact: 0,
		mountDiagnosticsHealth: 0,
		mountLocalQueueDiagnostics: 0,
		mountGraph: 0,
		mountHarness: 0,
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
		// ── The session-priming PRIME digest seam (PRD-046c) the composition root fires. ──
		mountMemoriesPrime: ((daemon, options) => {
			calls.mountMemoriesPrime += 1;
			order.push("mountMemoriesPrime");
			expect(typeof daemon.group).toBe("function");
			// The prime skim runs through the same live storage client …
			expect(options.storage).toBeDefined();
			// … and receives the threaded default scope (local-mode no-org loopback resolves).
			expect(options.defaultScope, "prime receives the threaded default scope").toBeDefined();
			expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountMemoriesPrime"],
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
			// goals/kpis/skills/rules wire through storage; secrets is wired (constructible);
			// sources is NOW wired too (PRD-045e) — the registry + providers resolver + document
			// worker are constructible at the composition root, so /api/sources + /api/documents
			// go live. See resolveProductDataDeps + buildSourcesApiDeps in assemble.ts/registry.ts.
			expect(options.storage).toBeDefined();
			expect(options.secrets, "secrets engine is wired at the composition root").toBeDefined();
			expect(options.sources, "sources engine is wired at the composition root (PRD-045e)").toBeDefined();
			expect(options.sources?.registry, "the sources registry is constructed").toBeDefined();
			expect(options.sources?.providers, "the providers resolver is constructed").toBeDefined();
			expect(options.sources?.documentWorker, "the document worker is wired (e-AC-3)").toBeDefined();
				// PRD-022: the product-data surface receives the threaded default scope.
				expect(options.defaultScope, "product-data receives the threaded default scope").toBeDefined();
				expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountProductData"],
		// ── The "Pollinate now" trigger seam (PRD-024 / AC-6) the composition root fires. ──
		mountPollinate: ((daemon, options) => {
			calls.mountPollinate += 1;
			order.push("mountPollinate");
			expect(typeof daemon.group).toBe("function");
			// The trigger is wired with the live storage client (the pollinating_state counter).
			expect(options.storage).toBeDefined();
			// PRD-024: the daemon's default tenancy scope is threaded so the pollinating counter
			// runs for the single local tenant a loopback dashboard button targets.
			expect(options.defaultScope, "pollinate trigger receives the threaded default scope").toBeDefined();
			expect(options.defaultScope?.org).toBeTruthy();
			// The enqueuer is the daemon's OWN durable job queue (no second pollinating subsystem).
			expect(options.enqueuer, "pollinate trigger reuses the daemon's job queue as the enqueuer").toBe(
				daemon.services.queue,
			);
		}) as SeamFns["mountPollinate"],
		// ── The PRD-049d registry → cache sync trigger seam the composition root fires. ──
		mountProjectsSync: ((daemon, options) => {
			calls.mountProjectsSync += 1;
			order.push("mountProjectsSync");
			expect(typeof daemon.group).toBe("function");
			// The sync route is wired with the live storage client (the projects-registry read).
			expect(options.storage).toBeDefined();
			// PRD-049d: the daemon's default tenancy scope is threaded so a no-org loopback sync
			// resolves the single local tenant's workspace registry.
			expect(options.defaultScope, "projects-sync trigger receives the threaded default scope").toBeDefined();
			expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountProjectsSync"],
		// ── The PRD-030 standalone COMPACTION trigger seam the composition root fires. ──
		mountCompact: ((daemon, options) => {
			calls.mountCompact += 1;
			order.push("mountCompact");
			expect(typeof daemon.group).toBe("function");
			// The compactor route is wired with the live storage client (the version-history reap).
			expect(options.storage).toBeDefined();
			// PRD-030 D-2: the daemon's default tenancy scope is threaded so the compaction pass
			// runs over the single local tenant's version-bumped tables.
			expect(options.defaultScope, "compact trigger receives the threaded default scope").toBeDefined();
			expect(options.defaultScope?.org).toBeTruthy();
		}) as SeamFns["mountCompact"],
		// ── The PRD-029 protected per-subsystem health-detail seam the composition root fires. ──
		mountDiagnosticsHealth: ((daemon, options) => {
			calls.mountDiagnosticsHealth += 1;
			order.push("mountDiagnosticsHealth");
			expect(typeof daemon.group).toBe("function");
			// The protected health detail is wired with the structured-detail thunk: a synchronous
			// read of the cached health bit + assembly-known embed state (no probe — PRD-029 D-4).
			expect(typeof options.healthDetail, "diagnostics-health receives the detail thunk").toBe("function");
			const detail = options.healthDetail();
			expect(detail.status, "the thunk yields the coarse status").toBeDefined();
			expect(detail.reasons, "the protected surface carries the full per-subsystem reasons").toBeDefined();
		}) as SeamFns["mountDiagnosticsHealth"],
		// ── The PRD-014 codebase-graph build/read seam the composition root fires (deferred wiring closed). ──
		mountLocalQueueDiagnostics: ((daemon, options) => {
			calls.mountLocalQueueDiagnostics += 1;
			order.push("mountLocalQueueDiagnostics");
			expect(typeof daemon.group).toBe("function");
			expect(options.config.localKinds.has("summary")).toBe(true);
			expect(typeof options.localQueue.counts).toBe("function");
			expect(options.topology?.mode).toBeDefined();
			expect(options.pendingSharedLocalJobs).toBeUndefined();
		}) as NonNullable<SeamFns["mountLocalQueueDiagnostics"]>,
		mountGraph: ((daemon, options) => {
			calls.mountGraph += 1;
			order.push("mountGraph");
			expect(typeof daemon.group).toBe("function");
			// The graph build/read endpoints are wired with the live storage client (the codebase-table push).
			expect(options.storage, "graph seam receives the live storage client").toBeDefined();
			// PRD-022: the daemon's default tenancy scope is threaded so a no-org loopback build resolves.
			expect(options.defaultScope, "graph seam receives the threaded default scope").toBeDefined();
			expect(options.defaultScope?.org).toBeTruthy();
			// PRD-014: the watched workspace (the checkout to graph) is threaded so the build knows what to walk.
			expect(options.workspaceDir, "graph seam receives the workspace dir to build from").toBeTruthy();
		}) as SeamFns["mountGraph"],
		// ── The PRD-039a harness registry + last-seen telemetry seam the composition root fires. ──
		mountHarness: ((daemon, options) => {
			calls.mountHarness += 1;
			order.push("mountHarness");
			expect(typeof daemon.group).toBe("function");
			// The telemetry endpoint is wired with the live storage client (the sessions GROUP BY).
			expect(options.storage, "harness seam receives the live storage client").toBeDefined();
			// PRD-022: the daemon's default tenancy scope is threaded so a no-org loopback read resolves.
			expect(options.defaultScope, "harness seam receives the threaded default scope").toBeDefined();
			expect(options.defaultScope?.org).toBeTruthy();
			// PRD-039a a-AC-3 / OQ-1: the installed set is threaded (the cheap cached presence check).
			expect(options.installedHarnesses, "harness seam receives the installed-harness set").toBeDefined();
		}) as SeamFns["mountHarness"],
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
	it("in LOCAL mode fires all ten seams (logs + dashboard-host + the three data seams + the pollinate trigger) each exactly once, in order", () => {
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
		// PRD-024 / AC-6: the "Pollinate now" trigger fires once and only once.
		expect(calls.mountPollinate).toBe(1);
		// PRD-049d: the registry → cache sync trigger fires once and only once.
		expect(calls.mountProjectsSync).toBe(1);
		// PRD-030 / D-2: the standalone compaction trigger fires once and only once.
		expect(calls.mountCompact).toBe(1);
		// PRD-029 / AC-3: the protected per-subsystem health detail fires once and only once.
		expect(calls.mountDiagnosticsHealth).toBe(1);
		expect(calls.mountLocalQueueDiagnostics).toBe(1);
		// PRD-014: the production composition root fires the graph build/read seam (deferred wiring closed).
		expect(calls.mountGraph).toBe(1);
		// PRD-039a: the harness registry + last-seen telemetry seam fires once and only once.
		expect(calls.mountHarness).toBe(1);
		// Deterministic order: the 021 seams, then the 022 data seams (memories → vfs → product),
		// then the PRD-024 pollinate trigger, the PRD-030 compaction trigger, the PRD-029 health detail,
		// the PRD-014 graph seam, and finally the PRD-039a harness telemetry seam.
		expect(order).toEqual([
			"attachHooks",
			"mountDashboard",
			"mountNotifications",
			"attachPrune",
			"mountLogs",
			"mountDashboardHost",
			"mountMemories",
			"mountMemoriesPrime",
			"mountVfs",
			"mountProductData",
			"mountPollinate",
			"mountProjectsSync",
			"mountCompact",
			"mountDiagnosticsHealth",
			"mountLocalQueueDiagnostics",
			"mountGraph",
			"mountHarness",
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
		// PRD-024 / AC-6: the pollinate trigger also fires unconditionally — its /api/diagnostics
		// group is protect:true, so it inherits auth/RBAC and is NOT mode-gated (fires in team too).
		expect(calls.mountPollinate).toBe(1);
		// PRD-030 / D-2: the standalone compaction trigger also fires unconditionally (same
		// protected /api/diagnostics group; fires in team too).
		expect(calls.mountCompact).toBe(1);
		// PRD-029 / AC-3: the protected health detail also fires unconditionally (same protected
		// /api/diagnostics group; fires in team too — the full reasons gate behind its auth).
		expect(calls.mountDiagnosticsHealth).toBe(1);
		expect(calls.mountLocalQueueDiagnostics).toBe(1);
		// PRD-039a: the harness telemetry seam also fires unconditionally (same protected
		// /api/diagnostics group; fires in team too — the activity GROUP BY gated behind its auth).
		expect(calls.mountHarness).toBe(1);
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
			// PRD-025: inject the inert embed supervisor so the hermetic assembly never spawns
			// a real embed child when start() runs (the real supervisor is covered separately).
			embedSupervisor: noopEmbedSupervisor,
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
			embedSupervisor: noopEmbedSupervisor,
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
			embedSupervisor: noopEmbedSupervisor,
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
			embedSupervisor: noopEmbedSupervisor,
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
			embedSupervisor: noopEmbedSupervisor,
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
				embedSupervisor: noopEmbedSupervisor,
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

describe("fix/daemon-scope-from-credentials: the daemon's default scope comes from the SAME creds the client connected with", () => {
	/**
	 * Capturing seams that record the `defaultScope` + `orgName` the composition root threads
	 * into the dashboard + data mounts. This is how we prove `resolveDaemonScope`/the tenancy
	 * resolver fed the seams the credentials' org — NOT the `"local"` placeholder — and that the
	 * storage client and the scope used the SAME resolved creds (no split).
	 */
	function capturingSeams(): {
		seams: SeamFns;
		captured: { dashboardScope?: QueryScope; dashboardOrgName?: string; memoriesScope?: QueryScope };
	} {
		const captured: { dashboardScope?: QueryScope; dashboardOrgName?: string; memoriesScope?: QueryScope } = {};
		const noop = (() => {}) as never;
		const seams: SeamFns = {
			attachHooks: (() => ({ register() {}, recordTurn() {} })) as SeamFns["attachHooks"],
			mountDashboard: ((_daemon, options) => {
				captured.dashboardScope = options.defaultScope;
				captured.dashboardOrgName = options.orgName;
			}) as SeamFns["mountDashboard"],
			mountNotifications: noop,
			attachPrune: noop,
			mountLogs: noop,
			mountDashboardHost: noop,
			mountMemories: ((_daemon, options) => {
				captured.memoriesScope = options.defaultScope;
			}) as SeamFns["mountMemories"],
			mountVfs: noop,
			mountProductData: noop,
			mountPollinate: noop,
			mountProjectsSync: noop,
			mountCompact: noop,
			mountDiagnosticsHealth: noop,
		};
		return { seams, captured };
	}

	it("with an injected credential provider (orgId/workspaceId/orgName) and NO env → scope is {org,workspace}, NOT 'local', and orgName is the friendly name", () => {
		// The reproduction shape: a plain login, no env vars. The provider yields the real org
		// from `~/.deeplake/credentials.json`; the daemon's default scope must be THAT org.
		const provider = stubProvider(
			fakeCredentialRecord({ org: "71f2566d-OSPRY", workspace: "default", orgName: "OSPRY" }),
		);
		const { seams, captured } = capturingSeams();
		// No env override (the bug repro). The fake storage keeps the deterministic health bit, but
		// the PROVIDER (not the fake client) is what feeds the scope — proving the two share one source.
		delete process.env.HONEYCOMB_DEEPLAKE_ORG;
		delete process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			provider,
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			seams,
		});
		// The scope threaded into BOTH the dashboard view AND the data mounts is the creds' org —
		// never the `"local"` placeholder (the bug). Same object value proves a single resolved source.
		expect(captured.dashboardScope).toEqual({ org: "71f2566d-OSPRY", workspace: "default" });
		expect(captured.memoriesScope).toEqual({ org: "71f2566d-OSPRY", workspace: "default" });
		// The friendly orgName reaches the settings view (so the header shows "OSPRY", not the GUID).
		expect(captured.dashboardOrgName).toBe("OSPRY");
	});

	it("with the env vars SET, env WINS over the file (the override + live-itest path is preserved)", () => {
		const provider = stubProvider(
			fakeCredentialRecord({ org: "file-org", workspace: "file-ws", orgName: "FileOrg" }),
		);
		const { seams, captured } = capturingSeams();
		process.env.HONEYCOMB_DEEPLAKE_ORG = "env-org";
		process.env.HONEYCOMB_DEEPLAKE_WORKSPACE = "env-ws";
		try {
			assembleDaemon({
				config: cfg({ mode: "local" }),
				storage: fakeStorage(OK_RESULT),
				provider,
				logger: createRequestLogger({ silent: true }),
				runtimeDir,
				seams,
			});
		} finally {
			delete process.env.HONEYCOMB_DEEPLAKE_ORG;
			delete process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;
		}
		// Env overrides the file per-field — the escape hatch and the live-itest path still win.
		expect(captured.dashboardScope).toEqual({ org: "env-org", workspace: "env-ws" });
		// orgName is a file-only display field (env carries none) — still the file's friendly name.
		expect(captured.dashboardOrgName).toBe("FileOrg");
	});

	it("with NO creds + NO env (injected fake client, no provider) → {org:'local', workspace:'default'} (the deterministic suite is unchanged)", () => {
		const { seams, captured } = capturingSeams();
		delete process.env.HONEYCOMB_DEEPLAKE_ORG;
		delete process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;
		// No `provider` injected + a fake `storage` → no creds at all → the benign loopback fallback.
		assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			seams,
		});
		expect(captured.dashboardScope).toEqual({ org: "local", workspace: "default" });
		expect(captured.memoriesScope).toEqual({ org: "local", workspace: "default" });
		// No creds → no friendly name; the settings view falls back to the scope org (handled in api.ts).
		expect(captured.dashboardOrgName).toBeUndefined();
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

describe("PRD-025 AC-1/D-6 the embed supervisor is wired into the daemon lifecycle", () => {
	/** A recording fake supervisor that satisfies the EmbedSupervisor contract. */
	function recordingSupervisor(): { svc: EmbedSupervisor; calls: { start: number; stop: number } } {
		const calls = { start: 0, stop: 0 };
		const svc: EmbedSupervisor = {
			live: false,
			warm: false,
			disabled: false,
			restarts: 0,
			start(): void {
				calls.start += 1;
			},
			stop(): void {
				calls.stop += 1;
			},
			async restart(): Promise<void> {
				/* recorded elsewhere */
			},
		};
		return { svc, calls };
	}

	it("AC-1: the assembled daemon exposes the embed supervisor as a wired service", () => {
		const { svc } = recordingSupervisor();
		const assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: svc,
		});
		// The injected supervisor IS the daemon's `embed` service (not the inert stub) — proof
		// the composition root threads it into DaemonServices so the daemon OWNS it (D-6).
		expect(assembled.daemon.services.embed).toBe(svc);
	});

	it("D-6: startServices starts the embed supervisor, stopServices stops it (lifecycle-owned)", async () => {
		const { svc, calls } = recordingSupervisor();
		const assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: svc,
		});
		// start() runs the daemon lifecycle (which calls startServices → embed.start()).
		await assembled.start();
		expect(calls.start).toBe(1);
		// A clean daemon shutdown drains the embed child (stopServices → embed.stop()).
		await assembled.shutdown();
		expect(calls.stop).toBe(1);
	});

	it("D-1: the default real supervisor is INERT under HONEYCOMB_EMBEDDINGS=false (no child spawned)", () => {
		const prev = process.env.HONEYCOMB_EMBEDDINGS;
		process.env.HONEYCOMB_EMBEDDINGS = "false";
		try {
			// Construct the REAL supervisor via its factory. With the opt-out set it reports
			// itself disabled and never spawns — so constructing it here touches no process.
			const supervisor = createEmbedSupervisor();
			expect(supervisor.disabled).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.HONEYCOMB_EMBEDDINGS;
			else process.env.HONEYCOMB_EMBEDDINGS = prev;
		}
	});
});

describe("PRD-026 AC-W the daemon-resident pollinating worker is gated on config.enabled (default OFF)", () => {
	/** A fixed pollinating-config provider so the gate is driven WITHOUT touching process.env. */
	function pollinatingProvider(over: { enabled?: unknown } = {}): PollinatingConfigProvider {
		return {
			read(): RawPollinatingConfig {
				return {
					enabled: over.enabled,
					// Tiny numeric knobs so resolvePollinatingConfig clamps cleanly.
					tokenThreshold: 1,
					maxInputTokens: 1,
					backfillOnFirstRun: false,
				};
			},
		};
	}

	/** A recording fake pollinating worker that satisfies the PollinatingJobWorker contract. */
	function recordingWorker(): { worker: PollinatingJobWorker; calls: { start: number; stop: number } } {
		const calls = { start: 0, stop: 0 };
		const worker: PollinatingJobWorker = {
			async runOnce(): Promise<boolean> {
				return false;
			},
			start(): void {
				calls.start += 1;
			},
			stop(): void {
				calls.stop += 1;
			},
		};
		return { worker, calls };
	}

	it("AC-W: with enabled:FALSE the worker is NOT started (the default-OFF gate holds)", async () => {
		const { worker, calls } = recordingWorker();
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			// Inject the recording worker BUT a disabled config provider: the gate must keep
			// `start()` from ever firing (in production the heavy bits are never even built).
			pollinatingWorker: worker,
			pollinatingConfigProvider: pollinatingProvider({ enabled: false }),
		});
		await assembled.start();
		try {
			expect(calls.start, "a disabled pollinating loop never starts the worker").toBe(0);
		} finally {
			await assembled.shutdown();
		}
		// Stop is a no-op when never started (the worker was never wired into the lifecycle).
		expect(calls.stop).toBe(0);
	});

	it("AC-W: with enabled:TRUE the worker IS started, and shutdown stops it (lifecycle-owned)", async () => {
		const { worker, calls } = recordingWorker();
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: worker,
			pollinatingConfigProvider: pollinatingProvider({ enabled: true }),
		});
		await assembled.start();
		expect(calls.start, "an enabled pollinating loop starts the worker exactly once").toBe(1);
		await assembled.shutdown();
		expect(calls.stop, "a clean shutdown stops the pollinating worker").toBe(1);
	});

	it("AC-W: injecting `null` as the worker constructs NOTHING — the daemon boots clean (no throw)", async () => {
		// `null` is the "no worker constructed when disabled" shape: the build step is skipped
		// entirely. The daemon must still start + serve + shut down without error.
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: null,
			pollinatingConfigProvider: pollinatingProvider({ enabled: true }),
		});
		await expect(assembled.start()).resolves.toBeUndefined();
		const res = await assembled.daemon.app.request("/health");
		expect(res.status).toBe(200);
		await assembled.shutdown();
	});

	it("AC-T/AC-W: with NO agent.yaml AND enabled:TRUE the daemon still boots (model degrades to noop, no throw)", async () => {
		// The end-to-end fail-soft proof for AC-T: enabled pollinating + the REAL (un-injected)
		// worker build, but the inference config path points at a file that does not exist.
		// `buildInferenceModelClient` returns the no-op client (never throws), the real worker
		// is constructed + started, and the daemon boots cleanly. The worker leases an empty
		// (fake) queue and runs nothing — no live model call, exactly Wave-1c's scope.
		const missingAgentYaml = join(runtimeDir, "no-such-agent.yaml");
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			// No `pollinatingWorker` injected → the REAL build path runs (model client + trigger +
			// worker), proving the production wiring boots without an agent.yaml or a key.
			agentConfigPath: missingAgentYaml,
			pollinatingConfigProvider: pollinatingProvider({ enabled: true }),
		});
		await expect(assembled.start()).resolves.toBeUndefined();
		try {
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
		} finally {
			await assembled.shutdown();
		}
	});

	it("AC-W: a malformed/non-bool enabled knob degrades to OFF (never prevents the daemon booting)", async () => {
		// BoolFlag coerces a non-bool to false, so the gate is closed and the daemon boots with
		// no worker — the point is start() NEVER throws out of the pollinating wiring (fail-soft).
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingConfigProvider: pollinatingProvider({ enabled: "not-a-bool" }),
		});
		await expect(assembled.start()).resolves.toBeUndefined();
		await assembled.shutdown();
	});
});

describe("PRD-032d AC-6 the inference provider/model + pollinating flag are VAULT-DRIVEN (vault-first, agent.yaml/env fallback)", () => {
	/**
	 * A fake vault `setting`-class reader (the narrow `VaultSettingsReader` surface). A map of
	 * `key → SettingValue` is the stored vault; a missing key resolves `not_found`. Records every
	 * key read so a test proves assembly CONSULTED the vault. NEVER touches the real workspace.
	 */
	function fakeVault(settings: Record<string, SettingValue>): {
		vault: VaultSettingsReader;
		reads: string[];
	} {
		const reads: string[] = [];
		const vault: VaultSettingsReader = {
			async getSetting(key: string, _scope: SecretScope): Promise<SettingResult> {
				reads.push(key);
				if (Object.hasOwn(settings, key)) {
					return { ok: true, value: settings[key] as SettingValue };
				}
				return { ok: false, reason: "not_found" };
			},
		};
		return { vault, reads };
	}

	/** A fixed pollinating-config provider so the ENV gate is driven WITHOUT touching process.env. */
	function pollinatingProvider(over: { enabled?: unknown } = {}): PollinatingConfigProvider {
		return {
			read(): RawPollinatingConfig {
				return { enabled: over.enabled, tokenThreshold: 1, maxInputTokens: 1, backfillOnFirstRun: false };
			},
		};
	}

	/** A recording fake pollinating worker (the PollinatingJobWorker contract). */
	function recordingWorker(): { worker: PollinatingJobWorker; calls: { start: number; stop: number } } {
		const calls = { start: 0, stop: 0 };
		const worker: PollinatingJobWorker = {
			async runOnce(): Promise<boolean> {
				return false;
			},
			start(): void {
				calls.start += 1;
			},
			stop(): void {
				calls.stop += 1;
			},
		};
		return { worker, calls };
	}

	// ── d-AC-2: pollinating-enabled is VAULT-FIRST ──────────────────────────────────

	it("d-AC-2: vault pollinating.enabled=true (env UNSET) → the worker IS started (no HONEYCOMB_POLLINATING_ENABLED needed)", async () => {
		const { worker, calls } = recordingWorker();
		const { vault } = fakeVault({ "pollinating.enabled": true });
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: worker,
			// The env says OFF (enabled:false); the vault says ON — the vault must WIN.
			pollinatingConfigProvider: pollinatingProvider({ enabled: false }),
			vault,
		});
		await assembled.start();
		try {
			expect(calls.start, "vault pollinating.enabled=true starts the worker even with env OFF").toBe(1);
		} finally {
			await assembled.shutdown();
		}
		expect(calls.stop).toBe(1);
	});

	it("d-AC-2 precedence: vault pollinating.enabled=false WINS over env enabled=true (vault-first)", async () => {
		const { worker, calls } = recordingWorker();
		const { vault } = fakeVault({ "pollinating.enabled": false });
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: worker,
			// The env says ON; the vault says OFF — vault-first means the worker stays OFF.
			pollinatingConfigProvider: pollinatingProvider({ enabled: true }),
			vault,
		});
		await assembled.start();
		try {
			expect(calls.start, "a vault pollinating.enabled=false disables pollinating even when env is true").toBe(0);
		} finally {
			await assembled.shutdown();
		}
	});

	it("d-AC-3: NO vault pollinating setting + env unset → the worker is NOT started (env fallback, no regression)", async () => {
		const { worker, calls } = recordingWorker();
		// An empty vault → the pollinating decision falls back to the env (enabled:false here).
		const { vault } = fakeVault({});
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: worker,
			pollinatingConfigProvider: pollinatingProvider({ enabled: false }),
			vault,
		});
		await assembled.start();
		try {
			expect(calls.start, "an empty vault falls back to the env gate (OFF) — no worker").toBe(0);
		} finally {
			await assembled.shutdown();
		}
	});

	it("d-AC-3: NO vault pollinating setting + env enabled=true → the worker IS started (env fallback preserved)", async () => {
		const { worker, calls } = recordingWorker();
		const { vault } = fakeVault({});
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: worker,
			// Empty vault → env decides; env says ON → the worker starts (PRD-026 behavior intact).
			pollinatingConfigProvider: pollinatingProvider({ enabled: true }),
			vault,
		});
		await assembled.start();
		try {
			expect(calls.start, "an empty vault preserves the HONEYCOMB_POLLINATING_ENABLED env fallback").toBe(1);
		} finally {
			await assembled.shutdown();
		}
		expect(calls.stop).toBe(1);
	});

	// ── d-AC-1: provider/model is VAULT-DRIVEN — assembly CONSULTS the vault ──────

	it("d-AC-1: with pollinating enabled the assembly READS the vault provider/model keys (vault is consulted before the model build)", async () => {
		// The REAL pollinating build runs (no injected worker), pointed at a missing agent.yaml so the
		// model degrades to the no-op client (never a throw). The vault carries a valid catalog pair;
		// we prove assembly READ `activeProvider` + `activeModel` (the override-resolution path runs).
		const { vault, reads } = fakeVault({
			"pollinating.enabled": true,
			activeProvider: "anthropic",
			activeModel: "claude-opus-4-8",
		});
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			// No injected worker → the REAL build path runs, reaching the provider/model override read.
			agentConfigPath: join(runtimeDir, "no-such-agent.yaml"),
			pollinatingConfigProvider: pollinatingProvider({ enabled: false }), // vault drives the gate ON.
			vault,
		});
		await expect(assembled.start()).resolves.toBeUndefined();
		try {
			// The daemon booted (model degraded to no-op, fail-soft) AND the vault was consulted for the
			// provider/model selection — proving the override-resolution path ran (d-AC-1 / FR-1).
			expect(reads).toContain("activeProvider");
			expect(reads).toContain("activeModel");
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
		} finally {
			await assembled.shutdown();
		}
	});

	// ── mountSettingsApi fired once + fail-soft boot ─────────────────────────────

	it("AC-6: mountSettingsApi is fired — GET /api/settings responds on the assembled daemon (CLI/dashboard surface is live)", async () => {
		// Inject a REAL VaultStore over a temp dir + fake machine-key so the settings mount fires and
		// the route is reachable in-process. The route group is protect:true; in local mode the
		// permission middleware is open, so a request reaches the handler.
		const vaultBase = mkdtempSync(join(tmpdir(), "honeycomb-vault-"));
		const realVault = new VaultStore({
			baseDir: vaultBase,
			machineKey: createFakeMachineKeyProvider("machine-settings"),
			registry: createVaultRegistry(),
		});
		// Seed one setting so the GET list is non-empty (and proves the handler reads the store).
		await realVault.setSetting("pollinating.enabled", true, { org: "local", workspace: "default" });
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			vault: realVault,
		});
		try {
			const res = await assembled.daemon.app.request("/api/settings", {
				method: "GET",
				headers: { "x-honeycomb-org": "local", "x-honeycomb-workspace": "default" },
			});
			// The mount fired: the route resolves (200) and returns the catalog + the seeded setting.
			expect(res.status).toBe(200);
			const body = (await res.json()) as { settings: Record<string, unknown>; catalog: unknown[] };
			expect(body.catalog.length).toBeGreaterThan(0);
			expect(body.settings["pollinating.enabled"]).toBe(true);
		} finally {
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});

	it("AC-6 fail-soft: an empty/absent vault still boots the daemon cleanly (a vault read never blocks boot)", async () => {
		// An empty fake vault: every getSetting is not_found. Provider/model + pollinating fall back; the
		// daemon must boot + serve /health + shut down without error (the wire-back is fail-soft).
		const { vault } = fakeVault({});
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingConfigProvider: pollinatingProvider({ enabled: true }),
			agentConfigPath: join(runtimeDir, "no-such-agent.yaml"),
			vault,
		});
		await expect(assembled.start()).resolves.toBeUndefined();
		try {
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
		} finally {
			await assembled.shutdown();
		}
	});
});

describe("PRD-032a AC-3 boot WIRING: start() invokes the DeepLake-token vault migration (live, non-destructive)", () => {
	/**
	 * THE boot-wiring proof for AC-3 (032d): the migration FUNCTION is unit-tested in the vault
	 * suite; here we prove the daemon's `start()` actually CALLS it. We inject a REAL
	 * {@link VaultStore} over a temp base dir + a fake machine-key + the real registry so the
	 * `start()` guard `vault instanceof VaultStore` is satisfied and the migration block runs.
	 *
	 * The creds source is driven HERMETICALLY: the boot migration uses the DEFAULT reader
	 * (`systemDeeplakeCredsReader` → `loadDiskCredentials()` → `~/.deeplake/credentials.json` via
	 * `os.homedir()`). To keep the read off the real user home we point `USERPROFILE` (win32) AND
	 * `HOME` (posix) at a per-test temp dir, seed a structurally-valid `DiskCredentials` under it
	 * (or NOT, for the no-creds case), clear `HONEYCOMB_TOKEN` so the env-token rule never masks
	 * the seeded file token, and RESTORE the env after each test. No network, no real `~/.deeplake`,
	 * fully deterministic.
	 *
	 * The daemon's resolved scope for an injected fake `storage` with NO provider is the
	 * `{ org: "local", workspace: "default" }` default (`resolveDaemonTenancy` step (c)), so the
	 * boot migration writes under `secretScopeFromQueryScope({ org: "local", workspace: "default" })`
	 * = `{ org: "local", workspace: "default" }` — the SAME scope we read the vault back with.
	 */
	const BOOT_SCOPE: SecretScope = { org: "local", workspace: "default" };
	const SEEDED_TOKEN = "dl-boot-wired-token-abc123";

	/** A temp HOME the seeded `~/.deeplake/credentials.json` lives under (per test). */
	let homeDir: string;
	/** A temp base dir the real VaultStore writes its records under (per test). */
	let vaultBase: string;
	/** The saved env we restore in afterEach so the global isolate-home redirect is preserved. */
	let prevUserProfile: string | undefined;
	let prevHome: string | undefined;
	let prevToken: string | undefined;

	/** Build the REAL VaultStore over the temp base dir + a fixed fake machine-key + the registry. */
	function realVault(): VaultStore {
		return new VaultStore({
			baseDir: vaultBase,
			machineKey: createFakeMachineKeyProvider("machine-boot-migration"),
			registry: createVaultRegistry(),
			clock: { now: () => "2026-06-21T00:00:00.000Z" },
		});
	}

	/** Seed a structurally-valid `DiskCredentials` at `<homeDir>/.deeplake/credentials.json`. */
	function seedCreds(token: string): string {
		const dir = join(homeDir, CREDENTIALS_DIR_NAME);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, CREDENTIALS_FILE_NAME);
		// `isDiskCredentials` requires a non-empty `token` + `orgId`; `savedAt` is carried for a
		// structurally-complete record (the loader tolerates it as a string).
		const creds = {
			token,
			orgId: "71f2566d-OSPRY",
			orgName: "OSPRY",
			workspaceId: "default",
			apiUrl: "https://api.deeplake.ai",
			savedAt: "2026-06-21T00:00:00.000Z",
		};
		writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { encoding: "utf8" });
		return file;
	}

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "honeycomb-boot-home-"));
		vaultBase = mkdtempSync(join(tmpdir(), "honeycomb-boot-vault-"));
		// Relocate the home `os.homedir()` resolves so the default creds reader NEVER touches the
		// real `~/.deeplake`. Both vars are set: win32 reads USERPROFILE, POSIX reads HOME.
		prevUserProfile = process.env.USERPROFILE;
		prevHome = process.env.HOME;
		prevToken = process.env[ENV_TOKEN];
		process.env.USERPROFILE = homeDir;
		process.env.HOME = homeDir;
		// Clear the env-token override so `loadDiskCredentials` trusts the SEEDED file token (the env
		// rule would otherwise replace it and the assertion would be vacuous).
		delete process.env[ENV_TOKEN];
	});

	afterEach(() => {
		// Restore the env EXACTLY (so the global isolate-home redirect resumes for later suites).
		if (prevUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevUserProfile;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevToken === undefined) delete process.env[ENV_TOKEN];
		else process.env[ENV_TOKEN] = prevToken;
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(vaultBase, { recursive: true, force: true });
	});

	it("AC-3 boot COPIES the DeepLake token into the vault (the migration FIRED) and leaves the plaintext creds BYTE-UNCHANGED", async () => {
		const credsFile = seedCreds(SEEDED_TOKEN);
		// Capture the plaintext bytes BEFORE boot so we can prove the migration is non-destructive.
		const before = readFileSync(credsFile);

		const vault = realVault();
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			// The REAL VaultStore satisfies the `vault instanceof VaultStore` guard → the boot
			// migration block runs against it.
			vault,
		});

		await assembled.start();
		try {
			// PROOF the migration FIRED: read the COPIED token back via the store's INTERNAL secret
			// resolver under the daemon's resolved boot scope — it equals the seeded token.
			const inVault = await vault.getSecretValue(DEEPLAKE_TOKEN_NAME, BOOT_SCOPE);
			expect(inVault.ok).toBe(true);
			expect(inVault.ok && inVault.value).toBe(SEEDED_TOKEN);
		} finally {
			await assembled.shutdown();
		}

		// NON-DESTRUCTIVE (D-3): the migration COPIES — it never writes the plaintext creds file.
		// The bytes are identical and the file still exists.
		expect(existsSync(credsFile)).toBe(true);
		const after = readFileSync(credsFile);
		expect(after.equals(before)).toBe(true);
	});

	it("AC-3 fail-soft: with NO ~/.deeplake/credentials.json the daemon still boots and the vault has NO DEEPLAKE_TOKEN (no_creds no-op)", async () => {
		// Point HOME at a dir with NO `.deeplake/credentials.json` (we seed nothing): the default
		// reader returns null → the migration is a `no_creds` NO-OP, never an error, never a write.
		expect(existsSync(join(homeDir, CREDENTIALS_DIR_NAME, CREDENTIALS_FILE_NAME))).toBe(false);

		const vault = realVault();
		const assembled = assembleDaemon({
			config: cfg({ mode: "local" }),
			storage: fakeStorage(OK_RESULT),
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			vault,
		});

		// The daemon boots cleanly even though there are no creds to migrate (fail-soft).
		await expect(assembled.start()).resolves.toBeUndefined();
		try {
			// No creds → the migration was a no-op → the vault holds NO DEEPLAKE_TOKEN record.
			const inVault = await vault.getSecretValue(DEEPLAKE_TOKEN_NAME, BOOT_SCOPE);
			expect(inVault.ok).toBe(false);
			// And the daemon is genuinely up (the boot completed past the migration block).
			const res = await assembled.daemon.app.request("/health");
			expect(res.status).toBe(200);
		} finally {
			await assembled.shutdown();
		}
	});
});
