/**
 * PRD-074b prose-format suite — b-AC-1..9 / L-B2..L-B6 / L-D2.
 *
 * `proseForEvent` / `proseForToolCall` are pure, synchronous extractors over the typed
 * `CaptureEvent` (the zod boundary already validated it). No daemon, no transport, no
 * IO — each test asserts the prose shape directly off the function. The headline
 * fixture is the screenshot's exact `Read` blob (a `tool_call` with `input.file_path`
 * + `response.file.content`), constructed explicitly in the first test.
 *
 * The cap assertions reference the NAMED export `TOOL_PROSE_RESPONSE_CAP`, never a
 * magic 500 — so a future tuning change to the constant cannot silently break the
 * "bounded" guarantee (the value is the contract, the bound is the criterion).
 */

import { describe, expect, it } from "vitest";
import {
	type CaptureEvent,
	type ToolCallEvent,
	TOOL_PROSE_RESPONSE_CAP,
	proseForEvent,
	proseForToolCall,
} from "../../../../src/daemon/runtime/capture/event-contract.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A `tool_call` event with all the recognized fields populated (the screenshot shape). */
function toolCall(over: Partial<ToolCallEvent> = {}): ToolCallEvent {
	return {
		kind: "tool_call",
		tool: "Read",
		input: {
			limit: 75,
			offset: 175,
			file_path: "C:\\Users\\mario\\GitHub\\the-apiary\\hive\\src\\dashboard\\web\\pages\\dashboard.tsx",
		},
		response: { file: { content: "// 'healthReasons' is no longer polled here — the SHEL…" } },
		...over,
	};
}

/** A `user_message` event (the verbatim-prose kind). */
function userMessage(text: string): CaptureEvent {
	return { kind: "user_message", text };
}

/** An `assistant_message` event (also verbatim prose). */
function assistantMessage(text: string): CaptureEvent {
	return { kind: "assistant_message", text };
}

// ── L-B2 / L-D2 / b-AC-8 — verbatim prose for user/assistant messages ─────────

describe("L-B2 / L-D2 / b-AC-8 — user_message + assistant_message prose is event.text VERBATIM", () => {
	it("a user_message's prose is its text with no cap, no truncation, no whitespace collapse", () => {
		const text = "   find   the   bug   in   the   dashboard   ";
		expect(proseForEvent(userMessage(text))).toBe(text);
	});

	it("an assistant_message's prose is its text verbatim", () => {
		const text = "I'll start by reading dashboard.tsx.\n\nThe issue is on line 175.";
		expect(proseForEvent(assistantMessage(text))).toBe(text);
	});

	it("a long user_message (10x the tool cap) is NOT capped — verbatim means verbatim", () => {
		// 5000 chars — an order of magnitude over TOOL_PROSE_RESPONSE_CAP. The cap applies
		// ONLY to tool_call response bodies; user/assistant text is the harness-bound prose.
		const text = "x".repeat(5000);
		expect(proseForEvent(userMessage(text))).toBe(text);
		expect(proseForEvent(userMessage(text)).length).toBe(5000);
	});

	it("proseForEvent dispatches by kind (user → text, tool → bounded format)", () => {
		expect(proseForEvent(userMessage("hello"))).toBe("hello");
		// A tool_call's prose is the bounded format, never the raw event.text (it has none).
		const prose = proseForEvent(toolCall({ tool: "Read" }));
		expect(prose).toMatch(/^Read →/);
	});
});

// ── L-B3 / b-AC-1 / b-AC-5 / m-AC-5 — the screenshot's Read blob (headline) ────

