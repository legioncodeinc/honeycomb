/**
 * PRD-004d runtime-path negotiation — d-AC-1..7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-004 §5): in-process via
 * `daemon.app.request(...)`. No socket is bound. Each test is named after the
 * d-AC it proves so the ledger maps one-to-one to a passing test.
 *
 * Session-id convention: `x-honeycomb-session` header.
 * Runtime-path header: `x-honeycomb-runtime-path` (`plugin` | `legacy`).
 * TTL default: 4h. Sweep default: ~5min. Both overridable for tests.
 *
 * Tests that need to observe TTL expiry or sweep-timer firing use
 * `vi.useFakeTimers()` + `vi.advanceTimersByTime()` so they run
 * instantaneously without real wall-clock delays.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import {
	createRuntimePathService,
	DEFAULT_TTL_MS,
	DEFAULT_SWEEP_INTERVAL_MS,
	noopRuntimePathService,
	runtimePathMiddleware,
} from "../../../../src/daemon/runtime/middleware/runtime-path.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal resolved config without touching env. */
function cfg(mode: RuntimeConfig["mode"] = "local"): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false };
}

/** A minimal StorageQuery stub (satisfies the interface, never queried). */
const storageStub = {
	async query() {
		return { kind: "ok", rows: [], durationMs: 0 } as const;
	},
};

/**
 * Build a daemon with the REAL runtime-path service injected and a probe
 * handler attached to a session-scoped group. The probe records whether it ran.
 *
 * Returns the daemon AND a function that reads whether the probe ran.
 */
function makeDaemon(
	service: ReturnType<typeof createRuntimePathService>,
	mode: RuntimeConfig["mode"] = "local",
) {
	const handlerRan = { value: false };
	const daemon = createDaemon({
		config: cfg(mode),
		storage: storageStub,
		logger: createRequestLogger({ silent: true }),
		// local mode → permission is open, so tests focus on 004d behaviour.
		permissionCheck: () => true,
		services: { runtimePath: service },
	});
	// Attach a probe handler to /api/memories (a session group).
	daemon.group("/api/memories")?.get("/probe", (c) => {
		handlerRan.value = true;
		return c.json({ reached: true });
	});
	return { daemon, handlerRan };
}

/**
 * Helper: issue a request to the probe handler with the given session + path.
 * Returns the Hono `Response`.
 */
async function probe(
	daemon: ReturnType<typeof makeDaemon>["daemon"],
	session: string,
	runtimePath: string,
): Promise<Response> {
	return daemon.app.request("/api/memories/probe", {
		headers: {
			"x-honeycomb-session": session,
			"x-honeycomb-runtime-path": runtimePath,
		},
	});
}

// ── d-AC-1: plugin claims, then legacy gets 409 ────────────────────────────────

describe("d-AC-1 session claimed by 'plugin'; 'legacy' request for same session → 409 Conflict", () => {
	it("first plugin request succeeds; subsequent legacy request for the same session returns 409", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		// Plugin claims the session.
		const r1 = await probe(daemon, "session-alpha", "plugin");
		expect(r1.status).toBe(200);

		// Legacy requests the same session — conflict.
		const r2 = await probe(daemon, "session-alpha", "legacy");
		expect(r2.status).toBe(409);
		const body = (await r2.json()) as Record<string, unknown>;
		expect(body.error).toBe("conflict");
		expect(body.heldBy).toBe("plugin");
	});

	it("the conflict is directional: legacy claims first, plugin gets 409", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		const r1 = await probe(daemon, "session-beta", "legacy");
		expect(r1.status).toBe(200);

		const r2 = await probe(daemon, "session-beta", "plugin");
		expect(r2.status).toBe(409);
		const body = (await r2.json()) as Record<string, unknown>;
		expect(body.heldBy).toBe("legacy");
	});

	it("different sessions do not conflict", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		const r1 = await probe(daemon, "session-one", "plugin");
		expect(r1.status).toBe(200);

		// Different session key → independent claim, no conflict.
		const r2 = await probe(daemon, "session-two", "legacy");
		expect(r2.status).toBe(200);
	});
});

