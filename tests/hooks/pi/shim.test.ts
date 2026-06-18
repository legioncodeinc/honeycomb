/**
 * PRD-019c pi shim suite — FR-7 (static AGENTS.md block, no PreToolUse, CLI fallback).
 */

import { describe, expect, it } from "vitest";

import {
	createFakeCliFallback,
	createPiShim,
	piAgentsBlock,
	piGoalKpiFallback,
	piResolveHostCli,
} from "../../../src/hooks/index.js";

const META = { sessionId: "sess-pi", path: "conv-pi" };

describe("PRD-019c pi shim", () => {
	it("FR-7 injects context via the static AGENTS.md fenced block", () => {
		const block = piAgentsBlock("## Goals\n- ship v2");
		expect(block).toContain("<!-- honeycomb:start -->");
		expect(block).toContain("ship v2");
		expect(block).toContain("<!-- honeycomb:end -->");
		// An empty block writes no section.
		expect(piAgentsBlock("")).toBe("");
	});

	it("FR-7 maps only session-end events and has NO PreToolUse", () => {
		const shim = createPiShim();
		expect(shim.mapEvent("agent_end")).toBe("session-end");
		expect(shim.mapEvent("session_shutdown")).toBe("session-end");
		expect(shim.mapEvent("PreToolUse")).toBeUndefined();
		expect(shim.runtimePath).toBe("plugin");
	});

	it("FR-7 resolves the host CLI for the active provider/model at spawn time", () => {
		expect(piResolveHostCli("anthropic", "claude-sonnet")).toEqual({
			bin: "pi",
			args: ["--print", "--provider", "anthropic", "--model", "claude-sonnet"],
		});
	});

	it("c-AC-2 pi has no pre-tool hook → goal/KPI routes through the CLI fallback", async () => {
		const cli = createFakeCliFallback();
		await piGoalKpiFallback(cli, "goal", ["add", "ship v2"]);
		await piGoalKpiFallback(cli, "kpi", ["set", "p95", "200ms"]);
		expect(cli.runs).toEqual([
			["honeycomb", "goal", "add", "ship v2"],
			["honeycomb", "kpi", "set", "p95", "200ms"],
		]);
	});

	it("FR-7 a session_shutdown normalizes to a session-end with the reason", () => {
		const shim = createPiShim();
		const input = shim.normalize({ name: "session_shutdown", payload: { reason: "user_quit" } }, META);
		expect(input!.event).toBe("session-end");
		expect((input!.data as { reason: string }).reason).toBe("user_quit");
	});
});
