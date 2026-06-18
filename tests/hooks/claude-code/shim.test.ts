/**
 * PRD-019c c-AC-1 — every harness produces the SAME normalized HookInput → the SAME
 * fake-core daemon calls as the Claude Code REFERENCE (FR-1 / D-4).
 *
 * This is the keystone equivalence suite. Each harness's NATIVE event (in its own
 * field names) is normalized through its shim, then dispatched through the 019b core
 * (`runCapture`) against a recording daemon fake. The resulting daemon call body MUST
 * equal the reference's for the same logical event — that is what "same daemon-written
 * rows as the Claude Code reference" means at the thin-client boundary (the daemon is
 * the same; identical inbound bodies ⇒ identical rows).
 *
 * Equivalence is asserted STRUCTURALLY: every shim is built on the SAME `createShim`
 * engine (`src/hooks/normalize.ts`) over a per-harness `ShimSpec`, so the only thing
 * that can differ is what the spec declares. The test parameterizes across all shims
 * for the events each one maps natively.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	type HarnessShim,
	type HookCoreDeps,
	type HookInput,
	type HookSessionMeta,
	type LogicalEvent,
	type NativeEvent,
} from "../../../src/hooks/index.js";
import {
	createClaudeCodeShim,
	createCodexShim,
	createCursorShim,
	createHermesShim,
	createOpenClawShim,
	createPiShim,
} from "../../../src/hooks/index.js";
import { runCapture } from "../../../src/hooks/shared/capture.js";

const META: HookSessionMeta = { sessionId: "sess-1", path: "conv-1" };

function deps(): { deps: HookCoreDeps; daemon: ReturnType<typeof createFakeDaemonHookClient> } {
	const daemon = createFakeDaemonHookClient();
	return {
		daemon,
		deps: {
			daemon,
			credentials: createFakeCredentialReader({ token: "t", org: "o", actor: "u" }),
			context: createFakeContextRenderer(""),
		},
	};
}

/** Dispatch a normalized input through the core and return the recorded daemon body. */
async function captureBody(input: HookInput): Promise<unknown> {
	const { deps: d, daemon } = deps();
	await runCapture(input, d, {});
	expect(daemon.calls).toHaveLength(1);
	return daemon.calls[0].body;
}

/** The reference shim and its baseline native events (Claude Code's hook payload shapes). */
const reference = createClaudeCodeShim();

/** Native events per harness, all carrying the SAME logical content for a given event. */
interface NativeFixture {
	readonly shim: HarnessShim;
	/** native event name → NativeEvent payload, in that harness's field names. */
	readonly events: Partial<Record<LogicalEvent, NativeEvent>>;
}

const userText = "what changed in auth?";
const asstText = "the token TTL dropped to 1h";

const fixtures: readonly NativeFixture[] = [
	{
		shim: reference,
		events: {
			user_message: { name: "UserPromptSubmit", payload: { prompt: userText } },
			tool_call: { name: "PostToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" } },
			assistant_message: { name: "Stop", payload: { text: asstText } },
		},
	},
	{
		shim: createCodexShim(),
		events: {
			user_message: { name: "UserPromptSubmit", payload: { prompt: userText } },
			tool_call: { name: "PostToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" } },
			assistant_message: { name: "Stop", payload: { text: asstText } },
		},
	},
	{
		shim: createCursorShim(),
		events: {
			user_message: { name: "beforeSubmitPrompt", payload: { prompt: userText } },
			tool_call: { name: "postToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" } },
			assistant_message: { name: "afterAgentResponse", payload: { text: asstText } },
		},
	},
	{
		shim: createHermesShim(),
		events: {
			user_message: { name: "on_user_message", payload: { message: userText } },
			// Hermes captures terminal tools only (FR-6); a terminal tool_use is equivalent
			// to the reference's tool_call for the same tool.
			tool_call: { name: "on_tool_use", payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" } },
		},
	},
];

