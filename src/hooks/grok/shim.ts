/**
 * Grok shim — PRD-019c extension (Grok Build CLI harness).
 *
 * Grok Build maps Claude/Codex-compatible lifecycle hooks (`SessionStart`,
 * `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) from `~/.grok/hooks/*.json`
 * onto the shared contract. Divergences from the Claude Code reference:
 *   1. native stdin carries `hookEventName` in snake_case (`pre_tool_use`) as well as
 *      PascalCase — both are mapped (Grok docs, 10-hooks.md).
 *   2. terminal tools arrive as `run_terminal_command` (with `Bash` alias in matchers);
 *      the shim normalizes them to the canonical `Bash` pre-tool shape for VFS recall.
 *   3. cwd may arrive as `workspaceRoot` (camelCase) — refined via `deriveMeta`.
 *   4. context channel is user-visible with a brief login line (Codex pattern).
 *
 * References gate: cited at `references/grok/`.
 *
 * THIN OVERRIDE: shares the `createShim` engine; the daemon call lives in the 019b core.
 */

import type { ContextChannel, HarnessShim, HostCli, RuntimePath } from "../contracts.js";
import {
	assistantMessageData,
	createShim,
	nested,
	pickString,
	preToolData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "../normalize.js";
import type { HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

/** PascalCase + snake_case native names Grok emits on stdin (`hookEventName`). */
export const GROK_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	SessionStart: "session-start",
	session_start: "session-start",
	UserPromptSubmit: "user_message",
	user_prompt_submit: "user_message",
	PreToolUse: "pre-tool-use",
	pre_tool_use: "pre-tool-use",
	PostToolUse: "tool_call",
	post_tool_use: "tool_call",
	Stop: "assistant_message",
	stop: "assistant_message",
};

export const GROK_CONTEXT_CHANNEL: ContextChannel = "user-visible";
export const GROK_RUNTIME_PATH: RuntimePath = "legacy";
export const GROK_HOST_CLI: HostCli = { bin: "grok", args: ["agent", "stdio"] };
export const GROK_REFERENCES = "references/grok/" as const;

/** Render Grok's brief, user-visible login-state line — not the full recall block. */
export const GROK_LOGIN_LINE = "honeycomb: signed in — memory recall active" as const;

/** True when a Grok tool name is a terminal/shell invocation (Bash alias included). */
export function grokIsTerminalTool(tool: string): boolean {
	return tool === "Bash" || tool === "run_terminal_command";
}

/** Condense the full context block to Grok's brief login line. */
export function grokRenderUserVisible(block: string): string {
	return block.trim() === "" ? "honeycomb: read-only (run `honeycomb login`)" : GROK_LOGIN_LINE;
}

/**
 * Refine session metadata: Grok reports `workspaceRoot` (camelCase) alongside `cwd`.
 */
export function grokDeriveMeta(raw: unknown, base: HookSessionMeta): HookSessionMeta {
	const ws = pickString(raw, "workspaceRoot", "workspace_root");
	if (ws !== undefined && ws !== "") return { ...base, cwd: ws };
	return base;
}

/**
 * Lower a Grok native payload into the canonical normalized data. Terminal tools
 * (`run_terminal_command` / `Bash`) on `pre-tool-use` reach the shared VFS intercept;
 * every other event reuses the canonical `*Data` builders.
 */
export function grokExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(pickString(raw, "source") || "startup");
		case "user_message":
			return userMessageData(pickString(raw, "prompt", "text", "message"));
		case "pre-tool-use": {
			const tool = pickString(raw, "tool_name", "toolName", "tool");
			if (!grokIsTerminalTool(tool ?? "")) return undefined;
			const inputObj = nested(raw, "tool_input") ?? nested(raw, "toolInput");
			const command =
				(typeof inputObj === "object" && inputObj !== null
					? pickString(inputObj, "command")
					: undefined) ?? pickString(raw, "command") ?? undefined;
			return preToolData("Bash", { command });
		}
		case "tool_call":
			return toolCallData(
				pickString(raw, "tool_name", "toolName", "tool"),
				nested(raw, "tool_input") ?? nested(raw, "toolInput"),
				nested(raw, "tool_response") ?? nested(raw, "toolOutput") ?? nested(raw, "tool_output"),
			);
		case "assistant_message":
			return assistantMessageData(pickString(raw, "text", "message"));
		default:
			return undefined;
	}
}

/** Construct the Grok shim. Claude-compatible hooks + terminal-tool intercept. */
export function createGrokShim(): HarnessShim {
	return createShim({
		harness: "grok",
		runtimePath: GROK_RUNTIME_PATH,
		contextChannel: GROK_CONTEXT_CHANNEL,
		hostCli: GROK_HOST_CLI,
		references: GROK_REFERENCES,
		eventMap: GROK_EVENT_MAP,
		deriveMeta: grokDeriveMeta,
		renderUserVisible: grokRenderUserVisible,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return grokExtractData(raw, logical);
		},
	});
}
