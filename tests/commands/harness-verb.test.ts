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
 * PRD-006c/006d - the `honeycomb harness <status|connect|repair>` verb handler.
 *
 * Proves the thin dispatcher surface Hive shells:
 *   - c-AC-4: `connect` renders the renderable status (text + `--json`), so Hive parses it verbatim.
 *   - c-AC-5: a non-connected connect (agent-absent) still exits 0 (onboarding proceeds / offers
 *             Retry); only a hard `error` exits non-zero; an unbound seam reports honestly (no throw).
 *   - d-AC-3: `repair` calls the seam and renders the updated status.
 *   - d-AC-4/5: `status` renders per-harness agent/plugin state; a repair that cannot complete never
 *               blocks (exits 0 with a clear line).
 */

import { describe, expect, it } from "vitest";

import type {
	ConnectSeamResult,
	HarnessConnectionState,
	HarnessStatusRunner,
	RepairResult,
} from "../../src/commands/index.js";
import { runHarnessVerb } from "../../src/commands/index.js";

/** A fake {@link HarnessStatusRunner} returning scripted results. */
function fakeRunner(overrides: Partial<HarnessStatusRunner> = {}): HarnessStatusRunner {
	return {
		async connect(): Promise<ConnectSeamResult> {
			return { harness: "claude-code", status: "connected" };
		},
		async status(): Promise<readonly HarnessConnectionState[]> {
			return [{ harness: "claude-code", agentPresent: true, pluginEnabled: true, connected: true }];
		},
		async repair(): Promise<RepairResult> {
			return { harness: "claude-code", status: "connected", connected: true };
		},
		...overrides,
	};
}

/** Capture the output lines a verb writes. */
function capture(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string): void => void lines.push(line), lines };
}

describe("PRD-006c/006d - the harness verb reports honestly when the seam is unbound", () => {
	it("c-AC-5 / d-AC-5 an unbound seam prints the deferred-assembly line and exits non-zero (never throws)", async () => {
		const { out, lines } = capture();
		const result = await runHarnessVerb(["connect"], { out }, false);
		expect(result.exitCode).toBe(1);
		expect(lines.join("\n")).toContain("not wired in this build");
	});
});

describe("PRD-006c c-AC-4 / c-AC-5 - connect rendering + exit codes", () => {
	it("c-AC-4 connect renders the renderable status as text", async () => {
		const { out, lines } = capture();
		const result = await runHarnessVerb(["connect"], { out, harnessStatus: fakeRunner() }, false);
		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).toContain("connected");
	});

	it("c-AC-4 connect --json emits a machine-readable body Hive parses", async () => {
		const { out, lines } = capture();
		const result = await runHarnessVerb(["connect"], { out, harnessStatus: fakeRunner() }, true);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(lines[0] ?? "{}") as ConnectSeamResult;
		expect(parsed.harness).toBe("claude-code");
		expect(parsed.status).toBe("connected");
	});

	it("c-AC-5 an agent-absent connect exits 0 so onboarding can proceed / offer Retry", async () => {
		const { out } = capture();
		const runner = fakeRunner({
			async connect(): Promise<ConnectSeamResult> {
				return { harness: "claude-code", status: "agent-absent" };
			},
		});
		const result = await runHarnessVerb(["connect"], { out, harnessStatus: runner }, false);
		expect(result.exitCode).toBe(0);
	});

	it("c-AC-5 an error connect exits non-zero so the caller can surface it", async () => {
		const { out } = capture();
		const runner = fakeRunner({
			async connect(): Promise<ConnectSeamResult> {
				return { harness: "claude-code", status: "error", detail: "boom" };
			},
		});
		const result = await runHarnessVerb(["connect"], { out, harnessStatus: runner }, false);
		expect(result.exitCode).toBe(1);
	});
});

describe("PRD-006d d-AC-3 / d-AC-4 - status + repair rendering", () => {
	it("d-AC-4 status renders per-harness agent/plugin state (text)", async () => {
		const { out, lines } = capture();
		const result = await runHarnessVerb(["status"], { out, harnessStatus: fakeRunner() }, false);
		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).toContain("agent present, plugin enabled");
	});

	it("d-AC-4 status --json emits the { harnesses: [...] } body", async () => {
		const { out, lines } = capture();
		await runHarnessVerb([], { out, harnessStatus: fakeRunner() }, true);
		const parsed = JSON.parse(lines[0] ?? "{}") as { harnesses: HarnessConnectionState[] };
		expect(parsed.harnesses[0]?.harness).toBe("claude-code");
		expect(parsed.harnesses[0]?.pluginEnabled).toBe(true);
	});

	it("d-AC-3 repair calls the seam and renders the updated status", async () => {
		const { out, lines } = capture();
		const result = await runHarnessVerb(["repair"], { out, harnessStatus: fakeRunner() }, false);
		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).toContain("repaired");
	});

	it("d-AC-5 a repair that cannot complete exits 0 with a clear line (never blocks)", async () => {
		const { out, lines } = capture();
		const runner = fakeRunner({
			async repair(): Promise<RepairResult> {
				return { harness: "claude-code", status: "agent-absent", connected: false };
			},
		});
		const result = await runHarnessVerb(["repair"], { out, harnessStatus: runner }, false);
		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).toContain("agent not installed");
	});
});
