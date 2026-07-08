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
 * PRD-006b - self-healing harness auto-wire reconcile (b-AC-1..b-AC-7).
 *
 * Proves the reconcile is idempotent + fail-soft, gated in the cheap order
 * (isPluginEnabled -> available() -> agent-present -> wire()), reuses the real
 * pieces (detectInstalledHarnesses, isPluginEnabled, createAutoWiring over the
 * real connector composition) without forking, runs on daemon-start + a recurring
 * cadence, and exposes a last-outcome status for 006c/006d. Every external effect
 * is behind an injected seam so no real `claude` binary is ever spawned.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/commands/index.js";
import {
	buildConnectorWiring,
	createHarnessReconciler,
	DEFAULT_RECONCILE_HARNESSES,
} from "../../src/cli/harness-reconcile.js";
import { buildDaemonLifecycle } from "../../src/cli/runtime.js";
import type { AutoWiring } from "../../src/notifications/contracts.js";
import { detectInstalledHarnesses } from "../../src/daemon/runtime/dashboard/harness-detect.js";

/** A fixed clock so the recorded `at` timestamps are deterministic. */
const FIXED_NOW = new Date("2026-07-08T12:00:00.000Z");

/** A spy {@link AutoWiring} - records wire()/unwire() calls; `wire()` resolves to the given `wrote`. */
function spyWiring(wrote = true): {
	wiring: AutoWiring;
	wire: ReturnType<typeof vi.fn>;
	unwire: ReturnType<typeof vi.fn>;
} {
	const wire = vi.fn(async () => wrote);
	const unwire = vi.fn(async () => {});
	return { wiring: { wire, unwire }, wire, unwire };
}

describe("PRD-006b b-AC-1 - start-wire", () => {
	it("b-AC-1 wires when the agent is present, the plugin is not enabled, and the CLI is available", async () => {
		const { wiring, wire } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		const results = await reconciler.reconcileOnce();

		expect(results).toHaveLength(1);
		expect(results[0]?.harness).toBe("claude-code");
		expect(results[0]?.outcome).toBe("wired");
		expect(wire).toHaveBeenCalledTimes(1);
	});

	it("b-AC-1 the daemon-start trigger fires the reconcile on daemon-up (fail-soft)", async () => {
		// The reconcile is triggered from the CLI daemon lifecycle's onDaemonUp seam, OUT of the
		// daemon request path. The already-running path returns before any spawn, so no real daemon
		// is started here.
		const upClient = { ping: async () => true } as unknown as DaemonClient;

		let fired = 0;
		const lifecycle = buildDaemonLifecycle(upClient, {
			serviceManager: null,
			onDaemonUp: () => {
				fired += 1;
			},
		});
		const result = await lifecycle.start();
		expect(result.alreadyRunning).toBe(true);
		expect(fired).toBe(1);

		// A THROWING hook must never turn a healthy start into a reported failure (b-AC-6 fail-soft).
		const throwing = buildDaemonLifecycle(upClient, {
			serviceManager: null,
			onDaemonUp: () => {
				throw new Error("reconcile blew up");
			},
		});
		const safe = await throwing.start();
		expect(safe.alreadyRunning).toBe(true);
	});
});

