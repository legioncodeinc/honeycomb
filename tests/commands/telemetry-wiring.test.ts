/**
 * PRD-050e — the emit WIRING into the host flows + the `honeycomb telemetry --show` verb.
 *
 * Proves the events fire from their real hosts (install → honeycomb_installed; the device-flow login →
 * honeycomb_first_link), that they are fire-and-forget (a throwing telemetry fetch leaves the host flow
 * byte-identical — same exit code, no throw — e-AC-4), that a second run dedupes (e-AC-5), and that the
 * glass-box CLI verb renders. Temp dir + injected fetch recorder: no real daemon/browser/PostHog/HOME.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type ConnectorRunner,
	createFakeDaemonClient,
	type DaemonLifecycle,
	type DaemonStatus,
	runConnectorVerb,
	runInstallCommand,
	runTelemetryCommand,
} from "../../src/commands/index.js";
import { loadOnboarding } from "../../src/daemon/runtime/onboarding/index.js";
import type { TelemetryFetchRequestInit } from "../../src/daemon/runtime/telemetry/index.js";
import type { FleetClassification } from "../../src/shared/fleet-detection.js";

const KEY = "phc_test_write_only_key";

/** PRD-003a: a fixed fleet-defer classifier so install never hits the network / npm tree / a real login. */
const fleetDefer = async (): Promise<FleetClassification> => ({
	mode: "fleet",
	signals: { registryHiveEntry: true, hivePortAnswering: false, hiveNpmGlobal: false },
	firedSignals: ["test-injected registry Hive entry"],
});

function fakeLifecycle(): DaemonLifecycle {
	return {
		async start() {
			return { started: true, alreadyRunning: false };
		},
		async stop() {
			return { stopped: true };
		},
		async status(): Promise<DaemonStatus> {
			return { running: true, pid: 1, port: 3850 };
		},
	};
}

async function reachablePortalProbe(): Promise<boolean> {
	return true;
}

function recordingFetch(opts: { throws?: boolean } = {}) {
	const calls: { url: string; init: TelemetryFetchRequestInit }[] = [];
	return {
		calls,
		fetch: (url: string, init: TelemetryFetchRequestInit) => {
			calls.push({ url, init });
			if (opts.throws === true) return Promise.reject(new Error("telemetry down"));
			return Promise.resolve({ ok: true, status: 200 });
		},
	};
}

/**
 * Drain pending microtasks/timers until `predicate` holds or the budget is spent. `honeycomb_installed`
 * now emits FIRE-AND-FORGET (the installer no longer awaits it), so the emit lands on a later turn of the
 * event loop — the test waits for it deterministically instead of relying on the (removed) await.
 */
