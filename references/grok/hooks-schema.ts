/**
 * Grok `~/.grok/hooks/*.json` — executable schema for the lifecycle hook shape Honeycomb emits.
 *
 * Source: Grok Build user guide (`10-hooks.md`): top-level `hooks` object, Claude/Codex-compatible
 * event keys (`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`), matcher
 * blocks, and command handlers with `type`, `command`, and optional `timeout`.
 */

import { z } from "zod";

export const GROK_EVENT_NAMES = [
	"SessionStart",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"UserPromptSubmit",
	"Stop",
	"StopFailure",
	"SessionEnd",
] as const;

export const grokHookHandler = z
	.object({
		type: z.string().min(1),
		command: z.string().min(1),
		timeout: z.number().optional(),
	})
	.passthrough();

export const grokMatcherBlock = z
	.object({
		matcher: z.string().optional(),
		hooks: z.array(grokHookHandler),
	})
	.passthrough();

export const grokHooksMap = z.record(z.string(), z.array(grokMatcherBlock));

export const grokHooksFile = z
	.object({
		hooks: grokHooksMap.optional(),
	})
	.passthrough();

export type GrokHooksFile = z.infer<typeof grokHooksFile>;

const EVENT_SET: ReadonlySet<string> = new Set(GROK_EVENT_NAMES);

export function isGrokEvent(name: string): boolean {
	return EVENT_SET.has(name);
}

export function assertGrokHooksConform(config: unknown): GrokHooksFile {
	const parsed = grokHooksFile.parse(config);
	for (const event of Object.keys(parsed.hooks ?? {})) {
		if (!isGrokEvent(event)) {
			throw new Error(
				`Grok hooks conformance: "${event}" is not an event name the harness accepts ` +
					`(valid: ${GROK_EVENT_NAMES.join(", ")}).`,
			);
		}
	}
	return parsed;
}
