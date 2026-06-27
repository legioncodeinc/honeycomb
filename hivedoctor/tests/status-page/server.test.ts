/**
 * Tests for the local status page server (PRD-064g AC-064g.4).
 *
 * AC coverage:
 *   AC-064g.4 -- daemon-down -> local status page returns current health +
 *                escalation + suggested commands (spin up on ephemeral port,
 *                GET / and /status.json)
 *
 * Implementation notes:
 *   - Uses port 0 so the OS assigns an ephemeral port (no conflict on CI).
 *   - start() is async-by-convention via a listener promise wrapper below.
 *   - All tests close the server in afterEach so no port is leaked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { silentLogger } from "../../src/logger.js";
import {
	createStatusPageServer,
	DEFAULT_STATUS_PAGE_PORT,
	type StatusPageHealth,
	type StatusPageServer,
	type StatusPageStateProvider,
	type StatusJson,
} from "../../src/status-page/server.js";
import type { NeedsAttentionFile } from "../../src/escalation/needs-attention-store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_NOW = 1_767_225_600_000;

function makeEscalationFile(resolved = false): NeedsAttentionFile {
	return {
		version: 1,
		escalation: {
			diagnosis: "Ladder exhausted after 3 failed restarts.",
			steps: [{ rung: 1, action: "restart-daemon", outcome: "failed", at: "2026-01-01T00:00:01.000Z" }],
			recommendedAction: "reinstall-primary",
			at: "2026-01-01T00:00:01.000Z",
		},
		resolved,
		recordedAt: "2026-01-01T00:00:01.000Z",
		...(resolved ? { resolvedAt: "2026-01-01T00:01:00.000Z" } : {}),
	};
}

function makeState(
	health: StatusPageHealth = "unreachable",
	escalation: NeedsAttentionFile | null = null,
): StatusPageStateProvider {
	return {
		health: () => health,
		escalation: () => escalation,
	};
}

/** Start the server on port 0 and resolve when it is listening. */
async function startServer(server: StatusPageServer): Promise<number> {
	return new Promise((resolve) => {
		// The server's start() binds synchronously and fires the 'listening' callback
		// internally. We poll listeningPort until it becomes defined.
		server.start();
		const poll = setInterval(() => {
			const p = server.listeningPort;
			if (p !== undefined) {
				clearInterval(poll);
				resolve(p);
			}
		}, 5);
	});
}

/** Fetch from the local server. Throws on network error (test will fail descriptively). */
async function localFetch(port: number, path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let server: StatusPageServer | null = null;

afterEach(() => {
	server?.stop();
	server = null;
});

// ── AC-064g.4: status page serves health + escalation + suggested commands ────

describe("AC-064g.4: status page GET /status.json returns health + escalation + commands", () => {
	it("returns 200 with health, escalation, and suggestedCommands at /status.json", async () => {
		const escalation = makeEscalationFile(false);
		server = createStatusPageServer({
			port: 0,
			state: makeState("unreachable", escalation),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const resp = await localFetch(port, "/status.json");
		expect(resp.status).toBe(200);
		expect(resp.headers.get("Content-Type")).toContain("application/json");

		const body = (await resp.json()) as StatusJson;
		expect(body.health).toBe("unreachable");
		expect(body.escalation).not.toBeNull();
		expect(body.escalation?.escalation.recommendedAction).toBe("reinstall-primary");
		expect(body.suggestedCommands.length).toBeGreaterThan(0);
		expect(typeof body.asOf).toBe("string");
	});

	it("includes the reinstall command in suggestedCommands when recommendedAction is reinstall-primary", async () => {
		const escalation = makeEscalationFile(false);
		server = createStatusPageServer({
			port: 0,
			state: makeState("unreachable", escalation),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const body = (await localFetch(port, "/status.json").then((r) => r.json())) as StatusJson;
		const hasInstallCmd = body.suggestedCommands.some((c) => c.includes("npm install"));
		expect(hasInstallCmd).toBe(true);
	});

	it("health is null-escalation when no escalation has occurred", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const body = (await localFetch(port, "/status.json").then((r) => r.json())) as StatusJson;
		expect(body.health).toBe("ok");
		expect(body.escalation).toBeNull();
	});

	it("always includes at least one suggested command", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("degraded", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const body = (await localFetch(port, "/status.json").then((r) => r.json())) as StatusJson;
		expect(body.suggestedCommands.length).toBeGreaterThanOrEqual(1);
	});

	it("sets Cache-Control: no-store on /status.json", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("unknown", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const resp = await localFetch(port, "/status.json");
		expect(resp.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("AC-064g.4: GET / returns HTML status page", () => {
	it("returns 200 with text/html content type", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("unreachable", makeEscalationFile(false)),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const resp = await localFetch(port, "/");
		expect(resp.status).toBe(200);
		expect(resp.headers.get("Content-Type")).toContain("text/html");
	});

	it("HTML body contains the health state", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("unreachable", makeEscalationFile(false)),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const body = await localFetch(port, "/").then((r) => r.text());
		expect(body).toContain("unreachable");
	});

	it("HTML body contains a link to /status.json", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const body = await localFetch(port, "/").then((r) => r.text());
		expect(body).toContain("/status.json");
	});

	it("HTML body contains the escalation diagnosis when present", async () => {
		const escalation = makeEscalationFile(false);
		server = createStatusPageServer({
			port: 0,
			state: makeState("unreachable", escalation),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const body = await localFetch(port, "/").then((r) => r.text());
		expect(body).toContain("reinstall-primary");
	});
});

describe("AC-064g.4: server lifecycle", () => {
	it("returns 404 for an unknown path", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);

		const resp = await localFetch(port, "/unknown-path");
		expect(resp.status).toBe(404);
	});

	it("start() is idempotent: a second call while listening is a no-op", async () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const port = await startServer(server);
		server.start(); // second call -- must not throw or double-bind

		const resp = await localFetch(port, "/status.json");
		expect(resp.status).toBe(200);
	});

	it("stop() before start() does not throw (defensive)", () => {
		server = createStatusPageServer({
			port: 0,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		expect(() => server!.stop()).not.toThrow();
	});

	it("DEFAULT_STATUS_PAGE_PORT is distinct from 3850 and 3851", () => {
		expect(DEFAULT_STATUS_PAGE_PORT).not.toBe(3850);
		expect(DEFAULT_STATUS_PAGE_PORT).not.toBe(3851);
	});

	it("bind error is swallowed: start() does not throw when port is taken", async () => {
		// Bind a server on a known port to block it.
		const blocker = createStatusPageServer({
			port: 0,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});
		const blockedPort = await startServer(blocker);

		// Try to bind a second server on the same port.
		const conflicted = createStatusPageServer({
			port: blockedPort,
			state: makeState("ok", null),
			logger: silentLogger,
			now: () => FAKE_NOW,
		});

		// Must not throw (EADDRINUSE is swallowed).
		expect(() => conflicted.start()).not.toThrow();

		// Clean up.
		await new Promise<void>((r) => setTimeout(r, 20));
		blocker.stop();
	});
});
