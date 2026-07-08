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
 * PRD-076a - the per-turn recall injector: coexistence, envelope, throttle/dedupe, regression.
 *
 *   - a-AC-4: on `UserPromptSubmit`, the injector path returns `{ ok, additionalContext }` and the
 *     binary renders it to stdout; the async capture path still stores the turn (Option A).
 *   - a-AC-5: `renderContext` emits `additionalContext` under `hookSpecificOutput` with
 *     `hookEventName: "UserPromptSubmit"` for the recall arm; the session-start envelope is unchanged.
 *   - a-AC-6: injection is deduped across turns - a repeated overlapping recall does not re-inject.
 *   - a-AC-7: an empty recall injects at most the throttled nudge (or nothing), never a malformed block.
 *   - a-AC-8: no session-start regression - the per-turn arm never runs on session-start.
 */

import { describe, expect, it, vi } from "vitest";

import { type BinaryIo, runHookBinary } from "../../../../src/hooks/binary.js";
import { createClaudeCodeShim } from "../../../../src/hooks/claude-code/shim.js";
import { createHookRuntime } from "../../../../src/hooks/runtime.js";
import {
	createFakeCredentialReader,
	createFakePrimeRenderer,
	createFakeRecallRenderer,
	createFakeRecallSessionStore,
	type DaemonHookClient,
	type DaemonHookRequest,
	type DaemonHookResponse,
	type HookSessionMeta,
	type RecallHit,
	type RecallRenderer,
	RECALL_BLOCK_HEADER,
	RECALL_REMINDER,
} from "../../../../src/hooks/shared/index.js";
import type { NotificationsPipeline } from "../../../../src/notifications/index.js";
import {
	assertClaudeCodeUserPromptResponse,
	injectedUserPromptContext,
	isNoInjection,
} from "../../../../references/claude-code/userprompt-response-schema.js";

const META: HookSessionMeta = {
	sessionId: "sess-076a",
	path: "conversations/sess-076a",
	cwd: "/repo/honeycomb",
	agent: "claude-code",
};

const CRED = createFakeCredentialReader({ token: "t", org: "acme", workspace: "ws-1", actor: "agent-1" });

/** A no-op notifications pipeline so runtime-level tests never touch a real daemon drain. */
const NOOP_NOTIFICATIONS: NotificationsPipeline = {
	async drain() {
		return { banner: null, suppressed: [] };
	},
};

/** A recording DaemonHookClient: records every send + returns 201 (capture ack). */
function recordingClient(): { client: DaemonHookClient; calls: DaemonHookRequest[] } {
	const calls: DaemonHookRequest[] = [];
	const client: DaemonHookClient = {
		async send(req: DaemonHookRequest): Promise<DaemonHookResponse> {
			calls.push(req);
			return { status: 201, body: { ok: true } };
		},
	};
	return { client, calls };
}

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

