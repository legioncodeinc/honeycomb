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
 * ISS-022 — the binary driver threads `HookResult.systemMessage` through `shim.renderContext`.
 *
 *   - The recall arm's stdout JSON carries the TOP-LEVEL `systemMessage` (the documented
 *     Claude Code pass-through field) alongside the unchanged `hookSpecificOutput` wrapper.
 *   - The nudge / deduped / capture / malformed-stdin paths stay byte-identical: no
 *     systemMessage key ever appears, and the benign `{}` acks are untouched.
 */

import { describe, expect, it, vi } from "vitest";

import { type BinaryIo, runHookBinary } from "../../src/hooks/binary.js";
import { createClaudeCodeShim } from "../../src/hooks/claude-code/shim.js";
import { createHookRuntime } from "../../src/hooks/runtime.js";
import {
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeRecallRenderer,
	createFakeRecallSessionStore,
	type RecallHit,
	type RecallSessionStore,
	renderRecallBlock,
} from "../../src/hooks/shared/index.js";
import type { NotificationsPipeline } from "../../src/notifications/index.js";
import {
	assertClaudeCodeUserPromptResponse,
	injectedUserPromptContext,
} from "../../references/claude-code/userprompt-response-schema.js";

const CRED = createFakeCredentialReader({ token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" });

const NOOP_NOTIFICATIONS: NotificationsPipeline = {
	async drain() {
		return { banner: null, suppressed: [] };
	},
};

const HITS: readonly RecallHit[] = [
	{ ref: "memories:m1", text: "Token TTL dropped to 1h (decided 2026-07-01)." },
	{ ref: "sessions:s9", text: "auth refactor thread" },
];

/** A stdio surface that captures everything the driver writes to stdout. */
function captureIo(stdin: string): BinaryIo & { readonly out: string[] } {
	const out: string[] = [];
	return {
		out,
		async readStdin() {
			return stdin;
		},
		writeStdout(text) {
			out.push(text);
		},
	};
}

/** Build a recall-arm runtime around the given hit set + store. */
function recallRuntime(hits: readonly RecallHit[], store: RecallSessionStore = createFakeRecallSessionStore()) {
	return createHookRuntime({
		credentials: CRED,
		daemon: createFakeDaemonHookClient({ status: 201 }),
		notifications: NOOP_NOTIFICATIONS,
		recall: createFakeRecallRenderer(hits),
		recallStore: store,
	});
}

const RECALL_STDIN = JSON.stringify({
	hook_event_name: "UserPromptSubmit",
	session_id: "sess-iss022-bin",
	cwd: "/repo/honeycomb",
	prompt: "what changed in auth?",
});

describe("ISS-022: the recall arm's stdout envelope carries the top-level systemMessage", () => {
	it("emits systemMessage next to the unchanged hookSpecificOutput wrapper, and conforms to the oracle", async () => {
		const io = captureIo(RECALL_STDIN);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "recall" }), runtime: recallRuntime(HITS), io });

		expect(io.out).toHaveLength(1);
		const emitted = JSON.parse(io.out[0]) as {
			channel: string;
			additionalContext: string;
			hookSpecificOutput?: { hookEventName: string; additionalContext: string };
			systemMessage?: string;
		};
		const block = renderRecallBlock(HITS);
		expect(emitted.systemMessage).toBe(`🐝 Honeycomb: 2 memories injected (~${Math.ceil(block.length / 4)} tokens)`);
		expect(emitted.hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: block });
		// The response still validates against the pinned Claude Code contract (systemMessage is a
		// documented universal pass-through field the oracle tolerates).
		const response = assertClaudeCodeUserPromptResponse(JSON.parse(io.out[0]));
		expect(injectedUserPromptContext(response)).toBe(block);
	});

	it("a deduped-only second turn emits the untouched benign `{}` ack (no systemMessage anywhere)", async () => {
		const store = createFakeRecallSessionStore();
		const shim = createClaudeCodeShim({ userPromptMode: "recall" });
		const runtime = recallRuntime(HITS, store);
		const io1 = captureIo(RECALL_STDIN);
		await runHookBinary({ shim, runtime, io: io1 });
		const io2 = captureIo(RECALL_STDIN);
		await runHookBinary({ shim, runtime, io: io2 });
		expect(io2.out).toEqual(["{}"]);
	});

	it("an empty-recall NUDGE turn injects the reminder WITHOUT a systemMessage key", async () => {
		const io = captureIo(RECALL_STDIN);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "recall" }), runtime: recallRuntime([]), io });
		const emitted = JSON.parse(io.out[0]) as Record<string, unknown>;
		expect(emitted.hookSpecificOutput, "the nudge still injects model-facing context").toBeDefined();
		expect("systemMessage" in emitted, "no user notice on a nudge turn").toBe(false);
	});
});

describe("ISS-022: the non-recall ack paths stay byte-identical", () => {
	it("the capture-mode UserPromptSubmit still emits exactly `{}`", async () => {
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: createFakeDaemonHookClient({ status: 201 }),
			notifications: NOOP_NOTIFICATIONS,
		});
		const io = captureIo(
			JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-iss022-bin",
				transcript_path: "conversations/sess-iss022-bin",
				prompt: "what changed in auth?",
			}),
		);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "capture" }), runtime, io });
		expect(io.out).toEqual(["{}"]);
	});

	it("a malformed stdin still emits exactly `{}` (fail-soft, untouched)", async () => {
		const io = captureIo("{ not json");
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "recall" }), runtime: recallRuntime(HITS), io });
		expect(io.out).toEqual(["{}"]);
	});
});

// Silence any unhandled-rejection noise from fire-and-forget paths in this suite.
vi.spyOn(console, "error").mockImplementation(() => undefined);
