/**
 * Claude Code harness adapter entry root — PRD-021c Wave 2 (c-AC-5, the REFERENCE binary).
 *
 * Claude Code is the FIRST fully-wired reference harness (FR-7 / c-AC-5). Its native
 * lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `Stop`/`SubagentStop`, `SessionEnd`) invoke THIS bundle once per event, piping the
 * native hook JSON on stdin. The binary drives:
 *
 *   native Claude Code hook payload (stdin/JSON)
 *     → 019c claude-code shim `normalize`   (`createClaudeCodeShim`)
 *     → 019b core                            (`runSessionStart`/`runCapture`/`runPreToolUse`/`runSessionEnd`)
 *     → production `DaemonHookClient`        (loopback POST to `/api/hooks/*`)
 *
 * via the SHARED {@link runHookBinary} driver + {@link createHookRuntime} runtime — so
 * adding the next harness (Codex, c-AC-6) is a shim swap, not a re-derivation.
 *
 * The `hooks.json` the connector installs (`harnesses/claude-code/hooks.json`) points
 * every Claude Code lifecycle event at this built `bundle/index.js`, so a native turn
 * drives the runtime end-to-end. Thin client only: no DeepLake; the only outbound path
 * is the daemon client over loopback.
 */

import { createClaudeCodeShim } from "../../../src/hooks/claude-code/shim.js";
import { maybeRunHookBinaryMain, runHookBinary } from "../../../src/hooks/binary.js";
import type { HookEventOutcome } from "../../../src/hooks/runtime.js";
import { bootHarness, type HarnessContext } from "../../../src/daemon-client/harness.js";

/**
 * Legacy harness-context activation (PRD-001b). Retained so any non-hook caller that
 * imported `activate()` keeps compiling; the hook lifecycle now runs through
 * {@link runClaudeCodeHook}.
 */
export function activate(): HarnessContext {
	return bootHarness("claude-code");
}

/**
 * Drive ONE Claude Code hook invocation end-to-end (c-AC-5). Reads the native hook
 * JSON off stdin, normalizes it through the claude-code shim, runs the 019b core, and
 * POSTs through the production `DaemonHookClient`. Fail-soft: always resolves.
 */
export async function runClaudeCodeHook(): Promise<HookEventOutcome> {
	return runHookBinary({ shim: createClaudeCodeShim() });
}

// Production: when invoked as the bundled binary, drive the hook from stdin (the path
// the native `hooks.json` invokes). Never on import — a test imports `runClaudeCodeHook`.
maybeRunHookBinaryMain(createClaudeCodeShim(), import.meta.url);