const HITS: readonly RecallHit[] = [
	{ ref: "memories:m1", text: "Token TTL dropped to 1h (decided 2026-07-01)." },
	{ ref: "sessions:s9", text: "auth refactor thread" },
];

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-4 - coexistence: the sync injector injects; the async capture still stores.
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-4: the sync recall injector and the async capture coexist on UserPromptSubmit (Option A)", () => {
	it("a-AC-4: the injector (recall mode) renders the recall hits to stdout", async () => {
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: recordingClient().client,
			notifications: NOOP_NOTIFICATIONS,
			recall: createFakeRecallRenderer(HITS),
			recallStore: createFakeRecallSessionStore(),
		});
		const io = captureIo(
			JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-076a",
				cwd: "/repo/honeycomb",
				prompt: "what changed in auth?",
			}),
		);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "recall" }), runtime, io });

		expect(io.out).toHaveLength(1);
		const response = assertClaudeCodeUserPromptResponse(JSON.parse(io.out[0]));
		const injected = injectedUserPromptContext(response);
		expect(injected).toContain(RECALL_BLOCK_HEADER);
		expect(injected).toContain("Token TTL dropped to 1h (decided 2026-07-01).");
		expect(injected).toContain("auth refactor thread");
	});

	it("a-AC-4: the injector makes NO daemon capture call (recall mode never captures)", async () => {
		const { client, calls } = recordingClient();
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: client,
			notifications: NOOP_NOTIFICATIONS,
			recall: createFakeRecallRenderer(HITS),
			recallStore: createFakeRecallSessionStore(),
		});
		const io = captureIo(
			JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-076a", prompt: "auth?" }),
		);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "recall" }), runtime, io });
		expect(calls, "the recall injector does not POST a capture").toHaveLength(0);
	});

	it("a-AC-4: the async capture entry (capture mode) still POSTs the captured turn", async () => {
		const { client, calls } = recordingClient();
		const runtime = createHookRuntime({ credentials: CRED, daemon: client, notifications: NOOP_NOTIFICATIONS });
		const io = captureIo(
			JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-076a",
				transcript_path: "conversations/sess-076a",
				prompt: "what changed in auth?",
			}),
		);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "capture" }), runtime, io });

		expect(calls, "the capture entry POSTed the turn").toHaveLength(1);
		expect(calls[0].endpoint).toBe("capture");
		expect((calls[0].body as { event: unknown }).event).toEqual({
			kind: "user_message",
			text: "what changed in auth?",
		});
		// Capture returns no additionalContext → the benign `{}` ack.
		expect(io.out).toEqual(["{}"]);
	});

	it("a-AC-4: the two modes map UserPromptSubmit to different logical events (the coexistence split)", () => {
		expect(createClaudeCodeShim({ userPromptMode: "capture" }).mapEvent("UserPromptSubmit")).toBe("user_message");
		expect(createClaudeCodeShim({ userPromptMode: "recall" }).mapEvent("UserPromptSubmit")).toBe("user_prompt_recall");
		// The recall injector drops every OTHER native event (registered only under UserPromptSubmit).
		expect(createClaudeCodeShim({ userPromptMode: "recall" }).mapEvent("PreToolUse")).toBeUndefined();
		expect(createClaudeCodeShim({ userPromptMode: "recall" }).mapEvent("SessionStart")).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-5 - the event-aware envelope: UserPromptSubmit under hookSpecificOutput,
// session-start unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-5: renderContext is event-aware (UserPromptSubmit hookSpecificOutput; SessionStart unchanged)", () => {
	it("a-AC-5: the recall arm wraps additionalContext under hookSpecificOutput.hookEventName=UserPromptSubmit", () => {
		const env = createClaudeCodeShim({ userPromptMode: "recall" }).renderContext("HITS-BLOCK");
		expect(env.channel).toBe("model-only");
		if (env.channel === "model-only") {
			expect(env.hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: "HITS-BLOCK" });
		}
		// It conforms to the pinned Claude Code UserPromptSubmit oracle.
		const response = assertClaudeCodeUserPromptResponse(JSON.parse(JSON.stringify(env)));
		expect(injectedUserPromptContext(response)).toBe("HITS-BLOCK");
	});

	it("a-AC-5: the session-start (capture-mode) envelope is UNCHANGED - flat, no hookSpecificOutput", () => {
		const env = createClaudeCodeShim({ userPromptMode: "capture" }).renderContext("PRIME-BLOCK");
		expect(env).toEqual({ channel: "model-only", additionalContext: "PRIME-BLOCK" });
		if (env.channel === "model-only") {
			expect(env.hookSpecificOutput, "session-start carries no hookSpecificOutput (a-AC-8)").toBeUndefined();
		}
	});

	it("a-AC-5: the recall envelope reaches stdout under hookSpecificOutput through the binary", async () => {
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: recordingClient().client,
			notifications: NOOP_NOTIFICATIONS,
			recall: createFakeRecallRenderer(HITS),
			recallStore: createFakeRecallSessionStore(),
		});
		const io = captureIo(
			JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-076a", prompt: "auth?" }),
		);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "recall" }), runtime, io });
		const emitted = JSON.parse(io.out[0]) as { hookSpecificOutput?: { hookEventName?: string } };
		expect(emitted.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-6 - throttle + dedupe: a repeated overlapping recall does not re-inject.
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-6: injection is deduped across turns (no double-injection of the same hit)", () => {
	it("a-AC-6: turn 1 injects the hits; turn 2 with the SAME hits injects nothing new", async () => {
		const store = createFakeRecallSessionStore();
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: recordingClient().client,
			notifications: NOOP_NOTIFICATIONS,
			recall: createFakeRecallRenderer(HITS), // both turns return the SAME [A, B].
			recallStore: store,
		});
		const shim = createClaudeCodeShim({ userPromptMode: "recall" });

		const turn1 = await runtime.runEvent(shim, { name: "UserPromptSubmit", payload: { prompt: "auth?" } }, META);
		expect(turn1.result.additionalContext, "turn 1 injects the hits").toContain("Token TTL dropped to 1h");

		const turn2 = await runtime.runEvent(shim, { name: "UserPromptSubmit", payload: { prompt: "auth again?" } }, META);
		// Every hit was already injected on turn 1 → nothing new, and no nudge (recall DID return hits).
		expect(turn2.result.additionalContext, "turn 2 does not re-inject the same hits").toBeUndefined();
	});

	it("a-AC-6: turn 2 injects ONLY the new hit when the overlap carries one fresh hit", async () => {
		const store = createFakeRecallSessionStore();
		// Turn 1 sees [A, B]; turn 2 sees [A, B, C] (C is new). Only C should be injected on turn 2.
		let call = 0;
		const stepped: RecallRenderer = {
			async render() {
				call += 1;
				return call === 1 ? HITS : [...HITS, { ref: "memories:m3", text: "new decision C" }];
			},
		};
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: recordingClient().client,
			notifications: NOOP_NOTIFICATIONS,
			recall: stepped,
			recallStore: store,
		});
		const shim = createClaudeCodeShim({ userPromptMode: "recall" });
		await runtime.runEvent(shim, { name: "UserPromptSubmit", payload: { prompt: "auth?" } }, META);
		const turn2 = await runtime.runEvent(shim, { name: "UserPromptSubmit", payload: { prompt: "auth?" } }, META);
		const injected = turn2.result.additionalContext ?? "";
		expect(injected).toContain("new decision C");
		expect(injected, "the already-injected hits are not re-injected").not.toContain("Token TTL dropped to 1h");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-7 - empty recall → the throttled nudge (or nothing), never a malformed block.
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-7: an empty recall injects at most the throttled reminder nudge (or nothing)", () => {
	it("a-AC-7: turn 1 with no hits injects the reminder nudge; turn 2 (still empty) is throttled off", async () => {
		const store = createFakeRecallSessionStore();
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: recordingClient().client,
			notifications: NOOP_NOTIFICATIONS,
			recall: createFakeRecallRenderer([]), // empty recall every turn.
			recallStore: store,
		});
		const shim = createClaudeCodeShim({ userPromptMode: "recall" });

		const turn1 = await runtime.runEvent(shim, { name: "UserPromptSubmit", payload: { prompt: "hello?" } }, META);
		expect(turn1.result.additionalContext, "the nudge fires on the first empty turn").toBe(RECALL_REMINDER);

		const turn2 = await runtime.runEvent(shim, { name: "UserPromptSubmit", payload: { prompt: "hello again?" } }, META);
		expect(turn2.result.additionalContext, "the nudge does NOT fire every turn (throttled)").toBeUndefined();
	});

	it("a-AC-7: an empty-recall no-nudge turn serializes to the benign no-injection ack (never malformed)", async () => {
		const store = createFakeRecallSessionStore();
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: recordingClient().client,
			notifications: NOOP_NOTIFICATIONS,
			recall: createFakeRecallRenderer([]),
			recallStore: store,
		});
		const shim = createClaudeCodeShim({ userPromptMode: "recall" });
		// Turn 1 nudges; turn 2 is throttled off → the binary emits the benign `{}` ack.
		const io1 = captureIo(
			JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-076a", prompt: "hi" }),
		);
		await runHookBinary({ shim, runtime, io: io1 });
		const io2 = captureIo(
			JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-076a", prompt: "hi" }),
		);
		await runHookBinary({ shim, runtime, io: io2 });
		expect(io2.out).toEqual(["{}"]);
		expect(isNoInjection(assertClaudeCodeUserPromptResponse(JSON.parse(io2.out[0])))).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// a-AC-8 - no session-start regression: the per-turn arm never runs on session-start.
