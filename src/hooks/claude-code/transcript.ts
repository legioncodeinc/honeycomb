/**
 * PRD-060 ROI capture fix — the Claude Code TRANSCRIPT reader (the real source of usage + model).
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * The `assistant_message` turn is captured off Claude Code's `Stop` / `SubagentStop`
 * hook (`shim.ts`, CLAUDE_CODE_EVENT_MAP). But the `Stop` hook PAYLOAD carries NO
 * message and NO `usage` — only `session_id`, `cwd`, and `transcript_path`. The
 * per-message `usage` (and the model id) live INSIDE the transcript JSONL at
 * `transcript_path`. The payload-level {@link import("../normalize.js").extractTurnUsage}
 * therefore returns `undefined` for the real Claude Code wiring, which is exactly why
 * the dashboard showed ZERO measured savings: `cache_read_input_tokens` persisted NULL
 * and no `model` was ever captured.
 *
 * This module reads the transcript file and sums the assistant entries of the turn,
 * lowering them onto the SAME canonical {@link import("../normalize.js").NormalizedTurnUsage}
 * shape the shim already feeds the daemon (so the daemon's zod boundary validates it
 * unchanged). The shim's payload-level `extractTurnUsage` stays as the fallback; this is
 * the primary source for the real `Stop`-hook wiring.
 *
 * ── PURE vs FILE-READING ────────────────────────────────────────────────────
 * {@link parseTurnUsage} is a PURE, fixture-testable function over the JSONL TEXT — no
 * disk, no throw. {@link readTranscriptTurnUsage} is the thin fail-soft file reader that
 * `readFileSync`s the transcript and delegates to it. ANY error (missing file,
 * unreadable, empty, or a non-Claude-Code grouping key like the in-process test's
 * `conversations/sess-1`) degrades to `{}` and NEVER throws — a transcript-read failure
 * must degrade to "no usage" exactly like the pre-fix behavior, never breaking capture
 * or the daemon.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT: this module opens NO DeepLake and builds NO SQL. It
 * only reads a local file the harness already named and returns the normalized usage.
 */

import { readFileSync } from "node:fs";

import type { NormalizedTurnUsage } from "../normalize.js";

/**
 * The result of reading a turn's transcript entries: the LAST assistant entry's model id
 * (when present) and the SUMMED per-turn usage across this turn's assistant entries (when
 * any count survived). Both are OPTIONAL and OMITTED when absent — never zero-filled,
 * never an empty string — so the absence round-trips downstream as "unknown" exactly like
 * the no-usage path.
 */
export interface TranscriptTurnUsage {
	/** The model id of the LAST assistant entry of the turn (e.g. `claude-opus-4-8`). Omitted when absent. */
	readonly model?: string;
	/** The summed per-turn token + cache counts. Omitted when no count was present. */
	readonly usage?: NormalizedTurnUsage;
}

/**
 * Parse a Claude Code transcript JSONL into THIS turn's `{ model?, usage? }` (PURE — no IO, no throw).
 *
 * The Claude Code transcript is one JSON object per line. Assistant entries look like
 * `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":N,
 * "output_tokens":N,"cache_read_input_tokens":N,"cache_creation_input_tokens":N}}}`; user
 * entries `{"type":"user",...}`. A single turn (one `Stop`) can have MULTIPLE assistant
 * entries (one per tool-use round), each with its own `usage`.
 *
 * Algorithm:
 *   1. Find the LAST `type:"user"` line — the turn boundary (everything after it is THIS turn).
 *   2. SUM `input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 *      `cache_creation_input_tokens` across all `type:"assistant"` entries AFTER it.
 *   3. `model` = the model id of the LAST assistant entry after the boundary.
 *
 * If there are no assistant entries after the last user line, return `{}`. Lines that do
 * not JSON-parse are skipped. A missing count on an entry contributes nothing (the SAME
 * non-negative-integer discipline as `readCount`/`isCount` in `normalize.ts` — a measured
 * `0` is kept, an absent count stays absent). If the summed usage has no present counts,
 * `usage` is omitted.
 *
 * v1 reads the whole text. A bounded tail-read (only the bytes after the last user line)
 * is a perf follow-up for very large transcripts — the algorithm above is the same.
 */
export function parseTurnUsage(jsonlText: string): TranscriptTurnUsage {
	const entries = parseEntries(jsonlText);
	// The turn boundary: everything AFTER the LAST user entry belongs to THIS turn.
	let lastUserIndex = -1;
	for (let i = 0; i < entries.length; i++) {
		if (entryType(entries[i]) === "user") lastUserIndex = i;
	}

	// Sum this turn's assistant entries; remember the LAST one's model id.
	const totals = new TurnTotals();
	let lastModel: string | undefined;
	let sawAssistant = false;
	for (let i = lastUserIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entryType(entry) !== "assistant") continue;
		sawAssistant = true;
		totals.add(messageOf(entry));
		const model = modelOf(entry);
		if (model !== undefined) lastModel = model;
	}

	// No assistant entries after the last user line → nothing to report for this turn.
	if (!sawAssistant) return {};

	const usage = totals.toUsage();
	return {
		...(lastModel !== undefined ? { model: lastModel } : {}),
		...(usage !== undefined ? { usage } : {}),
	};
}

