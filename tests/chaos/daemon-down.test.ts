/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CHAOS — daemon-down fail-soft over REAL sockets (PRD-020b FR-8 /         ║
 * ║  PRD-016c/018b b-AC-6 / PRD-020d FR-2).                                   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The fail-soft claims are proven against FAKES that resolve/timeout       ║
 * ║  cleanly. This suite removes the fakes for the I/O boundary: it points    ║
 * ║  the surfaces at REAL `node:net` / `node:http` sockets on EPHEMERAL       ║
 * ║  ports (port 0) that are either DEAD (bound-then-closed) or ACCEPT-BUT-   ║
 * ║  NEVER-REPLY, and proves every surface DEGRADES within a bounded time —   ║
 * ║  never hangs, never throws an unhandled rejection.                        ║
 * ║                                                                          ║
 * ║  1. Dashboard: `createDaemonDashboardDataSource` → an UNREACHABLE         ║
 * ║     loopback port → `renderDashboard` returns the connectivity banner     ║
 * ║     ALONE, bounded, and NEVER calls fetchAll (we wrap the source so a     ║
 * ║     stray fetchAll would fail the test).                                  ║
 * ║  2. autoPull: a REAL `SkillPullClient` whose read dials a socket that     ║
 * ║     accepts but never replies → `autoPull`'s timeout fires and it returns ║
 * ║     null without blocking past the bound. Asserted twice: with a short    ║
 * ║     injected timeout (fast) AND against the REAL 5s `AUTOPULL_TIMEOUT_MS` ║
 * ║     with generous headroom.                                               ║
 * ║  3. Notifications: a backend `fetch()` that hangs on a real never-reply   ║
 * ║     socket → the ~1.5s bounded fail-soft drain returns (banner === null,  ║
 * ║     hang NOT propagated).                                                 ║
 * ║                                                                          ║
 * ║  EPHEMERAL PORTS ONLY (port 0) so parallel runs never collide. Every      ║
 * ║  socket + server is closed in afterEach/afterAll; every wait is bounded;  ║
 * ║  an unhandled rejection during the run fails the test.                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	createDaemonDashboardDataSource,
	type DashboardData,
	type DashboardDataSource,
	renderDashboard,
} from "../../src/dashboard/index.js";
import {
	AUTOPULL_TIMEOUT_MS,
	type AgentRootDetector,
	autoPull,
	type AuthCheck,
	createFakeTrustedTableList,
	type PulledSkill,
	type SkillPullClient,
} from "../../src/daemon-client/skillify/index.js";
import {
	type BackendNotificationSource,
	createClaimLock,
	createInMemoryStateFs,
	createNotificationsPipeline,
	createNotificationsState,
	type Notification,
} from "../../src/notifications/index.js";

/** Sockets/servers opened during a test, torn down in afterEach (no leak across tests). */
const openSockets: Socket[] = [];
const openServers: Array<NetServer | HttpServer> = [];
/** Server-side accepted sockets (the never-reply black holes), force-destroyed on teardown. */
const acceptedSockets: Socket[] = [];

/** Track unhandled rejections during the run — a fail-soft path must never produce one. */
const unhandled: unknown[] = [];
function onUnhandled(reason: unknown): void {
	unhandled.push(reason);
}

beforeAll(() => {
	process.on("unhandledRejection", onUnhandled);
});

afterAll(() => {
	process.off("unhandledRejection", onUnhandled);
});

afterEach(async () => {
	// Destroy BOTH client-side and server-side (accepted) sockets so no live connection
	// keeps a server's `close()` pending — a never-reply black hole would otherwise hang teardown.
	for (const s of [...openSockets.splice(0), ...acceptedSockets.splice(0)]) {
		try {
			s.destroy();
		} catch {
			/* ignore */
		}
	}
	await Promise.all(
		openServers.splice(0).map(
			(srv) =>
				new Promise<void>((resolve) => {
					try {
						// closeAllConnections() force-drops any straggler the destroy loop missed.
						(srv as { closeAllConnections?: () => void }).closeAllConnections?.();
						srv.close(() => resolve());
					} catch {
						resolve();
					}
				}),
		),
	);
});

/**
 * A DEAD ephemeral port: bind a server on port 0, capture the assigned port, then
 * CLOSE it — so the port is (very likely) unbound and a connect gets ECONNREFUSED
 * fast. This is the "daemon not running" case for the dashboard probe.
 */