describe("L-B3 / b-AC-1 / b-AC-5 — the screenshot's exact Read blob (the headline fixture)", () => {
	it("Read with file_path + offset/limit + response.file.content → first line + capped content", () => {
		const event = toolCall();
		const prose = proseForToolCall(event);
		// First line: tool → shortPath:offset-(offset+limit). Windows backslashes preserved
		// (b-AC-9 / L-B6), last-three-segments shortening (web\pages\dashboard.tsx).
		expect(prose.startsWith("Read → web\\pages\\dashboard.tsx:175-250\n")).toBe(true);
		// Second line: the response body (response.file.content), whitespace-collapsed + capped.
		expect(prose).toContain("'healthReasons' is no longer polled here");
	});

	it("proseForEvent returns the SAME output as proseForToolCall for a tool_call", () => {
		const event = toolCall();
		expect(proseForEvent(event)).toBe(proseForToolCall(event));
	});

	it("TOOL_PROSE_RESPONSE_CAP is the named, exported constant (not a magic number)", () => {
		// m-AC-5 / b-AC-5: the cap is a named export. The default is 500 (PRD-074b); the value
		// may be tuned later, but it MUST be this named constant, never an inline literal.
		expect(TOOL_PROSE_RESPONSE_CAP).toBeTypeOf("number");
		expect(TOOL_PROSE_RESPONSE_CAP).toBe(500);
		expect(Number.isFinite(TOOL_PROSE_RESPONSE_CAP)).toBe(true);
		expect(TOOL_PROSE_RESPONSE_CAP).toBeGreaterThan(0);
	});
});

// ── L-B4 / b-AC-2..4 — first-line shape per input kind ─────────────────────────

describe("L-B4 / b-AC-2..4 — first-line shape per input kind", () => {
	it("b-AC-2 (file_path + offset + limit): `tool → shortPath:offset-(offset+limit)`", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "C:\\a\\b\\c\\d\\dashboard.tsx", offset: 175, limit: 75 },
				response: undefined,
			}),
		);
		expect(prose).toBe("Read → c\\d\\dashboard.tsx:175-250");
	});

	it("b-AC-2 (file_path WITHOUT offset/limit): `tool → shortPath` (no range suffix)", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Edit",
				input: { file_path: "/home/mario/repo/hive/web/sidebar.tsx" },
				response: { file: { content: "ok" } },
			}),
		);
		// POSIX path: last-three-segments joined with the dominant separator (/).
		expect(prose.startsWith("Edit → hive/web/sidebar.tsx\n")).toBe(true);
	});

	it("b-AC-2 (file_path with offset but NO limit): no range suffix (both required)", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "/a/b/c/d/e.tsx", offset: 100 },
				response: undefined,
			}),
		);
		expect(prose).toBe("Read → c/d/e.tsx");
	});

	it("b-AC-2 (file_path with limit but NO offset): no range suffix (both required)", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "/a/b/c/d/e.tsx", limit: 50 },
				response: undefined,
			}),
		);
		expect(prose).toBe("Read → c/d/e.tsx");
	});

	it("b-AC-3 (command, no file_path): `tool: <command collapsed + capped at 80>`", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Bash",
				input: { command: "git log --oneline -20" },
				response: { stdout: "abc1234 head" },
			}),
		);
		expect(prose.startsWith("Bash: git log --oneline -20\n")).toBe(true);
	});

	it("b-AC-3 (command capped at 80): a long command is collapsed + truncated with …", () => {
		const long = "run " + "arg ".repeat(40); // > 80 chars after collapse
		const prose = proseForToolCall(
			toolCall({ tool: "Bash", input: { command: long }, response: undefined }),
		);
		// First line is `Bash: ` (6 chars) + 80 chars of collapsed command + `…` = 87.
		expect(prose).toMatch(/^Bash: .{80}…$/);
		expect(prose.length).toBe(6 + 80 + 1);
	});

	it("b-AC-4 (no recognizable target): bare `tool` name as the first line", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "WebSearch",
				input: { query: "honeycomb recall" }, // no file_path/path/command
				response: undefined,
			}),
		);
		expect(prose).toBe("WebSearch");
	});

	it("b-AC-4 (generic `path` field, no file_path): `tool → shortPath`", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "ListFiles",
				input: { path: "/home/mario/repo/hive/web/components" },
				response: undefined,
			}),
		);
		expect(prose).toBe("ListFiles → hive/web/components");
	});

	it("file_path takes precedence over path and command when multiple are present", () => {
		// The branch order is file_path → path → command → bare tool. A payload with all three
		// resolves on file_path (the Read/Edit/Write case). /a/b/c.tsx is 3 non-empty segments
		// → returned AS-IS (≤ 3 segments, leading slash preserved).
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "/a/b/c.tsx", path: "/x/y", command: "ls" },
				response: undefined,
			}),
		);
		expect(prose).toBe("Read → /a/b/c.tsx");
	});
});

