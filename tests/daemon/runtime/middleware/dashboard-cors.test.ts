/**
 * Dashboard CORS middleware suite (ADR-0001 cutover follow-up).
 *
 * Verification posture: in-process via `daemon.app.request(...)` with an
 * `Origin` header, mirroring what a real browser sends before/with a
 * cross-origin fetch. No socket is bound.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	THEHIVE_DASHBOARD_ORIGINS,
	dashboardCorsMiddleware,
} from "../../../../src/daemon/runtime/middleware/dashboard-cors.js";

function cfg(mode: RuntimeConfig["mode"] = "local"): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false };
}

function daemon() {
	return createDaemon({ config: cfg(), logger: createRequestLogger({ silent: true }) });
}

const THEHIVE_ORIGIN = "http://127.0.0.1:3853";

describe("dashboard CORS: the fixed thehive origin is allowed", () => {
	it("reflects thehive's loopback origin on a simple GET (/health)", async () => {
		const res = await daemon().app.request("/health", { headers: { origin: THEHIVE_ORIGIN } });
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe(THEHIVE_ORIGIN);
	});

	it("reflects thehive's origin on the unprotected /setup/state-shaped route surface (/health, no auth)", async () => {
		// /setup/* is registered elsewhere; the CORS mount is app-wide ("*"), so any path — including
		// one this daemon build has not registered a handler for — still carries the CORS headers on
		// its 404, which is what lets the browser's preflight see a real Access-Control-* answer.
		const res = await daemon().app.request("/setup/login", {
			method: "OPTIONS",
			headers: {
				origin: THEHIVE_ORIGIN,
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		// hono/cors answers a valid preflight directly (204), never falling through to the app's
		// own 404 — this is the exact failure mode found live (an unhandled OPTIONS 404ing with no
		// CORS headers, which makes the browser block the real POST before it is ever sent).
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(THEHIVE_ORIGIN);
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
		expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
	});

	it("also allows the localhost and honeycomb.local variants thehive's own dashboard opener uses", async () => {
		for (const origin of THEHIVE_DASHBOARD_ORIGINS) {
			const res = await daemon().app.request("/health", { headers: { origin } });
			expect(res.headers.get("access-control-allow-origin")).toBe(origin);
		}
	});
});

describe("dashboard CORS mount order: preflight requests are still captured by the request logger", () => {
	it("logs the OPTIONS preflight itself (mounted after the logger, so hono/cors's no-next() short-circuit is still observed)", async () => {
		const d = daemon();
		const res = await d.app.request("/setup/login", {
			method: "OPTIONS",
			headers: {
				origin: THEHIVE_ORIGIN,
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		expect(res.status).toBe(204);
		const logged = d.logger.recent(1)[0];
		expect(logged?.method).toBe("OPTIONS");
		expect(logged?.path).toBe("/setup/login");
		expect(logged?.status).toBe(204);
	});
});

describe("dashboard CORS: an origin outside the fixed allowlist is not reflected", () => {
	it("carries no Access-Control-Allow-Origin for a stranger origin (the browser then blocks reading the response)", async () => {
		const res = await daemon().app.request("/health", { headers: { origin: "http://evil.example.com" } });
		// The route itself still answers (CORS is a browser-enforced header, not a server-side
		// authorization gate) — but with no matching Access-Control-Allow-Origin, a real browser's
		// fetch() would refuse to expose the body to the calling page's script.
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.example.com");
	});

	it("a request with no Origin header at all (curl, server-to-server) is unaffected", async () => {
		const res = await daemon().app.request("/health");
		expect(res.status).toBe(200);
	});
});

describe("dashboard CORS: existing auth/permission enforcement is unchanged", () => {
	it("a protected route is rejected identically with or without an Origin header (CORS adds headers, never bypasses auth)", async () => {
		const withoutOrigin = await daemon().app.request("/api/memories");
		const withOrigin = await daemon().app.request("/api/memories", { headers: { origin: THEHIVE_ORIGIN } });
		// The default fail-closed authenticator/runtime-path guard denies the request either way, and
		// denies it with the SAME status — CORS is additive response headers, never an auth bypass.
		expect(withOrigin.status).toBe(withoutOrigin.status);
		expect(withOrigin.status).toBeGreaterThanOrEqual(400);
		// But the ALLOWED origin still gets its CORS header on that same rejected response, so the
		// browser can at least read the error body (an unrecognized origin would not get this header).
		expect(withOrigin.headers.get("access-control-allow-origin")).toBe(THEHIVE_ORIGIN);
	});
});

describe("dashboardCorsMiddleware() allowlist injection (for tests / future multi-portal deployments)", () => {
	it("honors an injected allowlist instead of the THEHIVE_DASHBOARD_ORIGINS default, and rejects anything not in it", async () => {
		const app = new Hono();
		app.use("*", dashboardCorsMiddleware(["http://example.internal:9999"]));
		app.get("/probe", (c) => c.text("ok"));

		const allowed = await app.request("/probe", { headers: { origin: "http://example.internal:9999" } });
		expect(allowed.headers.get("access-control-allow-origin")).toBe("http://example.internal:9999");

		// The real default (thehive's loopback origin) is NOT allowed once a different list is injected —
		// proves the allowlist is actually consulted, not a fixed/ignored constant.
		const notAllowed = await app.request("/probe", { headers: { origin: THEHIVE_ORIGIN } });
		expect(notAllowed.headers.get("access-control-allow-origin")).not.toBe(THEHIVE_ORIGIN);
	});
});
