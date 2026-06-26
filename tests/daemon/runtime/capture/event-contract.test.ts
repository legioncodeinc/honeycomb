/**
 * PRD-005a — capture event-contract (zod boundary) tests (FR-2 / FR-5 / FR-10).
 *
 * The contract is the external boundary: it validates the three normalized event
 * kinds + the session metadata and rejects a malformed payload. These pin the
 * accepted shapes (including the OpenClaw-normalized tool_call) and the rejection
 * of anything outside the contract.
 */

import { describe, expect, it } from "vitest";

import { CAPTURE_EVENT_KINDS, parseCaptureRequest } from "../../../../src/daemon/runtime/capture/event-contract.js";

const metadata = {
	sessionId: "sess-1",
	path: "conversations/sess-1",
	org: "acme",
	workspace: "main",
};

describe("event contract (FR-2 / FR-5)", () => {
	it("declares exactly the three normalized kinds (FR-2)", () => {
		expect([...CAPTURE_EVENT_KINDS]).toEqual(["user_message", "tool_call", "assistant_message"]);
	});

	it("accepts a user_message and defaults optional metadata", () => {
		const r = parseCaptureRequest({ event: { kind: "user_message", text: "hi" }, metadata });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.event.kind).toBe("user_message");
			expect(r.value.metadata.agentId).toBe("default"); // default applied
			expect(r.value.metadata.isTurnTerminating).toBe(false); // default applied
		}
	});

	it("accepts a tool_call with tool name + input + response", () => {
		const r = parseCaptureRequest({
			event: { kind: "tool_call", tool: "grep", input: { q: "x" }, response: { hits: 1 } },
			metadata,
		});
		expect(r.ok).toBe(true);
	});

	it("accepts an assistant_message", () => {
		const r = parseCaptureRequest({ event: { kind: "assistant_message", text: "done" }, metadata });
		expect(r.ok).toBe(true);
	});

	it("rejects an unknown event kind (FR-2 boundary)", () => {
		const r = parseCaptureRequest({ event: { kind: "system", text: "x" }, metadata });
		expect(r.ok).toBe(false);
	});

	it("rejects a tool_call missing its tool name", () => {
		const r = parseCaptureRequest({ event: { kind: "tool_call" }, metadata });
		expect(r.ok).toBe(false);
	});

	it("rejects a request missing the org/workspace scope (FR-5: no unscoped capture)", () => {
		const r = parseCaptureRequest({
			event: { kind: "user_message", text: "hi" },
			metadata: { sessionId: "s", path: "p" },
		});
		expect(r.ok).toBe(false);
	});

	it("rejects a non-object body", () => {
		expect(parseCaptureRequest(null).ok).toBe(false);
		expect(parseCaptureRequest("nope").ok).toBe(false);
	});

	// Finding (empty-usage): an EMPTY `usage: {}` carries no information and must normalize to ABSENT
	// (undefined), so a no-usage turn never persists a distinct "present but empty" usage block.
	it("normalizes an empty `usage: {}` to ABSENT (the turn validates, usage is undefined)", () => {
		const r = parseCaptureRequest({ event: { kind: "assistant_message", text: "done", usage: {} }, metadata });
		expect(r.ok).toBe(true);
		if (r.ok && r.value.event.kind === "assistant_message") {
			// `{}` was normalized away -> the field round-trips ABSENT, not an empty object.
			expect(r.value.event.usage).toBeUndefined();
		}
	});

	it("keeps a usage block with at least one count (does not normalize a real partial usage away)", () => {
		const r = parseCaptureRequest({ event: { kind: "assistant_message", text: "done", usage: { input: 42 } }, metadata });
		expect(r.ok).toBe(true);
		if (r.ok && r.value.event.kind === "assistant_message") {
			expect(r.value.event.usage).toBeDefined();
			expect(r.value.event.usage?.input).toBe(42);
		}
	});
});
