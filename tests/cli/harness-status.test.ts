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
 * PRD-006c (c-AC-1/4/5) + PRD-006d (d-AC-3/4/5) - the honeycomb-side connect/status/repair surface.
 *
 * Proves the CLI-tier {@link buildHarnessStatusRunner}:
 *   - c-AC-1: `connect()` triggers the 006b reconcile (reuses `reconcileOnce`, no forked wiring).
 *   - c-AC-4: it returns a RENDERABLE status (connected / agent-absent / cli-absent / error) mapped
 *             from the reconcile outcome, without reimplementing detection or wiring.
 *   - c-AC-5: it never hangs/dead-ends - a throwing reconcile is absorbed to `error`, never rejects.
 *   - d-AC-3: `repair()` re-runs the reconcile (the same connector path) and reports updated status.
 *   - d-AC-4: `status()` derives plugin-enabled from `isPluginEnabled` (fail-soft false); no secret/path.
 *   - d-AC-5: a repair that cannot complete returns a clear status, never throws or blocks.
 * Every external effect is behind an injected seam, so no real `claude` binary / home dir is touched.
 */

import { describe, expect, it, vi } from "vitest";

import { buildHarnessStatusRunner, mapOutcomeToConnectStatus } from "../../src/cli/harness-status.js";
import type { HarnessReconcileResult, HarnessReconciler, ReconcileOutcome } from "../../src/cli/harness-reconcile.js";

const AT = "2026-07-08T12:00:00.000Z";

/** Build a `HarnessReconcileResult` for a harness/outcome pair. */
function result(harness: string, outcome: ReconcileOutcome, detail?: string): HarnessReconcileResult {
	return detail !== undefined ? { harness, outcome, at: AT, detail } : { harness, outcome, at: AT };
}

/**
 * A fake {@link HarnessReconciler} whose `reconcileOnce` returns scripted results (or throws), and
 * whose `lastOutcome` reads from a seeded map. `calls` records how many times `reconcileOnce` ran so
 * a test proves the seam TRIGGERS the reconcile (c-AC-1 / d-AC-3) rather than forking a second path.
 */
function fakeReconciler(opts: {
	readonly results?: readonly HarnessReconcileResult[];
	readonly throws?: boolean;
	readonly last?: Readonly<Record<string, HarnessReconcileResult>>;
}): HarnessReconciler & { calls: number } {
	const state = { calls: 0 };
	const last = new Map<string, HarnessReconcileResult>(Object.entries(opts.last ?? {}));
	return {
		calls: 0,
		async reconcileOnce(): Promise<readonly HarnessReconcileResult[]> {
			state.calls += 1;
			this.calls = state.calls;
			if (opts.throws === true) throw new Error("reconcile exploded");
			return opts.results ?? [];
		},
		start(): void {},
		stop(): void {},
		lastOutcome(harness: string): HarnessReconcileResult | undefined {
			return last.get(harness);
		},
		lastOutcomes(): readonly HarnessReconcileResult[] {
			return [...last.values()];
		},
	};
}

describe("PRD-006c c-AC-4 - outcome → renderable status mapping", () => {
	it("c-AC-4 maps every reconcile outcome to a renderable connect status", () => {
		expect(mapOutcomeToConnectStatus("wired")).toBe("connected");
		expect(mapOutcomeToConnectStatus("already-enabled")).toBe("connected");
		expect(mapOutcomeToConnectStatus("agent-absent")).toBe("agent-absent");
		expect(mapOutcomeToConnectStatus("cli-absent")).toBe("cli-absent");
		expect(mapOutcomeToConnectStatus("error")).toBe("error");
	});
});

describe("PRD-006c c-AC-1 / c-AC-4 - connect triggers the reconcile and returns a renderable status", () => {
	it("c-AC-1 connect() triggers the 006b reconcile (reuses reconcileOnce, no forked wiring)", async () => {
		const reconcile = fakeReconciler({ results: [result("claude-code", "wired")] });
		const runner = buildHarnessStatusRunner(reconcile, { harnesses: ["claude-code"] });

		const out = await runner.connect();

		expect(reconcile.calls).toBe(1);
		expect(out.harness).toBe("claude-code");
		expect(out.status).toBe("connected");
	});

	it("c-AC-4 connect() renders 'connected' when the plugin is already enabled (c-AC-2 success)", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({ results: [result("claude-code", "already-enabled")] }), {
			harnesses: ["claude-code"],
		});
		expect((await runner.connect()).status).toBe("connected");
	});

	it("c-AC-4 connect() renders 'agent-absent' when the agent is not installed (c-AC-3 install-then-retry)", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({ results: [result("claude-code", "agent-absent")] }), {
			harnesses: ["claude-code"],
		});
		const out = await runner.connect();
		expect(out.status).toBe("agent-absent");
	});

	it("c-AC-4 connect() renders 'cli-absent' when the CLI is not on PATH", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({ results: [result("claude-code", "cli-absent")] }), {
			harnesses: ["claude-code"],
		});
		expect((await runner.connect()).status).toBe("cli-absent");
	});
});

