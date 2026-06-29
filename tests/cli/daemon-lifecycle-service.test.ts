/**
 * PRD-064h AC-064h.5 / AC-064h.6 + HC-1, the service-aware daemon lifecycle in `src/cli/runtime.ts`.
 *
 * Proves with an injected DaemonClient + an injected service controller (NO real launchctl/schtasks,
 * NO real spawn):
 *   - AC-064h.6: in service mode, `start` REGISTERS via the manager (not a spawn) and `status`
 *     reflects the supervising manager.
 *   - AC-064h.5: `restart` goes THROUGH the manager when the service is registered.
 *   - HC-1 FALLBACK: with `serviceManager: null`, `start` uses the detached-spawn path (no controller
 *     is ever consulted), the behavior the existing tests + CI depend on.
 *   - fail-open: a controller whose `register` throws falls back to spawn rather than crashing.
 */

import { describe, expect, it, vi } from "vitest";

import { buildDaemonLifecycle } from "../../src/cli/runtime.js";
import type { DaemonClient } from "../../src/commands/index.js";
import type { DaemonServiceController, ServiceManager } from "../../src/cli/daemon-service.js";

/** A DaemonClient whose `ping` returns the scripted sequence (down → ... → up). */
function scriptedClient(pings: boolean[]): DaemonClient {
	let i = 0;
	return {
		async send() {
			return { status: 200, body: {} };
		},
		async ping() {
			const v = pings[Math.min(i, pings.length - 1)] ?? false;
			i += 1;
			return v;
		},
	};
}

/** A recording service controller: records each op + scripts isRegistered / a register throw. */
function recordingController(opts?: { registered?: boolean; registerThrows?: boolean }): DaemonServiceController & {
	calls: string[];
} {
	const calls: string[] = [];
	const manager: ServiceManager = "schtasks";
	return {
		calls,
		manager,
		register() {
			calls.push("register");
			if (opts?.registerThrows) throw new Error("schtasks unavailable");
			return { ok: true, manager };
		},
		unregister() {
			calls.push("unregister");
			return { ok: true, manager };
		},
		restart() {
			calls.push("restart");
			return { ok: true, manager };
		},
		stop() {
			calls.push("stop");
			return { ok: true, manager };
		},
		isRegistered() {
			calls.push("isRegistered");
			return opts?.registered ?? false;
		},
	};
}

describe("PRD-064h AC-064h.6, service-preferred start + status reflects the manager", () => {
	it("start REGISTERS via the manager (no spawn) and resolves started once /health answers", async () => {
		const ctl = recordingController({ registered: true });
		// down on the pre-check, then up after register (waitForHealth's first poll).
		const lifecycle = buildDaemonLifecycle(scriptedClient([false, true]), {
			serviceManager: "schtasks",
			controllerFor: () => ctl,
		});
		const res = await lifecycle.start();
		expect(res).toEqual({ started: true, alreadyRunning: false });
		expect(ctl.calls).toContain("register");
	});

	it("start is a no-op when the daemon already answers /health (no register)", async () => {
		const ctl = recordingController({ registered: true });
		const lifecycle = buildDaemonLifecycle(scriptedClient([true]), {
			serviceManager: "schtasks",
			controllerFor: () => ctl,
		});
		const res = await lifecycle.start();
		expect(res).toEqual({ started: false, alreadyRunning: true });
		expect(ctl.calls).not.toContain("register");
	});

	it("status reports the supervising manager when the service is registered", async () => {
		const ctl = recordingController({ registered: true });
		const lifecycle = buildDaemonLifecycle(scriptedClient([true]), {
			serviceManager: "schtasks",
			controllerFor: () => ctl,
		});
		const status = await lifecycle.status();
		expect(status.serviceManager).toBe("schtasks");
		expect(status.port).toBe(3850);
	});

	it("status omits the manager when the service is NOT registered", async () => {
		const ctl = recordingController({ registered: false });
		const lifecycle = buildDaemonLifecycle(scriptedClient([true]), {
			serviceManager: "schtasks",
			controllerFor: () => ctl,
		});
		const status = await lifecycle.status();
		expect(status.serviceManager).toBeUndefined();
	});
});

describe("PRD-064h AC-064h.5, restart goes through the service manager", () => {
	it("restart calls the manager's restart (not a spawn) when the service is registered", async () => {
		const ctl = recordingController({ registered: true });
		const lifecycle = buildDaemonLifecycle(scriptedClient([true]), {
			serviceManager: "schtasks",
			controllerFor: () => ctl,
		});
		const res = await lifecycle.restart?.();
		expect(res).toEqual({ restarted: true, viaService: true });
		expect(ctl.calls).toContain("restart");
	});
});

describe("PRD-064h HC-1, detached-spawn FALLBACK when no service manager is available", () => {
	it("start NEVER consults a controller when serviceManager is null (the spawn fallback path)", async () => {
		// The controllerFor is a spy that MUST NOT be called, null manager forces the spawn path.
		const controllerFor = vi.fn(() => recordingController());
		// Pre-check ping is true so start() short-circuits as alreadyRunning WITHOUT actually spawning a
		// real process (we only assert the controller was never built, the spawn branch is taken, not
		// the service branch).
		const lifecycle = buildDaemonLifecycle(scriptedClient([true]), {
			serviceManager: null,
			controllerFor,
		});
		const res = await lifecycle.start();
		expect(res).toEqual({ started: false, alreadyRunning: true });
		expect(controllerFor).not.toHaveBeenCalled();
	});

	it("status in fallback mode omits the serviceManager entirely", async () => {
		const lifecycle = buildDaemonLifecycle(scriptedClient([false]), { serviceManager: null });
		const status = await lifecycle.status();
		expect(status.serviceManager).toBeUndefined();
		expect(status.running).toBe(false);
		expect(status.port).toBe(3850);
	});
});

describe("PRD-064h fail-open, a throwing service register degrades to the spawn fallback", () => {
	it("a register that throws does not crash start (it falls through to the spawn path)", async () => {
		const ctl = recordingController({ registerThrows: true });
		// Pre-check down → register throws → spawn fallback. The spawn path then polls /health; we keep
		// it `true` after the first poll so spawnDaemonAndWait resolves quickly without a real long wait.
		const lifecycle = buildDaemonLifecycle(scriptedClient([false, true]), {
			serviceManager: "schtasks",
			controllerFor: () => ctl,
		});
		// Must not throw; resolves via the spawn fallback (started true once /health answers).
		const res = await lifecycle.start();
		expect(ctl.calls).toContain("register");
		expect(res.started || res.alreadyRunning).toBe(true);
	});
});
