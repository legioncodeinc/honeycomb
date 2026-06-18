/**
 * PRD-019c Hermes shim suite — FR-6 (terminal-only tools + `{ context }` + MCP mention).
 */

import { describe, expect, it } from "vitest";

import { createHermesShim, hermesContextOutput, HERMES_MCP_MENTION } from "../../../src/hooks/index.js";

const META = { sessionId: "sess-h", path: "conv-h" };

describe("PRD-019c Hermes shim", () => {
	it("FR-6 captures terminal tools only — a non-terminal tool_use is dropped", () => {
		const shim = createHermesShim();
		const terminal = shim.normalize({ name: "on_tool_use", payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" } }, META);
		expect(terminal).toBeDefined();
		expect((terminal!.data as { kind: string }).kind).toBe("tool_call");
		// A non-terminal tool is filtered out.
		expect(shim.normalize({ name: "on_tool_use", payload: { tool_name: "Browser" } }, META)).toBeUndefined();
	});

	it("FR-6 emits a { context } output carrying the full block + MCP-tools mention", () => {
		const shim = createHermesShim();
		const env = shim.renderContext("## Goals\n- ship v2");
		expect(env.channel).toBe("user-visible");
		if (env.channel === "user-visible") {
			const out = hermesContextOutput(env.text);
			expect(out.context).toContain("ship v2");
			expect(out.context).toContain(HERMES_MCP_MENTION.trim());
		}
	});

	it("FR-6 maps its four native events and shells hermes non-interactively", () => {
		const shim = createHermesShim();
		expect(shim.mapEvent("on_session_start")).toBe("session-start");
		expect(shim.mapEvent("on_session_end")).toBe("session-end");
		expect(shim.runtimePath).toBe("legacy");
		expect(shim.hostCli).toEqual({ bin: "hermes", args: ["--non-interactive"] });
	});
});