describe("PRD-006c c-AC-5 - never hangs, never dead-ends", () => {
	it("c-AC-5 a throwing reconcile is absorbed to an error status, never rejects", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({ throws: true }), { harnesses: ["claude-code"] });
		const out = await runner.connect();
		expect(out.status).toBe("error");
		expect(out.detail).toBe("reconcile exploded");
	});

	it("c-AC-5 a reconcile that returns no result for the target resolves to a clear error (not a hang)", async () => {
		// reconcileOnce returns an empty list and lastOutcome is empty → synthesized error, still resolves.
		const runner = buildHarnessStatusRunner(fakeReconciler({ results: [] }), { harnesses: ["claude-code"] });
		const out = await runner.connect();
		expect(out.status).toBe("error");
		expect(out.harness).toBe("claude-code");
	});

	it("c-AC-5 connect() falls back to the reconciler's last outcome when the pass omits the target", async () => {
		const runner = buildHarnessStatusRunner(
			fakeReconciler({ results: [], last: { "claude-code": result("claude-code", "wired") } }),
			{ harnesses: ["claude-code"] },
		);
		expect((await runner.connect()).status).toBe("connected");
	});
});

describe("PRD-006d d-AC-3 - repair re-runs the connector setup and reports updated status", () => {
	it("d-AC-3 repair() re-runs the 006b reconcile and reports connected on success", async () => {
		const reconcile = fakeReconciler({ results: [result("claude-code", "wired")] });
		const runner = buildHarnessStatusRunner(reconcile, { harnesses: ["claude-code"] });

		const out = await runner.repair();

		expect(reconcile.calls).toBe(1);
		expect(out.harness).toBe("claude-code");
		expect(out.status).toBe("connected");
		expect(out.connected).toBe(true);
	});

	it("d-AC-3 repair() targets the requested harness", async () => {
		const reconcile = fakeReconciler({ results: [result("claude-code", "already-enabled")] });
		const runner = buildHarnessStatusRunner(reconcile, { harnesses: ["claude-code"] });
		const out = await runner.repair("claude-code");
		expect(out.harness).toBe("claude-code");
		expect(out.connected).toBe(true);
	});
});

describe("PRD-006d d-AC-4 - status derives plugin-enabled fail-soft; no secret/path", () => {
	it("d-AC-4 status() reports agent-present + plugin-enabled derived from the injected seams", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({}), {
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: (h, name) => h === "claude-code" && name === "honeycomb",
		});
		const states = await runner.status();
		expect(states).toHaveLength(1);
		expect(states[0]?.harness).toBe("claude-code");
		expect(states[0]?.agentPresent).toBe(true);
		expect(states[0]?.pluginEnabled).toBe(true);
		expect(states[0]?.connected).toBe(true);
	});

	it("d-AC-4 plugin-enabled is fail-soft false when the probe throws (claude absent)", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({}), {
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => {
				throw new Error("claude not found");
			},
		});
		const states = await runner.status();
		expect(states[0]?.pluginEnabled).toBe(false);
		expect(states[0]?.connected).toBe(false);
		// Agent-present is still honestly reported even though the plugin probe failed soft.
		expect(states[0]?.agentPresent).toBe(true);
	});

	it("d-AC-4 status() carries NO secret/path - only ids, booleans, and a stable outcome string", async () => {
		const runner = buildHarnessStatusRunner(
			fakeReconciler({ last: { "claude-code": result("claude-code", "wired") } }),
			{
				harnesses: ["claude-code"],
				detectAgents: () => new Set(["claude-code"]),
				isPluginEnabled: () => true,
			},
		);
		const states = await runner.status();
		const raw = JSON.stringify(states).toLowerCase();
		for (const needle of ["token", "bearer", "secret", "password", "credential", "api_key", "/users/", "c:\\"]) {
			expect(raw).not.toContain(needle);
		}
		// The last reconcile outcome rides through for the card (a plain string, not a secret).
		expect(states[0]?.lastOutcome).toBe("wired");
		expect(states[0]?.lastOutcomeAt).toBe(AT);
	});

	it("d-AC-4 a throwing agent detector degrades to agent-absent, never a throw", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({}), {
			harnesses: ["claude-code"],
			detectAgents: () => {
				throw new Error("detect exploded");
			},
			isPluginEnabled: () => false,
		});
		const states = await runner.status();
		expect(states[0]?.agentPresent).toBe(false);
		expect(states[0]?.pluginEnabled).toBe(false);
	});
});

describe("PRD-006d d-AC-5 - a repair that cannot complete never fails or blocks", () => {
	it("d-AC-5 a throwing reconcile yields a clear error status with connected=false, never rejects", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({ throws: true }), { harnesses: ["claude-code"] });
		const out = await runner.repair();
		expect(out.status).toBe("error");
		expect(out.connected).toBe(false);
		expect(out.detail).toBe("reconcile exploded");
	});

	it("d-AC-5 an agent-absent repair reports the clear state without blocking (connected=false)", async () => {
		const runner = buildHarnessStatusRunner(fakeReconciler({ results: [result("claude-code", "agent-absent")] }), {
			harnesses: ["claude-code"],
		});
		const out = await runner.repair();
		expect(out.status).toBe("agent-absent");
		expect(out.connected).toBe(false);
	});
});

describe("PRD-006c/006d - connect/repair build on the reconcile's exposed status (reuse, not fork)", () => {
	it("uses the real reconcile surface: reconcileOnce is the ONLY wiring trigger", async () => {
		const reconcile = fakeReconciler({ results: [result("claude-code", "wired")] });
		const spy = vi.spyOn(reconcile, "reconcileOnce");
		const runner = buildHarnessStatusRunner(reconcile, { harnesses: ["claude-code"] });
		await runner.connect();
		await runner.repair();
		expect(spy).toHaveBeenCalledTimes(2);
		// status() is READ-ONLY: it must not trigger another wiring pass.
		await runner.status();
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
