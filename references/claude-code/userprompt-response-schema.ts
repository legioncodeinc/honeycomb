/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * Claude Code `UserPromptSubmit` hook RESPONSE - the REAL harness stdout contract, as an executable zod oracle.
 *
 * ── What this is (the references gate, EXECUTABLE for the UserPromptSubmit response) ──
 * A sibling of `pretool-response-schema.ts`. Where that pins the `PreToolUse` block-and-inject
 * response, this pins the `UserPromptSubmit` context-injection response - the shape a
 * `UserPromptSubmit` command hook prints to stdout to add context to the model for THIS turn.
 * PRD-076a's per-turn recall arm renders its hits into this shape; the conformance test parses the
 * shim's EMITTED response through THIS oracle, so a renderer that stamps the wrong `hookEventName`
 * (or drops the `hookSpecificOutput` wrapper) FAILS the gate.
 *
 * This schema encodes the EXTERNAL Claude Code protocol, NOT Honeycomb's own renderer types. That
 * independence is the point: it is an oracle the renderer is checked against, never a mirror of the
 * code under test.
 *
 * ── The pinned channel (a-AC-5) ─────────────────────────────────────────────
 * The installed, 2026-current Claude Code contract delivers `UserPromptSubmit` additional context
 * under a `hookSpecificOutput` object whose `hookEventName` MUST be the literal `"UserPromptSubmit"`
 * and whose `additionalContext` string is added to the model's context before it processes the
 * prompt. So Honeycomb pins {@link PINNED_USERPROMPT_INJECT_CHANNEL} = `"hookSpecificOutput.additionalContext"`:
 * the recall hits reach the model under the host's documented per-event channel.
 *
 * BELT-AND-SUSPENDERS: the renderer ALSO carries a top-level `additionalContext` (the shared
 * model-only `ContextEnvelope`'s field). The oracle PASSES THROUGH that (and the `channel` tag) as
 * unknown/tolerated keys; it asserts only the part we are confident in - the `hookSpecificOutput`
 * wrapper + the `hookEventName` literal - exactly as the PreToolUse oracle passes through the
 * universal response fields. This mirrors the 075b block-and-inject precedent (two channels, same
 * content) so a build that reads either location still receives the hits.
 *
 * ── Sources (high fidelity, 2026-current) ───────────────────────────────────
 *   1. Claude Code hooks reference (code.claude.com/docs/en/hooks) "UserPromptSubmit": a hook may
 *      add context via `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"` and an
 *      `additionalContext` string; the context is injected before the model processes the prompt.
 *   2. Same reference, "Add context for Claude": `additionalContext` is inserted where the hook
 *      fired and read on the model's next request.
 *
 * ── Fidelity caveats (be honest - see references/README.md) ─────────────────
 *   - The response object carries universal fields this gate does not constrain (`continue`,
 *     `stopReason`, `suppressOutput`, `systemMessage`) plus Honeycomb's own `channel` tag. The
 *     schema PASSES THROUGH unknown keys rather than inventing a closed shape; it asserts only the
 *     `hookSpecificOutput.hookEventName` literal.
 */

import { z } from "zod";

/**
 * The pinned UserPromptSubmit context-injection channel (a-AC-5): `hookSpecificOutput.additionalContext`.
 * Recorded here as the single source of truth for the channel the installed contract supports.
 */
export const PINNED_USERPROMPT_INJECT_CHANNEL = "hookSpecificOutput.additionalContext" as const;

/**
 * The `hookSpecificOutput` object a `UserPromptSubmit` hook returns. `hookEventName` MUST be the
 * literal `"UserPromptSubmit"` (a mismatch is the exact drift this gate catches); `additionalContext`
 * is asserted by kind, not required, and unknown keys pass through (the harness carries more than we pin).
 */
export const claudeCodeUserPromptHookSpecificOutput = z
	.object({
		hookEventName: z.literal("UserPromptSubmit"),
		additionalContext: z.string().optional(),
	})
	.passthrough();

/**
 * The full `UserPromptSubmit` response envelope printed to stdout. The injection form lives under
 * `hookSpecificOutput`; a no-injection turn is the empty object `{}` (no `hookSpecificOutput`).
 * Universal fields + Honeycomb's `channel`/top-level `additionalContext` pass through.
 */
export const claudeCodeUserPromptResponse = z
	.object({
		hookSpecificOutput: claudeCodeUserPromptHookSpecificOutput.optional(),
	})
	.passthrough();

export type ClaudeCodeUserPromptHookSpecificOutput = z.infer<typeof claudeCodeUserPromptHookSpecificOutput>;
export type ClaudeCodeUserPromptResponse = z.infer<typeof claudeCodeUserPromptResponse>;

/**
 * Assert a parsed `UserPromptSubmit` response CONFORMS to the real Claude Code contract:
 *   1. it parses against {@link claudeCodeUserPromptResponse} (structure + the `hookEventName` literal), AND
 *   2. when a `hookSpecificOutput` is present, its `hookEventName` is exactly `"UserPromptSubmit"`.
 *
 * Throws a `ZodError` (structure / wrong literal) or a plain `Error` (wrong event) on non-conformance -
 * the test asserts it does NOT throw. Returns the validated response on success.
 */
export function assertClaudeCodeUserPromptResponse(response: unknown): ClaudeCodeUserPromptResponse {
	const parsed = claudeCodeUserPromptResponse.parse(response);
	if (parsed.hookSpecificOutput !== undefined && parsed.hookSpecificOutput.hookEventName !== "UserPromptSubmit") {
		throw new Error(
			`Claude Code UserPromptSubmit conformance: hookEventName must be "UserPromptSubmit", got ` +
				`"${String(parsed.hookSpecificOutput.hookEventName)}". A real install would ignore this response.`,
		);
	}
	return parsed;
}

/**
 * The text this response injects into the model's context, or `undefined` when it injects nothing.
 * Reads the pinned `hookSpecificOutput.additionalContext` channel.
 */
export function injectedUserPromptContext(response: ClaudeCodeUserPromptResponse): string | undefined {
	const out = response.hookSpecificOutput;
	if (out === undefined) return undefined;
	if (typeof out.additionalContext === "string" && out.additionalContext.length > 0) return out.additionalContext;
	return undefined;
}

/**
 * True when `response` is a pure NO-INJECTION ack: no `hookSpecificOutput` at all (the turn proceeds
 * with no added context). This is what an empty-recall, throttled-off turn serializes to.
 */
export function isNoInjection(response: ClaudeCodeUserPromptResponse): boolean {
	return response.hookSpecificOutput === undefined;
}