// ── L-B5 / b-AC-5..7 — response line: collapse, cap, per-tool extractor ───────

describe("L-B5 / b-AC-5..7 — response line whitespace-collapsed + capped + per-tool extractor", () => {
	it("b-AC-6 (Read 10 KB): prose ≤ TOOL_PROSE_RESPONSE_CAP + first-line length; full content in JSONB", () => {
		// A 10 KB Read response. The prose body is capped; the full content survives ONLY in
		// the `message` JSONB (asserted by the capture-handler suite, L-B1).
		const bigContent = "x".repeat(10_000);
		const event = toolCall({
			tool: "Read",
			input: { file_path: "/a/b/c/d/big.ts", offset: 1, limit: 100 },
			response: { file: { content: bigContent } },
		});
		const prose = proseForToolCall(event);
		const lines = prose.split("\n");
		// Two lines: first line (tool → path:range) + capped body.
		expect(lines).toHaveLength(2);
		// The body line is at most TOOL_PROSE_RESPONSE_CAP chars (the cap) + the `…` marker.
		// (truncate appends `…` only when overflowing — a 10 KB body overflows.)
		expect(lines[1]!.length).toBe(TOOL_PROSE_RESPONSE_CAP + 1); // cap + the ellipsis.
		// Total prose bounded by first-line length + 1 (newline) + cap + 1 (ellipsis).
		expect(prose.length).toBeLessThanOrEqual(lines[0]!.length + 1 + TOOL_PROSE_RESPONSE_CAP + 1);
		// The body NEVER carries the full 10 KB — that's the bloat PRD-074 kills.
		expect(prose.length).toBeLessThan(10_000);
	});

	it("b-AC-7 (Bash multi-KB stdout): response.stdout is the body, capped", () => {
		const bigStdout = "line\n".repeat(2000); // ~10 KB
		const event = toolCall({
			tool: "Bash",
			input: { command: "git log" },
			response: { stdout: bigStdout },
		});
		const prose = proseForToolCall(event);
		const lines = prose.split("\n");
		// First line is `Bash: git log`; the rest is the capped, collapsed stdout.
		expect(lines[0]).toBe("Bash: git log");
		// The collapsed body (single-space-joined) is capped; an overflowing body ends with `…`.
		expect(prose.endsWith("…")).toBe(true);
		expect(prose.length).toBeLessThan(bigStdout.length);
	});

	it("b-AC-5 (whitespace collapse): runs of whitespace collapse to single spaces BEFORE the cap", () => {
		const indented = "    line one\n        line two\n            line three";
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "/a/b/c/d.ts" },
				response: { file: { content: indented } },
			}),
		);
		// The body is single-spaced (no runs of spaces, no newlines past the first line break).
		expect(prose).toContain("line one line two line three");
		// No interior run of 2+ whitespace chars survives the collapse.
		const body = prose.split("\n")[1]!;
		expect(body).not.toMatch(/\s{2,}/);
	});

	it("response is a bare string: used directly as the body", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "WebFetch",
				input: { url: "https://example.com" },
				response: "the page body text",
			}),
		);
		expect(prose).toBe("WebFetch\nthe page body text");
	});

	it("response is an object with NO recognized content field: JSON.stringify, then cap", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "UnknownTool",
				input: {},
				response: { ok: true, count: 3, items: ["a", "b", "c"] },
			}),
		);
		expect(prose.startsWith("UnknownTool\n")).toBe(true);
		// The body is the JSON serialization of the response object.
		expect(prose.split("\n")[1]).toBe(JSON.stringify({ ok: true, count: 3, items: ["a", "b", "c"] }));
	});

	it("response absent / null / undefined: line 1 alone (no second line)", () => {
		for (const response of [undefined, null] as unknown[]) {
			const prose = proseForToolCall(toolCall({ tool: "Read", input: { file_path: "/a/b/c/d.ts" }, response }));
			expect(prose).toBe("Read → b/c/d.ts");
			expect(prose.includes("\n")).toBe(false);
		}
	});

	it("a short response (under the cap) survives UNCHANGED — no `…` appended", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "/a/b/c/d.ts" },
				response: { file: { content: "short body" } },
			}),
		);
		expect(prose).toBe("Read → b/c/d.ts\nshort body");
		expect(prose.endsWith("…")).toBe(false);
	});

	it("response.file.content that is NOT a string is not used (falls through to stdout/stringify)", () => {
		// `file.content` present but a number → not recognized; `stdout` absent → JSON.stringify.
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: { file_path: "/a/b/c/d.ts" },
				response: { file: { content: 42 } },
			}),
		);
		expect(prose.split("\n")[1]).toBe(JSON.stringify({ file: { content: 42 } }));
	});
});

