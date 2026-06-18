/**
 * Cursor shim — PRD-019c Wave 2 (FR-4).
 *
 * Cursor maps `sessionStart`, `beforeSubmitPrompt`, `postToolUse`,
 * `afterAgentResponse`, `stop`, `sessionEnd`. Divergences from the reference:
 *   1. cwd comes from `workspace_roots[0]` (the editor's open roots), not a `cwd`
 *      field — applied via `deriveMeta` (FR-4).
 *   2. it intercepts the `Shell` tool (Cursor's terminal tool) for VFS recall, the
 *      Cursor analogue of Claude Code's Bash — normalized to the canonical `Bash`
 *      pre-tool shape so the shared VFS intercept treats it identically (c-AC-1).
 *   3. context lands MODEL-ONLY under the `additional_context` key; host CLI
 *      `cursor-agent` with a `claude` fallback; runtime path `plugin` (the extension).
 *
 * Only the Cursor HOOK shim is in scope here; the Cursor editor extension UX is
 * PRD-020c. References gate (FR-11 / D-3 / c-AC-6): cited at `references/cursor/`.
 *
 * THIN OVERRIDE: shares the `createShim` engine; the daemon call lives in the 019b
 * core. No SQL, no DeepLake (D-2).
 */

import type { ContextChannel, HarnessShim, HostCli, RuntimePath } from "../contracts.js";
import {
	asRecord,
	assistantMessageData,
	createShim,
	nested,
	pickString,
	preToolData,
	sessionEndData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "../normalize.js";
import type { HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

export const CURSOR_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	sessionStart: "session-start",
	beforeSubmitPrompt: "user_message",
	postToolUse: "tool_call",
	afterAgentResponse: "assistant_message",
	stop: "assistant_message",
	sessionEnd: "session-end",
};

export const CURSOR_CONTEXT_CHANNEL: ContextChannel = "model-only";
export const CURSOR_RUNTIME_PATH: RuntimePath = "plugin";
export const CURSOR_HOST_CLI: HostCli = { bin: "cursor-agent", args: [], fallbackBin: "claude" };
export const CURSOR_REFERENCES = "references/cursor/" as const;

/** The native Cursor key its context block lands under, MODEL-ONLY (FR-4 / FR-10). */
export const CURSOR_CONTEXT_KEY = "additional_context" as const;

/**
 * Cursor's `postToolUse` can carry the `Shell` tool (its terminal tool). The shim
 * normalizes `Shell` to the canonical `Bash` pre-tool shape so the shared VFS
 * intercept treats it identically to Claude Code's Bash (c-AC-1). A non-Shell tool
 * is captured as an ordinary tool_call.
 */
export function cursorIsShell(tool: string): boolean {
	return tool === "Shell";
}

/**
 * Derive Cursor's session metadata: cwd from `workspace_roots[0]` (FR-4). The
 * editor reports its open roots rather than a single `cwd`; the first root is the
 * turn's working directory.
 */
export function cursorDeriveMeta(raw: unknown, base: HookSessionMeta): HookSessionMeta {
	const roots = asRecord(raw).workspace_roots;
	if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0] !== "") {
		return { ...base, cwd: roots[0] };
	}
	return base;
}

/**
 * Lower a Cursor native payload into the CANONICAL normalized data (c-AC-1). The
 * `Shell` tool on `postToolUse` is normalized to the `Bash` pre-tool shape so it
 * reaches the VFS intercept like Claude Code's Bash; every other event reuses the
 * canonical `*Data` builders, so the normalized output matches the reference's.
 */
export function cursorExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(pickString(raw, "source") || "startup");
		case "user_message":
			return userMessageData(pickString(raw, "prompt", "text", "message"));
		case "tool_call": {
			const tool = pickString(raw, "tool_name", "tool");
			// A Shell tool that targets the memory mount is a VFS read intercept; the
			// shared core lowers it through `Bash` (c-AC-1). Otherwise a plain tool_call.
			if (cursorIsShell(tool)) {
				return preToolData("Bash", { command: pickString(raw, "command") || undefined });
			}
			return toolCallData(tool, nested(raw, "tool_input"), nested(raw, "tool_response"));
		}
		case "assistant_message":
			return assistantMessageData(pickString(raw, "text", "message"));
		case "session-end":
			return sessionEndData(pickString(raw, "reason") || "Stop");
		default:
			return undefined;
	}
}

/** Construct the Cursor shim (FR-4). workspace_roots cwd + Shell intercept + cursor-agent→claude. */
export function createCursorShim(): HarnessShim {
	return createShim({
		harness: "cursor",
		runtimePath: CURSOR_RUNTIME_PATH,
		contextChannel: CURSOR_CONTEXT_CHANNEL,
		hostCli: CURSOR_HOST_CLI,
		references: CURSOR_REFERENCES,
		eventMap: CURSOR_EVENT_MAP,
		deriveMeta: cursorDeriveMeta,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return cursorExtractData(raw, logical);
		},
	});
}
