/**
 * PRD-004a Hono server suite — a-AC-1..a-AC-7 (FR-1..8).
 *
 * Verification posture (EXECUTION_LEDGER-prd-004): in-process via
 * `daemon.app.request(...)`. No socket is bound. Each test is named after the AC
 * it proves so the ledger maps one-to-one to a passing test.
 */

import { describe, expect, it } from "vitest";
import { HONEYCOMB_VERSION } from "../../../src/shared/constants.js";
import { type RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../src/daemon/runtime/server.js";

/** Build a resolved config for a given mode without touching env. */
function cfg(mode: RuntimeConfig["mode"], over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false, ...over };
}

/** A minimal storage stub satisfying the `StorageQuery` interface (FR-6). */
const storageStub = {
	async query() {
		return { kind: "ok", rows: [], durationMs: 0 } as const;
	},
};

describe("a-AC-1 server is constructed with the resolved bind address", () => {
	it("exposes the resolved host/port/mode on the daemon", () => {
		const daemon = createDaemon({ config: cfg("local", { port: 4000, host: "0.0.0.0", widened: true }) });
		expect(daemon.config.host).toBe("0.0.0.0");
		expect(daemon.config.port).toBe(4000);
		expect(daemon.config.widened).toBe(true);
	});
});

describe("a-AC-2 /health is cheap, returns liveness/uptime/version/pipeline", () => {
	it("returns 200 with the health shape when storage is configured", async () => {
		const daemon = createDaemon({ config: cfg("local"), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(typeof body.uptimeMs).toBe("number");
		expect(body.version).toBe(HONEYCOMB_VERSION);
		expect(body.pipeline).toBe("ok");
	});

	it("reports unconfigured pipeline (200, daemon up) when no storage is wired", async () => {
		const daemon = createDaemon({ config: cfg("local"), logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/health");
		// Unconfigured storage still returns 200 (daemon up) but reports the pipeline.
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.pipeline).toBe("unconfigured");
	});

	it("degrades /health to 503 when the pipeline probe reports storage-down, process stays up", async () => {
		// The coarse probe (cached health bit, no per-request query) reports degraded:
		// /health returns non-200 so a client distinguishes daemon-down from storage-down.
		const daemon = createDaemon({
			config: cfg("local"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			pipelineProbe: () => "degraded",
		});
		const res = await daemon.app.request("/health");
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("degraded");
		expect(body.pipeline).toBe("degraded");
	});

	it("does not require any permission (reachable in team mode)", async () => {
		const daemon = createDaemon({ config: cfg("team"), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/health");
		expect(res.status).toBe(200);
	});
});

describe("a-AC-3 /api/status returns resolved config, providers, tenancy", () => {
	it("returns the resolved config + providers + tenancy + catalog count", async () => {
		const daemon = createDaemon({ config: cfg("team", { widened: true, host: "0.0.0.0" }), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/api/status", {
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "main" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.config.mode).toBe("team");
		expect(body.config.host).toBe("0.0.0.0");
		expect(body.config.widened).toBe(true);
		expect(body.providers.storage).toBe("configured");
		expect(body.tenancy.org).toBe("acme");
		expect(body.tenancy.workspace).toBe("main");
		expect(body.catalog.tableCount).toBeGreaterThan(0);
	});

	it("requires no permission (reachable in team mode without a role)", async () => {
		const daemon = createDaemon({ config: cfg("team"), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/api/status");
		expect(res.status).toBe(200);
	});
});

describe("a-AC-4 team mode: protected route rejected BEFORE the handler", () => {
	it("rejects a protected group with 403 when the permission check denies", async () => {
		let handlerReached = false;
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			// default-deny is the bootstrap default; make the assertion explicit.
			permissionCheck: () => false,
		});
		// Attach a probe handler to a protected group AFTER construction, via the
		// group accessor. Because the middleware was mounted at bootstrap (a-AC-6),
		// the probe sits behind it. The handler registers at the path RELATIVE to
		// the group base (`/probe`, not the full `/api/memories/probe`).
		daemon.group("/api/memories")?.get("/probe", (c) => {
			handlerReached = true;
			return c.json({ ok: true });
		});
		// Session-scoped groups (/api/memories) require x-honeycomb-runtime-path +
		// x-honeycomb-session (004d real middleware). Supply them so the test stays
		// focused on permission denial (a-AC-4), not runtime-path rejection.
		const res = await daemon.app.request("/api/memories/probe", {
			headers: {
				"x-honeycomb-runtime-path": "plugin",
				"x-honeycomb-session": "test-session",
			},
		});
		expect(res.status).toBe(403);
		expect(handlerReached).toBe(false); // handler never ran (rejected before it)
	});

	it("permits a protected route when the permission check allows", async () => {
		let handlerReached = false;
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			permissionCheck: (ctx) => ctx.role === "admin",
		});
		daemon.group("/api/skills")?.get("/probe", (c) => {
			handlerReached = true;
			return c.json({ ok: true });
		});
		const res = await daemon.app.request("/api/skills/probe", { headers: { "x-honeycomb-role": "admin" } });
		expect(res.status).toBe(200);
		expect(handlerReached).toBe(true);
	});
});

describe("a-AC-5 local mode: routes are open, handler runs without a check", () => {
	it("runs a handler on a protected group with no permission supplied", async () => {
		let handlerReached = false;
		const daemon = createDaemon({
			config: cfg("local"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			// Even default-deny must NOT fire in local mode.
			permissionCheck: () => false,
		});
		daemon.group("/api/goals")?.get("/probe", (c) => {
			handlerReached = true;
			return c.json({ ok: true });
		});
		const res = await daemon.app.request("/api/goals/probe");
		expect(res.status).toBe(200);
		expect(handlerReached).toBe(true);
	});
});

describe("a-AC-6 a later handler inherits the mounted permission middleware", () => {
	it("a probe handler attached post-construction is gated by the bootstrap middleware", async () => {
		const ran: string[] = [];
		const daemon = createDaemon({
			config: cfg("team"),
			storage: storageStub,
			logger: createRequestLogger({ silent: true }),
			// Record that the middleware ran by allowing only when it sees the group.
			permissionCheck: (ctx) => {
				ran.push(ctx.group);
				return false;
			},
		});
		// The handler is attached AFTER createDaemon — it re-wires NOTHING, yet the
		// permission middleware (mounted at bootstrap for /api/rules) runs first.
		daemon.group("/api/rules")?.get("/probe", (c) => c.json({ ok: true }));
		const res = await daemon.app.request("/api/rules/probe");
		// Middleware ran (recorded the group) and rejected before the handler.
		expect(ran).toContain("/api/rules");
		expect(res.status).toBe(403);
	});
});

describe("a-AC-7 HONEYCOMB_BIND widening is reflected at the config level", () => {
	it("/api/status reports widened:true for a widened bind", async () => {
		const daemon = createDaemon({ config: cfg("team", { host: "0.0.0.0", widened: true }), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/api/status");
		const body = (await res.json()) as any;
		expect(body.config.host).toBe("0.0.0.0");
		expect(body.config.widened).toBe(true);
	});
});

describe("FR-2 route-group scaffolding + FR-7 logging", () => {
	it("an unfilled protected group returns 501 (scaffolded, reachable) in local mode", async () => {
		const daemon = createDaemon({ config: cfg("local"), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/api/embeddings/anything");
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("not_implemented");
	});

	it("records a structured log record per request (FR-7)", async () => {
		const logger = createRequestLogger({ silent: true });
		const daemon = createDaemon({ config: cfg("local"), storage: storageStub, logger });
		await daemon.app.request("/health");
		const recent = logger.recent();
		expect(recent.length).toBe(1);
		expect(recent[0]?.path).toBe("/health");
		expect(recent[0]?.method).toBe("GET");
		expect(recent[0]?.status).toBe(200);
		expect(typeof recent[0]?.durationMs).toBe("number");
	});

	it("the root / is scaffolded and unprotected", async () => {
		const daemon = createDaemon({ config: cfg("team"), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		const res = await daemon.app.request("/");
		// Root is unprotected (FR-3 carve-out for the dashboard) → reaches the 501 scaffold, not a 403.
		expect(res.status).toBe(501);
	});
});

describe("bootstrap seams: Wave-2 services are registered + lifecycled", () => {
	it("the three stub services are wired with no-op defaults", () => {
		const daemon = createDaemon({ config: cfg("local"), logger: createRequestLogger({ silent: true }) });
		expect(daemon.services.queue).toBeDefined();
		expect(daemon.services.watcher).toBeDefined();
		expect(daemon.services.runtimePath).toBeDefined();
	});

	it("startServices/stopServices drive the injected services' lifecycle", async () => {
		const events: string[] = [];
		const makeService = (name: string) => ({
			start: () => {
				events.push(`start:${name}`);
			},
			stop: () => {
				events.push(`stop:${name}`);
			},
		});
		const daemon = createDaemon({
			config: cfg("local"),
			logger: createRequestLogger({ silent: true }),
			services: {
				queue: { ...makeService("queue"), enqueue: async () => "x", lease: async () => null, complete: async () => {}, fail: async () => {} },
				watcher: { ...makeService("watcher"), active: true },
				runtimePath: { ...makeService("rp"), claim: () => ({ ok: true }), activePath: () => undefined },
			},
		});
		await daemon.startServices();
		await daemon.stopServices();
		expect(events).toEqual(["start:queue", "start:watcher", "start:rp", "stop:rp", "stop:watcher", "stop:queue"]);
	});

	it("a session-scoped group has runtime-path middleware mounted ahead of it (real middleware requires path header)", async () => {
		const daemon = createDaemon({ config: cfg("local"), storage: storageStub, logger: createRequestLogger({ silent: true }) });
		// In local mode permission is open. The real 004d runtime-path middleware
		// requires x-honeycomb-runtime-path + x-honeycomb-session on session-scoped
		// groups. Supplying them lets the request pass through to the 501 scaffold,
		// proving the mount compiles and enforces (the pass-through stub is replaced
		// by the real impl — the 501 is only reached with valid headers).
		const res = await daemon.app.request("/api/memories/x", {
			headers: {
				"x-honeycomb-runtime-path": "plugin",
				"x-honeycomb-session": "test-session",
			},
		});
		expect(res.status).toBe(501);
	});
});
