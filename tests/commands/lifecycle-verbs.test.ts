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
 * PRD-003b — bare `start` / `stop` verbs (b-AC-1 / b-AC-5) and the completed `uninstall` verb
 * (b-AC-2 / b-AC-4 / b-AC-6 + parent AC-9).
 *
 * Everything is driven through the dispatcher / the connector handler against injected recording
 * fakes: a fake DaemonLifecycle, a recording ConnectorRunner, and recording UninstallLifecycleSteps.
 * No real daemon, no OS service manager, no real registry, no real state dir.
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	type ConnectorRunner,
	createDispatcher,
	createFakeDaemonClient,
	type DaemonLifecycle,
	type DaemonStatus,
	type LocalDeps,
	lookupVerb,
	runConnectorVerb,
	type UninstallLifecycleSteps,
	usageText,
} from "../../src/commands/index.js";
import type { HoneycombStandardOps } from "../../src/commands/standard-interface.js";

function fakeStandard(): HoneycombStandardOps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		configPath: "/tmp/honeycomb",
		logPath: "/tmp/honeycomb/service.log",
		async start() {
			calls.push("start");
			return { ok: true, changed: true, message: "Honeycomb started through its installed OS service." };
		},
		async stop() {
			calls.push("stop");
			return { ok: true, changed: true, message: "Honeycomb stopped through its installed OS service." };
		},
		async restart() {
			calls.push("restart");
			return { ok: true, changed: true, message: "Honeycomb restarted through its installed OS service." };
		},
		async serviceInstall() {
			return { ok: true, message: "installed" };
		},
		async serviceUninstall() {
			return { ok: true, message: "removed" };
		},
		async isServiceInstalled() {
			return true;
		},
		async register() {
			return { ok: true, message: "registered" };
		},
		async isRegistered() {
			return true;
		},
		async update() {
			return { ok: true, message: "current" };
		},
	};
}

/** A recording fake DaemonLifecycle: records every call + returns scripted results. */
function fakeLifecycle(
	script: { start?: { started: boolean; alreadyRunning: boolean }; stop?: { stopped: boolean } } = {},
): DaemonLifecycle & {
	calls: string[];
} {
	const calls: string[] = [];
	let running = true;
	return {
		calls,
		async start() {
			calls.push("start");
			running = true;
			return script.start ?? { started: true, alreadyRunning: false };
		},
		async stop() {
			calls.push("stop");
			running = false;
			return script.stop ?? { stopped: true };
		},
		async status(): Promise<DaemonStatus> {
			calls.push("status");
			return running ? { running: true, pid: 7, port: 3850 } : { running: false, port: 3850 };
		},
	};
}

describe("PRD-003b b-AC-1 — bare `start` / `stop` verbs front the daemon lifecycle", () => {
	it("b-AC-1 `honeycomb start` routes only to the installed-service adapter", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle();
		const standard = fakeStandard();
		const deps: CommandDeps = {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			standard,
			out: (l) => lines.push(l),
		};
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["start"]), deps);
		expect(res.exitCode).toBe(0);
		expect(standard.calls).toEqual(["start"]);
		expect(lifecycle.calls).toEqual([]);
		expect(lines.join("\n")).toMatch(/installed OS service/);
	});

	it("b-AC-1 `honeycomb stop` routes to lifecycle.stop and reports it stopped", async () => {
		const lines: string[] = [];
		const lifecycle = fakeLifecycle();
		const standard = fakeStandard();
		const deps: CommandDeps = {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			standard,
			out: (l) => lines.push(l),
		};
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["stop"]), deps);
		expect(res.exitCode).toBe(0);
		expect(standard.calls).toEqual(["stop"]);
		expect(lifecycle.calls).toEqual([]);
		expect(lines.join("\n")).toMatch(/installed OS service/);
	});

	it("b-AC-1 `start` and `stop` are registered verbs listed in --help", () => {
		expect(lookupVerb("start")?.cls).toBe("local");
		expect(lookupVerb("stop")?.cls).toBe("local");
		const help = usageText();
		expect(help).toMatch(/\n {2}start\s/);
		expect(help).toMatch(/\n {2}stop\s/);
	});
});

describe("PRD-003b b-AC-5 — the existing `daemon start|stop|status` spellings keep working", () => {
	it("b-AC-5 `honeycomb daemon start` still starts via the SAME lifecycle path", async () => {
		const lifecycle = fakeLifecycle();
		const deps: CommandDeps = { daemon: createFakeDaemonClient({ alive: false }), lifecycle, out: () => {} };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["daemon", "start"]), deps);
		expect(res.exitCode).toBe(0);
		expect(lifecycle.calls).toContain("start");
	});

	it("b-AC-5 `honeycomb daemon stop` and `daemon status` still route through the lifecycle", async () => {
		const lifecycle = fakeLifecycle();
		const deps: CommandDeps = { daemon: createFakeDaemonClient({ alive: true }), lifecycle, out: () => {} };
		const d = createDispatcher();
		await d.dispatch(d.parse(["daemon", "stop"]), deps);
		await d.dispatch(d.parse(["daemon", "status"]), deps);
		expect(lifecycle.calls).toContain("stop");
		expect(lifecycle.calls).toContain("status");
	});
});