// ─────────────────────────────────────────────────────────────────────────────

describe("a-AC-8: no session-start regression - the recall arm never runs on session-start", () => {
	it("a-AC-8: session-start emits the flat model-only envelope (unchanged) and never calls recall", async () => {
		let recallCalls = 0;
		const countingRecall: RecallRenderer = {
			async render() {
				recallCalls += 1;
				return HITS;
			},
		};
		const { client } = recordingClient();
		// The daemon /context render returns the rules/goals block via the recording client.
		const contextClient: DaemonHookClient = {
			async send() {
				return { status: 200, body: { additionalContext: "RULES: be concise." } };
			},
		};
		void client;
		const runtime = createHookRuntime({
			credentials: CRED,
			daemon: contextClient,
			notifications: NOOP_NOTIFICATIONS,
			prime: createFakePrimeRenderer(""),
			recall: countingRecall,
			recallStore: createFakeRecallSessionStore(),
			onboardingNotice: { hasBoundProject: () => true },
		});
		const io = captureIo(
			JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-076a", source: "startup" }),
		);
		await runHookBinary({ shim: createClaudeCodeShim({ userPromptMode: "capture" }), runtime, io });

		expect(recallCalls, "the per-turn recall arm never runs on session-start").toBe(0);
		expect(io.out).toHaveLength(1);
		const envelope = JSON.parse(io.out[0]) as {
			channel: string;
			additionalContext: string;
			hookSpecificOutput?: unknown;
		};
		expect(envelope.channel).toBe("model-only");
		expect(envelope.additionalContext).toBe("RULES: be concise.");
		expect(envelope.hookSpecificOutput, "session-start stays flat (no hookSpecificOutput)").toBeUndefined();
	});
});

// Silence any unhandled-rejection noise from fire-and-forget paths in this suite.
vi.spyOn(console, "error").mockImplementation(() => undefined);
