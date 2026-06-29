/**
 * Supervisor watch-loop acceptance tests (PRD-064a AC-064a.1 .. AC-064a.5).
 *
 * Each test drives the REAL loop (probe -> classify -> heal -> incident -> persist)
 * over a real ephemeral node:http `/health` server + a deterministic fake clock, and
 * an injected RestartFn standing in for the OS-service restart (064b/064h).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { probeHealth } from "../src/health-probe.js";
import type { Logger } from "../src/logger.js";
import type { Rung } from "../src/remediation.js";
import { DEFAULT_STATE } from "../src/state.js";
import { installCrashNet } from "../src/supervisor.js";
import { buildHarness, createFakeClock, type Harness } from "./helpers/harness.js";
import { degradedBody, okBody, startMockHealthServer, type MockHealthServer } from "./helpers/health-server.js";

const probeFor = (url: string) => () => probeHealth({ healthUrl: url, timeoutMs: 1_000 });

describe("supervisor watch loop (PRD-064a)", () => {
	let harness: Harness | undefined;
	let server: MockHealthServer | undefined;

	afterEach(async () => {
		harness?.cleanup();
		harness = undefined;
		if (server) await server.close();
		server = undefined;
	});

	it("AC-064a.1: healthy -> no action + low-verbosity log", async () => {
		server = await startMockHealthServer(okBody);
		const debug = vi.fn();
		const info = vi.fn();
		const warn = vi.fn();
		const logger: Logger = { debug, info, warn, error: vi.fn() };
		const restart = vi.fn(async () => true);

		harness = buildHarness({ probe: probeFor(server.url), restart, logger });
		const classification = await harness.supervisor.tick();

		expect(classification.kind).toBe("ok");
		// No remediation was attempted on the happy path.
		expect(restart).not.toHaveBeenCalled();
		// Low-verbosity: the healthy tick logs at debug, not warn.
		expect(debug).toHaveBeenCalledWith("tick.healthy");
		expect(warn).not.toHaveBeenCalled();
		// No incident episode was opened.
		expect(harness.readIncidents()).toHaveLength(0);
	});

	it("AC-064a.2: unreachable -> restart -> next probe healthy -> backoff resets", async () => {
		// Start with the daemon DOWN (no server) so the first probe is unreachable.
		const restart = vi.fn(async () => true);
		// A swappable probe: down first, then healthy after the "restart".
		let up = false;
		const probe = async () =>
			up
				? { kind: "ok" as const }
				: { kind: "unreachable-refused" as const, detail: "ECONNREFUSED" };
		restart.mockImplementation(async () => {
			up = true; // the restart brings the daemon back
			return true;
		});

		harness = buildHarness({ probe, restart });

		// Tick 1: unreachable -> rung 1 restart kicked.
		const t1 = await harness.supervisor.tick();
		expect(t1.kind).toBe("unreachable-refused");
		expect(restart).toHaveBeenCalledTimes(1);
		// An incident episode recorded the restart step.
		const incidents = harness.readIncidents() as Array<{ steps: Array<{ action: string; outcome: string }> }>;
		expect(incidents).toHaveLength(1);
		expect(incidents[0]?.steps[0]).toMatchObject({ action: "restart-daemon", outcome: "succeeded" });

		// Tick 2: now healthy -> backoff + failure count reset, lastHealAt set.
		const t2 = await harness.supervisor.tick();
		expect(t2.kind).toBe("ok");
		const state = harness.readState();
		expect(state.lastKnownHealth).toBe("ok");
		expect(state.consecutiveRestartFailures).toBe(0);
		expect(state.backoffRung).toBe(0);
		expect(state.lastHealAt).not.toBeNull();
	});

	it("AC-064a.3: 3 consecutive failed restarts -> advances to rung 2", async () => {
		// The daemon is always unreachable and every restart FAILS, so the failure count climbs.
		const restart = vi.fn(async () => false);
		const probe = async () => ({ kind: "unreachable-refused" as const, detail: "ECONNREFUSED" });

		// Capture whether rung 2 (a later-wave slot) was requested.
		const rung2Requested: number[] = [];
		const observingRung2: Rung = {
			rung: 2,
			name: "reinstall-primary",
			run: async () => {
				rung2Requested.push(2);
				return { ok: false, skipped: true, action: "reinstall-primary", detail: "observed-by-test" };
			},
		};

		harness = buildHarness({ probe, restart, restartGiveUpThreshold: 3, extraRungs: [observingRung2] });

		// 3 failed restart ticks build the failure count up to the threshold.
		await harness.supervisor.tick(); // failures 0 -> 1
		await harness.supervisor.tick(); // failures 1 -> 2
		await harness.supervisor.tick(); // failures 2 -> 3
		expect(restart).toHaveBeenCalledTimes(3);
		expect(harness.readState().consecutiveRestartFailures).toBe(3);
		expect(rung2Requested).toHaveLength(0); // not yet advanced

		// 4th tick: failures >= threshold -> the ladder advances to rung 2 instead of restarting again.
		await harness.supervisor.tick();
		expect(rung2Requested).toEqual([2]);
		// rung 1 restart was NOT called a 4th time.
		expect(restart).toHaveBeenCalledTimes(3);
		// The advance is recorded in the incident for this tick.
		const incidents = harness.readIncidents() as Array<{ steps: Array<{ rung: number; action: string }> }>;
		const lastIncident = incidents[incidents.length - 1];
		expect(lastIncident?.steps[0]).toMatchObject({ rung: 2, action: "reinstall-primary" });
	});

	it("AC-064a.4: degraded with a specific subsystem reason -> classification routes to the matching rung (targeted)", async () => {
		server = await startMockHealthServer(() => degradedBody({ schema: "missing_table" }));

		// A rung that inspects the classification handed to it, proving the degraded subsystem
		// reason flows all the way through to the rung context (targeted remediation, not blind).
		const targetedReasons: Array<{ storage?: string; embeddings?: string; schema?: string }> = [];
		const targetingRung: Rung = {
			rung: 1, // replaces the default restart rung for this test's registry
			name: "targeted-schema-rung",
			run: async (rungCtx) => {
				if (rungCtx.classification.kind === "degraded") targetedReasons.push(rungCtx.classification.reasons);
				return { ok: true, action: "targeted-schema-rung" };
			},
		};

		harness = buildHarness({ probe: probeFor(server.url), restart: async () => true, rung1: targetingRung });

		const classification = await harness.supervisor.tick();
		expect(classification.kind).toBe("degraded");
		if (classification.kind === "degraded") expect(classification.reasons.schema).toBe("missing_table");

		// The rung that ran SAW the specific failing subsystem (targeted, not a blind restart).
		expect(targetedReasons).toHaveLength(1);
		expect(targetedReasons[0]?.schema).toBe("missing_table");

		// And the incident records the per-subsystem reason that drove targeting.
		const incidents = harness.readIncidents() as Array<{ healthKind: string; healthReasons?: Record<string, string> }>;
		expect(incidents[0]?.healthKind).toBe("degraded");
		expect(incidents[0]?.healthReasons?.schema).toBe("missing_table");
	});

	it("AC-064a.5: a remediation step that throws -> caught, recorded in incident, loop continues", async () => {
		const probe = async () => ({ kind: "unreachable-refused" as const, detail: "ECONNREFUSED" });
		// rung 1 restart THROWS.
		const restart = vi.fn(async () => {
			throw new Error("spawn EACCES");
		});

		harness = buildHarness({ probe, restart });

		// The tick must NOT throw - the ladder catches the rung's throw.
		const t1 = await harness.supervisor.tick();
		expect(t1.kind).toBe("unreachable-refused");
		// The throw was recorded as a failed step with the error detail.
		const incidents = harness.readIncidents() as Array<{ steps: Array<{ action: string; outcome: string; detail?: string }> }>;
		expect(incidents[0]?.steps[0]).toMatchObject({ outcome: "failed" });
		expect(incidents[0]?.steps[0]?.detail).toContain("EACCES");

		// The loop continues: a second tick still runs (proving the watchdog survived).
		const t2 = await harness.supervisor.tick();
		expect(t2.kind).toBe("unreachable-refused");
		expect(restart).toHaveBeenCalledTimes(2);
	});
});

describe("supervisor startup grace (PRD-067)", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	function recordingLogger(): Logger & {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
	} {
		return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	}

	it("AC-1: refused health probe inside startup grace logs booting and does not run the ladder", async () => {
		const logger = recordingLogger();
		const restart = vi.fn(async () => true);
		harness = buildHarness({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			restart,
			logger,
			startupGraceMs: 60_000,
		});

		const classification = await harness.supervisor.tick();

		expect(classification.kind).toBe("unreachable-refused");
		expect(restart).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith("tick.booting", { kind: "unreachable-refused", remainingMs: 60_000 });
		expect(logger.warn).not.toHaveBeenCalledWith("tick.unhealthy", expect.anything());
		expect(harness.readIncidents()).toHaveLength(0);
		expect(harness.readState().consecutiveRestartFailures).toBe(0);
	});

	it("AC-2: timeout inside startup grace writes no incident and leaves counters unchanged", async () => {
		const restart = vi.fn(async () => true);
		harness = buildHarness({
			probe: async () => ({ kind: "unreachable-timeout" }),
			restart,
			startupGraceMs: 60_000,
		});

		await harness.supervisor.tick();

		expect(restart).not.toHaveBeenCalled();
		expect(harness.readIncidents()).toHaveLength(0);
		expect(harness.readState()).toMatchObject({ consecutiveRestartFailures: 0, backoffRung: 0 });
	});

	it("AC-3: degraded inside startup grace does not remediate or escalate", async () => {
		const restart = vi.fn(async () => true);
		const logger = recordingLogger();
		harness = buildHarness({
			probe: async () => ({ kind: "degraded", reasons: { schema: "migrating" } }),
			restart,
			logger,
			startupGraceMs: 60_000,
		});

		await harness.supervisor.tick();

		expect(restart).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalledWith("tick.unhealthy", expect.anything());
		expect(harness.readIncidents()).toHaveLength(0);
	});

	it("AC-4: after startup grace expires, the existing unhealthy remediation path runs", async () => {
		const clock = createFakeClock();
		const restart = vi.fn(async () => true);
		harness = buildHarness({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			restart,
			clock,
			startupGraceMs: 60_000,
		});

		clock.advance(60_000);
		await harness.supervisor.tick();

		expect(restart).toHaveBeenCalledTimes(1);
		const incidents = harness.readIncidents() as Array<{ steps: Array<{ action: string; outcome: string }> }>;
		expect(incidents).toHaveLength(1);
		expect(incidents[0]?.steps[0]).toMatchObject({ action: "restart-daemon", outcome: "succeeded" });
	});

	it("AC-5: a successful restart opens a post-restart grace and prevents a second immediate restart", async () => {
		const clock = createFakeClock();
		const restart = vi.fn(async () => true);
		harness = buildHarness({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			restart,
			clock,
			startupGraceMs: 60_000,
		});

		clock.advance(60_000);
		await harness.supervisor.tick();
		expect(restart).toHaveBeenCalledTimes(1);

		await harness.supervisor.tick();

		expect(restart).toHaveBeenCalledTimes(1);
		expect(harness.readIncidents()).toHaveLength(1);
	});

	it("AC-6: a failed restart does not open post-restart grace", async () => {
		const clock = createFakeClock();
		const restart = vi.fn(async () => false);
		harness = buildHarness({
			probe: async () => ({ kind: "unreachable-refused", detail: "ECONNREFUSED" }),
			restart,
			clock,
			cooldownMs: 0,
			startupGraceMs: 60_000,
		});

		clock.advance(60_000);
		await harness.supervisor.tick();
		await harness.supervisor.tick();

		expect(restart).toHaveBeenCalledTimes(2);
		expect(harness.readIncidents()).toHaveLength(2);
		expect(harness.readState().consecutiveRestartFailures).toBe(2);
	});

	it("AC-8: ok during startup grace records healthy state and resets stale backoff", async () => {
		harness = buildHarness({
			probe: async () => ({ kind: "ok" }),
			restart: async () => true,
			startupGraceMs: 60_000,
		});
		writeFileSync(
			join(harness.workspaceDir, "state.json"),
			`${JSON.stringify({ ...DEFAULT_STATE, lastKnownHealth: "unreachable", consecutiveRestartFailures: 2, backoffRung: 2 }, null, 2)}\n`,
			"utf8",
		);

		await harness.supervisor.tick();

		expect(harness.readState()).toMatchObject({
			lastKnownHealth: "ok",
			consecutiveRestartFailures: 0,
			backoffRung: 0,
			currentRung: 1,
		});
	});

	it("AC-10: a daemon that needs 30 seconds to boot is not restarted before it becomes healthy", async () => {
		const clock = createFakeClock();
		const restart = vi.fn(async () => true);
		harness = buildHarness({
			probe: async () =>
				clock.now() < 30_000 ? { kind: "unreachable-refused", detail: "ECONNREFUSED" } : { kind: "ok" },
			restart,
			clock,
			startupGraceMs: 60_000,
		});

		const first = await harness.supervisor.tick();
		clock.advance(30_000);
		const second = await harness.supervisor.tick();

		expect(first.kind).toBe("unreachable-refused");
		expect(second.kind).toBe("ok");
		expect(restart).not.toHaveBeenCalled();
		expect(harness.readIncidents()).toHaveLength(0);
		expect(harness.readState().lastKnownHealth).toBe("ok");
	});
});

describe("crash net (design principle 1 / parent AC-8)", () => {
	it("installs + uninstalls uncaughtException / unhandledRejection handlers", () => {
		const before = process.listenerCount("uncaughtException");
		const uninstall = installCrashNet({ debug() {}, info() {}, warn() {}, error() {} });
		expect(process.listenerCount("uncaughtException")).toBe(before + 1);
		uninstall();
		expect(process.listenerCount("uncaughtException")).toBe(before);
	});

	it("logs an uncaught exception without rethrowing (keeps the loop alive)", () => {
		const error = vi.fn();
		const uninstall = installCrashNet({ debug() {}, info() {}, warn() {}, error });
		// Emit a synthetic uncaughtException; our handler must log and not rethrow.
		process.emit("uncaughtException", new Error("boom") as never);
		expect(error).toHaveBeenCalledWith("crashnet.uncaught_exception", expect.objectContaining({ reason: "boom" }));
		uninstall();
	});
});

describe("error-stream routing (PRD-064d AC-064d.1)", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("a probe that throws routes to the onError seam (error stream) AND the loop continues", async () => {
		const onError = vi.fn();
		// A probe that throws drives the tick's probe catch (the heal path classifies it as
		// unreachable-refused with detail "probe-threw" and continues).
		const probe = async (): Promise<never> => {
			throw new Error("getaddrinfo ENOTFOUND");
		};
		harness = buildHarness({ probe, restart: async () => true, onError });

		const classification = await harness.supervisor.tick();
		// The loop survived and produced a usable classification (never threw).
		expect(classification.kind).toBe("unreachable-refused");
		// The caught error was routed to the error stream with a stable class label + the reason.
		expect(onError).toHaveBeenCalledWith("ProbeThrew", "getaddrinfo ENOTFOUND");
	});

	it("a throwing onError seam can never destabilize the tick (fail-soft)", async () => {
		const onError = vi.fn(() => {
			throw new Error("telemetry seam blew up");
		});
		const probe = async (): Promise<never> => {
			throw new Error("ECONNREFUSED");
		};
		harness = buildHarness({ probe, restart: async () => true, onError });

		// Even though the seam throws, the tick resolves normally (the seam call is guarded).
		const classification = await harness.supervisor.tick();
		expect(classification.kind).toBe("unreachable-refused");
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("no onError seam is a no-op (the loop behaves identically)", async () => {
		const probe = async (): Promise<never> => {
			throw new Error("boom");
		};
		harness = buildHarness({ probe, restart: async () => true });
		const classification = await harness.supervisor.tick();
		expect(classification.kind).toBe("unreachable-refused");
	});

	it("installCrashNet routes a caught crash to the onError seam too", () => {
		const onError = vi.fn();
		const uninstall = installCrashNet({ debug() {}, info() {}, warn() {}, error() {} }, onError);
		process.emit("uncaughtException", new Error("kaboom") as never);
		expect(onError).toHaveBeenCalledWith("uncaughtException", "kaboom");
		uninstall();
	});
});
