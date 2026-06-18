/**
 * PRD-019c Codex shim suite — c-AC-4 (detached setup + brief login line) + FR-3.
 *
 * c-AC-4: Codex session-start runs `autoUpdate` + table-ensure in a DETACHED setup
 * process, and injects ONLY a brief login-state line (its hook context is
 * user-visible). The Bash-only pre-tool intercept (FR-3) is also asserted.
 */

import { describe, expect, it } from "vitest";

import {
	codexRenderUserVisible,
	codexSessionStartSetup,
	createCodexShim,
} from "../../../src/hooks/index.js";

const META = { sessionId: "sess-c", path: "conv-c" };

describe("PRD-019c Codex shim", () => {
	it("c-AC-4 autoUpdate + table-ensure are deferred to a DETACHED setup process", () => {
		// The interactive hook does NOT run autoUpdate/ensure inline — they are deferred.
		expect(codexSessionStartSetup.detached).toBe(true);
		expect(codexSessionStartSetup.entry).toBe("session-start-setup.ts");
		expect(codexSessionStartSetup.deferred).toEqual(["autoUpdate", "ensureTables"]);
	});

	it("c-AC-4 only a brief login-state line is injected (signed-in)", () => {
		const block = "## Goals\n- ship v2\n## Rules\n- prefer small PRs";
		const line = codexRenderUserVisible(block);
		// NOT the full block — a single brief line.
		expect(line).toBe("honeycomb: signed in — memory recall active");
		expect(line).not.toContain("ship v2");
	});

	it("c-AC-4 the brief line reflects read-only when signed out (empty block)", () => {
		expect(codexRenderUserVisible("")).toBe("honeycomb: read-only (run `honeycomb login`)");
	});

	it("c-AC-4 / c-AC-5 the channel is user-visible and the envelope carries the brief line", () => {
		const shim = createCodexShim();
		expect(shim.contextChannel).toBe("user-visible");
		const env = shim.renderContext("## Goals\n- ship v2");
		expect(env.channel).toBe("user-visible");
		if (env.channel === "user-visible") {
			expect(env.text).toBe("honeycomb: signed in — memory recall active");
		}
	});

	it("FR-3 Codex intercepts Bash ONLY — a non-Bash PreToolUse is dropped", () => {
		const shim = createCodexShim();
		// Bash → normalized to the canonical pre-tool shape.
		const bash = shim.normalize({ name: "PreToolUse", payload: { tool_name: "Bash", command: "grep x" } }, META);
		expect(bash).toBeDefined();
		expect((bash!.data as { tool: string }).tool).toBe("Bash");
		// A non-Bash tool is dropped (no normalized input).
		expect(shim.normalize({ name: "PreToolUse", payload: { tool_name: "Read", path: "a.ts" } }, META)).toBeUndefined();
	});

	it("FR-3 Codex maps its five native events and stamps the legacy runtime path", () => {
		const shim = createCodexShim();
		expect(shim.mapEvent("SessionStart")).toBe("session-start");
		expect(shim.mapEvent("Stop")).toBe("assistant_message");
		expect(shim.runtimePath).toBe("legacy");
		expect(shim.hostCli).toEqual({ bin: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox"] });
	});
});
