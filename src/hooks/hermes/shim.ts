/**
 * Hermes shim — PRD-019c Wave 2 (FR-6).
 *
 * Hermes (skill + shell hooks + MCP) maps `on_session_start`, `on_user_message`,
 * `on_tool_use` (terminal ONLY), `on_session_end`. Divergences from the reference:
 *   1. `on_tool_use` is captured ONLY for terminal tools — a non-terminal tool is
 *      dropped (returns no normalized data), per FR-6.
 *   2. context is USER-VISIBLE as a `{ context: "..." }` output carrying the FULL
 *      block PLUS an MCP-tools mention (so the user knows the `honeycomb_*` tools are
 *      available). {@link hermesRenderUserVisible} appends the mention;
 *      {@link hermesContextOutput} wraps it in the `{ context }` shape Hermes emits.
 *   3. host CLI `hermes --non-interactive`; runtime path `legacy` (shell hooks).
 *
 * References gate (FR-11 / D-3 / c-AC-6): cited at `references/hermes/`.
 *
 * THIN OVERRIDE: shares the `createShim` engine; the daemon call lives in the 019b
 * core. No SQL, no DeepLake (D-2).
 */

import type { ContextChannel, HarnessShim, HostCli, RuntimePath } from "../contracts.js";
import {
	assistantMessageData,
	createShim,
	nested,
	pickString,
	sessionEndData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "../normalize.js";
import type { HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

export const HERMES_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	on_session_start: "session-start",
	on_user_message: "user_message",
	on_tool_use: "tool_call",
	on_session_end: "session-end",
};

export const HERMES_CONTEXT_CHANNEL: ContextChannel = "user-visible";
export const HERMES_RUNTIME_PATH: RuntimePath = "legacy";
export const HERMES_HOST_CLI: HostCli = { bin: "hermes", args: ["--non-interactive"] };
export const HERMES_REFERENCES = "references/hermes/" as const;

/** The MCP-tools mention appended to Hermes's user-visible context block (FR-6). */
export const HERMES_MCP_MENTION =
	"\n\n(Honeycomb MCP tools available: honeycomb_search, honeycomb_read, honeycomb_index.)" as const;

/** True when a Hermes tool name is a terminal tool (the only tools captured, FR-6). */
export function hermesIsTerminalTool(tool: string): boolean {
	return tool === "terminal" || tool === "Terminal" || tool === "shell" || tool === "Shell" || tool === "Bash";
}

/**
 * Append the MCP-tools mention to the full context block for Hermes's user-visible
 * channel (FR-6 / c-AC-5). An empty block (signed-out / read-only) renders nothing —
 * the mention only rides a non-empty recall block.
 */
export function hermesRenderUserVisible(block: string): string {
	return block.trim() === "" ? "" : block + HERMES_MCP_MENTION;
}

/** Wrap Hermes's user-visible context text in the `{ context: "..." }` output shape (FR-6). */
export function hermesContextOutput(text: string): { readonly context: string } {
	return { context: text };
}

/**
 * Lower a Hermes native payload into the CANONICAL normalized data (c-AC-1). The
 * terminal-ONLY tool filter lives here: a non-terminal `on_tool_use` returns
 * `undefined` (dropped, FR-6). Every other event reuses the canonical `*Data`
 * builders, so Hermes's normalized output matches the reference's.
 */
export function hermesExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(pickString(raw, "source") || "startup");
		case "user_message":
			return userMessageData(pickString(raw, "message", "prompt", "text"));
		case "tool_call": {
			const tool = pickString(raw, "tool_name", "tool");
			if (!hermesIsTerminalTool(tool)) return undefined; // terminal-only (FR-6).
			return toolCallData(tool, nested(raw, "tool_input"), nested(raw, "tool_response"));
		}
		case "session-end":
			return sessionEndData(pickString(raw, "reason") || "on_session_end");
		case "assistant_message":
			return assistantMessageData(pickString(raw, "text", "message"));
		default:
			return undefined;
	}
}

/** Construct the Hermes shim (FR-6). Terminal-only tools + `{ context }` + MCP mention. */
export function createHermesShim(): HarnessShim {
	return createShim({
		harness: "hermes",
		runtimePath: HERMES_RUNTIME_PATH,
		contextChannel: HERMES_CONTEXT_CHANNEL,
		hostCli: HERMES_HOST_CLI,
		references: HERMES_REFERENCES,
		eventMap: HERMES_EVENT_MAP,
		renderUserVisible: hermesRenderUserVisible,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return hermesExtractData(raw, logical);
		},
	});
}
