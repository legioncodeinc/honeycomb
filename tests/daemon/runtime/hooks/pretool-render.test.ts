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
 * PRD-075b — render the PreToolDecision: block-and-inject + conformance (b-AC-1..b-AC-6).
 *
 * 075a wired the `PreToolUse` recall path so the runtime SURFACES a `PreToolDecision`;
 * 075b turns that decision into a REAL Claude Code `PreToolUse` response that blocks the
 * tool and injects the daemon output. This suite proves:
 *   - b-AC-1: the block-and-inject contract is pinned as an executable oracle
 *     (`references/claude-code/pretool-response-schema.ts`) and the shim's emitted response
 *     parses against it (and the oracle BITES a malformed response).
 *   - b-AC-2: a `replace` render (a) prevents the real tool from running and (b) delivers
 *     the output to the model — asserted on the serialized stdout.
 *   - b-AC-3: `deny` → block + guidance; `rewrite` → substituted command; `allow` →
 *     untouched pass-through.
 *   - b-AC-4: end-to-end (shim + 075a runtime, daemon vfs faked): a mount `Grep` produces a
 *     serialized response that blocks the grep and carries the faked hybrid-recall hits.
 *   - b-AC-5: a non-claude-code harness (codex) that does not implement the renderer is
 *     unaffected — its pre-tool response is its prior channel envelope, not a block.
 *   - b-AC-6: fail-soft — an absent decision (075a fail-soft) or `allow` renders as
 *     pass-through, never a malformed block that could strand a turn.
 */

import { describe, expect, it } from "vitest";

import { type BinaryIo, runHookBinary } from "../../../../src/hooks/binary.js";
import { createClaudeCodeShim, renderClaudeCodePreTool } from "../../../../src/hooks/claude-code/shim.js";
import { createCodexShim } from "../../../../src/hooks/codex/shim.js";
import { createHookRuntime } from "../../../../src/hooks/runtime.js";
import {
	createFakeDaemonHookClient,
	createFakeVfsIntercept,
	HARMLESS_ECHO,
	type VfsIntercept,
	WRITE_DENY_GUIDANCE,
} from "../../../../src/hooks/shared/index.js";
import type { NotificationsPipeline } from "../../../../src/notifications/index.js";
import {
	assertClaudeCodePreToolResponse,
	blocksTool,
	type ClaudeCodePreToolResponse,
	injectedContext,
	isPassThrough,
	PINNED_BLOCK_AND_INJECT_CHANNEL,
	rewrittenInput,
} from "../../../../references/claude-code/pretool-response-schema.js";

/** A no-op notifications pipeline so runtime-level tests never touch a real daemon drain. */
const NOOP_NOTIFICATIONS: NotificationsPipeline = {
	async drain() {
		return { banner: null, suppressed: [] };
	},
};

/** A stdio surface that captures everything the driver writes to stdout. */
function captureIo(stdin: string): BinaryIo & { readonly out: string[] } {
	const out: string[] = [];
	return {
		out,
		async readStdin() {
			return stdin;
		},
		writeStdout(text) {
			out.push(text);
		},
	};
}

/** Serialize a native Claude Code PreToolUse envelope for stdin. */
function preToolStdin(payload: Record<string, unknown>): string {
	return JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sess-075b", ...payload });
}

/**
 * Drive one native PreToolUse event through the REAL shim + 075a runtime (daemon vfs faked)
 * and return the parsed, oracle-validated response the driver serialized to stdout.
 */
