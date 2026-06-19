/**
 * Claude Code `settings.json#hooks` — the REAL harness config contract, as an executable zod schema.
 *
 * ── What this is (the references gate, now EXECUTABLE) ───────────────────────
 * PRDs 019a/020c/020d cited the harness `hooks.json` protocol as a "references gate =
 * documented CONVENTION" (decision D-3): no `references/<harness>/` repo existed, so the
 * gate was never machine-checkable. This file makes it executable. It encodes — as an
 * INDEPENDENT zod oracle — the structure the REAL Claude Code harness accepts under the
 * top-level `hooks` key of `~/.claude/settings.json`. The conformance suite
 * (`tests/conformance/connector-hooks-conformance.test.ts`) runs the REAL
 * `ClaudeCodeConnector` install path and parses the emitted config through THIS schema, so
 * a typo'd/renamed event name or a malformed entry the connector emits FAILS the gate.
 *
 * This schema encodes the EXTERNAL harness protocol, NOT Honeycomb's own connector types.
 * That independence is the point: it is an oracle the connector is checked against, not a
 * mirror of the code under test.
 *
 * ── Sources (high fidelity) ─────────────────────────────────────────────────
 *   1. Claude Code hooks reference (code.claude.com/docs/en/hooks): the event → matcher-group
 *      → handler hierarchy, the matcher object `{ matcher?, hooks: [...] }`, and the command
 *      handler fields `{ type, command, timeout?, async? }`. `async` IS a real Claude Code
 *      command-hook field ("Run in background without blocking").
 *   2. The in-repo legacy reference `hivemind-v1/harnesses/claude-code/hooks/hooks.json`
 *      (cited by `src/connectors/claude-code.ts`): top-level `hooks` map keyed by the native
 *      event names, each holding `[{ hooks: [{ type:"command", command, timeout, async? }] }]`.
 *
 * ── Fidelity caveats (be honest — see references/README.md) ─────────────────
 *   - The harness accepts MANY more events than Honeycomb registers (Setup, Notification,
 *     SubagentStart, PreCompact, …). The conformance gate only asserts that every event the
 *     CONNECTOR writes is a name the harness accepts — so {@link CLAUDE_CODE_EVENT_NAMES}
 *     below enumerates the events relevant here plus the documented siblings, and the event
 *     KEY is validated by membership, not by an exact total-set match (a connector that adds
 *     a NEW valid event must not fail; a connector that emits a NON-event MUST).
 *   - The handler object carries harness fields this gate does not constrain (`if`, `once`,
 *     `args`, `statusMessage`, `shell`, `asyncRewake`). The schema therefore PASSES THROUGH
 *     unknown keys on the handler rather than inventing a strict closed shape we cannot
 *     justify — it asserts the parts we are confident in (`type`, `command`, the optional
 *     `timeout`/`async` numeric/boolean kinds) and tolerates the rest.
 */

import { z } from "zod";

/**
 * The native Claude Code lifecycle event names this gate recognizes as VALID config keys.
 *
 * Includes the six Honeycomb registers under (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
 * `PostToolUse`, `Stop`, `SessionEnd`) plus documented siblings (`SubagentStop`, `Notification`,
 * `PreCompact`, `SubagentStart`) so a future connector that legitimately registers one of those
 * is not falsely failed. A key NOT in this set is, by definition, an event the harness does not
 * accept — the exact failure the gate exists to catch.
 *
 * Source: code.claude.com/docs/en/hooks event list (subset of the documented events; the full
 * list is larger, but these are the lifecycle events relevant to a hooks-based memory connector).
 */
export const CLAUDE_CODE_EVENT_NAMES = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"SubagentStop",
	"SessionEnd",
	"Notification",
	"PreCompact",
	"SubagentStart",
] as const;

/** A single Claude Code command hook handler — the leaf of `hooks[event][block].hooks[]`. */
export const claudeCodeHookHandler = z
	.object({
		// `type` is required; `"command"` is the form Honeycomb emits. Other documented types
		// (`http`, `mcp_tool`, `prompt`, `agent`) exist but Honeycomb only writes command hooks.
		type: z.string().min(1),
		// `command` is required for a command hook (the shell command / node invocation).
		command: z.string().min(1),
		// Optional: seconds before the harness cancels the hook.
		timeout: z.number().optional(),
		// Optional: real Claude Code command-hook field — run in background without blocking.
		async: z.boolean().optional(),
	})
	// Tolerate the harness fields this gate does not constrain (`if`, `once`, `args`, `shell`,
	// `statusMessage`, `asyncRewake`) AND Honeycomb's own `_honeycomb` sentinel, which the
	// harness round-trips verbatim. Passthrough is the honest choice over a closed shape we
	// cannot fully justify from the public docs.
	.passthrough();

/** A matcher group under an event key: an optional `matcher` filter + the `hooks` handler array. */
export const claudeCodeMatcherBlock = z
	.object({
		// Optional filter (exact string / regex / `*`). Honeycomb omits it (applies to all),
		// which is valid since `matcher` is not required.
		matcher: z.string().optional(),
		// Required: the array of handler objects.
		hooks: z.array(claudeCodeHookHandler),
	})
	.passthrough();

/**
 * The top-level Claude Code `hooks` object: each key MUST be a recognized event name (validated
 * by {@link CLAUDE_CODE_EVENT_NAMES} membership via {@link assertClaudeCodeHooksConform}), each
 * value an array of matcher blocks. The settings file itself carries many other top-level keys
 * (`permissions`, `env`, `model`, …); this schema validates ONLY the `hooks` sub-object, which is
 * all the connector writes.
 */
export const claudeCodeHooksMap = z.record(z.string(), z.array(claudeCodeMatcherBlock));

/** The full settings shape the connector serializes — `hooks` plus any preserved foreign keys. */
export const claudeCodeSettings = z
	.object({
		hooks: claudeCodeHooksMap.optional(),
	})
	.passthrough();

export type ClaudeCodeEventName = (typeof CLAUDE_CODE_EVENT_NAMES)[number];
export type ClaudeCodeSettings = z.infer<typeof claudeCodeSettings>;

const EVENT_SET: ReadonlySet<string> = new Set(CLAUDE_CODE_EVENT_NAMES);

/** True iff `name` is a Claude Code lifecycle event the harness accepts as a `hooks` key. */
export function isClaudeCodeEvent(name: string): boolean {
	return EVENT_SET.has(name);
}

/**
 * Assert a parsed `settings.json` object CONFORMS to the real Claude Code hooks contract:
 *   1. the `hooks` sub-object parses against {@link claudeCodeSettings} (structure), AND
 *   2. EVERY `hooks` key is a recognized event name (the typo/rename catch).
 *
 * Throws a `ZodError` (structure) or a plain `Error` (unknown event) on non-conformance — the
 * test asserts it does NOT throw. Returns the validated settings on success.
 */
export function assertClaudeCodeHooksConform(config: unknown): ClaudeCodeSettings {
	const parsed = claudeCodeSettings.parse(config);
	for (const event of Object.keys(parsed.hooks ?? {})) {
		if (!isClaudeCodeEvent(event)) {
			throw new Error(
				`Claude Code hooks conformance: "${event}" is not an event name the harness accepts ` +
					`(valid: ${CLAUDE_CODE_EVENT_NAMES.join(", ")}). A real install under this config ` +
					`would silently drop the hook.`,
			);
		}
	}
	return parsed;
}