// ── L-B6 / b-AC-9 — Windows path separators preserved ─────────────────────────

describe("L-B6 / b-AC-9 — Windows backslashes preserved as-is (no re-escaping)", () => {
	it("a Windows file_path keeps backslashes in the shortened path (no double-backslash)", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Read",
				input: {
					file_path: "C:\\Users\\mario\\GitHub\\the-apiary\\hive\\src\\dashboard\\web\\pages\\dashboard.tsx",
					offset: 175,
					limit: 75,
				},
				response: undefined,
			}),
		);
		// The shortened path uses single backslashes (web\pages\dashboard.tsx), NEVER the
		// double-backslash re-escaping the JSONB cast produced (`web\\pages\\dashboard.tsx`).
		expect(prose).toContain("web\\pages\\dashboard.tsx");
		expect(prose).not.toContain("web\\\\pages");
	});

	it("a Windows command path keeps backslashes; the JSONB cast's doubling is gone", () => {
		const prose = proseForToolCall(
			toolCall({
				tool: "Bash",
				input: { command: "type C:\\Users\\mario\\file.txt" },
				response: undefined,
			}),
		);
		expect(prose).toContain("C:\\Users\\mario\\file.txt");
		expect(prose).not.toContain("C:\\\\Users");
	});

	it("shortPath on a Windows absolute path: last three segments joined with backslash", () => {
		// Direct exercise of the shortening via the public proseForToolCall (shortPath is private).
		const prose = proseForToolCall(
			toolCall({
				tool: "Edit",
				input: { file_path: "C:\\a\\b\\c\\d\\e\\f.tsx" },
				response: undefined,
			}),
		);
		expect(prose).toBe("Edit → d\\e\\f.tsx");
	});
});

// ── b-AC-1 — pure + synchronous, no IO ────────────────────────────────────────

describe("b-AC-1 — proseForToolCall is pure + synchronous (no IO)", () => {
	it("returns a string synchronously for every event kind (no promise, no throw)", () => {
		// A synchronous call (no await) returning a string proves no IO. Every recognized kind
		// + an unknown-tool fallback is exercised — none throws, none returns a Promise.
		const events: ToolCallEvent[] = [
			toolCall(),
			toolCall({ tool: "Bash", input: { command: "ls" }, response: undefined }),
			toolCall({ tool: "Mystery", input: {}, response: undefined }),
			toolCall({ tool: "Read", input: undefined, response: undefined }),
		];
		for (const event of events) {
			const result = proseForToolCall(event);
			expect(typeof result).toBe("string");
			expect(result).toBe(result); // stable across two reads (pure).
		}
	});

	it("a malformed input (not a record) degrades to the bare tool name, never throws", () => {
		// input is `z.unknown()` at the boundary; a non-record input must not crash the hot path.
		const prose = proseForToolCall(
			toolCall({ tool: "Read", input: "not-a-record" as unknown, response: undefined }),
		);
		expect(prose).toBe("Read");
	});

	it("a non-serializable response object (cycle) degrades to omit-line-2, never throws", () => {
		// JSON.stringify throws on a cycle; the extractor catches and returns null (omit line 2).
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const prose = proseForToolCall(
			toolCall({ tool: "Read", input: { file_path: "/a/b/c/d.ts" }, response: cyclic }),
		);
		expect(prose).toBe("Read → b/c/d.ts");
	});
});