async function driveClaudeCodePreTool(
	payload: Record<string, unknown>,
	vfs: VfsIntercept,
): Promise<ClaudeCodePreToolResponse> {
	const runtime = createHookRuntime({ daemon: createFakeDaemonHookClient(), notifications: NOOP_NOTIFICATIONS, vfs });
	const io = captureIo(preToolStdin(payload));
	await runHookBinary({ shim: createClaudeCodeShim(), runtime, io });
	expect(io.out).toHaveLength(1);
	// Every serialized PreToolUse response the shim emits MUST parse against the pinned oracle.
	return assertClaudeCodePreToolResponse(JSON.parse(io.out[0]));
}

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-1 — the contract is pinned as an executable oracle, and it BITES.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-1: the Claude Code PreToolUse block-and-inject contract is pinned as an executable oracle", () => {
	it("b-AC-1: the pinned channel is deny + additionalContext (recorded in the oracle)", () => {
		expect(PINNED_BLOCK_AND_INJECT_CHANNEL).toBe("deny+additionalContext");
	});

	it("b-AC-1: the shim's emitted replace response parses against the oracle", async () => {
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Grep", tool_input: { path: "memory/notes.md", pattern: "needle" } },
			createFakeVfsIntercept({ content: "recall-hit" }),
		);
		// The parse inside driveClaudeCodePreTool already asserted conformance; re-assert explicitly.
		expect(() => assertClaudeCodePreToolResponse(response)).not.toThrow();
		expect(response.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
	});

	it("b-AC-1: the oracle REJECTS a response whose hookEventName is not PreToolUse (it bites)", () => {
		const wrongEvent = { hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } };
		expect(() => assertClaudeCodePreToolResponse(wrongEvent)).toThrow();
	});

	it("b-AC-1: the oracle REJECTS an invalid permissionDecision value (it bites)", () => {
		const badDecision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "blocked" } };
		expect(() => assertClaudeCodePreToolResponse(badDecision)).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-2 — replace blocks the real tool AND delivers output to the model.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-2: a replace decision blocks the real tool and delivers the output to the model", () => {
	it("b-AC-2: the serialized response (a) blocks the tool and (b) carries the daemon output", async () => {
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Read", tool_input: { file_path: "memory/x.md" } },
			createFakeVfsIntercept({ content: "the daemon row body" }),
		);
		// (a) the real Read is BLOCKED — permissionDecision: "deny".
		expect(blocksTool(response)).toBe(true);
		// (b) the daemon output reaches the model via the pinned channel.
		expect(response.hookSpecificOutput?.additionalContext).toBe("the daemon row body");
		expect(injectedContext(response)).toBe("the daemon row body");
	});

	it("b-AC-2: the output also rides permissionDecisionReason (the older-version Channel-2 fallback)", () => {
		const rendered = renderClaudeCodePreTool({ kind: "replace", output: "hits-here" });
		expect(rendered?.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(rendered?.hookSpecificOutput.permissionDecisionReason).toBe("hits-here");
		expect(rendered?.hookSpecificOutput.additionalContext).toBe("hits-here");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-3 — deny → block+guidance; rewrite → substituted command; allow → pass-through.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-3: deny / rewrite / allow each render to their correct PreToolUse response", () => {
	it("b-AC-3: a deny (mount write) renders as a block carrying the mount-write guidance", async () => {
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Write", tool_input: { file_path: "memory/x.md" } },
			createFakeVfsIntercept({ content: "unused" }),
		);
		expect(blocksTool(response)).toBe(true);
		expect(response.hookSpecificOutput?.permissionDecisionReason).toBe(WRITE_DENY_GUIDANCE);
		// A deny carries no separate additionalContext; the guidance IS the reason shown to the model.
		expect(injectedContext(response)).toBe(WRITE_DENY_GUIDANCE);
	});

	it("b-AC-3: a rewrite (unmodelable mount Bash) renders as the substituted harmless-echo command", async () => {
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Bash", tool_input: { command: "chmod 777 memory/x.md" } },
			createFakeVfsIntercept({ content: "unused" }),
		);
		// A rewrite is NOT a block — the tool runs, but against the substituted args.
		expect(blocksTool(response)).toBe(false);
		expect(response.hookSpecificOutput?.permissionDecision).toBe("allow");
		expect(rewrittenInput(response)).toEqual({ command: HARMLESS_ECHO });
	});

	it("b-AC-3: an allow (off-mount) renders as untouched pass-through (the real tool runs)", async () => {
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Bash", tool_input: { command: "cat /etc/hosts" } },
			createFakeVfsIntercept({ content: "must-not-appear" }),
		);
		expect(isPassThrough(response)).toBe(true);
		expect(blocksTool(response)).toBe(false);
		expect(injectedContext(response)).toBeUndefined();
	});

	it("b-AC-3: the renderer maps each decision kind to the exact native response (direct matrix)", () => {
		expect(renderClaudeCodePreTool({ kind: "allow" })).toBeUndefined();
		expect(renderClaudeCodePreTool({ kind: "deny", guidance: "no writes" })).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no writes",
			},
		});
		expect(renderClaudeCodePreTool({ kind: "rewrite", command: "echo hi" })).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "echo hi" },
			},
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-4 — end-to-end: mount Grep → 075a runtime → shim render → block + faked hits.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-4: end-to-end mount Grep blocks the grep and carries the faked hybrid-recall hits", () => {
	it("b-AC-4: a mount Grep produces a serialized PreToolUse response that blocks + carries the hits", async () => {
		const HITS = "memory/auth.md\n\nToken TTL dropped to 1h (decided 2026-07-01).";
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Grep", tool_input: { path: "memory/auth.md", pattern: "token" } },
			createFakeVfsIntercept({ content: HITS }),
		);
		// The real grep never runs (blocked), and the faked hybrid-recall hits reach the model.
		expect(blocksTool(response)).toBe(true);
		expect(injectedContext(response)).toBe(HITS);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-5 — a non-claude-code harness without the renderer is unaffected.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-5: a harness that does not implement the renderer keeps its prior pre-tool behavior", () => {
	it("b-AC-5: only the claude-code reference shim carries the pre-tool renderer", () => {
		expect("renderPreTool" in createClaudeCodeShim()).toBe(true);
		expect("renderPreTool" in createCodexShim()).toBe(false);
	});

	it("b-AC-5: codex's pre-tool replace is its prior channel envelope, NOT a block-and-inject response", async () => {
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient(),
			notifications: NOOP_NOTIFICATIONS,
			vfs: createFakeVfsIntercept({ content: "recall" }),
		});
		// Codex reads the Bash command from the flat `command` field (its native shape).
		const io = captureIo(
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "s",
				tool_name: "Bash",
				command: "grep needle memory/x.md",
			}),
		);
		await runHookBinary({ shim: createCodexShim(), runtime, io });
		expect(io.out).toHaveLength(1);
		const emitted = JSON.parse(io.out[0]) as Record<string, unknown>;
		// Codex emits its own user-visible channel envelope — no PreToolUse block-and-inject fields.
		expect(emitted.hookSpecificOutput).toBeUndefined();
		expect(emitted.channel).toBe("user-visible");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-6 — fail-soft: absent decision / allow → pass-through, never a malformed block.