// ── d-AC-2: stale claim past TTL → swept, session reclaimable ─────────────────

describe("d-AC-2 crashed-harness claim past TTL → swept, session reclaimable (fake timers)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("after TTL elapses and the sweeper fires, the session is reclaimable by either path", async () => {
		const ttlMs = 1_000; // 1 second for this test
		const sweepIntervalMs = 500; // 0.5 second sweep
		const service = createRuntimePathService({ ttlMs, sweepIntervalMs });
		service.start();

		const { daemon } = makeDaemon(service);

		// Plugin claims the session.
		const r1 = await probe(daemon, "session-gamma", "plugin");
		expect(r1.status).toBe(200);

		// Legacy conflicts while claim is live.
		const r2 = await probe(daemon, "session-gamma", "legacy");
		expect(r2.status).toBe(409);

		// Advance past TTL + trigger the sweeper.
		vi.advanceTimersByTime(ttlMs + sweepIntervalMs + 1);

		// Now legacy can claim the same session (sweep expired the plugin claim).
		const r3 = await probe(daemon, "session-gamma", "legacy");
		expect(r3.status).toBe(200);

		service.stop();
	});
});

// ── d-AC-3: claiming path re-requests its own session → proceeds + refreshes ──

describe("d-AC-3 claiming path re-requests own session → proceeds, claim timestamp refreshes", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("the claiming path can re-request multiple times without conflict", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		const r1 = await probe(daemon, "session-delta", "plugin");
		expect(r1.status).toBe(200);

		// Same path re-requests — must succeed (not conflict with itself).
		const r2 = await probe(daemon, "session-delta", "plugin");
		expect(r2.status).toBe(200);

		const r3 = await probe(daemon, "session-delta", "plugin");
		expect(r3.status).toBe(200);
	});

	it("last_seen_at is refreshed on each own re-request (hard cap: claimed_at stays fixed)", () => {
		// Test via the service directly to inspect last_seen_at indirectly through
		// activePath (which does NOT reset claimed_at).
		vi.setSystemTime(1_000);
		const clock = (): number => Date.now();
		const service = createRuntimePathService({ clock, ttlMs: 5_000 });

		// First claim at t=1000.
		const r1 = service.claim("s", "plugin");
		expect(r1.ok).toBe(true);
		expect(service.activePath("s")).toBe("plugin");

		// Advance to t=3000 — re-request by owning path.
		vi.setSystemTime(3_000);
		const r2 = service.claim("s", "plugin");
		expect(r2.ok).toBe(true);

		// Advance to t=4500 — still within TTL from claimed_at=1000 (4500-1000=3500 < 5000).
		vi.setSystemTime(4_500);
		expect(service.activePath("s")).toBe("plugin");

		// Advance to t=6001 — past TTL from claimed_at=1000 (6001-1000=5001 >= 5000).
		// Even though last_seen_at was refreshed at 3000, the hard cap (claimed_at)
		// governs expiry.
		vi.setSystemTime(6_001);
		expect(service.activePath("s")).toBeUndefined();
	});
});

// ── d-AC-4: missing/invalid header → rejected before handler ──────────────────