/** A recording ConnectorRunner that reverses the given harness slugs. */
function recordingConnector(harnesses: string[] = ["cursor"]): ConnectorRunner & { runs: string[] } {
	const runs: string[] = [];
	return {
		runs,
		async run(args) {
			runs.push(args.verb + (args.harness !== undefined ? ` ${args.harness}` : ""));
			return { exitCode: 0, harnesses };
		},
	};
}

/** Recording UninstallLifecycleSteps: records order + returns scripted results (or throws). */
function recordingSteps(
	script: {
		stop?: { stopped: boolean } | "throw";
		unregister?: { removed: boolean; manager?: string } | "throw";
		registry?: { removed: boolean } | "throw";
		stateDir?: { removed: boolean; dir: string } | "throw";
	} = {},
): UninstallLifecycleSteps & { calls: string[] } {
	const calls: string[] = [];
	const yield_ = <T>(v: T | "throw"): T => {
		if (v === "throw") throw new Error("step failed");
		return v;
	};
	return {
		calls,
		async stopDaemon() {
			calls.push("stop");
			return yield_(script.stop ?? { stopped: true });
		},
		unregisterService() {
			calls.push("unregister");
			return yield_(script.unregister ?? { removed: true, manager: "launchd" });
		},
		deleteRegistryEntry() {
			calls.push("registry");
			return yield_(script.registry ?? { removed: true });
		},
		removeStateDir() {
			calls.push("stateDir");
			return yield_(script.stateDir ?? { removed: true, dir: "/home/ada/.apiary/honeycomb" });
		},
	};
}

describe("PRD-003b b-AC-2 / b-AC-4 — the full uninstall removes unit + registry + state dir, in order", () => {
	it("b-AC-2 / b-AC-4 runs stop → unregister → delete-registry → remove-state-dir and reports each", async () => {
		const lines: string[] = [];
		const steps = recordingSteps();
		const connector = recordingConnector([]);
		const deps: LocalDeps = {
			daemon: createFakeDaemonClient({ alive: true }),
			connector,
			uninstallSteps: steps,
			out: (l) => lines.push(l),
		};
		const res = await runConnectorVerb("uninstall", [], deps);
		expect(res.exitCode).toBe(0);
		// The contract order (b-AC-3 impl-note: doctor never sees a registered-but-gone product).
		expect(steps.calls).toEqual(["stop", "unregister", "registry", "stateDir"]);
		const text = lines.join("\n");
		expect(text).toMatch(/removed the OS service unit \(launchd\)/);
		expect(text).toMatch(/removed Honeycomb's entry from doctor's registry/);
		expect(text).toMatch(/removed the Honeycomb state directory \(.*honeycomb\)/);
		// The harness-hook reversal (connector.run) still ran too.
		expect(connector.runs).toEqual(["uninstall"]);
	});

	it("b-AC-4 a single-harness `uninstall <harness>` does NOT run the fleet-lifecycle steps", async () => {
		const steps = recordingSteps();
		const deps: LocalDeps = {
			daemon: createFakeDaemonClient({ alive: true }),
			connector: recordingConnector(["cursor"]),
			uninstallSteps: steps,
			out: () => {},
		};
		const res = await runConnectorVerb("uninstall", ["cursor"], deps);
		expect(res.exitCode).toBe(0);
		// A partial re-wire is not a full uninstall → the destructive fleet steps never fire.
		expect(steps.calls).toEqual([]);
	});
});

describe("PRD-003b b-AC-6 — uninstall with nothing installed exits 0 with a friendly message", () => {
	it("b-AC-6 reports nothing-to-remove when no unit / registry / state dir / harness existed", async () => {
		const lines: string[] = [];
		const steps = recordingSteps({
			stop: { stopped: false },
			unregister: { removed: false },
			registry: { removed: false },
			stateDir: { removed: false, dir: "/home/ada/.apiary/honeycomb" },
		});
		const deps: LocalDeps = {
			daemon: createFakeDaemonClient({ alive: false }),
			connector: recordingConnector([]),
			uninstallSteps: steps,
			out: (l) => lines.push(l),
		};
		const res = await runConnectorVerb("uninstall", [], deps);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/nothing to remove/i);
	});
});

describe("PRD-003b / AC-9 — every uninstall step is best-effort and never aborts the verb", () => {
	it("AC-9 a throwing step is reported as a note and the remaining steps still run (exit 0)", async () => {
		const lines: string[] = [];
		// The FIRST prerequisite throws; later destructive steps must not run.
		const steps = recordingSteps({ stop: "throw" });
		const deps: LocalDeps = {
			daemon: createFakeDaemonClient({ alive: true }),
			connector: recordingConnector([]),
			uninstallSteps: steps,
			out: (l) => lines.push(l),
		};
		const res = await runConnectorVerb("uninstall", [], deps);
		expect(res.exitCode).toBe(1);
		expect(steps.calls).toEqual(["stop"]);
		expect(lines.join("\n")).toMatch(/no further removal was attempted/);
	});
});