/**
 * Read a Claude Code transcript file and return THIS turn's `{ model?, usage? }` (FAIL-SOFT).
 *
 * `readFileSync`s the transcript at `transcriptPath` and delegates to {@link parseTurnUsage}.
 * ANY error — a missing/unreadable file, an empty read, or a non-Claude-Code grouping key
 * (e.g. the in-process test's `conversations/sess-1`, which is not a real transcript file) —
 * resolves to `{}` and NEVER throws. The capture path must degrade to "no usage" on a read
 * failure exactly as it did before this fix, never break the turn or the daemon.
 */
export function readTranscriptTurnUsage(transcriptPath: string): TranscriptTurnUsage {
	if (transcriptPath.length === 0) return {};
	let text: string;
	try {
		text = readFileSync(transcriptPath, "utf8");
	} catch {
		// Missing / unreadable / not a real transcript path → degrade to "no usage" (never throw).
		return {};
	}
	return parseTurnUsage(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals — JSONL parsing + the per-turn token summation (mirrors normalize.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Parse the JSONL text into the object entries, skipping any line that does not JSON-parse. */
function parseEntries(jsonlText: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of jsonlText.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // a malformed line is skipped, never fatal.
		}
		if (parsed !== null && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
	}
	return out;
}

/** The `type` discriminant of a transcript entry (`"user"` / `"assistant"` / …), or `""`. */
function entryType(entry: Record<string, unknown>): string {
	return typeof entry.type === "string" ? entry.type : "";
}

/** The `message` object of an assistant entry (where `usage` + `model` live), or an empty record. */
function messageOf(entry: Record<string, unknown>): Record<string, unknown> {
	const message = entry.message;
	return message !== null && typeof message === "object" ? (message as Record<string, unknown>) : {};
}

/** The `message.model` id of an assistant entry, or `undefined` (absent / non-string / empty). */
function modelOf(entry: Record<string, unknown>): string | undefined {
	const model = messageOf(entry).model;
	return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * The running per-turn token totals. Each bucket starts ABSENT (`undefined`) and only becomes
 * present once a real measured count is added — so an entirely count-less turn yields `undefined`
 * usage (omitted), and a measured `0` keeps the bucket present at `0` (zero ≠ absent), mirroring
 * the `compactUsage`/`isCount` discipline in `normalize.ts`.
 */
class TurnTotals {
	private input: number | undefined;
	private output: number | undefined;
	private cacheRead: number | undefined;
	private cacheCreation: number | undefined;

	/** Fold one assistant `message.usage` block's counts into the running totals (absent counts skipped). */
	add(message: Record<string, unknown>): void {
		const usage = message.usage;
		const block = usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
		this.input = addCount(this.input, readCount(block, "input_tokens"));
		this.output = addCount(this.output, readCount(block, "output_tokens"));
		this.cacheRead = addCount(this.cacheRead, readCount(block, "cache_read_input_tokens"));
		this.cacheCreation = addCount(this.cacheCreation, readCount(block, "cache_creation_input_tokens"));
	}

	/** Compact the totals into a {@link NormalizedTurnUsage}, or `undefined` when every bucket stayed absent. */
	toUsage(): NormalizedTurnUsage | undefined {
		const usage: NormalizedTurnUsage = {
			...(this.input !== undefined ? { input: this.input } : {}),
			...(this.output !== undefined ? { output: this.output } : {}),
			...(this.cacheRead !== undefined ? { cacheRead: this.cacheRead } : {}),
			...(this.cacheCreation !== undefined ? { cacheCreation: this.cacheCreation } : {}),
		};
		return Object.keys(usage).length > 0 ? usage : undefined;
	}
}

/**
 * Add a present count into a running bucket. An ABSENT addend (`undefined`) leaves the bucket
 * unchanged (an absent bucket stays absent). A present addend turns an absent bucket present and
 * accumulates onto an already-present one — so a measured `0` makes the bucket present at `0`.
 */
function addCount(running: number | undefined, addend: number | undefined): number | undefined {
	if (addend === undefined) return running;
	return (running ?? 0) + addend;
}

/**
 * Read one native count field as a non-negative integer, or `undefined`. A missing, non-numeric,
 * negative, or fractional value yields `undefined` (it contributes nothing → the bucket stays
 * absent → the column stays NULL, never a silent 0). A genuine `0` is returned (zero ≠ absent) —
 * the SAME `readCount`/`isCount` discipline as `normalize.ts`.
 */
function readCount(block: Record<string, unknown>, key: string): number | undefined {
	const value = block[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
	return value;
}
