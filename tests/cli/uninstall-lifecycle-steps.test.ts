/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-003b b-AC-2 / b-AC-4 / AC-8 — the REAL fleet-lifecycle uninstall steps.
 *
 *   - `removeStateDir` deletes ONLY honeycomb's resolved state dir under the fleet root; a sibling
 *     product dir and the registry file survive (b-AC-4 / AC-8: nothing else).
 *   - `deleteRegistryEntry` removes ONLY honeycomb's registry entry, leaving other entries intact.
 *   - the per-manager `unregisterLegacy` runs the right fixed-argv to strip the pre-#32 legacy unit
 *     (b-AC-2: current + best-effort legacy label), asserted with a recording runner (no real
 *     launchctl / systemctl / schtasks).
 *
 * The state-dir + registry steps run under an injected `APIARY_HOME` temp fleet root so no real
 * `~/.apiary` is touched. `unregisterService` (which reads the host's real service manager) is NOT
 * exercised here — its argv is proven via the controller below.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDaemonServiceController,
	type DaemonServiceController,
	LEGACY_SERVICE_LABEL,
	LEGACY_SERVICE_SYSTEMD_UNIT,
	LEGACY_SERVICE_TASK_NAME,
	type ServiceRunner,
	type ServiceSpec,
} from "../../src/cli/daemon-service.js";
import { buildUninstallLifecycleSteps } from "../../src/cli/runtime.js";
import type { DaemonLifecycle, DaemonStatus } from "../../src/commands/index.js";
import { fleetRegistryPath } from "../../src/daemon/runtime/telemetry/fleet-registry.js";
import { honeycombStateDir } from "../../src/shared/fleet-root.js";

function fakeLifecycle(): DaemonLifecycle {
	return {
		async start() {
			return { started: false, alreadyRunning: true };
		},
		async stop() {
			return { stopped: true };
		},
		async status(): Promise<DaemonStatus> {
			return { running: false, port: 3850 };
		},
	};
}

describe("PRD-003b fail-closed explicit service removal", () => {
	it("removes an inspected service even when daemon launch preference is spawn", () => {
		const previous = process.env.HONEYCOMB_DAEMON_SERVICE;
		process.env.HONEYCOMB_DAEMON_SERVICE = "spawn";
		const calls: string[] = [];
		const controller: DaemonServiceController = {
			manager: "schtasks",
			register: () => ({ ok: true, manager: "schtasks" }),
			unregister: () => {
				calls.push("unregister");
				return { ok: true, manager: "schtasks" };
			},
			restart: () => ({ ok: true, manager: "schtasks" }),
			stop: () => ({ ok: true, manager: "schtasks" }),
			isRegistered: () => {
				calls.push("inspect");
				return true;
			},
		};
		try {
			const steps = buildUninstallLifecycleSteps(fakeLifecycle(), {
				manager: "schtasks",
				controllerFor: () => controller,
			});
			expect(steps.unregisterService()).toEqual({ removed: true, manager: "schtasks" });
			expect(calls).toEqual(["inspect", "unregister"]);
		} finally {
			if (previous === undefined) delete process.env.HONEYCOMB_DAEMON_SERVICE;
			else process.env.HONEYCOMB_DAEMON_SERVICE = previous;
		}
	});

	it("throws when explicit service inspection is unavailable", () => {
		const steps = buildUninstallLifecycleSteps(fakeLifecycle(), { manager: null });
		expect(() => steps.unregisterService()).toThrow(/service manager/);
	});
});

let fleetRoot: string;
let prevApiaryHome: string | undefined;

beforeEach(() => {
	fleetRoot = mkdtempSync(join(tmpdir(), "hc-uninstall-root-"));
	prevApiaryHome = process.env.APIARY_HOME;
	// Pin the fleet root so honeycombStateDir()/fleetRegistryPath() resolve under the temp dir.
	process.env.APIARY_HOME = fleetRoot;
});
afterEach(() => {
	if (prevApiaryHome === undefined) delete process.env.APIARY_HOME;
	else process.env.APIARY_HOME = prevApiaryHome;
	rmSync(fleetRoot, { recursive: true, force: true });
});