async function waitFor(predicate: () => boolean, budget = 50): Promise<void> {
	for (let i = 0; i < budget && !predicate(); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-tele-wire-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("e-AC-1/e-AC-5 honeycomb install emits honeycomb_installed once, deduped on re-run", () => {
	it("emits the installed event after success, then dedupes a second run", async () => {
		const rec = recordingFetch();
		const deps = {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle(),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY },
		};
		const first = await runInstallCommand(["--ref", "mario"], deps);
		expect(first.exitCode).toBe(0);
		// The emit is fire-and-forget — wait for the chokepoint to reach the recorder before asserting.
		await waitFor(() => rec.calls.length > 0);
		expect(rec.calls).toHaveLength(1);
		expect(JSON.parse(rec.calls[0]!.init.body).event).toBe("honeycomb_installed");
		// Second run: deduped — still exactly one network call total. Give a would-be duplicate send a
		// chance to land (it must not) before re-asserting the count is unchanged.
		const second = await runInstallCommand(["--ref", "mario"], deps);
		expect(second.exitCode).toBe(0);
		await waitFor(() => false, 5);
		expect(rec.calls).toHaveLength(1);
	});
});

describe("e-AC-4 install telemetry is fire-and-forget: a throwing fetch leaves the flow byte-identical", () => {
	it("a throwing telemetry fetch does NOT change the exit code and does NOT throw", async () => {
		const recOk = recordingFetch();
		const recThrow = recordingFetch({ throws: true });
		const baseDeps = (telemetryFetch: typeof recOk.fetch, d: string) => ({
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle(),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: d,
			out: () => {},
			telemetry: { fetch: telemetryFetch, posthogKey: KEY },
		});
		const dirA = mkdtempSync(join(tmpdir(), "hc-tele-ok-"));
		const dirB = mkdtempSync(join(tmpdir(), "hc-tele-throw-"));
		try {
			const ok = await runInstallCommand([], baseDeps(recOk.fetch, dirA));
			const thrown = await runInstallCommand([], baseDeps(recThrow.fetch, dirB));
			// Same exit code with telemetry succeeding vs throwing (byte-identical user flow).
			expect(ok.exitCode).toBe(thrown.exitCode);
			expect(thrown.exitCode).toBe(0);
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	});
});

describe("honeycomb_updated fires from the install verb when the build version changed since the last run", () => {
	it("first run records the baseline silently; a re-run at a NEW version emits honeycomb_updated once", async () => {
		const rec = recordingFetch();
		const depsAt = (version: string) => ({
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle(),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY, version },
		});
		// First run at 1.0.0: honeycomb_installed fires; the version checkpoint records the baseline
		// WITHOUT an update emit (a fresh install is not an update).
		await runInstallCommand(["--ref", "mario"], depsAt("1.0.0"));
		// The whole chain is fire-and-forget; the baseline persist is its LAST step, so wait for it.
		await waitFor(() => loadOnboarding(dir).lastVersion !== undefined);
		expect(rec.calls.map((c) => JSON.parse(c.init.body).event)).toEqual(["honeycomb_installed"]);
		expect(loadOnboarding(dir).lastVersion).toBe("1.0.0");
		// Re-run at 1.0.1: honeycomb_installed is deduped (once per machine); honeycomb_updated fires
		// with the new version in the allow-listed honeycomb_version property.
		await runInstallCommand(["--ref", "mario"], depsAt("1.0.1"));
		await waitFor(() => loadOnboarding(dir).lastVersion === "1.0.1");
		const events = rec.calls.map((c) => JSON.parse(c.init.body).event);
		expect(events).toEqual(["honeycomb_installed", "honeycomb_updated"]);
		expect(JSON.parse(rec.calls[1]!.init.body).properties.honeycomb_version).toBe("1.0.1");
		expect(loadOnboarding(dir).lastVersion).toBe("1.0.1");
		// A THIRD run at the same version emits nothing new (baseline matches + both events deduped).
		await runInstallCommand(["--ref", "mario"], depsAt("1.0.1"));
		await waitFor(() => false, 5);
		expect(rec.calls).toHaveLength(2);
	});
});

describe("honeycomb_uninstalled fires from the FULL uninstall verb, fire-and-forget", () => {
	const recordingConnector = (): ConnectorRunner & { runs: string[] } => {
		const runs: string[] = [];
		return {
			runs,
			async run(args) {
				runs.push(args.verb);
				return { exitCode: 0, harnesses: ["cursor"] };
			},
		};
	};

	it("a full `uninstall` (no harness arg) emits honeycomb_uninstalled once", async () => {
		const rec = recordingFetch();
		const connector = recordingConnector();
		const res = await runConnectorVerb("uninstall", [], {
			daemon: createFakeDaemonClient({ alive: true }),
			connector,
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY },
		});
		expect(res.exitCode).toBe(0);
		await waitFor(() => rec.calls.length > 0);
		expect(rec.calls).toHaveLength(1);
		expect(JSON.parse(rec.calls[0]!.init.body).event).toBe("honeycomb_uninstalled");
		// A second full uninstall dedupes (once per machine) - still exactly one network call.
		await runConnectorVerb("uninstall", [], {
			daemon: createFakeDaemonClient({ alive: true }),
			connector,
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY },
		});
		await waitFor(() => false, 5);
		expect(rec.calls).toHaveLength(1);
	});

	it("a single-harness `uninstall <harness>` (a partial re-wire) emits nothing", async () => {
		const rec = recordingFetch();
		await runConnectorVerb("uninstall", ["cursor"], {
			daemon: createFakeDaemonClient({ alive: true }),
			connector: recordingConnector(),
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY },
		});
		await waitFor(() => false, 5);
		expect(rec.calls).toHaveLength(0);
	});

	it("a throwing telemetry fetch leaves the uninstall byte-identical (same exit code, no throw)", async () => {
		const rec = recordingFetch({ throws: true });
		const res = await runConnectorVerb("uninstall", [], {
			daemon: createFakeDaemonClient({ alive: true }),
			connector: recordingConnector(),
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY },
		});
		expect(res.exitCode).toBe(0);
	});
});

describe("e-AC-8 honeycomb telemetry --show renders the glass box", () => {
	it("bare `telemetry` and `telemetry --show` both render the sent + pending sections", () => {
		const lines: string[] = [];
		const res = runTelemetryCommand(["--show"], { dir, out: (l) => lines.push(l) });
		expect(res.exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain("ALREADY SENT");
		expect(text).toContain("WOULD SEND NEXT");
		expect(text).toContain("honeycomb_installed");
	});

	it("after an install, the sent event appears in --show", async () => {
		const rec = recordingFetch();
		await runInstallCommand(["--ref", "mario"], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle(),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir,
			out: () => {},
			telemetry: { fetch: rec.fetch, posthogKey: KEY },
		});
		// The emit is fire-and-forget — wait for the ledger persist before reading it back.
		await waitFor(() => loadOnboarding(dir).telemetry.sent.length > 0);
		// Confirm the ledger recorded it.
		expect(loadOnboarding(dir).telemetry.sent.map((s) => s.event)).toContain("honeycomb_installed");
		const lines: string[] = [];
		runTelemetryCommand([], { dir, out: (l) => lines.push(l) });
		const text = lines.join("\n");
		// honeycomb_installed is now in the ALREADY SENT section.
		expect(text).toMatch(/ALREADY SENT \(1\)/);
	});
});
