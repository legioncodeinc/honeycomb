/**
 * Budgeted capture-envelope serializer (PRD-062c L-C2 / AC-62c.2.1 / AC-6).
 *
 * ── Why this exists (Driver 2, the metadata-bloat half) ──────────────────────
 * The capture handler persists the FULL normalized envelope `{ event, metadata }`
 * into the `sessions.message` JSONB column. For a `tool_call` event that envelope
 * carries the ENTIRE serialized tool input AND response — which for a file read, a
 * grep over a big tree, or a verbose API call is routinely multiple megabytes of
 * JSON shipped to DeepLake on every captured turn. This module caps each oversized
 * tool I/O payload to a documented BYTE budget and replaces the overflow with an
 * explicit, machine-detectable truncation marker, so a pathological multi-MB
 * response is stored within budget while a normal small payload passes through
 * BYTE-IDENTICAL.
 *
 * ── What it trims, and what it deliberately does NOT ─────────────────────────
 * It caps ONLY the two genuinely unbounded fields on a `tool_call` event:
 * `event.input` and `event.response`. It NEVER touches:
 *   - `event.text` (a `user_message` / `assistant_message` body) — recall +
 *     skillify + the summary gate all read this; it is signal, not bloat.
 *   - the `metadata` object — every field is small AND consumed: the skillify
 *     miner reads `metadata.sessionId` from the envelope (no dedicated column
 *     carries it), so the consumer audit (PRD-062c gating) forbids dropping it.
 *   - `event.tool` / `event.kind` — tiny enum/name strings the consumers key on.
 * The trim is a CONTENT change to an existing column, never a schema change, and
 * is forward-only (existing rows are untouched — parent non-goal).
 *
 * ── The marker contract (truncation is detectable, never silent) ─────────────
 * A capped field is replaced by a sentinel STRING of the shape
 * `…[truncated N bytes]` (where N is the original UTF-8 byte length of the field's
 * own JSON serialization). A consumer that walks the envelope can detect the
 * marker; recall, which matches the whole `message` lexically/semantically, simply
 * sees a shorter body with the marker text in place of the megabyte blob — the
 * documented, intended reduction (AC-62c.2.3 parity: no CONSUMED field removed).
 *
 * ── PII posture ──────────────────────────────────────────────────────────────
 * The envelope is captured tool I/O, a known PII surface. This module REDUCES the
 * surface (less raw I/O persisted) but never logs the payload it trims — it only
 * measures byte lengths. (Parent index security handoff.)
 *
 * Pure + synchronous + dependency-free beyond the language runtime and the event
 * contract types, so it is trivially unit-testable with no I/O.
 */

import type { CaptureEvent, CaptureMetadata } from "./event-contract.js";

/** The default per-field byte budget (16 KiB), the PRD-062c flag default. */
export const DEFAULT_ENVELOPE_BUDGET_BYTES = 16_384;

/**
 * Build the truncation sentinel for a field whose JSON serialization is
 * `originalBytes` long. A single canonical shape so a consumer (or a test) can
 * detect truncation by matching this marker. The `N` is the ORIGINAL byte length,
 * not the truncated one, so the marker records what was dropped.
 */
export function truncationMarker(originalBytes: number): string {
	return `…[truncated ${originalBytes} bytes]`;
}

/** UTF-8 byte length of a string (the unit the budget is measured in). */
function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/**
 * Cap one schemaless tool-I/O value to the byte budget.
 *
 * Returns the value UNCHANGED when its JSON serialization is within budget (so a
 * small payload round-trips byte-identical), and the {@link truncationMarker}
 * string when it is over budget. `undefined` (an absent input/response) stays
 * `undefined` — there is nothing to cap and no marker to stamp.
 *
 * A value that cannot serialize (a cycle) is treated as absent rather than
 * throwing — capture must never fail because a tool returned an unserializable
 * blob.
 */
export function capToolField(value: unknown, budgetBytes: number): unknown {
	if (value === undefined) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		// A non-serializable value (cycle) contributes nothing — never throw.
		return undefined;
	}
	if (serialized === undefined) return undefined; // JSON.stringify of a bare `undefined`-yielding value.
	if (byteLength(serialized) <= budgetBytes) return value;
	return truncationMarker(byteLength(serialized));
}

/**
 * Trim a `tool_call` event's oversized I/O to the budget, returning a NEW event
 * with `input`/`response` capped and every other field preserved. Non-`tool_call`
 * events (and `tool_call` events already within budget) are returned UNCHANGED so
 * the common path allocates nothing new.
 */
function trimEvent(event: CaptureEvent, budgetBytes: number): CaptureEvent {
	if (event.kind !== "tool_call") return event;
	const cappedInput = capToolField(event.input, budgetBytes);
	const cappedResponse = capToolField(event.response, budgetBytes);
	// Reference-equal when nothing was capped → return the original event untouched.
	if (cappedInput === event.input && cappedResponse === event.response) return event;
	return {
		kind: "tool_call",
		tool: event.tool,
		...(cappedInput !== undefined ? { input: cappedInput } : {}),
		...(cappedResponse !== undefined ? { response: cappedResponse } : {}),
	};
}

/**
 * Serialize the capture envelope `{ event, metadata }` with each oversized tool
 * I/O field capped to `budgetBytes` (L-C2 / AC-6).
 *
 * The output is the SAME `JSON.stringify({ event, metadata })` the handler wrote
 * before this PRD, except a `tool_call` event's over-budget `input`/`response` is
 * replaced by the {@link truncationMarker}. A small payload's serialization is
 * BYTE-IDENTICAL to the un-budgeted form (no field is reordered, the metadata is
 * carried verbatim), so flag-off / within-budget capture is unchanged.
 */
export function budgetedStringify(
	event: CaptureEvent,
	metadata: CaptureMetadata,
	budgetBytes: number = DEFAULT_ENVELOPE_BUDGET_BYTES,
): string {
	const trimmedEvent = trimEvent(event, budgetBytes);
	return JSON.stringify({ event: trimmedEvent, metadata });
}
