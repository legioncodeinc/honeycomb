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
 * PRD-006d F-2 - the Tier-4 reconcile pushes real plugin-enabled state to the daemon.
 *
 * Proves the CLI side of the tier-legal cross-process handoff:
 *   - after each reconcile cycle the reconciler fires `onCycleComplete` with the pass results;
 *   - the push maps outcomes -> per-harness `pluginEnabled` (`already-enabled`/`wired` -> true) and
 *     POSTs them to the daemon's loopback ingest (`/api/diagnostics/harness-status`);
 *   - a throwing hook never breaks the reconcile, and a failing push never throws (fail-soft, D-2).
 * No real `claude` binary and no real daemon: every seam is a fake.
 */

import { describe, expect, it } from "vitest";

import type { DaemonClient, DaemonRequest } from "../../src/commands/index.js";
import { createHarnessReconciler, type HarnessReconcileResult } from "../../src/cli/harness-reconcile.js";
import { buildReconcilePluginStatusPush } from "../../src/cli/runtime.js";

const FIXED_NOW = new Date("2026-07-08T12:00:00.000Z");
const AT = FIXED_NOW.toISOString();

/** Flush pending microtasks so a fire-and-forget `void push(...)` settles before the assertion. */
async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

/** A recording fake {@link DaemonClient}; `fail` makes `send` reject to prove the push is fail-soft. */
function recordingDaemon(opts: { fail?: boolean } = {}): { daemon: DaemonClient; calls: DaemonRequest[] } {
	const calls: DaemonRequest[] = [];
	const daemon: DaemonClient = {
		async send(req: DaemonRequest) {
			calls.push(req);
			if (opts.fail === true) throw new Error("boom");
			return { status: 200, body: { accepted: true } };
		},
		async ping() {
			return true;
		},
	};
	return { daemon, calls };
}

function result(harness: string, outcome: HarnessReconcileResult["outcome"]): HarnessReconcileResult {
	return { harness, outcome, at: AT };
}

describe("PRD-006d F-2 - buildReconcilePluginStatusPush maps outcomes and posts", () => {
	it("F-2 POSTs per-harness pluginEnabled to the daemon ingest (already-enabled/wired -> true)", async () => {
		const { daemon, calls } = recordingDaemon();
		const push = buildReconcilePluginStatusPush(daemon);
		push([result("claude-code", "already-enabled"), result("cursor", "wired"), result("codex", "agent-absent")]);
		await flush();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.path).toBe("/api/diagnostics/harness-status");
		const body = calls[0]?.body as { harnesses: { harness: string; pluginEnabled: boolean }[] };
		expect(body.harnesses).toEqual([
			{ harness: "claude-code", pluginEnabled: true },
			{ harness: "cursor", pluginEnabled: true },
			{ harness: "codex", pluginEnabled: false },
		]);
	});

	it("F-2 a failing push never throws (fail-soft: the reconcile is unaffected)", async () => {
		const { daemon } = recordingDaemon({ fail: true });
		const push = buildReconcilePluginStatusPush(daemon);
		expect(() => push([result("claude-code", "error")])).not.toThrow();
		await flush(); // no unhandled rejection escapes.
	});
});

describe("PRD-006d F-2 - the reconciler fires onCycleComplete after each cycle", () => {
	it("F-2 hands the pass results to onCycleComplete after reconcileOnce", async () => {
		const seen: HarnessReconcileResult[][] = [];
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => true,
			cliAvailable: () => true,
			now: () => FIXED_NOW,
			onCycleComplete: (results) => seen.push([...results]),
		});
		const results = await reconciler.reconcileOnce();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual(results);
		expect(seen[0]?.[0]?.outcome).toBe("already-enabled");
	});

	it("F-2 a throwing onCycleComplete hook is absorbed (the reconcile still resolves)", async () => {
		const errors: string[] = [];
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => true,
			cliAvailable: () => true,
			onError: (line) => errors.push(line),
			onCycleComplete: () => {
				throw new Error("hook boom");
			},
		});
		const results = await reconciler.reconcileOnce();
		expect(results).toHaveLength(1);
		expect(errors.some((e) => e.includes("cycle-complete hook error"))).toBe(true);
	});

	it("F-2 end-to-end: a reconcile cycle pushes the computed set to the daemon", async () => {
		const { daemon, calls } = recordingDaemon();
		const reconciler = createHarnessReconciler({
			harnesses: ["claude-code"],
			detectAgents: () => new Set(["claude-code"]),
			isPluginEnabled: () => true,
			cliAvailable: () => true,
			onCycleComplete: buildReconcilePluginStatusPush(daemon),
		});
		await reconciler.reconcileOnce();
		await flush();
		expect(calls).toHaveLength(1);
		const body = calls[0]?.body as { harnesses: { harness: string; pluginEnabled: boolean }[] };
		expect(body.harnesses).toEqual([{ harness: "claude-code", pluginEnabled: true }]);
	});
});