describe("PRD-003b b-AC-4 / AC-8 — removeStateDir deletes ONLY honeycomb's state dir", () => {
	it("b-AC-4 removes the resolved honeycomb dir and leaves a sibling product dir + the registry intact", () => {
		const hcDir = honeycombStateDir();
		mkdirSync(hcDir, { recursive: true });
		writeFileSync(join(hcDir, "daemon.pid"), "123");
		// A sibling product's dir + the fleet registry file must survive.
		const nectarDir = join(fleetRoot, "nectar");
		mkdirSync(nectarDir, { recursive: true });
		writeFileSync(join(nectarDir, "state"), "keep");
		writeFileSync(fleetRegistryPath(), JSON.stringify({ daemons: [{ name: "nectar" }] }));

		const steps = buildUninstallLifecycleSteps(fakeLifecycle());
		const r = steps.removeStateDir();
		expect(r.removed).toBe(true);
		expect(r.dir).toBe(hcDir);
		expect(existsSync(hcDir)).toBe(false);
		// Nothing else was touched.
		expect(existsSync(join(nectarDir, "state"))).toBe(true);
		expect(existsSync(fleetRegistryPath())).toBe(true);
	});

	it("b-AC-6 removeStateDir on an absent dir is a friendly no-op (removed:false, never a throw)", () => {
		const steps = buildUninstallLifecycleSteps(fakeLifecycle());
		const r = steps.removeStateDir();
		expect(r.removed).toBe(false);
		expect(existsSync(honeycombStateDir())).toBe(false);
	});

	it("AC-8 a SYMLINKED state dir has only the link removed — the link target is never followed out of the root", () => {
		// Windows junctions are NOT reported as symlinks by lstat and have their own removal semantics,
		// so this POSIX symlink guarantee is asserted on POSIX only (the resolved-absolute-path guard in
		// the first test already proves "nothing else" on every platform).
		if (process.platform === "win32") return;
		// A target OUTSIDE the fleet root, with a file that must survive.
		const outside = mkdtempSync(join(tmpdir(), "hc-outside-"));
		const keep = join(outside, "precious.txt");
		writeFileSync(keep, "do not delete");
		const hcDir = honeycombStateDir();
		mkdirSync(join(fleetRoot), { recursive: true });
		try {
			symlinkSync(outside, hcDir, "junction");
		} catch {
			// Some CI environments forbid symlink creation; skip the assertion body cleanly.
			rmSync(outside, { recursive: true, force: true });
			return;
		}
		const steps = buildUninstallLifecycleSteps(fakeLifecycle());
		const r = steps.removeStateDir();
		expect(r.removed).toBe(true);
		// The link is gone, but the target's file OUTSIDE the root is untouched (never followed).
		expect(existsSync(hcDir)).toBe(false);
		expect(existsSync(keep)).toBe(true);
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("PRD-003b b-AC-3/b-AC-4 — deleteRegistryEntry removes only honeycomb", () => {
	it("removes the honeycomb entry and preserves the sibling entry", () => {
		mkdirSync(fleetRoot, { recursive: true });
		writeFileSync(fleetRegistryPath(), JSON.stringify({ daemons: [{ name: "honeycomb" }, { name: "hive" }] }, null, 2));
		const steps = buildUninstallLifecycleSteps(fakeLifecycle());
		const r = steps.deleteRegistryEntry();
		expect(r.removed).toBe(true);
		const daemons = (JSON.parse(readFileSync(fleetRegistryPath(), "utf8")) as { daemons: Array<{ name: string }> })
			.daemons;
		expect(daemons.map((d) => d.name)).toEqual(["hive"]);
	});

	it("is a friendly no-op when there is no registry (removed:false)", () => {
		const steps = buildUninstallLifecycleSteps(fakeLifecycle());
		expect(steps.deleteRegistryEntry().removed).toBe(false);
	});
});

/** A recording runner (no real launchctl/systemctl/schtasks). */
function recordingRunner(): ServiceRunner & {
	runs: Array<{ cmd: string; args: readonly string[] }>;
	removes: string[];
} {
	const runs: Array<{ cmd: string; args: readonly string[] }> = [];
	const removes: string[] = [];
	return {
		runs,
		removes,
		run(cmd, args) {
			runs.push({ cmd, args });
			return "";
		},
		writeFile() {},
		removeFile(path) {
			removes.push(path);
		},
		fileExists() {
			return true;
		},
	};
}

const SPEC: ServiceSpec = {
	nodePath: "/usr/local/bin/node",
	entry: "/opt/honeycomb/daemon/index.js",
	nodeFlags: ["--experimental-sqlite"],
	workspace: "/home/ada/.apiary/honeycomb",
	home: "/home/ada",
};

describe("PRD-003b b-AC-2 — unregisterLegacy strips the pre-#32 legacy unit per manager", () => {
	it("launchd unregisterLegacy boots out + removes the legacy LaunchAgent", () => {
		const runner = recordingRunner();
		createDaemonServiceController("launchd", runner).unregisterLegacy?.(SPEC);
		expect(runner.runs[0]?.cmd).toBe("launchctl");
		expect(runner.runs[0]?.args).toEqual(["bootout", expect.stringContaining(LEGACY_SERVICE_LABEL)]);
		expect(runner.removes.some((p) => p.includes(LEGACY_SERVICE_LABEL))).toBe(true);
	});

	it("systemd unregisterLegacy disables + removes the legacy user unit", () => {
		const runner = recordingRunner();
		createDaemonServiceController("systemd-user", runner).unregisterLegacy?.(SPEC);
		expect(runner.runs[0]?.args).toEqual(["--user", "disable", "--now", LEGACY_SERVICE_SYSTEMD_UNIT]);
	});

	it("schtasks unregisterLegacy ends + deletes the legacy task", () => {
		const runner = recordingRunner();
		createDaemonServiceController("schtasks", runner).unregisterLegacy?.(SPEC);
		const argvs = runner.runs.map((r) => r.args.join(" "));
		expect(argvs).toContain(`/End /TN ${LEGACY_SERVICE_TASK_NAME}`);
		expect(argvs).toContain(`/Delete /TN ${LEGACY_SERVICE_TASK_NAME} /F`);
	});
});
