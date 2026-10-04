/**
 * Hermes shell-hook shim.
 *
 * Hermes exposes lifecycle hooks through `$HERMES_HOME/config.yaml`. Each hook receives
 * a JSON envelope on stdin with event-specific fields under `extra`. Honeycomb runs
 * the pre-LLM hook twice: capture mode records the user message; recall mode performs
 * synchronous per-turn recall and returns Hermes' native `{ context }` response.
 * References gate: `references/hermes/` mirrors the authoritative Hermes shell-hook protocol.
 */

import type { ContextChannel, HarnessShim, HostCli, RuntimePath } from "../contracts.js";
import {
	asRecord,
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

/** Current Hermes shell-hook events used by the capture-mode adapter. */
export const HERMES_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	on_session_start: "session-start",
	pre_llm_call: "user_message",
	post_tool_call: "tool_call",
	post_llm_call: "assistant_message",
	on_session_finalize: "session-end",
};

/** Recall-mode map: only the synchronous pre-LLM injector is active. */
export const HERMES_RECALL_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	pre_llm_call: "user_prompt_recall",
};

export type HermesHookMode = "capture" | "recall";
export const HERMES_RECALL_HOOK_ARG = "--honeycomb-recall" as const;

export function detectHermesHookMode(argv: readonly string[] = process.argv): HermesHookMode {
	return argv.slice(2).includes(HERMES_RECALL_HOOK_ARG) ? "recall" : "capture";
}

export const HERMES_CONTEXT_CHANNEL: ContextChannel = "model-only";
export const HERMES_RUNTIME_PATH: RuntimePath = "legacy";
export const HERMES_HOST_CLI: HostCli = { bin: "hermes", args: ["chat", "-Q", "-q"] };
export const HERMES_REFERENCES = "references/hermes/" as const;

export function hermesRenderUserVisible(block: string): string {
	return block;
}

export function hermesContextOutput(text: string): { readonly context: string } {
	return { context: text };
}

/**
 * Hermes consumes injected context only from `pre_llm_call`. Session-start recall is
 * still run for Honeycomb's setup/notification lifecycle, but its stdout is a benign
 * no-op because Hermes ignores context on that event.
 */
export function hermesRenderHookResponse(nativeEventName: string, block: string): unknown | undefined {
	if (nativeEventName === "pre_llm_call") return hermesContextOutput(hermesRenderUserVisible(block));
	if (nativeEventName === "on_session_start") return {};
	return undefined;
}

function extra(raw: unknown): Record<string, unknown> {
	return asRecord(nested(raw, "extra"));
}

function extraString(raw: unknown, ...keys: readonly string[]): string {
	return pickString(extra(raw), ...keys);
}

/** Lower the current Hermes shell-hook envelope into canonical Honeycomb data. */
export function hermesExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(extraString(raw, "source") || "startup");
		case "user_message":
		case "user_prompt_recall":
			return userMessageData(extraString(raw, "user_message", "message", "prompt", "text"));

		case "tool_call": {
			const tool = pickString(raw, "tool_name", "tool");
			return toolCallData(tool, nested(raw, "tool_input"), nested(extra(raw), "result"));
		}
		case "assistant_message":
			return assistantMessageData(extraString(raw, "assistant_response", "response", "text", "message"));
		case "session-end":
			return sessionEndData(extraString(raw, "reason") || "on_session_finalize");
		default:
			return undefined;
	}
}

export function createHermesShim(options: { readonly mode?: HermesHookMode } = {}): HarnessShim {
	const mode = options.mode ?? detectHermesHookMode();
	return createShim({
		harness: "hermes",
		runtimePath: HERMES_RUNTIME_PATH,
		contextChannel: HERMES_CONTEXT_CHANNEL,
		hostCli: HERMES_HOST_CLI,
		references: HERMES_REFERENCES,
		eventMap: mode === "recall" ? HERMES_RECALL_EVENT_MAP : HERMES_EVENT_MAP,
		renderUserVisible: hermesRenderUserVisible,
		renderHookResponse: hermesRenderHookResponse,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return hermesExtractData(raw, logical);
		},
	});
}