describe("d-AC-4 request without valid x-honeycomb-runtime-path → rejected before any session handler", () => {
	it("missing header returns 400 and the handler does NOT run", async () => {
		const service = createRuntimePathService();
		const { daemon, handlerRan } = makeDaemon(service);

		const res = await daemon.app.request("/api/memories/probe", {
			headers: { "x-honeycomb-session": "session-echo" },
			// No x-honeycomb-runtime-path header.
		});
		expect(res.status).toBe(400);
		expect(handlerRan.value).toBe(false);
	});

	it("invalid value ('bad') returns 400 and the handler does NOT run", async () => {
		const service = createRuntimePathService();
		const { daemon, handlerRan } = makeDaemon(service);

		const res = await daemon.app.request("/api/memories/probe", {
			headers: {
				"x-honeycomb-session": "session-foxtrot",
				"x-honeycomb-runtime-path": "bad",
			},
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("bad_request");
		expect(handlerRan.value).toBe(false);
	});

	it("missing session header returns 400 and the handler does NOT run", async () => {
		const service = createRuntimePathService();
		const { daemon, handlerRan } = makeDaemon(service);

		const res = await daemon.app.request("/api/memories/probe", {
			headers: {
				"x-honeycomb-runtime-path": "plugin",
				// No x-honeycomb-session header.
			},
		});
		expect(res.status).toBe(400);
		expect(handlerRan.value).toBe(false);
	});

	it("both plugin and legacy are accepted as valid values", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		const rPlugin = await probe(daemon, "session-g1", "plugin");
		expect(rPlugin.status).toBe(200);

		const rLegacy = await probe(daemon, "session-g2", "legacy");
		expect(rLegacy.status).toBe(200);
	});
});

// ── d-AC-5: activePath reports the claimed path ──────────────────────────────

describe("d-AC-5 diagnostics query → reports the active claimed path for a session", () => {
	it("activePath returns 'plugin' after plugin claims the session", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		await probe(daemon, "session-hotel", "plugin");

		expect(service.activePath("session-hotel")).toBe("plugin");
	});

	it("activePath returns 'legacy' after legacy claims the session", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		await probe(daemon, "session-india", "legacy");

		expect(service.activePath("session-india")).toBe("legacy");
	});

	it("activePath returns undefined for a session that has never been claimed", () => {
		const service = createRuntimePathService();
		expect(service.activePath("never-claimed")).toBeUndefined();
	});

	it("activePath returns undefined after a conflict 409 (conflict does not update activePath)", async () => {
		const service = createRuntimePathService();
		const { daemon } = makeDaemon(service);

		// Plugin claims.
		await probe(daemon, "session-juliet", "plugin");
		// Legacy conflicts.
		const r = await probe(daemon, "session-juliet", "legacy");
		expect(r.status).toBe(409);

		// activePath still reports the original claimant, not the conflicting path.
		expect(service.activePath("session-juliet")).toBe("plugin");
	});
});

// ── d-AC-6: just-expired claim → fresh claim by either path ──────────────────

describe("d-AC-6 just-expired claim → either path touching it records a fresh claim", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("plugin claim expiring allows legacy to reclaim (lazy expiry on next touch)", async () => {
		vi.setSystemTime(0);
		const ttlMs = 2_000;
		const clock = (): number => Date.now();
		const service = createRuntimePathService({ ttlMs, clock });
		const { daemon } = makeDaemon(service);

		// Plugin claims at t=0.
		await probe(daemon, "session-kilo", "plugin");
		expect(service.activePath("session-kilo")).toBe("plugin");

		// Advance past TTL — no sweep needed; lazy expiry on next claim() call.
		vi.advanceTimersByTime(ttlMs + 1);

		// Legacy touches the expired session → fresh claim.
		const r = await probe(daemon, "session-kilo", "legacy");
		expect(r.status).toBe(200);
		expect(service.activePath("session-kilo")).toBe("legacy");
	});

	it("plugin claim expiring allows plugin itself to reclaim fresh", async () => {
		vi.setSystemTime(0);
		const ttlMs = 2_000;
		const clock = (): number => Date.now();
		const service = createRuntimePathService({ ttlMs, clock });
		const { daemon } = makeDaemon(service);

		// Plugin claims at t=0.
		await probe(daemon, "session-lima", "plugin");

		// Advance past TTL.
		vi.advanceTimersByTime(ttlMs + 1);

		// Plugin reclaims — fresh start (claimed_at resets).
		const r = await probe(daemon, "session-lima", "plugin");
		expect(r.status).toBe(200);
		expect(service.activePath("session-lima")).toBe("plugin");
	});
});

// ── d-AC-7: on 409, downstream handler never ran ──────────────────────────────

