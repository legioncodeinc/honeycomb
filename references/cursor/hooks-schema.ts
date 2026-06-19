/**
 * Cursor `hooks.json` — the REAL harness config contract, as an executable zod schema.
 *
 * ── What this is (the references gate, now EXECUTABLE) ───────────────────────
 * The Cursor analogue of `references/claude-code/hooks-schema.ts`. PRDs 019a/020c cited the
 * Cursor hook protocol as a documented CONVENTION (`references/cursor/`, D-3) that no repo
 * actually held. This file makes it executable: it encodes — as an INDEPENDENT zod oracle —
 * the structure the REAL Cursor 1.7+ agent harness accepts in `~/.cursor/hooks.json`. The
 * conformance suite runs the REAL `CursorConnector` install path and parses the emitted config
 * through THIS schema, so a typo'd/renamed event or a structurally wrong entry FAILS the gate.
 *
 * It encodes the EXTERNAL Cursor protocol, NOT Honeycomb's connector types — an oracle the
 * connector is checked against, not a mirror of the code under test.
 *
 * ── Sources (high fidelity) ─────────────────────────────────────────────────
 *   1. Cursor Agent Hooks reference (cursor.com/docs/agent/hooks): the `hooks.json` top-level
 *      shape `{ version, hooks: { <eventName>: [ { command, type?, timeout?, matcher?,
 *      failClosed?, loop_limit? } ] } }`, and the exact event-name set (`sessionStart`,
 *      `sessionEnd`, `preToolUse`, `postToolUse`, `beforeShellExecution`,
 *      `afterShellExecution`, `beforeSubmitPrompt`, `stop`, `afterAgentResponse`,
 *      `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, `subagentStart`,
 *      `subagentStop`, `preCompact`, …).
 *   2. The in-repo 019b Cursor shim `src/hooks/cursor/shim.ts` (`CURSOR_EVENT_MAP`), the
 *      runtime side of the contract: it lowers Cursor's `sessionStart`, `beforeSubmitPrompt`,
 *      `postToolUse`, `afterAgentResponse`, `stop`, `sessionEnd`.
 *
 * ── Fidelity caveats (be honest — see references/README.md) ─────────────────
 *   - REAL Cursor `hooks.json` lists each event's handlers as a FLAT array of entries directly
 *     under the event key: `hooks[event] = [ { command, type? , … } ]`. Cursor does NOT use the
 *     Claude-Code-style nested matcher block `{ matcher?, hooks: [...] }`. To validate honestly
 *     against the real harness, {@link cursorHooksEntryArray} encodes the FLAT-entry contract.
 *     A separate {@link cursorMatcherBlock} is provided ONLY so the gate can DETECT the
 *     Claude-Code-shaped nesting and report it, never to bless it as Cursor-valid.
 *   - REAL Cursor command entries use `command` (required) + `type?` + `timeout?` + `matcher?`
 *     + `failClosed?` + `loop_limit?`. Cursor has NO `async` field (its concurrency model is
 *     `timeout`/`failClosed`/`loop_limit`). An `async` key is therefore tolerated as an
 *     unknown passthrough field, NOT asserted as part of the contract.
 *   - The `beforeShellExecution` event is Cursor's shell-command gate (the analogue of Claude
 *     Code's `PreToolUse` + Bash matcher). It IS a real Cursor event; the connector's
 *     `pre-tool-use → beforeShellExecution` mapping targets it deliberately.
 */

import { z } from "zod";

/**
 * The native Cursor lifecycle event names this gate recognizes as VALID `hooks.json` keys.
 *
 * Includes the events the connector + the 019b shim use (`sessionStart`, `beforeSubmitPrompt`,
 * `beforeShellExecution`, `postToolUse`, `stop`, `sessionEnd`, `afterAgentResponse`) plus the
 * documented siblings (`preToolUse`, `afterShellExecution`, `beforeMCPExecution`,
 * `beforeReadFile`, `afterFileEdit`, `subagentStart`, `subagentStop`, `preCompact`). A key NOT
 * in this set is an event the harness does not accept — the failure the gate exists to catch.
 *
 * Source: cursor.com/docs/agent/hooks event list.
 */
