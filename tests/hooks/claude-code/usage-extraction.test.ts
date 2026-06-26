/**
 * PRD-060a — Token & Cache Usage Capture (Claude Code first): the EXTRACTION half.
 *
 * Proves the Claude Code shim lowers the per-message `usage` block from a
 * real-shaped transcript message onto the canonical assistant-turn data shape, and
 * that the zero-vs-null discipline holds end to end on the contract side:
 *   - a-AC-1 — a turn with NO usage round-trips with the `usage` field ABSENT
 *     (not zero-filled), and still validates at the daemon's zod boundary.
 *   - a-AC-2 — the four counts (`input_tokens` / `output_tokens` /
 *     `cache_read_input_tokens` / `cache_creation_input_tokens`) land from a
 *     real-shaped transcript message.
 *   - a-AC-6 — a message WITHOUT `usage`, or with a malformed/partial count,
 *     omits the field (or just the bad count) — never a silent 0.
 *
 * The shim is the REFERENCE shim (`createClaudeCodeShim`); extraction is exercised
 * through `normalize(...)` (the real production path) and through the contract's
 * own zod boundary (`parseCaptureRequest`) so the round-trip is asserted, not assumed.
 */

import { describe, expect, it } from "vitest";

import { createClaudeCodeShim, extractTurnUsage, type HookInput } from "../../../src/hooks/index.js";
import { parseCaptureRequest } from "../../../src/daemon/runtime/capture/event-contract.js";

const META = { sessionId: "sess-1", path: "conv-1" } as const;
const ASST = "the token TTL dropped to 1h";

const reference = createClaudeCodeShim();

/** A real-shaped Claude Code `Stop` payload carrying the transcript per-message `usage` block. */
function stopWithUsage(usage: Record<string, unknown>): HookInput {
	return reference.normalize({ name: "Stop", payload: { text: ASST, usage } }, META) as HookInput;
}

/** Wrap a normalized assistant turn into the daemon `CaptureRequest` shape for zod round-trip. */
function captureRequestFor(input: HookInput): unknown {
	return {
		event: input.data,
		metadata: {
			sessionId: "sess-1",
			path: "conv-1",
			org: "o",
			workspace: "ws",
			agent: "claude-code",
		},
	};
}

describe("PRD-060a a-AC-2: the Claude Code shim extracts the four transcript usage counts", () => {
	it("a-AC-2 lowers input/output/cache_read/cache_creation from a real-shaped transcript message", () => {
		// The exact field names Claude Code writes to its transcript JSONL per assistant message.
		const input = stopWithUsage({
			input_tokens: 1200,
			output_tokens: 350,
			cache_read_input_tokens: 8000,
			cache_creation_input_tokens: 64,
		});
		expect(input.event).toBe("assistant_message");
		expect(input.data).toEqual({
			kind: "assistant_message",
			text: ASST,
			usage: { input: 1200, output: 350, cacheRead: 8000, cacheCreation: 64 },
		});
	});

	it("a-AC-2 also reads the nested `message.usage` transcript shape", () => {
		// Some hook wirings surface the per-message usage nested under the assistant `message`.
		const usage = extractTurnUsage({
			message: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 5 } },
		});
		expect(usage).toEqual({ input: 10, output: 20, cacheRead: 0, cacheCreation: 5 });
	});

	it("a-AC-2 the extracted usage round-trips through the daemon zod boundary intact", () => {
		const input = stopWithUsage({ input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9, cache_creation_input_tokens: 10 });
		const parsed = parseCaptureRequest(captureRequestFor(input));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.event).toEqual({
			kind: "assistant_message",
			text: ASST,
			usage: { input: 7, output: 8, cacheRead: 9, cacheCreation: 10 },
		});
	});
});

describe("PRD-060a a-AC-1: a turn with no usage round-trips with the field ABSENT (not zero-filled)", () => {
	it("a-AC-1 a Stop with no usage omits the `usage` key entirely", () => {
		const input = reference.normalize({ name: "Stop", payload: { text: ASST } }, META) as HookInput;
		expect(input.data).toEqual({ kind: "assistant_message", text: ASST });
		expect(Object.prototype.hasOwnProperty.call(input.data, "usage")).toBe(false);
	});

	it("a-AC-1 the no-usage turn still validates at the daemon boundary with usage ABSENT", () => {
		const input = reference.normalize({ name: "Stop", payload: { text: ASST } }, META) as HookInput;
		const parsed = parseCaptureRequest(captureRequestFor(input));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const event = parsed.value.event as Record<string, unknown>;
		expect(event.kind).toBe("assistant_message");
		// ABSENT, not zero-filled: the key is not present after validation.
		expect(Object.prototype.hasOwnProperty.call(event, "usage")).toBe(false);
	});
});

describe("PRD-060a a-AC-6: absent / malformed usage → omitted, never a silent 0", () => {
	it("a-AC-6 an empty usage object yields no `usage` field (all counts absent)", () => {
		expect(extractTurnUsage({ usage: {} })).toBeUndefined();
		const input = stopWithUsage({});
		expect(Object.prototype.hasOwnProperty.call(input.data, "usage")).toBe(false);
	});

	it("a-AC-6 a malformed count is DROPPED, the rest survive (never coerced to 0)", () => {
		const usage = extractTurnUsage({
			usage: {
				input_tokens: -5, // negative → malformed, dropped
				output_tokens: 12.5, // fractional → malformed, dropped
				cache_read_input_tokens: "8000", // string → malformed, dropped
				cache_creation_input_tokens: 64, // valid → survives
			},
		});
		// Only the one valid count survives; the malformed ones are ABSENT, not 0.
		expect(usage).toEqual({ cacheCreation: 64 });
	});

	it("a-AC-6 a genuine measured 0 SURVIVES (zero is distinct from absent)", () => {
		const usage = extractTurnUsage({
			usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		});
        // The real measurement `0` is carried through verbatim, not dropped.
		expect(usage).toEqual({ input: 100, output: 50, cacheRead: 0, cacheCreation: 0 });
	});

	it("a-AC-6 a non-object / absent usage yields undefined", () => {
		expect(extractTurnUsage(undefined)).toBeUndefined();
		expect(extractTurnUsage({})).toBeUndefined();
		expect(extractTurnUsage({ usage: 42 })).toBeUndefined();
		expect(extractTurnUsage({ usage: null })).toBeUndefined();
	});

	it("a-AC-6 the daemon zod boundary REJECTS a malformed count rather than silently zeroing it", () => {
		// If a malformed count ever slipped past the shim into the contract, the boundary
		// rejects it — it never silently becomes 0.
		const bad = parseCaptureRequest({
			event: { kind: "assistant_message", text: ASST, usage: { input: -1 } },
			metadata: { sessionId: "s", path: "p", org: "o", workspace: "w" },
		});
		expect(bad.ok).toBe(false);
	});
});
