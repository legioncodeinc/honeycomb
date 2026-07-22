/**
 * Hermes shim suite — current Hermes shell-hook protocol + Honeycomb lifecycle mapping.
 */

import { describe, expect, it } from "vitest";

import {
	createHermesShim,
	HERMES_RECALL_HOOK_ARG,
	hermesContextOutput,
	hermesRenderHookResponse,
} from "../../../src/hooks/index.js";

const META = { sessionId: "sess-h", path: "conv-h" };

const native = (event: string, extra: Record<string, unknown> = {}, tool?: string) => ({
	name: event,
	payload: {
		hook_event_name: event,
		tool_name: tool,
		tool_input: tool === undefined ? null : { command: "pwd" },
		session_id: "sess-h",
		cwd: "/repo",
		extra,
	},
});

describe("Hermes shim", () => {
	it("maps the current Hermes shell-hook lifecycle and reads event fields from extra", () => {
		const shim = createHermesShim({ mode: "capture" });

		expect(shim.mapEvent("on_session_start")).toBe("session-start");
		expect(shim.mapEvent("pre_llm_call")).toBe("user_message");
		expect(shim.mapEvent("pre_tool_call")).toBeUndefined();
		expect(shim.mapEvent("post_tool_call")).toBe("tool_call");
		expect(shim.mapEvent("post_llm_call")).toBe("assistant_message");
		expect(shim.mapEvent("on_session_end")).toBeUndefined();
		expect(shim.mapEvent("on_session_finalize")).toBe("session-end");

		const user = shim.normalize(native("pre_llm_call", { user_message: "ship the adapter" }), META);
		expect(user?.data).toEqual({ kind: "user_message", text: "ship the adapter" });

		const assistant = shim.normalize(native("post_llm_call", { assistant_response: "adapter shipped" }), META);
		expect(assistant?.data).toEqual({ kind: "assistant_message", text: "adapter shipped" });
	});

	it("captures every Hermes tool and reads the post-tool result from extra", () => {
		const shim = createHermesShim({ mode: "capture" });
		const terminal = shim.normalize(native("post_tool_call", { result: "ok" }, "terminal"), META);
		expect(terminal?.data).toEqual({
			kind: "tool_call",
			tool: "terminal",
			input: { command: "pwd" },
			response: "ok",
		});
		expect(shim.normalize(native("post_tool_call", { result: "contents" }, "read_file"), META)?.data).toEqual({
			kind: "tool_call",
			tool: "read_file",
			input: { command: "pwd" },
			response: "contents",
		});
	});

	it("uses a dedicated recall mode so pre_llm_call injects context without double-capturing", () => {
		const capture = createHermesShim({ mode: "capture" });
		const recall = createHermesShim({ mode: "recall" });
		expect(capture.mapEvent("pre_llm_call")).toBe("user_message");
		expect(recall.mapEvent("pre_llm_call")).toBe("user_prompt_recall");
		expect(HERMES_RECALL_HOOK_ARG).toBe("--honeycomb-recall");
	});

	it("emits Hermes' native { context } response only for pre_llm_call", () => {
		const block = "## Goals\n- ship v2";
		const out = hermesRenderHookResponse("pre_llm_call", block);
		expect(out).toEqual(hermesContextOutput(block));
		expect(hermesRenderHookResponse("on_session_start", block)).toEqual({});
	});

	it("shells Hermes non-interactively and keeps the legacy runtime path", () => {
		const shim = createHermesShim();
		expect(shim.runtimePath).toBe("legacy");
		expect(shim.contextChannel).toBe("model-only");
		expect(shim.hostCli).toEqual({ bin: "hermes", args: ["chat", "-Q", "-q"] });
	});
});
