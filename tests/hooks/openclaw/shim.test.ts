/**
 * PRD-019c OpenClaw shim suite — c-AC-3 (new-slice batch) + c-AC-2 (CLI fallback).
 *
 * Driven against the 019b recording fakes. c-AC-3: OpenClaw's `agent_end` flushes
 * ONLY the new-message slice since the last flush, and the resulting daemon rows
 * match incremental capture. c-AC-2: OpenClaw has NO pre-tool hook, so a goal/KPI
 * write routes through the injected `CliFallback` rather than being dropped.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeCliFallback,
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	type HookCoreDeps,
} from "../../../src/hooks/index.js";
import {
	createClaudeCodeShim,
	createOpenClawShim,
	type OpenClawMessage,
	openclawDeriveMeta,
	openclawExpandBatch,
	openclawGoalKpiFallback,
	openclawSliceSinceLastFlush,
} from "../../../src/hooks/index.js";
import { runCapture, runCaptureBatch } from "../../../src/hooks/shared/capture.js";

function deps(): { deps: HookCoreDeps; daemon: ReturnType<typeof createFakeDaemonHookClient> } {
	const daemon = createFakeDaemonHookClient();
	return {
		daemon,
		deps: {
			daemon,
			credentials: createFakeCredentialReader({ token: "t" }),
			context: createFakeContextRenderer(""),
		},
	};
}

const META = { sessionId: "agent:alice:run-7", path: "conv-7" };

const conversation: readonly OpenClawMessage[] = [
	{ role: "user", text: "hi" },
	{ role: "assistant", text: "hello" },
	{ role: "tool", tool: "Read", input: { file_path: "x.ts" }, response: "ok" },
	{ role: "user", text: "and now?" },
	{ role: "assistant", text: "done" },
];

describe("PRD-019c OpenClaw shim", () => {
	it("c-AC-3 agent_end sends ONLY the new-message slice since the last flush", async () => {
		// First flush: cursor 0 → the first three messages arrived.
		const first = openclawSliceSinceLastFlush(conversation.slice(0, 3), 0);
		expect(first.slice).toHaveLength(3);
		expect(first.nextCursor).toBe(3);

		// Second flush: cursor 3 → ONLY the two NEW messages, not the first three.
		const second = openclawSliceSinceLastFlush(conversation, first.nextCursor);
		expect(second.slice).toEqual([
			{ role: "user", text: "and now?" },
			{ role: "assistant", text: "done" },
		]);
		expect(second.nextCursor).toBe(5);
	});

	it("c-AC-3 the batched new-slice produces the SAME daemon rows as incremental capture", async () => {
		// Incremental: each message captured one at a time via the reference shim.
		const inc = deps();
		const ref = createClaudeCodeShim();
		await runCapture(ref.normalize({ name: "UserPromptSubmit", payload: { prompt: "hi" } }, META)!, inc.deps, {});
		await runCapture(ref.normalize({ name: "Stop", payload: { text: "hello" } }, META)!, inc.deps, {});

		// Batched: OpenClaw flushes the same two-message slice at agent_end.
		const batch = deps();
		const slice: readonly OpenClawMessage[] = [
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "hello" },
		];
		const inputs = openclawExpandBatch(slice, META);
		const results = await runCaptureBatch(inputs, batch.deps, {});

		// Same endpoints, same event payloads, in order — identical daemon rows (b-AC-1).
		expect(batch.daemon.calls.map((c) => c.endpoint)).toEqual(["capture", "capture"]);
		expect(batch.daemon.calls.map((c) => (c.body as { event: unknown }).event)).toEqual(
			inc.daemon.calls.map((c) => (c.body as { event: unknown }).event),
		);
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it("c-AC-3 the agent is auto-routed from the session key (agent:alice:...)", () => {
		const meta = openclawDeriveMeta(undefined, META);
		expect(meta.agent).toBe("alice");
		expect(meta.agentId).toBe("alice");
		// The batch inputs carry the routed agent on every row.
		const inputs = openclawExpandBatch([{ role: "user", text: "hi" }], META);
		expect(inputs[0].meta.agent).toBe("alice");
	});

	it("c-AC-3 a non-namespaced session key leaves the agent unchanged", () => {
		const meta = openclawDeriveMeta(undefined, { sessionId: "plain-session" });
		expect(meta.agent).toBeUndefined();
	});

	it("c-AC-2 a goal write with no pre-tool hook falls back to a CLI call", async () => {
		const cli = createFakeCliFallback();
		const result = await openclawGoalKpiFallback(cli, "goal", ["add", "ship v2"]);
		expect(result.code).toBe(0);
		// The action was routed to the CLI, not dropped.
		expect(cli.runs).toEqual([["honeycomb", "goal", "add", "ship v2"]]);
	});

	it("c-AC-2 a kpi write also falls back to a CLI call", async () => {
		const cli = createFakeCliFallback();
		await openclawGoalKpiFallback(cli, "kpi", ["set", "latency", "120ms"]);
		expect(cli.runs).toEqual([["honeycomb", "kpi", "set", "latency", "120ms"]]);
	});

	it("c-AC-3 OpenClaw maps before_agent_start + before_prompt_build to session-start, agent_end to session-end, and has NO PreToolUse", () => {
		const shim = createOpenClawShim();
		expect(shim.mapEvent("before_agent_start")).toBe("session-start");
		expect(shim.mapEvent("before_prompt_build")).toBe("session-start");
		expect(shim.mapEvent("agent_end")).toBe("session-end");
		expect(shim.mapEvent("PreToolUse")).toBeUndefined(); // tools are registered, not hooked.
	});
});
