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
 * Claude Code `PreToolUse` hook RESPONSE - the REAL harness stdout contract, as an executable zod oracle.
 *
 * ── What this is (the references gate, now EXECUTABLE for the PreToolUse response) ──
 * `references/claude-code/hooks-schema.ts` already pins the harness CONFIG contract (the
 * `settings.json#hooks` shape a connector writes). This sibling pins the other half: the
 * RESPONSE a `PreToolUse` command hook prints to stdout to BLOCK the real tool and INJECT
 * text into the model's context. PRD-075b renders the shared-core {@link PreToolDecision}
 * into this shape; the conformance test (`tests/daemon/runtime/hooks/pretool-render.test.ts`)
 * parses the shim's EMITTED response through THIS oracle, so a renderer that emits a field
 * the harness ignores - or omits one it needs to block - FAILS the gate.
 *
 * This schema encodes the EXTERNAL Claude Code protocol, NOT Honeycomb's own renderer types.
 * That independence is the point: it is an oracle the renderer is checked against, never a
 * mirror of the code under test.
 *
 * ── The pinned block-and-inject channel (b-AC-1) ────────────────────────────
 * The installed, 2026-current Claude Code contract supports BOTH halves of a single
 * `hookSpecificOutput` object on `PreToolUse`:
 *   - `permissionDecision: "deny"`  BLOCKS the real tool (the tool never runs).
 *   - `additionalContext: <string>` INJECTS a string into the model's context alongside the
 *     (blocked) tool result. Wrapped in a system reminder, read on the next model request.
 * So Honeycomb pins {@link PINNED_BLOCK_AND_INJECT_CHANNEL} = `"deny+additionalContext"`:
 * deny stops the grep/cat, `additionalContext` carries the daemon's hybrid-recall hits to the
 * model. `additionalContext` on `PreToolUse` landed in Claude Code v2.1.9 (anthropics/claude-code
 * issue #15664) and is documented in the PreToolUse decision-control table.
 *
 * BELT-AND-SUSPENDERS: the renderer ALSO sets `permissionDecisionReason` to the same hits. For a
 * `deny`, the reason is shown to the model (docs: "For `deny`, shown to Claude"), so on any older
 * build where `additionalContext` is not yet honored on `PreToolUse`, the hits still reach the
 * model AS the deny reason (the PRD's "Channel 2" fallback). Both channels carry the same content.
 *
 * ── Rewrite vs block ────────────────────────────────────────────────────────
 * A `rewrite` decision (the harmless-echo no-op) is NOT a block: it renders
 * `permissionDecision: "allow"` + `updatedInput` (which "Replaces the entire input object" and,
 * combined with `allow`, auto-approves), so the tool RUNS but against the substituted args. An
 * `allow` decision is pure pass-through: the renderer emits NO response (the binary writes the
 * benign `{}` ack) so the real tool runs under the host's normal permission flow, un-skipped.
 *
 * ── Sources (high fidelity, 2026-current) ───────────────────────────────────
 *   1. Claude Code hooks reference (code.claude.com/docs/en/hooks) "PreToolUse decision control":
 *      `hookSpecificOutput` with `permissionDecision` (allow/deny/ask/defer),
 *      `permissionDecisionReason`, `updatedInput` (replaces the whole input; pair with allow/ask),
 *      and `additionalContext` (added to Claude's context; ignored for `defer`).
 *   2. Same reference, "Add context for Claude": `additionalContext` is wrapped in a system
 *      reminder and inserted where the hook fired; capped at 10,000 characters.
 *   3. anthropics/claude-code issue #15664: `additionalContext` support added to `PreToolUse`
 *      hooks (implemented in v2.1.9).
 *
 * ── Fidelity caveats (be honest - see references/README.md) ─────────────────
 *   - The response object carries universal fields this gate does not constrain (`continue`,
 *     `stopReason`, `suppressOutput`, `systemMessage`). The schema PASSES THROUGH unknown keys
 *     rather than inventing a closed shape; it asserts only the parts we are confident in - the
 *     `hookSpecificOutput.hookEventName` literal and the `permissionDecision` enum.
 *   - The deprecated top-level `decision`/`reason` form (mapped `approve`->`allow`, `block`->`deny`)
 *     is tolerated via passthrough but NOT the pinned channel; the renderer uses the current
 *     `hookSpecificOutput` form exclusively.
 */

import { z } from "zod";

/** The four `PreToolUse` permission decisions the harness accepts (docs: PreToolUse decision control). */
export const PRETOOL_PERMISSION_DECISIONS = ["allow", "deny", "ask", "defer"] as const;

/** One `PreToolUse` permission decision. */
export type PreToolPermissionDecision = (typeof PRETOOL_PERMISSION_DECISIONS)[number];

/**
 * The pinned block-and-inject channel (b-AC-1). `deny` blocks the real tool; `additionalContext`
 * injects the daemon hits into the model's context. Recorded here as the single source of truth
 * for which of the PRD's candidate channels the installed contract supports.
 */
export const PINNED_BLOCK_AND_INJECT_CHANNEL = "deny+additionalContext" as const;

/**
 * The `hookSpecificOutput` object a `PreToolUse` hook returns. `hookEventName` MUST be the literal
 * `"PreToolUse"` (a mismatch is the exact drift this gate catches); `permissionDecision` MUST be one
 * of the four documented values when present. The optional carriers (`permissionDecisionReason`,
 * `updatedInput`, `additionalContext`) are asserted by kind, not required, and unknown keys pass
 * through (the harness carries more than we pin).
 */
export const claudeCodePreToolHookSpecificOutput = z
	.object({
		hookEventName: z.literal("PreToolUse"),
		permissionDecision: z.enum(PRETOOL_PERMISSION_DECISIONS).optional(),
		permissionDecisionReason: z.string().optional(),
		updatedInput: z.record(z.string(), z.unknown()).optional(),
		additionalContext: z.string().optional(),
	})
	.passthrough();

/**
 * The full `PreToolUse` response envelope printed to stdout. The block-and-inject / rewrite forms
 * live under `hookSpecificOutput`; a pure pass-through is the empty object `{}` (no
 * `hookSpecificOutput`). Universal fields (`continue`, `systemMessage`, ...) pass through.
 */
export const claudeCodePreToolResponse = z
	.object({
		hookSpecificOutput: claudeCodePreToolHookSpecificOutput.optional(),
	})
	.passthrough();

export type ClaudeCodePreToolHookSpecificOutput = z.infer<typeof claudeCodePreToolHookSpecificOutput>;
export type ClaudeCodePreToolResponse = z.infer<typeof claudeCodePreToolResponse>;

const DECISION_SET: ReadonlySet<string> = new Set(PRETOOL_PERMISSION_DECISIONS);

/** True iff `d` is a `PreToolUse` permission decision the harness accepts. */
export function isPreToolPermissionDecision(d: unknown): d is PreToolPermissionDecision {
	return typeof d === "string" && DECISION_SET.has(d);
}

/**
 * Assert a parsed `PreToolUse` response CONFORMS to the real Claude Code contract:
 *   1. it parses against {@link claudeCodePreToolResponse} (structure + the `hookEventName`
 *      literal + the `permissionDecision` enum), AND
 *   2. when a `hookSpecificOutput` is present, its `hookEventName` is exactly `"PreToolUse"`.
 *
 * Throws a `ZodError` (structure / wrong literal / bad enum) on non-conformance - the test asserts
 * it does NOT throw. Returns the validated response on success.
 */
export function assertClaudeCodePreToolResponse(response: unknown): ClaudeCodePreToolResponse {
	const parsed = claudeCodePreToolResponse.parse(response);
	if (parsed.hookSpecificOutput !== undefined && parsed.hookSpecificOutput.hookEventName !== "PreToolUse") {
		throw new Error(
			`Claude Code PreToolUse conformance: hookEventName must be "PreToolUse", got ` +
				`"${String(parsed.hookSpecificOutput.hookEventName)}". A real install would ignore this response.`,
		);
	}
	return parsed;
}

/**
 * True when `response` BLOCKS the real tool - `permissionDecision: "deny"` (the block half of the
 * pinned channel; `defer` also prevents execution but is a resume-later path, not a block).
 */
export function blocksTool(response: ClaudeCodePreToolResponse): boolean {
	return response.hookSpecificOutput?.permissionDecision === "deny";
}

/**
 * The text this response injects into the model's context, or `undefined` when it injects nothing.
 * Prefers `additionalContext` (the pinned channel); falls back to `permissionDecisionReason` on a
 * `deny` (the Channel-2 safety net, where the hits arrive as the deny reason).
 */
export function injectedContext(response: ClaudeCodePreToolResponse): string | undefined {
	const out = response.hookSpecificOutput;
	if (out === undefined) return undefined;
	if (typeof out.additionalContext === "string" && out.additionalContext.length > 0) return out.additionalContext;
	if (out.permissionDecision === "deny" && typeof out.permissionDecisionReason === "string") {
		return out.permissionDecisionReason;
	}
	return undefined;
}

/** The rewritten tool input a `rewrite` render substitutes, or `undefined` when none. */
export function rewrittenInput(response: ClaudeCodePreToolResponse): Record<string, unknown> | undefined {
	return response.hookSpecificOutput?.updatedInput;
}

/**
 * True when `response` is a pure PASS-THROUGH: no `hookSpecificOutput` at all (the real tool runs
 * untouched under the host's normal permission flow). This is what an `allow` decision - and the
 * fail-soft no-decision path - must serialize to (b-AC-6: never a malformed block).
 */
export function isPassThrough(response: ClaudeCodePreToolResponse): boolean {
	return response.hookSpecificOutput === undefined;
}