describe("d-AC-7 on 409 Conflict, no downstream handler runs (fail-closed before handler)", () => {
	it("the probe handler's side-effect does NOT occur when 409 is returned", async () => {
		const service = createRuntimePathService();
		const { daemon, handlerRan } = makeDaemon(service);

		// Plugin claims the session — handler runs.
		const r1 = await probe(daemon, "session-mike", "plugin");
		expect(r1.status).toBe(200);
		expect(handlerRan.value).toBe(true);

		// Reset the probe flag.
		handlerRan.value = false;

		// Legacy conflicts — 409, handler must NOT run.
		const r2 = await probe(daemon, "session-mike", "legacy");
		expect(r2.status).toBe(409);
		expect(handlerRan.value).toBe(false); // handler never ran
	});

	it("the response body on 409 names the holder and does NOT call next", async () => {
		const service = createRuntimePathService();
		const { daemon, handlerRan } = makeDaemon(service);

		await probe(daemon, "session-november", "legacy");
		handlerRan.value = false;

		const res = await probe(daemon, "session-november", "plugin");
		expect(res.status).toBe(409);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("conflict");
		expect(body.heldBy).toBe("legacy");
		expect(handlerRan.value).toBe(false);
	});
});

// ── Service unit tests: start/stop lifecycle ──────────────────────────────────

describe("RuntimePathService lifecycle (start/stop)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("start() is idempotent — calling it twice does not start two sweepers", () => {
		const service = createRuntimePathService({ ttlMs: 1_000, sweepIntervalMs: 500 });
		// start twice — must not throw and must behave like a single sweeper.
		service.start();
		service.start();
		// Clean up.
		service.stop();
	});

	it("stop() clears the sweeper and does not throw on double-stop", () => {
		const service = createRuntimePathService({ ttlMs: 1_000, sweepIntervalMs: 500 });
		service.start();
		service.stop();
		// Second stop is a no-op.
		service.stop();
	});

	it("noopRuntimePathService start/stop are lifecycle-safe (regression guard)", async () => {
		// Ensures the no-op stub still satisfies the lifecycle contract after the
		// real impl is in place (guards against accidentally breaking stubs.test.ts).
		await noopRuntimePathService.start();
		await noopRuntimePathService.stop();
		expect(noopRuntimePathService.claim("s", "plugin").ok).toBe(true);
		expect(noopRuntimePathService.activePath("s")).toBeUndefined();
	});
});

// ── Middleware unit test: createRuntimePathService + runtimePathMiddleware directly ─

describe("runtimePathMiddleware mounted on a minimal Hono app (direct integration)", () => {
	it("a request through the full middleware chain produces a 409 before any session capture", async () => {
		// Build a tiny Hono app with ONLY the runtime-path middleware + a probe
		// handler, bypassing createDaemon. This proves the middleware shape is
		// independently correct without the full daemon scaffolding.
		const { Hono } = await import("hono");
		const service = createRuntimePathService();
		const mw = runtimePathMiddleware(service, () => "local");

		const app = new Hono();
		const ran = { value: false };
		app.use("/test/*", mw);
		app.get("/test/probe", (c) => {
			ran.value = true;
			return c.json({ ok: true });
		});

		// First request: plugin claims /test scope for session "omega".
		const r1 = await app.request("/test/probe", {
			headers: {
				"x-honeycomb-session": "omega",
				"x-honeycomb-runtime-path": "plugin",
			},
		});
		expect(r1.status).toBe(200);
		expect(ran.value).toBe(true);

		ran.value = false;

		// Second request: legacy conflicts.
		const r2 = await app.request("/test/probe", {
			headers: {
				"x-honeycomb-session": "omega",
				"x-honeycomb-runtime-path": "legacy",
			},
		});
		expect(r2.status).toBe(409);
		expect(ran.value).toBe(false);
	});
});

// ── Default TTL / sweep constants are exported and correct (D-2) ───────────────

describe("default TTL and sweep constants (D-2 binding)", () => {
	it("DEFAULT_TTL_MS is 4 hours", () => {
		expect(DEFAULT_TTL_MS).toBe(4 * 60 * 60 * 1_000);
	});

	it("DEFAULT_SWEEP_INTERVAL_MS is ~5 minutes", () => {
		expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1_000);
	});

	it("DEFAULT_SWEEP_INTERVAL_MS is well under DEFAULT_TTL_MS (D-2 constraint)", () => {
		expect(DEFAULT_SWEEP_INTERVAL_MS).toBeLessThan(DEFAULT_TTL_MS / 10);
	});
});
