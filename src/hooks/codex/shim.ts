/**
 * Codex shim — PRD-019c Wave 2 (FR-3 / c-AC-4).
 *
 * Codex maps `SessionStart`, `UserPromptSubmit`, `PreToolUse(Bash)`, `PostToolUse`,
 * `Stop` onto the contract. Three divergences from the Claude Code reference:
 *   1. session-start DEFERS `autoUpdate` + table-ensure to a DETACHED
 *      `session-start-setup.ts` process (so the interactive hook stays fast), and
 *      injects ONLY a brief login-state line — its hook context is USER-VISIBLE
 *      (c-AC-4). The {@link codexSessionStartSetup} descriptor names the detached
 *      process; {@link CODEX_LOGIN_LINE} is the brief line rendered.
 *   2. it intercepts Bash ONLY — a `PreToolUse` for any non-Bash tool is dropped
 *      (returns no normalized data), so only Bash reaches the VFS intercept (FR-3).
 *   3. channel `user-visible`; host CLI `codex exec --dangerously-bypass-approvals-
 *      and-sandbox`; runtime path `legacy`.
 *
 * References gate (FR-11 / D-3 / c-AC-6): the Codex hooks protocol event names +
 * payload shapes are cited at `references/codex/`.
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
	preToolData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "../normalize.js";
import type { HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

export const CODEX_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	SessionStart: "session-start",
	UserPromptSubmit: "user_message",
	PreToolUse: "pre-tool-use",
	PostToolUse: "tool_call",
	Stop: "assistant_message",
};

export const CODEX_CONTEXT_CHANNEL: ContextChannel = "user-visible";
export const CODEX_RUNTIME_PATH: RuntimePath = "legacy";
export const CODEX_HOST_CLI: HostCli = {
	bin: "codex",
	args: ["exec", "--dangerously-bypass-approvals-and-sandbox"],
};
export const CODEX_REFERENCES = "references/codex/" as const;

/**
 * The DETACHED session-start setup process (FR-3 / c-AC-4). Codex defers
 * `autoUpdate` + table-ensure to this process so the interactive session-start hook
 * returns immediately with only the brief login line. The shim spawns it
 * fire-and-forget; the descriptor is asserted by the c-AC-4 test (the work is
 * detached, not inline). The real binding wires this to the 019b
 * `SessionStartSeams.autoUpdate`/`ensureTables` in the deferred assembly step.
 */
export const codexSessionStartSetup = {
	/** The detached setup entry (a sibling script under the Codex bundle). */
	entry: "session-start-setup.ts",
	/** True — the setup runs in a DETACHED process, not inline in the hook (c-AC-4). */
	detached: true,
	/** The steps the detached process runs (the ones the interactive hook defers). */
	deferred: ["autoUpdate", "ensureTables"] as const,
} as const;

/** Render Codex's brief, USER-VISIBLE login-state line (c-AC-4) — NOT the full block. */
export const CODEX_LOGIN_LINE = "honeycomb: signed in — memory recall active" as const;

/**
 * Condense the full context block to Codex's brief login line (c-AC-4 / c-AC-5).
 * Codex injects ONLY a login-state line into its user-visible transcript; an empty
 * block (signed-out / read-only) renders the read-only line.
 */
export function codexRenderUserVisible(block: string): string {
	return block.trim() === "" ? "honeycomb: read-only (run `honeycomb login`)" : CODEX_LOGIN_LINE;
}

/** Render Codex's strict, event-specific JSON stdout contract for SessionStart. */
export function codexRenderHookResponse(
	nativeEventName: string,
	block: string,
	extras?: { readonly systemMessage?: string },
): unknown | undefined {
	if (nativeEventName !== "SessionStart") return undefined;
	return {
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: codexRenderUserVisible(block),
		},
		...(extras?.systemMessage !== undefined ? { systemMessage: extras.systemMessage } : {}),
	};
}

/**
 * Lower a Codex native payload into the CANONICAL normalized data (c-AC-1). Codex's
 * field names mirror Claude Code's hook shape, but the Bash-ONLY rule lives here: a
 * `pre-tool-use` for any non-Bash tool returns `undefined`, so only Bash reaches the
 * shared VFS intercept (FR-3). All other events reuse the canonical `*Data` builders,
 * so Codex's normalized output is byte-identical to the reference's.
 */
export function codexExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(pickString(raw, "source") || "startup");
		case "user_message":
			return userMessageData(pickString(raw, "prompt", "text", "message"));
		case "pre-tool-use": {
			const tool = pickString(raw, "tool_name", "tool");
			if (tool !== "Bash") return undefined; // Bash-only intercept (FR-3).
			return preToolData("Bash", { command: pickString(raw, "command") || undefined });
		}
		case "tool_call":
			return toolCallData(
				pickString(raw, "tool_name", "tool"),
				nested(raw, "tool_input"),
				nested(raw, "tool_response"),
			);
		case "assistant_message":
			return assistantMessageData(pickString(raw, "text", "message"));
		default:
			return undefined;
	}
}

/** Construct the Codex shim (FR-3). Brief login line + Bash-only + detached setup. */
export function createCodexShim(): HarnessShim {
	return createShim({
		harness: "codex",
		runtimePath: CODEX_RUNTIME_PATH,
		contextChannel: CODEX_CONTEXT_CHANNEL,
		hostCli: CODEX_HOST_CLI,
		references: CODEX_REFERENCES,
		eventMap: CODEX_EVENT_MAP,
		renderUserVisible: codexRenderUserVisible,
		renderHookResponse: codexRenderHookResponse,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return codexExtractData(raw, logical);
		},
	});
}