async function deadEphemeralPort(): Promise<number> {
	const srv = createNetServer();
	const port = await new Promise<number>((resolve, reject) => {
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr === null || typeof addr === "string") {
				reject(new Error("no ephemeral port assigned"));
				return;
			}
			resolve(addr.port);
		});
	});
	await new Promise<void>((resolve) => srv.close(() => resolve()));
	return port;
}

/**
 * An ACCEPT-BUT-NEVER-REPLY server on an ephemeral port: it accepts the TCP
 * connection and holds the socket open WITHOUT ever writing a byte. A client that
 * awaits a response will hang until ITS timeout fires — the real "daemon dispatch
 * that never responds" case. Returns the live port; the server is registered for
 * teardown.
 */
async function neverReplyServer(): Promise<number> {
	const srv = createNetServer((socket) => {
		// Accept and hold. Never write, never end — the connection is a black hole.
		acceptedSockets.push(socket);
		socket.on("error", () => {
			/* swallow client-side resets on teardown */
		});
	});
	openServers.push(srv);
	return new Promise<number>((resolve, reject) => {
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr === null || typeof addr === "string") {
				reject(new Error("no ephemeral port assigned"));
				return;
			}
			resolve(addr.port);
		});
	});
}

describe("CHAOS: dashboard renders the connectivity banner alone when the daemon is unreachable", () => {
	it("returns ONLY the connectivity banner, bounded, and NEVER calls fetchAll", async () => {
		const port = await deadEphemeralPort();

		// The REAL daemon-served data source over the global fetch, pointed at the dead port.
		// A short per-request timeout keeps the probe bounded even if the OS delays the refusal.
		const realSource = createDaemonDashboardDataSource({
			host: "127.0.0.1",
			port,
			timeoutMs: 1500,
		});

		// Wrap so a stray fetchAll() while the daemon is down FAILS the test (b-AC-2: the
		// renderer must branch on probe() and never fetch behind a spinner).
		let fetchAllCalled = false;
		const guardedSource: DashboardDataSource = {
			probe: () => realSource.probe(),
			fetchAll: (): Promise<DashboardData> => {
				fetchAllCalled = true;
				return realSource.fetchAll();
			},
		};

		const start = Date.now();
		const rendered = await renderDashboard(guardedSource);
		const elapsed = Date.now() - start;

		// Bounded: a dead port resolves well within a generous ceiling (the 1.5s probe + slack).
		expect(elapsed, "render must be bounded, never hang").toBeLessThan(10_000);

		// The connectivity state is unreachable, and the views are the banner ALONE.
		expect(rendered.connectivity.reachable, "probe must report the daemon unreachable").toBe(false);
		expect(rendered.views, "exactly one view block — the banner").toHaveLength(1);
		expect(rendered.views[0]?.kind).toBe("connectivity");
		expect(rendered.views[0]?.title).toBe("Daemon unreachable");

		// CRITICAL: fetchAll was NEVER called while the daemon was down (no hang behind a spinner).
		expect(fetchAllCalled, "fetchAll must NOT be called when the probe is unreachable").toBe(false);

		expect(unhandled, "no unhandled rejection on the daemon-down render path").toEqual([]);
	}, 30_000);
});

