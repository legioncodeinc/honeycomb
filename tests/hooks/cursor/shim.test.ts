/**
 * PRD-019c Cursor shim suite — FR-4 (workspace_roots cwd + Shell intercept).
 *
 * Cursor reads cwd from `workspace_roots` and intercepts the `Shell` tool for VFS
 * recall (normalized to the canonical Bash pre-tool shape so it reaches the shared
 * intercept like Claude Code's Bash). Context lands MODEL-ONLY under
 * `additional_context`.
 */

import { describe, expect, it } from "vitest";

import { createCursorShim, CURSOR_CONTEXT_KEY } from "../../../src/hooks/index.js";

const META = { sessionId: "sess-cur", path: "conv-cur" };

describe("PRD-019c Cursor shim", () => {
	it("FR-4 cwd is derived from workspace_roots[0]", () => {
		const shim = createCursorShim();
		const input = shim.normalize(
			{ name: "beforeSubmitPrompt", payload: { prompt: "hi", workspace_roots: ["/repo/app", "/repo/lib"] } },
			META,
		);
		expect(input?.meta.cwd).toBe("/repo/app");
	});

	it("FR-4 a Shell tool_call is normalized to the canonical Bash pre-tool shape", () => {
		const shim = createCursorShim();
		const input = shim.normalize(
			{ name: "postToolUse", payload: { tool_name: "Shell", command: "grep token memory/" } },
			META,
		);
		expect(input).toBeDefined();
		expect((input!.data as { tool: string }).tool).toBe("Bash");
		expect((input!.data as { command: string }).command).toBe("grep token memory/");
	});

	it("FR-4 a non-Shell tool_call stays an ordinary tool_call", () => {
		const shim = createCursorShim();
		const input = shim.normalize(
			{ name: "postToolUse", payload: { tool_name: "Edit", tool_input: { path: "a.ts" }, tool_response: "ok" } },
			META,
		);
		expect((input!.data as { kind: string }).kind).toBe("tool_call");
		expect((input!.data as { tool: string }).tool).toBe("Edit");
	});

	it("FR-4 / FR-10 Cursor stamps the plugin runtime path and lands context model-only", () => {
		const shim = createCursorShim();
		expect(shim.runtimePath).toBe("plugin");
		expect(shim.contextChannel).toBe("model-only");
		expect(CURSOR_CONTEXT_KEY).toBe("additional_context");
		expect(shim.hostCli).toEqual({ bin: "cursor-agent", args: [], fallbackBin: "claude" });
	});
});
