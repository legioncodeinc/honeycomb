/**
 * PRD-019c Grok shim suite — terminal-tool intercept + snake_case events.
 */

import { describe, expect, it } from "vitest";

import {
	createGrokShim,
	grokRenderUserVisible,
} from "../../../src/hooks/index.js";

const META = { sessionId: "sess-g", path: "conv-g" };

describe("PRD-019c Grok shim", () => {
	it("maps PascalCase and snake_case native event names", () => {
		const shim = createGrokShim();
		expect(shim.mapEvent("SessionStart")).toBe("session-start");
		expect(shim.mapEvent("session_start")).toBe("session-start");
		expect(shim.mapEvent("pre_tool_use")).toBe("pre-tool-use");
		expect(shim.mapEvent("Stop")).toBe("assistant_message");
		expect(shim.harness).toBe("grok");
	});

	it("renders a brief user-visible login line", () => {
		expect(grokRenderUserVisible("## Goals\n- ship")).toBe("honeycomb: signed in — memory recall active");
		expect(grokRenderUserVisible("")).toBe("honeycomb: read-only (run `honeycomb login`)");
	});

	it("intercepts run_terminal_command and Bash only on PreToolUse", () => {
		const shim = createGrokShim();
		const bash = shim.normalize(
			{ name: "PreToolUse", payload: { toolName: "run_terminal_command", toolInput: { command: "grep x" } } },
			META,
		);
		expect(bash).toBeDefined();
		expect((bash!.data as { tool: string }).tool).toBe("Bash");
		expect(
			shim.normalize({ name: "pre_tool_use", payload: { toolName: "read_file", toolInput: {} } }, META),
		).toBeUndefined();
	});

	it("stamps meta.agent = grok on captured turns", () => {
		const shim = createGrokShim();
		const input = shim.normalize(
			{ name: "user_prompt_submit", payload: { prompt: "find the bug" } },
			META,
		);
		expect(input?.meta.agent).toBe("grok");
	});

	it("uses grok agent stdio for detached summaries", () => {
		expect(createGrokShim().hostCli).toEqual({ bin: "grok", args: ["agent", "stdio"] });
	});
});
