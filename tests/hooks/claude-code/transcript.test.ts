/**
 * PRD-060 ROI capture fix — the Claude Code TRANSCRIPT reader.
 *
 * The bug this proves dead: the `Stop` hook payload carries NO `usage` and NO `model`, so the
 * payload-level extractor returned `undefined` and the dashboard showed ZERO measured savings. The
 * real source is the transcript JSONL at `transcript_path`. These tests drive {@link parseTurnUsage}
 * from a REAL-shaped transcript fixture (NOT an injected capture body) so the boundary-find + the
 * per-turn multi-entry summation + the last-entry model are pinned, and {@link readTranscriptTurnUsage}
 * is proven fail-soft (a missing/unreadable path → `{}`, never a throw).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseTurnUsage, readTranscriptTurnUsage } from "../../../src/hooks/index.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const OPUS_FIXTURE = join(FIXTURE_DIR, "transcript-opus-tool-round.jsonl");

describe("PRD-060 parseTurnUsage: sums THIS turn's assistant entries + takes the last model", () => {
	it("sums input/output/cache_read/cache_creation across the turn's two assistant entries", () => {
		// The fixture: a prior (Sonnet) turn, then the LAST user prompt followed by TWO Opus
		// assistant entries (the tool-use round + the final). The boundary is the last user line, so the
		// prior turn's all-99 counts are EXCLUDED and only the two Opus entries are summed.
		const result = parseTurnUsage(readFileSync(OPUS_FIXTURE, "utf8"));
		expect(result.model).toBe("claude-opus-4-8"); // the LAST assistant entry's model.
		expect(result.usage).toEqual({
			input: 1500, // 1200 + 300
			output: 150, // 40 + 110
			cacheRead: 8000, // 5000 + 3000  ← the headline measured-savings lever
			cacheCreation: 64, // 64 + 0
		});
	});

	it("a turn with NO assistant entries after the last user line returns {}", () => {
		const jsonl =
			'{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10}}}\n' +
			'{"type":"user","message":{"role":"user","content":"the latest prompt, no reply yet"}}';
		expect(parseTurnUsage(jsonl)).toEqual({});
	});

	it("malformed (non-JSON) lines are skipped, not fatal — the valid entries still sum", () => {
		const jsonl = [
			'{"type":"user","message":{"content":"go"}}',
			"this line is not JSON at all {{{",
			'{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":7,"cache_read_input_tokens":11}}}',
			"", // blank line
		].join("\n");
		const result = parseTurnUsage(jsonl);
		expect(result.model).toBe("claude-opus-4-8");
		expect(result.usage).toEqual({ input: 7, cacheRead: 11 });
	});

	it("a measured 0 is KEPT; an absent / malformed count stays ABSENT (zero ≠ null)", () => {
		const jsonl =
			'{"type":"user","message":{"content":"go"}}\n' +
			// cache_read_input_tokens: 0 is a REAL measurement (kept); output absent; input negative (dropped).
			'{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":-3,"cache_read_input_tokens":0}}}';
		const result = parseTurnUsage(jsonl);
		// The measured 0 survives; the negative input is dropped (absent); output never appeared.
		expect(result.usage).toEqual({ cacheRead: 0 });
		expect(Object.prototype.hasOwnProperty.call(result.usage, "input")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(result.usage, "output")).toBe(false);
	});

	it("an assistant entry with NO usage counts contributes a model but OMITS usage", () => {
		const jsonl =
			'{"type":"user","message":{"content":"go"}}\n' +
			'{"type":"assistant","message":{"model":"claude-opus-4-8"}}';
		const result = parseTurnUsage(jsonl);
		expect(result.model).toBe("claude-opus-4-8");
		expect(Object.prototype.hasOwnProperty.call(result, "usage")).toBe(false);
	});

	it("empty / whitespace text returns {}", () => {
		expect(parseTurnUsage("")).toEqual({});
		expect(parseTurnUsage("   \n  \n")).toEqual({});
	});
});

describe("PRD-060 readTranscriptTurnUsage: fail-soft file read (never throws)", () => {
	it("a missing / unreadable path → {} (no throw)", () => {
		expect(() => readTranscriptTurnUsage(join(FIXTURE_DIR, "does-not-exist.jsonl"))).not.toThrow();
		expect(readTranscriptTurnUsage(join(FIXTURE_DIR, "does-not-exist.jsonl"))).toEqual({});
	});

	it("the in-process grouping key (not a real transcript file) → {} (no throw)", () => {
		// The capture unit tests use a `conversations/sess-1` path — NOT a Claude Code transcript file.
		// It must degrade to "no usage", exactly like the pre-fix behavior, never break capture.
		expect(readTranscriptTurnUsage("conversations/sess-1")).toEqual({});
	});

	it("an empty path → {} (no throw)", () => {
		expect(readTranscriptTurnUsage("")).toEqual({});
	});

	it("reads + parses a real transcript file end to end", () => {
		const result = readTranscriptTurnUsage(OPUS_FIXTURE);
		expect(result.model).toBe("claude-opus-4-8");
		expect(result.usage?.cacheRead).toBe(8000);
	});
});