describe("PRD-006b b-AC-2 - recurring cadence", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("b-AC-2 start() arms a recurring cadence that reconciles again on each interval", async () => {
		const { wiring, wire } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			intervalMs: 1000,
			wireTimeoutMs: 1_000_000,
			now: () => FIXED_NOW,
		});

		reconciler.start();
		// The immediate start pass (b-AC-1).
		await vi.advanceTimersByTimeAsync(0);
		expect(wire).toHaveBeenCalledTimes(1);

		// Each interval tick runs another reconcile pass with no user action (b-AC-2).
		await vi.advanceTimersByTimeAsync(1000);
		expect(wire).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wire).toHaveBeenCalledTimes(3);

		// stop() clears the cadence - no further passes fire.
		reconciler.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(wire).toHaveBeenCalledTimes(3);
	});

	it("b-AC-1/b-AC-2 start() is idempotent - a repeated call while running neither re-fires the immediate pass nor stacks a second cadence timer", async () => {
		const { wiring, wire } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			intervalMs: 1000,
			wireTimeoutMs: 1_000_000,
			now: () => FIXED_NOW,
		});

		reconciler.start();
		reconciler.start(); // repeated while already running - must be a total no-op
		reconciler.start();
		await vi.advanceTimersByTimeAsync(0);
		// Only ONE immediate pass fired despite three start() calls.
		expect(wire).toHaveBeenCalledTimes(1);

		// Only ONE cadence timer is armed - a single interval tick advances exactly one more pass,
		// never N stacked passes from N stacked timers.
		await vi.advanceTimersByTimeAsync(1000);
		expect(wire).toHaveBeenCalledTimes(2);

		reconciler.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(wire).toHaveBeenCalledTimes(2);

		// start() after stop() resumes normally: fires again and rearms the cadence.
		reconciler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(wire).toHaveBeenCalledTimes(3);
	});
});

describe("PRD-006b b-AC-3 - already-enabled no-op", () => {
	it("b-AC-3 does not invoke wire() when the plugin is already enabled", async () => {
		const { wiring, wire } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => true, // already enabled -> cheap short-circuit
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		const results = await reconciler.reconcileOnce();

		expect(results[0]?.outcome).toBe("already-enabled");
		expect(wire).not.toHaveBeenCalled();
	});
});

describe("PRD-006b b-AC-4 - agent/CLI absent status", () => {
	it("b-AC-4 records cli-absent when claude is not available and never wires or spins", async () => {
		const { wiring, wire } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => false,
			cliAvailable: () => false, // claude not on PATH
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		const results = await reconciler.reconcileOnce();

		expect(results[0]?.outcome).toBe("cli-absent");
		expect(wire).not.toHaveBeenCalled();
	});

	it("b-AC-4 records agent-absent when the harness agent is not installed", async () => {
		const { wiring, wire } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set<string>(), // agent not present
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		const results = await reconciler.reconcileOnce();

		expect(results[0]?.outcome).toBe("agent-absent");
		expect(wire).not.toHaveBeenCalled();
	});
});

describe("PRD-006b b-AC-5 - reuse, not fork", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "hc-reconcile-detect-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("b-AC-5 delegates to createAutoWiring's wire() and reuses isPluginEnabled + agent detect (no fork)", async () => {
		const { wiring, wire, unwire } = spyWiring();
		const detectAgents = vi.fn(() => new Set(["claude-code"]));
		const isPluginEnabled = vi.fn(() => false);
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents,
			isPluginEnabled,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		await reconciler.reconcileOnce();

		expect(detectAgents).toHaveBeenCalledTimes(1);
		expect(isPluginEnabled).toHaveBeenCalledWith("claude-code", "honeycomb");
		// Delegation: the reconcile runs the connector's wire() (no forked merge logic), never unwire().
		expect(wire).toHaveBeenCalledTimes(1);
		expect(unwire).not.toHaveBeenCalled();
	});

	it("b-AC-5 reuses the REAL detectInstalledHarnesses as the agent-present gate", async () => {
		const { wiring } = spyWiring();
		// Write the claude-code install marker the real detector reads (~/.claude/settings.json).
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), "{}");

		const present = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => detectInstalledHarnesses(home),
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});
		expect((await present.reconcileOnce())[0]?.outcome).toBe("wired");

		// An empty home -> the real detector reports the agent absent.
		const empty = mkdtempSync(join(tmpdir(), "hc-reconcile-empty-"));
		try {
			const absent = createHarnessReconciler({
				harnesses: ["claude-code"],
				detectAgents: () => detectInstalledHarnesses(empty),
				isPluginEnabled: () => false,
				cliAvailable: () => true,
				buildWiring: () => wiring,
				now: () => FIXED_NOW,
			});
			expect((await absent.reconcileOnce())[0]?.outcome).toBe("agent-absent");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("b-AC-5 the default buildConnectorWiring composes the real connector registry + createAutoWiring", () => {
		// The real composition returns a delegation seam (wire/unwire) for a known harness, and
		// undefined for an unknown one - proving it reuses createConnectorRegistry, not a fork.
		const wiring = buildConnectorWiring("claude-code", home);
		expect(wiring).toBeDefined();
		expect(typeof wiring?.wire).toBe("function");
		expect(typeof wiring?.unwire).toBe("function");
		expect(buildConnectorWiring("not-a-real-harness", home)).toBeUndefined();
	});

	it("b-AC-5 the first cut is scoped to claude-code", () => {
		expect(DEFAULT_RECONCILE_HARNESSES).toEqual(["claude-code"]);
	});
});

