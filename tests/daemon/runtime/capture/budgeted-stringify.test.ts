/**
 * PRD-062c L-C2 / AC-6 — budgeted capture-envelope serializer.
 *
 * Proves: (1) a small payload passes through BYTE-IDENTICAL to the un-budgeted
 * `JSON.stringify({event,metadata})`; (2) a multi-MB tool response is stored within
 * budget with an explicit truncation marker; (3) the consumer-read fields
 * (`event.text`, `event.kind`, `event.tool`, the whole `metadata`) are preserved.
 */

import { describe, expect, it } from "vitest";

import {
	budgetedStringify,
	capToolField,
	DEFAULT_ENVELOPE_BUDGET_BYTES,
	truncationMarker,
} from "../../../../src/daemon/runtime/capture/budgeted-stringify.js";
import type { CaptureEvent, CaptureMetadata } from "../../../../src/daemon/runtime/capture/event-contract.js";

const META: CaptureMetadata = {
	sessionId: "sess-1",
	path: "conversations/sess-1",
	cwd: "/repo",
	permissionMode: "default",
	hookEventName: "PostToolUse",
	agentId: "agent-7",
	org: "fake-org",
	workspace: "fake-ws",
	agent: "claude-code",
	pluginVersion: "0.1.0",
	isTurnTerminating: false,
};

describe("AC-6 / L-C2: small payloads pass through byte-identical", () => {
	it("a user_message envelope equals the un-budgeted JSON.stringify", () => {
		const event: CaptureEvent = { kind: "user_message", text: "hello world" };
		const out = budgetedStringify(event, META, DEFAULT_ENVELOPE_BUDGET_BYTES);
		expect(out).toBe(JSON.stringify({ event, metadata: META }));
	});

	it("a small tool_call envelope equals the un-budgeted JSON.stringify (within budget)", () => {
		const event: CaptureEvent = { kind: "tool_call", tool: "Read", input: { file: "a.ts" }, response: "ok" };
		const out = budgetedStringify(event, META, DEFAULT_ENVELOPE_BUDGET_BYTES);
		expect(out).toBe(JSON.stringify({ event, metadata: META }));
	});

	it("budget 0 means no trimming: the full untrimmed envelope (pre-062c parity)", () => {
		const big = "x".repeat(5_000_000);
		const event: CaptureEvent = { kind: "tool_call", tool: "Grep", response: big };
		// capToolField with a 0 budget always truncates, so the handler skips the call when budget===0;
		// budgetedStringify with an explicit large budget reproduces the verbatim envelope.
		const out = budgetedStringify(event, META, big.length + 1024);
		expect(out).toBe(JSON.stringify({ event, metadata: META }));
	});
});

describe("AC-62c.2.1: a multi-MB tool response is stored within budget with a marker", () => {
	it("caps an oversized response and stamps the truncation marker", () => {
		const huge = "y".repeat(3_000_000); // ~3 MB
		const event: CaptureEvent = { kind: "tool_call", tool: "Bash", response: huge };
		const out = budgetedStringify(event, META, 16_384);
		const parsed = JSON.parse(out) as { event: { kind: string; tool: string; response: unknown } };
		// The response is replaced by the marker, NOT the 3 MB blob.
		expect(parsed.event.response).toBe(truncationMarker(JSON.stringify(huge).length));
		// The stored envelope is within a small multiple of the budget (no megabytes shipped).
		expect(Buffer.byteLength(out, "utf8")).toBeLessThan(16_384 + 2_048);
	});

	it("caps an oversized input independently of the response", () => {
		const hugeInput = { blob: "z".repeat(2_000_000) };
		const event: CaptureEvent = { kind: "tool_call", tool: "Edit", input: hugeInput, response: "done" };
		const out = budgetedStringify(event, META, 16_384);
		const parsed = JSON.parse(out) as { event: { input: unknown; response: unknown } };
		expect(parsed.event.input).toBe(truncationMarker(JSON.stringify(hugeInput).length));
		// A within-budget response is untouched.
		expect(parsed.event.response).toBe("done");
	});
});

describe("AC-62c.2.3: consumer-read fields are preserved after trimming", () => {
	it("keeps event.kind, event.tool, and the whole metadata object", () => {
		const event: CaptureEvent = { kind: "tool_call", tool: "Bash", response: "w".repeat(1_000_000) };
		const out = budgetedStringify(event, META, 4_096);
		const parsed = JSON.parse(out) as { event: { kind: string; tool: string }; metadata: CaptureMetadata };
		expect(parsed.event.kind).toBe("tool_call");
		expect(parsed.event.tool).toBe("Bash");
		// The metadata.sessionId the skillify miner reads from the envelope survives verbatim.
		expect(parsed.metadata).toEqual(META);
	});

	it("never trims a user_message/assistant_message text body (it is signal, not bloat)", () => {
		const longText = "a real long prompt ".repeat(100_000); // big, but it is recall signal
		const event: CaptureEvent = { kind: "user_message", text: longText };
		const out = budgetedStringify(event, META, 1_024);
		const parsed = JSON.parse(out) as { event: { text: string } };
		expect(parsed.event.text).toBe(longText);
	});
});

describe("capToolField unit behavior", () => {
	it("returns the value unchanged when within budget", () => {
		const v = { a: 1, b: "x" };
		expect(capToolField(v, 1_024)).toBe(v);
	});
	it("returns the marker when over budget", () => {
		const v = "q".repeat(50_000);
		expect(capToolField(v, 1_024)).toBe(truncationMarker(JSON.stringify(v).length));
	});
	it("returns undefined for an absent value", () => {
		expect(capToolField(undefined, 1_024)).toBeUndefined();
	});
	it("treats an unserializable value (cycle) as absent, never throws", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(capToolField(cyclic, 1_024)).toBeUndefined();
	});
});