describe("CHAOS: autoPull's timeout fires against a real never-replying dispatch socket", () => {
	/** Detected agent roots pointed nowhere meaningful — autoPull times out before any write. */
	const roots: AgentRootDetector = {
		canonicalRoot: () => "/nonexistent-canonical-root-chaos",
		otherRoots: () => [],
	};
	/** Authenticated so autoPull proceeds to the (hanging) read rather than the silent skip. */
	const auth: AuthCheck = { isAuthenticated: () => true };

	/**
	 * A REAL {@link SkillPullClient} whose `readLatestSkills` dials a never-reply socket and
	 * awaits a response line that never arrives — a genuine hung socket I/O wait, NOT a
	 * `setTimeout` fake. `autoPull`'s timeout is the ONLY thing that can unblock it.
	 */
	function hangingPullClient(port: number): SkillPullClient {
		return {
			readLatestSkills(): Promise<readonly PulledSkill[]> {
				return new Promise<readonly PulledSkill[]>((resolve, reject) => {
					const socket = netConnect({ host: "127.0.0.1", port }, () => {
						// Send a request, then wait for a reply that the black-hole server never sends.
						socket.write("READ\n");
					});
					openSockets.push(socket);
					socket.on("data", () => resolve([])); // never fires (server never replies)
					socket.on("error", (err) => reject(err)); // only on teardown destroy
					// Deliberately NO socket-level timeout — the hang must be unblocked by autoPull's bound.
				});
			},
		};
	}

	it("returns null within a SHORT injected timeout (fast bound)", async () => {
		const port = await neverReplyServer();
		const client = hangingPullClient(port);

		const start = Date.now();
		const result = await autoPull({
			client,
			roots,
			auth,
			timeoutMs: 400, // a short, explicit bound the real socket hang cannot exceed.
			trustedTables: createFakeTrustedTableList(["skills"]),
		});
		const elapsed = Date.now() - start;

		expect(result, "a hung dispatch yields null, never a throw").toBeNull();
		// Bounded by the injected 400ms (+ slack); must NOT approach the real 5s.
		expect(elapsed, "must return at the injected bound, not the socket's never").toBeLessThan(3_000);
		expect(unhandled, "no unhandled rejection on the autoPull timeout path").toEqual([]);
	}, 30_000);

	it(`honors the REAL ${AUTOPULL_TIMEOUT_MS}ms AUTOPULL_TIMEOUT_MS bound (no override)`, async () => {
		const port = await neverReplyServer();
		const client = hangingPullClient(port);

		const start = Date.now();
		// No `timeoutMs` → the production default AUTOPULL_TIMEOUT_MS (5s) governs.
		const result = await autoPull({
			client,
			roots,
			auth,
			trustedTables: createFakeTrustedTableList(["skills"]),
		});
		const elapsed = Date.now() - start;

		expect(result, "the real 5s bound resolves to null, never a throw").toBeNull();
		// It must fire NEAR the real bound: at least most of it, and never run away past it.
		expect(elapsed, "must wait for the real timeout, proving the bound is genuine").toBeGreaterThanOrEqual(
			AUTOPULL_TIMEOUT_MS - 1_000,
		);
		expect(elapsed, "must not exceed the real bound by more than generous test headroom").toBeLessThan(
			AUTOPULL_TIMEOUT_MS + 5_000,
		);
		expect(unhandled, "no unhandled rejection on the real-bound autoPull path").toEqual([]);
	}, 30_000);
});

describe("CHAOS: the notifications drain stays bounded when a real backend fetch hangs", () => {
	/**
	 * A REAL {@link BackendNotificationSource} whose `fetch` dials a never-reply socket and
	 * awaits a reply that never comes — the pipeline's per-fetch timeout is the only escape.
	 */
	function hangingBackend(port: number): BackendNotificationSource {
		return {
			fetch(): Promise<readonly Notification[]> {
				return new Promise<readonly Notification[]>((resolve, reject) => {
					const socket = netConnect({ host: "127.0.0.1", port }, () => {
						socket.write("FETCH\n");
					});
					openSockets.push(socket);
					socket.on("data", () => resolve([]));
					socket.on("error", (err) => reject(err));
				});
			},
		};
	}

	it("drains within the ~1.5s bound (banner === null) without the hang propagating", async () => {
		const port = await neverReplyServer();
		const backend = hangingBackend(port);

		// Real state + claim seams (in-memory FS so no disk), real pipeline, real timeout.
		const fs = createInMemoryStateFs();
		const pipeline = createNotificationsPipeline({
			state: createNotificationsState({ dir: "/chaos-state", fs }),
			lock: createClaimLock({ dir: "/chaos-state", fs }),
			backend,
			timeoutMs: 1500, // the production-default ~1.5s bound (FR-2 / d-AC-3).
		});

		const start = Date.now();
		const result = await pipeline.drain("session_start");
		const elapsed = Date.now() - start;

		// Fail-soft: the hung backend contributes ZERO candidates → no banner, no throw.
		expect(result.banner, "a hung backend yields no banner (fail-soft)").toBeNull();
		// Bounded near the ~1.5s timeout, with generous headroom (never the socket's never).
		expect(elapsed, "drain must return at the bound, not block on the hang").toBeLessThan(6_000);
		expect(elapsed, "drain must actually wait out the bound, proving it is real").toBeGreaterThanOrEqual(1_000);
		expect(unhandled, "no unhandled rejection on the hung-backend drain path").toEqual([]);
	}, 30_000);
});