describe("PRD-006b b-AC-6 - fail-soft on throw/timeout", () => {
	it("b-AC-6 a throwing wire() is absorbed to an error status and never rejects", async () => {
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => ({
				wire: async () => {
					throw new Error("boom");
				},
				unwire: async () => {},
			}),
			now: () => FIXED_NOW,
		});

		const results = await reconciler.reconcileOnce();
		expect(results[0]?.outcome).toBe("error");
		expect(results[0]?.detail).toBe("boom");
	});

	it("b-AC-6 a hung wire() times out to an error status without blocking forever", async () => {
		vi.useFakeTimers();
		try {
			const reconciler = createHarnessReconciler({
				harnesses: ["claude-code"],
				detectAgents: () => new Set(["claude-code"]),
				isPluginEnabled: () => false,
				cliAvailable: () => true,
				buildWiring: () => ({
					wire: () => new Promise<boolean>(() => {}), // never settles
					unwire: async () => {},
				}),
				wireTimeoutMs: 50,
				now: () => FIXED_NOW,
			});

			const pending = reconciler.reconcileOnce();
			await vi.advanceTimersByTimeAsync(50);
			const results = await pending;
			expect(results[0]?.outcome).toBe("error");
			expect(results[0]?.detail).toContain("timed out");
		} finally {
			vi.useRealTimers();
		}
	});

	it("b-AC-6 a throwing agent detector degrades to agent-absent, never a throw", async () => {
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => {
				throw new Error("detect exploded");
			},
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => spyWiring().wiring,
			now: () => FIXED_NOW,
		});

		const results = await reconciler.reconcileOnce();
		// isPluginEnabled(false) -> cliAvailable(true) -> agent set is empty (detect swallowed) -> agent-absent.
		expect(results[0]?.outcome).toBe("agent-absent");
	});
});

describe("PRD-006b b-AC-7 - last-outcome exposure", () => {
	it("b-AC-7 exposes the last outcome per harness for 006c/006d to read", async () => {
		const { wiring } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => false,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		// Before any pass there is no recorded outcome.
		expect(reconciler.lastOutcome("claude-code")).toBeUndefined();
		expect(reconciler.lastOutcomes()).toEqual([]);

		await reconciler.reconcileOnce();

		const last = reconciler.lastOutcome("claude-code");
		expect(last?.outcome).toBe("wired");
		expect(last?.at).toBe(FIXED_NOW.toISOString());
		expect(reconciler.lastOutcomes()).toHaveLength(1);
		expect(reconciler.lastOutcomes()[0]?.harness).toBe("claude-code");
	});

	it("b-AC-7 the last outcome reflects the latest pass (already-enabled after wiring)", async () => {
		let enabled = false;
		const { wiring } = spyWiring();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => enabled,
			cliAvailable: () => true,
			buildWiring: () => wiring,
			now: () => FIXED_NOW,
		});

		await reconciler.reconcileOnce();
		expect(reconciler.lastOutcome("claude-code")?.outcome).toBe("wired");

		// Once the plugin is enabled, the next pass records the cheap no-op.
		enabled = true;
		await reconciler.reconcileOnce();
		expect(reconciler.lastOutcome("claude-code")?.outcome).toBe("already-enabled");
	});
});
