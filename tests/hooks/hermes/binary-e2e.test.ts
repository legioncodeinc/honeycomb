/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";

import { type BinaryIo, runHookBinary } from "../../../src/hooks/binary.js";
import { createHermesShim } from "../../../src/hooks/hermes/shim.js";
import { createHookRuntime } from "../../../src/hooks/runtime.js";
import {
	createFakeDaemonHookClient,
	createFakePrimeRenderer,
	createFakeRecallRenderer,
	createFakeRecallSessionStore,
	createNoopSessionStartSeams,
} from "../../../src/hooks/shared/index.js";

const SESSION_ID = "hermes-binary-e2e";
const BASE = {
	session_id: SESSION_ID,
	cwd: "/repo",
	transcript_path: `/tmp/${SESSION_ID}.jsonl`,
};

function hermesEvent(hook_event_name: string, extra: Record<string, unknown> = {}, tool_name?: string) {
	return {
		hook_event_name,
		...BASE,
		...(tool_name === undefined ? {} : { tool_name, tool_input: { command: "pwd" } }),
		extra,
	};
}

async function invoke(runtime: ReturnType<typeof createHookRuntime>, raw: unknown, recall = false): Promise<unknown> {
	let output = "";
	const io: BinaryIo = {
		async readStdin(): Promise<string> {
			return JSON.stringify(raw);
		},
		writeStdout(text: string): void {
			output += text;
		},
	};
	await runHookBinary({ shim: createHermesShim({ mode: recall ? "recall" : "capture" }), runtime, io });
	return JSON.parse(output);
}

describe("Hermes installed-hook lifecycle", () => {
	it("captures the complete lifecycle and injects daemon recall through Hermes' model-only response", async () => {
		const daemon = createFakeDaemonHookClient();
		const runtime = createHookRuntime({
			daemon,
			prime: createFakePrimeRenderer(),
			recall: createFakeRecallRenderer([{ ref: "memory:verification", text: "HERMES_RECALL_MARKER" }]),
			recallStore: createFakeRecallSessionStore(),
			seams: createNoopSessionStartSeams(),
			onboardingNotice: { hasBoundProject: () => true },
			notifications: { drain: async () => ({ banner: null, suppressed: [] }) },
		});

		expect(await invoke(runtime, hermesEvent("on_session_start", { source: "cli" }))).toEqual({});
		expect(await invoke(runtime, hermesEvent("pre_llm_call", { user_message: "verify lifecycle" }))).toEqual({});
		expect(await invoke(runtime, hermesEvent("post_tool_call", { result: "ok" }, "terminal"))).toEqual({});
		expect(await invoke(runtime, hermesEvent("post_llm_call", { assistant_response: "verified" }))).toEqual({});
		expect(await invoke(runtime, hermesEvent("on_session_finalize", { reason: "complete" }))).toEqual({});

		const recall = await invoke(runtime, hermesEvent("pre_llm_call", { user_message: "verify lifecycle" }), true);
		expect(recall).toEqual({ context: expect.stringContaining("HERMES_RECALL_MARKER") });
		expect(daemon.calls.map((call) => call.endpoint)).toEqual([
			"context",
			"capture",
			"capture",
			"capture",
			"session-end",
		]);
		expect(daemon.calls.map((call) => (call.body as { event?: { kind?: string } }).event?.kind)).toEqual([
			undefined,
			"user_message",
			"tool_call",
			"assistant_message",
			undefined,
		]);
		expect(daemon.calls.every((call) => call.meta.sessionId === SESSION_ID && call.runtimePath === "legacy")).toBe(
			true,
		);
	});
});