// ─────────────────────────────────────────────────────────────────────────────

describe("b-AC-6: fail-soft — an absent decision or allow renders as pass-through, never a malformed block", () => {
	it("b-AC-6: a fail-soft no-decision outcome (vfs threw) serializes as the benign pass-through ack", async () => {
		const rejecting: VfsIntercept = {
			async resolve(): Promise<string> {
				throw new Error("daemon unreachable");
			},
		};
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient(),
			notifications: NOOP_NOTIFICATIONS,
			vfs: rejecting,
		});
		const io = captureIo(preToolStdin({ tool_name: "Read", tool_input: { file_path: "memory/x.md" } }));
		const outcome = await runHookBinary({ shim: createClaudeCodeShim(), runtime, io });

		// 075a's fail-soft path: no decision rode the outcome.
		expect(outcome.decision).toBeUndefined();
		// The serialized response is the benign pass-through `{}` — the real tool is allowed to run.
		expect(io.out).toEqual(["{}"]);
		expect(isPassThrough(assertClaudeCodePreToolResponse(JSON.parse(io.out[0])))).toBe(true);
	});

	it("b-AC-6: an allow decision serializes as the benign pass-through ack (real tool runs)", async () => {
		const response = await driveClaudeCodePreTool(
			{ tool_name: "Bash", tool_input: { command: "cat /etc/hosts" } },
			createFakeVfsIntercept({ content: "must-not-appear" }),
		);
		expect(isPassThrough(response)).toBe(true);
	});
});
