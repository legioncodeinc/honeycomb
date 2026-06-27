/**
 * Supervisor watch-loop acceptance tests (PRD-063a AC-063a.1 .. AC-063a.5).
 *
 * Each test drives the REAL loop (probe -> classify -> heal -> incident -> persist)
 * over a real ephemeral node:http `/health` server + a deterministic fake clock, and
 * an injected RestartFn standing in for the OS-service restart (063b/063h).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { probeHealth } from "../src/health-probe.js";
import type { Logger } from "../src/logger.js";
import type { Rung } from "../src/remediation.js";
import { installCrashNet } from "../src/supervisor.js";
import { buildHarness, type Harness } from "./helpers/harness.js";
import { degradedBody, okBody, startMockHealthServer, type MockHealthServer } from "./helpers/health-server.js";

const probeFor = (url: string) => () => probeHealth({ healthUrl: url, timeoutMs: 1_000 });

describe("supervisor watch loop (PRD-063a)", () => {
	let harness: Harness | undefined;
	let server: MockHealthServer | undefined;

	afterEach(async () => {
		harness?.cleanup();
		harness = undefined;
		if (server) await server.close();
		server = undefined;
	});

	it("AC-063a.1: healthy -> no action + low-verbosity log", async () => {
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

	it("AC-063a.2: unreachable -> restart -> next probe healthy -> backoff resets", async () => {
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

	it("AC-063a.3: 3 consecutive failed restarts -> advances to rung 2", async () => {
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

	it("AC-063a.4: degraded with a specific subsystem reason -> classification routes to the matching rung (targeted)", async () => {
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

	it("AC-063a.5: a remediation step that throws -> caught, recorded in incident, loop continues", async () => {
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