export const CURSOR_EVENT_NAMES = [
	"sessionStart",
	"sessionEnd",
	"beforeSubmitPrompt",
	"preToolUse",
	"postToolUse",
	"beforeShellExecution",
	"afterShellExecution",
	"beforeMCPExecution",
	"afterMCPExecution",
	"beforeReadFile",
	"afterFileEdit",
	"afterAgentResponse",
	"subagentStart",
	"subagentStop",
	"preCompact",
	"stop",
] as const;

/** A single REAL Cursor command hook entry — a leaf of the FLAT `hooks[event][]` array. */
export const cursorHookEntry = z
	.object({
		// `command` is REQUIRED (the script path / shell command).
		command: z.string().min(1),
		// Optional: `"command"` (default) or `"prompt"`.
		type: z.string().optional(),
		// Optional: execution timeout in seconds.
		timeout: z.number().optional(),
		// Optional: filters when the hook runs (tool / subagent / command pattern).
		matcher: z.string().optional(),
		// Optional: hook failure blocks the action instead of allowing it through.
		failClosed: z.boolean().optional(),
		// Optional: per-script loop limit for stop/subagentStop hooks.
		loop_limit: z.number().nullable().optional(),
	})
	// Tolerate fields outside the documented set (incl. Honeycomb's `_honeycomb` sentinel, and
	// an `async` key Cursor does not define). Passthrough is the honest choice over a closed
	// shape; the gate asserts the parts we can justify (the required `command`, the kinds of
	// the optional fields) and tolerates the rest.
	.passthrough();

/**
 * The REAL Cursor per-event value: a FLAT array of {@link cursorHookEntry}. This is the contract
 * the conformance gate validates the connector's emitted config against.
 */
export const cursorHooksEntryArray = z.array(cursorHookEntry);

/**
 * The Claude-Code-style nested matcher block `{ matcher?, hooks: [...] }`. Cursor does NOT use
 * this shape. It is encoded ONLY so the gate can DETECT it in emitted config (and report the
 * structural divergence) — it is never treated as Cursor-valid.
 */
export const cursorMatcherBlock = z
	.object({
		matcher: z.string().optional(),
		hooks: z.array(cursorHookEntry),
	})
	.passthrough();

/** The top-level `hooks.json` shape: optional `version`, plus the `hooks` event map. */
export const cursorHooksFile = z
	.object({
		version: z.number().optional(),
		hooks: z.record(z.string(), cursorHooksEntryArray).optional(),
	})
	.passthrough();

export type CursorEventName = (typeof CURSOR_EVENT_NAMES)[number];
export type CursorHooksFile = z.infer<typeof cursorHooksFile>;

const EVENT_SET: ReadonlySet<string> = new Set(CURSOR_EVENT_NAMES);

/** True iff `name` is a Cursor lifecycle event the harness accepts as a `hooks.json` key. */
export function isCursorEvent(name: string): boolean {
	return EVENT_SET.has(name);
}

/**
 * True iff `value` is the Claude-Code-style nested matcher block (`{ hooks: [...] }`) rather
 * than a flat Cursor entry array. Used by the conformance gate to DETECT and report the
 * structural divergence the real Cursor harness would reject.
 */
export function looksLikeNestedMatcherBlocks(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.some(
		(block) =>
			block !== null &&
			typeof block === "object" &&
			Array.isArray((block as { hooks?: unknown }).hooks),
	);
}

/**
 * Assert a parsed `hooks.json` object CONFORMS to the real Cursor hooks contract:
 *   1. the top-level shape parses against {@link cursorHooksFile} (incl. each event value being
 *      a FLAT array of valid entries), AND
 *   2. EVERY `hooks` key is a recognized Cursor event name (the typo/rename catch).
 *
 * Throws a `ZodError` (structure — e.g. a nested matcher block where a flat array is required)
 * or a plain `Error` (unknown event) on non-conformance. The test asserts whether it throws.
 * Returns the validated file on success.
 */
export function assertCursorHooksConform(config: unknown): CursorHooksFile {
	const parsed = cursorHooksFile.parse(config);
	for (const event of Object.keys(parsed.hooks ?? {})) {
		if (!isCursorEvent(event)) {
			throw new Error(
				`Cursor hooks conformance: "${event}" is not an event name the harness accepts ` +
					`(valid: ${CURSOR_EVENT_NAMES.join(", ")}). A real install under this config ` +
					`would silently drop the hook.`,
			);
		}
	}
	return parsed;
}