describe("PRD-019c c-AC-1: harness equivalence to the Claude Code reference", () => {
	it("c-AC-1 every harness maps native event names onto the SAME logical events", () => {
		expect(reference.mapEvent("UserPromptSubmit")).toBe<LogicalEvent>("user_message");
		expect(createCodexShim().mapEvent("UserPromptSubmit")).toBe<LogicalEvent>("user_message");
		expect(createCursorShim().mapEvent("beforeSubmitPrompt")).toBe<LogicalEvent>("user_message");
		expect(createHermesShim().mapEvent("on_user_message")).toBe<LogicalEvent>("user_message");
		expect(createOpenClawShim().mapEvent("agent_end")).toBe<LogicalEvent>("session-end");
		expect(createPiShim().mapEvent("session_shutdown")).toBe<LogicalEvent>("session-end");
		// A non-lifecycle name maps to undefined (dropped) on every shim.
		expect(reference.mapEvent("NotAnEvent")).toBeUndefined();
		expect(createCursorShim().mapEvent("NotAnEvent")).toBeUndefined();
	});

	it("c-AC-1 a user_message normalizes to the SAME daemon body across harnesses", async () => {
		const refEvent = reference.normalize(
			{ name: "UserPromptSubmit", payload: { prompt: userText } },
			META,
		);
		expect(refEvent).toBeDefined();
		const refBody = await captureBody(refEvent as HookInput);
		// The reference body's event payload is the canonical `{ kind:"user_message", text }`.
		expect((refBody as { event: unknown }).event).toEqual({ kind: "user_message", text: userText });

		for (const { shim, events } of fixtures) {
			const native = events.user_message;
			if (!native) continue;
			const input = shim.normalize(native, META);
			expect(input, `${shim.harness} user_message`).toBeDefined();
			const body = await captureBody(input as HookInput);
			// SAME event payload as the reference (the daemon writes the same row).
			expect((body as { event: unknown }).event, shim.harness).toEqual((refBody as { event: unknown }).event);
		}
	});

	it("c-AC-1 a tool_call normalizes to the SAME daemon body across harnesses", async () => {
		const refInput = reference.normalize(
			{ name: "PostToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" } },
			META,
		) as HookInput;
		const refBody = await captureBody(refInput);
		expect((refBody as { event: unknown }).event).toEqual({
			kind: "tool_call",
			tool: "Bash",
			input: { command: "ls" },
			response: "ok",
		});

		for (const { shim, events } of fixtures) {
			const native = events.tool_call;
			if (!native) continue;
			const input = shim.normalize(native, META) as HookInput;
			const body = await captureBody(input);
			expect((body as { event: unknown }).event, shim.harness).toEqual((refBody as { event: unknown }).event);
		}
	});

	it("c-AC-1 the runtime-path header is stamped on every harness's daemon call (FR-10)", async () => {
		const { deps: d, daemon } = deps();
		const cc = reference.normalize({ name: "UserPromptSubmit", payload: { prompt: userText } }, META) as HookInput;
		await runCapture(cc, d, {});
		expect(daemon.calls[0].runtimePath).toBe("legacy"); // Claude Code hook script.

		const { deps: d2, daemon: dm2 } = deps();
		const cur = createCursorShim().normalize({ name: "beforeSubmitPrompt", payload: { prompt: userText } }, META) as HookInput;
		await runCapture(cur, d2, {});
		expect(dm2.calls[0].runtimePath).toBe("plugin"); // Cursor runtime extension.
	});

	it("c-AC-1 a dropped (non-lifecycle) native event normalizes to undefined", () => {
		expect(reference.normalize({ name: "NotAnEvent", payload: {} }, META)).toBeUndefined();
		// Hermes drops a non-terminal tool_use (terminal-only, FR-6) → no capture.
		expect(createHermesShim().normalize({ name: "on_tool_use", payload: { tool_name: "Browser" } }, META)).toBeUndefined();
		// Codex drops a non-Bash PreToolUse (Bash-only, FR-3).
		expect(createCodexShim().normalize({ name: "PreToolUse", payload: { tool_name: "Read" } }, META)).toBeUndefined();
	});
});
