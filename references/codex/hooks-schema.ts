/**
 * Codex `hooks.json` — executable schema for the lifecycle hook shape Honeycomb emits.
 *
 * Source: OpenAI Codex hooks docs (`developers.openai.com/codex/hooks`): top-level `hooks`
 * object, event keys such as `SessionStart`/`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`,
 * matcher blocks, and command handlers with `type`, `command`, optional `timeout`, and optional
 * `statusMessage`.
 */

import { z } from "zod";

export const CODEX_EVENT_NAMES = [
	"SessionStart",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"UserPromptSubmit",
	"SubagentStart",
	"SubagentStop",
	"Stop",
] as const;

export const codexHookHandler = z
	.object({
		type: z.string().min(1),
		command: z.string().min(1),
		timeout: z.number().optional(),
		statusMessage: z.string().optional(),
	})
	.passthrough();

export const codexMatcherBlock = z
	.object({
		matcher: z.string().optional(),
		hooks: z.array(codexHookHandler),
	})
	.passthrough();

export const codexHooksMap = z.record(z.string(), z.array(codexMatcherBlock));

export const codexHooksFile = z
	.object({
		hooks: codexHooksMap.optional(),
	})
	.passthrough();

export type CodexHooksFile = z.infer<typeof codexHooksFile>;

/**
 * Codex `SessionStart` JSON stdout contract.
 *
 * Codex rejects unknown top-level fields, so a generic channel envelope such as
 * `{ channel: "user-visible", text: "..." }` is not a valid hook response even
 * though it is valid JSON. Context must ride under the event-specific wrapper.
 */
export const codexSessionStartOutput = z
	.object({
		continue: z.boolean().optional(),
		stopReason: z.string().optional(),
		suppressOutput: z.boolean().optional(),
		systemMessage: z.string().optional(),
		hookSpecificOutput: z
			.object({
				hookEventName: z.literal("SessionStart"),
				additionalContext: z.string().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type CodexSessionStartOutput = z.infer<typeof codexSessionStartOutput>;

const EVENT_SET: ReadonlySet<string> = new Set(CODEX_EVENT_NAMES);

export function isCodexEvent(name: string): boolean {
	return EVENT_SET.has(name);
}

export function assertCodexHooksConform(config: unknown): CodexHooksFile {
	const parsed = codexHooksFile.parse(config);
	for (const event of Object.keys(parsed.hooks ?? {})) {
		if (!isCodexEvent(event)) {
			throw new Error(
				`Codex hooks conformance: "${event}" is not an event name the harness accepts ` +
					`(valid: ${CODEX_EVENT_NAMES.join(", ")}).`,
			);
		}
	}
	return parsed;
}

export function assertCodexSessionStartOutput(output: unknown): CodexSessionStartOutput {
	return codexSessionStartOutput.parse(output);
}
