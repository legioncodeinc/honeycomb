/**
 * PRD-021b b-AC-2 / b-AC-3 — daemon lifecycle verbs + ensure-running-on-demand.
 *
 * Proves with injected seams (a fake DaemonClient + a recording fake DaemonLifecycle):
 *   - b-AC-2: `daemon start` brings the daemon up and `daemon status` reports it running on 3850;
 *     `daemon stop` signals it down.
 *   - b-AC-3: ensure-running-on-demand auto-starts a DOWN daemon and reports reachable, so a
 *     storage verb completes rather than failing with ECONNREFUSED; it is a no-op when already up.
 */

import { describe, expect, it } from "vitest";

import {
	type DaemonLifecycle,
	type DaemonStatus,
	createFakeDaemonClient,
	ensureDaemonRunning,
	runDaemonCommand,
} from "../../src/commands/index.js";

/** A recording fake DaemonLifecycle: scripts start/status results + records every call. */
function fakeLifecycle(script: {
	start?: { started: boolean; alreadyRunning: boolean };
	stop?: { stopped: boolean };
	status?: DaemonStatus;
}): DaemonLifecycle & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async start() {
			calls.push("start");
			return script.start ?? { started: true, alreadyRunning: false };
		},
		async stop() {
			calls.push("stop");
			return script.stop ?? { stopped: true };
		},
		async status() {
			calls.push("status");
			return script.status ?? { running: true, pid: 4242, port: 3850 };
		},
	};
}

describe("PRD-021b b-AC-2 — daemon start|stop|status", () => {
	it("b-AC-2 `daemon start` brings the daemon up via the lifecycle seam", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle({ start: { started: true, alreadyRunning: false } });
		const res = await runDaemonCommand(["start"], {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lifecycle.calls).toContain("start");
		expect(lines.join("\n")).toMatch(/started on 127\.0\.0\.1:3850/);
	});

	it("`daemon start` reports a warming-up daemon (process up, /health not yet) instead of failing", async () => {
		const lines: string[] = [];
		// start() exhausts the readiness budget (started:false) but the process is up + holds the lock.
		const lifecycle = fakeLifecycle({
			start: { started: false, alreadyRunning: false },
			status: { running: true, pid: 4242, port: 3850 },
		});
		const res = await runDaemonCommand(["start"], {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0); // a daemon that is coming up is NOT a failure
		expect(lines.join("\n")).toMatch(/warming up/);
		expect(lines.join("\n")).not.toMatch(/failed to start/);
	});

	it("`daemon start` still reports failure when the process never comes up", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle({
			start: { started: false, alreadyRunning: false },
			status: { running: false, port: 3850 },
		});
		const res = await runDaemonCommand(["start"], {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/failed to start/);
	});

	it("b-AC-2 `daemon start` is idempotent when already running", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle({ start: { started: false, alreadyRunning: true } });
		const res = await runDaemonCommand(["start"], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/already running/);
	});

	it("b-AC-2 `daemon status` reports running on 3850 via the PID/lock + /health", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle({ status: { running: true, pid: 99, port: 3850 } });
		const res = await runDaemonCommand(["status"], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lifecycle.calls).toContain("status");
		expect(lines.join("\n")).toMatch(/running on 127\.0\.0\.1:3850 \(pid 99\)/);
	});

	it("b-AC-2 `daemon status` reports not-running when the lock is unheld", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle({ status: { running: false, port: 3850 } });
		const res = await runDaemonCommand(["status"], {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/not running/);
	});

	it("b-AC-2 `daemon stop` signals a graceful shutdown", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle({ stop: { stopped: true } });
		const res = await runDaemonCommand(["stop"], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lifecycle.calls).toContain("stop");
		expect(lines.join("\n")).toMatch(/stopped/);
	});
});

describe("PRD-021b b-AC-3 — ensure-running-on-demand", () => {
	it("b-AC-3 auto-starts a DOWN daemon and reports reachable", async () => {
		// The client is down on the first probe, then up after start() resolves.
		let pinged = 0;
		const daemon = {
			async send() {
				return { status: 200, body: {} };
			},
			async ping() {
				pinged += 1;
				// First probe (down) → triggers start; subsequent probes (after start) → up.
				return pinged > 1;
			},
		};
		const lifecycle = fakeLifecycle({ start: { started: true, alreadyRunning: false } });
		const reachable = await ensureDaemonRunning({ daemon, lifecycle });
		expect(reachable).toBe(true);
		expect(lifecycle.calls).toContain("start");
	});

	it("b-AC-3 is a no-op when the daemon is already up (no start call)", async () => {
		const lifecycle = fakeLifecycle({});
		const reachable = await ensureDaemonRunning({
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
		});
		expect(reachable).toBe(true);
		expect(lifecycle.calls).not.toContain("start");
	});

	it("b-AC-3 reports unreachable when the start attempt never binds", async () => {
		const lifecycle = fakeLifecycle({ start: { started: false, alreadyRunning: false } });
		const reachable = await ensureDaemonRunning({
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
		});
		expect(reachable).toBe(false);
	});
});
